/**
 * Wire types for the Redis Agent Memory (RAM) cloud REST API.
 *
 * These are intentionally camelCase exactly as they appear on the wire.
 *
 * Notable wire quirks preserved here on purpose:
 * - Timestamps (`createdAt` / `updatedAt`, including the `createdAt` search
 *   filter) are `int64` Unix **milliseconds** — numbers, not ISO strings.
 * - `MessageRole` is UPPERCASE ("USER" | "ASSISTANT" | "SYSTEM").
 * - `filterOp` is lowercase ("all" | "any"), not "AND"/"OR".
 * - The tag filter "in" key is literally `in` (the `in_` spelling in the
 *   Python SDK is a language keyword workaround that does not apply here).
 */

// ============================================================================
// Long-term memory
// ============================================================================

export type RamMemoryType = "semantic" | "episodic" | "message";

/**
 * Payload for creating a long-term memory record.
 *
 * `id` is REQUIRED and caller-generated (e.g. via `randomUUID()`), matching
 * pattern `^[a-zA-Z0-9-]+$`, 1-64 chars.
 */
export type RamCreateMemoryRecord = {
  id: string;
  text: string;
  memoryType?: RamMemoryType;
  sessionId?: string;
  ownerId?: string;
  namespace?: string;
  topics?: string[];
};

/**
 * A long-term memory record as returned by search/get responses.
 *
 * No score/dist field exists on the wire — do not invent one.
 */
export type RamMemoryRecord = {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  memoryType?: RamMemoryType;
  sessionId?: string;
  ownerId?: string;
  namespace?: string;
  topics?: string[];
};

export type RamBulkCreateResponse = {
  created: string[];
  errors?: unknown[];
};

export type RamBulkDeleteResponse = {
  deleted: string[];
  errors?: unknown[];
};

// ============================================================================
// Filters
// ============================================================================

/**
 * Tag filter shape. Wire key for "in" is literally `in` — the `in_` spelling
 * seen in the Python SDK is only a keyword workaround in that language.
 */
export type RamTagFilter = {
  eq?: string;
  ne?: string;
  in?: string[];
  all?: string[];
};

/**
 * Numeric filter, used for the `createdAt` filter on search requests.
 * Value is an int64 Unix millisecond timestamp.
 */
export type RamNumericFilter = {
  eq?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
};

export type RamLongTermMemoryFilter = {
  sessionId?: RamTagFilter;
  ownerId?: RamTagFilter;
  namespace?: RamTagFilter;
  topics?: RamTagFilter;
  memoryType?: RamTagFilter;
  createdAt?: RamNumericFilter;
};

/** Filter conjunction: "all" = AND (default), "any" = OR. Lowercase on the wire. */
export type RamFilterOp = "all" | "any";

// ============================================================================
// Search
// ============================================================================

export type RamSearchRequest = {
  text?: string;
  /** Similarity (0-1, higher = more similar) — NOT distance. */
  similarityThreshold?: number;
  filter?: RamLongTermMemoryFilter;
  filterOp?: RamFilterOp;
  limit?: number;
  pageToken?: string;
};

export type RamSearchResponse = {
  memories: RamMemoryRecord[];
  nextPageToken?: string;
};

// ============================================================================
// Session memory
// ============================================================================

/** Uppercase on the wire. The provider (not this client) uppercases plugin roles. */
export type RamMessageRole = "USER" | "ASSISTANT" | "SYSTEM";

export type RamContentBlock = {
  text: string;
};

export type RamSessionEvent = {
  eventId: string;
  actorId: string;
  sessionId: string;
  role: RamMessageRole;
  content: RamContentBlock[];
  createdAt: number;
  metadata?: Record<string, unknown>;
};

/** Body for POST .../session-memory/events — same as RamSessionEvent minus eventId, sessionId optional. */
export type RamAddSessionEvent = {
  actorId: string;
  role: RamMessageRole;
  content: RamContentBlock[];
  createdAt: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

export type RamSessionMemory = {
  sessionId: string;
  ownerId: string;
  events: RamSessionEvent[];
  summary?: unknown;
};

export type RamListSessionsResponse = {
  sessions: string[];
  total: number;
  nextPageToken?: string;
};

// ============================================================================
// Errors
// ============================================================================

/** RFC 9457 Problem Details body shape returned on non-2xx responses. */
export type RamProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  fields?: Array<{ field?: string; rule?: string; message?: string }>;
};

/**
 * Error thrown by RamClient for any non-2xx HTTP response, as well as
 * network/abort failures (which are wrapped rather than left as bare fetch
 * errors). Carries the numeric HTTP status and the parsed (or raw) body.
 */
export class RamApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "RamApiError";
    this.status = status;
    this.body = body;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Thrown when a request is aborted due to exceeding `timeoutMs`. Subclasses
 * RamApiError (status 408) so callers that only check `instanceof RamApiError`
 * still work, while callers that care about timeouts specifically can check
 * `instanceof RamTimeoutError`.
 */
export class RamTimeoutError extends RamApiError {
  constructor(message = "RAM request timed out") {
    super(message, 408);
    this.name = "RamTimeoutError";
  }
}
