/**
 * Backend-neutral memory provider interface.
 *
 * The plugin core (`index.ts`) depends only on this interface; all differences
 * between backends (self-hosted AMS, cloud RAM) live inside the provider
 * implementations under `src/providers/`.
 */

import type { MemoryStrategy } from "./config.js";
import type { ScopedMemoryTarget } from "./scopes.js";

export type ProviderCapabilities = {
  summaryViews: boolean;
  extractionStrategy: boolean;
  similarityScores: boolean;
};

export type ProviderSearchResult = {
  id: string;
  text: string;
  score?: number; // undefined when !capabilities.similarityScores
  topics?: string[];
  entities?: string[];
  memoryType?: string;
  /** Bounded provenance category; never contains session ids or memory text. */
  source?: "direct" | "session" | "unknown";
};

export type CapturedMessage = {
  role: "user" | "assistant";
  content: string;
  id: string;
  timestampMs: number;
};

/** Compact durable capture position reconstructed from backend session data. */
export type CaptureCheckpoint = {
  maxTimestampMs: number;
  messageIdsAtMax: string[];
};

export type CaptureBatchResult = {
  acceptedMessageIds: string[];
};

/**
 * A capture batch stopped after accepting a known prefix. The failed request
 * may have reached the backend, so callers must reconcile before retrying it.
 */
export class CaptureBatchError extends Error {
  readonly acceptedMessageIds: string[];
  override readonly cause?: unknown;

  constructor(message: string, acceptedMessageIds: string[], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CaptureBatchError";
    this.acceptedMessageIds = acceptedMessageIds;
    this.cause = cause;
  }
}

export type SummaryPartition = {
  summary: string;
  memoryCount: number;
  computedAt?: string;
};

/** Complete plugin-side identity used to authorize destructive operations. */
export type MemoryScopeIdentity = {
  key: string;
  namespace?: string;
  userId?: string;
};

/**
 * Per-id deletion outcome. Providers must account for every requested id and
 * must not turn a partial backend response into success.
 */
export type DeleteLongTermResult = {
  deletedIds: string[];
  notFoundIds: string[];
  forbiddenIds: string[];
  failedIds: string[];
};

export type ScopeErasureStatus = "verified_best_effort" | "partial" | "failed";

/**
 * Auditable scope-erasure outcome. It intentionally contains identifiers and
 * counts only: memory/session content and credentials must never be copied to
 * tool results or logs.
 */
export type ScopeErasureResult = {
  scopeKey: string;
  status: ScopeErasureStatus;
  passes: number;
  /** Identifiers confirmed deleted by the backend during either sweep. */
  memoryIds: string[];
  sessionIds: string[];
  failedMemoryIds: string[];
  failedSessionIds: string[];
  remainingMemoryIds: string[];
  remainingSessionIds: string[];
  residuals: string[];
};

export type ScopeErasureOptions = {
  settleMs: number;
  maxRecords: number;
};

export interface SummaryViewOperations {
  ensureView(scope: ScopedMemoryTarget): Promise<string | null>;
  getSummaryPartition(scope: ScopedMemoryTarget): Promise<SummaryPartition | null>;
  refreshView(scope: ScopedMemoryTarget): Promise<void>;
}

export interface MemoryProvider {
  readonly capabilities: ProviderCapabilities;
  /**
   * Convert an OpenClaw session identity into the backend's working-memory
   * identifier. Providers that impose identifier or tenancy constraints own
   * that translation; the plugin core must not construct backend-specific ids.
   */
  deriveCaptureSessionId(
    sessionIdentity: string,
    scope: ScopedMemoryTarget,
  ): string;
  healthCheck(): Promise<void>;
  searchLongTerm(params: {
    text: string;
    limit: number;
    key?: string;
    namespace?: string;
    userId?: string;
    minScore?: number;
  }): Promise<ProviderSearchResult[]>;
  createLongTerm(params: {
    text: string;
    topics?: string[];
    key?: string;
    namespace?: string;
    userId?: string;
  }): Promise<{ id: string }>;
  deleteLongTerm(
    ids: string[],
    scope: MemoryScopeIdentity,
  ): Promise<DeleteLongTermResult>;
  eraseScope(
    scope: MemoryScopeIdentity,
    options: ScopeErasureOptions,
  ): Promise<ScopeErasureResult>;
  findDuplicate(params: {
    text: string;
    key?: string;
    namespace?: string;
    userId?: string;
  }): Promise<{ id: string; text: string } | null>;
  getCaptureCheckpoint(
    sessionId: string,
    scope: { key?: string; namespace?: string; userId?: string },
  ): Promise<CaptureCheckpoint>;
  captureMessages(
    sessionId: string,
    messages: CapturedMessage[],
    scope: {
      key?: string;
      namespace?: string;
      userId?: string;
      extractionStrategy?: MemoryStrategy;
      customPrompt?: string;
      sessionRetentionSeconds?: number;
    },
  ): Promise<CaptureBatchResult>;
  summaries?: SummaryViewOperations; // present only when capabilities.summaryViews
}
