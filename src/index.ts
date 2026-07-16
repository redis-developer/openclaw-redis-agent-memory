/**
 * Redis Agent Memory Plugin
 *
 * Long-term memory with vector search for AI conversations, backed by
 * Redis Agent Memory.
 *
 * ## Backends
 *
 * - **cloud** (default): the managed Redis Agent Memory service. Requires
 *   `apiKey` and `storeId` (or the `AGENT_MEMORY_*` env fallbacks); memory
 *   extraction and summarization happen automatically, server-side, with no
 *   client configuration.
 * - **self-hosted**: the open-source `agent-memory-server`. Backwards
 *   compatible with existing `serverUrl`-only configs (auto-detected).
 *
 * `providers/factory.ts` picks the implementation from the resolved config so
 * the rest of this file stays backend-agnostic; see `provider.ts` for the
 * shared interface and capability flags.
 *
 * Features:
 * - Auto-recall: Semantic search for relevant long-term memories
 * - Auto-capture: Saves conversation to working memory for background extraction
 * - Manual tools: Store, search, and forget memories explicitly
 * - Extraction strategies (self-hosted only): configure how the self-hosted
 *   server extracts memories from conversations. The cloud backend always
 *   extracts automatically and ignores this setting.
 * - Summary views (self-hosted only): rolling summaries of long-term
 *   memories for stable context. Not available on the cloud backend.
 *
 * On self-hosted, the server handles memory extraction in the background,
 * keeping the client fast. On cloud, extraction happens server-side with no
 * client configuration at all.
 *
 * ## Memory Retrieval
 *
 * The plugin uses long-term memory search for auto-recall. Conversation
 * history is handled separately, so we only inject long-term memories - not
 * working memory (recent messages).
 *
 * ## Extraction Strategies (self-hosted only)
 *
 * Configure how the self-hosted server extracts memories from conversations.
 * The cloud backend (Redis Agent Memory) ignores this setting and always
 * extracts automatically, server-side.
 *
 * - **discrete** (default): Extract semantic and episodic memories
 * - **summary**: Maintain a running summary of the conversation
 * - **preferences**: Focus on extracting user preferences and settings
 * - **custom**: Use a custom extraction prompt for specialized use cases
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { memoryConfigSchema } from "./config.js";
import type { PluginApi, PluginDefinition } from "./types.js";
import { stringEnum } from "./types.js";
import { createProvider } from "./providers/factory.js";
import type { CapturedMessage } from "./provider.js";
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
  score?: number;
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
 * Convert messages to the backend-neutral CapturedMessage format.
 * Preserves original timestamps from pi-ai messages to enable deduplication.
 */
export function convertToMemoryMessages(messages: unknown[]): CapturedMessage[] {
  const result: CapturedMessage[] = [];

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
      timestampMs: msgTimestamp,
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
    const provider = createProvider(cfg, api.logger);

    // Whether this backend returns per-result similarity scores. Gates the
    // "(NN%)" recall suffix and score-based sorting/auto-delete below.
    // AMS (self-hosted): true; RAM (cloud): false.
    const showScores = provider.capabilities.similarityScores;

    const namespaceLabel = cfg.namespace ?? "default";
    if (cfg.provider === "cloud") {
      // Never log apiKey/bearerToken. storeId identifies the cloud tenant.
      api.logger.info?.(
        `redis-memory: plugin registered (backend: cloud, server: ${cfg.serverUrl}, storeId: ${cfg.storeId}, namespace: ${namespaceLabel})`,
      );
    } else {
      api.logger.info?.(
        `redis-memory: plugin registered (backend: self-hosted, server: ${cfg.serverUrl}, namespace: ${namespaceLabel})`,
      );
    }

    // One-time notice at registration (never per turn): the cloud backend
    // ignores extraction/summary-view options because Redis Agent Memory
    // extracts memories server-side. `cloudIgnoredOptions` is always [] for
    // self-hosted, so this branch never fires there.
    if (cfg.provider === "cloud" && cfg.cloudIgnoredOptions.length > 0) {
      api.logger.warn(
        "redis-memory: the following options are ignored on the cloud backend " +
          "(Redis Agent Memory extracts memories server-side; extraction and " +
          "summary-view options apply only to the self-hosted backend): " +
          cfg.cloudIgnoredOptions.join(", "),
      );
    }

    // ========================================================================
    // Scope helpers
    // ========================================================================

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

    async function searchScope(
      scope: ScopedMemoryTarget,
      query: string,
      limit: number,
    ): Promise<MemorySearchResult[]> {
      const results = await provider.searchLongTerm({
        text: query,
        limit,
        namespace: scope.namespace,
        userId: scope.userId,
        minScore: cfg.minScore,
      });

      return results.map((result) => ({
        id: result.id,
        text: result.text,
        // Pass the provider's score through unchanged: a real number for
        // score-bearing backends (AMS), undefined for scoreless ones (RAM).
        // Never coerce to 0 — that would fabricate a "0%" match.
        score: result.score,
        topics: result.topics,
        entities: result.entities,
        scope: scope.key,
        scopeLabel: scope.label,
      }));
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

              // Scoreless providers (RAM) return no per-result score: the
              // server-side similarityThreshold already ranked and filtered
              // the hits, so preserve server order within each scope and
              // concatenate scopes in plan order (flatMap yields plan order),
              // then apply the limit. Only score-bearing providers (AMS)
              // re-sort by score descending.
              const flattened = scopedResults.flatMap((entry) => entry.memories);
              const merged = (
                showScores
                  ? flattened.sort(
                      (left, right) => (right.score ?? 0) - (left.score ?? 0),
                    )
                  : flattened
              ).slice(0, limit);

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
                  // Show the "(NN%)" suffix only for score-bearing backends.
                  // Scoreless providers render just the numbered memory text
                  // (with the scope prefix when multi-scope).
                  const scoreSuffix =
                    showScores && typeof memory.score === "number"
                      ? ` (${(memory.score * 100).toFixed(0)}%)`
                      : "";
                  return `${index + 1}. ${prefix}${memory.text}${scoreSuffix}`;
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
              const dup = await provider.findDuplicate({
                text,
                namespace: targetScope.namespace,
                userId: targetScope.userId,
              });

              if (dup) {
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `Similar memory already exists in ${targetScope.label}: ` +
                        `"${dup.text}"`,
                    },
                  ],
                  details: {
                    action: "duplicate",
                    scope: targetScope.key,
                    existingId: dup.id,
                    existingText: dup.text,
                  },
                };
              }

              const { id: memoryId } = await provider.createLongTerm({
                text,
                topics: [inferredCategory],
                namespace: targetScope.namespace,
                userId: targetScope.userId,
              });

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
                    await provider.deleteLongTerm([memoryId], {
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
                const flattened = (
                  await Promise.all(
                    targetScopes.map((scope) => searchScope(scope, query, 5)),
                  )
                ).flat();
                // Same scoreless stable-order rule as memory_recall: never
                // sort by score for scoreless providers — a NaN comparator
                // from undefined scores would corrupt order. Server order
                // (already ranked by similarityThreshold) is preserved.
                const merged = showScores
                  ? flattened.sort(
                      (left, right) => (right.score ?? 0) - (left.score ?? 0),
                    )
                  : flattened;

                if (merged.length === 0) {
                  return {
                    content: [{ type: "text", text: "No matching memories found." }],
                    details: { found: 0 },
                  };
                }

                // For scoreless providers (RAM) the server-side
                // similarityThreshold already ran, so "exactly one hit" IS the
                // high-confidence signal. Score-bearing providers (AMS) keep
                // the >0.9 gate to avoid auto-deleting a weak single match.
                if (
                  merged.length === 1 &&
                  (!showScores || (merged[0].score ?? 0) > 0.9)
                ) {
                  const winningScope = targetScopes.find(
                    (scope) => scope.key === merged[0].scope,
                  ) ?? plan.defaultStoreScope;
                  await provider.deleteLongTerm([merged[0].id], {
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
            const checkpoint = await provider.getCaptureCheckpoint(workingMemorySessionId, {
              namespace: scope.namespace,
              userId: scope.userId,
            });
            if (checkpoint > 0) {
              sessionMaxTimestamps.set(trackingKey, checkpoint);
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

          if (provider.capabilities.summaryViews && provider.summaries) {
            const part = await provider.summaries.getSummaryPartition(scope);
            if (part) {
              scopedContextParts.push(
                `<user-summary computed="${part.computedAt ?? "unknown"}" memories="${part.memoryCount}">\n${part.summary}\n</user-summary>`,
              );
              api.logger.info?.(
                `redis-memory: injecting summary for scope "${scope.key}" (${part.memoryCount} memories)`,
              );
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
            const newMessages = allMemoryMessages.filter(
              (message) => message.timestampMs > cutoffTs,
            );

            sessionMaxTimestamps.delete(trackingKey);

            if (newMessages.length === 0) {
              continue;
            }

            await provider.captureMessages(workingMemorySessionId, newMessages, {
              namespace: scope.namespace,
              userId: scope.userId,
              extractionStrategy: scope.extractionStrategy,
              customPrompt: scope.customPrompt,
            });

            if (provider.capabilities.summaryViews) {
              await provider.summaries?.refreshView(scope);
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
          await provider.healthCheck();
          api.logger.info?.(
            `redis-memory: connected to server (${cfg.serverUrl}, namespace: ${cfg.namespace ?? "default"})`,
          );

          if (provider.capabilities.summaryViews) {
            for (const scope of getConfiguredScopes(cfg)) {
              await provider.summaries?.ensureView(scope);
            }
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
