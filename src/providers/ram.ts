/**
 * RAM (Redis Agent Memory cloud REST API) provider.
 *
 * Wraps the official Redis Agent Memory SDK adapter and holds every direct
 * call to it. All translation logic (filter shaping, dedup
 * threshold, capture checkpointing) lives here so the plugin core can stay
 * backend-agnostic. Unlike the AMS provider, RAM performs extraction and
 * summarization server-side, so this provider has no `summaries` member and
 * ignores `extractionStrategy` / `customPrompt` on capture.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  AddSessionEventRequestContent,
  LongTermMemoryFilter,
  MessageRole,
} from "@redis-iris/agent-memory/models";

import type { MemoryConfig } from "../config.js";
import type { PluginLogger } from "../types.js";
import type {
  CapturedMessage,
  DeleteLongTermResult,
  MemoryProvider,
  MemoryScopeIdentity,
  ScopeErasureResult,
} from "../provider.js";
import { CaptureBatchError } from "../provider.js";
import { RamSdkAdapter } from "../ram/adapter.js";
import { RamApiError } from "../ram/errors.js";
import {
  CONFIG_KEY_PATTERN,
  MAX_IDENTIFIER_CHARS,
  MAX_RECALL_LIMIT,
  assertBoundedString,
  assertIntegerInRange,
  assertMemoryText,
  assertNumberInRange,
  assertSearchText,
  assertServiceIdentifier,
  assertTopics,
} from "../validation.js";

const RAM_ID_DIGEST_LENGTH = 58;
export const RAM_ERASURE_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      () => worker(),
    ),
  );
  return results;
}

function digestParts(parts: Array<string | null>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex")
    .slice(0, RAM_ID_DIGEST_LENGTH);
}

/**
 * RAM extraction preserves the session owner but currently omits namespace
 * from the long-term record. Encode the complete plugin scope into the owner
 * so manual and extracted memories remain searchable through one secure filter.
 */
export function deriveRamOwnerId(
  namespace: string | undefined,
  userId: string | undefined,
  scopeKey = "default",
): string {
  return `oc-o-${digestParts(["ram-owner-v1", scopeKey, namespace ?? null, userId ?? null])}`;
}

/**
 * Return a stable RAM-safe id without exposing OpenClaw session, scope,
 * namespace, or user identifiers. The result is 63 lowercase ASCII
 * alphanumeric/dash characters, below RAM's 64-character limit.
 */
export function deriveRamSessionId(
  sessionIdentity: string,
  scope: { key: string; namespace?: string; userId?: string },
): string {
  const ownerId = deriveRamOwnerId(scope.namespace, scope.userId, scope.key);
  return `oc-s-${digestParts(["ram-session-v1", sessionIdentity, scope.key, ownerId])}`;
}

/** Owner is the effective RAM tenancy boundary for every recall path. */
function buildFilter(
  scopeKey: string | undefined,
  namespace: string | undefined,
  userId: string | undefined,
): LongTermMemoryFilter {
  return {
    ownerId: { eq: deriveRamOwnerId(namespace, userId, scopeKey) },
  };
}

function emptyDeleteResult(): DeleteLongTermResult {
  return {
    deletedIds: [],
    notFoundIds: [],
    forbiddenIds: [],
    failedIds: [],
  };
}

function sameOptionalString(actual: string | undefined, expected: string | undefined): boolean {
  return actual === expected;
}

function assertRamScope(scope: { key?: string; namespace?: string; userId?: string }): void {
  if (scope.key !== undefined) {
    assertBoundedString(scope.key, "scope key", {
      min: 1,
      max: MAX_IDENTIFIER_CHARS,
      pattern: CONFIG_KEY_PATTERN,
    });
  }
  if (scope.namespace !== undefined) assertServiceIdentifier(scope.namespace, "namespace");
  if (scope.userId !== undefined) assertServiceIdentifier(scope.userId, "userId");
}

/**
 * RAM extraction may omit namespace, so the derived owner is the mandatory
 * authorization boundary. When namespace is present it must agree too.
 */
function isAuthorizedRamMemory(
  memory: { ownerId?: string; namespace?: string },
  scope: MemoryScopeIdentity,
): boolean {
  const expectedOwner = deriveRamOwnerId(scope.namespace, scope.userId, scope.key);
  if (!memory.ownerId || memory.ownerId !== expectedOwner) return false;
  return memory.namespace === undefined || sameOptionalString(memory.namespace, scope.namespace);
}

export function createRamProvider(
  cfg: MemoryConfig,
  logger?: PluginLogger,
): MemoryProvider {
  const client = new RamSdkAdapter({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey!,
    storeId: cfg.storeId!,
    timeoutMs: cfg.timeout,
  });

  async function enumerateMemoryIds(
    scope: MemoryScopeIdentity,
    maxRecords: number,
  ): Promise<string[]> {
    const ids = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await client.searchLongTermMemory({
        limit: MAX_RECALL_LIMIT,
        pageToken,
        filter: buildFilter(scope.key, scope.namespace, scope.userId),
      });
      for (const memory of page.items) {
        if (!isAuthorizedRamMemory(memory, scope)) {
          throw new Error("RAM scope enumeration returned a record outside the owner boundary");
        }
        ids.add(memory.id);
        if (ids.size > maxRecords) throw new Error("RAM scope erasure record limit exceeded");
      }
      pageToken = page.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) {
        throw new Error("RAM scope erasure pagination token repeated");
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return [...ids].sort();
  }

  async function enumerateSessionIds(
    scope: MemoryScopeIdentity,
    maxRecords: number,
  ): Promise<string[]> {
    const expectedOwner = deriveRamOwnerId(scope.namespace, scope.userId, scope.key);
    const ids = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await client.listSessions({
        limit: MAX_RECALL_LIMIT,
        pageToken,
        filterOwnerId: expectedOwner,
      });
      const sessions = await mapWithConcurrency(
        page.items,
        RAM_ERASURE_CONCURRENCY,
        async (id) => {
          try {
            return await client.getSessionMemory(id);
          } catch (error) {
            if (error instanceof RamApiError && error.isNotFound) return undefined;
            throw error;
          }
        },
      );
      for (const [index, session] of sessions.entries()) {
        if (!session) continue;
        if (session.ownerId !== expectedOwner) {
          throw new Error("RAM scope enumeration returned a session outside the owner boundary");
        }
        ids.add(page.items[index]);
        if (ids.size > maxRecords) throw new Error("RAM scope erasure session limit exceeded");
      }
      pageToken = page.nextPageToken;
      if (pageToken && seenTokens.has(pageToken)) {
        throw new Error("RAM scope erasure pagination token repeated");
      }
      if (pageToken) seenTokens.add(pageToken);
    } while (pageToken);
    return [...ids].sort();
  }

  const erasureResiduals = [
    "queued_extraction_not_barriered",
    "upstream_backups_not_verifiable",
    "external_writers_not_quiesced",
    "process_restart_can_end_capture_quiesce",
  ];

  return {
    capabilities: {
      summaryViews: false,
      extractionStrategy: false,
      similarityScores: false,
    },

    deriveCaptureSessionId(sessionIdentity, scope) {
      assertBoundedString(sessionIdentity, "session identity", { min: 1, max: 4_096 });
      assertRamScope(scope);
      return deriveRamSessionId(sessionIdentity, scope);
    },

    async healthCheck() {
      await client.health();
    },

    async searchLongTerm({ text, limit, key, namespace, userId, minScore }) {
      assertSearchText(text, "search text");
      assertIntegerInRange(limit, "limit", 1, MAX_RECALL_LIMIT);
      if (minScore !== undefined) assertNumberInRange(minScore, "minScore", 0, 1);
      assertRamScope({ key, namespace, userId });
      const response = await client.searchLongTermMemory({
        text,
        limit,
        similarityThreshold: minScore,
        filter: buildFilter(key, namespace, userId),
      });

      return response.items
        .filter((memory) => isAuthorizedRamMemory(memory, {
          key: key ?? "default",
          namespace,
          userId,
        }))
        .map((memory) => ({
        id: memory.id,
        text: memory.text,
        score: undefined,
        topics: memory.topics,
        entities: undefined,
        memoryType: memory.memoryType,
        source: memory.sessionId ? "session" : "direct",
        }));
    },

    async createLongTerm({ text, topics, key, namespace, userId }) {
      assertMemoryText(text, "text");
      if (topics !== undefined) assertTopics(topics);
      assertRamScope({ key, namespace, userId });
      const id = randomUUID();
      const ownerId = deriveRamOwnerId(namespace, userId, key);
      const response = await client.bulkCreateLongTermMemories({
        memories: [{
          id,
          text,
          topics,
          namespace,
          ownerId,
        }],
      });
      // Bulk create returns HTTP 201 even when an individual record is
      // rejected server-side: the failure lands in `errors` and `created`
      // stays empty. Treat an empty `created` as failure (symmetric with
      // deleteLongTerm below) so memory_store surfaces the error instead of
      // reporting a fabricated id that was never persisted.
      if ((response.created?.length ?? 0) === 0) {
        throw new Error(
          `RAM bulk create did not create the record; failures=${response.errors?.length ?? 0}`,
        );
      }
      return { id: response.created[0] ?? id };
    },

    async deleteLongTerm(ids, scope) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RECALL_LIMIT) {
        throw new Error(`ids must contain between 1 and ${MAX_RECALL_LIMIT} values`);
      }
      ids.forEach((id) => assertServiceIdentifier(id, "memoryId"));
      assertRamScope(scope);
      const result = emptyDeleteResult();
      const authorizedIds: string[] = [];

      for (const id of [...new Set(ids)]) {
        try {
          const memory = await client.getLongTermMemory(id);
          if (isAuthorizedRamMemory(memory, scope)) {
            authorizedIds.push(id);
          } else {
            result.forbiddenIds.push(id);
          }
        } catch (error) {
          if (error instanceof RamApiError && error.isNotFound) {
            result.notFoundIds.push(id);
          } else {
            result.failedIds.push(id);
          }
        }
      }

      if (authorizedIds.length === 0) return result;

      try {
        const response = await client.bulkDeleteLongTermMemories({ memoryIds: authorizedIds });
        const deleted = new Set(response.deleted);
        for (const id of authorizedIds) {
          if (deleted.has(id)) {
            result.deletedIds.push(id);
          } else {
            // Includes explicit item errors and malformed partial responses
            // that account for an id in neither response collection.
            result.failedIds.push(id);
          }
        }

        // Never report a backend error for an id it also says was deleted.
        result.failedIds = result.failedIds.filter((id) => !deleted.has(id));
      } catch {
        result.failedIds.push(...authorizedIds);
      }

      return result;
    },

    async eraseScope(scope, options): Promise<ScopeErasureResult> {
      assertRamScope(scope);
      assertIntegerInRange(options.settleMs, "erasure settleMs", 0, 60_000);
      assertIntegerInRange(options.maxRecords, "erasure maxRecords", 1, 10_000);
      const memoryIds = new Set<string>();
      const sessionIds = new Set<string>();
      const failedMemoryIds = new Set<string>();
      const failedSessionIds = new Set<string>();
      const residuals = new Set(erasureResiduals);
      let completedPasses = 0;

      const deleteSweep = async () => {
        const memories = await enumerateMemoryIds(scope, options.maxRecords);
        for (let offset = 0; offset < memories.length; offset += MAX_RECALL_LIMIT) {
          const batch = memories.slice(offset, offset + MAX_RECALL_LIMIT);
          const authorization = await mapWithConcurrency(
            batch,
            RAM_ERASURE_CONCURRENCY,
            async (id) => {
              try {
                const memory = await client.getLongTermMemory(id);
                return {
                  id,
                  status: isAuthorizedRamMemory(memory, scope)
                    ? "authorized" as const
                    : "forbidden" as const,
                };
              } catch (error) {
                return {
                  id,
                  status: error instanceof RamApiError && error.isNotFound
                    ? "absent" as const
                    : "failed" as const,
                };
              }
            },
          );
          const authorized = authorization
            .filter((result) => result.status === "authorized")
            .map((result) => result.id);
          for (const result of authorization) {
            if (result.status === "forbidden" || result.status === "failed") {
              failedMemoryIds.add(result.id);
            }
          }
          if (authorized.length > 0) {
            try {
              const deleted = await client.bulkDeleteLongTermMemories({ memoryIds: authorized });
              const deletedIds = new Set(deleted.deleted);
              for (const id of authorized) {
                if (deletedIds.has(id)) {
                  memoryIds.add(id);
                  failedMemoryIds.delete(id);
                } else failedMemoryIds.add(id);
              }
            } catch {
              authorized.forEach((id) => failedMemoryIds.add(id));
            }
          }
        }

        const sessions = await enumerateSessionIds(scope, options.maxRecords);
        await mapWithConcurrency(sessions, RAM_ERASURE_CONCURRENCY, async (id) => {
          try {
            await client.deleteSessionMemory(id);
            sessionIds.add(id);
            failedSessionIds.delete(id);
          } catch (error) {
            if (error instanceof RamApiError && error.isNotFound) {
              failedSessionIds.delete(id);
            } else {
              failedSessionIds.add(id);
            }
          }
        });
      };

      try {
        await deleteSweep();
        completedPasses += 1;
        if (options.settleMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.settleMs));
        }
        await deleteSweep();
        completedPasses += 1;
      } catch {
        residuals.add("enumeration_failed_closed");
      }

      let remainingMemoryIds: string[] = [];
      let remainingSessionIds: string[] = [];
      try {
        remainingMemoryIds = await enumerateMemoryIds(scope, options.maxRecords);
        remainingSessionIds = await enumerateSessionIds(scope, options.maxRecords);
      } catch {
        residuals.add("verification_failed");
      }

      // Reconcile the failure sets against the authoritative re-enumeration: an
      // id proven absent by verification is not a failure, even if an earlier
      // bulk-delete response omitted it from `deleted` (the adapter tolerates
      // such omissions). Mirrors the session 404 self-heal so a fully-erased
      // scope reports "verified_best_effort" instead of a spurious "partial".
      // Only runs when verification succeeded, so a failed re-enumeration never
      // clears a genuine failure.
      if (!residuals.has("verification_failed")) {
        const remainingMemory = new Set(remainingMemoryIds);
        for (const id of [...failedMemoryIds]) {
          if (!remainingMemory.has(id)) failedMemoryIds.delete(id);
        }
        const remainingSession = new Set(remainingSessionIds);
        for (const id of [...failedSessionIds]) {
          if (!remainingSession.has(id)) failedSessionIds.delete(id);
        }
      }

      const hasFailure = failedMemoryIds.size > 0 || failedSessionIds.size > 0 ||
        remainingMemoryIds.length > 0 || remainingSessionIds.length > 0 ||
        residuals.has("enumeration_failed_closed") || residuals.has("verification_failed");
      return {
        scopeKey: scope.key,
        status: hasFailure
          ? (memoryIds.size > 0 || sessionIds.size > 0 ? "partial" : "failed")
          : "verified_best_effort",
        passes: completedPasses,
        memoryIds: [...memoryIds].sort(),
        sessionIds: [...sessionIds].sort(),
        failedMemoryIds: [...failedMemoryIds].sort(),
        failedSessionIds: [...failedSessionIds].sort(),
        remainingMemoryIds,
        remainingSessionIds,
        residuals: [...residuals].sort(),
      };
    },

    async findDuplicate({ text, key, namespace, userId }) {
      assertMemoryText(text, "text");
      assertRamScope({ key, namespace, userId });
      const response = await client.searchLongTermMemory({
        text,
        limit: 1,
        similarityThreshold: 0.95,
        filter: buildFilter(key, namespace, userId),
      });

      // Re-verify the owner boundary client-side, exactly like searchLongTerm:
      // the server-side ownerId filter is treated as untrusted, so a record
      // outside this scope's derived owner must never be surfaced (and echoed
      // back to the model by memory_store) as a duplicate.
      const match = response.items.find((memory) =>
        isAuthorizedRamMemory(memory, { key: key ?? "default", namespace, userId }),
      );
      return match ? { id: match.id, text: match.text } : null;
    },

    async getCaptureCheckpoint(sessionId, _scope) {
      assertServiceIdentifier(sessionId, "sessionId");
      try {
        const sessionMemory = await client.getSessionMemory(sessionId);
        if (sessionMemory.events.length === 0) {
          return { maxTimestampMs: 0, messageIdsAtMax: [] };
        }

        let maxTimestampMs = 0;
        for (const event of sessionMemory.events) {
          maxTimestampMs = Math.max(maxTimestampMs, event.createdAt.getTime());
        }
        const messageIdsAtMax = sessionMemory.events
          .filter((event) => event.createdAt.getTime() === maxTimestampMs)
          .map((event) => {
            const metadata = event.metadata;
            return metadata && typeof metadata === "object" &&
              typeof (metadata as Record<string, unknown>).openclawMessageId === "string"
              ? (metadata as Record<string, unknown>).openclawMessageId as string
              : undefined;
          })
          .filter((id): id is string => Boolean(id));
        return { maxTimestampMs, messageIdsAtMax };
      } catch (err) {
        if (err instanceof RamApiError && err.isNotFound) {
          return { maxTimestampMs: 0, messageIdsAtMax: [] };
        }
        throw err;
      }
    },

    async captureMessages(sessionId, messages: CapturedMessage[], scope) {
      // Sequential, in order: RAM extracts server-side from the session
      // event stream, so event ordering matters. The checkpoint is read
      // after any ambiguous/partial failure before replay. Event POSTs remain
      // single-attempt because the service does not expose an idempotency key.
      assertServiceIdentifier(sessionId, "sessionId");
      assertRamScope(scope);
      if (messages.length < 1 || messages.length > 256) {
        throw new Error("capture batch must contain between 1 and 256 messages");
      }
      for (const message of messages) {
        assertServiceIdentifier(message.id, "message id");
        assertMemoryText(message.content, "message content");
        if (
          !Number.isInteger(message.timestampMs) ||
          !Number.isFinite(message.timestampMs) ||
          message.timestampMs < 0 ||
          message.timestampMs > 8_640_000_000_000_000
        ) {
          throw new Error("message timestamp must be a valid nonnegative Unix timestamp");
        }
      }
      const ownerId = deriveRamOwnerId(scope.namespace, scope.userId, scope.key);
      const acceptedMessageIds: string[] = [];
      for (const message of messages) {
        const event: AddSessionEventRequestContent = {
          actorId: ownerId,
          role: message.role.toUpperCase() as MessageRole,
          content: [{ text: message.content }],
          createdAt: new Date(message.timestampMs),
          sessionId,
          metadata: {
            openclawMessageId: message.id,
            ...(scope.key ? { openclawScopeKey: scope.key } : {}),
          },
        };
        try {
          await client.addSessionEvent(event);
          acceptedMessageIds.push(message.id);
        } catch (error) {
          throw new CaptureBatchError(
            "RAM capture stopped after an event request failed",
            acceptedMessageIds,
            error,
          );
        }
      }
      return { acceptedMessageIds };
    },
  };
}
