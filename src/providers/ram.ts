/**
 * RAM (Redis Agent Memory cloud REST API) provider.
 *
 * Wraps the dependency-free `RamClient` (Story 02) and holds every direct
 * call to that client. All translation logic (filter shaping, dedup
 * threshold, capture checkpointing) lives here so the plugin core can stay
 * backend-agnostic. Unlike the AMS provider, RAM performs extraction and
 * summarization server-side, so this provider has no `summaries` member and
 * ignores `extractionStrategy` / `customPrompt` on capture.
 */

import { randomUUID } from "node:crypto";

import type { MemoryConfig } from "../config.js";
import type { PluginLogger } from "../types.js";
import type { CapturedMessage, MemoryProvider } from "../provider.js";
import { RamClient } from "../ram/client.js";
import {
  RamApiError,
  type RamAddSessionEvent,
  type RamLongTermMemoryFilter,
  type RamMessageRole,
} from "../ram/types.js";

/**
 * `storeId` is being added to `MemoryConfig` by a parallel story
 * (config.ts is owned by another agent while this one is in flight). Cast
 * locally rather than editing config.ts here.
 */
type CloudConfig = MemoryConfig & { storeId?: string };

/** Shared namespace/ownerId filter builder for search and findDuplicate. */
function buildFilter(
  namespace: string | undefined,
  userId: string | undefined,
): RamLongTermMemoryFilter | undefined {
  if (!namespace && !userId) return undefined;
  const filter: RamLongTermMemoryFilter = {};
  if (namespace) filter.namespace = { eq: namespace };
  if (userId) filter.ownerId = { eq: userId };
  return filter;
}

export function createRamProvider(
  cfg: MemoryConfig,
  logger?: PluginLogger,
): MemoryProvider {
  const cloudCfg = cfg as CloudConfig;
  const client = new RamClient({
    serverUrl: cloudCfg.serverUrl,
    apiKey: cloudCfg.apiKey!,
    storeId: cloudCfg.storeId!,
    timeoutMs: cloudCfg.timeout,
  });

  return {
    capabilities: {
      summaryViews: false,
      extractionStrategy: false,
      similarityScores: false,
    },

    async healthCheck() {
      await client.health();
    },

    async searchLongTerm({ text, limit, namespace, userId, minScore }) {
      const response = await client.searchLongTermMemory({
        text,
        limit,
        similarityThreshold: minScore,
        filter: buildFilter(namespace, userId),
      });

      return response.memories.map((memory) => ({
        id: memory.id,
        text: memory.text,
        score: undefined,
        topics: memory.topics,
        entities: undefined,
      }));
    },

    async createLongTerm({ text, topics, namespace, userId }) {
      const id = randomUUID();
      const response = await client.bulkCreateLongTermMemories([
        {
          id,
          text,
          topics,
          namespace,
          ownerId: userId ?? "default",
        },
      ]);
      // Bulk create returns HTTP 201 even when an individual record is
      // rejected server-side: the failure lands in `errors` and `created`
      // stays empty. Treat an empty `created` as failure (symmetric with
      // deleteLongTerm below) so memory_store surfaces the error instead of
      // reporting a fabricated id that was never persisted.
      if ((response.created?.length ?? 0) === 0) {
        throw new Error(
          `RAM bulkCreateLongTermMemories did not create the record${
            response.errors?.length ? `: ${JSON.stringify(response.errors)}` : ""
          }`,
        );
      }
      return { id: response.created[0] ?? id };
    },

    async deleteLongTerm(ids, { namespace: _namespace }) {
      // namespace is irrelevant for id-based deletion in RAM; accepted for
      // interface compatibility with the AMS provider and ignored here.
      const res = await client.bulkDeleteLongTermMemories(ids);
      if ((res.deleted?.length ?? 0) === 0 && (res.errors?.length ?? 0) > 0) {
        throw new Error(
          `RAM bulkDeleteLongTermMemories failed for all ids: ${JSON.stringify(res.errors)}`,
        );
      }
    },

    async findDuplicate({ text, namespace, userId }) {
      const response = await client.searchLongTermMemory({
        text,
        limit: 1,
        similarityThreshold: 0.95,
        filter: buildFilter(namespace, userId),
      });

      if (response.memories.length > 0) {
        const [match] = response.memories;
        return { id: match.id, text: match.text };
      }
      return null;
    },

    async getCaptureCheckpoint(sessionId, _scope) {
      try {
        const sessionMemory = await client.getSessionMemory(sessionId);
        return sessionMemory.events.length > 0
          ? Math.max(...sessionMemory.events.map((event) => event.createdAt))
          : 0;
      } catch (err) {
        if (err instanceof RamApiError && err.isNotFound) return 0;
        throw err;
      }
    },

    async captureMessages(sessionId, messages: CapturedMessage[], scope) {
      // Sequential, in order: RAM extracts server-side from the session
      // event stream, so event ordering matters. The checkpoint is read
      // fresh from getSessionMemory each turn, so if an event throws
      // mid-batch, the next turn's checkpoint still reflects exactly what
      // the server persisted and will re-send only what's missing.
      for (const message of messages) {
        const event: RamAddSessionEvent = {
          actorId: scope.userId ?? "default",
          role: message.role.toUpperCase() as RamMessageRole,
          content: [{ text: message.content }],
          createdAt: message.timestampMs,
          sessionId,
        };
        await client.addSessionEvent(event);
      }
    },
  };
}
