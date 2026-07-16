/**
 * Memory Plugin (Redis) E2E Tests
 *
 * Tests the memory plugin functionality including:
 * - Plugin registration and configuration
 * - Memory storage and retrieval
 * - Auto-recall via hooks
 * - Auto-capture filtering
 * - Message timestamp handling and deduplication
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { convertToMemoryMessages, readSessionIdFromStore } from "./index.js";
import { resolveAgentScopePlan, parseAgentIdFromSessionKey } from "./scopes.js";
import type { MemoryProvider, ProviderCapabilities } from "./provider.js";

const MEMORY_SERVER_URL = process.env.AGENT_MEMORY_SERVER_URL ?? "http://localhost:8000";
const MEMORY_SERVER_API_KEY = process.env.AGENT_MEMORY_API_KEY;
const MEMORY_SERVER_BEARER_TOKEN = process.env.AGENT_MEMORY_BEARER_TOKEN;
const HAS_SERVER = Boolean(process.env.AGENT_MEMORY_SERVER_URL);
const liveEnabled = HAS_SERVER && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

// Env isolation (Story 04): the config-parsing tests below pass an explicit
// serverUrl (resolving provider "self-hosted"), but ambient
// AGENT_MEMORY_STORE_ID/ENDPOINT/API_KEY in the developer's shell could
// otherwise flip provider resolution to "cloud" (see parseMemoryConfig's
// backwards-compat clause) and break them. Clear these three for every
// test in this file and restore them afterward. This does not touch
// AGENT_MEMORY_SERVER_URL/OPENCLAW_LIVE_TEST, which are read once above at
// import time (before this hook ever runs) to gate describeLive.
const CLOUD_ENV_KEYS = [
  "AGENT_MEMORY_ENDPOINT",
  "AGENT_MEMORY_API_KEY",
  "AGENT_MEMORY_STORE_ID",
] as const;
let savedCloudEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedCloudEnv = {};
  for (const key of CLOUD_ENV_KEYS) {
    savedCloudEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    if (savedCloudEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedCloudEnv[key];
    }
  }
});

describe("redis-memory plugin", () => {
  test("memory plugin registers and initializes correctly", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(memoryPlugin.id).toBe("openclaw-redis-agent-memory");
    expect(memoryPlugin.name).toBe("Redis Memory");
    expect(memoryPlugin.kind).toBe("memory");
    expect(memoryPlugin.configSchema).toBeDefined();
    expect(memoryPlugin.register).toBeInstanceOf(Function);
  });

  test("config schema parses valid config", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const config = memoryPlugin.configSchema?.parse?.({
      serverUrl: "http://localhost:8000",
      namespace: "test",
      autoCapture: true,
      autoRecall: true,
    });

    expect(config).toBeDefined();
    expect(config?.serverUrl).toBe("http://localhost:8000");
    expect(config?.namespace).toBe("test");
  });

  test("config schema resolves env vars", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    process.env.TEST_MEMORY_SERVER_URL = "http://test-server:9000";

    const config = memoryPlugin.configSchema?.parse?.({
      serverUrl: "${TEST_MEMORY_SERVER_URL}",
    });

    expect(config?.serverUrl).toBe("http://test-server:9000");

    delete process.env.TEST_MEMORY_SERVER_URL;
  });

  test("config schema uses defaults when not provided", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    // Cloud is now the default provider, which requires serverUrl/apiKey/
    // storeId (see Story 04). Passing serverUrl explicitly (and nothing
    // RAM-shaped) resolves provider "self-hosted" via the backwards-compat
    // clause, exercising the same defaults this test has always covered.
    const config = memoryPlugin.configSchema?.parse?.({
      serverUrl: "http://localhost:8000",
    });

    expect(config?.serverUrl).toBe("http://localhost:8000");
    expect(config?.timeout).toBe(30000);
    expect(config?.minScore).toBe(0.3);
    expect(config?.recallLimit).toBe(3);
    expect(config?.autoCapture).toBe(true);
    expect(config?.autoRecall).toBe(true);
    expect(config?.summaryViewName).toBe("agent_user_summary");
    expect(config?.summaryTimeWindowDays).toBe(30);
  });

  test("config schema parses summary view options", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const config = memoryPlugin.configSchema?.parse?.({
      serverUrl: "http://localhost:8000",
      summaryViewName: "custom_summary",
      summaryTimeWindowDays: 7,
    });

    expect(config?.summaryViewName).toBe("custom_summary");
    expect(config?.summaryTimeWindowDays).toBe(7);
  });

  test("config schema parses named scopes and agent routes", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const config = memoryPlugin.configSchema?.parse?.({
      serverUrl: "http://localhost:8000",
      namespace: "multi-agent-demo",
      scopes: {
        aditi_personal: {
          userId: "aditi",
        },
        household: {
          userId: "household",
          summaryViewName: "household_summary",
        },
      },
      agentScopes: {
        main: {
          primaryScope: "aditi_personal",
          recallScopes: ["aditi_personal", "household"],
          toolScopes: ["aditi_personal", "household"],
          defaultStoreScope: "aditi_personal",
        },
        grocery: {
          primaryScope: "household",
        },
      },
    });

    expect(config?.scopes?.aditi_personal?.namespace).toBe("multi-agent-demo");
    expect(config?.scopes?.aditi_personal?.summaryViewName).toBe(
      "agent_user_summary_aditi_personal",
    );
    expect(config?.scopes?.household?.summaryViewName).toBe("household_summary");
    expect(config?.agentScopes?.main?.recallScopes).toEqual([
      "aditi_personal",
      "household",
    ]);
  });

  test("config schema rejects agent routes that reference unknown scopes", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(() =>
      memoryPlugin.configSchema?.parse?.({
        scopes: {
          personal: {
            userId: "aditi",
          },
        },
        agentScopes: {
          main: {
            primaryScope: "missing",
          },
        },
      }),
    ).toThrow(/unknown scope "missing"/i);
  });

  test("shouldCapture filters correctly", async () => {
    // Test the capture filtering logic by checking the rules
    const triggers = [
      { text: "I prefer dark mode", shouldMatch: true },
      { text: "Remember that my name is John", shouldMatch: true },
      { text: "My email is test@example.com", shouldMatch: true },
      { text: "Call me at +1234567890123", shouldMatch: true },
      { text: "We decided to use TypeScript", shouldMatch: true },
      { text: "I always want verbose output", shouldMatch: true },
      { text: "Just a random short message", shouldMatch: false },
      { text: "x", shouldMatch: false },
      { text: "<relevant-memories>injected</relevant-memories>", shouldMatch: false },
    ];

    for (const { text, shouldMatch } of triggers) {
      const hasPreference = /prefer|radši|like|love|hate|want/i.test(text);
      const hasRemember = /zapamatuj|pamatuj|remember/i.test(text);
      const hasEmail = /[\w.-]+@[\w.-]+\.\w+/.test(text);
      const hasPhone = /\+\d{10,}/.test(text);
      const hasDecision = /rozhodli|decided|will use|budeme/i.test(text);
      const hasAlways = /always|never|important/i.test(text);
      const isInjected = text.includes("<relevant-memories>");
      const isTooShort = text.length < 10;

      const wouldCapture =
        !isTooShort &&
        !isInjected &&
        (hasPreference || hasRemember || hasEmail || hasPhone || hasDecision || hasAlways);

      if (shouldMatch) {
        expect(wouldCapture).toBe(true);
      }
    }
  });

  test("detectCategory classifies correctly", async () => {
    const cases = [
      { text: "I prefer dark mode", expected: "preference" },
      { text: "We decided to use React", expected: "decision" },
      { text: "My email is test@example.com", expected: "entity" },
      { text: "The server is running on port 3000", expected: "fact" },
    ];

    for (const { text, expected } of cases) {
      const lower = text.toLowerCase();
      let category: string;

      if (/prefer|radši|like|love|hate|want/i.test(lower)) {
        category = "preference";
      } else if (/rozhodli|decided|will use|budeme/i.test(lower)) {
        category = "decision";
      } else if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se/i.test(lower)) {
        category = "entity";
      } else if (/is|are|has|have|je|má|jsou/i.test(lower)) {
        category = "fact";
      } else {
        category = "other";
      }

      expect(category).toBe(expected);
    }
  });
});

describe("convertToMemoryMessages", () => {
  test("preserves original timestamp when provided", () => {
    const timestamp = 1706900000000; // Fixed Unix ms timestamp
    const messages = [
      { role: "user", content: "Hello", timestamp, id: "msg-1" },
    ];

    const result = convertToMemoryMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-1");
    // convertToMemoryMessages now returns the neutral CapturedMessage shape
    // (numeric timestampMs) instead of the AMS-specific created_at ISO string.
    expect(result[0].timestampMs).toBe(timestamp);
  });

  test("falls back to current time when timestamp not provided", () => {
    const before = Date.now();
    const messages = [
      { role: "user", content: "Hello", id: "msg-1" },
    ];

    const result = convertToMemoryMessages(messages);
    const after = Date.now();

    expect(result).toHaveLength(1);
    const resultTs = result[0].timestampMs;
    expect(resultTs).toBeGreaterThanOrEqual(before);
    expect(resultTs).toBeLessThanOrEqual(after);
  });

  test("generates UUID for id when not provided", () => {
    const messages = [
      { role: "user", content: "Hello" },
    ];

    const result = convertToMemoryMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBeDefined();
    expect(result[0].id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("filters out non-user/assistant messages", () => {
    const messages = [
      { role: "system", content: "You are an assistant" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "tool", content: "Tool result" },
    ];

    const result = convertToMemoryMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  test("filters out injected memory context", () => {
    const messages = [
      { role: "user", content: "<relevant-memories>Some context</relevant-memories>" },
      { role: "user", content: "Real user message" },
    ];

    const result = convertToMemoryMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Real user message");
  });

  test("filters out empty content", () => {
    const messages = [
      { role: "user", content: "" },
      { role: "user", content: "   " },
      { role: "user", content: "Valid message" },
    ];

    const result = convertToMemoryMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Valid message");
  });

  test("handles invalid input gracefully", () => {
    const messages = [
      null,
      undefined,
      "not an object",
      { notRole: "user" },
      { role: 123, content: "invalid role type" },
    ];

    const result = convertToMemoryMessages(messages as any);

    expect(result).toHaveLength(0);
  });
});

describe("readSessionIdFromStore", () => {
  test("returns null when session store does not exist", () => {
    // Use a sessionKey that won't have a store file
    const result = readSessionIdFromStore("nonexistent:agent:key");
    expect(result).toBeNull();
  });

  test("returns null for empty sessionKey", () => {
    const result = readSessionIdFromStore("");
    expect(result).toBeNull();
  });
});

describe("agent scope routing", () => {
  test("parses agent id from canonical session key", () => {
    expect(parseAgentIdFromSessionKey("agent:travel:main")).toBe("travel");
    expect(parseAgentIdFromSessionKey("main")).toBeNull();
  });

  test("resolves shared and isolated scopes per agent", () => {
    const plan = resolveAgentScopePlan(
      {
        serverUrl: "http://localhost:8000",
        namespace: "multi-agent-demo",
        summaryViewName: "agent_user_summary",
        summaryTimeWindowDays: 30,
        summaryGroupBy: ["user_id"],
        recallDescription: "recall",
        storeDescription: "store",
        forgetDescription: "forget",
        scopes: {
          aditi_personal: {
            namespace: "multi-agent-demo",
            userId: "aditi",
            summaryViewName: "summary_aditi_personal",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
          household: {
            namespace: "multi-agent-demo",
            userId: "household",
            summaryViewName: "summary_household",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
          partner_personal: {
            namespace: "multi-agent-demo",
            userId: "partner",
            summaryViewName: "summary_partner_personal",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
        },
        agentScopes: {
          main: {
            primaryScope: "aditi_personal",
            recallScopes: ["aditi_personal", "household"],
            toolScopes: ["aditi_personal", "household"],
          },
          partner: {
            primaryScope: "partner_personal",
            recallScopes: ["partner_personal", "household"],
            toolScopes: ["partner_personal", "household"],
          },
          grocery: {
            primaryScope: "household",
          },
          travel: {
            primaryScope: "aditi_personal",
          },
        },
      },
      { agentId: "main" },
    );

    expect(plan.primaryScope.key).toBe("aditi_personal");
    expect(plan.recallScopes.map((scope) => scope.key)).toEqual([
      "aditi_personal",
      "household",
    ]);

    const groceryPlan = resolveAgentScopePlan(
      {
        serverUrl: "http://localhost:8000",
        namespace: "multi-agent-demo",
        summaryViewName: "agent_user_summary",
        summaryTimeWindowDays: 30,
        summaryGroupBy: ["user_id"],
        recallDescription: "recall",
        storeDescription: "store",
        forgetDescription: "forget",
        scopes: {
          aditi_personal: {
            namespace: "multi-agent-demo",
            userId: "aditi",
            summaryViewName: "summary_aditi_personal",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
          household: {
            namespace: "multi-agent-demo",
            userId: "household",
            summaryViewName: "summary_household",
            summaryTimeWindowDays: 30,
            summaryGroupBy: ["user_id"],
          },
        },
        agentScopes: {
          grocery: {
            primaryScope: "household",
          },
        },
      },
      { sessionKey: "agent:grocery:main" },
    );

    expect(groceryPlan.primaryScope.key).toBe("household");
    expect(groceryPlan.recallScopes.map((scope) => scope.key)).toEqual(["household"]);
  });
});

describe("timestamp-based message filtering", () => {
  test("filters messages newer than cutoff timestamp", () => {
    const cutoffTs = 1706900000000;
    const messages = [
      { role: "user" as const, content: "Old message", id: "1", created_at: new Date(cutoffTs - 1000).toISOString() },
      { role: "user" as const, content: "At cutoff", id: "2", created_at: new Date(cutoffTs).toISOString() },
      { role: "user" as const, content: "New message", id: "3", created_at: new Date(cutoffTs + 1000).toISOString() },
    ];

    const newMessages = messages.filter((m) => {
      const msgTs = m.created_at ? new Date(m.created_at).getTime() : 0;
      return msgTs > cutoffTs;
    });

    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].id).toBe("3");
  });

  test("returns all messages when cutoff is 0", () => {
    const cutoffTs = 0;
    const messages = [
      { role: "user" as const, content: "Message 1", id: "1", created_at: new Date(1000).toISOString() },
      { role: "user" as const, content: "Message 2", id: "2", created_at: new Date(2000).toISOString() },
    ];

    const newMessages = messages.filter((m) => {
      const msgTs = m.created_at ? new Date(m.created_at).getTime() : 0;
      return msgTs > cutoffTs;
    });

    expect(newMessages).toHaveLength(2);
  });

  test("handles missing created_at gracefully", () => {
    const cutoffTs = 1706900000000;
    const messages = [
      { role: "user" as const, content: "No timestamp", id: "1" },
      { role: "user" as const, content: "Has timestamp", id: "2", created_at: new Date(cutoffTs + 1000).toISOString() },
    ];

    const newMessages = messages.filter((m) => {
      const msgTs = (m as any).created_at ? new Date((m as any).created_at).getTime() : 0;
      return msgTs > cutoffTs;
    });

    // Message without timestamp gets 0, which is < cutoffTs, so filtered out
    expect(newMessages).toHaveLength(1);
    expect(newMessages[0].id).toBe("2");
  });
});

// ============================================================================
// Story 05: provider integration & capability gating (mocked, fully offline)
// ============================================================================
//
// These tests exercise register()'s provider wiring without any network by
// mocking ./providers/factory.js so createProvider returns a fake
// MemoryProvider whose capabilities and method behaviors the test controls.
// A couple of tests use the REAL factory (registration only, which makes no
// network calls) to verify the backend-aware registration log and warning.

type CapturedLogs = {
  info: string[];
  warn: string[];
  error: string[];
  debug: string[];
  all: string[];
};

type FakeApiHarness = {
  api: any;
  tools: Array<{ tool: any; opts: any }>;
  hooks: Record<string, any[]>;
  services: any[];
  logs: CapturedLogs;
};

/** Reusable fake PluginApi that captures tools, hooks, services, and logs. */
function createFakeApi(pluginConfig: Record<string, unknown>): FakeApiHarness {
  const tools: Array<{ tool: any; opts: any }> = [];
  const hooks: Record<string, any[]> = {};
  const services: any[] = [];
  const logs: CapturedLogs = { info: [], warn: [], error: [], debug: [], all: [] };
  const record = (level: "info" | "warn" | "error" | "debug", msg: string) => {
    logs[level].push(msg);
    logs.all.push(`[${level}] ${msg}`);
  };
  const api = {
    id: "redis-memory",
    name: "Redis Memory",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      info: (m: string) => record("info", m),
      warn: (m: string) => record("warn", m),
      error: (m: string) => record("error", m),
      debug: (m: string) => record("debug", m),
    },
    registerTool: (tool: any, opts: any) => tools.push({ tool, opts }),
    registerService: (service: any) => services.push(service),
    on: (name: string, handler: any) => {
      (hooks[name] ??= []).push(handler);
    },
    resolvePath: (p: string) => p,
  };
  return { api, tools, hooks, services, logs };
}

/** Build a fake MemoryProvider; every method defaults to a no-op vi.fn(). */
function createFakeProvider(
  overrides: Omit<Partial<MemoryProvider>, "capabilities"> & {
    capabilities?: Partial<ProviderCapabilities>;
  } = {},
): MemoryProvider {
  const capabilities: ProviderCapabilities = {
    summaryViews: false,
    extractionStrategy: false,
    similarityScores: false,
    ...overrides.capabilities,
  };
  return {
    capabilities,
    healthCheck: overrides.healthCheck ?? vi.fn(async () => {}),
    searchLongTerm: overrides.searchLongTerm ?? vi.fn(async () => []),
    createLongTerm: overrides.createLongTerm ?? vi.fn(async () => ({ id: "created-id" })),
    deleteLongTerm: overrides.deleteLongTerm ?? vi.fn(async () => {}),
    findDuplicate: overrides.findDuplicate ?? vi.fn(async () => null),
    getCaptureCheckpoint: overrides.getCaptureCheckpoint ?? vi.fn(async () => 0),
    captureMessages: overrides.captureMessages ?? vi.fn(async () => {}),
    summaries: overrides.summaries,
  };
}

/** Register the plugin with ./providers/factory.js mocked to return `provider`. */
async function registerWithFakeProvider(
  pluginConfig: Record<string, unknown>,
  provider: MemoryProvider,
): Promise<FakeApiHarness & { createProvider: ReturnType<typeof vi.fn> }> {
  const createProvider = vi.fn(() => provider);
  vi.resetModules();
  vi.doMock("./providers/factory.js", () => ({ createProvider }));
  const { default: plugin } = await import("./index.js");
  const harness = createFakeApi(pluginConfig);
  await plugin.register(harness.api);
  return { ...harness, createProvider };
}

/** Register the plugin with the REAL factory (registration makes no network calls). */
async function registerWithRealProvider(
  pluginConfig: Record<string, unknown>,
): Promise<FakeApiHarness> {
  vi.resetModules();
  vi.doUnmock("./providers/factory.js");
  const { default: plugin } = await import("./index.js");
  const harness = createFakeApi(pluginConfig);
  await plugin.register(harness.api);
  return harness;
}

function buildTool(
  tools: Array<{ tool: any; opts: any }>,
  name: string,
  ctx: Record<string, unknown> = {},
) {
  const entry = tools.find((t) => t.opts?.name === name)?.tool;
  return typeof entry === "function" ? entry(ctx) : entry;
}

const SELF_HOSTED_CONFIG = { serverUrl: "http://localhost:8000", namespace: "test" };
const TOOL_CTX = { agentId: "main", sessionKey: "agent:main:main" };

describe("redis-memory plugin — provider integration (Story 05)", () => {
  afterEach(() => {
    // Undo any per-test module mocks so later tests (including describeLive)
    // get the real modules.
    vi.doUnmock("./providers/factory.js");
    vi.doUnmock("./providers/ams.js");
    vi.doUnmock("./providers/ram.js");
    vi.resetModules();
    vi.clearAllMocks();
  });

  test("factory routes provider 'cloud' → RAM and 'self-hosted' → AMS", async () => {
    vi.resetModules();
    const createAmsProvider = vi.fn(() => ({ __kind: "ams" }));
    const createRamProvider = vi.fn(() => ({ __kind: "ram" }));
    vi.doMock("./providers/ams.js", () => ({ createAmsProvider }));
    vi.doMock("./providers/ram.js", () => ({ createRamProvider }));

    const { createProvider } = await import("./providers/factory.js");

    const ram = createProvider({ provider: "cloud" } as any);
    expect(createRamProvider).toHaveBeenCalledTimes(1);
    expect(ram).toEqual({ __kind: "ram" });

    const ams = createProvider({ provider: "self-hosted" } as any);
    expect(createAmsProvider).toHaveBeenCalledTimes(1);
    expect(ams).toEqual({ __kind: "ams" });
  });

  test("cloud-resolved config logs 'backend: cloud' with storeId and never leaks apiKey", async () => {
    process.env.AGENT_MEMORY_ENDPOINT = "https://ram.example.com/memory";
    process.env.AGENT_MEMORY_API_KEY = "super-secret-key";
    process.env.AGENT_MEMORY_STORE_ID = "store-xyz";

    const { logs } = await registerWithRealProvider({});

    const line = logs.info.find((l) => l.includes("backend: cloud"));
    expect(line).toBeDefined();
    expect(line).toContain("storeId: store-xyz");
    expect(line).toContain("https://ram.example.com/memory");
    expect(line).toContain("namespace: default");
    // apiKey must never appear in any log line.
    expect(logs.all.join("\n")).not.toContain("super-secret-key");
  });

  test("self-hosted config logs 'backend: self-hosted' (no storeId)", async () => {
    const provider = createFakeProvider({
      capabilities: { summaryViews: true, extractionStrategy: true, similarityScores: true },
    });
    const { logs } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);

    const line = logs.info.find((l) => l.includes("backend: self-hosted"));
    expect(line).toBeDefined();
    expect(line).toContain("server: http://localhost:8000");
    expect(line).not.toContain("storeId");
  });

  test("summaryViews=false: before_prompt_build makes no summary calls but still injects <relevant-memories>", async () => {
    const searchLongTerm = vi.fn(async () => [
      { id: "m1", text: "User loves hiking in the mountains", score: undefined, topics: ["preference"] },
    ]);
    const provider = createFakeProvider({
      capabilities: { summaryViews: false, extractionStrategy: false, similarityScores: false },
      searchLongTerm,
      getCaptureCheckpoint: vi.fn(async () => 0),
    });
    // No `summaries` member — mirrors the RAM provider exactly.
    expect(provider.summaries).toBeUndefined();

    const { hooks } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const handler = hooks["before_prompt_build"]?.[0];
    expect(handler).toBeDefined();

    const result = await handler(
      { prompt: "what activities do I enjoy" },
      TOOL_CTX,
    );

    expect(searchLongTerm).toHaveBeenCalled();
    expect(result?.prependContext).toContain("<relevant-memories");
    expect(result?.prependContext).toContain("User loves hiking");
    // No summary was fetched or injected.
    expect(result?.prependContext).not.toContain("<user-summary>");
  });

  test("memory_recall: scoreless provider renders no percentages", async () => {
    const provider = createFakeProvider({
      capabilities: { similarityScores: false },
      searchLongTerm: vi.fn(async () => [
        { id: "1", text: "prefers tea over coffee", score: undefined },
      ]),
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const recall = buildTool(tools, "memory_recall", TOOL_CTX);

    const res = await recall.execute("c1", { query: "beverage preference", limit: 5 });
    const text = res.content[0].text;

    expect(text).toContain("prefers tea over coffee");
    expect(text).not.toContain("%");
  });

  test("memory_recall: scored provider keeps (NN%) suffix", async () => {
    const provider = createFakeProvider({
      capabilities: { similarityScores: true },
      searchLongTerm: vi.fn(async () => [
        { id: "1", text: "prefers tea over coffee", score: 0.87 },
      ]),
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const recall = buildTool(tools, "memory_recall", TOOL_CTX);

    const res = await recall.execute("c1", { query: "beverage preference", limit: 5 });
    const text = res.content[0].text;

    expect(text).toContain("prefers tea over coffee");
    expect(text).toContain("(87%)");
  });

  test("memory_store: duplicate path uses provider.findDuplicate for scored and scoreless providers", async () => {
    for (const similarityScores of [true, false]) {
      const findDuplicate = vi.fn(async () => ({ id: "dup-1", text: "existing memory text" }));
      const provider = createFakeProvider({
        capabilities: { similarityScores },
        findDuplicate,
      });
      const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
      const store = buildTool(tools, "memory_store", TOOL_CTX);

      const res = await store.execute("c1", { text: "some memory to store" });

      expect(findDuplicate).toHaveBeenCalledTimes(1);
      expect(res.details.action).toBe("duplicate");
    }
  });

  test("memory_forget: scoreless single hit auto-deletes", async () => {
    const deleteLongTerm = vi.fn(async () => {});
    const provider = createFakeProvider({
      capabilities: { similarityScores: false },
      searchLongTerm: vi.fn(async () => [
        { id: "m1", text: "old memory to remove", score: undefined },
      ]),
      deleteLongTerm,
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const forget = buildTool(tools, "memory_forget", TOOL_CTX);

    const res = await forget.execute("c1", { query: "old memory to remove" });

    expect(res.details.action).toBe("deleted");
    expect(res.details.id).toBe("m1");
    expect(deleteLongTerm).toHaveBeenCalledTimes(1);
    expect(deleteLongTerm).toHaveBeenCalledWith(["m1"], expect.anything());
  });

  test("memory_forget: scoreless multiple hits lists candidates without deleting", async () => {
    const deleteLongTerm = vi.fn(async () => {});
    const provider = createFakeProvider({
      capabilities: { similarityScores: false },
      searchLongTerm: vi.fn(async () => [
        { id: "m1", text: "memory one", score: undefined },
        { id: "m2", text: "memory two", score: undefined },
      ]),
      deleteLongTerm,
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const forget = buildTool(tools, "memory_forget", TOOL_CTX);

    const res = await forget.execute("c1", { query: "memory" });

    expect(res.details.action).toBe("candidates");
    expect(res.details.candidates).toHaveLength(2);
    expect(deleteLongTerm).not.toHaveBeenCalled();
  });

  test("memory_forget: scored provider single high-confidence hit (>0.9) auto-deletes", async () => {
    const deleteLongTerm = vi.fn(async () => {});
    const provider = createFakeProvider({
      capabilities: { similarityScores: true },
      searchLongTerm: vi.fn(async () => [
        { id: "m1", text: "old memory to remove", score: 0.95 },
      ]),
      deleteLongTerm,
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const forget = buildTool(tools, "memory_forget", TOOL_CTX);

    const res = await forget.execute("c1", { query: "old memory to remove" });

    expect(res.details.action).toBe("deleted");
    expect(res.details.id).toBe("m1");
    expect(deleteLongTerm).toHaveBeenCalledTimes(1);
    expect(deleteLongTerm).toHaveBeenCalledWith(["m1"], expect.anything());
  });

  test("memory_forget: scored provider single low-confidence hit (<=0.9) lists candidates without deleting", async () => {
    const deleteLongTerm = vi.fn(async () => {});
    const provider = createFakeProvider({
      capabilities: { similarityScores: true },
      searchLongTerm: vi.fn(async () => [
        { id: "m1", text: "maybe this memory", score: 0.5 },
      ]),
      deleteLongTerm,
    });
    const { tools } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const forget = buildTool(tools, "memory_forget", TOOL_CTX);

    const res = await forget.execute("c1", { query: "maybe this memory" });

    // Exactly one hit, but below the 0.9 confidence threshold → do NOT auto-delete.
    expect(res.details.action).toBe("candidates");
    expect(res.details.candidates).toHaveLength(1);
    expect(deleteLongTerm).not.toHaveBeenCalled();
  });

  test("cloud + ignored options logs exactly one warning at registration", async () => {
    process.env.AGENT_MEMORY_ENDPOINT = "https://ram.example.com/memory";
    process.env.AGENT_MEMORY_API_KEY = "super-secret-key";
    process.env.AGENT_MEMORY_STORE_ID = "store-xyz";

    const { logs } = await registerWithRealProvider({ extractionStrategy: "summary" });

    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]).toContain("extractionStrategy");
    expect(logs.warn[0]).toContain("ignored");
  });

  test("agent_end captures new messages via provider.captureMessages (no refreshView when summaryless)", async () => {
    const captureMessages = vi.fn(async () => {});
    const provider = createFakeProvider({
      capabilities: { summaryViews: false, extractionStrategy: false, similarityScores: false },
      captureMessages,
      getCaptureCheckpoint: vi.fn(async () => 0),
    });
    const { hooks } = await registerWithFakeProvider(SELF_HOSTED_CONFIG, provider);
    const handler = hooks["agent_end"]?.[0];
    expect(handler).toBeDefined();

    await handler(
      {
        success: true,
        messages: [{ role: "user", content: "I love hiking", timestamp: 1000, id: "a" }],
      },
      TOOL_CTX,
    );

    expect(captureMessages).toHaveBeenCalledTimes(1);
    const [, capturedMsgs] = captureMessages.mock.calls[0];
    expect(capturedMsgs[0].content).toBe("I love hiking");
    // summaryViews=false + no summaries member: no crash, no summary refresh.
    expect(provider.summaries).toBeUndefined();
  });
});

// Live tests that require agent-memory-server running
describeLive("redis-memory plugin live tests", () => {
  test("memory tools work end-to-end", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const testNamespace = `test-${randomUUID().slice(0, 8)}`;

    // Mock plugin API
    const registeredTools: any[] = [];
    const registeredServices: any[] = [];
    const registeredHooks: Record<string, any[]> = {};
    const logs: string[] = [];

    const mockApi = {
      id: "redis-memory",
      name: "Redis Memory",
      source: "test",
      config: {},
      pluginConfig: {
        serverUrl: MEMORY_SERVER_URL,
        ...(MEMORY_SERVER_API_KEY ? { apiKey: MEMORY_SERVER_API_KEY } : {}),
        ...(MEMORY_SERVER_BEARER_TOKEN ? { bearerToken: MEMORY_SERVER_BEARER_TOKEN } : {}),
        namespace: testNamespace,
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      on: (hookName: string, handler: any) => {
        if (!registeredHooks[hookName]) registeredHooks[hookName] = [];
        registeredHooks[hookName].push(handler);
      },
      resolvePath: (p: string) => p,
    };

    // Register plugin
    await memoryPlugin.register(mockApi as any);

    // Check registration
    expect(registeredTools.length).toBe(3);
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_recall");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_store");
    expect(registeredTools.map((t) => t.opts?.name)).toContain("memory_forget");
    expect(registeredServices.length).toBe(1);

    const buildTool = (name: string, ctx: Record<string, unknown> = {}) => {
      const entry = registeredTools.find((t) => t.opts?.name === name)?.tool;
      return typeof entry === "function" ? entry(ctx) : entry;
    };

    // Get tool functions
    const storeTool = buildTool("memory_store", { agentId: "main", sessionKey: "agent:main:main" });
    const recallTool = buildTool("memory_recall", { agentId: "main", sessionKey: "agent:main:main" });
    const forgetTool = buildTool("memory_forget", { agentId: "main", sessionKey: "agent:main:main" });

    // Use unique text per test run to avoid conflicts with previous runs
    const uniqueId = randomUUID().slice(0, 8);
    const testText = `User prefers xyzzy-${uniqueId} theme for applications`;

    // Test store
    const storeResult = await storeTool.execute("test-call-1", {
      text: testText,
      category: "preference",
    });

    expect(storeResult.details?.action).toBe("created");
    expect(storeResult.details?.id).toBeDefined();
    const storedId = storeResult.details?.id;

    // Wait a moment for indexing
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test recall
    const recallResult = await recallTool.execute("test-call-2", {
      query: `xyzzy-${uniqueId} theme`,
      limit: 5,
    });

    expect(recallResult.details?.count).toBeGreaterThan(0);
    expect(recallResult.details?.memories?.[0]?.text).toContain(uniqueId);

    // Test duplicate detection
    const duplicateResult = await storeTool.execute("test-call-3", {
      text: testText,
    });

    expect(duplicateResult.details?.action).toBe("duplicate");

    // Test forget
    const forgetResult = await forgetTool.execute("test-call-4", {
      memoryId: storedId,
    });

    expect(forgetResult.details?.action).toBe("deleted");
    expect(forgetResult.details?.id).toBe(storedId);

    // Wait for deletion to propagate
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify the deleted memory is gone by searching for it
    const recallAfterForget = await recallTool.execute("test-call-5", {
      query: `xyzzy-${uniqueId} theme`,
      limit: 5,
    });

    // The deleted memory should not appear in results
    const foundDeletedMemory = recallAfterForget.details?.memories?.find(
      (m: { id: string }) => m.id === storedId,
    );
    expect(foundDeletedMemory).toBeUndefined();
  }, 60000);

  test("service health check works", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const registeredServices: any[] = [];
    const logs: string[] = [];

    const mockApi = {
      id: "redis-memory",
      name: "Redis Memory",
      source: "test",
      config: {},
      pluginConfig: {
        serverUrl: MEMORY_SERVER_URL,
        ...(MEMORY_SERVER_API_KEY ? { apiKey: MEMORY_SERVER_API_KEY } : {}),
        ...(MEMORY_SERVER_BEARER_TOKEN ? { bearerToken: MEMORY_SERVER_BEARER_TOKEN } : {}),
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      registerTool: () => {},
      registerCli: () => {},
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      on: () => {},
      resolvePath: (p: string) => p,
    };

    await memoryPlugin.register(mockApi as any);

    expect(registeredServices.length).toBe(1);

    // Start the service to trigger health check
    await registeredServices[0].start();

    // Check that connection was logged
    const connectedLog = logs.find((l) => l.includes("connected to server"));
    expect(connectedLog).toBeDefined();
  }, 30000);

  test("summary view is initialized on service start", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const testNamespace = `test-summary-${randomUUID().slice(0, 8)}`;
    const testViewName = `test_view_${randomUUID().slice(0, 8)}`;

    const registeredServices: any[] = [];
    const logs: string[] = [];

    const mockApi = {
      id: "redis-memory",
      name: "Redis Memory",
      source: "test",
      config: {},
      pluginConfig: {
        serverUrl: MEMORY_SERVER_URL,
        ...(MEMORY_SERVER_API_KEY ? { apiKey: MEMORY_SERVER_API_KEY } : {}),
        ...(MEMORY_SERVER_BEARER_TOKEN ? { bearerToken: MEMORY_SERVER_BEARER_TOKEN } : {}),
        namespace: testNamespace,
        summaryViewName: testViewName,
        summaryTimeWindowDays: 7,
      },
      runtime: {},
      logger: {
        info: (msg: string) => logs.push(`[info] ${msg}`),
        warn: (msg: string) => logs.push(`[warn] ${msg}`),
        error: (msg: string) => logs.push(`[error] ${msg}`),
        debug: (msg: string) => logs.push(`[debug] ${msg}`),
      },
      registerTool: () => {},
      registerCli: () => {},
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      on: () => {},
      resolvePath: (p: string) => p,
    };

    await memoryPlugin.register(mockApi as any);

    // Start the service to trigger summary view initialization
    await registeredServices[0].start();

    // Check that summary view was created or found
    const summaryLog = logs.find(
      (l) => l.includes("summary view") && l.includes(testViewName),
    );
    expect(summaryLog).toBeDefined();
  }, 30000);
});
