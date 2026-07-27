/**
 * Live integration suite for the Redis Agent Memory (RAM) cloud backend.
 *
 * ## Gating
 *
 * This suite is **env-gated**, not flag-gated: the presence of all three RAM
 * cloud credentials is the opt-in, exactly like nemo's CI (secrets on the job
 * gate the tests, no separate "run live tests" toggle). Unlike the AMS live
 * tests in `../index.test.ts` (which additionally require
 * `OPENCLAW_LIVE_TEST=1`), this suite does NOT require that flag:
 *
 * ```ts
 * const RAM_ENDPOINT = process.env.AGENT_MEMORY_ENDPOINT;
 * const RAM_API_KEY  = process.env.AGENT_MEMORY_API_KEY;
 * const RAM_STORE_ID = process.env.AGENT_MEMORY_STORE_ID;
 * const ramLive = Boolean(RAM_ENDPOINT && RAM_API_KEY && RAM_STORE_ID);
 * const describeRamLive = ramLive ? describe : describe.skip;
 * ```
 *
 * With no credentials set, `describeRamLive` resolves to `describe.skip`.
 * Vitest still *collects* (walks) the describe/nested-describe factory
 * bodies below to enumerate skipped tests for reporting, but it never
 * invokes a `test()`/`beforeAll()`/`afterAll()` *body* for a skipped suite.
 * Every `RamSdkAdapter` construction, `createRamProvider()` call, and
 * `parseMemoryConfig()` call in this file lives strictly inside a
 * `test(...)` or `beforeAll(...)` callback body — never directly in a
 * `describe(...)` factory body and never at module top level — so a bare
 * `npm test` with no credentials performs zero network calls.
 *
 * ## Isolation
 *
 * The RAM store behind these credentials is shared and persistent (it is
 * not reset between runs). Every run of this file computes one fresh
 * `oc-it-<8 hex chars>` namespace (see `testNamespace` below); every
 * individual test additionally mints its own `ownerId`/`sessionId` where
 * relevant. No test ever asserts on a *global* count (total memories,
 * total sessions, etc.) — only on records/sessions this run created.
 *
 * ## Cleanup
 *
 * Cleanup happens at three layers, so a failure partway through a test
 * never leaks data into the shared store:
 *   1. Most tests wrap their own create/delete pair in try/finally.
 *   2. The "1. client round-trip" fixture describe has its own `afterAll`
 *      that re-attempts deletion of its fixture ids (idempotent — RAM's
 *      bulk-delete tolerates already-deleted ids via its `errors[]` field
 *      rather than throwing).
 *   3. The outermost `afterAll` in this file does a final, unconditional
 *      sweep: search-by-namespace (paginating via `nextPageToken`) and
 *      bulk-delete everything found, plus `deleteSessionMemory` for every
 *      session id any test created. 404s during cleanup are swallowed;
 *      other cleanup failures are `console.warn`'d rather than thrown, so
 *      cleanup itself never masks (or gets skipped because of) a test
 *      failure.
 *
 * ## Extraction timing
 *
 * RAM extracts long-term memories from session events asynchronously,
 * server-side, on a schedule this plugin does not control. Developer runs
 * retain a 60s observational deadline and may skip that one assertion. The
 * protected release gate sets RAM_RELEASE_GATE=1, extends the deadline to
 * 360s, and treats a timeout or any skipped live test as a hard failure. The
 * longer release ceiling accommodates observed store-level scheduling when
 * two extraction sessions are submitted back to back.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LongTermMemoryFilter } from "@redis-iris/agent-memory/models";

import { RamSdkAdapter } from "./adapter.js";
import { RamApiError } from "./errors.js";
import { createRamProvider, deriveRamOwnerId } from "../providers/ram.js";
import { parseMemoryConfig } from "../config.js";
import type { CapturedMessage } from "../provider.js";
import memoryPlugin from "../index.js";

// ============================================================================
// Gating (see file header)
// ============================================================================

const RAM_ENDPOINT = process.env.AGENT_MEMORY_ENDPOINT;
const RAM_API_KEY = process.env.AGENT_MEMORY_API_KEY;
const RAM_STORE_ID = process.env.AGENT_MEMORY_STORE_ID;
const RELEASE_GATE = process.env.RAM_RELEASE_GATE === "1";
const REQUIRED_RAM_ENV = [
  "AGENT_MEMORY_ENDPOINT",
  "AGENT_MEMORY_API_KEY",
  "AGENT_MEMORY_STORE_ID",
] as const;
const ramLive = Boolean(RAM_ENDPOINT && RAM_API_KEY && RAM_STORE_ID);
if (RELEASE_GATE && !ramLive) {
  const missing = REQUIRED_RAM_ENV.filter((name) => !process.env[name]?.trim());
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}
const describeRamLive = ramLive ? describe : describe.skip;
const EXTRACTION_DEADLINE_MS = RELEASE_GATE ? 360_000 : 60_000;

function writeReleaseArtifact(name: string, value: unknown): void {
  if (!RELEASE_GATE) return;
  const directory = process.env.RAM_RELEASE_RESULTS_DIR;
  if (!directory || !/^[-A-Za-z0-9]+$/.test(name)) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

// ============================================================================
// Generic polling helper (used for eventual-consistency waits)
// ============================================================================

type PollResult<T> = { value: T; timedOut: boolean };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn` immediately, then again every `intervalMs` until `predicate`
 * is satisfied or `timeoutMs` elapses. Never throws on timeout — callers
 * decide whether a timeout is a hard failure (`expect(timedOut).toBe(false)`)
 * or a reason to skip (the extraction test).
 */
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<PollResult<T>> {
  const deadline = Date.now() + opts.timeoutMs;
  let value = await fn();
  while (!predicate(value)) {
    if (Date.now() >= deadline) {
      return { value, timedOut: true };
    }
    await sleep(opts.intervalMs);
    value = await fn();
  }
  return { value, timedOut: false };
}

// ============================================================================
// Minimal fake PluginApi (Section 5) — same shape as the harness in
// ../index.test.ts, reimplemented locally since that file's helpers aren't
// exported (and this story doesn't touch ../index.test.ts).
// ============================================================================

type FakeApiHarness = {
  api: Record<string, unknown>;
  tools: Array<{ tool: unknown; opts: { name?: string } }>;
  services: unknown[];
  hooks: Record<string, unknown[]>;
  logs: string[];
};

function createFakeApi(pluginConfig: Record<string, unknown>): FakeApiHarness {
  const tools: Array<{ tool: unknown; opts: { name?: string } }> = [];
  const services: unknown[] = [];
  const hooks: Record<string, unknown[]> = {};
  const logs: string[] = [];
  const api = {
    id: "redis-memory",
    name: "Redis Memory",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      info: (m: string) => logs.push(`[info] ${m}`),
      warn: (m: string) => logs.push(`[warn] ${m}`),
      error: (m: string) => logs.push(`[error] ${m}`),
      debug: (m: string) => logs.push(`[debug] ${m}`),
    },
    registerTool: (tool: unknown, opts: { name?: string }) => tools.push({ tool, opts }),
    registerService: (service: unknown) => services.push(service),
    on: (name: string, handler: unknown) => {
      (hooks[name] ??= []).push(handler);
    },
    resolvePath: (p: string) => p,
  };
  return { api, tools, services, hooks, logs };
}

function buildTool(
  tools: FakeApiHarness["tools"],
  name: string,
  ctx: Record<string, unknown> = {},
): any {
  const entry = tools.find((t) => t.opts?.name === name)?.tool;
  return typeof entry === "function" ? (entry as (ctx: unknown) => unknown)(ctx) : entry;
}

// ============================================================================
// Suite
// ============================================================================

describeRamLive("RAM (Redis Agent Memory) — live integration suite (Story 06)", () => {
  let client: RamSdkAdapter;
  let testNamespace: string;
  const allSessionIds = new Set<string>();
  const cleanupDiagnostics = {
    memoryDeleteBatches: 0,
    sessionDeleteAttempts: 0,
    failures: 0,
  };

  beforeAll(() => {
    testNamespace = `oc-it-${randomUUID().slice(0, 8)}`;
    client = new RamSdkAdapter({
      serverUrl: RAM_ENDPOINT!,
      apiKey: RAM_API_KEY!,
      storeId: RAM_STORE_ID!,
    });
  });

  // --------------------------------------------------------------------
  // Cleanup helpers (all close over `client`, assigned by the beforeAll
  // above; safe because these are only ever invoked from within test/hook
  // bodies, which run strictly after that beforeAll has completed).
  // --------------------------------------------------------------------

  async function bulkDeleteBatched(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids)).filter((id) => id.length > 0);
    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      if (batch.length === 0) continue;
      try {
        cleanupDiagnostics.memoryDeleteBatches += 1;
        const response = await client.bulkDeleteLongTermMemories({ memoryIds: batch });
        const deleted = new Set(response.deleted);
        const unresolved = batch.filter((id) => !deleted.has(id));
        if (RELEASE_GATE && unresolved.length > 0) {
          const stillPresent = await Promise.all(unresolved.map(async (id) => {
            try {
              await client.getLongTermMemory(id);
              return true;
            } catch (error) {
              if (error instanceof RamApiError && error.isNotFound) return false;
              return true;
            }
          }));
          cleanupDiagnostics.failures += stillPresent.filter(Boolean).length;
        }
      } catch (err) {
        if (err instanceof RamApiError && err.isNotFound) continue;
        cleanupDiagnostics.failures += 1;
        console.warn(
          `[integration cleanup] bulkDeleteLongTermMemories failed for [${batch.join(", ")}]: ${String(err)}`,
        );
      }
    }
  }

  async function sweepByFilter(filter: LongTermMemoryFilter): Promise<void> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let guard = 0;
    do {
      let res;
      try {
        res = await client.searchLongTermMemory({ filter, limit: 100, pageToken });
      } catch (err) {
        cleanupDiagnostics.failures += 1;
        console.warn(`[integration cleanup] sweep search failed: ${String(err)}`);
        return;
      }
      for (const memory of res.items) ids.push(memory.id);
      pageToken = res.nextPageToken;
      guard += 1;
    } while (pageToken && guard < 50);
    if (pageToken) {
      cleanupDiagnostics.failures += 1;
      console.warn("[integration cleanup] sweep pagination limit reached");
      return;
    }
    if (ids.length > 0) {
      await bulkDeleteBatched(ids);
    }
  }

  async function sweepNamespace(ns: string): Promise<void> {
    await sweepByFilter({ namespace: { eq: ns } });
  }

  async function safeDeleteSession(sessionId: string): Promise<void> {
    cleanupDiagnostics.sessionDeleteAttempts += 1;
    try {
      await client.deleteSessionMemory(sessionId);
    } catch (err) {
      if (err instanceof RamApiError && err.isNotFound) return;
      cleanupDiagnostics.failures += 1;
      console.warn(
        `[integration cleanup] deleteSessionMemory("${sessionId}") failed: ${String(err)}`,
      );
    }
  }

  afterAll(async () => {
    // Final safety net: even though every test/nested-describe below also
    // cleans up its own resources, sweep this run's whole namespace one
    // more time (covers, e.g., server-side-extracted records whose ids we
    // never knew) and delete every session id any test created.
    await sweepNamespace(testNamespace);
    for (const sessionId of allSessionIds) {
      await safeDeleteSession(sessionId);
    }
    allSessionIds.clear();
    if (RELEASE_GATE) {
      try {
        const verification = await client.searchLongTermMemory({
          filter: { namespace: { eq: testNamespace } },
          limit: 1,
        });
        if (verification.items.length > 0) cleanupDiagnostics.failures += 1;
      } catch {
        cleanupDiagnostics.failures += 1;
      }
    }
    writeReleaseArtifact(
      `node${process.versions.node.split(".")[0]}-pass${process.env.RAM_RELEASE_RUN ?? "0"}-cleanup`,
      cleanupDiagnostics,
    );
    if (RELEASE_GATE) expect(cleanupDiagnostics.failures).toBe(0);
  }, 30000);

  // ==========================================================================
  // 1. Client round-trip
  // ==========================================================================

  describe("1. client round-trip", () => {
    test("health resolves { status }", async () => {
      const res = await client.health();
      expect(res).toBeDefined();
      expect(typeof res.status).toBe("string");
      expect(res.status.length).toBeGreaterThan(0);
    }, 15000);

    describe("bulk create -> search -> filter -> threshold -> paginate -> delete", () => {
      const ownerA = `oc-it-owner-a-${randomUUID().slice(0, 8)}`;
      const ownerB = `oc-it-owner-b-${randomUUID().slice(0, 8)}`;
      const ownerC = `oc-it-owner-c-${randomUUID().slice(0, 8)}`;
      const idFox = randomUUID();
      const idRedis = randomUUID();
      const idParis = randomUUID();
      const fixtureIds = [idFox, idRedis, idParis];

      beforeAll(async () => {
        const created = await client.bulkCreateLongTermMemories({ memories: [
          {
            id: idFox,
            text: "The quick brown fox jumps over the lazy dog.",
            ownerId: ownerA,
            namespace: testNamespace,
            topics: ["animals"],
          },
          {
            id: idRedis,
            text: "Redis is an in-memory data structure store used as a database and cache.",
            ownerId: ownerB,
            namespace: testNamespace,
            topics: ["databases"],
          },
          {
            id: idParis,
            text: "Paris is the capital city of France.",
            ownerId: ownerC,
            namespace: testNamespace,
            topics: ["geography"],
          },
        ] });
        expect([...created.created].sort()).toEqual([...fixtureIds].sort());
      }, 20000);

      afterAll(async () => {
        // Idempotent safety net in case the "bulk delete" test below never
        // ran (e.g. an earlier assertion in this block threw).
        await bulkDeleteBatched(fixtureIds);
      }, 20000);

      test("search by text finds the created record", async () => {
        const { value, timedOut } = await poll(
          () =>
            client.searchLongTermMemory({
              text: "brown fox",
              filter: { namespace: { eq: testNamespace } },
              limit: 10,
            }),
          (res) => res.items.some((m) => m.id === idFox),
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(value.items.some((m) => m.id === idFox)).toBe(true);
      }, 20000);

      test("search with ownerId filter excludes other owners", async () => {
        const res = await client.searchLongTermMemory({
          filter: { namespace: { eq: testNamespace }, ownerId: { eq: ownerA } },
          limit: 10,
        });
        const ids = res.items.map((m) => m.id);
        expect(ids).toContain(idFox);
        expect(ids).not.toContain(idRedis);
        expect(ids).not.toContain(idParis);
      }, 20000);

      test("search with topics `in` filter matches only the tagged record", async () => {
        const res = await client.searchLongTermMemory({
          filter: { namespace: { eq: testNamespace }, topics: { in: ["databases"] } },
          limit: 10,
        });
        const ids = res.items.map((m) => m.id);
        expect(ids).toContain(idRedis);
        expect(ids).not.toContain(idFox);
        expect(ids).not.toContain(idParis);
      }, 20000);

      test("a high similarityThreshold excludes weak/unrelated matches", async () => {
        const res = await client.searchLongTermMemory({
          text: `completely unrelated gibberish about interstellar plasma turbines ${randomUUID()}`,
          similarityThreshold: 0.95,
          filter: { namespace: { eq: testNamespace } },
          limit: 10,
        });
        expect(res.items).toHaveLength(0);
      }, 20000);

      test("pagination with limit 1 walks all 3 records via nextPageToken", async () => {
        const seen = new Set<string>();
        let pageToken: string | undefined;
        let pages = 0;
        do {
          const res = await client.searchLongTermMemory({
            filter: { namespace: { eq: testNamespace } },
            limit: 1,
            pageToken,
          });
          expect(res.items.length).toBeLessThanOrEqual(1);
          for (const memory of res.items) seen.add(memory.id);
          pageToken = res.nextPageToken;
          pages += 1;
        } while (pageToken && pages < 10);

        expect(seen).toEqual(new Set(fixtureIds));
      }, 30000);

      test("bulk delete removes the records and search confirms gone", async () => {
        const res = await client.bulkDeleteLongTermMemories({ memoryIds: fixtureIds });
        expect([...res.deleted].sort()).toEqual([...fixtureIds].sort());

        const { value, timedOut } = await poll(
          () =>
            client.searchLongTermMemory({
              filter: { namespace: { eq: testNamespace } },
              limit: 10,
            }),
          (res2) => res2.items.length === 0,
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(value.items).toHaveLength(0);
      }, 30000);
    });
  });

  // ==========================================================================
  // 2. Provider contract
  // ==========================================================================

  describe("2. provider contract (createRamProvider)", () => {
    test("createLongTerm -> searchLongTerm finds it with score === undefined", async () => {
      const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
      const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
      const text = `Provider contract memory ${randomUUID()}`;

      const { id } = await provider.createLongTerm({
        text,
        topics: ["test"],
        namespace: testNamespace,
        userId: ownerId,
      });

      try {
        const { value, timedOut } = await poll(
          () =>
            provider.searchLongTerm({
              text,
              limit: 5,
              namespace: testNamespace,
              userId: ownerId,
            }),
          (results) => results.some((r) => r.id === id),
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        const match = value.find((r) => r.id === id);
        expect(match).toBeDefined();
        expect(match?.text).toBe(text);
        expect(match?.score).toBeUndefined();
      } finally {
        await provider.deleteLongTerm([id], {
          key: "default",
          namespace: testNamespace,
          userId: ownerId,
        });
      }
    }, 25000);

    test("findDuplicate finds the just-created text and returns null for unrelated text", async () => {
      const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
      const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
      const text = `Provider dedup memory ${randomUUID()}`;

      const { id } = await provider.createLongTerm({
        text,
        namespace: testNamespace,
        userId: ownerId,
      });

      try {
        const { value: dup, timedOut } = await poll(
          () => provider.findDuplicate({ text, namespace: testNamespace, userId: ownerId }),
          (result) => result !== null,
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(dup?.text).toBe(text);

        const noDup = await provider.findDuplicate({
          text: `totally unrelated gibberish ${randomUUID()}`,
          namespace: testNamespace,
          userId: ownerId,
        });
        expect(noDup).toBeNull();
      } finally {
        await provider.deleteLongTerm([id], {
          key: "default",
          namespace: testNamespace,
          userId: ownerId,
        });
      }
    }, 25000);

    test("deleteLongTerm removes the record", async () => {
      const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
      const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
      const text = `Provider delete memory ${randomUUID()}`;

      const { id } = await provider.createLongTerm({
        text,
        namespace: testNamespace,
        userId: ownerId,
      });

      const outcome = await provider.deleteLongTerm([id], {
        key: "default",
        namespace: testNamespace,
        userId: ownerId,
      });
      expect(outcome.deletedIds).toEqual([id]);

      const { value, timedOut } = await poll(
        () =>
          provider.searchLongTerm({
            text,
            limit: 5,
            namespace: testNamespace,
            userId: ownerId,
          }),
        (results) => !results.some((r) => r.id === id),
        { intervalMs: 1000, timeoutMs: 15000 },
      );
      expect(timedOut).toBe(false);
      expect(value.some((r) => r.id === id)).toBe(false);
    }, 25000);

    test("deleteLongTerm refuses a known id from another effective scope", async () => {
      const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
      const text = `Cross-scope delete guard ${randomUUID()}`;
      const ownerA = `owner-a-${randomUUID().slice(0, 8)}`;
      const ownerB = `owner-b-${randomUUID().slice(0, 8)}`;
      const createdIds: string[] = [];

      try {
        const { id } = await provider.createLongTerm({
          text,
          key: "personal",
          namespace: testNamespace,
          userId: ownerA,
        });
        createdIds.push(id);

        const hostileOutcome = await provider.deleteLongTerm([id], {
          key: "shared",
          namespace: testNamespace,
          userId: ownerB,
        });
        expect(hostileOutcome).toMatchObject({
          deletedIds: [],
          forbiddenIds: [id],
        });

        const { value: stillPresent, timedOut } = await poll(
          () => provider.searchLongTerm({
            text,
            limit: 5,
            key: "personal",
            namespace: testNamespace,
            userId: ownerA,
          }),
          (memories) => memories.some((memory) => memory.id === id),
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(stillPresent.some((memory) => memory.id === id)).toBe(true);

        const authorizedOutcome = await provider.deleteLongTerm([id], {
          key: "personal",
          namespace: testNamespace,
          userId: ownerA,
        });
        expect(authorizedOutcome.deletedIds).toEqual([id]);
        createdIds.splice(createdIds.indexOf(id), 1);
      } finally {
        await bulkDeleteBatched(createdIds);
      }
    }, 25000);
  });

  // ==========================================================================
  // 3. Session capture
  // ==========================================================================

  describe("3. session capture", () => {
    test(
      "captureMessages (4 msgs / 2 turns) -> getCaptureCheckpoint returns max timestamp; " +
        "capturing only-newer messages appends",
      async () => {
        const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
        const sessionId = `oc-it-session-${randomUUID().slice(0, 8)}`;
        const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
        allSessionIds.add(sessionId);

        const base = Date.now() - 60000;
        const turn1: CapturedMessage[] = [
          { role: "user", content: "What is the capital of Iceland?", id: randomUUID(), timestampMs: base },
          {
            role: "assistant",
            content: "The capital of Iceland is Reykjavik.",
            id: randomUUID(),
            timestampMs: base + 1000,
          },
        ];
        const turn2: CapturedMessage[] = [
          {
            role: "user",
            content: "And what's the population there?",
            id: randomUUID(),
            timestampMs: base + 2000,
          },
          {
            role: "assistant",
            content: "Reykjavik has around 130,000 residents.",
            id: randomUUID(),
            timestampMs: base + 3000,
          },
        ];

        try {
          await provider.captureMessages(sessionId, [...turn1, ...turn2], {
            namespace: testNamespace,
            userId: ownerId,
          });

          const checkpoint = await provider.getCaptureCheckpoint(sessionId, {
            namespace: testNamespace,
            userId: ownerId,
          });
          expect(checkpoint).toEqual({
            maxTimestampMs: base + 3000,
            messageIdsAtMax: [turn2[1].id],
          });

          const afterFirstCapture = await client.getSessionMemory(sessionId);
          expect(afterFirstCapture.events).toHaveLength(4);
          const effectiveOwnerId = deriveRamOwnerId(testNamespace, ownerId, "default");
          const listed = await client.listSessions({
            limit: 1,
            filterOwnerId: effectiveOwnerId,
          });
          expect(listed.items).toContain(sessionId);

          const turn3: CapturedMessage[] = [
            {
              role: "user",
              content: "Thanks, one more: what language do they speak?",
              id: randomUUID(),
              timestampMs: base + 4000,
            },
            {
              role: "assistant",
              content: "Icelandic is the official language.",
              id: randomUUID(),
              timestampMs: base + 5000,
            },
          ];
          await provider.captureMessages(sessionId, turn3, {
            namespace: testNamespace,
            userId: ownerId,
          });

          const afterSecondCapture = await client.getSessionMemory(sessionId);
          expect(afterSecondCapture.events).toHaveLength(6);
        } finally {
          await safeDeleteSession(sessionId);
          allSessionIds.delete(sessionId);
        }
      },
      30000,
    );
  });

  // ==========================================================================
  // 4. Assumption checks
  // ==========================================================================

  describe("4. assumption checks", () => {
    test("health endpoint is at server root", async () => {
      // The official SDK calls `${serverUrl}/health`, never
      // `${serverUrl}/v1/stores/{storeId}/health`. Resolving
      // here against real credentials confirms end-to-end that the root
      // /health path is reachable with the same bearer token used for every
      // store-scoped endpoint.
      const res = await client.health();
      expect(res).toBeDefined();
      expect(typeof res.status).toBe("string");
      expect(res.status.length).toBeGreaterThan(0);
    }, 15000);

    test(
      "default plugin auto-capture extracts and auto-recalls through a production-derived session",
      async (ctx) => {
        const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
        const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
        const scope = { key: "default", namespace: testNamespace, userId: ownerId };
        const effectiveOwnerId = deriveRamOwnerId(
          scope.namespace,
          scope.userId,
          scope.key,
        );
        const sessionKey = `agent:main:release-${randomUUID()}`;
        const sessionId = provider.deriveCaptureSessionId(
          sessionKey,
          {
            ...scope,
            label: "Default",
            summaryViewName: "unused",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
        );
        allSessionIds.add(sessionId);
        const harness = createFakeApi({
          provider: "cloud",
          namespace: testNamespace,
          userId: ownerId,
        });
        await memoryPlugin.register(harness.api as any);
        const agentEnd = harness.hooks.agent_end?.[0] as any;
        const beforePrompt = harness.hooks.before_prompt_build?.[0] as any;
        expect(agentEnd).toBeTypeOf("function");
        expect(beforePrompt).toBeTypeOf("function");
        expect(sessionId).toMatch(/^oc-s-[a-f0-9]{58}$/);
        const otherScope = {
          key: "other",
          namespace: testNamespace,
          userId: `${ownerId}-other`,
        };
        let hostileId: string | undefined;

        try {
          const now = Date.now();
          const uniqueFact = `release-fact-${randomUUID().slice(0, 8)}`;
          await agentEnd(
            {
              success: true,
              messages: [
              {
                role: "user",
                content: `I am working on a Redis migration project called ${uniqueFact}.`,
                id: randomUUID(),
                timestamp: now,
              },
              {
                role: "assistant",
                content: `Understood. The Redis migration project is called ${uniqueFact}.`,
                id: randomUUID(),
                timestamp: now + 1000,
              },
              {
                role: "user",
                content: `Please remember ${uniqueFact} as my project codename for future conversations.`,
                id: randomUUID(),
                timestamp: now + 2000,
              },
              {
                role: "assistant",
                content: `I will remember that your project codename is ${uniqueFact}.`,
                id: randomUUID(),
                timestamp: now + 3000,
              },
              ],
            },
            { agentId: "main", sessionKey },
          );

          const capturedSession = await client.getSessionMemory(sessionId);
          expect(capturedSession.ownerId).toBe(effectiveOwnerId);
          // The default preserves complete conversational turns so RAM can
          // extract memories from the dialogue. Operators can opt out of
          // assistant retention with assistantCapture="exclude".
          expect(capturedSession.events).toHaveLength(4);
          expect(capturedSession.events.map((event) => event.role)).toEqual([
            "USER", "ASSISTANT", "USER", "ASSISTANT",
          ]);

          const { value, timedOut } = await poll(
            () =>
              provider.searchLongTerm({
                text: uniqueFact,
                limit: 10,
                ...scope,
              }),
            (res) => res.length > 0,
            { intervalMs: 2000, timeoutMs: EXTRACTION_DEADLINE_MS },
          );

          if (timedOut) {
            if (RELEASE_GATE) {
              throw new Error(
                `RAM extraction did not produce a recallable memory within ${EXTRACTION_DEADLINE_MS}ms`,
              );
            }
            console.warn(
              `[assumption check] RAM extraction exceeded ${EXTRACTION_DEADLINE_MS}ms; ` +
                "developer run is skipping the timing assertion.",
            );
            ctx.skip();
            return;
          }

          expect(value.length).toBeGreaterThan(0);
          const recalled = await beforePrompt(
            { prompt: `What do you remember about ${uniqueFact}?` },
            { agentId: "main", sessionKey },
          );
          expect(recalled?.prependContext).toContain("UNTRUSTED HISTORICAL DATA");
          expect(recalled?.prependContext).toContain('"kind":"memory"');
          expect(recalled?.prependContext).toContain(uniqueFact);

          const isolated = await provider.searchLongTerm({
            text: uniqueFact,
            limit: 10,
            ...otherScope,
          });
          expect(isolated).toHaveLength(0);

          if (RELEASE_GATE) {
            const direct = await provider.createLongTerm({
              text: `direct-primary-${uniqueFact}`,
              ...scope,
            });
            const hostile = await provider.createLongTerm({
              text: `hostile-other-${uniqueFact}`,
              ...otherScope,
            });
            hostileId = hostile.id;
            const directVisible = await poll(
              () => provider.searchLongTerm({
                text: uniqueFact,
                limit: 10,
                ...scope,
              }),
              (memories) => memories.some((memory) => memory.id === direct.id),
              { intervalMs: 1_000, timeoutMs: 15_000 },
            );
            expect(directVisible.timedOut).toBe(false);
            const refused = await provider.deleteLongTerm([hostile.id], scope);
            expect(refused.forbiddenIds).toEqual([hostile.id]);

            const erased = await provider.eraseScope(scope, {
              settleMs: 2_000,
              maxRecords: 100,
            });
            expect(erased.status).toBe("verified_best_effort");
            expect(erased.passes).toBe(2);
            expect(erased.memoryIds).toContain(direct.id);
            expect(erased.sessionIds).toContain(sessionId);
            expect(erased.remainingMemoryIds).toEqual([]);
            expect(erased.remainingSessionIds).toEqual([]);

            const hostileStillPresent = await poll(
              () => provider.searchLongTerm({
                text: uniqueFact,
                limit: 10,
                ...otherScope,
              }),
              (memories) => memories.some((memory) => memory.id === hostile.id),
              { intervalMs: 1_000, timeoutMs: 15_000 },
            );
            expect(hostileStillPresent.timedOut).toBe(false);
          }
        } finally {
          if (hostileId) {
            await provider.deleteLongTerm([hostileId], otherScope);
          }
          await safeDeleteSession(sessionId);
          allSessionIds.delete(sessionId);
          await sweepByFilter({ ownerId: { eq: effectiveOwnerId } });
          if (RELEASE_GATE) {
            const absent = await poll(
              () => client.searchLongTermMemory({
                filter: { ownerId: { eq: effectiveOwnerId } },
                limit: 10,
              }),
              (response) => response.items.length === 0,
              { intervalMs: 1000, timeoutMs: 20_000 },
            );
            expect(absent.timedOut).toBe(false);
          }
        }
      },
      EXTRACTION_DEADLINE_MS + 45_000,
    );
  });

  // ==========================================================================
  // 5. End-to-end plugin smoke
  // ==========================================================================

  describe("5. plugin smoke (register -> memory_store -> memory_recall -> memory_forget)", () => {
    test("end-to-end through the real plugin against the live cloud provider", async () => {
      const harness = createFakeApi({
        provider: "cloud",
        namespace: testNamespace,
        autoCapture: false,
        autoRecall: false,
      });

      await memoryPlugin.register(harness.api as any);

      const toolNames = harness.tools.map((t) => t.opts?.name);
      expect(toolNames).toContain("memory_recall");
      expect(toolNames).toContain("memory_store");
      expect(toolNames).toContain("memory_forget");

      const toolCtx = { agentId: "main", sessionKey: "agent:main:main" };
      const storeTool = buildTool(harness.tools, "memory_store", toolCtx);
      const recallTool = buildTool(harness.tools, "memory_recall", toolCtx);
      const forgetTool = buildTool(harness.tools, "memory_forget", toolCtx);

      const uniqueId = randomUUID().slice(0, 8);
      const text = `Plugin smoke test memory xyzzy-${uniqueId}`;
      let memoryId: string | undefined;

      try {
        const storeResult = await storeTool.execute("call-1", { text });
        expect(storeResult.details?.action).toBe("created");
        memoryId = storeResult.details?.id as string;
        expect(memoryId).toBeTruthy();

        const { value: recallResult, timedOut } = await poll(
          () => recallTool.execute("call-2", { query: `xyzzy-${uniqueId}`, limit: 5 }),
          (result: any) => (result.details?.count ?? 0) > 0,
          { intervalMs: 1000, timeoutMs: 20000 },
        );
        expect(timedOut).toBe(false);
        expect(
          recallResult.details?.memories?.some((m: { id: string }) => m.id === memoryId),
        ).toBe(true);

        const forgetResult = await forgetTool.execute("call-3", { memoryId });
        expect(forgetResult.details?.action).toBe("deleted");
        expect(forgetResult.details?.id).toBe(memoryId);
        memoryId = undefined; // successfully cleaned up via the tool itself
      } finally {
        if (memoryId) {
          // The forget step never ran (an earlier assertion threw) — best-effort
          // direct cleanup on top of the outer afterAll's namespace-wide sweep.
          await client.bulkDeleteLongTermMemories({ memoryIds: [memoryId] }).catch(() => {});
        }
      }
    }, 45000);
  });

  test.runIf(RELEASE_GATE)("bounded cloud pilot canary meets capture and recall targets", async () => {
    const sessionCount = 4;
    const captureLatencies: number[] = [];
    const recallLatencies: number[] = [];
    let errors = 0;
    let cleanupErrors = 0;
    const cleanup: Array<{
      provider: ReturnType<typeof createRamProvider>;
      scope: { key: string; namespace: string; userId: string };
      sessionId: string;
      memoryId?: string;
    }> = [];

    try {
      await Promise.all(Array.from({ length: sessionCount }, async (_, index) => {
        const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
        const scope = {
          key: `pilot_${index}`,
          namespace: testNamespace,
          userId: `pilot-user-${randomUUID().slice(0, 8)}`,
        };
        const sessionId = provider.deriveCaptureSessionId(`pilot-session-${randomUUID()}`, {
          ...scope,
          label: scope.key,
          summaryViewName: "unused",
          summaryTimeWindowDays: 30,
          summaryGroupBy: ["user_id"],
        });
        const cleanupRecord = { provider, scope, sessionId, memoryId: undefined as string | undefined };
        cleanup.push(cleanupRecord);
        allSessionIds.add(sessionId);
        const started = performance.now();
        try {
          await provider.captureMessages(sessionId, [
            {
              role: "user",
              content: `Bounded cloud capture canary ${index}`,
              id: randomUUID(),
              timestampMs: Date.now(),
            },
            {
              role: "user",
              content: `Second bounded cloud capture event ${index}`,
              id: randomUUID(),
              timestampMs: Date.now() + 1,
            },
          ], scope);
        } catch (error) {
          errors += 1;
          throw error;
        } finally {
          captureLatencies.push(performance.now() - started);
        }

        const text = `bounded-recall-${randomUUID()}`;
        const created = await provider.createLongTerm({ text, ...scope });
        cleanupRecord.memoryId = created.id;
        const recallStarted = performance.now();
        try {
          const result = await provider.searchLongTerm({ text, limit: 3, ...scope });
          expect(result.some((memory) => memory.id === created.id)).toBe(true);
        } catch (error) {
          errors += 1;
          throw error;
        } finally {
          recallLatencies.push(performance.now() - recallStarted);
        }
      }));
    } finally {
      await Promise.all(cleanup.map(async ({ provider, scope, sessionId, memoryId }) => {
        try {
          const erased = await provider.eraseScope(scope, { settleMs: 2_000, maxRecords: 100 });
          if (
            erased.status !== "verified_best_effort" ||
            erased.remainingMemoryIds.length > 0 ||
            erased.remainingSessionIds.length > 0
          ) {
            cleanupErrors += 1;
          }
        } catch {
          cleanupErrors += 1;
        } finally {
          if (memoryId) await provider.deleteLongTerm([memoryId], scope).catch(() => {
            cleanupErrors += 1;
          });
          await safeDeleteSession(sessionId);
          const ownerId = deriveRamOwnerId(scope.namespace, scope.userId, scope.key);
          await sweepByFilter({ ownerId: { eq: ownerId } });
          try {
            const remaining = await client.searchLongTermMemory({
              filter: { ownerId: { eq: ownerId } },
              limit: 1,
            });
            if (remaining.items.length > 0) cleanupErrors += 1;
          } catch {
            cleanupErrors += 1;
          }
          allSessionIds.delete(sessionId);
        }
      }));
    }

    const summarize = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      if (sorted.length === 0) {
        return { samples: 0, p50: null, p95: null, p99: null };
      }
      const percentile = (fraction: number) => sorted[
        Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
      ];
      return {
        samples: sorted.length,
        p50: Number(percentile(0.50).toFixed(2)),
        p95: Number(percentile(0.95).toFixed(2)),
        p99: Number(percentile(0.99).toFixed(2)),
      };
    };
    const metrics = {
      kind: "bounded_cloud_pilot_canary",
      targets: {
        concurrentSessions: sessionCount,
        messagesPerSession: 2,
        captureP95Ms: 30_000,
        recallP95Ms: 20_000,
        errors: 0,
      },
      observations: {
        errors,
        cleanupErrors,
        captureLatencyMs: summarize(captureLatencies),
        recallLatencyMs: summarize(recallLatencies),
      },
    };
    writeReleaseArtifact(
      `node${process.versions.node.split(".")[0]}-pass${process.env.RAM_RELEASE_RUN ?? "0"}-cloud-pilot`,
      metrics,
    );
    console.info(`[ram-cloud-pilot] ${JSON.stringify(metrics)}`);
    expect(errors).toBe(0);
    expect(cleanupErrors).toBe(0);
    expect(metrics.observations.captureLatencyMs.samples).toBe(sessionCount);
    expect(metrics.observations.recallLatencyMs.samples).toBe(sessionCount);
    expect(metrics.observations.captureLatencyMs.p95 ?? Infinity).toBeLessThanOrEqual(30_000);
    expect(metrics.observations.recallLatencyMs.p95 ?? Infinity).toBeLessThanOrEqual(20_000);
  }, 180_000);
});
