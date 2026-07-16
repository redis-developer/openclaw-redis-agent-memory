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
  MemoryProvider,
  SummaryPartition,
  SummaryViewOperations,
} from "../provider.js";

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

  // Cache of summary view ids keyed by scope.key (owned by the provider).
  const summaryViewIds = new Map<string, string | null>();

  async function ensureView(scope: ScopedMemoryTarget): Promise<string | null> {
    try {
      const views = await client.listSummaryViews();
      const existing = views.find((view) => view.name === scope.summaryViewName);

      if (existing) {
        logger?.info?.(
          `redis-memory: using existing summary view "${scope.summaryViewName}" for scope "${scope.key}" (id: ${existing.id})`,
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
        `redis-memory: created summary view "${scope.summaryViewName}" for scope "${scope.key}" (id: ${newView.id})`,
      );
      summaryViewIds.set(scope.key, newView.id);
      return newView.id;
    } catch (err) {
      logger?.warn(
        `redis-memory: failed to initialize summary view for scope "${scope.key}": ${String(err)}`,
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
        `redis-memory: triggered summary refresh for scope "${scope.key}" (task: ${task.id})`,
      );
    } catch (refreshErr) {
      if (refreshErr instanceof MemoryNotFoundError) {
        logger?.info?.(
          `redis-memory: summary view missing for scope "${scope.key}", re-creating...`,
        );
        await ensureView(scope);
      } else {
        logger?.debug?.(
          `redis-memory: summary refresh trigger failed for scope "${scope.key}": ${String(refreshErr)}`,
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
          `redis-memory: summary view fetch failed for scope "${scope.key}": ${String(err)}`,
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

    async healthCheck() {
      await client.healthCheck();
    },

    async searchLongTerm({ text, limit, namespace, userId, minScore }) {
      const distanceThreshold = minScore !== undefined ? 1 - minScore : undefined;
      const results = await client.searchLongTermMemory({
        text,
        limit,
        namespace: namespace ? { eq: namespace } : undefined,
        userId: userId ? { eq: userId } : undefined,
        distanceThreshold,
      });

      return results.memories
        .map((memory) => ({
          id: memory.id,
          text: memory.text,
          score: Math.max(0, 1 - (memory.dist ?? 0)),
          topics: memory.topics ?? undefined,
          entities: memory.entities ?? undefined,
        }))
        .filter((memory) => memory.score >= (minScore ?? 0.3));
    },

    async createLongTerm({ text, topics, namespace, userId }) {
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

    async deleteLongTerm(ids, { namespace }) {
      await client.deleteLongTermMemories(ids, { namespace });
    },

    async findDuplicate({ text, namespace, userId }) {
      const existing = await client.searchLongTermMemory({
        text,
        limit: 1,
        namespace: namespace ? { eq: namespace } : undefined,
        userId: userId ? { eq: userId } : undefined,
      });

      if (existing.memories.length > 0 && existing.memories[0].dist < 0.05) {
        return { id: existing.memories[0].id, text: existing.memories[0].text };
      }
      return null;
    },

    async getCaptureCheckpoint(sessionId, { namespace }) {
      const wm = await client.getWorkingMemory(sessionId, { namespace });
      if (wm?.messages && wm.messages.length > 0) {
        return Math.max(
          ...wm.messages.map((message) =>
            message.created_at ? new Date(message.created_at).getTime() : 0,
          ),
        );
      }
      return 0;
    },

    async captureMessages(
      sessionId,
      messages: CapturedMessage[],
      { namespace, userId, extractionStrategy, customPrompt },
    ) {
      const memoryMessages: MemoryMessage[] = messages.map((message) => ({
        role: message.role,
        content: message.content,
        id: message.id,
        created_at: new Date(message.timestampMs).toISOString(),
      }));

      await client.putWorkingMemory(sessionId, {
        messages: memoryMessages,
        namespace,
        ...(userId ? { user_id: userId } : {}),
        long_term_memory_strategy: buildLongTermMemoryStrategy({
          extractionStrategy,
          customPrompt,
        }),
      });
    },

    summaries,
  };
}
