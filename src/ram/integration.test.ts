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
 * Every `RamClient` construction, `createRamProvider()` call, and
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
 * server-side, on a schedule this plugin does not control. The one test that
 * depends on extraction having happened
 * polls for up to 60s and calls `ctx.skip()` (not a failing assertion) if
 * nothing has materialized by the deadline, logging a loud `console.warn`
 * first. No other test in this file depends on extraction.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

import { RamClient } from "./client.js";
import { RamApiError, type RamLongTermMemoryFilter } from "./types.js";
import { createRamProvider } from "../providers/ram.js";
import { parseMemoryConfig } from "../config.js";
import type { CapturedMessage } from "../provider.js";
import memoryPlugin from "../index.js";

// ============================================================================
// Gating (see file header)
// ============================================================================

const RAM_ENDPOINT = process.env.AGENT_MEMORY_ENDPOINT;
const RAM_API_KEY = process.env.AGENT_MEMORY_API_KEY;
const RAM_STORE_ID = process.env.AGENT_MEMORY_STORE_ID;
const ramLive = Boolean(RAM_ENDPOINT && RAM_API_KEY && RAM_STORE_ID);
const describeRamLive = ramLive ? describe : describe.skip;

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
  let client: RamClient;
  let testNamespace: string;
  const allSessionIds = new Set<string>();

  beforeAll(() => {
    testNamespace = `oc-it-${randomUUID().slice(0, 8)}`;
    client = new RamClient({
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
        await client.bulkDeleteLongTermMemories(batch);
      } catch (err) {
        if (err instanceof RamApiError && err.isNotFound) continue;
        console.warn(
          `[integration cleanup] bulkDeleteLongTermMemories failed for [${batch.join(", ")}]: ${String(err)}`,
        );
      }
    }
  }

  async function sweepByFilter(filter: RamLongTermMemoryFilter): Promise<void> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    let guard = 0;
    do {
      let res;
      try {
        res = await client.searchLongTermMemory({ filter, limit: 100, pageToken });
      } catch (err) {
        console.warn(`[integration cleanup] sweep search failed: ${String(err)}`);
        return;
      }
      for (const memory of res.memories) ids.push(memory.id);
      pageToken = res.nextPageToken;
      guard += 1;
    } while (pageToken && guard < 50);
    if (ids.length > 0) {
      await bulkDeleteBatched(ids);
    }
  }

  async function sweepNamespace(ns: string): Promise<void> {
    await sweepByFilter({ namespace: { eq: ns } });
  }

  async function safeDeleteSession(sessionId: string): Promise<void> {
    try {
      await client.deleteSessionMemory(sessionId);
    } catch (err) {
      if (err instanceof RamApiError && err.isNotFound) return;
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
        const created = await client.bulkCreateLongTermMemories([
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
        ]);
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
          (res) => res.memories.some((m) => m.id === idFox),
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(value.memories.some((m) => m.id === idFox)).toBe(true);
      }, 20000);

      test("search with ownerId filter excludes other owners", async () => {
        const res = await client.searchLongTermMemory({
          filter: { namespace: { eq: testNamespace }, ownerId: { eq: ownerA } },
          limit: 10,
        });
        const ids = res.memories.map((m) => m.id);
        expect(ids).toContain(idFox);
        expect(ids).not.toContain(idRedis);
        expect(ids).not.toContain(idParis);
      }, 20000);

      test("search with topics `in` filter matches only the tagged record", async () => {
        const res = await client.searchLongTermMemory({
          filter: { namespace: { eq: testNamespace }, topics: { in: ["databases"] } },
          limit: 10,
        });
        const ids = res.memories.map((m) => m.id);
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
        expect(res.memories).toHaveLength(0);
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
          expect(res.memories.length).toBeLessThanOrEqual(1);
          for (const memory of res.memories) seen.add(memory.id);
          pageToken = res.nextPageToken;
          pages += 1;
        } while (pageToken && pages < 10);

        expect(seen).toEqual(new Set(fixtureIds));
      }, 30000);

      test("bulk delete removes the records and search confirms gone", async () => {
        const res = await client.bulkDeleteLongTermMemories(fixtureIds);
        expect([...res.deleted].sort()).toEqual([...fixtureIds].sort());

        const { value, timedOut } = await poll(
          () =>
            client.searchLongTermMemory({
              filter: { namespace: { eq: testNamespace } },
              limit: 10,
            }),
          (res2) => res2.memories.length === 0,
          { intervalMs: 1000, timeoutMs: 15000 },
        );
        expect(timedOut).toBe(false);
        expect(value.memories).toHaveLength(0);
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
        await provider.deleteLongTerm([id], { namespace: testNamespace });
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
        await provider.deleteLongTerm([id], { namespace: testNamespace });
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

      await provider.deleteLongTerm([id], { namespace: testNamespace });

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
          expect(checkpoint).toBe(base + 3000);

          const afterFirstCapture = await client.getSessionMemory(sessionId);
          expect(afterFirstCapture.events).toHaveLength(4);

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
      // RamClient.health() always calls `${serverUrl}/health`, never
      // `${serverUrl}/v1/stores/{storeId}/health` (see client.ts). Resolving
      // here against real credentials confirms end-to-end that the root
      // /health path is reachable with the same bearer token used for every
      // store-scoped endpoint.
      const res = await client.health();
      expect(res).toBeDefined();
      expect(typeof res.status).toBe("string");
      expect(res.status.length).toBeGreaterThan(0);
    }, 15000);

    test(
      "extraction: session events produce long-term memories",
      async (ctx) => {
        const ownerId = `oc-it-owner-${randomUUID().slice(0, 8)}`;
        const sessionId = `oc-it-session-${randomUUID().slice(0, 8)}`;
        const provider = createRamProvider(parseMemoryConfig({ provider: "cloud" }));
        allSessionIds.add(sessionId);

        try {
          const now = Date.now();
          await provider.captureMessages(
            sessionId,
            [
              {
                role: "user",
                content: "My favorite color is teal and I live in Austin, Texas.",
                id: randomUUID(),
                timestampMs: now,
              },
              {
                role: "assistant",
                content: "Got it — teal is your favorite color and you live in Austin, Texas.",
                id: randomUUID(),
                timestampMs: now + 1000,
              },
              {
                role: "user",
                content: "I also have a pet cat named Whiskers.",
                id: randomUUID(),
                timestampMs: now + 2000,
              },
              {
                role: "assistant",
                content: "Noted, your cat is named Whiskers.",
                id: randomUUID(),
                timestampMs: now + 3000,
              },
            ],
            { namespace: testNamespace, userId: ownerId },
          );

          const { value, timedOut } = await poll(
            () =>
              client.searchLongTermMemory({
                filter: { namespace: { eq: testNamespace }, ownerId: { eq: ownerId } },
                limit: 10,
              }),
            (res) => res.memories.length > 0,
            { intervalMs: 2000, timeoutMs: 60000 },
          );

          if (timedOut) {
            console.warn(
              "[assumption check] RAM did not extract any long-term memories from " +
                `session "${sessionId}" (owner "${ownerId}") within 60s. This does not ` +
                "necessarily mean extraction is broken — the service's extraction SLA is " +
                "outside this plugin's control — but it means " +
                "the live-timing half of that assumption could not be confirmed on this " +
                "run. Skipping rather than failing.",
            );
            ctx.skip();
            return;
          }

          expect(value.memories.length).toBeGreaterThan(0);
        } finally {
          await safeDeleteSession(sessionId);
          allSessionIds.delete(sessionId);
          await sweepByFilter({ namespace: { eq: testNamespace }, ownerId: { eq: ownerId } });
        }
      },
      75000,
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
          await client.bulkDeleteLongTermMemories([memoryId]).catch(() => {});
        }
      }
    }, 45000);
  });
});
