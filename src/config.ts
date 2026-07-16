/**
 * Configuration schema and parsing for the agent-memory-plugin.
 */

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
export const DEFAULT_NAMESPACE = "default";
export const USER_ID_PLACEHOLDER = "user-123";
export const DEFAULT_SUMMARY_VIEW_NAME = "agent_user_summary";
export const DEFAULT_SUMMARY_TIME_WINDOW_DAYS = 30;
export const DEFAULT_SUMMARY_GROUP_BY: SummaryGroupByField[] = ["user_id"];
export const DEFAULT_RECALL_DESCRIPTION =
  "Search through long-term memories. Use when you need context about user preferences, past decisions, or previously discussed topics.";
export const DEFAULT_STORE_DESCRIPTION =
  "Save important information in long-term memory. Use for preferences, facts, decisions.";
export const DEFAULT_FORGET_DESCRIPTION = "Delete specific memories. GDPR-compliant.";

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

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return parsed.length > 0 ? parsed : undefined;
}

function parseSummaryGroupBy(
  value: unknown,
  fallback: SummaryGroupByField[],
): SummaryGroupByField[] {
  if (!Array.isArray(value)) return fallback;

  const validFields: SummaryGroupByField[] = ["user_id", "namespace"];
  const parsed = value.filter(
    (field): field is SummaryGroupByField =>
      typeof field === "string" && validFields.includes(field as SummaryGroupByField),
  );

  return parsed.length > 0 ? parsed : fallback;
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
    ],
    `memory scope "${key}"`,
  );

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
  if (extractionStrategy === "custom" && !customPrompt) {
    throw new Error(`customPrompt is required for custom extractionStrategy in scope "${key}"`);
  }

  return {
    label: resolveOptionalString(scope.label),
    namespace: resolveOptionalString(scope.namespace) ?? defaults.namespace,
    userId: resolveOptionalString(scope.userId) ?? defaults.userId,
    workingMemorySessionId:
      resolveOptionalString(scope.workingMemorySessionId) ?? defaults.workingMemorySessionId,
    extractionStrategy,
    customPrompt,
    summaryViewName:
      resolveOptionalString(scope.summaryViewName) ??
      `${defaults.summaryViewName}_${sanitizeScopeKey(key)}`,
    summaryTimeWindowDays:
      typeof scope.summaryTimeWindowDays === "number" &&
      Number.isFinite(scope.summaryTimeWindowDays)
        ? Math.max(1, Math.floor(scope.summaryTimeWindowDays))
        : defaults.summaryTimeWindowDays,
    summaryGroupBy: parseSummaryGroupBy(scope.summaryGroupBy, defaults.summaryGroupBy),
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

  return {
    primaryScope: route.primaryScope,
    recallScopes: parseStringList(route.recallScopes),
    captureScopes: parseStringList(route.captureScopes),
    toolScopes: parseStringList(route.toolScopes),
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
    typeof cfg.customPrompt === "string" ? cfg.customPrompt : undefined;
  if (extractionStrategy === "custom" && !customPrompt) {
    throw new Error(
      'customPrompt is required when extractionStrategy is "custom"',
    );
  }

  const summaryGroupBy = parseSummaryGroupBy(cfg.summaryGroupBy, DEFAULT_SUMMARY_GROUP_BY);

  const parsedNamespace =
    typeof cfg.namespace === "string" ? resolveEnvVars(cfg.namespace) : DEFAULT_NAMESPACE;
  const parsedUserId =
    typeof cfg.userId === "string" ? resolveEnvVars(cfg.userId) : undefined;
  const parsedWorkingMemorySessionId =
    typeof cfg.workingMemorySessionId === "string"
      ? resolveEnvVars(cfg.workingMemorySessionId)
      : undefined;
  const parsedSummaryViewName =
    typeof cfg.summaryViewName === "string"
      ? resolveEnvVars(cfg.summaryViewName)
      : DEFAULT_SUMMARY_VIEW_NAME;
  const parsedSummaryTimeWindowDays =
    typeof cfg.summaryTimeWindowDays === "number" &&
    Number.isFinite(cfg.summaryTimeWindowDays)
      ? Math.max(1, Math.floor(cfg.summaryTimeWindowDays))
      : DEFAULT_SUMMARY_TIME_WINDOW_DAYS;

  let scopes: Record<string, MemoryScopeConfig> | undefined;
  if (cfg.scopes !== undefined) {
    if (!cfg.scopes || typeof cfg.scopes !== "object" || Array.isArray(cfg.scopes)) {
      throw new Error("scopes must be an object");
    }

    scopes = Object.fromEntries(
      Object.entries(cfg.scopes as Record<string, unknown>).map(([key, scopeValue]) => [
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
        }),
      ]),
    );
  }

  let agentScopes: Record<string, AgentMemoryRoute> | undefined;
  if (cfg.agentScopes !== undefined) {
    if (!cfg.agentScopes || typeof cfg.agentScopes !== "object" || Array.isArray(cfg.agentScopes)) {
      throw new Error("agentScopes must be an object");
    }

    agentScopes = Object.fromEntries(
      Object.entries(cfg.agentScopes as Record<string, unknown>).map(([key, routeValue]) => [
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
  } else {
    serverUrl = rawServerUrl ?? DEFAULT_SERVER_URL;
    apiKey = rawApiKey;
    storeId = rawStoreId;
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
    timeout:
      typeof cfg.timeout === "number" && Number.isFinite(cfg.timeout)
        ? cfg.timeout
        : DEFAULT_TIMEOUT,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall !== false,
    minScore:
      typeof cfg.minScore === "number" && Number.isFinite(cfg.minScore)
        ? Math.max(0, Math.min(1, cfg.minScore))
        : DEFAULT_MIN_SCORE,
    recallLimit:
      typeof cfg.recallLimit === "number" && Number.isFinite(cfg.recallLimit)
        ? Math.max(1, Math.floor(cfg.recallLimit))
        : DEFAULT_RECALL_LIMIT,
    extractionStrategy,
    customPrompt,
    summaryViewName: parsedSummaryViewName,
    summaryTimeWindowDays: parsedSummaryTimeWindowDays,
    summaryGroupBy,
    recallDescription:
      typeof cfg.recallDescription === "string"
        ? cfg.recallDescription
        : DEFAULT_RECALL_DESCRIPTION,
    storeDescription:
      typeof cfg.storeDescription === "string"
        ? cfg.storeDescription
        : DEFAULT_STORE_DESCRIPTION,
    forgetDescription:
      typeof cfg.forgetDescription === "string"
        ? cfg.forgetDescription
        : DEFAULT_FORGET_DESCRIPTION,
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
