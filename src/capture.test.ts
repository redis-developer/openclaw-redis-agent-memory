import { describe, expect, test, vi } from "vitest";

import { CaptureCoordinator, truncateCapturedContent } from "./capture.js";
import {
  CaptureBatchError,
  type CaptureCheckpoint,
  type CapturedMessage,
  type MemoryProvider,
} from "./provider.js";

function message(id: string, timestampMs: number): CapturedMessage {
  return { role: "user", content: id, id, timestampMs };
}

function checkpoint(messages: CapturedMessage[]): CaptureCheckpoint {
  let maxTimestampMs = 0;
  for (const item of messages) maxTimestampMs = Math.max(maxTimestampMs, item.timestampMs);
  return {
    maxTimestampMs,
    messageIdsAtMax: messages
      .filter((item) => item.timestampMs === maxTimestampMs)
      .map((item) => item.id),
  };
}

function fakeProvider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    capabilities: {
      summaryViews: false,
      extractionStrategy: false,
      similarityScores: false,
    },
    deriveCaptureSessionId: (identity) => identity,
    healthCheck: async () => {},
    searchLongTerm: async () => [],
    createLongTerm: async () => ({ id: "created" }),
    deleteLongTerm: async (ids) => ({
      deletedIds: ids,
      notFoundIds: [],
      forbiddenIds: [],
      failedIds: [],
    }),
    findDuplicate: async () => null,
    getCaptureCheckpoint: async () => ({ maxTimestampMs: 0, messageIdsAtMax: [] }),
    captureMessages: async (_sessionId, messages) => ({
      acceptedMessageIds: messages.map((item) => item.id),
    }),
    ...overrides,
  };
}

const scope = { key: "personal", namespace: "app", userId: "alice" };

describe("CaptureCoordinator", () => {
  test("reconciles equal timestamps by message id across repeats and process restart", async () => {
    const remote: CapturedMessage[] = [];
    const captureMessages = vi.fn(async (_sessionId, messages: CapturedMessage[]) => {
      remote.push(...messages);
      return { acceptedMessageIds: messages.map((item) => item.id) };
    });
    const provider = fakeProvider({
      getCaptureCheckpoint: vi.fn(async () => checkpoint(remote)),
      captureMessages,
    });
    const firstProcess = new CaptureCoordinator(provider);
    const firstTranscript = [message("a", 1000), message("b", 1000)];

    await firstProcess.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: firstTranscript,
      scope,
    });
    await firstProcess.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: firstTranscript,
      scope,
    });

    const restarted = new CaptureCoordinator(provider);
    await restarted.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: [...firstTranscript, message("c", 1000)],
      scope,
    });

    expect(remote.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(captureMessages).toHaveBeenCalledTimes(2);
  });

  test("reconciles an ambiguously accepted event before replaying a partial batch", async () => {
    const remote: CapturedMessage[] = [];
    let firstAttempt = true;
    const provider = fakeProvider({
      getCaptureCheckpoint: vi.fn(async () => checkpoint(remote)),
      captureMessages: vi.fn(async (_sessionId, messages) => {
        if (firstAttempt) {
          firstAttempt = false;
          remote.push(messages[0], messages[1]);
          throw new CaptureBatchError("timeout", [messages[0].id]);
        }
        remote.push(...messages);
        return { acceptedMessageIds: messages.map((item) => item.id) };
      }),
    });
    const coordinator = new CaptureCoordinator(provider, undefined, { readAttempts: 1 });
    const transcript = [message("a", 1000), message("b", 1000), message("c", 1000)];

    await expect(coordinator.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: transcript,
      scope,
    })).rejects.toThrow("timeout");
    await coordinator.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: transcript,
      scope,
    });

    expect(remote.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(coordinator.getMetrics()).toMatchObject({ captured: 2, permanentlyFailed: 1 });
  });

  test("replays the unaccepted suffix after a mid-batch failure without duplicating its prefix", async () => {
    const remote: CapturedMessage[] = [];
    let firstAttempt = true;
    const provider = fakeProvider({
      getCaptureCheckpoint: vi.fn(async () => checkpoint(remote)),
      captureMessages: vi.fn(async (_sessionId, messages) => {
        if (firstAttempt) {
          firstAttempt = false;
          remote.push(messages[0]);
          throw new CaptureBatchError("failed second event", [messages[0].id]);
        }
        remote.push(...messages);
        return { acceptedMessageIds: messages.map((item) => item.id) };
      }),
    });
    const coordinator = new CaptureCoordinator(provider, undefined, { readAttempts: 1 });
    const transcript = [message("a", 1000), message("b", 1000), message("c", 1000)];

    await expect(coordinator.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: transcript,
      scope,
    })).rejects.toThrow();
    await coordinator.capture({
      trackingKey: "key",
      sessionId: "session",
      messages: transcript,
      scope,
    });

    expect(remote.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  test("serializes one session while independent sessions obey the global concurrency bound", async () => {
    const remote = new Map<string, CapturedMessage[]>();
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const provider = fakeProvider({
      getCaptureCheckpoint: vi.fn(async (sessionId) => checkpoint(remote.get(sessionId) ?? [])),
      captureMessages: vi.fn(async (sessionId, messages) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const stored = remote.get(sessionId) ?? [];
        stored.push(...messages);
        remote.set(sessionId, stored);
        order.push(...messages.map((item) => `${sessionId}:${item.id}`));
        active -= 1;
        return { acceptedMessageIds: messages.map((item) => item.id) };
      }),
    });
    const coordinator = new CaptureCoordinator(provider, undefined, { concurrency: 2 });

    await Promise.all([
      coordinator.capture({ trackingKey: "same", sessionId: "same", messages: [message("a", 1)], scope }),
      coordinator.capture({ trackingKey: "same", sessionId: "same", messages: [message("a", 1), message("b", 2)], scope }),
      coordinator.capture({ trackingKey: "other-1", sessionId: "other-1", messages: [message("c", 1)], scope }),
      coordinator.capture({ trackingKey: "other-2", sessionId: "other-2", messages: [message("d", 1)], scope }),
    ]);

    expect(order.filter((entry) => entry.startsWith("same:"))).toEqual(["same:a", "same:b"]);
    expect(maxActive).toBe(2);
    expect(coordinator.lockEntryCount).toBe(0);
  });

  test("retries only retryable checkpoint reads with capped exponential delays", async () => {
    const sleep = vi.fn(async () => {});
    const getCaptureCheckpoint = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("server"), { statusCode: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error("network"), { code: "ECONNRESET" }))
      .mockResolvedValue({ maxTimestampMs: 0, messageIdsAtMax: [] });
    const provider = fakeProvider({ getCaptureCheckpoint });
    const coordinator = new CaptureCoordinator(provider, undefined, {
      readAttempts: 3,
      retryBaseMs: 10,
      sleep,
    });

    await coordinator.capture({
      trackingKey: "retry",
      sessionId: "retry",
      messages: [message("a", 1)],
      scope,
    });

    expect(getCaptureCheckpoint).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20]);
    expect(coordinator.getMetrics().retried).toBe(2);

    const authRead = vi.fn(async () => {
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const authCoordinator = new CaptureCoordinator(
      fakeProvider({ getCaptureCheckpoint: authRead }),
      undefined,
      { readAttempts: 3, sleep },
    );
    await expect(authCoordinator.capture({
      trackingKey: "auth",
      sessionId: "auth",
      messages: [message("a", 1)],
      scope,
    })).rejects.toThrow("unauthorized");
    expect(authRead).toHaveBeenCalledTimes(1);
  });

  test("drains every bounded batch and keeps cache and lock state bounded", async () => {
    const captureMessages = vi.fn(async (_sessionId, messages: CapturedMessage[]) => ({
      acceptedMessageIds: messages.map((item) => item.id),
    }));
    const coordinator = new CaptureCoordinator(
      fakeProvider({ captureMessages }),
      undefined,
      { batchSize: 2, cacheSize: 2 },
    );

    await coordinator.capture({
      trackingKey: "batch",
      sessionId: "batch",
      messages: [1, 2, 3, 4, 5].map((value) => message(String(value), value)),
      scope,
    });
    expect(captureMessages.mock.calls.map(([, messages]) => messages.length)).toEqual([2, 2, 1]);

    for (let index = 0; index < 5; index += 1) {
      await coordinator.capture({
        trackingKey: `cache-${index}`,
        sessionId: `cache-${index}`,
        messages: [message(`m-${index}`, index + 1)],
        scope,
      });
    }
    expect(coordinator.cacheEntryCount).toBe(2);
    expect(coordinator.lockEntryCount).toBe(0);
  });

  test("bounds same-key waiters and performs a bounded shutdown drain", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fakeProvider({
      captureMessages: vi.fn(async (_sessionId, messages) => {
        await gate;
        return { acceptedMessageIds: messages.map((item) => item.id) };
      }),
    });
    const coordinator = new CaptureCoordinator(provider, undefined, {
      concurrency: 1,
      queueSize: 2,
    });
    const first = coordinator.capture({ trackingKey: "same", sessionId: "same", messages: [message("a", 1)], scope });
    const second = coordinator.capture({ trackingKey: "same", sessionId: "same", messages: [message("b", 2)], scope });
    await expect(coordinator.capture({
      trackingKey: "same",
      sessionId: "same",
      messages: [message("c", 3)],
      scope,
    })).rejects.toThrow("queue is full");

    expect(await coordinator.drain(1)).toBe(false);
    await expect(coordinator.capture({
      trackingKey: "new",
      sessionId: "new",
      messages: [message("d", 1)],
      scope,
    })).rejects.toThrow("closing");
    release();
    await Promise.all([first, second]);
    expect(await coordinator.drain(10)).toBe(true);
    expect(coordinator.getMetrics().dropped).toBe(2);
    expect(coordinator.lockEntryCount).toBe(0);
  });

  test("does not count provider-reported ids from outside the attempted batch", async () => {
    const coordinator = new CaptureCoordinator(fakeProvider({
      captureMessages: vi.fn(async () => {
        throw new CaptureBatchError("partial", ["a", "not-in-batch", "a"]);
      }),
    }), undefined, { readAttempts: 1 });

    await expect(coordinator.capture({
      trackingKey: "partial",
      sessionId: "partial",
      messages: [message("a", 1), message("b", 2)],
      scope,
    })).rejects.toThrow("partial");
    expect(coordinator.getMetrics().captured).toBe(1);
  });

  test("truncates oversized UTF-8 events with an explicit marker instead of dropping the turn", async () => {
    const warnings: string[] = [];
    const captureMessages = vi.fn(async (_sessionId, messages: CapturedMessage[]) => ({
      acceptedMessageIds: messages.map((item) => item.id),
    }));
    const coordinator = new CaptureCoordinator(
      fakeProvider({ captureMessages }),
      { warn: (message) => warnings.push(message), error: () => {} },
      { eventBytes: 64 },
    );
    const original = "🙂".repeat(100);

    await coordinator.capture({
      trackingKey: "oversized",
      sessionId: "oversized",
      messages: [{ role: "user", content: original, id: "oversized", timestampMs: 1 }],
      scope,
    });

    const sent = captureMessages.mock.calls[0][1][0].content;
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(64);
    expect(sent).toMatch(/\n\[truncated\]$/);
    expect(sent).not.toContain("�");
    expect(coordinator.getMetrics()).toMatchObject({ captured: 1, dropped: 0 });
    expect(warnings.join("\n")).toContain("capture event truncated");
    expect(warnings.join("\n")).not.toContain(original);
    expect(truncateCapturedContent("short", 64)).toBe("short");
  });

  test("checks an erasure guard at the last point before the provider write", async () => {
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const captureMessages = vi.fn(async (_sessionId, messages: CapturedMessage[]) => ({
      acceptedMessageIds: messages.map((item) => item.id),
    }));
    const provider = fakeProvider({
      getCaptureCheckpoint: vi.fn(async () => {
        await checkpointGate;
        return { maxTimestampMs: 0, messageIdsAtMax: [] };
      }),
      captureMessages,
    });
    const coordinator = new CaptureCoordinator(provider);
    let allowed = true;
    const pending = coordinator.capture({
      trackingKey: "private",
      sessionId: "private",
      messages: [message("a", 1)],
      scope: { ...scope, key: "private" },
      canWrite: () => allowed,
    });
    allowed = false;
    releaseCheckpoint();
    await expect(pending).rejects.toThrow("blocked for scope erasure");
    expect(captureMessages).not.toHaveBeenCalled();
    expect(await coordinator.waitForScope("private", 10)).toBe(true);
  });
});
