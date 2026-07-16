/**
 * Dependency-free REST client for the Redis Agent Memory (RAM) cloud API.
 *
 * There is no npm SDK for RAM (verified 2026-07-15), so this client is
 * hand-written against the Redis Agent Memory REST API wire contract. It uses
 * only the global `fetch` / `AbortController` available in Node >=18 — no new
 * runtime dependencies.
 *
 * Design notes:
 * - No retries. Callers (providers) already degrade gracefully.
 * - `undefined` fields are stripped from request bodies before
 *   `JSON.stringify` so they're sent absent rather than `null`.
 * - Every non-2xx response, and every network/abort failure, is normalized
 *   into a `RamApiError` (or its `RamTimeoutError` subclass) — callers never
 *   see a bare `fetch` rejection for HTTP-level failures.
 */

import {
  RamApiError,
  RamTimeoutError,
  type RamAddSessionEvent,
  type RamBulkCreateResponse,
  type RamBulkDeleteResponse,
  type RamCreateMemoryRecord,
  type RamListSessionsResponse,
  type RamProblemDetails,
  type RamSearchRequest,
  type RamSearchResponse,
  type RamSessionMemory,
} from "./types.js";

export type RamClientOptions = {
  /** Base URL, e.g. `https://<host>`. Trailing slash is stripped. */
  serverUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` on every request. */
  apiKey: string;
  /** Interpolated (URL-encoded) into `/v1/stores/{storeId}/...`. */
  storeId: string;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
};

export const DEFAULT_RAM_TIMEOUT_MS = 30000;

type RequestOptions = {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  body?: unknown;
};

/**
 * Recursively removes keys whose value is `undefined` from plain objects
 * (including nested objects, e.g. the `filter` on a search request), so
 * they are omitted from the JSON payload entirely rather than serialized
 * as `null`. Arrays are walked but not otherwise altered.
 */
function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => pruneUndefined(entry)) as unknown as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = pruneUndefined(entry);
    }
    return result as T;
  }
  return value;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Builds a RamApiError message preferring RFC 9457 `detail`, then `title`, then raw text. */
function buildErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const problem = body as RamProblemDetails;
    if (typeof problem.detail === "string" && problem.detail.trim().length > 0) {
      return problem.detail;
    }
    if (typeof problem.title === "string" && problem.title.trim().length > 0) {
      return problem.title;
    }
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return body;
  }
  return `RAM request failed with status ${status}`;
}

export class RamClient {
  private readonly baseUrl: string;
  private readonly storeUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: RamClientOptions) {
    this.baseUrl = opts.serverUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RAM_TIMEOUT_MS;
    this.storeUrl = `${this.baseUrl}/v1/stores/${encodeURIComponent(opts.storeId)}`;
  }

  /** GET /health — at the server root, NOT under /v1/stores/{storeId}. */
  health(): Promise<{ status: string }> {
    return this.request<{ status: string }>(`${this.baseUrl}/health`, { method: "GET" });
  }

  /** POST .../long-term-memory — bulk create; caller must generate each record's `id`. */
  bulkCreateLongTermMemories(
    memories: RamCreateMemoryRecord[],
  ): Promise<RamBulkCreateResponse> {
    return this.request<RamBulkCreateResponse>(`${this.storeUrl}/long-term-memory`, {
      method: "POST",
      body: { memories },
    });
  }

  /** DELETE .../long-term-memory with a JSON body `{ memoryIds }` (unusual but per contract). */
  bulkDeleteLongTermMemories(memoryIds: string[]): Promise<RamBulkDeleteResponse> {
    return this.request<RamBulkDeleteResponse>(`${this.storeUrl}/long-term-memory`, {
      method: "DELETE",
      body: { memoryIds },
    });
  }

  /** POST .../long-term-memory/search — response field is `memories`, not `items`. */
  searchLongTermMemory(req: RamSearchRequest): Promise<RamSearchResponse> {
    return this.request<RamSearchResponse>(`${this.storeUrl}/long-term-memory/search`, {
      method: "POST",
      body: req,
    });
  }

  /** POST .../session-memory/events — the `{event}` response body is ignored. */
  async addSessionEvent(event: RamAddSessionEvent): Promise<void> {
    await this.request<unknown>(`${this.storeUrl}/session-memory/events`, {
      method: "POST",
      body: event,
    });
  }

  /** GET .../session-memory/{sessionId}. On 404 throws RamApiError (isNotFound); does not swallow. */
  getSessionMemory(sessionId: string): Promise<RamSessionMemory> {
    return this.request<RamSessionMemory>(
      `${this.storeUrl}/session-memory/${encodeURIComponent(sessionId)}`,
      { method: "GET" },
    );
  }

  /** DELETE .../session-memory/{sessionId} — 204 No Content on success. */
  async deleteSessionMemory(sessionId: string): Promise<void> {
    await this.request<unknown>(
      `${this.storeUrl}/session-memory/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
  }

  /** GET .../session-memory?includeAll=true — required query param, else the server 400s. */
  listSessions(): Promise<RamListSessionsResponse> {
    return this.request<RamListSessionsResponse>(
      `${this.storeUrl}/session-memory?includeAll=true`,
      { method: "GET" },
    );
  }

  private async request<T>(url: string, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(pruneUndefined(options.body));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new RamTimeoutError(`RAM request to ${url} timed out after ${this.timeoutMs}ms`);
      }
      const message = err instanceof Error ? err.message : "RAM request failed";
      throw new RamApiError(message, 0, undefined);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await parseBody(response);
      throw new RamApiError(buildErrorMessage(response.status, body), response.status, body);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }
}
