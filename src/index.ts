/**
 * Agent Memory Plugin
 *
 * Long-term memory with vector search for AI conversations.
 * Uses agent-memory-server (Redis-backed) for storage and semantic search.
 *
 * Features:
 * - Auto-recall: Semantic search for relevant long-term memories
 * - Auto-capture: Saves conversation to working memory for background extraction
 * - Manual tools: Store, search, and forget memories explicitly
 *
 * The server handles memory extraction in the background, keeping the client fast.
 *
 * ## Memory Retrieval
 *
 * The plugin uses semantic search (`searchLongTermMemory`) for auto-recall.
 * Conversation history is handled separately, so we only inject long-term
 * memories - not working memory (recent messages).
 *
 * ## Extraction Strategies
 *
 * Configure how the server extracts memories from conversations:
 *
 * - **discrete** (default): Extract semantic and episodic memories
 * - **summary**: Maintain a running summary of the conversation
 * - **preferences**: Focus on extracting user preferences and settings
 * - **custom**: Use a custom extraction prompt for specialized use cases
 */

import { Type } from "@sinclair/typebox";
import { MemoryAPIClient, MemoryNotFoundError } from "agent-memory-client";
import type { MemoryMessage } from "agent-memory-client";
import { randomUUID } from "node:crypto";

import { type MemoryConfig, memoryConfigSchema } from "./config.js";
import type { PluginApi, PluginDefinition } from "./types.js";
import { stringEnum } from "./types.js";

// ============================================================================
// Types
// ============================================================================

const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

type MemorySearchResult = {
  id: string;
  text: string;
  score: number;
  category?: string;
  topics?: string[];
  entities?: string[];
};

// ============================================================================
// Message conversion helpers
// ============================================================================

/**
 * Extract text content from a message content block (handles string or array format)
 */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as Record<string, unknown>).type === "text" &&
        "text" in block &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    return texts.join("\n");
  }

  return "";
}

/**
 * Strip envelope metadata from prompts before searching.
 * Removes [message_id: ...] hints and envelope headers like [Channel user timestamp].
 */
function stripEnvelopeForSearch(text: string): string {
  // Strip [message_id: ...] lines
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter((line) => !/^\[message_id:\s*[^\]]+\]$/.test(line.trim()));
  let result = filtered.join("\n");

  // Strip envelope header like [Channel user timestamp] at the start
  const envelopeMatch = result.match(/^\[([^\]]+)\]\s*/);
  if (envelopeMatch) {
    const header = envelopeMatch[1] ?? "";
    // Check if it looks like an envelope (has multiple space-separated parts)
    if (header.split(/\s+/).length >= 2) {
      result = result.slice(envelopeMatch[0].length);
    }
  }

  return result.trim();
}

/**
 * Convert messages to MemoryMessage format for working memory
 */
function convertToMemoryMessages(messages: unknown[]): MemoryMessage[] {
  const result: MemoryMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;

    const role = msgObj.role;
    if (typeof role !== "string") continue;

    // Only include user and assistant messages
    if (role !== "user" && role !== "assistant") continue;

    const content = extractTextContent(msgObj.content);
    if (!content.trim()) continue;

    // Skip injected memory context
    if (content.includes("<relevant-memories>")) continue;

    result.push({
      role,
      content,
      id: typeof msgObj.id === "string" ? msgObj.id : randomUUID(),
      created_at: new Date().toISOString(),
    });
  }

  return result;
}

// ============================================================================
// Category detection for manual store tool
// ============================================================================

function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want/i.test(lower)) return "preference";
  if (/rozhodli|decided|will use|budeme/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) return "entity";
  if (/is|are|has|have|je|má|jsou/i.test(lower)) return "fact";
  return "other";
}

// ============================================================================
// Plugin Definition
// ============================================================================

const redisMemoryPlugin: PluginDefinition = {
  id: "redis-memory",
  name: "Redis Memory",
  description: "Redis-backed long-term memory via agent-memory-server with auto-recall/capture",
  kind: "memory",
  configSchema: memoryConfigSchema,

  register(api: PluginApi) {
    const cfg = memoryConfigSchema.parse(api.pluginConfig);
    const client = new MemoryAPIClient({
      baseUrl: cfg.serverUrl,
      apiKey: cfg.apiKey,
      bearerToken: cfg.bearerToken,
      defaultNamespace: cfg.namespace,
      timeout: cfg.timeout,
    });

    api.logger.info?.(
      `redis-memory: plugin registered (server: ${cfg.serverUrl}, namespace: ${cfg.namespace ?? "default"})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_recall",
        label: "Memory Recall",
        description: cfg.recallDescription!,
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5 } = params as { query: string; limit?: number };

          try {
            const results = await client.searchLongTermMemory({
              text: query,
              limit,
              namespace: cfg.namespace ? { eq: cfg.namespace } : undefined,
              userId: cfg.userId ? { eq: cfg.userId } : undefined,
            });

            if (results.memories.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            // Convert distance to similarity score (lower distance = higher similarity)
            const mapped: MemorySearchResult[] = results.memories.map((m) => ({
              id: m.id,
              text: m.text,
              score: Math.max(0, 1 - (m.dist ?? 0)),
              topics: m.topics ?? undefined,
              entities: m.entities ?? undefined,
            }));

            // Filter by minimum score
            const filtered = mapped.filter((r) => r.score >= cfg.minScore!);

            if (filtered.length === 0) {
              return {
                content: [{ type: "text", text: "No relevant memories found." }],
                details: { count: 0 },
              };
            }

            const text = filtered
              .map((r, i) => `${i + 1}. ${r.text} (${(r.score * 100).toFixed(0)}%)`)
              .join("\n");

            return {
              content: [
                { type: "text", text: `Found ${filtered.length} memories:\n\n${text}` },
              ],
              details: { count: filtered.length, memories: filtered },
            };
          } catch (err) {
            api.logger.warn(`redis-memory: recall failed: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Memory search failed: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description: cfg.storeDescription!,
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        }),
        async execute(_toolCallId, params) {
          const { text, category = "other" } = params as {
            text: string;
            category?: MemoryCategory;
          };

          // Validate text is non-empty
          if (!text || !text.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: The 'text' parameter is required and cannot be empty. Please provide the actual content you want to store in memory.",
                },
              ],
              details: { error: "empty_text", action: "rejected" },
            };
          }

          try {
            // Check for duplicates by searching first
            const existing = await client.searchLongTermMemory({
              text,
              limit: 1,
              namespace: cfg.namespace ? { eq: cfg.namespace } : undefined,
              userId: cfg.userId ? { eq: cfg.userId } : undefined,
            });

            if (existing.memories.length > 0 && existing.memories[0].dist < 0.05) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Similar memory already exists: "${existing.memories[0].text}"`,
                  },
                ],
                details: {
                  action: "duplicate",
                  existingId: existing.memories[0].id,
                  existingText: existing.memories[0].text,
                },
              };
            }

            const memoryId = randomUUID();
            await client.createLongTermMemory(
              [
                {
                  id: memoryId,
                  text,
                  topics: [category],
                  namespace: cfg.namespace,
                },
              ],
              { namespace: cfg.namespace },
            );

            return {
              content: [{ type: "text", text: `Stored: "${text.slice(0, 100)}..."` }],
              details: { action: "created", id: memoryId },
            };
          } catch (err) {
            api.logger.warn(`redis-memory: store failed: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Memory store failed: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: cfg.forgetDescription!,
        parameters: Type.Object({
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as { query?: string; memoryId?: string };

          try {
            if (memoryId) {
              // Direct fetch workaround for SDK issue
              const deleteUrl = new URL("/v1/long-term-memory", cfg.serverUrl);
              deleteUrl.searchParams.set("memory_ids", memoryId);
              const deleteRes = await fetch(deleteUrl.toString(), {
                method: "DELETE",
                headers: {
                  "Content-Type": "application/json",
                  ...(cfg.apiKey && { "X-API-Key": cfg.apiKey }),
                  ...(cfg.bearerToken && { Authorization: `Bearer ${cfg.bearerToken}` }),
                },
              });
              if (!deleteRes.ok) {
                throw new Error(`Delete failed: ${deleteRes.status} ${deleteRes.statusText}`);
              }
              return {
                content: [{ type: "text", text: `Memory ${memoryId} forgotten.` }],
                details: { action: "deleted", id: memoryId },
              };
            }

            if (query) {
              const results = await client.searchLongTermMemory({
                text: query,
                limit: 5,
                namespace: cfg.namespace ? { eq: cfg.namespace } : undefined,
                userId: cfg.userId ? { eq: cfg.userId } : undefined,
              });

              if (results.memories.length === 0) {
                return {
                  content: [{ type: "text", text: "No matching memories found." }],
                  details: { found: 0 },
                };
              }

              // Convert distance to similarity score
              const scored = results.memories.map((m) => ({
                ...m,
                score: Math.max(0, 1 - (m.dist ?? 0)),
              }));

              if (scored.length === 1 && scored[0].score > 0.9) {
                // Direct fetch workaround for SDK issue
                const deleteUrl = new URL("/v1/long-term-memory", cfg.serverUrl);
                deleteUrl.searchParams.set("memory_ids", scored[0].id);
                const deleteRes = await fetch(deleteUrl.toString(), {
                  method: "DELETE",
                  headers: {
                    "Content-Type": "application/json",
                    ...(cfg.apiKey && { "X-API-Key": cfg.apiKey }),
                    ...(cfg.bearerToken && { Authorization: `Bearer ${cfg.bearerToken}` }),
                  },
                });
                if (!deleteRes.ok) {
                  throw new Error(`Delete failed: ${deleteRes.status} ${deleteRes.statusText}`);
                }
                return {
                  content: [{ type: "text", text: `Forgotten: "${scored[0].text}"` }],
                  details: { action: "deleted", id: scored[0].id },
                };
              }

              const list = scored
                .map((r) => `- [${r.id.slice(0, 8)}] ${r.text.slice(0, 60)}...`)
                .join("\n");

              const candidates = scored.map((r) => ({
                id: r.id,
                text: r.text,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${scored.length} candidates. Specify memoryId:\n${list}`,
                  },
                ],
                details: { action: "candidates", candidates },
              };
            }

            return {
              content: [{ type: "text", text: "Provide query or memoryId." }],
              details: { error: "missing_param" },
            };
          } catch (err) {
            api.logger.warn(`redis-memory: forget failed: ${String(err)}`);
            return {
              content: [{ type: "text", text: `Memory forget failed: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // Summary View Management
    // ========================================================================

    let summaryViewId: string | null = null;

    async function ensureSummaryView(): Promise<string | null> {
      try {
        const views = await client.listSummaryViews();
        const existing = views.find((v) => v.name === cfg.summaryViewName);

        if (existing) {
          api.logger.info?.(
            `redis-memory: using existing summary view "${cfg.summaryViewName}" (id: ${existing.id})`,
          );
          return existing.id;
        }

        const filters: Record<string, unknown> = {};
        if (cfg.namespace) {
          filters.namespace = cfg.namespace;
        }

        const newView = await client.createSummaryView({
          name: cfg.summaryViewName,
          source: "long_term",
          group_by: cfg.summaryGroupBy ?? ["user_id"],
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          time_window_days: cfg.summaryTimeWindowDays,
          continuous: false,
          prompt:
            "Summarize key facts, preferences, decisions, and important context about the user. " +
            "Focus on information that would be useful for future conversations. " +
            "Be concise but comprehensive.",
        });

        api.logger.info?.(
          `redis-memory: created summary view "${cfg.summaryViewName}" (id: ${newView.id})`,
        );
        return newView.id;
      } catch (err) {
        api.logger.warn(`redis-memory: failed to initialize summary view: ${String(err)}`);
        return null;
      }
    }

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject rolling summary + query-specific memories before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, _ctx) => {
        const e = event as { prompt?: string };
        if (!e.prompt || e.prompt.length < 5) return;

        const contextParts: string[] = [];

        // 1. Try to get the cached summary from the summary view
        if (summaryViewId) {
          try {
            const partitions = await client.listSummaryViewPartitions(summaryViewId, {
              namespace: cfg.namespace,
              userId: cfg.userId,
            });

            const partition = partitions.find((p) => {
              const groupBy = cfg.summaryGroupBy ?? ["user_id"];
              for (const field of groupBy) {
                if (field === "user_id" && p.group.user_id !== cfg.userId) return false;
                if (field === "namespace" && p.group.namespace !== cfg.namespace) return false;
              }
              return true;
            }) ?? partitions[0];

            if (partition && partition.summary && partition.memory_count > 0) {
              contextParts.push(
                `<user-summary computed="${partition.computed_at ?? "unknown"}" memories="${partition.memory_count}">\n${partition.summary}\n</user-summary>`,
              );
              api.logger.info?.(
                `redis-memory: injecting summary (${partition.memory_count} memories)`,
              );
            }
          } catch (err) {
            if (err instanceof MemoryNotFoundError) {
              api.logger.info?.("redis-memory: summary view not found, re-creating...");
              summaryViewId = await ensureSummaryView();
            } else {
              api.logger.debug?.(`redis-memory: summary view fetch failed: ${String(err)}`);
            }
          }
        }

        // 2. Semantic search for query-specific memories
        try {
          const searchQuery = stripEnvelopeForSearch(e.prompt);
          if (searchQuery && searchQuery.length >= 5) {
            const distanceThreshold = cfg.minScore !== undefined ? 1 - cfg.minScore : undefined;

            const results = await client.searchLongTermMemory({
              text: searchQuery,
              limit: cfg.recallLimit,
              namespace: cfg.namespace ? { eq: cfg.namespace } : undefined,
              userId: cfg.userId ? { eq: cfg.userId } : undefined,
              distanceThreshold,
            });

            if (results.memories.length > 0) {
              const filtered = results.memories
                .map((m) => ({
                  id: m.id,
                  text: m.text,
                  score: Math.max(0, 1 - (m.dist ?? 0)),
                }))
                .filter((r) => r.score >= (cfg.minScore ?? 0.3));

              if (filtered.length > 0) {
                const memoryList = filtered.map((r) => `- ${r.text}`).join("\n");
                contextParts.push(
                  `<relevant-memories query-specific="true">\n${memoryList}\n</relevant-memories>`,
                );
                api.logger.info?.(
                  `redis-memory: injecting ${filtered.length} query-specific memories`,
                );
              }
            }
          }
        } catch (err) {
          api.logger.warn(`redis-memory: semantic search failed: ${String(err)}`);
        }

        if (contextParts.length === 0) return;

        return {
          prependContext: contextParts.join("\n\n"),
        };
      });
    }

    // Auto-capture: save conversation to working memory for background extraction
    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        const e = event as { success?: boolean; messages?: unknown[] };
        if (!e.success || !e.messages || e.messages.length === 0) {
          return;
        }

        try {
          const sessionId = ctx?.sessionKey ?? `session-${Date.now()}`;
          const memoryMessages = convertToMemoryMessages(e.messages);

          if (memoryMessages.length === 0) {
            api.logger.debug?.("redis-memory: no messages to capture");
            return;
          }

          const longTermMemoryStrategy = cfg.extractionStrategy
            ? {
                strategy: cfg.extractionStrategy,
                config:
                  cfg.extractionStrategy === "custom" && cfg.customPrompt
                    ? { prompt: cfg.customPrompt }
                    : {},
              }
            : undefined;

          await client.putWorkingMemory(sessionId, {
            messages: memoryMessages,
            namespace: cfg.namespace,
            user_id: cfg.userId,
            long_term_memory_strategy: longTermMemoryStrategy,
          });

          api.logger.info?.(
            `redis-memory: saved ${memoryMessages.length} messages to working memory`,
          );

          // Trigger async summary view refresh (non-blocking)
          if (summaryViewId) {
            try {
              const task = await client.runSummaryView(summaryViewId);
              api.logger.debug?.(
                `redis-memory: triggered summary refresh (task: ${task.id})`,
              );
            } catch (refreshErr) {
              if (refreshErr instanceof MemoryNotFoundError) {
                api.logger.info?.("redis-memory: summary view not found, re-creating...");
                summaryViewId = await ensureSummaryView();
              } else {
                api.logger.debug?.(
                  `redis-memory: summary refresh trigger failed: ${String(refreshErr)}`,
                );
              }
            }
          }
        } catch (err) {
          api.logger.warn(`redis-memory: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "redis-memory",
      start: async () => {
        try {
          await client.healthCheck();
          api.logger.info?.(
            `redis-memory: connected to server (${cfg.serverUrl}, namespace: ${cfg.namespace ?? "default"})`,
          );

          // Initialize summary view
          summaryViewId = await ensureSummaryView();
        } catch (err) {
          api.logger.warn(
            `redis-memory: server not reachable at ${cfg.serverUrl}: ${String(err)}`,
          );
        }
      },
      stop: () => {
        api.logger.info?.("redis-memory: stopped");
      },
    });
  },
};

export default redisMemoryPlugin;

// Re-export config for convenience
export { memoryConfigSchema, parseMemoryConfig } from "./config.js";
export type { MemoryConfig, MemoryStrategy, SummaryGroupByField } from "./config.js";
export type { PluginApi, PluginDefinition, ToolDefinition, ToolResult } from "./types.js";

