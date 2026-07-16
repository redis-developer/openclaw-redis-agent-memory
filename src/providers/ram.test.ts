/**
 * Unit tests for the RAM provider.
 *
 * `RamClient` is mocked at the module level so these tests run with no
 * network access or credentials. They assert the translation logic that is
 * unique to RAM vs. AMS:
 *   - minScore -> similarityThreshold UNtransformed (no 1 - minScore inversion)
 *   - no client-side score filtering (server already applied the threshold)
 *   - namespace/userId -> filter.namespace.eq / filter.ownerId.eq
 *   - createLongTerm generated id (UUID) + ownerId "default" fallback
 *   - findDuplicate similarityThreshold 0.95 boundary
 *   - captureMessages sequential ordering + UPPERCASE roles + epoch timestamps
 *   - getCaptureCheckpoint max(createdAt) + 404 -> 0
 *   - deleteLongTerm throws when deleted is empty and errors is non-empty
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MemoryConfig } from "../config.js";
import { RamApiError } from "../ram/types.js";

const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  bulkCreateLongTermMemories: vi.fn(),
  bulkDeleteLongTermMemories: vi.fn(),
  searchLongTermMemory: vi.fn(),
  addSessionEvent: vi.fn(),
  getSessionMemory: vi.fn(),
  deleteSessionMemory: vi.fn(),
  listSessions: vi.fn(),
}));

vi.mock("../ram/client.js", () => {
  class RamClient {
    health = mocks.health;
    bulkCreateLongTermMemories = mocks.bulkCreateLongTermMemories;
    bulkDeleteLongTermMemories = mocks.bulkDeleteLongTermMemories;
    searchLongTermMemory = mocks.searchLongTermMemory;
    addSessionEvent = mocks.addSessionEvent;
    getSessionMemory = mocks.getSessionMemory;
    deleteSessionMemory = mocks.deleteSessionMemory;
    listSessions = mocks.listSessions;
    constructor(_opts: unknown) {}
  }
  return { RamClient };
});

import { createRamProvider } from "./ram.js";

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
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5, minScore: 0.4 });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.similarityThreshold).toBe(0.4);
    expect(call.text).toBe("q");
    expect(call.limit).toBe(5);
  });

  test("maps namespace to filter.namespace.eq and userId to filter.ownerId.eq", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5, namespace: "ns", userId: "u" });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.filter).toEqual({ namespace: { eq: "ns" }, ownerId: { eq: "u" } });
  });

  test("omits filter entirely when namespace and userId are both unset", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [] });
    const provider = createRamProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 5 });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.filter).toBeUndefined();
  });

  test("maps records to ProviderSearchResult with score undefined, topics passthrough, entities undefined, and applies no client-side filtering", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [
        { id: "a", text: "alpha", createdAt: 1, updatedAt: 1, topics: ["t1"] },
        { id: "b", text: "beta", createdAt: 2, updatedAt: 2 },
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
    });
    expect(results[1]).toEqual({
      id: "b",
      text: "beta",
      score: undefined,
      topics: undefined,
      entities: undefined,
    });
  });

  // --------------------------------------------------------------------
  // createLongTerm
  // --------------------------------------------------------------------

  test("createLongTerm generates a UUID id and defaults ownerId to 'default'", async () => {
    // A successful bulk create echoes the caller-supplied id in `created`.
    mocks.bulkCreateLongTermMemories.mockImplementation(async (records) => ({
      created: [records[0].id],
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
    const [records] = mocks.bulkCreateLongTermMemories.mock.calls[0];
    expect(records).toEqual([
      {
        id: result.id,
        text: "remember this",
        topics: ["fact"],
        namespace: "ns",
        ownerId: "default",
      },
    ]);
  });

  test("createLongTerm forwards userId as ownerId when provided", async () => {
    mocks.bulkCreateLongTermMemories.mockImplementation(async (records) => ({
      created: [records[0].id],
    }));
    const provider = createRamProvider(cfg);

    await provider.createLongTerm({ text: "t", topics: ["fact"], namespace: "ns", userId: "u" });

    const [records] = mocks.bulkCreateLongTermMemories.mock.calls[0];
    expect(records[0].ownerId).toBe("u");
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

  // --------------------------------------------------------------------
  // findDuplicate
  // --------------------------------------------------------------------

  test("findDuplicate searches with similarityThreshold 0.95 and limit 1, applying the same filters", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [{ id: "d1", text: "dup", createdAt: 1, updatedAt: 1 }],
    });

    const provider = createRamProvider(cfg);
    const dup = await provider.findDuplicate({ text: "x", namespace: "ns", userId: "u" });

    expect(dup).toEqual({ id: "d1", text: "dup" });
    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.similarityThreshold).toBe(0.95);
    expect(call.limit).toBe(1);
    expect(call.filter).toEqual({ namespace: { eq: "ns" }, ownerId: { eq: "u" } });
  });

  test("findDuplicate returns null when memories is empty", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [] });
    const provider = createRamProvider(cfg);
    expect(await provider.findDuplicate({ text: "x" })).toBeNull();
  });

  // --------------------------------------------------------------------
  // deleteLongTerm
  // --------------------------------------------------------------------

  test("deleteLongTerm throws when deleted is empty and errors is non-empty", async () => {
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({
      deleted: [],
      errors: [{ id: "x", error: "not found" }],
    });
    const provider = createRamProvider(cfg);

    await expect(provider.deleteLongTerm(["x"], {})).rejects.toThrow();
  });

  test("deleteLongTerm resolves on the happy path (deleted non-empty)", async () => {
    mocks.bulkDeleteLongTermMemories.mockResolvedValue({ deleted: ["x", "y"] });
    const provider = createRamProvider(cfg);

    await expect(provider.deleteLongTerm(["x", "y"], { namespace: "ns" })).resolves.toBeUndefined();
    expect(mocks.bulkDeleteLongTermMemories).toHaveBeenCalledWith(["x", "y"]);
  });

  // --------------------------------------------------------------------
  // getCaptureCheckpoint
  // --------------------------------------------------------------------

  test("getCaptureCheckpoint returns the max createdAt across events", async () => {
    mocks.getSessionMemory.mockResolvedValue({
      sessionId: "s",
      ownerId: "default",
      events: [
        { eventId: "1", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "a" }], createdAt: 1000 },
        { eventId: "2", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "b" }], createdAt: 3000 },
        { eventId: "3", actorId: "a", sessionId: "s", role: "USER", content: [{ text: "c" }], createdAt: 2000 },
      ],
    });

    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toBe(3000);
  });

  test("getCaptureCheckpoint returns 0 when there are no events", async () => {
    mocks.getSessionMemory.mockResolvedValue({ sessionId: "s", ownerId: "default", events: [] });
    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toBe(0);
  });

  test("getCaptureCheckpoint returns 0 on a 404 RamApiError", async () => {
    mocks.getSessionMemory.mockRejectedValue(new RamApiError("not found", 404));
    const provider = createRamProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", {})).toBe(0);
  });

  test("getCaptureCheckpoint rethrows non-404 errors", async () => {
    mocks.getSessionMemory.mockRejectedValue(new RamApiError("server error", 500));
    const provider = createRamProvider(cfg);
    await expect(provider.getCaptureCheckpoint("s", {})).rejects.toThrow("server error");
  });

  // --------------------------------------------------------------------
  // captureMessages
  // --------------------------------------------------------------------

  test("captureMessages sends N sequential addSessionEvent calls, in order, with preserved epoch timestamps and UPPERCASE roles", async () => {
    mocks.addSessionEvent.mockResolvedValue(undefined);
    const provider = createRamProvider(cfg);

    const messages = [
      { role: "user" as const, content: "hi", id: "m1", timestampMs: 1000 },
      { role: "assistant" as const, content: "hello", id: "m2", timestampMs: 2000 },
      { role: "user" as const, content: "bye", id: "m3", timestampMs: 3000 },
    ];

    await provider.captureMessages("session-1", messages, { userId: "u" });

    expect(mocks.addSessionEvent).toHaveBeenCalledTimes(3);
    expect(mocks.addSessionEvent.mock.calls.map((call) => call[0])).toEqual([
      { actorId: "u", role: "USER", content: [{ text: "hi" }], createdAt: 1000, sessionId: "session-1" },
      { actorId: "u", role: "ASSISTANT", content: [{ text: "hello" }], createdAt: 2000, sessionId: "session-1" },
      { actorId: "u", role: "USER", content: [{ text: "bye" }], createdAt: 3000, sessionId: "session-1" },
    ]);
  });

  test("captureMessages defaults actorId to 'default' when userId is not provided", async () => {
    mocks.addSessionEvent.mockResolvedValue(undefined);
    const provider = createRamProvider(cfg);

    await provider.captureMessages(
      "s",
      [{ role: "user", content: "hi", id: "m1", timestampMs: 1 }],
      {},
    );

    expect(mocks.addSessionEvent.mock.calls[0][0].actorId).toBe("default");
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

    await expect(
      provider.captureMessages(
        "s",
        [
          { role: "user", content: "one", id: "m1", timestampMs: 1 },
          { role: "user", content: "two", id: "m2", timestampMs: 2 },
          { role: "user", content: "three", id: "m3", timestampMs: 3 },
        ],
        {},
      ),
    ).rejects.toThrow("boom");

    expect(mocks.addSessionEvent).toHaveBeenCalledTimes(2);
  });
});
