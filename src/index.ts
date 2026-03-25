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
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { type MemoryConfig, memoryConfigSchema } from "./config.js";
import type { PluginApi, PluginDefinition } from "./types.js";
import { stringEnum } from "./types.js";
import {
  getConfiguredScopes,
  resolveAgentScopePlan,
  type AgentScopePlan,
  type ScopedMemoryTarget,
  type AgentScopeContext,
} from "./scopes.js";

// ============================================================================
// Session Store Helpers
// ============================================================================

/**
 * Read the sessionId from the OpenClaw session store.
 *
 * Session store is at: ~/.openclaw/agents/<agentId>/sessions/sessions.json
 * Format: { "agent:main:main": { "sessionId": "uuid", ... }, ... }
 */
export function readSessionIdFromStore(sessionKey: string): string | null {
  try {
    // Extract agentId from sessionKey (e.g., "agent:main:main" -> "main")
    const parts = sessionKey.split(":");
    const agentId = parts.length >= 2 ? parts[1] : "main";

    const storePath = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");

    if (!fs.existsSync(storePath)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const entry = data[sessionKey];

    if (entry && typeof entry.sessionId === "string") {
      return entry.sessionId;
    }

    return null;
  } catch {
    return null;
  }
}

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
  scope?: string;
  scopeLabel?: string;
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
 * Convert messages to MemoryMessage format for working memory.
 * Preserves original timestamps from pi-ai messages to enable deduplication.
 */
export function convertToMemoryMessages(messages: unknown[]): MemoryMessage[] {
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

    // Preserve original timestamp from pi-ai message (Unix ms), fallback to now
    const msgTimestamp =
      typeof msgObj.timestamp === "number" ? msgObj.timestamp : Date.now();

    result.push({
      role,
      content,
      id: typeof msgObj.id === "string" ? msgObj.id : randomUUID(),
      created_at: new Date(msgTimestamp).toISOString(),
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
  id: "openclaw-redis-agent-memory",
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
    // Scope helpers
    // ========================================================================

    const summaryViewIds = new Map<string, string | null>();

    // Track max message timestamp per session/scope pair to avoid re-sending messages
    const sessionMaxTimestamps = new Map<string, number>();

    function buildTrackingKey(scope: ScopedMemoryTarget, workingMemorySessionId: string): string {
      return `${scope.key}::${workingMemorySessionId}`;
    }

    function getWorkingMemorySessionId(
      sessionKey: string,
      scope: ScopedMemoryTarget,
    ): string {
      if (scope.workingMemorySessionId) {
        return scope.workingMemorySessionId;
      }

      const sessionId = readSessionIdFromStore(sessionKey);
      if (sessionId) {
        return `${sessionKey}:${sessionId}`;
      }

      return sessionKey;
    }

    function getToolPlan(ctx?: AgentScopeContext): AgentScopePlan {
      return resolveAgentScopePlan(cfg, ctx);
    }

    function describeScopes(scopes: ScopedMemoryTarget[], defaultScope?: ScopedMemoryTarget): string {
      if (scopes.length <= 1) return "";
      const scopeList = scopes.map((scope) => `${scope.key} (${scope.label})`).join(", ");
      const defaultText = defaultScope ? ` Default scope is "${defaultScope.key}".` : "";
      return ` Available scopes: ${scopeList}.${defaultText}`;
    }

    async function ensureSummaryView(scope: ScopedMemoryTarget): Promise<string | null> {
      try {
        const views = await client.listSummaryViews();
        const existing = views.find((view) => view.name === scope.summaryViewName);

        if (existing) {
          api.logger.info?.(
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

        api.logger.info?.(
          `redis-memory: created summary view "${scope.summaryViewName}" for scope "${scope.key}" (id: ${newView.id})`,
        );
        summaryViewIds.set(scope.key, newView.id);
        return newView.id;
      } catch (err) {
        api.logger.warn(
          `redis-memory: failed to initialize summary view for scope "${scope.key}": ${String(err)}`,
        );
        summaryViewIds.set(scope.key, null);
        return null;
      }
    }

    async function searchScope(
      scope: ScopedMemoryTarget,
      query: string,
      limit: number,
    ): Promise<MemorySearchResult[]> {
      const distanceThreshold = cfg.minScore !== undefined ? 1 - cfg.minScore : undefined;
      const results = await client.searchLongTermMemory({
        text: query,
        limit,
        namespace: scope.namespace ? { eq: scope.namespace } : undefined,
        userId: scope.userId ? { eq: scope.userId } : undefined,
        distanceThreshold,
      });

      return results.memories
        .map((memory) => ({
          id: memory.id,
          text: memory.text,
          score: Math.max(0, 1 - (memory.dist ?? 0)),
          topics: memory.topics ?? undefined,
          entities: memory.entities ?? undefined,
          scope: scope.key,
          scopeLabel: scope.label,
        }))
        .filter((memory) => memory.score >= (cfg.minScore ?? 0.3));
    }

    function resolveSelectedScope(
      scopeKey: string | undefined,
      allowedScopes: ScopedMemoryTarget[],
      fallbackScope: ScopedMemoryTarget,
    ): ScopedMemoryTarget {
      if (!scopeKey) return fallbackScope;

      const scope = allowedScopes.find((candidate) => candidate.key === scopeKey);
      if (!scope) {
        throw new Error(`Scope "${scopeKey}" is not available for this agent`);
      }
      return scope;
    }

    function buildLongTermMemoryStrategy(scope: ScopedMemoryTarget) {
      if (!scope.extractionStrategy) return undefined;
      return {
        strategy: scope.extractionStrategy,
        config:
          scope.extractionStrategy === "custom" && scope.customPrompt
            ? { prompt: scope.customPrompt }
            : {},
      };
    }

    async function refreshSummaryView(scope: ScopedMemoryTarget) {
      const viewId = summaryViewIds.get(scope.key);
      if (!viewId) return;

      try {
        const task = await client.runSummaryView(viewId);
        api.logger.debug?.(
          `redis-memory: triggered summary refresh for scope "${scope.key}" (task: ${task.id})`,
        );
      } catch (refreshErr) {
        if (refreshErr instanceof MemoryNotFoundError) {
          api.logger.info?.(
            `redis-memory: summary view missing for scope "${scope.key}", re-creating...`,
          );
          await ensureSummaryView(scope);
        } else {
          api.logger.debug?.(
            `redis-memory: summary refresh trigger failed for scope "${scope.key}": ${String(refreshErr)}`,
          );
        }
      }
    }

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      (toolCtx) => {
        const plan = getToolPlan({
          agentId: toolCtx.agentId,
          sessionKey: toolCtx.sessionKey,
        });
        const scopeKeys = plan.recallScopes.map((scope) => scope.key);
        const parameters: Record<string, unknown> = {
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" })),
        };
        if (scopeKeys.length > 1) {
          parameters.scope = Type.Optional(
            stringEnum(scopeKeys, {
              description: "Optional memory boundary to search within",
            }),
          );
        }

        return {
          name: "memory_recall",
          label: "Memory Recall",
          description:
            cfg.recallDescription! +
            describeScopes(plan.recallScopes, plan.defaultStoreScope),
          parameters: Type.Object(parameters as Record<string, any>),
          async execute(_toolCallId, params) {
            const { query, limit = 5, scope: scopeKey } = params as {
              query: string;
              limit?: number;
              scope?: string;
            };

            try {
              const targetScopes = scopeKey
                ? [resolveSelectedScope(scopeKey, plan.recallScopes, plan.defaultStoreScope)]
                : plan.recallScopes;

              const scopedResults = await Promise.all(
                targetScopes.map(async (scope) => ({
                  scope,
                  memories: await searchScope(scope, query, limit),
                })),
              );

              const merged = scopedResults
                .flatMap((entry) => entry.memories)
                .sort((left, right) => right.score - left.score)
                .slice(0, limit);

              if (merged.length === 0) {
                return {
                  content: [{ type: "text", text: "No relevant memories found." }],
                  details: { count: 0 },
                };
              }

              const text = merged
                .map((memory, index) => {
                  const prefix =
                    targetScopes.length > 1
                      ? `[${memory.scopeLabel ?? memory.scope}] `
                      : "";
                  return `${index + 1}. ${prefix}${memory.text} (${(memory.score * 100).toFixed(0)}%)`;
                })
                .join("\n");

              return {
                content: [{ type: "text", text: `Found ${merged.length} memories:\n\n${text}` }],
                details: { count: merged.length, memories: merged },
              };
            } catch (err) {
              api.logger.warn(`redis-memory: recall failed: ${String(err)}`);
              return {
                content: [{ type: "text", text: `Memory search failed: ${String(err)}` }],
                details: { error: String(err) },
              };
            }
          },
        };
      },
      { name: "memory_recall" },
    );

    api.registerTool(
      (toolCtx) => {
        const plan = getToolPlan({
          agentId: toolCtx.agentId,
          sessionKey: toolCtx.sessionKey,
        });
        const scopeKeys = plan.toolScopes.map((scope) => scope.key);
        const parameters: Record<string, unknown> = {
          text: Type.String({ description: "Information to remember" }),
          category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
        };
        if (scopeKeys.length > 1) {
          parameters.scope = Type.Optional(
            stringEnum(scopeKeys, {
              description: "Optional memory boundary to store within",
            }),
          );
        }

        return {
          name: "memory_store",
          label: "Memory Store",
          description:
            cfg.storeDescription! +
            describeScopes(plan.toolScopes, plan.defaultStoreScope),
          parameters: Type.Object(parameters as Record<string, any>),
          async execute(_toolCallId, params) {
            const { text, category, scope: scopeKey } = params as {
              text: string;
              category?: MemoryCategory;
              scope?: string;
            };

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
              const targetScope = resolveSelectedScope(
                scopeKey,
                plan.toolScopes,
                plan.defaultStoreScope,
              );
              const inferredCategory = category ?? detectCategory(text);
              const existing = await client.searchLongTermMemory({
                text,
                limit: 1,
                namespace: targetScope.namespace ? { eq: targetScope.namespace } : undefined,
                userId: targetScope.userId ? { eq: targetScope.userId } : undefined,
              });

              if (existing.memories.length > 0 && existing.memories[0].dist < 0.05) {
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `Similar memory already exists in ${targetScope.label}: ` +
                        `"${existing.memories[0].text}"`,
                    },
                  ],
                  details: {
                    action: "duplicate",
                    scope: targetScope.key,
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
                    topics: [inferredCategory],
                    namespace: targetScope.namespace,
                    ...(targetScope.userId ? { user_id: targetScope.userId } : {}),
                  },
                ],
                { namespace: targetScope.namespace },
              );

              return {
                content: [
                  {
                    type: "text",
                    text: `Stored in ${targetScope.label}: "${text.slice(0, 100)}..."`,
                  },
                ],
                details: { action: "created", id: memoryId, scope: targetScope.key },
              };
            } catch (err) {
              api.logger.warn(`redis-memory: store failed: ${String(err)}`);
              return {
                content: [{ type: "text", text: `Memory store failed: ${String(err)}` }],
                details: { error: String(err) },
              };
            }
          },
        };
      },
      { name: "memory_store" },
    );

    api.registerTool(
      (toolCtx) => {
        const plan = getToolPlan({
          agentId: toolCtx.agentId,
          sessionKey: toolCtx.sessionKey,
        });
        const scopeKeys = plan.toolScopes.map((scope) => scope.key);
        const parameters: Record<string, unknown> = {
          query: Type.Optional(Type.String({ description: "Search to find memory" })),
          memoryId: Type.Optional(Type.String({ description: "Specific memory ID" })),
        };
        if (scopeKeys.length > 1) {
          parameters.scope = Type.Optional(
            stringEnum(scopeKeys, {
              description: "Optional memory boundary to delete from",
            }),
          );
        }

        return {
          name: "memory_forget",
          label: "Memory Forget",
          description:
            cfg.forgetDescription! +
            describeScopes(plan.toolScopes, plan.defaultStoreScope),
          parameters: Type.Object(parameters as Record<string, any>),
          async execute(_toolCallId, params) {
            const { query, memoryId, scope: scopeKey } = params as {
              query?: string;
              memoryId?: string;
              scope?: string;
            };

            try {
              const targetScopes = scopeKey
                ? [resolveSelectedScope(scopeKey, plan.toolScopes, plan.defaultStoreScope)]
                : plan.toolScopes;

              if (memoryId) {
                let lastError: unknown;
                for (const scope of targetScopes) {
                  try {
                    await client.deleteLongTermMemories([memoryId], {
                      namespace: scope.namespace,
                    });
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Memory ${memoryId} forgotten from ${scope.label}.`,
                        },
                      ],
                      details: { action: "deleted", id: memoryId, scope: scope.key },
                    };
                  } catch (err) {
                    lastError = err;
                  }
                }

                throw lastError ?? new Error(`Memory ${memoryId} not found`);
              }

              if (query) {
                const merged = (
                  await Promise.all(
                    targetScopes.map((scope) => searchScope(scope, query, 5)),
                  )
                )
                  .flat()
                  .sort((left, right) => right.score - left.score);

                if (merged.length === 0) {
                  return {
                    content: [{ type: "text", text: "No matching memories found." }],
                    details: { found: 0 },
                  };
                }

                if (merged.length === 1 && merged[0].score > 0.9) {
                  const winningScope = targetScopes.find(
                    (scope) => scope.key === merged[0].scope,
                  ) ?? plan.defaultStoreScope;
                  await client.deleteLongTermMemories([merged[0].id], {
                    namespace: winningScope.namespace,
                  });
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Forgotten from ${winningScope.label}: "${merged[0].text}"`,
                      },
                    ],
                    details: {
                      action: "deleted",
                      id: merged[0].id,
                      scope: winningScope.key,
                    },
                  };
                }

                const list = merged
                  .map((result) => {
                    const scopeLabel = result.scopeLabel ?? result.scope ?? "unknown";
                    return `- [${result.id.slice(0, 8)}] [${scopeLabel}] ${result.text.slice(0, 60)}...`;
                  })
                  .join("\n");

                const candidates = merged.map((result) => ({
                  id: result.id,
                  text: result.text,
                  score: result.score,
                  scope: result.scope,
                  scopeLabel: result.scopeLabel,
                }));

                return {
                  content: [
                    {
                      type: "text",
                      text: `Found ${merged.length} candidates. Specify memoryId${scopeKeys.length > 1 ? " and optional scope" : ""}:\n${list}`,
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
        };
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Auto-recall: inject rolling summary + query-specific memories before prompt build
    if (cfg.autoRecall) {
      api.on("before_prompt_build", async (event, ctx) => {
        const e = event as { prompt?: string };
        if (!e.prompt || e.prompt.length < 5) return;

        const sessionKey = ctx?.sessionKey ?? "default";
        const plan = resolveAgentScopePlan(cfg, {
          agentId: ctx?.agentId,
          sessionKey,
        });

        for (const scope of plan.captureScopes) {
          const workingMemorySessionId = getWorkingMemorySessionId(sessionKey, scope);
          const trackingKey = buildTrackingKey(scope, workingMemorySessionId);
          try {
            const workingMemory = await client.getWorkingMemory(workingMemorySessionId, {
              namespace: scope.namespace,
            });
            if (workingMemory?.messages && workingMemory.messages.length > 0) {
              const maxTs = Math.max(
                ...workingMemory.messages.map((message) =>
                  message.created_at ? new Date(message.created_at).getTime() : 0,
                ),
              );
              sessionMaxTimestamps.set(trackingKey, maxTs);
            } else {
              sessionMaxTimestamps.delete(trackingKey);
            }
          } catch {
            sessionMaxTimestamps.delete(trackingKey);
          }
        }

        const contextParts: string[] = [];

        const searchQuery = stripEnvelopeForSearch(e.prompt);
        for (const scope of plan.recallScopes) {
          const scopedContextParts: string[] = [];

          const viewId = summaryViewIds.get(scope.key) ?? (await ensureSummaryView(scope));
          if (viewId) {
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
                scopedContextParts.push(
                  `<user-summary computed="${partition.computed_at ?? "unknown"}" memories="${partition.memory_count}">\n${partition.summary}\n</user-summary>`,
                );
                api.logger.info?.(
                  `redis-memory: injecting summary for scope "${scope.key}" (${partition.memory_count} memories)`,
                );
              }
            } catch (err) {
              if (err instanceof MemoryNotFoundError) {
                api.logger.info?.(
                  `redis-memory: summary view missing for scope "${scope.key}", re-creating...`,
                );
                await ensureSummaryView(scope);
              } else {
                api.logger.debug?.(
                  `redis-memory: summary view fetch failed for scope "${scope.key}": ${String(err)}`,
                );
              }
            }
          }

          if (searchQuery && searchQuery.length >= 5) {
            try {
              const filtered = await searchScope(scope, searchQuery, cfg.recallLimit ?? 3);
              if (filtered.length > 0) {
                const memoryList = filtered.map((memory) => `- ${memory.text}`).join("\n");
                scopedContextParts.push(
                  `<relevant-memories query-specific="true">\n${memoryList}\n</relevant-memories>`,
                );
                api.logger.info?.(
                  `redis-memory: injecting ${filtered.length} query-specific memories for scope "${scope.key}"`,
                );
              }
            } catch (err) {
              api.logger.warn(
                `redis-memory: semantic search failed for scope "${scope.key}": ${String(err)}`,
              );
            }
          }

          if (scopedContextParts.length === 0) continue;

          if (plan.recallScopes.length > 1) {
            contextParts.push(
              `<memory-scope key="${scope.key}" label="${scope.label}">\n${scopedContextParts.join("\n\n")}\n</memory-scope>`,
            );
          } else {
            contextParts.push(scopedContextParts.join("\n\n"));
          }
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
          const sessionKey = ctx?.sessionKey ?? `session-${Date.now()}`;
          const plan = resolveAgentScopePlan(cfg, {
            agentId: ctx?.agentId,
            sessionKey,
          });

          const allMemoryMessages = convertToMemoryMessages(e.messages);
          if (allMemoryMessages.length === 0) {
            return;
          }

          for (const scope of plan.captureScopes) {
            const workingMemorySessionId = getWorkingMemorySessionId(sessionKey, scope);
            const trackingKey = buildTrackingKey(scope, workingMemorySessionId);
            const cutoffTs = sessionMaxTimestamps.get(trackingKey) ?? 0;
            const newMessages = allMemoryMessages.filter((message) => {
              const messageTs = message.created_at ? new Date(message.created_at).getTime() : 0;
              return messageTs > cutoffTs;
            });

            sessionMaxTimestamps.delete(trackingKey);

            if (newMessages.length === 0) {
              continue;
            }

            await client.putWorkingMemory(workingMemorySessionId, {
              messages: newMessages,
              namespace: scope.namespace,
              ...(scope.userId ? { user_id: scope.userId } : {}),
              long_term_memory_strategy: buildLongTermMemoryStrategy(scope),
            });

            await refreshSummaryView(scope);
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

          for (const scope of getConfiguredScopes(cfg)) {
            await ensureSummaryView(scope);
          }
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
