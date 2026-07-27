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
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { memoryConfigSchema } from "./config.js";
import type { PluginApi, PluginDefinition } from "./types.js";
import { stringEnum } from "./types.js";
import { createProvider } from "./providers/factory.js";
import type { CapturedMessage } from "./provider.js";
import { CaptureCoordinator } from "./capture.js";
import { applyCapturePrivacy } from "./privacy.js";
import { frameUntrustedMemories, type UntrustedMemoryRecord } from "./trust.js";
import { distributeBudget, mapWithConcurrency } from "./bounded.js";
import {
  CONFIG_KEY_PATTERN,
  MAX_IDENTIFIER_CHARS,
  MAX_MEMORY_TEXT_CHARS,
  MAX_RECALL_LIMIT,
  MAX_SEARCH_TEXT_CHARS,
  SERVICE_IDENTIFIER_PATTERN,
  assertIntegerInRange,
  assertMemoryText,
  assertSearchText,
  assertServiceIdentifier,
  normalizeExternalMessageId,
  safeErrorMessage,
} from "./validation.js";
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
    if (!CONFIG_KEY_PATTERN.test(agentId) || agentId.length > MAX_IDENTIFIER_CHARS) {
      return null;
    }

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
const MAX_TOOL_OUTPUT_CHARS = 32_000;
const MAX_TOOL_RECORD_TEXT_CHARS = 2_000;
const MAX_SCOPED_SEARCH_CONCURRENCY = 4;

type MemorySearchResult = {
  id: string;
  text: string;
  score?: number;
  category?: string;
  topics?: string[];
  entities?: string[];
  scope?: string;
  scopeLabel?: string;
  memoryType?: string;
  source?: string;
};

function truncateVisibleText(value: string, maximum: number): string {
  const marker = "\n[truncated]";
  return value.length <= maximum
    ? value
    : value.slice(0, Math.max(0, maximum - marker.length)) + marker;
}

function boundToolMemories(memories: MemorySearchResult[]): MemorySearchResult[] {
  const perRecord = Math.max(
    128,
    Math.min(
      MAX_TOOL_RECORD_TEXT_CHARS,
      Math.floor((MAX_TOOL_OUTPUT_CHARS - 12_000) / Math.max(1, memories.length)),
    ),
  );
  return memories.map((memory) => ({
    id: memory.id,
    text: truncateVisibleText(memory.text, perRecord),
    score: memory.score,
    scope: memory.scope,
    scopeLabel: memory.scopeLabel,
  }));
}

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
  const syntheticOccurrences = new Map<string, number>();
  let lastTimestampMs = 1577836800000; // Stable fallback base: 2020-01-01 UTC.

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;

    const role = msgObj.role;
    if (typeof role !== "string") continue;

    // Only include user and assistant messages
    if (role !== "user" && role !== "assistant") continue;

    const content = extractTextContent(msgObj.content);
    if (!content.trim()) continue;

    // Skip both legacy and current injected memory context.
    if (
      content.includes("<relevant-memories>") ||
      content.includes("<untrusted-memory-context")
    ) continue;

    // Missing transport fields must be stable across repeated hook delivery
    // and process restarts. A transcript-derived occurrence id distinguishes
    // repeated identical messages without depending on wall-clock time.
    const identitySeed = JSON.stringify([role, content]);
    const occurrence = syntheticOccurrences.get(identitySeed) ?? 0;
    syntheticOccurrences.set(identitySeed, occurrence + 1);
    const id = normalizeExternalMessageId(
      msgObj.id,
      JSON.stringify([role, content, occurrence]),
    );

    const hasTimestamp =
      typeof msgObj.timestamp === "number" &&
      Number.isFinite(msgObj.timestamp) &&
      Number.isInteger(msgObj.timestamp) &&
      msgObj.timestamp >= 0 &&
      msgObj.timestamp <= 8_640_000_000_000_000;
    const msgTimestamp = hasTimestamp ? msgObj.timestamp as number : lastTimestampMs + 1;
    lastTimestampMs = msgTimestamp;

    result.push({
      role,
      content,
      id,
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
      api.logger.info?.(
        `redis-memory: plugin registered (backend: cloud, server: ${cfg.serverUrl}, namespace: ${JSON.stringify(namespaceLabel)})`,
      );
    } else {
      api.logger.info?.(
        `redis-memory: plugin registered (backend: self-hosted, server: ${cfg.serverUrl}, namespace: ${JSON.stringify(namespaceLabel)})`,
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

    const captureCoordinator = new CaptureCoordinator(provider, api.logger);
    const erasingScopes = new Set<string>();
    const sensitiveValues = [cfg.apiKey, cfg.bearerToken];

    function reportFailure(operation: string, error: unknown): void {
      api.logger.warn(`redis-memory: ${operation} failed: ${safeErrorMessage(error, sensitiveValues)}`);
    }

    function buildTrackingKey(scope: ScopedMemoryTarget, workingMemorySessionId: string): string {
      return `${scope.key}::${workingMemorySessionId}`;
    }

    function getWorkingMemorySessionId(
      sessionKey: string,
      scope: ScopedMemoryTarget,
    ): string {
      let sessionIdentity: string;
      if (scope.workingMemorySessionId) {
        sessionIdentity = scope.workingMemorySessionId;
      } else {
        const sessionId = readSessionIdFromStore(sessionKey);
        sessionIdentity = sessionId ? `${sessionKey}:${sessionId}` : sessionKey;
      }

      return provider.deriveCaptureSessionId(sessionIdentity, scope);
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
        key: scope.key,
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
        memoryType: result.memoryType,
        source: result.source,
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
          query: Type.String({
            description: "Search query",
            minLength: 1,
            maxLength: MAX_SEARCH_TEXT_CHARS,
          }),
          limit: Type.Optional(Type.Integer({
            description: "Max results (default: 5)",
            minimum: 1,
            maximum: MAX_RECALL_LIMIT,
          })),
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
            const input =
              params && typeof params === "object" && !Array.isArray(params)
                ? params as Record<string, unknown>
                : {};
            const { query, limit = 5, scope: scopeKey } = input as {
              query: string;
              limit?: number;
              scope?: string;
            };

            try {
              assertSearchText(query, "query");
              assertIntegerInRange(limit, "limit", 1, MAX_RECALL_LIMIT);
              if (scopeKey !== undefined && typeof scopeKey !== "string") {
                throw new Error("scope must be a string");
              }
              const targetScopes = scopeKey
                ? [resolveSelectedScope(scopeKey, plan.recallScopes, plan.defaultStoreScope)]
                : plan.recallScopes;

              // Divide one global result budget across scopes. This keeps a
              // 32-scope configuration from fetching and buffering 32 times
              // the requested limit, while bounded fan-out avoids a burst of
              // simultaneous backend requests.
              const retrievalBudget = Math.min(
                MAX_RECALL_LIMIT,
                Math.max(limit, targetScopes.length),
              );
              const quotas = distributeBudget(retrievalBudget, targetScopes.length);
              const searchableScopes = targetScopes
                .map((scope, index) => ({ scope, limit: quotas[index] }))
                .filter((entry) => entry.limit > 0);
              const scopedResults = await mapWithConcurrency(
                searchableScopes,
                MAX_SCOPED_SEARCH_CONCURRENCY,
                async ({ scope, limit: scopeLimit }) => ({
                  scope,
                  memories: await searchScope(scope, query, scopeLimit),
                }),
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

              const boundedMemories = boundToolMemories(merged);
              const text = boundedMemories
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
                content: [{
                  type: "text",
                  text: truncateVisibleText(
                    `Found ${boundedMemories.length} memories:\n\n${text}`,
                    MAX_TOOL_OUTPUT_CHARS,
                  ),
                }],
                details: { count: boundedMemories.length, memories: boundedMemories },
              };
            } catch (err) {
              reportFailure("recall", err);
              return {
                content: [{ type: "text", text: "Memory search failed." }],
                details: { error: "backend_error" },
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
          text: Type.String({
            description: "Information to remember",
            minLength: 1,
            maxLength: MAX_MEMORY_TEXT_CHARS,
          }),
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
            const input =
              params && typeof params === "object" && !Array.isArray(params)
                ? params as Record<string, unknown>
                : {};
            const { text, category, scope: scopeKey } = input as {
              text: string;
              category?: MemoryCategory;
              scope?: string;
            };

            if (typeof text !== "string" || !text.trim()) {
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
              assertMemoryText(text, "text");
              if (category !== undefined && !MEMORY_CATEGORIES.includes(category)) {
                throw new Error("category is invalid");
              }
              if (scopeKey !== undefined && typeof scopeKey !== "string") {
                throw new Error("scope must be a string");
              }
              const targetScope = resolveSelectedScope(
                scopeKey,
                plan.toolScopes,
                plan.defaultStoreScope,
              );
              const inferredCategory = category ?? detectCategory(text);
              const dup = await provider.findDuplicate({
                text,
                key: targetScope.key,
                namespace: targetScope.namespace,
                userId: targetScope.userId,
              });

              if (dup) {
                const duplicateText = truncateVisibleText(
                  dup.text,
                  MAX_TOOL_RECORD_TEXT_CHARS,
                );
                return {
                  content: [
                    {
                      type: "text",
                      text:
                        `Similar memory already exists in ${targetScope.label}: ` +
                        `"${duplicateText}"`,
                    },
                  ],
                  details: {
                    action: "duplicate",
                    scope: targetScope.key,
                    existingId: dup.id,
                    existingText: duplicateText,
                  },
                };
              }

              const { id: memoryId } = await provider.createLongTerm({
                text,
                topics: [inferredCategory],
                key: targetScope.key,
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
              reportFailure("store", err);
              return {
                content: [{ type: "text", text: "Memory store failed." }],
                details: { error: "backend_error" },
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
          query: Type.Optional(Type.String({
            description: "Search to find memory",
            minLength: 1,
            maxLength: MAX_SEARCH_TEXT_CHARS,
          })),
          memoryId: Type.Optional(Type.String({
            description: "Specific memory ID",
            minLength: 1,
            maxLength: MAX_IDENTIFIER_CHARS,
            pattern: SERVICE_IDENTIFIER_PATTERN.source,
          })),
        };
        if (scopeKeys.length > 1) {
          parameters.scope = Type.Optional(
            stringEnum(scopeKeys, {
              description: "Memory boundary; required when deleting by ID",
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
            const input =
              params && typeof params === "object" && !Array.isArray(params)
                ? params as Record<string, unknown>
                : {};
            const { query, memoryId, scope: scopeKey } = input as {
              query?: string;
              memoryId?: string;
              scope?: string;
            };

            try {
              if (query !== undefined) assertSearchText(query, "query");
              if (memoryId !== undefined) assertServiceIdentifier(memoryId, "memoryId");
              if (scopeKey !== undefined && typeof scopeKey !== "string") {
                throw new Error("scope must be a string");
              }
              if (memoryId && scopeKeys.length > 1 && !scopeKey) {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Choose a scope before deleting a memory by ID.",
                    },
                  ],
                  details: { action: "scope_required", id: memoryId },
                };
              }

              const targetScopes = scopeKey
                ? [resolveSelectedScope(scopeKey, plan.toolScopes, plan.defaultStoreScope)]
                : plan.toolScopes;

              if (memoryId) {
                const [scope] = targetScopes;
                const outcome = await provider.deleteLongTerm([memoryId], {
                  key: scope.key,
                  namespace: scope.namespace,
                  userId: scope.userId,
                });

                if (outcome.deletedIds.includes(memoryId)) {
                  api.logger.info?.(
                    `redis-memory: forget action=deleted id=${JSON.stringify(memoryId)} scope=${JSON.stringify(scope.key)}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Memory ${memoryId} forgotten from ${scope.label}.`,
                      },
                    ],
                    details: { action: "deleted", id: memoryId, scope: scope.key },
                  };
                }

                if (outcome.forbiddenIds.includes(memoryId)) {
                  api.logger.warn(
                    `redis-memory: forget action=forbidden id=${JSON.stringify(memoryId)} scope=${JSON.stringify(scope.key)}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Memory ${memoryId} is outside the selected scope.`,
                      },
                    ],
                    details: { action: "forbidden", id: memoryId, scope: scope.key },
                  };
                }

                if (outcome.notFoundIds.includes(memoryId)) {
                  api.logger.info?.(
                    `redis-memory: forget action=not_found id=${JSON.stringify(memoryId)} scope=${JSON.stringify(scope.key)}`,
                  );
                  return {
                    content: [{ type: "text", text: `Memory ${memoryId} was not found.` }],
                    details: { action: "not_found", id: memoryId, scope: scope.key },
                  };
                }

                api.logger.warn(
                  `redis-memory: forget action=failed id=${JSON.stringify(memoryId)} scope=${JSON.stringify(scope.key)}`,
                );
                return {
                  content: [{ type: "text", text: `Memory ${memoryId} could not be deleted.` }],
                  details: { action: "failed", id: memoryId, scope: scope.key },
                };
              }

              if (query) {
                const forgetBudget = Math.min(
                  MAX_RECALL_LIMIT,
                  Math.max(5, targetScopes.length),
                );
                const quotas = distributeBudget(forgetBudget, targetScopes.length);
                const searchableScopes = targetScopes
                  .map((scope, index) => ({ scope, limit: quotas[index] }))
                  .filter((entry) => entry.limit > 0);
                const flattened = (
                  await mapWithConcurrency(
                    searchableScopes,
                    MAX_SCOPED_SEARCH_CONCURRENCY,
                    ({ scope, limit }) => searchScope(scope, query, limit),
                  )
                ).flat();
                // Same scoreless stable-order rule as memory_recall: never
                // sort by score for scoreless providers — a NaN comparator
                // from undefined scores would corrupt order. Server order
                // (already ranked by similarityThreshold) is preserved.
                const merged = showScores
                  ? flattened.sort(
                      (left, right) => (right.score ?? 0) - (left.score ?? 0),
                    ).slice(0, MAX_RECALL_LIMIT)
                  : flattened.slice(0, MAX_RECALL_LIMIT);

                if (merged.length === 0) {
                  return {
                    content: [{ type: "text", text: "No matching memories found." }],
                    details: { found: 0 },
                  };
                }

                // Only an actual score can justify automatic query deletion.
                // Scoreless RAM results always require exact-ID confirmation.
                if (merged.length === 1 && showScores && (merged[0].score ?? 0) > 0.9) {
                  const winningScope = targetScopes.find(
                    (scope) => scope.key === merged[0].scope,
                  ) ?? plan.defaultStoreScope;
                  const outcome = await provider.deleteLongTerm([merged[0].id], {
                    key: winningScope.key,
                    namespace: winningScope.namespace,
                    userId: winningScope.userId,
                  });

                  if (!outcome.deletedIds.includes(merged[0].id)) {
                    const action = outcome.forbiddenIds.includes(merged[0].id)
                      ? "forbidden"
                      : outcome.notFoundIds.includes(merged[0].id)
                        ? "not_found"
                        : "failed";
                    api.logger.warn(
                      `redis-memory: forget action=${action} id=${JSON.stringify(merged[0].id)} scope=${JSON.stringify(winningScope.key)}`,
                    );
                    return {
                      content: [
                        {
                          type: "text",
                          text: `Memory ${merged[0].id} could not be deleted from ${winningScope.label}.`,
                        },
                      ],
                      details: {
                        action,
                        id: merged[0].id,
                        scope: winningScope.key,
                      },
                    };
                  }

                  api.logger.info?.(
                    `redis-memory: forget action=deleted id=${JSON.stringify(merged[0].id)} scope=${JSON.stringify(winningScope.key)}`,
                  );
                  return {
                    content: [
                      {
                        type: "text",
                        text: `Forgotten from ${winningScope.label}: "${truncateVisibleText(merged[0].text, MAX_TOOL_RECORD_TEXT_CHARS)}"`,
                      },
                    ],
                    details: {
                      action: "deleted",
                      id: merged[0].id,
                      scope: winningScope.key,
                    },
                  };
                }

                const candidates = boundToolMemories(merged).map((result) => ({
                  id: result.id,
                  text: result.text,
                  score: result.score,
                  scope: result.scope,
                  scopeLabel: result.scopeLabel,
                }));
                const list = candidates
                  .map((result) => {
                    const scopeLabel = result.scopeLabel ?? result.scope ?? "unknown";
                    return `- [${result.id.slice(0, 8)}] [${scopeLabel}] ${result.text.slice(0, 60)}...`;
                  })
                  .join("\n");

                return {
                  content: [
                    {
                      type: "text",
                      text: truncateVisibleText(
                        `Found ${candidates.length} candidates. Specify memoryId${scopeKeys.length > 1 ? " and scope" : ""}:\n${list}`,
                        MAX_TOOL_OUTPUT_CHARS,
                      ),
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
              reportFailure("forget", err);
              return {
                content: [{ type: "text", text: "Memory forget failed." }],
                details: { error: "backend_error" },
              };
            }
          },
        };
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      (toolCtx) => {
        const plan = getToolPlan({
          agentId: toolCtx.agentId,
          sessionKey: toolCtx.sessionKey,
        });
        const scopeKeys = plan.toolScopes.map((scope) => scope.key);
        return {
          name: "memory_erase_scope",
          label: "Memory Scope Erasure",
          description:
            "Perform the strongest backend-supported best-effort erasure for one authorized memory scope. " +
            "This does not certify deletion from backups, external writers, or upstream retention systems.",
          parameters: Type.Object({
            scope: stringEnum(scopeKeys, {
              description: "Exact authorized memory scope to erase",
            }),
            confirm: Type.String({
              description: 'Must exactly equal "ERASE <scope>"',
              minLength: 7,
              maxLength: MAX_IDENTIFIER_CHARS + 6,
            }),
          }),
          async execute(_toolCallId, params) {
            const input = params && typeof params === "object" && !Array.isArray(params)
              ? params as Record<string, unknown>
              : {};
            const scopeKey = typeof input.scope === "string" ? input.scope : undefined;
            const confirm = typeof input.confirm === "string" ? input.confirm : undefined;
            if (!scopeKey || !scopeKeys.includes(scopeKey)) {
              return {
                content: [{ type: "text", text: "Choose an authorized scope to erase." }],
                details: { status: "failed", residuals: ["scope_not_authorized"] },
              };
            }
            if (confirm !== `ERASE ${scopeKey}`) {
              return {
                content: [{ type: "text", text: `Confirmation must exactly match ERASE ${scopeKey}.` }],
                details: { status: "failed", scope: scopeKey, residuals: ["confirmation_required"] },
              };
            }

            const scope = resolveSelectedScope(scopeKey, plan.toolScopes, plan.defaultStoreScope);
            erasingScopes.add(scope.key);
            try {
              const drained = await captureCoordinator.waitForScope(scope.key, 5_000);
              if (!drained) {
                api.logger.warn(
                  `redis-memory: erasure status=failed scope=${JSON.stringify(scope.key)} reason=capture_drain_timeout`,
                );
                return {
                  content: [{ type: "text", text: `Erasure did not start for ${scope.label}; capture did not quiesce.` }],
                  details: {
                    status: "failed",
                    scope: scope.key,
                    residuals: ["capture_drain_timeout"],
                  },
                };
              }

              const result = await provider.eraseScope(
                { key: scope.key, namespace: scope.namespace, userId: scope.userId },
                { settleMs: cfg.erasureSettleMs, maxRecords: 10_000 },
              );
              api.logger.info?.(
                `redis-memory: erasure status=${result.status} scope=${JSON.stringify(scope.key)} ` +
                `memory_ids=${result.memoryIds.length} session_ids=${result.sessionIds.length} ` +
                `failed_memory_ids=${result.failedMemoryIds.length} failed_session_ids=${result.failedSessionIds.length}`,
              );
              return {
                content: [{
                  type: "text",
                  text:
                    `Scope erasure status: ${result.status}. ` +
                    `Long-term records found: ${result.memoryIds.length}; sessions found: ${result.sessionIds.length}; ` +
                    `remaining: ${result.remainingMemoryIds.length + result.remainingSessionIds.length}.`,
                }],
                details: result,
              };
            } catch {
              api.logger.warn(
                `redis-memory: erasure status=failed scope=${JSON.stringify(scope.key)} reason=backend_error`,
              );
              return {
                content: [{ type: "text", text: `Scope erasure failed for ${scope.label}.` }],
                details: { status: "failed", scope: scope.key, residuals: ["backend_error"] },
              };
            } finally {
              erasingScopes.delete(scope.key);
            }
          },
        };
      },
      { name: "memory_erase_scope" },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Named scopes may opt into auto-recall/-capture even when the top-level
    // default is off, so register each hook when the global flag OR any
    // configured scope enables it; the per-scope flag inside each hook stays
    // the authoritative switch. For legacy single-scope configs the scope
    // inherits the global flag, so this is a no-op there.
    const configuredScopes = getConfiguredScopes(cfg);
    const anyScopeAutoRecall = configuredScopes.some((scope) => scope.autoRecall);
    const anyScopeAutoCapture = configuredScopes.some((scope) => scope.autoCapture);

    // Auto-recall: inject rolling summary + query-specific memories as one
    // structurally encoded, explicitly untrusted data envelope.
    if (cfg.autoRecall || anyScopeAutoRecall) {
      api.on("before_prompt_build", async (event, ctx) => {
        const e = event as { prompt?: string };
        if (!e.prompt || e.prompt.length < 5) return;

        const sessionKey = ctx?.sessionKey ?? "default";
        const plan = resolveAgentScopePlan(cfg, {
          agentId: ctx?.agentId,
          sessionKey,
        });

        const enabledScopes = plan.recallScopes.filter((scope) => scope.autoRecall);
        const records: UntrustedMemoryRecord[] = [];
        const searchQuery = stripEnvelopeForSearch(e.prompt).slice(0, MAX_SEARCH_TEXT_CHARS);
        const recordBudget = Math.min(
          MAX_RECALL_LIMIT,
          enabledScopes.length + (cfg.recallLimit ?? 3),
        );
        if (provider.capabilities.summaryViews && provider.summaries) {
          const summaries = await mapWithConcurrency(
            enabledScopes,
            MAX_SCOPED_SEARCH_CONCURRENCY,
            async (scope) => {
              try {
                const part = await provider.summaries!.getSummaryPartition(scope);
                if (part) {
                  api.logger.info?.(
                    `redis-memory: recalled summary scope=${JSON.stringify(scope.key)} memories=${part.memoryCount}`,
                  );
                }
                return part
                  ? {
                      kind: "summary" as const,
                      scope: scope.key,
                      id: `summary-${scope.key}`,
                      memoryType: "aggregate",
                      source: "summary-view",
                      content: part.summary,
                    }
                  : undefined;
              } catch (err) {
                api.logger.warn(
                  `redis-memory: summary recall failed scope=${JSON.stringify(scope.key)}: ${safeErrorMessage(err, sensitiveValues)}`,
                );
                return undefined;
              }
            },
          );
          records.push(
            ...summaries.flatMap((record) => record ? [record] : [])
              .slice(0, recordBudget),
          );
        }

        const semanticBudget = Math.max(0, recordBudget - records.length);
        if (searchQuery && searchQuery.length >= 5 && semanticBudget > 0) {
          const quotas = distributeBudget(semanticBudget, enabledScopes.length);
          const searchableScopes = enabledScopes
            .map((scope, index) => ({
              scope,
              limit: Math.min(cfg.recallLimit ?? 3, quotas[index]),
            }))
            .filter((entry) => entry.limit > 0);
          const recalled = await mapWithConcurrency(
            searchableScopes,
            MAX_SCOPED_SEARCH_CONCURRENCY,
            async ({ scope, limit }) => {
              try {
                const filtered = await searchScope(scope, searchQuery, limit);
                if (filtered.length > 0) {
                  api.logger.info?.(
                    `redis-memory: recalled memories scope=${JSON.stringify(scope.key)} count=${filtered.length}`,
                  );
                }
                return filtered.map((memory) => ({
                  kind: "memory" as const,
                  scope: scope.key,
                  id: memory.id,
                  memoryType: memory.memoryType,
                  source: memory.source ?? "unknown",
                  content: memory.text,
                }));
              } catch (err) {
                api.logger.warn(
                  `redis-memory: semantic search failed for scope "${scope.key}": ${safeErrorMessage(err, sensitiveValues)}`,
                );
                return [];
              }
            },
          );
          records.push(...recalled.flat().slice(0, semanticBudget));
        }
        const prependContext = frameUntrustedMemories(records, {
          maxRecords: recordBudget,
          maxRecordChars: cfg.recallRecordMaxChars,
          maxTotalChars: cfg.recallContextMaxChars,
        });
        return prependContext ? { prependContext } : undefined;
      });
    }

    // Auto-capture: save conversation to working memory for background extraction
    if (cfg.autoCapture || anyScopeAutoCapture) {
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
            if (!scope.autoCapture || erasingScopes.has(scope.key)) continue;
            const memoryMessages = applyCapturePrivacy(allMemoryMessages, {
              assistantCapture: scope.assistantCapture,
              sensitiveDataRedaction: scope.sensitiveDataRedaction,
            });
            if (memoryMessages.length === 0) continue;
            const workingMemorySessionId = getWorkingMemorySessionId(sessionKey, scope);
            const trackingKey = buildTrackingKey(scope, workingMemorySessionId);
            const result = await captureCoordinator.capture({
              trackingKey,
              sessionId: workingMemorySessionId,
              messages: memoryMessages,
              scope: {
                key: scope.key,
                namespace: scope.namespace,
                userId: scope.userId,
                extractionStrategy: scope.extractionStrategy,
                customPrompt: scope.customPrompt,
                sessionRetentionSeconds: scope.sessionRetentionSeconds,
              },
              canWrite: () => !erasingScopes.has(scope.key),
            });

            if (result.acceptedMessageIds.length > 0 && provider.capabilities.summaryViews) {
              await provider.summaries?.refreshView(scope);
            }
          }
        } catch (err) {
          reportFailure("capture", err);
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
            `redis-memory: connected to server (${cfg.serverUrl}, namespace: ${JSON.stringify(cfg.namespace ?? "default")})`,
          );

          if (provider.capabilities.summaryViews) {
            for (const scope of getConfiguredScopes(cfg)) {
              await provider.summaries?.ensureView(scope);
            }
          }
        } catch (err) {
          api.logger.warn(
            `redis-memory: server not reachable at ${cfg.serverUrl}: ${safeErrorMessage(err, sensitiveValues)}`,
          );
        }
      },
      stop: async () => {
        await captureCoordinator.drain(5000);
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
