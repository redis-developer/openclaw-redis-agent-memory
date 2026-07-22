import { afterEach, describe, expect, test, vi } from "vitest";

import { RamSdkAdapter } from "./adapter.js";
import { RamApiError, RamTimeoutError } from "./errors.js";
import { MAX_ERROR_RESPONSE_BYTES, MAX_EVENT_METADATA_BYTES } from "../validation.js";
import searchResponseFixture from "./fixtures/search-response.json";

type Fetcher = (request: Request) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAdapter(fetcher: Fetcher, timeoutMs = 30000): RamSdkAdapter {
  return new RamSdkAdapter({
    serverUrl: "https://ram.example.com/",
    apiKey: "test-api-key",
    storeId: "store-one",
    timeoutMs,
    fetcher,
  });
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  return text ? JSON.parse(text) : undefined;
}

const [memory] = searchResponseFixture.items;

describe("RamSdkAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("delegates URL, auth, search serialization, items, dates, and pagination to the SDK", async () => {
    let captured: Request | undefined;
    const adapter = makeAdapter(async (request) => {
      captured = request;
      return jsonResponse(200, searchResponseFixture);
    });

    const result = await adapter.searchLongTermMemory({
      text: "redis",
      similarityThreshold: 0.8,
      filter: { ownerId: { eq: "owner-1" } },
      limit: 2,
      pageToken: "page-1",
    });

    expect(captured?.url).toBe(
      "https://ram.example.com/v1/stores/store-one/long-term-memory/search",
    );
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-api-key");
    expect(await bodyOf(captured!)).toEqual({
      text: "redis",
      similarityThreshold: 0.8,
      filter: { ownerId: { eq: "owner-1" } },
      limit: 2,
      pageToken: "page-1",
    });
    expect(result.nextPageToken).toBe("next-1");
    expect(result.items[0]).toMatchObject({ id: "memory-1", text: "Redis is fast" });
    expect(result.items[0].createdAt).toEqual(new Date(memory.createdAt));
    expect(result.items[0].updatedAt).toEqual(new Date(memory.updatedAt));
  });

  test("uses the SDK bulk request objects without reshaping their wire bodies", async () => {
    const requests: Request[] = [];
    const responses = [
      jsonResponse(201, { created: ["memory-1"] }),
      jsonResponse(200, { deleted: ["memory-1"] }),
    ];
    const adapter = makeAdapter(async (request) => {
      requests.push(request);
      return responses.shift()!;
    });

    await adapter.bulkCreateLongTermMemories({
      memories: [{ id: "memory-1", text: "remember me", ownerId: "owner-1" }],
    });
    await adapter.bulkDeleteLongTermMemories({ memoryIds: ["memory-1"] });

    expect(await bodyOf(requests[0])).toEqual({
      memories: [{ id: "memory-1", text: "remember me", ownerId: "owner-1" }],
    });
    expect(requests[1].method).toBe("DELETE");
    expect(await bodyOf(requests[1])).toEqual({ memoryIds: ["memory-1"] });
  });

  test("fetches one validated long-term memory id for authorization", async () => {
    let captured: Request | undefined;
    const adapter = makeAdapter(async (request) => {
      captured = request;
      return jsonResponse(200, memory);
    });

    const result = await adapter.getLongTermMemory("memory-one");

    expect(captured?.url).toBe(
      "https://ram.example.com/v1/stores/store-one/long-term-memory/memory-one",
    );
    expect(captured?.method).toBe("GET");
    expect(result).toMatchObject({ id: memory.id, text: memory.text });
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  test("serializes event Date values as ISO and validates the SDK response", async () => {
    let captured: Request | undefined;
    const createdAt = new Date("2026-07-21T12:34:56.789Z");
    const adapter = makeAdapter(async (request) => {
      captured = request;
      return jsonResponse(201, {
        event: {
          eventId: "event-1",
          actorId: "owner-1",
          sessionId: "session-1",
          role: "USER",
          content: [{ text: "hello" }],
          createdAt: createdAt.toISOString(),
          systemTimestamp: "2026-07-21T12:34:57.000Z",
        },
      });
    });

    await adapter.addSessionEvent({
      sessionId: "session-1",
      actorId: "owner-1",
      role: "USER",
      content: [{ text: "hello" }],
      createdAt,
    });

    expect(await bodyOf(captured!)).toMatchObject({
      sessionId: "session-1",
      createdAt: createdAt.toISOString(),
    });
  });

  test("parses session event timestamps into Date instances", async () => {
    const adapter = makeAdapter(async () =>
      jsonResponse(200, {
        sessionId: "session-1",
        ownerId: "owner-1",
        events: [{
          eventId: "event-1",
          actorId: "owner-1",
          sessionId: "session-1",
          role: "USER",
          content: [{ text: "hello" }],
          createdAt: "2026-07-21T12:34:56.789Z",
          systemTimestamp: "2026-07-21T12:34:57.000Z",
        }],
      }));

    const result = await adapter.getSessionMemory("session-one");

    expect(result.events[0].createdAt).toEqual(new Date("2026-07-21T12:34:56.789Z"));
    expect(result.events[0].systemTimestamp).toBeInstanceOf(Date);
  });

  test("maps list pagination to SDK arguments and returns items", async () => {
    let captured: Request | undefined;
    const adapter = makeAdapter(async (request) => {
      captured = request;
      return jsonResponse(200, { items: ["session-1"], total: 1, nextPageToken: "next" });
    });

    const result = await adapter.listSessions({
      limit: 5,
      pageToken: "page",
      filterOwnerId: "owner-1",
    });

    expect(captured?.url).toContain("limit=5");
    expect(captured?.url).toContain("pageToken=page");
    expect(captured?.url).toContain("filterOwnerId=owner-1");
    expect(captured?.url).not.toContain("includeAll");
    expect(result).toEqual({ items: ["session-1"], total: 1, nextPageToken: "next" });
  });

  test("sets includeAll only for unfiltered session enumeration", async () => {
    let captured: Request | undefined;
    const adapter = makeAdapter(async (request) => {
      captured = request;
      return jsonResponse(200, { items: [], total: 0 });
    });

    await adapter.listSessions();

    expect(captured?.url).toContain("includeAll=true");
    expect(captured?.url).not.toContain("filterOwnerId");
  });

  test("rejects mutually exclusive session-list options before transport", async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, { items: [], total: 0 }));
    const adapter = makeAdapter(fetcher);

    await expect(adapter.listSessions({ filterOwnerId: "owner-1", includeAll: true }))
      .rejects.toThrow("includeAll must not be combined with filterOwnerId");
    await expect(adapter.listSessions({ includeAll: false }))
      .rejects.toThrow("includeAll must be true when no filterOwnerId is provided");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    [400, "/errors/invalid-data"],
    [401, "/errors/authentication-failed"],
    [403, "/errors/insufficient-permissions"],
    [404, "/errors/resource-not-found"],
    [408, "/errors/timeout"],
    [413, "/errors/payload-too-large"],
    [424, "/errors/resource-unavailable"],
    [429, "/errors/too-many-requests"],
    [500, "/errors/unexpected-error"],
  ])("normalizes typed SDK HTTP %d errors and preserves the typed cause", async (status, type) => {
    const fetcher = vi.fn(async () =>
      jsonResponse(status, {
        title: `status ${status}`,
        status,
        detail: `detail ${status}`,
        type,
      }));
    const adapter = makeAdapter(fetcher);

    let caught: unknown;
    try {
      await adapter.searchLongTermMemory({ text: "query" });
    } catch (error) {
      caught = error;
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(RamApiError);
    expect(caught).toMatchObject({ status, message: `detail ${status}` });
    expect((caught as RamApiError).cause).toMatchObject({ name: expect.any(String) });
  });

  test("does not retry retryable HTTP statuses", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(500, {
        title: "failure",
        status: 500,
        detail: "one attempt",
        type: "/errors/unexpected-error",
      }));
    const adapter = makeAdapter(fetcher);

    await expect(adapter.health()).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("maps malformed successful responses to a neutral error with validation cause", async () => {
    const adapter = makeAdapter(async () => jsonResponse(200, { memories: [memory] }));

    let caught: unknown;
    try {
      await adapter.searchLongTermMemory({ text: "query" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RamApiError);
    expect(caught).toMatchObject({ status: 200 });
    expect((caught as RamApiError).cause).toMatchObject({ name: "ResponseValidationError" });
  });

  test("maps malformed JSON in a successful response to a neutral error", async () => {
    const adapter = makeAdapter(async () => new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(adapter.health()).rejects.toMatchObject({
      status: 0,
      cause: { name: expect.any(String) },
    });
  });

  test("preserves the SDK fallback error for malformed documented error responses", async () => {
    const adapter = makeAdapter(async () => jsonResponse(400, { unexpected: true }));

    let caught: unknown;
    try {
      await adapter.health();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RamApiError);
    expect(caught).toMatchObject({ status: 400 });
    expect((caught as RamApiError).cause).toMatchObject({ name: expect.any(String) });
    expect((caught as RamApiError).body).toBeUndefined();
  });

  test("uses the configured timeout and preserves the SDK timeout cause", async () => {
    const adapter = makeAdapter(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
      100,
    );

    let caught: unknown;
    try {
      await adapter.health();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RamTimeoutError);
    expect(caught).toMatchObject({ status: 408 });
    expect((caught as RamApiError).cause).toMatchObject({ name: "RequestTimeoutError" });
  });

  test("normalizes client aborts without misclassifying them as timeouts", async () => {
    const adapter = makeAdapter(async () => {
      const error = new Error("cancelled");
      error.name = "AbortError";
      throw error;
    });

    let caught: unknown;
    try {
      await adapter.health();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RamApiError);
    expect(caught).not.toBeInstanceOf(RamTimeoutError);
    expect(caught).toMatchObject({ status: 0 });
    expect((caught as RamApiError).cause).toMatchObject({ name: "RequestAbortedError" });
  });

  test("keeps SDK debug output silent", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const group = vi.spyOn(console, "group").mockImplementation(() => {});
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => {});
    const adapter = makeAdapter(async () => jsonResponse(200, { status: "healthy" }));

    await adapter.health();

    expect(log).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
    expect(groupEnd).not.toHaveBeenCalled();
  });

  test.each([
    [{ serverUrl: "http://ram.example.com" }, /HTTPS/],
    [{ serverUrl: "https://ram.example.com/path" }, /path/],
    [{ serverUrl: "https://user:pass@ram.example.com" }, /credentials/],
    [{ storeId: "bad/store" }, /unsupported characters/],
    [{ apiKey: "   " }, /blank/],
    [{ timeoutMs: 99 }, /between 100 and 120000/],
    [{ timeoutMs: 100.5 }, /finite integer/],
  ])("rejects unsafe constructor option %#", (override, expected) => {
    expect(() => new RamSdkAdapter({
      serverUrl: "https://ram.example.com",
      apiKey: "test-api-key",
      storeId: "store-one",
      fetcher: async () => jsonResponse(200, { status: "healthy" }),
      ...override,
    })).toThrow(expected);
  });

  test.each([
    [{ text: "" }, /at least 1/],
    [{ text: "q", limit: Number.NaN }, /finite integer/],
    [{ text: "q", limit: 1.5 }, /finite integer/],
    [{ text: "q", limit: 0 }, /between 1 and 100/],
    [{ text: "q", limit: 101 }, /between 1 and 100/],
    [{ text: "q", similarityThreshold: -0.1 }, /between 0 and 1/],
    [{ text: "q", pageToken: "x".repeat(4_097) }, /at most 4096/],
    [{ text: "q", filter: { topics: { in: [] } } }, /between 1 and 50/],
    [{ text: "q", filter: { topics: { in: ["x".repeat(101)] } } }, /at most 100/],
  ])("rejects out-of-contract search request %#", async (request, expected) => {
    const fetcher = vi.fn(async () => jsonResponse(200, { items: [] }));
    const adapter = makeAdapter(fetcher);
    await expect(adapter.searchLongTermMemory(request as any)).rejects.toThrow(expected);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects invalid bulk, event, timestamp, and metadata inputs before transport", async () => {
    const fetcher = vi.fn(async () => jsonResponse(201, { created: [] }));
    const adapter = makeAdapter(fetcher);
    await expect(adapter.bulkCreateLongTermMemories({ memories: [] })).rejects.toThrow(/between 1 and 100/);
    await expect(adapter.bulkCreateLongTermMemories({
      memories: [{ id: "memory-one", text: "x".repeat(50_001) }],
    })).rejects.toThrow(/at most 50000/);
    await expect(adapter.bulkDeleteLongTermMemories({ memoryIds: ["bad/id"] })).rejects.toThrow(/unsupported/);
    await expect(adapter.addSessionEvent({
      sessionId: "session-one",
      actorId: "actor-one",
      role: "USER",
      content: [{ text: "hello" }],
      createdAt: new Date(Number.NaN),
    })).rejects.toThrow(/valid Date/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(adapter.addSessionEvent({
      sessionId: "session-one",
      actorId: "actor-one",
      role: "USER",
      content: [{ text: "hello" }],
      createdAt: new Date(),
      metadata: circular,
    })).rejects.toThrow(/JSON-serializable/);
    await expect(adapter.addSessionEvent({
      sessionId: "session-one",
      actorId: "actor-one",
      role: "USER",
      content: [{ text: "hello" }],
      createdAt: new Date(),
      metadata: { padding: "x".repeat(MAX_EVENT_METADATA_BYTES) },
    })).rejects.toThrow(/metadata is too large/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("rejects fuzzed unsafe memory identifiers before transport", async () => {
    const fetcher = vi.fn(async () => jsonResponse(200, memory));
    const adapter = makeAdapter(fetcher);

    for (let index = 0; index < 50; index += 1) {
      const invalidId = `memory/${index}-${"x".repeat(index)}`;
      await expect(adapter.getLongTermMemory(invalidId)).rejects.toThrow(/unsupported/);
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  test("forces manual redirects so authorization cannot be forwarded", async () => {
    let captured: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      captured = request;
      return new Response(JSON.stringify({ redirect: true }), {
        status: 302,
        headers: {
          "content-type": "application/json",
          location: "https://attacker.example/steal",
        },
      });
    });
    const adapter = makeAdapter(fetcher);

    await expect(adapter.health()).rejects.toMatchObject({ status: 302 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(captured?.redirect).toBe("manual");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-api-key");
  });

  test("rejects declared and streamed oversized response bodies", async () => {
    const declared = makeAdapter(async () => new Response("x", {
      status: 400,
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_ERROR_RESPONSE_BYTES + 1),
      },
    }));
    await expect(declared.health()).rejects.toMatchObject({
      status: 0,
      cause: { name: "RamResponseTooLargeError" },
    });

    const streamed = makeAdapter(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ERROR_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    await expect(streamed.health()).rejects.toMatchObject({
      status: 0,
      cause: { name: "RamResponseTooLargeError" },
    });
  });

  test("timeout remains active while a successful response body is stalled", async () => {
    const adapter = makeAdapter(async () => new Response(new ReadableStream({
      start() {},
    }), { status: 200, headers: { "content-type": "application/json" } }), 100);

    await expect(adapter.health()).rejects.toBeInstanceOf(RamTimeoutError);
  });

  test("redacts secrets from normalized message, body, cause, and string rendering", async () => {
    const adapter = makeAdapter(async () => jsonResponse(400, {
      title: "bad test-api-key",
      status: 400,
      detail: "Authorization=Bearer test-api-key\n[info] forged",
      type: "/errors/invalid-data",
      apiKey: "test-api-key",
    }));
    let caught: unknown;
    try {
      await adapter.health();
    } catch (error) {
      caught = error;
    }
    const rendered = JSON.stringify(caught) + String(caught) + String((caught as RamApiError).cause);
    expect(rendered).not.toContain("test-api-key");
    expect(rendered).toContain("[REDACTED]");
    expect(String(caught)).not.toContain("\n");
  });

  test("rejects structurally valid but semantically oversized successful records", async () => {
    const adapter = makeAdapter(async () => jsonResponse(200, {
      items: [{ ...memory, text: "x".repeat(50_001) }],
    }));
    await expect(adapter.searchLongTermMemory({ text: "query" })).rejects.toMatchObject({
      status: 0,
      cause: { name: "MemoryInputError" },
    });
  });

  test("bounds pagination tokens and bulk result collections returned by the service", async () => {
    const search = makeAdapter(async () => jsonResponse(200, {
      items: [],
      nextPageToken: "x".repeat(4_097),
    }));
    await expect(search.searchLongTermMemory({ text: "query" })).rejects.toMatchObject({ status: 0 });

    const bulkCreate = makeAdapter(async () => jsonResponse(201, {
      created: ["memory-one", "memory-two"],
    }));
    await expect(bulkCreate.bulkCreateLongTermMemories({
      memories: [{ id: "memory-one", text: "valid" }],
    })).rejects.toMatchObject({ status: 0 });

    const list = makeAdapter(async () => jsonResponse(200, {
      items: [],
      total: 0,
      nextPageToken: "x".repeat(4_097),
    }));
    await expect(list.listSessions()).rejects.toMatchObject({ status: 0 });
  });
});
