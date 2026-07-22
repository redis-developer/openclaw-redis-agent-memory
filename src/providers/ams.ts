/**
 * AMS (agent-memory-server) provider.
 *
 * Wraps the `agent-memory-client` `MemoryAPIClient` and holds every direct call
 * to that SDK. This is the only place in the plugin allowed to import from
 * `agent-memory-client`. All translation logic (distance/score math, dedup
 * threshold, working-memory checkpointing, summary views) lives here so the
 * plugin core can stay backend-agnostic.
 */

import { MemoryAPIClient, MemoryNotFoundError } from "agent-memory-client";
import type { MemoryMessage } from "agent-memory-client";
import { randomUUID } from "node:crypto";

import type { MemoryConfig, MemoryStrategy } from "../config.js";
import type { ScopedMemoryTarget } from "../scopes.js";
import type { PluginLogger } from "../types.js";
import type {
  CapturedMessage,
  DeleteLongTermResult,
  MemoryProvider,
  SummaryPartition,
  SummaryViewOperations,
} from "../provider.js";
import { CaptureBatchError } from "../provider.js";
import {
  MAX_IDENTIFIER_CHARS,
  MAX_RECALL_LIMIT,
  assertBoundedString,
  assertGenericIdentifier,
  assertIntegerInRange,
  assertMemoryText,
  assertNumberInRange,
  assertSearchText,
  assertTopics,
  safeErrorMessage,
} from "../validation.js";

function emptyDeleteResult(): DeleteLongTermResult {
  return {
    deletedIds: [],
    notFoundIds: [],
    forbiddenIds: [],
    failedIds: [],
  };
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

/**
 * Build the `long_term_memory_strategy` payload from scope extraction settings.
 * Returns undefined when no extraction strategy is configured.
 */
function buildLongTermMemoryStrategy(params: {
  extractionStrategy?: MemoryStrategy;
  customPrompt?: string;
}) {
  if (!params.extractionStrategy) return undefined;
  return {
    strategy: params.extractionStrategy,
    config:
      params.extractionStrategy === "custom" && params.customPrompt
        ? { prompt: params.customPrompt }
        : {},
  };
}

export function createAmsProvider(
  cfg: MemoryConfig,
  logger?: PluginLogger,
): MemoryProvider {
  const client = new MemoryAPIClient({
    baseUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    bearerToken: cfg.bearerToken,
    defaultNamespace: cfg.namespace,
    timeout: cfg.timeout,
  });
  const sensitiveValues = [cfg.apiKey, cfg.bearerToken];

  function assertAmsId(value: unknown, label: string): asserts value is string {
    assertGenericIdentifier(value, label);
  }

  function assertScope(namespace?: string, userId?: string): void {
    if (namespace !== undefined) assertAmsId(namespace, "namespace");
    if (userId !== undefined) assertAmsId(userId, "userId");
  }

  function assertAmsMemory(memory: {
    id: unknown;
    text: unknown;
    topics?: unknown;
    entities?: unknown;
    dist?: unknown;
  }): void {
    assertAmsId(memory.id, "memory id");
    assertMemoryText(memory.text, "memory text");
    if (memory.topics !== undefined && memory.topics !== null) assertTopics(memory.topics);
    if (memory.entities !== undefined && memory.entities !== null) {
      assertTopics(memory.entities, "entities");
    }
    if (
      memory.dist !== undefined &&
      (typeof memory.dist !== "number" || !Number.isFinite(memory.dist) || memory.dist < 0)
    ) {
      throw new Error("memory distance must be a finite nonnegative number");
    }
  }

  // Cache of summary view ids keyed by scope.key (owned by the provider).
  const summaryViewIds = new Map<string, string | null>();

  async function ensureView(scope: ScopedMemoryTarget): Promise<string | null> {
    try {
      const views = await client.listSummaryViews();
      const existing = views.find((view) => view.name === scope.summaryViewName);

      if (existing) {
        logger?.info?.(
          `redis-memory: using existing summary view "${scope.summaryViewName}" for scope "${scope.key}" (id: ${JSON.stringify(existing.id)})`,
        );
        summaryViewIds.set(scope.key, existing.id);
        return existing.id;
      }

      const filters: Record<string, unknown> = {};
      if (scope.namespace) {
        filters.namespace = scope.namespace;
      }

      const newView = await client.createSummaryView({
        name: scope.summaryViewName,
        source: "long_term",
        group_by: scope.summaryGroupBy,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        time_window_days: scope.summaryTimeWindowDays,
        continuous: false,
        prompt:
          "Summarize key facts, preferences, decisions, and important context about the user. " +
          "Focus on information that would be useful for future conversations. " +
          "Be concise but comprehensive.",
      });

      logger?.info?.(
        `redis-memory: created summary view "${scope.summaryViewName}" for scope "${scope.key}" (id: ${JSON.stringify(newView.id)})`,
      );
      summaryViewIds.set(scope.key, newView.id);
      return newView.id;
    } catch (err) {
      logger?.warn(
        `redis-memory: failed to initialize summary view for scope "${scope.key}": ${safeErrorMessage(err, sensitiveValues)}`,
      );
      summaryViewIds.set(scope.key, null);
      return null;
    }
  }

  async function refreshView(scope: ScopedMemoryTarget): Promise<void> {
    const viewId = summaryViewIds.get(scope.key);
    if (!viewId) return;

    try {
      const task = await client.runSummaryView(viewId);
      logger?.debug?.(
        `redis-memory: triggered summary refresh for scope "${scope.key}" (task: ${JSON.stringify(task.id)})`,
      );
    } catch (refreshErr) {
      if (refreshErr instanceof MemoryNotFoundError) {
        logger?.info?.(
          `redis-memory: summary view missing for scope "${scope.key}", re-creating...`,
        );
        await ensureView(scope);
      } else {
        logger?.debug?.(
          `redis-memory: summary refresh trigger failed for scope "${scope.key}": ${safeErrorMessage(refreshErr, sensitiveValues)}`,
        );
      }
    }
  }

  async function getSummaryPartition(
    scope: ScopedMemoryTarget,
  ): Promise<SummaryPartition | null> {
    const viewId = summaryViewIds.get(scope.key) ?? (await ensureView(scope));
    if (!viewId) return null;

    try {
      const partitions = await client.listSummaryViewPartitions(viewId, {
        namespace: scope.namespace,
        userId: scope.userId,
      });

      const partition =
        partitions.find((partition) => {
          for (const field of scope.summaryGroupBy) {
            if (field === "user_id" && partition.group.user_id !== scope.userId) {
              return false;
            }
            if (
              field === "namespace" &&
              partition.group.namespace !== scope.namespace
            ) {
              return false;
            }
          }
          return true;
        }) ?? partitions[0];

      if (partition?.summary && partition.memory_count > 0) {
        return {
          summary: partition.summary,
          memoryCount: partition.memory_count,
          computedAt: partition.computed_at,
        };
      }

      return null;
    } catch (err) {
      if (err instanceof MemoryNotFoundError) {
        logger?.info?.(
          `redis-memory: summary view missing for scope "${scope.key}", re-creating...`,
        );
        await ensureView(scope);
      } else {
        logger?.debug?.(
          `redis-memory: summary view fetch failed for scope "${scope.key}": ${safeErrorMessage(err, sensitiveValues)}`,
        );
      }
      return null;
    }
  }

  const summaries: SummaryViewOperations = {
    ensureView,
    getSummaryPartition,
    refreshView,
  };

  return {
    capabilities: {
      summaryViews: true,
      extractionStrategy: true,
      similarityScores: true,
    },

    deriveCaptureSessionId(sessionIdentity) {
      assertAmsId(sessionIdentity, "sessionId");
      return sessionIdentity;
    },

    async healthCheck() {
      await client.healthCheck();
    },

    async searchLongTerm({ text, limit, namespace, userId, minScore }) {
      assertSearchText(text, "search text");
      assertIntegerInRange(limit, "limit", 1, MAX_RECALL_LIMIT);
      if (minScore !== undefined) assertNumberInRange(minScore, "minScore", 0, 1);
      assertScope(namespace, userId);
      const distanceThreshold = minScore !== undefined ? 1 - minScore : undefined;
      const results = await client.searchLongTermMemory({
        text,
        limit,
        namespace: namespace ? { eq: namespace } : undefined,
        userId: userId ? { eq: userId } : undefined,
        distanceThreshold,
      });

      if (!Array.isArray(results.memories)) throw new Error("AMS search response is invalid");
      if (results.memories.length > MAX_RECALL_LIMIT) {
        throw new Error(`AMS search response exceeded ${MAX_RECALL_LIMIT} memories`);
      }
      results.memories.forEach(assertAmsMemory);
      return results.memories
        .filter((memory) =>
          normalizeOptionalString(memory.namespace) === namespace &&
          normalizeOptionalString(memory.user_id) === userId)
        .map((memory) => ({
          id: memory.id,
          text: memory.text,
          score: Math.max(0, 1 - (memory.dist ?? 0)),
          topics: memory.topics ?? undefined,
          entities: memory.entities ?? undefined,
          memoryType: memory.memory_type,
          source: memory.session_id ? "session" as const : "direct" as const,
        }))
        .filter((memory) => memory.score >= (minScore ?? 0.3));
    },

    async createLongTerm({ text, topics, namespace, userId }) {
      assertMemoryText(text, "text");
      if (topics !== undefined) assertTopics(topics);
      assertScope(namespace, userId);
      const id = randomUUID();
      await client.createLongTermMemory(
        [
          {
            id,
            text,
            topics,
            namespace,
            ...(userId ? { user_id: userId } : {}),
          },
        ],
        { namespace },
      );
      return { id };
    },

    async deleteLongTerm(ids, scope) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_RECALL_LIMIT) {
        throw new Error(`ids must contain between 1 and ${MAX_RECALL_LIMIT} values`);
      }
      ids.forEach((id) => assertAmsId(id, "memoryId"));
      assertScope(scope.namespace, scope.userId);
      const result = emptyDeleteResult();

      // The AMS delete endpoint accepts namespace but not user id. Fetch and
      // authorize each record first, then delete individually so the outcome
      // remains exact even when a later item fails.
      for (const id of [...new Set(ids)]) {
        let memory;
        try {
          memory = await client.getLongTermMemory(id, { namespace: scope.namespace });
        } catch (error) {
          if (error instanceof MemoryNotFoundError) {
            result.notFoundIds.push(id);
          } else {
            result.failedIds.push(id);
          }
          continue;
        }

        if (!memory) {
          result.notFoundIds.push(id);
          continue;
        }

        if (
          normalizeOptionalString(memory.namespace) !== scope.namespace ||
          normalizeOptionalString(memory.user_id) !== scope.userId
        ) {
          result.forbiddenIds.push(id);
          continue;
        }

        try {
          await client.deleteLongTermMemories([id], { namespace: scope.namespace });
          result.deletedIds.push(id);
        } catch (error) {
          if (error instanceof MemoryNotFoundError) {
            result.notFoundIds.push(id);
          } else {
            result.failedIds.push(id);
          }
        }
      }

      return result;
    },

    async eraseScope(scope, options) {
      assertScope(scope.namespace, scope.userId);
      assertIntegerInRange(options.settleMs, "erasure settleMs", 0, 60_000);
      assertIntegerInRange(options.maxRecords, "erasure maxRecords", 1, 10_000);
      // AMS exposes semantic search only (`text` is required), not an
      // exhaustive filter-only/list endpoint. Running a semantic wildcard
      // and calling it erasure would create a dangerous false guarantee, so
      // fail before deleting any subset of the subject's data.
      return {
        scopeKey: scope.key,
        status: "failed" as const,
        passes: 0,
        memoryIds: [],
        sessionIds: [],
        failedMemoryIds: [],
        failedSessionIds: [],
        remainingMemoryIds: [],
        remainingSessionIds: [],
        residuals: [
          "external_writers_not_quiesced",
          "long_term_enumeration_not_supported",
          "process_restart_can_end_capture_quiesce",
          "queued_extraction_not_barriered",
          "summary_views_not_erased",
          "upstream_backups_not_verifiable",
        ],
      };
    },

    async findDuplicate({ text, namespace, userId }) {
      assertMemoryText(text, "text");
      assertScope(namespace, userId);
      const existing = await client.searchLongTermMemory({
        text,
        limit: 1,
        namespace: namespace ? { eq: namespace } : undefined,
        userId: userId ? { eq: userId } : undefined,
      });

      if (!Array.isArray(existing.memories)) throw new Error("AMS search response is invalid");
      if (existing.memories.length > 0 && existing.memories[0].dist < 0.05) {
        assertAmsMemory(existing.memories[0]);
        return { id: existing.memories[0].id, text: existing.memories[0].text };
      }
      return null;
    },

    async getCaptureCheckpoint(sessionId, { namespace }) {
      assertAmsId(sessionId, "sessionId");
      if (namespace !== undefined) assertAmsId(namespace, "namespace");
      const wm = await client.getWorkingMemory(sessionId, { namespace });
      if (wm?.messages && wm.messages.length > 0) {
        let maxTimestampMs = 0;
        for (const message of wm.messages) {
          const timestampMs = message.created_at
            ? new Date(message.created_at).getTime()
            : 0;
          maxTimestampMs = Math.max(maxTimestampMs, timestampMs);
        }
        return {
          maxTimestampMs,
          messageIdsAtMax: wm.messages
            .filter(
              (message) =>
                (message.created_at ? new Date(message.created_at).getTime() : 0) ===
                maxTimestampMs,
            )
            .map((message) => message.id)
            .filter((id): id is string => typeof id === "string"),
        };
      }
      return { maxTimestampMs: 0, messageIdsAtMax: [] };
    },

    async captureMessages(
      sessionId,
      messages: CapturedMessage[],
      { namespace, userId, extractionStrategy, customPrompt, sessionRetentionSeconds },
    ) {
      assertAmsId(sessionId, "sessionId");
      assertScope(namespace, userId);
      if (messages.length < 1 || messages.length > 256) {
        throw new Error("capture batch must contain between 1 and 256 messages");
      }
      for (const message of messages) {
        assertBoundedString(message.id, "message id", { min: 1, max: MAX_IDENTIFIER_CHARS });
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
      const memoryMessages: MemoryMessage[] = messages.map((message) => ({
        role: message.role,
        content: message.content,
        id: message.id,
        created_at: new Date(message.timestampMs).toISOString(),
      }));

      try {
        await client.putWorkingMemory(sessionId, {
          messages: memoryMessages,
          namespace,
          ...(userId ? { user_id: userId } : {}),
          long_term_memory_strategy: buildLongTermMemoryStrategy({
            extractionStrategy,
            customPrompt,
          }),
          ...(sessionRetentionSeconds !== undefined
            ? { ttl_seconds: sessionRetentionSeconds }
            : {}),
        });
        return { acceptedMessageIds: messages.map((message) => message.id) };
      } catch (error) {
        // A failed PUT can be ambiguous at the transport boundary. Report no
        // confirmed ids and let the coordinator reconcile before replay.
        throw new CaptureBatchError(
          "AMS capture failed",
          [],
          new Error(safeErrorMessage(error, sensitiveValues)),
        );
      }
    },

    summaries,
  };
}
