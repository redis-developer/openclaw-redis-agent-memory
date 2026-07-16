/**
 * Unit tests for the AMS provider.
 *
 * `MemoryAPIClient` is mocked at the module level so these tests run with no
 * network access or credentials. They assert the translation logic that used
 * to live in `src/index.ts`:
 *   - minScore -> distanceThreshold (1 - minScore) and dist -> score mapping
 *   - post-filter dropping results below minScore
 *   - findDuplicate boundary (dist 0.049 dup, 0.05 not)
 *   - createLongTerm generated id + topics/namespace/user_id forwarding
 *   - captureMessages ISO created_at rendering + long_term_memory_strategy
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import type { MemoryConfig } from "../config.js";

const mocks = vi.hoisted(() => ({
  searchLongTermMemory: vi.fn(),
  createLongTermMemory: vi.fn(),
  deleteLongTermMemories: vi.fn(),
  getWorkingMemory: vi.fn(),
  putWorkingMemory: vi.fn(),
  healthCheck: vi.fn(),
  listSummaryViews: vi.fn(),
  createSummaryView: vi.fn(),
  runSummaryView: vi.fn(),
  listSummaryViewPartitions: vi.fn(),
}));

vi.mock("agent-memory-client", () => {
  class MemoryAPIClient {
    searchLongTermMemory = mocks.searchLongTermMemory;
    createLongTermMemory = mocks.createLongTermMemory;
    deleteLongTermMemories = mocks.deleteLongTermMemories;
    getWorkingMemory = mocks.getWorkingMemory;
    putWorkingMemory = mocks.putWorkingMemory;
    healthCheck = mocks.healthCheck;
    listSummaryViews = mocks.listSummaryViews;
    createSummaryView = mocks.createSummaryView;
    runSummaryView = mocks.runSummaryView;
    listSummaryViewPartitions = mocks.listSummaryViewPartitions;
    constructor(_config: unknown) {}
  }
  class MemoryNotFoundError extends Error {}
  return { MemoryAPIClient, MemoryNotFoundError };
});

import { createAmsProvider } from "./ams.js";

const cfg = {
  serverUrl: "http://localhost:8000",
  namespace: "test-ns",
} as MemoryConfig;

describe("createAmsProvider", () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  test("capabilities are all true for AMS and summaries is present", () => {
    const provider = createAmsProvider(cfg);
    expect(provider.capabilities).toEqual({
      summaryViews: true,
      extractionStrategy: true,
      similarityScores: true,
    });
    expect(provider.summaries).toBeDefined();
  });

  test("healthCheck resolves void", async () => {
    mocks.healthCheck.mockResolvedValue({ now: 1 });
    const provider = createAmsProvider(cfg);
    await expect(provider.healthCheck()).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------
  // searchLongTerm: distanceThreshold + dist->score + post-filter
  // --------------------------------------------------------------------

  test("translates minScore to distanceThreshold and maps dist to score", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [
        { id: "a", text: "alpha", dist: 0.1, topics: ["t1"], entities: ["e1"] },
        { id: "b", text: "beta", dist: 0.2 },
      ],
      total: 2,
    });

    const provider = createAmsProvider(cfg);
    const results = await provider.searchLongTerm({
      text: "q",
      limit: 5,
      namespace: "ns",
      userId: "u",
      minScore: 0.5,
    });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.text).toBe("q");
    expect(call.limit).toBe(5);
    expect(call.distanceThreshold).toBeCloseTo(0.5); // 1 - 0.5
    expect(call.namespace).toEqual({ eq: "ns" });
    expect(call.userId).toEqual({ eq: "u" });

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeCloseTo(0.9); // 1 - 0.1
    expect(results[0].topics).toEqual(["t1"]);
    expect(results[0].entities).toEqual(["e1"]);
    expect(results[1].id).toBe("b");
    expect(results[1].score).toBeCloseTo(0.8); // 1 - 0.2
    expect(results[1].topics).toBeUndefined();
    expect(results[1].entities).toBeUndefined();
  });

  test("omits namespace/userId filters when not provided and distanceThreshold when minScore unset", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [], total: 0 });
    const provider = createAmsProvider(cfg);
    await provider.searchLongTerm({ text: "q", limit: 3 });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.namespace).toBeUndefined();
    expect(call.userId).toBeUndefined();
    expect(call.distanceThreshold).toBeUndefined();
  });

  test("post-filters results below minScore", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [
        { id: "keep", text: "keep", dist: 0.1 }, // score 0.9 >= 0.5
        { id: "drop", text: "drop", dist: 0.6 }, // score 0.4 < 0.5
      ],
      total: 2,
    });

    const provider = createAmsProvider(cfg);
    const results = await provider.searchLongTerm({ text: "q", limit: 5, minScore: 0.5 });
    expect(results.map((r) => r.id)).toEqual(["keep"]);
  });

  test("post-filter defaults to 0.3 when minScore is undefined", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [
        { id: "keep", text: "keep", dist: 0.5 }, // score 0.5 >= 0.3
        { id: "drop", text: "drop", dist: 0.8 }, // score ~0.2 < 0.3
      ],
      total: 2,
    });

    const provider = createAmsProvider(cfg);
    const results = await provider.searchLongTerm({ text: "q", limit: 5 });
    expect(results.map((r) => r.id)).toEqual(["keep"]);
  });

  // --------------------------------------------------------------------
  // findDuplicate boundary
  // --------------------------------------------------------------------

  test("findDuplicate treats dist 0.049 as a duplicate", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [{ id: "d1", text: "dup", dist: 0.049 }],
      total: 1,
    });

    const provider = createAmsProvider(cfg);
    const dup = await provider.findDuplicate({ text: "x", namespace: "ns", userId: "u" });
    expect(dup).toEqual({ id: "d1", text: "dup" });

    const call = mocks.searchLongTermMemory.mock.calls[0][0];
    expect(call.limit).toBe(1);
    expect(call.distanceThreshold).toBeUndefined();
    expect(call.namespace).toEqual({ eq: "ns" });
    expect(call.userId).toEqual({ eq: "u" });
  });

  test("findDuplicate treats dist 0.05 as not a duplicate", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({
      memories: [{ id: "d2", text: "notdup", dist: 0.05 }],
      total: 1,
    });

    const provider = createAmsProvider(cfg);
    const dup = await provider.findDuplicate({ text: "x" });
    expect(dup).toBeNull();
  });

  test("findDuplicate returns null when there are no results", async () => {
    mocks.searchLongTermMemory.mockResolvedValue({ memories: [], total: 0 });
    const provider = createAmsProvider(cfg);
    expect(await provider.findDuplicate({ text: "x" })).toBeNull();
  });

  // --------------------------------------------------------------------
  // createLongTerm
  // --------------------------------------------------------------------

  test("createLongTerm generates an id and forwards topics, namespace, user_id", async () => {
    mocks.createLongTermMemory.mockResolvedValue({ status: "ok" });
    const provider = createAmsProvider(cfg);

    const result = await provider.createLongTerm({
      text: "remember this",
      topics: ["fact"],
      namespace: "ns",
      userId: "u",
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
    const [memories, options] = mocks.createLongTermMemory.mock.calls[0];
    expect(memories).toEqual([
      { id: result.id, text: "remember this", topics: ["fact"], namespace: "ns", user_id: "u" },
    ]);
    expect(options).toEqual({ namespace: "ns" });
  });

  test("createLongTerm omits user_id when userId is not provided", async () => {
    mocks.createLongTermMemory.mockResolvedValue({ status: "ok" });
    const provider = createAmsProvider(cfg);

    const result = await provider.createLongTerm({
      text: "t",
      topics: ["fact"],
      namespace: "ns",
    });

    const [memories] = mocks.createLongTermMemory.mock.calls[0];
    expect(memories[0]).not.toHaveProperty("user_id");
    expect(memories[0]).toEqual({
      id: result.id,
      text: "t",
      topics: ["fact"],
      namespace: "ns",
    });
  });

  // --------------------------------------------------------------------
  // deleteLongTerm
  // --------------------------------------------------------------------

  test("deleteLongTerm forwards ids and namespace", async () => {
    mocks.deleteLongTermMemories.mockResolvedValue({ status: "ok" });
    const provider = createAmsProvider(cfg);
    await provider.deleteLongTerm(["x", "y"], { namespace: "ns" });
    expect(mocks.deleteLongTermMemories).toHaveBeenCalledWith(["x", "y"], { namespace: "ns" });
  });

  // --------------------------------------------------------------------
  // getCaptureCheckpoint
  // --------------------------------------------------------------------

  test("getCaptureCheckpoint returns the max created_at epoch ms", async () => {
    mocks.getWorkingMemory.mockResolvedValue({
      messages: [
        { role: "user", content: "a", created_at: new Date(1000).toISOString() },
        { role: "user", content: "b", created_at: new Date(3000).toISOString() },
        { role: "user", content: "c", created_at: new Date(2000).toISOString() },
      ],
    });

    const provider = createAmsProvider(cfg);
    expect(await provider.getCaptureCheckpoint("s", { namespace: "ns" })).toBe(3000);
    expect(mocks.getWorkingMemory).toHaveBeenCalledWith("s", { namespace: "ns" });
  });

  test("getCaptureCheckpoint returns 0 when working memory is null or empty", async () => {
    const provider = createAmsProvider(cfg);

    mocks.getWorkingMemory.mockResolvedValueOnce(null);
    expect(await provider.getCaptureCheckpoint("s", {})).toBe(0);

    mocks.getWorkingMemory.mockResolvedValueOnce({ messages: [] });
    expect(await provider.getCaptureCheckpoint("s", {})).toBe(0);
  });

  // --------------------------------------------------------------------
  // captureMessages
  // --------------------------------------------------------------------

  test("captureMessages renders created_at ISO from timestampMs and passes custom strategy", async () => {
    mocks.putWorkingMemory.mockResolvedValue({});
    const provider = createAmsProvider(cfg);
    const ts = 1706900000000;

    await provider.captureMessages(
      "session-1",
      [{ role: "user", content: "hi", id: "m1", timestampMs: ts }],
      { namespace: "ns", userId: "u", extractionStrategy: "custom", customPrompt: "my prompt" },
    );

    const [sessionId, wm] = mocks.putWorkingMemory.mock.calls[0];
    expect(sessionId).toBe("session-1");
    expect(wm.messages).toEqual([
      { role: "user", content: "hi", id: "m1", created_at: new Date(ts).toISOString() },
    ]);
    expect(wm.namespace).toBe("ns");
    expect(wm.user_id).toBe("u");
    expect(wm.long_term_memory_strategy).toEqual({
      strategy: "custom",
      config: { prompt: "my prompt" },
    });
  });

  test("captureMessages builds a discrete strategy with empty config and omits user_id", async () => {
    mocks.putWorkingMemory.mockResolvedValue({});
    const provider = createAmsProvider(cfg);

    await provider.captureMessages(
      "s",
      [{ role: "assistant", content: "c", id: "m", timestampMs: 1 }],
      { extractionStrategy: "discrete" },
    );

    const [, wm] = mocks.putWorkingMemory.mock.calls[0];
    expect(wm.long_term_memory_strategy).toEqual({ strategy: "discrete", config: {} });
    expect(wm).not.toHaveProperty("user_id");
  });

  test("captureMessages omits long_term_memory_strategy when extractionStrategy is unset", async () => {
    mocks.putWorkingMemory.mockResolvedValue({});
    const provider = createAmsProvider(cfg);

    await provider.captureMessages(
      "s",
      [{ role: "user", content: "c", id: "m", timestampMs: 1 }],
      {},
    );

    const [, wm] = mocks.putWorkingMemory.mock.calls[0];
    expect(wm.long_term_memory_strategy).toBeUndefined();
  });
});
