import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { RamClient } from "./client.js";
import { RamApiError, RamTimeoutError } from "./types.js";
import type { RamSearchRequest } from "./types.js";

type FetchCall = { url: string; init: RequestInit & { headers?: Record<string, string> } };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

describe("RamClient", () => {
  let calls: FetchCall[];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function queueResponse(response: Response) {
    fetchMock.mockImplementationOnce(async (url: string, init: RequestInit) => {
      calls.push({ url, init: init as FetchCall["init"] });
      return response;
    });
  }

  function bodyOf(call: FetchCall): unknown {
    const raw = call.init.body;
    if (typeof raw !== "string") return undefined;
    return JSON.parse(raw);
  }

  // --------------------------------------------------------------------
  // URL construction
  // --------------------------------------------------------------------

  test("normalizes serverUrl with a trailing slash", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com/",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(201, { created: ["a"] }));

    await client.bulkCreateLongTermMemories([{ id: "a", text: "hi" }]);

    expect(calls[0].url).toBe("https://ram.example.com/v1/stores/store1/long-term-memory");
  });

  test("produces the same URL whether serverUrl has a trailing slash or not", async () => {
    const withSlash = new RamClient({
      serverUrl: "https://ram.example.com/",
      apiKey: "key",
      storeId: "store1",
    });
    const withoutSlash = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });

    queueResponse(jsonResponse(201, { created: ["a"] }));
    await withSlash.bulkCreateLongTermMemories([{ id: "a", text: "hi" }]);
    queueResponse(jsonResponse(201, { created: ["a"] }));
    await withoutSlash.bulkCreateLongTermMemories([{ id: "a", text: "hi" }]);

    expect(calls[0].url).toBe(calls[1].url);
  });

  test("URL-encodes a storeId that needs encoding", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "my store/id",
    });
    queueResponse(jsonResponse(200, { memories: [] }));

    await client.searchLongTermMemory({ text: "hello" });

    expect(calls[0].url).toBe(
      `https://ram.example.com/v1/stores/${encodeURIComponent("my store/id")}/long-term-memory/search`,
    );
    expect(calls[0].url).not.toContain("my store/id");
  });

  test("URL-encodes a sessionId path segment", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { sessionId: "s/1", ownerId: "o", events: [] }));

    await client.getSessionMemory("session/with slash");

    expect(calls[0].url).toBe(
      `https://ram.example.com/v1/stores/store1/session-memory/${encodeURIComponent("session/with slash")}`,
    );
  });

  test("health() hits /health at the server root, not under /v1/stores", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { status: "ok" }));

    const result = await client.health();

    expect(calls[0].url).toBe("https://ram.example.com/health");
    expect(calls[0].url).not.toContain("/v1/stores");
    expect(result).toEqual({ status: "ok" });
  });

  // --------------------------------------------------------------------
  // Auth header
  // --------------------------------------------------------------------

  test("sends the Authorization bearer header on every call", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "super-secret",
      storeId: "store1",
    });

    queueResponse(jsonResponse(200, { status: "ok" }));
    await client.health();

    queueResponse(jsonResponse(200, { memories: [] }));
    await client.searchLongTermMemory({ text: "x" });

    queueResponse(jsonResponse(201, { created: [] }));
    await client.bulkCreateLongTermMemories([{ id: "a", text: "hi" }]);

    queueResponse(jsonResponse(200, { deleted: [] }));
    await client.bulkDeleteLongTermMemories(["a"]);

    queueResponse(noContentResponse());
    await client.addSessionEvent({ actorId: "u1", role: "USER", content: [{ text: "hi" }], createdAt: 1 });

    queueResponse(jsonResponse(200, { sessionId: "s1", ownerId: "o1", events: [] }));
    await client.getSessionMemory("s1");

    queueResponse(noContentResponse());
    await client.deleteSessionMemory("s1");

    queueResponse(jsonResponse(200, { sessions: [], total: 0 }));
    await client.listSessions();

    expect(calls).toHaveLength(8);
    for (const call of calls) {
      expect(call.init.headers?.Authorization).toBe("Bearer super-secret");
    }
  });

  // --------------------------------------------------------------------
  // Search
  // --------------------------------------------------------------------

  test("search: strips undefined fields (including nested filter) before serializing", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { memories: [] }));

    const req: RamSearchRequest = {
      text: "hello",
      similarityThreshold: undefined,
      filter: {
        ownerId: undefined,
        topics: { in: ["a", "b"], eq: undefined },
      },
      filterOp: undefined,
      limit: 5,
      pageToken: undefined,
    };
    await client.searchLongTermMemory(req);

    const body = bodyOf(calls[0]) as Record<string, unknown>;
    expect(body).toEqual({
      text: "hello",
      limit: 5,
      filter: {
        topics: { in: ["a", "b"] },
      },
    });
    expect(Object.keys(body)).not.toContain("similarityThreshold");
    expect(Object.keys(body)).not.toContain("filterOp");
    expect(Object.keys(body)).not.toContain("pageToken");
  });

  test("search: the `in` filter key is spelled exactly `in`", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { memories: [] }));

    await client.searchLongTermMemory({
      filter: { topics: { in: ["red", "blue"] } },
    });

    const body = bodyOf(calls[0]) as { filter: { topics: Record<string, unknown> } };
    expect(body.filter.topics).toHaveProperty("in");
    expect(body.filter.topics.in).toEqual(["red", "blue"]);
    expect(body.filter.topics).not.toHaveProperty("in_");
  });

  test("search: parses the response including memories and nextPageToken", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    const record = {
      id: "m1",
      text: "hello",
      createdAt: 1720000000000,
      updatedAt: 1720000000000,
    };
    queueResponse(jsonResponse(200, { memories: [record], nextPageToken: "tok-123" }));

    const result = await client.searchLongTermMemory({ text: "hello" });

    expect(result.memories).toEqual([record]);
    expect(result.nextPageToken).toBe("tok-123");
  });

  test("search: POSTs to the search endpoint", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { memories: [] }));

    await client.searchLongTermMemory({ text: "hello" });

    expect(calls[0].url).toBe("https://ram.example.com/v1/stores/store1/long-term-memory/search");
    expect(calls[0].init.method).toBe("POST");
  });

  // --------------------------------------------------------------------
  // Bulk delete (regression: DELETE with a JSON body)
  // --------------------------------------------------------------------

  test("bulkDeleteLongTermMemories sends method DELETE with a JSON body of memoryIds", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { deleted: ["a", "b"] }));

    const result = await client.bulkDeleteLongTermMemories(["a", "b"]);

    expect(calls[0].init.method).toBe("DELETE");
    expect(bodyOf(calls[0])).toEqual({ memoryIds: ["a", "b"] });
    expect(calls[0].init.headers?.["Content-Type"]).toBe("application/json");
    expect(result).toEqual({ deleted: ["a", "b"] });
  });

  // --------------------------------------------------------------------
  // Error mapping
  // --------------------------------------------------------------------

  test.each([401, 404, 429])("maps HTTP %d to a RamApiError with the right status", async (status) => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(
      jsonResponse(status, {
        type: `/errors/x`,
        title: "Something went wrong",
        status,
        detail: `detail for ${status}`,
      }),
    );

    await expect(client.searchLongTermMemory({ text: "x" })).rejects.toMatchObject({
      status,
      message: `detail for ${status}`,
    });
  });

  test("RamApiError.isNotFound is true only for 404", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(404, { title: "not found", status: 404 }));

    let caught: unknown;
    try {
      await client.getSessionMemory("missing");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RamApiError);
    const error = caught as RamApiError;
    expect(error.isNotFound).toBe(true);
    expect(error.isAuth).toBe(false);
  });

  test("RamApiError.isAuth is true for 401 and 403", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });

    queueResponse(jsonResponse(401, { title: "auth failed", status: 401 }));
    let caught401: unknown;
    try {
      await client.searchLongTermMemory({ text: "x" });
    } catch (err) {
      caught401 = err;
    }
    expect((caught401 as RamApiError).isAuth).toBe(true);
    expect((caught401 as RamApiError).isNotFound).toBe(false);

    queueResponse(jsonResponse(403, { title: "forbidden", status: 403 }));
    let caught403: unknown;
    try {
      await client.searchLongTermMemory({ text: "x" });
    } catch (err) {
      caught403 = err;
    }
    expect((caught403 as RamApiError).isAuth).toBe(true);
  });

  test("falls back to raw text when the error body is not JSON", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(textResponse(500, "internal server error"));

    await expect(client.searchLongTermMemory({ text: "x" })).rejects.toMatchObject({
      status: 500,
      message: "internal server error",
      body: "internal server error",
    });
  });

  test("getSessionMemory throws RamApiError on 404 rather than swallowing it", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(404, { title: "no such session", status: 404 }));

    await expect(client.getSessionMemory("nope")).rejects.toBeInstanceOf(RamApiError);
  });

  // --------------------------------------------------------------------
  // Timeout
  // --------------------------------------------------------------------

  test("aborts and surfaces a detectable timeout error when the request exceeds timeoutMs", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
      timeoutMs: 10,
    });

    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    let caught: unknown;
    try {
      await client.searchLongTermMemory({ text: "slow" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RamTimeoutError);
    expect(caught).toBeInstanceOf(RamApiError);
    expect((caught as RamApiError).status).toBe(408);
  });

  test("wraps a non-timeout network failure into a RamApiError distinct from RamTimeoutError", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });

    fetchMock.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    let caught: unknown;
    try {
      await client.searchLongTermMemory({ text: "x" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RamApiError);
    expect(caught).not.toBeInstanceOf(RamTimeoutError);
  });

  // --------------------------------------------------------------------
  // Session events / timestamps
  // --------------------------------------------------------------------

  test("addSessionEvent: createdAt passes through as a number, not an ISO string", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(noContentResponse());

    const createdAt = 1720000000000;
    await client.addSessionEvent({
      actorId: "user-1",
      role: "USER",
      content: [{ text: "hello" }],
      createdAt,
      sessionId: "s1",
    });

    const body = bodyOf(calls[0]) as { createdAt: unknown };
    expect(typeof body.createdAt).toBe("number");
    expect(body.createdAt).toBe(createdAt);
  });

  test("addSessionEvent POSTs to the events endpoint and resolves void", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(201, { event: { eventId: "e1" } }));

    const result = await client.addSessionEvent({
      actorId: "user-1",
      role: "ASSISTANT",
      content: [{ text: "hi" }],
      createdAt: Date.now(),
    });

    expect(calls[0].url).toBe("https://ram.example.com/v1/stores/store1/session-memory/events");
    expect(calls[0].init.method).toBe("POST");
    expect(result).toBeUndefined();
  });

  // --------------------------------------------------------------------
  // Sessions
  // --------------------------------------------------------------------

  test("listSessions requests includeAll=true and parses sessions/total/nextPageToken", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { sessions: ["s1", "s2"], total: 2, nextPageToken: "tok" }));

    const result = await client.listSessions();

    expect(calls[0].url).toBe("https://ram.example.com/v1/stores/store1/session-memory?includeAll=true");
    expect(calls[0].init.method).toBe("GET");
    expect(result).toEqual({ sessions: ["s1", "s2"], total: 2, nextPageToken: "tok" });
  });

  test("deleteSessionMemory issues a DELETE and resolves void on 204", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(noContentResponse());

    const result = await client.deleteSessionMemory("s1");

    expect(calls[0].init.method).toBe("DELETE");
    expect(result).toBeUndefined();
  });

  // --------------------------------------------------------------------
  // Content-Type
  // --------------------------------------------------------------------

  test("does not send Content-Type on bodyless GET requests", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { status: "ok" }));

    await client.health();

    expect(calls[0].init.headers?.["Content-Type"]).toBeUndefined();
  });

  test("sends Content-Type: application/json on requests with a body", async () => {
    const client = new RamClient({
      serverUrl: "https://ram.example.com",
      apiKey: "key",
      storeId: "store1",
    });
    queueResponse(jsonResponse(200, { memories: [] }));

    await client.searchLongTermMemory({ text: "x" });

    expect(calls[0].init.headers?.["Content-Type"]).toBe("application/json");
  });
});
