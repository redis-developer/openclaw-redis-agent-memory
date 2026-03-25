import type {
  MemoryConfig,
  MemoryStrategy,
  MemoryScopeConfig,
  SummaryGroupByField,
  AgentMemoryRoute,
} from "./config.js";

export type ScopedMemoryTarget = {
  key: string;
  label: string;
  namespace?: string;
  userId?: string;
  workingMemorySessionId?: string;
  extractionStrategy?: MemoryStrategy;
  customPrompt?: string;
  summaryViewName: string;
  summaryTimeWindowDays: number;
  summaryGroupBy: SummaryGroupByField[];
};

export type AgentScopePlan = {
  agentId: string;
  primaryScope: ScopedMemoryTarget;
  recallScopes: ScopedMemoryTarget[];
  captureScopes: ScopedMemoryTarget[];
  toolScopes: ScopedMemoryTarget[];
  defaultStoreScope: ScopedMemoryTarget;
};

export type AgentScopeContext = {
  agentId?: string;
  sessionKey?: string;
};

function titleCaseScopeLabel(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function uniqueTargets(targets: ScopedMemoryTarget[]): ScopedMemoryTarget[] {
  const seen = new Set<string>();
  const result: ScopedMemoryTarget[] = [];

  for (const target of targets) {
    if (seen.has(target.key)) continue;
    seen.add(target.key);
    result.push(target);
  }

  return result;
}

function buildLegacyScope(cfg: MemoryConfig): ScopedMemoryTarget {
  return {
    key: "default",
    label: "Default",
    namespace: cfg.namespace,
    userId: cfg.userId,
    workingMemorySessionId: cfg.workingMemorySessionId,
    extractionStrategy: cfg.extractionStrategy,
    customPrompt: cfg.customPrompt,
    summaryViewName: cfg.summaryViewName!,
    summaryTimeWindowDays: cfg.summaryTimeWindowDays!,
    summaryGroupBy: cfg.summaryGroupBy!,
  };
}

function buildScopedTarget(key: string, scope: MemoryScopeConfig): ScopedMemoryTarget {
  return {
    key,
    label: scope.label ?? titleCaseScopeLabel(key),
    namespace: scope.namespace,
    userId: scope.userId,
    workingMemorySessionId: scope.workingMemorySessionId,
    extractionStrategy: scope.extractionStrategy,
    customPrompt: scope.customPrompt,
    summaryViewName: scope.summaryViewName!,
    summaryTimeWindowDays: scope.summaryTimeWindowDays!,
    summaryGroupBy: scope.summaryGroupBy!,
  };
}

function buildScopeCatalog(cfg: MemoryConfig): Map<string, ScopedMemoryTarget> {
  if (!cfg.scopes || Object.keys(cfg.scopes).length === 0) {
    return new Map([["default", buildLegacyScope(cfg)]]);
  }

  return new Map(
    Object.entries(cfg.scopes).map(([key, scope]) => [key, buildScopedTarget(key, scope)]),
  );
}

function resolveFallbackRoute(cfg: MemoryConfig, catalog: Map<string, ScopedMemoryTarget>): AgentMemoryRoute | null {
  if (cfg.agentScopes?.default) {
    return cfg.agentScopes.default;
  }

  const firstScope = catalog.values().next().value as ScopedMemoryTarget | undefined;
  if (!firstScope) return null;

  return {
    primaryScope: firstScope.key,
  };
}

function selectRoute(
  cfg: MemoryConfig,
  catalog: Map<string, ScopedMemoryTarget>,
  agentId: string,
): AgentMemoryRoute | null {
  if (!cfg.scopes || Object.keys(cfg.scopes).length === 0) {
    return null;
  }

  return cfg.agentScopes?.[agentId] ?? resolveFallbackRoute(cfg, catalog);
}

function requireScope(
  catalog: Map<string, ScopedMemoryTarget>,
  key: string,
): ScopedMemoryTarget {
  const scope = catalog.get(key);
  if (!scope) {
    throw new Error(`Unknown memory scope "${key}"`);
  }
  return scope;
}

export function parseAgentIdFromSessionKey(sessionKey?: string): string | null {
  const raw = sessionKey?.trim().toLowerCase() ?? "";
  if (!raw.startsWith("agent:")) return null;

  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return null;

  return parts[1] ?? null;
}

export function resolveAgentId(ctx: AgentScopeContext): string {
  return (
    ctx.agentId?.trim().toLowerCase() ||
    parseAgentIdFromSessionKey(ctx.sessionKey) ||
    "main"
  );
}

export function getConfiguredScopes(cfg: MemoryConfig): ScopedMemoryTarget[] {
  return Array.from(buildScopeCatalog(cfg).values());
}

export function resolveAgentScopePlan(
  cfg: MemoryConfig,
  ctx: AgentScopeContext = {},
): AgentScopePlan {
  const catalog = buildScopeCatalog(cfg);
  const agentId = resolveAgentId(ctx);

  if (!cfg.scopes || Object.keys(cfg.scopes).length === 0) {
    const legacy = buildLegacyScope(cfg);
    return {
      agentId,
      primaryScope: legacy,
      recallScopes: [legacy],
      captureScopes: [legacy],
      toolScopes: [legacy],
      defaultStoreScope: legacy,
    };
  }

  const route = selectRoute(cfg, catalog, agentId);
  if (!route) {
    throw new Error(`No memory route configured for agent "${agentId}"`);
  }

  const primaryScope = requireScope(catalog, route.primaryScope);
  const recallScopes = uniqueTargets(
    (route.recallScopes && route.recallScopes.length > 0
      ? route.recallScopes
      : [route.primaryScope]
    ).map((key) => requireScope(catalog, key)),
  );
  const captureScopes = uniqueTargets(
    (route.captureScopes && route.captureScopes.length > 0
      ? route.captureScopes
      : [route.primaryScope]
    ).map((key) => requireScope(catalog, key)),
  );
  const toolScopes = uniqueTargets(
    (route.toolScopes && route.toolScopes.length > 0
      ? route.toolScopes
      : [route.primaryScope, ...recallScopes.map((scope) => scope.key)]
    ).map((key) => requireScope(catalog, key)),
  );
  const defaultStoreScope = requireScope(
    catalog,
    route.defaultStoreScope ?? route.primaryScope,
  );

  return {
    agentId,
    primaryScope,
    recallScopes,
    captureScopes,
    toolScopes,
    defaultStoreScope,
  };
}
