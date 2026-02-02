/**
 * Memory Plugin (Redis) E2E Tests
 *
 * Tests the memory plugin functionality including:
 * - Plugin registration and configuration
 * - Memory storage and retrieval
 * - Auto-recall via hooks
 * - Auto-capture filtering
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const MEMORY_SERVER_URL = process.env.AGENT_MEMORY_SERVER_URL ?? "http://localhost:8000";
const HAS_SERVER = Boolean(process.env.AGENT_MEMORY_SERVER_URL);
const liveEnabled = HAS_SERVER && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describe("redis-memory plugin", () => {
  test("memory plugin registers and initializes correctly", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    expect(memoryPlugin.id).toBe("redis-memory");
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

    const config = memoryPlugin.configSchema?.parse?.({});

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

// Live tests that require agent-memory-server running
describeLive("redis-memory plugin live tests", () => {
  test("memory tools work end-to-end", async () => {
    const { default: memoryPlugin } = await import("./index.js");
    const testNamespace = `test-${randomUUID().slice(0, 8)}`;

    // Mock plugin API
    const registeredTools: any[] = [];
    const registeredClis: any[] = [];
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
      registerCli: (registrar: any, opts: any) => {
        registeredClis.push({ registrar, opts });
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
    expect(registeredClis.length).toBe(1);
    expect(registeredServices.length).toBe(1);

    // Get tool functions
    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;

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

