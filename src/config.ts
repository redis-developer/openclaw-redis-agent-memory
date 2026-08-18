/**
 * Configuration schema and parsing for the agent-memory-plugin.
 */

import {
  CONFIG_KEY_PATTERN,
  MAX_AGENT_ROUTES,
  MAX_CONFIG_SCOPES,
  MAX_CUSTOM_PROMPT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_IDENTIFIER_CHARS,
  MAX_RECALL_LIMIT,
  MAX_ROUTE_SCOPES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  assertBoundedString,
  assertGenericIdentifier,
  assertIntegerInRange,
  assertNumberInRange,
  assertServiceIdentifier,
  validateServerUrl,
} from "./validation.js";
import type { AssistantCapturePolicy } from "./privacy.js";

/**
 * Memory extraction strategy types.
 *
 * - "discrete": Extract semantic and episodic memories (default)
 * - "summary": Extract a running summary of the conversation
 * - "preferences": Extract user preferences and settings
 * - "custom": Use a custom extraction prompt
 */
export type MemoryStrategy = "discrete" | "summary" | "preferences" | "custom";

/**
 * Fields that can be used for grouping in summary views.
 */
export type SummaryGroupByField = "user_id" | "namespace";

/**
 * Resolved backend provider for a parsed `MemoryConfig`.
 *
 * - "cloud": Redis Agent Memory (RAM), the managed cloud service. Default
 *   for new installs.
 * - "self-hosted": the open-source agent-memory-server (AMS).
 */
export type MemoryProviderKind = "cloud" | "self-hosted";

export type MemoryScopeConfig = {
  label?: string;
  namespace?: string;
  userId?: string;
  workingMemorySessionId?: string;
  extractionStrategy?: MemoryStrategy;
  customPrompt?: string;
  summaryViewName?: string;
  summaryTimeWindowDays?: number;
  summaryGroupBy?: SummaryGroupByField[];
  autoRecall?: boolean;
  autoCapture?: boolean;
  assistantCapture?: AssistantCapturePolicy;
  sensitiveDataRedaction?: boolean;
  sessionRetentionSeconds?: number;
};

export type AgentMemoryRoute = {
  primaryScope: string;
  recallScopes?: string[];
  captureScopes?: string[];
  toolScopes?: string[];
  defaultStoreScope?: string;
};

export type MemoryConfig = {
  /**
   * Resolved backend provider. Optional in input; always set (never
   * undefined) once a config has been parsed. "cloud" (Redis Agent Memory)
   * is the default backend; "self-hosted" (agent-memory-server) is resolved
   * for legacy configs and when explicitly requested. See
   * `parseMemoryConfig` for the resolution algorithm.
   */
  provider: MemoryProviderKind;
  /**
   * Base URL of the backend. For provider "cloud" this is the RAM cloud
   * endpoint (falls back to AGENT_MEMORY_ENDPOINT); for "self-hosted" this
   * is the agent-memory-server URL (e.g., 'http://localhost:8000', the
   * default when unset).
   */
  serverUrl: string;
  /**
   * API key for authentication. Required for provider "cloud" (sent as the
   * RAM bearer token; falls back to AGENT_MEMORY_API_KEY). Optional for
   * "self-hosted".
   */
  apiKey?: string;
  /** Optional bearer token for authentication (self-hosted only) */
  bearerToken?: string;
  /**
   * RAM store id (cloud provider only). Supports `${VAR}` substitution like
   * every other string field; falls back to AGENT_MEMORY_STORE_ID.
   */
  storeId?: string;
  /** Namespace for organizing memories (default: "default") */
  namespace?: string;
  /** User ID for memory isolation (default: "default") */
  userId?: string;
  /**
   * Working memory session ID override.
   * If set, uses this fixed session ID instead of deriving from OpenClaw session.
   * Useful for maintaining a single continuous working memory across sessions.
   */
  workingMemorySessionId?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Enable auto-capture of important information from conversations */
  autoCapture?: boolean;
  /** Enable auto-recall of relevant memories before agent starts */
  autoRecall?: boolean;
  /** Minimum similarity score for recall (0-1, default: 0.3) */
  minScore?: number;
  /** Maximum number of memories to recall (default: 3) */
  recallLimit?: number;
  /** Maximum characters in one automatically injected record. */
  recallRecordMaxChars: number;
  /** Maximum characters in the complete automatically injected envelope. */
  recallContextMaxChars: number;
  /** Capture assistant output as well as user messages (default: exclude). */
  assistantCapture: AssistantCapturePolicy;
  /** Apply best-effort sensitive-data pattern redaction before capture. */
  sensitiveDataRedaction: boolean;
  /**
   * Await the backend health check (and summary-view ensures) during service
   * start (default: true). When false they run in the background so hosts
   * that gate readiness on service start are not blocked by the network
   * round-trips; failures still surface as log warnings and per-call tool
   * errors.
   */
  eagerStartupCheck: boolean;
  /** Self-hosted working-memory TTL. Unsupported by RAM cloud. */
  sessionRetentionSeconds?: number;
  /** Delay between destructive erasure sweeps. */
  erasureSettleMs: number;
  /** Memory extraction strategy for background processing */
  extractionStrategy?: MemoryStrategy;
  /** Custom extraction prompt (only used when extractionStrategy is "custom") */
  customPrompt?: string;
  /** Name for the summary view (default: "agent_user_summary") */
  summaryViewName?: string;
  /** Rolling time window in days for the summary view (default: 30) */
  summaryTimeWindowDays?: number;
  /** Fields to group by in the summary view (default: ["user_id"]) */
  summaryGroupBy?: SummaryGroupByField[];
  /** Custom description for the memory_recall tool */
  recallDescription?: string;
  /** Custom description for the memory_store tool */
  storeDescription?: string;
  /** Custom description for the memory_forget tool */
  forgetDescription?: string;
  /** Optional named memory boundaries for multi-agent setups */
  scopes?: Record<string, MemoryScopeConfig>;
  /** Optional routing from OpenClaw agent id to named scopes */
  agentScopes?: Record<string, AgentMemoryRoute>;
  /**
   * Output-only. Cloud-incompatible options (`extractionStrategy`,
   * `customPrompt`, `summaryViewName`, `summaryTimeWindowDays`,
   * `summaryGroupBy`) the user explicitly set (top-level or inside any
   * scope) that the cloud provider ignores. Always `[]` for self-hosted.
   * Not a valid input key — an input config containing `cloudIgnoredOptions`
   * is rejected as unknown.
   */
  cloudIgnoredOptions: string[];
};

export const DEFAULT_SERVER_URL = "http://localhost:8000";
export const DEFAULT_TIMEOUT = 30000;
export const DEFAULT_MIN_SCORE = 0.3;
export const DEFAULT_RECALL_LIMIT = 3;
export const DEFAULT_RECALL_RECORD_MAX_CHARS = 2_000;
export const DEFAULT_RECALL_CONTEXT_MAX_CHARS = 16_000;
export const DEFAULT_ERASURE_SETTLE_MS = 2_000;
export const DEFAULT_NAMESPACE = "default";
export const USER_ID_PLACEHOLDER = "user-123";
export const DEFAULT_SUMMARY_VIEW_NAME = "agent_user_summary";
export const DEFAULT_SUMMARY_TIME_WINDOW_DAYS = 30;
export const DEFAULT_SUMMARY_GROUP_BY: SummaryGroupByField[] = ["user_id"];
export const DEFAULT_RECALL_DESCRIPTION =
  "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.";
export const DEFAULT_STORE_DESCRIPTION =
  "Save important information in long-term memory. Use for preferences, facts, decisions.";
export const DEFAULT_FORGET_DESCRIPTION = "Delete a specific memory from an authorized scope.";

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function sanitizeScopeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "default";
}

function resolveOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? resolveEnvVars(value) : undefined;
}

function resolveOptionalSessionIdentity(
  value: unknown,
  label: string,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const resolved = resolveEnvVars(value);
  if (!resolved.trim()) throw new Error(`${label} must not be empty`);
  if (resolved !== resolved.trim()) throw new Error(`${label} must not have surrounding whitespace`);
  assertGenericIdentifier(resolved, label);
  return resolved;
}

function parseStringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_ROUTE_SCOPES) {
    throw new Error(`${label} must contain at most ${MAX_ROUTE_SCOPES} scopes`);
  }
  const parsed = value.map((entry, index) => {
    assertBoundedString(entry, `${label}[${index}]`, {
      min: 1,
      max: MAX_IDENTIFIER_CHARS,
      pattern: CONFIG_KEY_PATTERN,
    });
    return entry;
  });
  return parsed.length > 0 ? parsed : undefined;
}

function parseSummaryGroupBy(
  value: unknown,
  fallback: SummaryGroupByField[],
): SummaryGroupByField[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new Error("summaryGroupBy must be an array");

  const validFields: SummaryGroupByField[] = ["user_id", "namespace"];
  if (value.length === 0 || value.length > validFields.length) {
    throw new Error("summaryGroupBy must contain one or two supported fields");
  }
  const parsed = value.map((field) => {
    if (typeof field !== "string" || !validFields.includes(field as SummaryGroupByField)) {
      throw new Error("summaryGroupBy entries must be user_id or namespace");
    }
    return field as SummaryGroupByField;
  });

  return [...new Set(parsed)];
}

function parseScopeConfig(
  key: string,
  value: unknown,
  defaults: {
    namespace?: string;
    userId?: string;
    workingMemorySessionId?: string;
    extractionStrategy?: MemoryStrategy;
    customPrompt?: string;
    summaryViewName: string;
    summaryTimeWindowDays: number;
    summaryGroupBy: SummaryGroupByField[];
    autoRecall: boolean;
    autoCapture: boolean;
    assistantCapture: AssistantCapturePolicy;
    sensitiveDataRedaction: boolean;
    sessionRetentionSeconds?: number;
  },
): MemoryScopeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`memory scope "${key}" must be an object`);
  }

  const scope = value as Record<string, unknown>;
  assertAllowedKeys(
    scope,
    [
      "label",
      "namespace",
      "userId",
      "workingMemorySessionId",
      "extractionStrategy",
      "customPrompt",
      "summaryViewName",
      "summaryTimeWindowDays",
      "summaryGroupBy",
      "autoRecall",
      "autoCapture",
      "assistantCapture",
      "sensitiveDataRedaction",
      "sessionRetentionSeconds",
    ],
    `memory scope "${key}"`,
  );

  for (const field of [
    "label",
    "namespace",
    "userId",
    "workingMemorySessionId",
    "extractionStrategy",
    "customPrompt",
    "summaryViewName",
  ]) {
    if (scope[field] !== undefined && typeof scope[field] !== "string") {
      throw new Error(`memory scope "${key}" ${field} must be a string`);
    }
  }
  if (
    scope.summaryTimeWindowDays !== undefined &&
    (typeof scope.summaryTimeWindowDays !== "number" ||
      !Number.isFinite(scope.summaryTimeWindowDays) ||
      !Number.isInteger(scope.summaryTimeWindowDays))
  ) {
    throw new Error(`memory scope "${key}" summaryTimeWindowDays must be a finite integer`);
  }
  for (const field of ["autoRecall", "autoCapture", "sensitiveDataRedaction"] as const) {
    if (scope[field] !== undefined && typeof scope[field] !== "boolean") {
      throw new Error(`memory scope "${key}" ${field} must be a boolean`);
    }
  }
  if (
    scope.assistantCapture !== undefined &&
    scope.assistantCapture !== "exclude" &&
    scope.assistantCapture !== "include"
  ) {
    throw new Error(`memory scope "${key}" assistantCapture must be exclude or include`);
  }
  if (scope.sessionRetentionSeconds !== undefined) {
    assertIntegerInRange(
      scope.sessionRetentionSeconds,
      `memory scope "${key}" sessionRetentionSeconds`,
      60,
      31_536_000,
    );
  }

  let extractionStrategy = defaults.extractionStrategy;
  if (typeof scope.extractionStrategy === "string") {
    if (!VALID_STRATEGIES.includes(scope.extractionStrategy as MemoryStrategy)) {
      throw new Error(
        `Invalid extractionStrategy in scope "${key}": ${scope.extractionStrategy}. Must be one of: ${VALID_STRATEGIES.join(", ")}`,
      );
    }
    extractionStrategy = scope.extractionStrategy as MemoryStrategy;
  }

  const customPrompt = resolveOptionalString(scope.customPrompt) ?? defaults.customPrompt;
  if (customPrompt !== undefined) {
    assertBoundedString(customPrompt, `memory scope "${key}" customPrompt`, {
      min: 1,
      max: MAX_CUSTOM_PROMPT_CHARS,
    });
  }
  if (extractionStrategy === "custom" && !customPrompt) {
    throw new Error(`customPrompt is required for custom extractionStrategy in scope "${key}"`);
  }

  const configuredWorkingMemorySessionId = resolveOptionalSessionIdentity(
    scope.workingMemorySessionId,
    `memory scope "${key}" workingMemorySessionId`,
  );

  const label = resolveOptionalString(scope.label);
  if (label !== undefined) {
    assertBoundedString(label, `memory scope "${key}" label`, { min: 1, max: 200 });
  }
  const namespace = resolveOptionalString(scope.namespace) ?? defaults.namespace;
  if (namespace !== undefined) {
    assertGenericIdentifier(namespace, `memory scope "${key}" namespace`);
  }
  const userId = resolveOptionalString(scope.userId) ?? defaults.userId;
  if (userId !== undefined) {
    assertGenericIdentifier(userId, `memory scope "${key}" userId`);
  }
  const summaryViewName =
    resolveOptionalString(scope.summaryViewName) ??
    `${defaults.summaryViewName}_${sanitizeScopeKey(key)}`;
  assertBoundedString(summaryViewName, `memory scope "${key}" summaryViewName`, {
    min: 1,
    max: 128,
    pattern: CONFIG_KEY_PATTERN,
  });
  const summaryTimeWindowDays =
    scope.summaryTimeWindowDays === undefined
      ? defaults.summaryTimeWindowDays
      : scope.summaryTimeWindowDays as number;
  assertIntegerInRange(
    summaryTimeWindowDays,
    `memory scope "${key}" summaryTimeWindowDays`,
    1,
    36_500,
  );

  return {
    label,
    namespace,
    userId,
    workingMemorySessionId:
      configuredWorkingMemorySessionId ?? defaults.workingMemorySessionId,
    extractionStrategy,
    customPrompt,
    summaryViewName,
    summaryTimeWindowDays,
    summaryGroupBy: parseSummaryGroupBy(scope.summaryGroupBy, defaults.summaryGroupBy),
    autoRecall: scope.autoRecall === undefined ? defaults.autoRecall : scope.autoRecall as boolean,
    autoCapture: scope.autoCapture === undefined ? defaults.autoCapture : scope.autoCapture as boolean,
    assistantCapture:
      scope.assistantCapture === undefined
        ? defaults.assistantCapture
        : scope.assistantCapture as AssistantCapturePolicy,
    sensitiveDataRedaction:
      scope.sensitiveDataRedaction === undefined
        ? defaults.sensitiveDataRedaction
        : scope.sensitiveDataRedaction as boolean,
    sessionRetentionSeconds:
      scope.sessionRetentionSeconds === undefined
        ? defaults.sessionRetentionSeconds
        : scope.sessionRetentionSeconds as number,
  };
}

function parseAgentMemoryRoute(key: string, value: unknown): AgentMemoryRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`agent scope route "${key}" must be an object`);
  }

  const route = value as Record<string, unknown>;
  assertAllowedKeys(
    route,
    ["primaryScope", "recallScopes", "captureScopes", "toolScopes", "defaultStoreScope"],
    `agent scope route "${key}"`,
  );

  if (typeof route.primaryScope !== "string" || route.primaryScope.trim().length === 0) {
    throw new Error(`agent scope route "${key}" requires primaryScope`);
  }
  assertBoundedString(route.primaryScope, `agent scope route "${key}" primaryScope`, {
    min: 1,
    max: MAX_IDENTIFIER_CHARS,
    pattern: CONFIG_KEY_PATTERN,
  });
  if (route.defaultStoreScope !== undefined) {
    assertBoundedString(route.defaultStoreScope, `agent scope route "${key}" defaultStoreScope`, {
      min: 1,
      max: MAX_IDENTIFIER_CHARS,
      pattern: CONFIG_KEY_PATTERN,
    });
  }

  return {
    primaryScope: route.primaryScope,
    recallScopes: parseStringList(route.recallScopes, `agent scope route "${key}" recallScopes`),
    captureScopes: parseStringList(route.captureScopes, `agent scope route "${key}" captureScopes`),
    toolScopes: parseStringList(route.toolScopes, `agent scope route "${key}" toolScopes`),
    defaultStoreScope:
      typeof route.defaultStoreScope === "string" ? route.defaultStoreScope : undefined,
  };
}

const ALLOWED_CONFIG_KEYS = [
  "provider",
  "serverUrl",
  "apiKey",
  "bearerToken",
  "storeId",
  "namespace",
  "userId",
  "workingMemorySessionId",
  "timeout",
  "autoCapture",
  "autoRecall",
  "minScore",
  "recallLimit",
  "recallRecordMaxChars",
  "recallContextMaxChars",
  "assistantCapture",
  "sensitiveDataRedaction",
  "eagerStartupCheck",
  "sessionRetentionSeconds",
  "erasureSettleMs",
  "extractionStrategy",
  "customPrompt",
  "summaryViewName",
  "summaryTimeWindowDays",
  "summaryGroupBy",
  "recallDescription",
  "storeDescription",
  "forgetDescription",
  "scopes",
  "agentScopes",
];

const VALID_STRATEGIES = ["discrete", "summary", "preferences", "custom"] as const;

const STRING_CONFIG_KEYS = [
  "provider",
  "serverUrl",
  "apiKey",
  "bearerToken",
  "storeId",
  "namespace",
  "userId",
  "workingMemorySessionId",
  "extractionStrategy",
  "customPrompt",
  "summaryViewName",
  "recallDescription",
  "storeDescription",
  "forgetDescription",
  "assistantCapture",
] as const;
const NUMBER_CONFIG_KEYS = [
  "timeout",
  "minScore",
  "recallLimit",
  "summaryTimeWindowDays",
  "recallRecordMaxChars",
  "recallContextMaxChars",
  "sessionRetentionSeconds",
  "erasureSettleMs",
] as const;
const BOOLEAN_CONFIG_KEYS = [
  "autoCapture",
  "autoRecall",
  "sensitiveDataRedaction",
  "eagerStartupCheck",
] as const;

function assertConfigFieldTypes(cfg: Record<string, unknown>): void {
  for (const key of STRING_CONFIG_KEYS) {
    if (cfg[key] !== undefined && typeof cfg[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  for (const key of NUMBER_CONFIG_KEYS) {
    if (cfg[key] !== undefined && (typeof cfg[key] !== "number" || !Number.isFinite(cfg[key]))) {
      throw new Error(`${key} must be a finite number`);
    }
  }
  for (const key of BOOLEAN_CONFIG_KEYS) {
    if (cfg[key] !== undefined && typeof cfg[key] !== "boolean") {
      throw new Error(`${key} must be a boolean`);
    }
  }
}

/**
 * Options the cloud provider (Redis Agent Memory) does not support. Setting
 * these does not throw — they're recorded in `cloudIgnoredOptions` instead,
 * since a config may be shared between providers.
 */
const CLOUD_IGNORED_OPTION_KEYS = [
  "extractionStrategy",
  "customPrompt",
  "summaryViewName",
  "summaryTimeWindowDays",
  "summaryGroupBy",
] as const;

export function parseMemoryConfig(value: unknown): MemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memory config required");
  }
  const cfg = value as Record<string, unknown>;
  assertAllowedKeys(cfg, ALLOWED_CONFIG_KEYS, "memory config");
  assertConfigFieldTypes(cfg);
  if (
    cfg.assistantCapture !== undefined &&
    cfg.assistantCapture !== "exclude" &&
    cfg.assistantCapture !== "include"
  ) {
    throw new Error("assistantCapture must be exclude or include");
  }

  // Validate extraction strategy
  let extractionStrategy: MemoryStrategy | undefined;
  if (typeof cfg.extractionStrategy === "string") {
    if (!VALID_STRATEGIES.includes(cfg.extractionStrategy as MemoryStrategy)) {
      throw new Error(
        `Invalid extractionStrategy: ${cfg.extractionStrategy}. Must be one of: ${VALID_STRATEGIES.join(", ")}`,
      );
    }
    extractionStrategy = cfg.extractionStrategy as MemoryStrategy;
  }

  // Validate custom prompt
  const customPrompt =
    typeof cfg.customPrompt === "string" ? resolveEnvVars(cfg.customPrompt) : undefined;
  if (customPrompt !== undefined) {
    assertBoundedString(customPrompt, "customPrompt", {
      min: 1,
      max: MAX_CUSTOM_PROMPT_CHARS,
    });
  }
  if (extractionStrategy === "custom" && !customPrompt) {
    throw new Error(
      'customPrompt is required when extractionStrategy is "custom"',
    );
  }

  const summaryGroupBy = parseSummaryGroupBy(cfg.summaryGroupBy, DEFAULT_SUMMARY_GROUP_BY);

  const parsedNamespace =
    typeof cfg.namespace === "string" ? resolveEnvVars(cfg.namespace) : DEFAULT_NAMESPACE;
  assertGenericIdentifier(parsedNamespace, "namespace");
  const parsedUserId =
    typeof cfg.userId === "string" ? resolveEnvVars(cfg.userId) : undefined;
  if (parsedUserId !== undefined) {
    assertGenericIdentifier(parsedUserId, "userId");
  }
  const parsedWorkingMemorySessionId =
    resolveOptionalSessionIdentity(cfg.workingMemorySessionId, "workingMemorySessionId");
  const parsedSummaryViewName =
    typeof cfg.summaryViewName === "string"
      ? resolveEnvVars(cfg.summaryViewName)
      : DEFAULT_SUMMARY_VIEW_NAME;
  assertBoundedString(parsedSummaryViewName, "summaryViewName", {
    min: 1,
    max: 128,
    pattern: CONFIG_KEY_PATTERN,
  });
  const parsedSummaryTimeWindowDays =
    typeof cfg.summaryTimeWindowDays === "number"
      ? cfg.summaryTimeWindowDays
      : DEFAULT_SUMMARY_TIME_WINDOW_DAYS;
  assertIntegerInRange(
    parsedSummaryTimeWindowDays,
    "summaryTimeWindowDays",
    1,
    36_500,
  );
  const autoCapture = cfg.autoCapture !== false;
  const autoRecall = cfg.autoRecall !== false;
  const eagerStartupCheck = cfg.eagerStartupCheck !== false;
  const assistantCapture =
    cfg.assistantCapture === "exclude" ? "exclude" : "include";
  const sensitiveDataRedaction = cfg.sensitiveDataRedaction === true;
  const sessionRetentionSeconds =
    typeof cfg.sessionRetentionSeconds === "number"
      ? cfg.sessionRetentionSeconds
      : undefined;
  if (sessionRetentionSeconds !== undefined) {
    assertIntegerInRange(
      sessionRetentionSeconds,
      "sessionRetentionSeconds",
      60,
      31_536_000,
    );
  }

  let scopes: Record<string, MemoryScopeConfig> | undefined;
  if (cfg.scopes !== undefined) {
    if (!cfg.scopes || typeof cfg.scopes !== "object" || Array.isArray(cfg.scopes)) {
      throw new Error("scopes must be an object");
    }
    const scopeEntries = Object.entries(cfg.scopes as Record<string, unknown>);
    if (scopeEntries.length === 0 || scopeEntries.length > MAX_CONFIG_SCOPES) {
      throw new Error(`scopes must contain between 1 and ${MAX_CONFIG_SCOPES} entries`);
    }
    for (const [key] of scopeEntries) {
      assertBoundedString(key, "memory scope key", {
        min: 1,
        max: MAX_IDENTIFIER_CHARS,
        pattern: CONFIG_KEY_PATTERN,
      });
    }

    scopes = Object.fromEntries(
      scopeEntries.map(([key, scopeValue]) => [
        key,
        parseScopeConfig(key, scopeValue, {
          namespace: parsedNamespace,
          userId: parsedUserId,
          workingMemorySessionId: parsedWorkingMemorySessionId,
          extractionStrategy,
          customPrompt,
          summaryViewName: parsedSummaryViewName,
          summaryTimeWindowDays: parsedSummaryTimeWindowDays,
          summaryGroupBy,
          autoRecall,
          autoCapture,
          assistantCapture,
          sensitiveDataRedaction,
          sessionRetentionSeconds,
        }),
      ]),
    );
  }

  let agentScopes: Record<string, AgentMemoryRoute> | undefined;
  if (cfg.agentScopes !== undefined) {
    if (!cfg.agentScopes || typeof cfg.agentScopes !== "object" || Array.isArray(cfg.agentScopes)) {
      throw new Error("agentScopes must be an object");
    }
    const agentEntries = Object.entries(cfg.agentScopes as Record<string, unknown>);
    if (agentEntries.length === 0 || agentEntries.length > MAX_AGENT_ROUTES) {
      throw new Error(`agentScopes must contain between 1 and ${MAX_AGENT_ROUTES} entries`);
    }
    for (const [key] of agentEntries) {
      assertBoundedString(key, "agentScopes key", {
        min: 1,
        max: MAX_IDENTIFIER_CHARS,
        pattern: CONFIG_KEY_PATTERN,
      });
    }

    agentScopes = Object.fromEntries(
      agentEntries.map(([key, routeValue]) => [
        key,
        parseAgentMemoryRoute(key, routeValue),
      ]),
    );
  }

  if (agentScopes && !scopes) {
    throw new Error("agentScopes requires scopes to also be configured");
  }

  if (scopes && agentScopes) {
    const scopeNames = new Set(Object.keys(scopes));
    for (const [agentId, route] of Object.entries(agentScopes)) {
      const referencedScopes = [
        route.primaryScope,
        ...(route.recallScopes ?? []),
        ...(route.captureScopes ?? []),
        ...(route.toolScopes ?? []),
        ...(route.defaultStoreScope ? [route.defaultStoreScope] : []),
      ];

      for (const scopeName of referencedScopes) {
        if (!scopeNames.has(scopeName)) {
          throw new Error(`agentScopes.${agentId} references unknown scope "${scopeName}"`);
        }
      }
    }
  }

  // --- Provider resolution & RAM credential resolution (Story 04) ---
  //
  // `${VAR}` substitution always happens first (matching every other string
  // field); environment fallbacks for the cloud provider are applied only
  // afterward, and only for fields the user left unset entirely.
  const rawServerUrlPresent = typeof cfg.serverUrl === "string";
  const rawServerUrl = rawServerUrlPresent
    ? resolveEnvVars(cfg.serverUrl as string)
    : undefined;
  const rawApiKey = typeof cfg.apiKey === "string" ? resolveEnvVars(cfg.apiKey) : undefined;
  const rawBearerToken =
    typeof cfg.bearerToken === "string" ? resolveEnvVars(cfg.bearerToken) : undefined;
  const storeIdInConfig = typeof cfg.storeId === "string";
  const rawStoreId = storeIdInConfig ? resolveEnvVars(cfg.storeId as string) : undefined;

  let provider: MemoryProviderKind;
  if (cfg.provider === "cloud" || cfg.provider === "self-hosted") {
    provider = cfg.provider;
  } else if (cfg.provider !== undefined) {
    throw new Error(
      `Invalid provider: ${String(cfg.provider)}. Must be one of: cloud, self-hosted`,
    );
  } else if (
    rawServerUrlPresent &&
    !storeIdInConfig &&
    !process.env.AGENT_MEMORY_STORE_ID
  ) {
    // Backwards-compat clause: an existing AMS-shaped config (serverUrl set,
    // nothing RAM-shaped) keeps resolving to self-hosted without requiring
    // an explicit "provider" key. Story 05 logs an informational note about
    // this resolution when the plugin registers; parse time stays silent so
    // config parsing has no side effects.
    provider = "self-hosted";
  } else {
    provider = "cloud";
  }

  let serverUrl: string;
  let apiKey: string | undefined;
  let storeId: string | undefined;
  if (provider === "cloud") {
    serverUrl = rawServerUrl ?? process.env.AGENT_MEMORY_ENDPOINT ?? "";
    apiKey = rawApiKey ?? process.env.AGENT_MEMORY_API_KEY ?? undefined;
    storeId = rawStoreId ?? process.env.AGENT_MEMORY_STORE_ID ?? undefined;

    if (rawBearerToken) {
      throw new Error(
        'bearerToken is not supported with the cloud provider (Redis Agent Memory). Set "apiKey" instead.',
      );
    }

    const missing: string[] = [];
    if (!serverUrl) missing.push("serverUrl (set it or AGENT_MEMORY_ENDPOINT)");
    if (!apiKey) missing.push("apiKey (set it or AGENT_MEMORY_API_KEY)");
    if (!storeId) missing.push("storeId (set it or AGENT_MEMORY_STORE_ID)");
    if (missing.length > 0) {
      throw new Error(
        "Redis Agent Memory (cloud) is the default backend and requires serverUrl, apiKey, storeId.\n" +
          `Missing: ${missing.join(", ")}.\n` +
          'To use a self-hosted agent-memory-server instead, set "provider": "self-hosted".',
      );
    }
    serverUrl = validateServerUrl(serverUrl, provider);
    assertBoundedString(apiKey, "apiKey", { min: 1, max: 4_096 });
    if (!apiKey.trim()) throw new Error("apiKey must not be blank");
    assertServiceIdentifier(storeId, "storeId");
    assertServiceIdentifier(parsedNamespace, "namespace");
    if (parsedUserId !== undefined) assertServiceIdentifier(parsedUserId, "userId");
    if (parsedWorkingMemorySessionId !== undefined) {
      assertServiceIdentifier(parsedWorkingMemorySessionId, "workingMemorySessionId");
    }
    for (const [scopeKey, scope] of Object.entries(scopes ?? {})) {
      if (scope.namespace !== undefined) {
        assertServiceIdentifier(scope.namespace, `memory scope "${scopeKey}" namespace`);
      }
      if (scope.userId !== undefined) {
        assertServiceIdentifier(scope.userId, `memory scope "${scopeKey}" userId`);
      }
      if (scope.workingMemorySessionId !== undefined) {
        assertServiceIdentifier(
          scope.workingMemorySessionId,
          `memory scope "${scopeKey}" workingMemorySessionId`,
        );
      }
    }
    if (
      sessionRetentionSeconds !== undefined ||
      Object.values(scopes ?? {}).some((scope) => scope.sessionRetentionSeconds !== undefined)
    ) {
      throw new Error(
        "sessionRetentionSeconds is not supported by the cloud provider; Redis Agent Memory does not expose a session TTL option",
      );
    }
  } else {
    serverUrl = rawServerUrl ?? DEFAULT_SERVER_URL;
    apiKey = rawApiKey;
    storeId = rawStoreId;
    serverUrl = validateServerUrl(serverUrl, provider);
    if (apiKey !== undefined) {
      assertBoundedString(apiKey, "apiKey", { min: 1, max: 4_096 });
      if (!apiKey.trim()) throw new Error("apiKey must not be blank");
    }
    if (rawBearerToken !== undefined) {
      assertBoundedString(rawBearerToken, "bearerToken", { min: 1, max: 8_192 });
      if (!rawBearerToken.trim()) throw new Error("bearerToken must not be blank");
    }
    if (storeId !== undefined) assertServiceIdentifier(storeId, "storeId");
  }

  // Cloud-incompatible options are never fatal — they may be shared configs
  // toggled between providers. Record which the user explicitly set (either
  // top-level or inside any scope) so Story 05 can log one consolidated
  // warning at registration. Defaulting behavior for these options is
  // unchanged regardless of provider.
  let cloudIgnoredOptions: string[] = [];
  if (provider === "cloud") {
    const ignored = new Set<string>();
    const rawScopes =
      cfg.scopes && typeof cfg.scopes === "object" && !Array.isArray(cfg.scopes)
        ? (cfg.scopes as Record<string, unknown>)
        : undefined;

    for (const key of CLOUD_IGNORED_OPTION_KEYS) {
      let explicitlySet = cfg[key] !== undefined;
      if (!explicitlySet && rawScopes) {
        for (const scopeValue of Object.values(rawScopes)) {
          if (
            scopeValue &&
            typeof scopeValue === "object" &&
            !Array.isArray(scopeValue) &&
            (scopeValue as Record<string, unknown>)[key] !== undefined
          ) {
            explicitlySet = true;
            break;
          }
        }
      }
      if (explicitlySet) ignored.add(key);
    }

    cloudIgnoredOptions = Array.from(ignored);
  }

  const timeout = typeof cfg.timeout === "number" ? cfg.timeout : DEFAULT_TIMEOUT;
  assertIntegerInRange(timeout, "timeout", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const minScore = typeof cfg.minScore === "number" ? cfg.minScore : DEFAULT_MIN_SCORE;
  assertNumberInRange(minScore, "minScore", 0, 1);
  const recallLimit =
    typeof cfg.recallLimit === "number" ? cfg.recallLimit : DEFAULT_RECALL_LIMIT;
  assertIntegerInRange(recallLimit, "recallLimit", 1, MAX_RECALL_LIMIT);
  const recallRecordMaxChars =
    typeof cfg.recallRecordMaxChars === "number"
      ? cfg.recallRecordMaxChars
      : DEFAULT_RECALL_RECORD_MAX_CHARS;
  assertIntegerInRange(recallRecordMaxChars, "recallRecordMaxChars", 128, 10_000);
  const recallContextMaxChars =
    typeof cfg.recallContextMaxChars === "number"
      ? cfg.recallContextMaxChars
      : DEFAULT_RECALL_CONTEXT_MAX_CHARS;
  assertIntegerInRange(recallContextMaxChars, "recallContextMaxChars", 1_024, 32_000);
  if (recallRecordMaxChars > recallContextMaxChars) {
    throw new Error("recallRecordMaxChars must not exceed recallContextMaxChars");
  }
  const erasureSettleMs =
    typeof cfg.erasureSettleMs === "number"
      ? cfg.erasureSettleMs
      : DEFAULT_ERASURE_SETTLE_MS;
  assertIntegerInRange(erasureSettleMs, "erasureSettleMs", 0, 60_000);

  const recallDescription =
    typeof cfg.recallDescription === "string"
      ? resolveEnvVars(cfg.recallDescription)
      : DEFAULT_RECALL_DESCRIPTION;
  const storeDescription =
    typeof cfg.storeDescription === "string"
      ? resolveEnvVars(cfg.storeDescription)
      : DEFAULT_STORE_DESCRIPTION;
  const forgetDescription =
    typeof cfg.forgetDescription === "string"
      ? resolveEnvVars(cfg.forgetDescription)
      : DEFAULT_FORGET_DESCRIPTION;
  for (const [label, description] of [
    ["recallDescription", recallDescription],
    ["storeDescription", storeDescription],
    ["forgetDescription", forgetDescription],
  ] as const) {
    assertBoundedString(description, label, { min: 1, max: MAX_DESCRIPTION_CHARS });
  }

  return {
    provider,
    serverUrl,
    apiKey,
    bearerToken: rawBearerToken,
    storeId,
    namespace: parsedNamespace,
    // Default to undefined - only pass user_id when explicitly set
    // (client library v0.3.x doesn't pass user_id on GET, causing key mismatch)
    userId: parsedUserId,
    workingMemorySessionId: parsedWorkingMemorySessionId,
    timeout,
    autoCapture,
    autoRecall,
    minScore,
    recallLimit,
    recallRecordMaxChars,
    recallContextMaxChars,
    assistantCapture,
    sensitiveDataRedaction,
    eagerStartupCheck,
    sessionRetentionSeconds,
    erasureSettleMs,
    extractionStrategy,
    customPrompt,
    summaryViewName: parsedSummaryViewName,
    summaryTimeWindowDays: parsedSummaryTimeWindowDays,
    summaryGroupBy,
    recallDescription,
    storeDescription,
    forgetDescription,
    scopes,
    agentScopes,
    cloudIgnoredOptions,
  };
}

/**
 * Config schema object compatible with OpenClaw plugin system.
 */
export const memoryConfigSchema = {
  parse: parseMemoryConfig,
  uiHints: {
    provider: {
      label: "Backend",
      help: 'Which backend to use. Defaults to "cloud" (Redis Agent Memory) unless an existing self-hosted config is detected.',
      options: [
        { value: "cloud", label: "Redis Agent Memory (cloud, default)" },
        { value: "self-hosted", label: "Self-hosted agent-memory-server" },
      ],
    },
    serverUrl: {
      label: "Server URL",
      placeholder: DEFAULT_SERVER_URL,
      help: "Base URL of the backend: the Redis Agent Memory cloud endpoint (falls back to ${AGENT_MEMORY_ENDPOINT}) when using the cloud provider, or the self-hosted agent-memory-server URL otherwise.",
    },
    apiKey: {
      label: "API Key",
      sensitive: true,
      placeholder: "your-api-key",
      help: "API key for authentication. Required for the cloud provider (sent as the Redis Agent Memory bearer token; falls back to ${AGENT_MEMORY_API_KEY}). Optional for self-hosted.",
    },
    bearerToken: {
      label: "Bearer Token",
      sensitive: true,
      placeholder: "your-bearer-token",
      help: "Bearer token for authentication (self-hosted only; optional). Not supported with the cloud provider — use API Key instead.",
      advanced: true,
    },
    storeId: {
      label: "Store ID",
      placeholder: "your-store-id",
      help: "Redis Agent Memory store id (cloud provider only, or use ${AGENT_MEMORY_STORE_ID})",
    },
    namespace: {
      label: "Namespace",
      placeholder: DEFAULT_NAMESPACE,
      help: "Namespace for organizing memories (isolates memories by app, team, or project)",
    },
    userId: {
      label: "User ID",
      placeholder: USER_ID_PLACEHOLDER,
      help: "Optional. Set explicitly for per-user isolation. If omitted, memory is scoped only by namespace.",
    },
    workingMemorySessionId: {
      label: "Working Memory Session ID",
      placeholder: "my-session",
      help: "Fixed session ID for working memory. If set, uses this instead of deriving from OpenClaw session. Useful for demos that should keep one continuous session.",
      advanced: true,
    },
    timeout: {
      label: "Timeout (ms)",
      placeholder: String(DEFAULT_TIMEOUT),
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into context",
    },
    eagerStartupCheck: {
      label: "Eager Startup Check",
      help: "Await the backend health check during service start. Disable on latency-sensitive hosts to run it in the background instead",
      advanced: true,
    },
    assistantCapture: {
      label: "Assistant Capture",
      help: "Include assistant turns for memory extraction, or exclude them to minimize retained data",
      advanced: true,
    },
    sensitiveDataRedaction: {
      label: "Sensitive Data Redaction",
      help: "Opt-in heuristic redaction for common secrets and personal identifiers before capture",
      advanced: true,
    },
    sessionRetentionSeconds: {
      label: "Session Retention (seconds)",
      help: "Self-hosted working-memory TTL; unsupported by Redis Agent Memory cloud",
      advanced: true,
    },
    recallRecordMaxChars: {
      label: "Recall Record Limit",
      placeholder: String(DEFAULT_RECALL_RECORD_MAX_CHARS),
      advanced: true,
    },
    recallContextMaxChars: {
      label: "Recall Context Limit",
      placeholder: String(DEFAULT_RECALL_CONTEXT_MAX_CHARS),
      advanced: true,
    },
    erasureSettleMs: {
      label: "Erasure Settle Delay",
      placeholder: String(DEFAULT_ERASURE_SETTLE_MS),
      advanced: true,
    },
    minScore: {
      label: "Minimum Score",
      placeholder: String(DEFAULT_MIN_SCORE),
      help: "Minimum similarity score for memory recall (0-1)",
      advanced: true,
    },
    recallLimit: {
      label: "Recall Limit",
      placeholder: String(DEFAULT_RECALL_LIMIT),
      help: "Maximum number of memories to recall",
      advanced: true,
    },
    extractionStrategy: {
      label: "Extraction Strategy",
      placeholder: "discrete",
      help: "How to extract memories: discrete (semantic/episodic), summary, preferences, or custom",
      options: [
        { value: "discrete", label: "Discrete (semantic & episodic memories)" },
        { value: "summary", label: "Summary (running conversation summary)" },
        { value: "preferences", label: "Preferences (user preferences)" },
        { value: "custom", label: "Custom (use custom prompt)" },
      ],
    },
    customPrompt: {
      label: "Custom Extraction Prompt",
      placeholder: "Extract action items and decisions from this conversation.",
      help: "Custom prompt for memory extraction (only used with 'custom' strategy)",
      multiline: true,
      advanced: true,
    },
    summaryViewName: {
      label: "Summary View Name",
      placeholder: DEFAULT_SUMMARY_VIEW_NAME,
      help: "Name for the rolling summary view of long-term memories",
      advanced: true,
    },
    summaryTimeWindowDays: {
      label: "Summary Time Window (days)",
      placeholder: String(DEFAULT_SUMMARY_TIME_WINDOW_DAYS),
      help: "Rolling window in days for the summary view (only recent memories included)",
      advanced: true,
    },
    summaryGroupBy: {
      label: "Summary Group By",
      placeholder: "user_id",
      help: "Fields to partition summaries by: user_id, namespace, or both",
      advanced: true,
    },
    recallDescription: {
      label: "Recall Tool Description",
      placeholder: DEFAULT_RECALL_DESCRIPTION,
      help: "Description shown to the LLM for the memory_recall tool",
      multiline: true,
      advanced: true,
    },
    storeDescription: {
      label: "Store Tool Description",
      placeholder: DEFAULT_STORE_DESCRIPTION,
      help: "Description shown to the LLM for the memory_store tool",
      multiline: true,
      advanced: true,
    },
    forgetDescription: {
      label: "Forget Tool Description",
      placeholder: DEFAULT_FORGET_DESCRIPTION,
      help: "Description shown to the LLM for the memory_forget tool",
      multiline: true,
      advanced: true,
    },
    scopes: {
      label: "Named Scopes",
      help: "Optional named memory boundaries for multi-agent setups. Each scope can override namespace, userId, extraction, and summary settings.",
      advanced: true,
    },
    agentScopes: {
      label: "Agent Scope Routing",
      help: "Optional mapping from OpenClaw agent ID to named scopes for recall, capture, and tool defaults.",
      advanced: true,
    },
  },
};
