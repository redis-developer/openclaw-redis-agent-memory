/**
 * Unit tests for the RAM provider.
 *
 * `RamSdkAdapter` is mocked at the module level so these tests run with no
 * network access or credentials. They assert the translation logic that is
 * unique to RAM vs. AMS:
 *   - minScore -> similarityThreshold UNtransformed (no 1 - minScore inversion)
 *   - no client-side score filtering (server already applied the threshold)
 *   - namespace/userId -> opaque ownerId boundary shared by every RAM path
 *   - RAM-safe, deterministic, privacy-preserving session ids
 *   - findDuplicate similarityThreshold 0.95 boundary
 *   - captureMessages sequential ordering + UPPERCASE roles + Date timestamps
 *   - getCaptureCheckpoint max(createdAt.getTime()) + 404 -> 0
 *   - exact-id deletion authorizes the complete effective owner boundary
 *   - partial bulk delete responses are never promoted to success
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MemoryConfig } from "../config.js";
import { RamApiError } from "../ram/errors.js";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  bulkCreateLongTermMemories: vi.fn(),
  bulkDeleteLongTermMemories: vi.fn(),
  getLongTermMemory: vi.fn(),
  searchLongTermMemory: vi.fn(),
  addSessionEvent: vi.fn(),
  getSessionMemory: vi.fn(),
  deleteSessionMemory: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../ram/adapter.js", () => {
  class RamSdkAdapter {
    health = mocks.health;
    bulkCreateLongTermMemories = mocks.bulkCreateLongTermMemories;
    bulkDeleteLongTermMemories = mocks.bulkDeleteLongTermMemories;
    getLongTermMemory = mocks.getLongTermMemory;
    searchLongTermMemory = mocks.searchLongTermMemory;
    addSessionEvent = mocks.addSessionEvent;
    getSessionMemory = mocks.getSessionMemory;
    deleteSessionMemory = mocks.deleteSessionMemory;
    listSessions = mocks.listSessions;
    constructor(_opts: unknown) {}
  }
  return { RamSdkAdapter };
});

import {
  createRamProvider,
  deriveRamOwnerId,
  deriveRamSessionId,
  RAM_ERASURE_CONCURRENCY,
} from "./ram.js";

const cfg = {
  serverUrl: "https://ram.example.com",
  apiKey: "key-123",
  storeId: "store-1",
} as MemoryConfig;

describe("createRamProvider", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  test("capabilities are all false and summaries is undefined", () => {
    const provider = createRamProvider(cfg);
    expect(provider.capabilities).toEqual({
      summaryViews: false,
      extractionStrategy: false,
      similarityScores: false,
    });
    expect(provider.summaries).toBeUndefined();
  });

  test("deriveRamSessionId is stable, opaque, RAM-safe, and at most 64 characters", () => {
    const scope = { key: "personal", namespace: "private-app", userId: "alice@example.com" };
    const sessionId = deriveRamSessionId("agent:main:main:raw-secret-session", scope);

    expect(sessionId).toBe(deriveRamSessionId("agent:main:main:raw-secret-session", scope));
    expect(sessionId).toMatch(/^[a-z0-9-]+$/);
    expect(sessionId.length).toBeLessThanOrEqual(64);
    expect(sessionId).not.toContain("alice");
    expect(sessionId).not.toContain("private-app");
    expect(sessionId).not.toContain("main");
  });

  test("deriveRamSessionId separates session, scope, namespace, owner, and missing-owner boundaries", () => {
    const base = deriveRamSessionId("session-a", {
      key: "personal",
      namespace: "app-a",
      userId: "alice",
    });

    const variants = [
      deriveRamSessionId("session-b", { key: "personal", namespace: "app-a", userId: "alice" }),
      deriveRamSessionId("session-a", { key: "shared", namespace: "app-a", userId: "alice" }),
      deriveRamSessionId("session-a", { key: "personal", namespace: "app-b", userId: "alice" }),
      deriveRamSessionId("session-a", { key: "personal", namespace: "app-a", userId: "bob" }),
      deriveRamSessionId("session-a", { key: "personal", namespace: "app-a" }),
    ];

    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  test("deriveRamOwnerId is shared only by identical namespace/user boundaries", () => {
    const owner = deriveRamOwnerId("app-a", undefined, "shared");
    expect(owner).toBe(deriveRamOwnerId("app-a", undefined, "shared"));
    expect(owner).not.toBe(deriveRamOwnerId("app-b", undefined, "shared"));
    expect(owner).not.toBe(deriveRamOwnerId("app-a", "alice", "shared"));
    expect(owner).not.toBe(deriveRamOwnerId("app-a", undefined, "personal"));
    expect(owner).toMatch(/^oc-o-[a-f0-9]+$/);
  });

  test("healthCheck resolves void on a resolved status", async () => {
    mocks.health.mockResolvedValue({ status: "ok" });
    const provider = createRamProvider(cfg);
    await expect(provider.healthCheck()).resolves.toBeUndefined();
  });

  test("healthCheck lets errors propagate", async () => {
    mocks.health.mockRejectedValue(new RamApiError("boom", 500));
    const provider = createRamProvider(cfg);
    await expect(provider.healthCheck()).rejects.toThrow("boom");
  });

  // --------------------------------------------------------------------
  // searchLongTerm
  // --------------------------------------------------------------------

  test("passes minScore through as similarityThreshold, untransformed", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5, minScore: 0.4 });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.similarityThreshold).toBe(0.4);
    expect(call.text).toBe("q");
    expect(call.limit).toBe(5);
  });

  test("maps namespace and userId to one opaque ownerId filter", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5, key: "personal", namespace: "ns", userId: "u" });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.filter).toEqual({ ownerId: { eq: deriveRamOwnerId("ns", "u", "personal") } });
  });

  test("separates search filters for named scopes with the same namespace and user", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    const provider = createRamProvider(cfg);

    await provider.searchLongTerm({ text: "q", limit: 5, key: "shared", namespace: "ns", userId: "u" });
    await provider.searchLongTerm({ text: "q", limit: 5, key: "personal", namespace: "ns", userId: "u" });

    const [shared, personal] = mocks.searchLongTermMemory.mock.calls.map(
      ([request]) => request.filter.ownerId.eq,
    );
    expect(shared).not.toBe(personal);
  });

  test("uses an explicit shared owner boundary when namespace and userId are unset", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5 });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.filter).toEqual({ ownerId: { eq: deriveRamOwnerId(undefined, undefined) } });
  });

  test("maps records to ProviderSearchResult with score undefined, topics passthrough, entities undefined, and applies no client-side filtering", async () => {
    const ownerId = deriveRamOwnerId(undefined, undefined);
    mocks.searchLongTermMemory.mockResolvedValue({
      items: [
        { id: "a", text: "alpha", ownerId, createdAt: new Date(1), updatedAt: new Date(1), topics: ["t1"] },
        { id: "b", text: "beta", ownerId, sessionId: "session-1", memoryType: "semantic", createdAt: new Date(2), updatedAt: new Date(2) },
      ],
    });

    const provider = createRamProvider(cfg);
    const results = await provider.searchLongTerm({ text: "q", limit: 5, minScore: 0.9 });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: "a",
      text: "alpha",
      score: undefined,
      topics: ["t1"],
      entities: undefined,
      memoryType: undefined,
      source: "direct",
    });
    expect(results[1]).toEqual({
      id: "b",
      text: "beta",
      score: undefined,
      topics: undefined,
      entities: undefined,
      memoryType: "semantic",
      source: "session",
    });
  });

  test("drops cross-owner and cross-namespace search results", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    mocks.searchLongTermMemory.mockResolvedValue({
      items: [
        { id: "ok", text: "safe", ownerId, namespace: "ns", createdAt: new Date(1), updatedAt: new Date(1) },
        { id: "owner", text: "hostile-owner", ownerId: deriveRamOwnerId("ns", "mallory", "personal"), namespace: "ns", createdAt: new Date(1), updatedAt: new Date(1) },
        { id: "namespace", text: "hostile-namespace", ownerId, namespace: "other", createdAt: new Date(1), updatedAt: new Date(1) },
        { id: "missing", text: "hostile-missing-owner", namespace: "ns", createdAt: new Date(1), updatedAt: new Date(1) },
      ],
    });
    const provider = createRamProvider(cfg);
    const results = await provider.searchLongTerm({
      text: "query",
      limit: 10,
      key: "personal",
      namespace: "ns",
      userId: "alice",
    });
    expect(results.map((result) => result.id)).toEqual(["ok"]);
  });

  // --------------------------------------------------------------------
  // createLongTerm
  // --------------------------------------------------------------------

  test("createLongTerm generates a UUID id and uses the effective owner boundary", async () => {
    // A successful bulk create echoes the caller-supplied id in `created`.
    mocks.bulkCreateLongTermMemories.mockImplementation(async ({ memories }) => ({
      created: [memories[0].id],
    }));
    const provider = createRamProvider(cfg);

    const result = await provider.createLongTerm({
      text: "remember this",
      topics: ["fact"],
      namespace: "ns",
    });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const [request] = mocks.bulkCreateLongTermMemories.mock.calls[0];
    expect(request).toEqual({
      memories: [{
        id: result.id,
        text: "remember this",
        topics: ["fact"],
        namespace: "ns",
        ownerId: deriveRamOwnerId("ns", undefined),
      }],
    });
  });

  test("createLongTerm hashes namespace and userId into ownerId when provided", async () => {
    mocks.bulkCreateLongTermMemories.mockImplementation(async ({ memories }) => ({
      created: [memories[0].id],
    }));
    const provider = createRamProvider(cfg);

    await provider.createLongTerm({ text: "t", topics: ["fact"], key: "personal", namespace: "ns", userId: "u" });

    const [request] = mocks.bulkCreateLongTermMemories.mock.calls[0];
    expect(request.memories[0].ownerId).toBe(deriveRamOwnerId("ns", "u", "personal"));
  });

  test("createLongTerm throws when the record was not created (created empty, errors present)", async () => {
    // RAM returns HTTP 201 even when a record is rejected server-side: the
    // failure lands in `errors` and `created` stays empty. The provider must
    // surface this rather than report a fabricated id.
    mocks.bulkCreateLongTermMemories.mockResolvedValue({
      created: [],
      errors: [{ id: "x", error: "persistence failed" }],
    });
    const provider = createRamProvider(cfg);

    await expect(provider.createLongTerm({ text: "t" })).rejects.toThrow(
      /did not create the record/i,
    );
  });

  test("createLongTerm prefers the echoed id from created[] when present", async () => {
    mocks.bulkCreateLongTermMemories.mockResolvedValue({ created: ["server-id"] });
    const provider = createRamProvider(cfg);

    const result = await provider.createLongTerm({ text: "t" });
    expect(result.id).toBe("server-id");
  });

  test("createLongTerm accepts omitted optional topics", async () => {
    mocks.bulkCreateLongTermMemories.mockImplementation(async ({ memories }) => ({
      created: [memories[0].id],
    }));
    const provider = createRamProvider(cfg);
    await expect(provider.createLongTerm({ text: "valid" })).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  // --------------------------------------------------------------------
  // findDuplicate
  // --------------------------------------------------------------------

  test("findDuplicate searches with similarityThreshold 0.95 and limit 1, applying the same filters", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      items: [{
        id: "d1",
        text: "dup",
        ownerId: deriveRamOwnerId("ns", "u", "personal"),
        createdAt: new Date(1),
        updatedAt: new Date(1),
      }],
    });

    const provider = createRamProvider(cfg);
    const dup = await provider.findDuplicate({ text: "x", key: "personal", namespace: "ns", userId: "u" });

    expect(dup).toEqual({ id: "d1", text: "dup" });
    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.similarityThreshold).toBe(0.95);
    expect(call.limit).toBe(1);
    expect(call.filter).toEqual({ ownerId: { eq: deriveRamOwnerId("ns", "u", "personal") } });
  });

  test("findDuplicate returns null when items is empty", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    const provider = createRamProvider(cfg);
    expect(await provider.findDuplicate({ text: "x" })).toBeNull();
  });

  test("findDuplicate drops a record outside the scope's owner boundary", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      items: [{
        id: "other-scope",
        text: "someone else's secret",
        ownerId: deriveRamOwnerId("ns", "attacker", "personal"),
        createdAt: new Date(1),
        updatedAt: new Date(1),
      }],
    });
    const provider = createRamProvider(cfg);
    const dup = await provider.findDuplicate({ text: "x", key: "personal", namespace: "ns", userId: "u" });
    expect(dup).toBeNull();
  });

  // --------------------------------------------------------------------
  // deleteLongTerm
  // --------------------------------------------------------------------

  test("deleteLongTerm fetches, authorizes owner and namespace, then deletes", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    mocks.getLongTermMemory.mockResolvedValue({
      id: "x",
      text: "private",
      ownerId,
      namespace: "ns",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({ deleted: ["x"] });
    const provider = createRamProvider(cfg);

    await expect(provider.deleteLongTerm(["x"], {
      key: "personal",
      namespace: "ns",
      userId: "alice",
    })).resolves.toEqual({
      deletedIds: ["x"],
      notFoundIds: [],
      forbiddenIds: [],
      failedIds: [],
    });
    expect(mocks.getLongTermMemory).toHaveBeenCalledWith("x");
    expect(mocks.bulkDeleteLongTermMemories).toHaveBeenCalledWith({ memoryIds: ["x"] });
  });

  test("deleteLongTerm accepts an omitted RAM namespace only with the exact derived owner", async () => {
    mocks.getLongTermMemory.mockResolvedValue({
      id: "x",
      text: "extracted",
      ownerId: deriveRamOwnerId("ns", "alice", "personal"),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({ deleted: ["x"] });
    const provider = createRamProvider(cfg);

    const result = await provider.deleteLongTerm(["x"], {
      key: "personal",
      namespace: "ns",
      userId: "alice",
    });
    expect(result.deletedIds).toEqual(["x"]);
  });

  test.each([
    ["missing owner", { namespace: "ns" }],
    ["wrong owner", { ownerId: deriveRamOwnerId("ns", "mallory", "personal"), namespace: "ns" }],
    ["wrong namespace", { ownerId: deriveRamOwnerId("ns", "alice", "personal"), namespace: "other" }],
  ])("deleteLongTerm denies %s without calling bulk delete", async (_label, identity) => {
    mocks.getLongTermMemory.mockResolvedValue({
      id: "hostile-id",
      text: "must not leak",
      ...identity,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    const provider = createRamProvider(cfg);

    const result = await provider.deleteLongTerm(["hostile-id"], {
      key: "personal",
      namespace: "ns",
      userId: "alice",
    });

    expect(result.forbiddenIds).toEqual(["hostile-id"]);
    expect(mocks.bulkDeleteLongTermMemories).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("must not leak");
  });

  test("deleteLongTerm distinguishes not-found and fetch failures", async () => {
    mocks.getLongTermMemory
      .mockRejectedValueOnce(new RamApiError("not found", 404))
      .mockRejectedValueOnce(new RamApiError("service unavailable", 503));
    const provider = createRamProvider(cfg);

    const result = await provider.deleteLongTerm(["gone", "unknown"], {
      key: "personal",
      namespace: "ns",
      userId: "alice",
    });

    expect(result.notFoundIds).toEqual(["gone"]);
    expect(result.failedIds).toEqual(["unknown"]);
    expect(mocks.bulkDeleteLongTermMemories).not.toHaveBeenCalled();
  });

  test("deleteLongTerm reports partial bulk responses by exact id", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    mocks.getLongTermMemory.mockImplementation(async (id: string) => ({
      id,
      text: id,
      ownerId,
      namespace: "ns",
      createdAt: new Date(1),
      updatedAt: new Date(1),
    }));
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({
      deleted: ["ok"],
      errors: [{ id: "failed", error: "backend rejected it" }],
    });
    const provider = createRamProvider(cfg);

    const result = await provider.deleteLongTerm(["ok", "failed", "unaccounted"], {
      key: "personal",
      namespace: "ns",
      userId: "alice",
    });

    expect(result.deletedIds).toEqual(["ok"]);
    expect(result.failedIds).toEqual(["failed", "unaccounted"]);
  });

  test("deleteLongTerm de-duplicates caller ids before authorization", async () => {
    mocks.getLongTermMemory.mockResolvedValue({
      id: "x",
      text: "x",
      ownerId: deriveRamOwnerId(undefined, undefined, "default"),
      createdAt: new Date(1),
      updatedAt: new Date(1),
    });
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({ deleted: ["x"] });
    const provider = createRamProvider(cfg);

    const result = await provider.deleteLongTerm(["x", "x"], { key: "default" });
    expect(result.deletedIds).toEqual(["x"]);
    expect(mocks.getLongTermMemory).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------
  // scope erasure
  // --------------------------------------------------------------------

  test("eraseScope paginates, deletes sessions, re-sweeps extraction races, and verifies absence", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    let firstPageCalls = 0;
    mocks.searchLongTermMemory.mockImplementation(async ({ pageToken }) => {
      if (pageToken === "memory-next") {
        return { items: [{ id: "m2", text: "secret-two", ownerId, createdAt: new Date(1), updatedAt: new Date(1) }] };
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) {
        return {
          items: [{ id: "m1", text: "secret-one", ownerId, createdAt: new Date(1), updatedAt: new Date(1) }],
          nextPageToken: "memory-next",
        };
      }
      if (firstPageCalls === 2) {
        return { items: [{ id: "m3", text: "late-secret", ownerId, createdAt: new Date(1), updatedAt: new Date(1) }] };
      }
      return { items: [] };
    });
    let firstSessionPageCalls = 0;
    mocks.listSessions.mockImplementation(async ({ pageToken }) => {
      if (pageToken === "session-next") return { items: ["s2"], total: 2 };
      firstSessionPageCalls += 1;
      if (firstSessionPageCalls === 1) {
        return { items: ["s1"], total: 2, nextPageToken: "session-next" };
      }
      if (firstSessionPageCalls === 2) return { items: ["s3"], total: 1 };
      return { items: [], total: 0 };
    });
    mocks.getLongTermMemory.mockImplementation(async (id) => ({
      id,
      text: "must-not-escape",
      ownerId,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    }));
    mocks.getSessionMemory.mockImplementation(async (sessionId) => ({
      sessionId,
      ownerId,
      events: [],
    }));
    mocks.bulkDeleteLongTermMemories.mockImplementation(async ({ memoryIds }) => ({ deleted: memoryIds }));
    mocks.deleteSessionMemory.mockResolvedValue(undefined);

    const provider = createRamProvider(cfg);
    const result = await provider.eraseScope(
      { key: "personal", namespace: "ns", userId: "alice" },
      { settleMs: 0, maxRecords: 100 },
    );

    expect(result.status).toBe("verified_best_effort");
    expect(result.passes).toBe(2);
    expect(result.memoryIds).toEqual(["m1", "m2", "m3"]);
    expect(result.sessionIds).toEqual(["s1", "s2", "s3"]);
    expect(result.remainingMemoryIds).toEqual([]);
    expect(result.remainingSessionIds).toEqual([]);
    expect(result.residuals).toContain("queued_extraction_not_barriered");
    expect(mocks.listSessions).toHaveBeenCalledWith(expect.objectContaining({
      filterOwnerId: ownerId,
    }));
    expect(mocks.listSessions.mock.calls[0][0].includeAll).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("eraseScope reports partial deletion and remaining ids without memory text", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    mocks.searchLongTermMemory.mockResolvedValue({
      items: [{ id: "stuck", text: "erased-private-text", ownerId, createdAt: new Date(1), updatedAt: new Date(1) }],
    });
    mocks.searchLongTermMemory
      .mockResolvedValueOnce({
        items: [
          { id: "deleted", text: "erased-private-text", ownerId, createdAt: new Date(1), updatedAt: new Date(1) },
          { id: "stuck", text: "erased-private-text", ownerId, createdAt: new Date(1), updatedAt: new Date(1) },
        ],
      })
      .mockResolvedValue({
        items: [
          { id: "stuck", text: "erased-private-text", ownerId, createdAt: new Date(1), updatedAt: new Date(1) },
        ],
      });
    mocks.getLongTermMemory.mockImplementation(async (id) => ({
      id,
      text: "erased-private-text",
      ownerId,
      createdAt: new Date(1),
      updatedAt: new Date(1),
    }));
    mocks.bulkDeleteLongTermMemories.mockImplementation(async ({ memoryIds }) => ({
      deleted: memoryIds.includes("deleted") ? ["deleted"] : [],
      errors: memoryIds.includes("stuck") ? [{ id: "stuck" }] : [],
    }));
    mocks.listSessions.mockResolvedValue({ items: [], total: 0 });

    const provider = createRamProvider(cfg);
    const result = await provider.eraseScope(
      { key: "personal", namespace: "ns", userId: "alice" },
      { settleMs: 0, maxRecords: 100 },
    );
    expect(result.status).toBe("partial");
    expect(result.memoryIds).toEqual(["deleted"]);
    expect(result.failedMemoryIds).toEqual(["stuck"]);
    expect(result.remainingMemoryIds).toEqual(["stuck"]);
    expect(JSON.stringify(result)).not.toContain("erased-private-text");
  });

  test("eraseScope treats a session disappearing after enumeration as absent", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    mocks.listSessions
      .mockResolvedValueOnce({ items: ["gone"], total: 1 })
      .mockResolvedValue({ items: [], total: 0 });
    mocks.getSessionMemory.mockRejectedValue(new RamApiError("not found", 404));
    const provider = createRamProvider(cfg);
    const result = await provider.eraseScope(
      { key: "personal", namespace: "ns", userId: "alice" },
      { settleMs: 0, maxRecords: 100 },
    );
    expect(result.status).toBe("verified_best_effort");
    expect(result.failedSessionIds).toEqual([]);
    expect(mocks.deleteSessionMemory).not.toHaveBeenCalled();
    expect(mocks.listSessions.mock.calls[0][0].filterOwnerId).toBe(ownerId);
  });

  test("eraseScope bounds session validation and deletion concurrency", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    const sessionIds = Array.from({ length: 24 }, (_, index) => `session-${index}`);
    let listCalls = 0;
    mocks.searchLongTermMemory.mockResolvedValue({ items: [] });
    mocks.listSessions.mockImplementation(async () => ({
      items: listCalls++ === 0 ? sessionIds : [],
      total: listCalls === 1 ? sessionIds.length : 0,
    }));
    let activeGets = 0;
    let activeDeletes = 0;
    let maxGets = 0;
    let maxDeletes = 0;
    mocks.getSessionMemory.mockImplementation(async (sessionId) => {
      activeGets += 1;
      maxGets = Math.max(maxGets, activeGets);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeGets -= 1;
      return { sessionId, ownerId, events: [] };
    });
    mocks.deleteSessionMemory.mockImplementation(async () => {
      activeDeletes += 1;
      maxDeletes = Math.max(maxDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeDeletes -= 1;
    });

    const result = await createRamProvider(cfg).eraseScope(
      { key: "personal", namespace: "ns", userId: "alice" },
      { settleMs: 0, maxRecords: 100 },
    );
    expect(result.status).toBe("verified_best_effort");
    expect(result.sessionIds).toHaveLength(sessionIds.length);
    expect(maxGets).toBeLessThanOrEqual(RAM_ERASURE_CONCURRENCY);
    expect(maxDeletes).toBeLessThanOrEqual(RAM_ERASURE_CONCURRENCY);
    expect(RAM_ERASURE_CONCURRENCY).toBe(4);
  });

  test("eraseScope reports a 429 authorization read as an explicit partial result", async () => {
    const ownerId = deriveRamOwnerId("ns", "alice", "personal");
    let searchCalls = 0;
    mocks.searchLongTermMemory.mockImplementation(async () => {
      searchCalls += 1;
      const ids = searchCalls === 1 ? ["deleted", "rate-limited"] : ["rate-limited"];
      return {
        items: ids.map((id) => ({
          id,
          text: "private",
          ownerId,
          createdAt: new Date(1),
          updatedAt: new Date(1),
        })),
      };
    });
    mocks.getLongTermMemory.mockImplementation(async (id) => {
      if (id === "rate-limited") throw new RamApiError("rate limited", 429);
      return {
        id,
        text: "private",
        ownerId,
        createdAt: new Date(1),
        updatedAt: new Date(1),
      };
    });
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({ deleted: ["deleted"] });
    mocks.listSessions.mockResolvedValue({ items: [], total: 0 });

    const result = await createRamProvider(cfg).eraseScope(
      { key: "personal", namespace: "ns", userId: "alice" },
      { settleMs: 0, maxRecords: 100 },
    );
    expect(result.status).toBe("partial");
    expect(result.memoryIds).toEqual(["deleted"]);
    expect(result.failedMemoryIds).toEqual(["rate-limited"]);
    expect(result.remainingMemoryIds).toEqual(["rate-limited"]);
  });

  // --------------------------------------------------------------------
  // getCaptureCheckpoint
  // --------------------------------------------------------------------

  test("getCaptureCheckpoint returns the max timestamp and ids at that timestamp", async () => {
    mocks.getSessionMemory.mockResolvedValue({
      sessionId: "s",
      ownerId: "default",
      events: [
        { eventId: "1", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "a" }], createdAt: new Date(1000), systemTimestamp: new Date(1000), metadata: { openclawMessageId: "old" } },
        { eventId: "2", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "b" }], createdAt: new Date(3000), systemTimestamp: new Date(3000), metadata: { openclawMessageId: "max-a" } },
        { eventId: "3", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "c" }], createdAt: new Date(2000), systemTimestamp: new Date(2000), metadata: { openclawMessageId: "middle" } },
        { eventId: "4", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "d" }], createdAt: new Date(3000), systemTimestamp: new Date(3000), metadata: { openclawMessageId: "max-b" } },
      ],
    });

    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toEqual({
      maxTimestampMs: 3000,
      messageIdsAtMax: ["max-a", "max-b"],
    });
  });

  test("getCaptureCheckpoint returns 0 when there are no events", async () => {
    mocks.getSessionMemory.mockResolvedValue({ sessionId: "s", ownerId: "default", events: [] });
    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toEqual({
      maxTimestampMs: 0,
      messageIdsAtMax: [],
    });
  });

  test("getCaptureCheckpoint returns 0 on a 404 RamApiError", async () => {
    mocks.getSessionMemory.mockRejectedValue(new RamApiError("not found", 404));
    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toEqual({
      maxTimestampMs: 0,
      messageIdsAtMax: [],
    });
  });

  test("getCaptureCheckpoint rethrows non-404 errors", async () => {
    mocks.getSessionMemory.mockRejectedValue(new RamApiError("server error", 500));
    const provider = createRamProvider(cfg);
    await expect(provider.getCaptureCheckpoint("s", {})).rejects.toThrow("server error");
  });

  test("getCaptureCheckpoint handles long session histories without argument spreading", async () => {
    const events = Array.from({ length: 100000 }, (_, index) => ({
      eventId: `event-${index}`,
      actorId: "a",
      sessionId: "s",
      role: "USER" as const,
      content: [{ text: String(index) }],
      createdAt: new Date(index + 1),
      systemTimestamp: new Date(index + 1),
      metadata: { openclawMessageId: `message-${index}` },
    }));
    mocks.getSessionMemory.mockResolvedValue({
      sessionId: "s",
      ownerId: "default",
      events,
    });

    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toEqual({
      maxTimestampMs: 100000,
      messageIdsAtMax: ["message-99999"],
    });
  });

  // --------------------------------------------------------------------
  // captureMessages
  // --------------------------------------------------------------------

  test("captureMessages sends N sequential addSessionEvent calls with Date timestamps and uppercase roles", async () => {
    mocks.addSessionEvent.mockResolvedValue(undefined);
    const provider = createRamProvider(cfg);

    const messages = [
      { role: "user" as const, content: "hi", id: "m1", timestampMs: 1000 },
      { role: "assistant" as const, content: "hello", id: "m2", timestampMs: 2000 },
      { role: "user" as const, content: "bye", id: "m3", timestampMs: 3000 },
    ];

    await provider.captureMessages("session-1", messages, { key: "personal", namespace: "ns", userId: "u" });

    expect(mocks.addSessionEvent).toHaveBeenCalledTimes(3);
    expect(mocks.addSessionEvent.mock.calls.map((call) => call[0])).toEqual([
      { actorId: deriveRamOwnerId("ns", "u", "personal"), role: "USER", content: [{ text: "hi" }], createdAt: new Date(1000), sessionId: "session-1", metadata: { openclawMessageId: "m1", openclawScopeKey: "personal" } },
      { actorId: deriveRamOwnerId("ns", "u", "personal"), role: "ASSISTANT", content: [{ text: "hello" }], createdAt: new Date(2000), sessionId: "session-1", metadata: { openclawMessageId: "m2", openclawScopeKey: "personal" } },
      { actorId: deriveRamOwnerId("ns", "u", "personal"), role: "USER", content: [{ text: "bye" }], createdAt: new Date(3000), sessionId: "session-1", metadata: { openclawMessageId: "m3", openclawScopeKey: "personal" } },
    ]);
  });

  test("captureMessages uses the shared namespace owner when userId is not provided", async () => {
    mocks.addSessionEvent.mockResolvedValue(undefined);
    const provider = createRamProvider(cfg);

    await provider.captureMessages(
      "s",
      [{ role: "user", content: "hi", id: "m1", timestampMs: 1 }],
      { namespace: "shared-app" },
    );

    expect(mocks.addSessionEvent.mock.calls[0][0].actorId).toBe(
      deriveRamOwnerId("shared-app", undefined),
    );
  });

  test("captureMessages calls addSessionEvent sequentially, not concurrently", async () => {
    const order: string[] = [];
    mocks.addSessionEvent.mockImplementation(async (event: { content: [{ text: string }] }) => {
      order.push(`start:${event.content[0].text}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end:${event.content[0].text}`);
    });

    const provider = createRamProvider(cfg);
    await provider.captureMessages(
      "s",
      [
        { role: "user", content: "one", id: "m1", timestampMs: 1 },
        { role: "user", content: "two", id: "m2", timestampMs: 2 },
      ],
      {},
    );

    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });

  test("captureMessages stops after a mid-batch failure without sending further events", async () => {
    mocks.addSessionEvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new RamApiError("boom", 500));
    const provider = createRamProvider(cfg);

    let caught: unknown;
    try {
      await provider.captureMessages(
        "s",
        [
          { role: "user", content: "one", id: "m1", timestampMs: 1 },
          { role: "user", content: "two", id: "m2", timestampMs: 2 },
          { role: "user", content: "three", id: "m3", timestampMs: 3 },
        ],
        {},
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      message: "RAM capture stopped after an event request failed",
      acceptedMessageIds: ["m1"],
    });

    expect(mocks.addSessionEvent).toHaveBeenCalledTimes(2);
  });

  test.each([-1, 1.5, Number.NaN, 8_640_000_000_000_001])(
    "captureMessages rejects invalid timestamp %s before transport",
    async (timestampMs) => {
      const provider = createRamProvider(cfg);
      await expect(provider.captureMessages(
        "session-1",
        [{ role: "user", content: "valid", id: "m1", timestampMs }],
        {},
      )).rejects.toThrow(/valid nonnegative Unix timestamp/);
      expect(mocks.addSessionEvent).not.toHaveBeenCalled();
    },
  );
});
