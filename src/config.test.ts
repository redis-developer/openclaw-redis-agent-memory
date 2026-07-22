/**
 * Tests for provider resolution, RAM credentials, and env fallbacks in
 * src/config.ts (Story 04).
 *
 * Env isolation: every test that touches AGENT_MEMORY_ENDPOINT /
 * AGENT_MEMORY_API_KEY / AGENT_MEMORY_STORE_ID must not leak into (or be
 * polluted by) the developer's shell environment. beforeEach clears them;
 * afterEach restores whatever was there before.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { parseMemoryConfig } from "./config.js";

const ENV_KEYS = [
  "AGENT_MEMORY_ENDPOINT",
  "AGENT_MEMORY_API_KEY",
  "AGENT_MEMORY_STORE_ID",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("parseMemoryConfig — provider resolution", () => {
  const validCloud = {
    provider: "cloud",
    serverUrl: "https://cloud.example.com",
    apiKey: "valid-api-key",
    storeId: "valid-store-id",
  } as const;

  test("rejects an empty workingMemorySessionId", () => {
    expect(() =>
      parseMemoryConfig({
        serverUrl: "http://localhost:8000",
        workingMemorySessionId: "   ",
      }),
    ).toThrow(/workingMemorySessionId must not be empty/);
  });

  test("rejects an empty workingMemorySessionId inside a named scope", () => {
    expect(() =>
      parseMemoryConfig({
        serverUrl: "http://localhost:8000",
        scopes: { personal: { workingMemorySessionId: "" } },
      }),
    ).toThrow(/scope "personal" workingMemorySessionId must not be empty/);
  });

  test("legacy config with only serverUrl resolves to self-hosted with existing defaults intact", () => {
    const config = parseMemoryConfig({ serverUrl: "http://localhost:8000" });

    expect(config.provider).toBe("self-hosted");
    expect(config.serverUrl).toBe("http://localhost:8000");
    expect(config.timeout).toBe(30000);
    expect(config.minScore).toBe(0.3);
    expect(config.recallLimit).toBe(3);
    expect(config.autoCapture).toBe(true);
    expect(config.autoRecall).toBe(true);
    expect(config.summaryViewName).toBe("agent_user_summary");
    expect(config.summaryTimeWindowDays).toBe(30);
    expect(config.cloudIgnoredOptions).toEqual([]);
    expect(config.assistantCapture).toBe("include");
    expect(config.sensitiveDataRedaction).toBe(false);
    expect(config.recallRecordMaxChars).toBe(2000);
    expect(config.recallContextMaxChars).toBe(16000);
    expect(config.erasureSettleMs).toBe(2000);
  });

  test("parses privacy controls and per-scope opt-outs strictly", () => {
    const config = parseMemoryConfig({
      serverUrl: "http://localhost:8000",
      assistantCapture: "include",
      sensitiveDataRedaction: true,
      sessionRetentionSeconds: 3600,
      recallRecordMaxChars: 512,
      recallContextMaxChars: 4096,
      erasureSettleMs: 0,
      scopes: {
        private: {
          autoRecall: false,
          autoCapture: false,
          assistantCapture: "exclude",
          sensitiveDataRedaction: false,
          sessionRetentionSeconds: 600,
        },
      },
    });
    expect(config.sessionRetentionSeconds).toBe(3600);
    expect(config.scopes?.private).toMatchObject({
      autoRecall: false,
      autoCapture: false,
      assistantCapture: "exclude",
      sensitiveDataRedaction: false,
      sessionRetentionSeconds: 600,
    });
  });

  test.each([
    [{ assistantCapture: "sometimes" }, /assistantCapture must be exclude or include/],
    [{ sensitiveDataRedaction: "yes" }, /sensitiveDataRedaction must be a boolean/],
    [{ sessionRetentionSeconds: 59 }, /sessionRetentionSeconds must be between 60/],
    [{ recallRecordMaxChars: 127 }, /recallRecordMaxChars must be between 128/],
    [{ recallContextMaxChars: 1000 }, /recallContextMaxChars must be between 1024/],
    [{ recallRecordMaxChars: 5000, recallContextMaxChars: 4000 }, /must not exceed/],
    [{ erasureSettleMs: 60001 }, /erasureSettleMs must be between 0 and 60000/],
  ])("rejects invalid privacy config %#", (partial, expected) => {
    expect(() => parseMemoryConfig({ serverUrl: "http://localhost:8000", ...partial })).toThrow(expected);
  });

  test("rejects session retention for RAM cloud instead of pretending it applies", () => {
    expect(() => parseMemoryConfig({
      ...validCloud,
      sessionRetentionSeconds: 3600,
    })).toThrow(/not supported by the cloud provider/);
    expect(() => parseMemoryConfig({
      ...validCloud,
      scopes: { private: { sessionRetentionSeconds: 3600 } },
    })).toThrow(/not supported by the cloud provider/);
  });

  test("empty config with all three env vars set resolves to cloud using env values", () => {
    process.env.AGENT_MEMORY_ENDPOINT = "https://cloud.example.com";
    process.env.AGENT_MEMORY_API_KEY = "env-api-key";
    process.env.AGENT_MEMORY_STORE_ID = "env-store-id";

    const config = parseMemoryConfig({});

    expect(config.provider).toBe("cloud");
    expect(config.serverUrl).toBe("https://cloud.example.com");
    expect(config.apiKey).toBe("env-api-key");
    expect(config.storeId).toBe("env-store-id");
    expect(config.cloudIgnoredOptions).toEqual([]);
  });

  test("empty config with no env set throws naming all three missing fields", () => {
    expect(() => parseMemoryConfig({})).toThrow(
      /Missing: serverUrl \(set it or AGENT_MEMORY_ENDPOINT\), apiKey \(set it or AGENT_MEMORY_API_KEY\), storeId \(set it or AGENT_MEMORY_STORE_ID\)/,
    );
  });

  test("throws a single actionable error naming the default backend and self-hosted alternative", () => {
    try {
      parseMemoryConfig({});
      throw new Error("expected parseMemoryConfig to throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(
        "Redis Agent Memory (cloud) is the default backend and requires serverUrl, apiKey, storeId.",
      );
      expect(message).toContain(
        'To use a self-hosted agent-memory-server instead, set "provider": "self-hosted".',
      );
    }
  });

  test("partial cloud config (apiKey via env, storeId in config) throws naming only serverUrl", () => {
    process.env.AGENT_MEMORY_API_KEY = "env-api-key";

    expect(() =>
      parseMemoryConfig({ provider: "cloud", storeId: "explicit-store-id" }),
    ).toThrow(/Missing: serverUrl \(set it or AGENT_MEMORY_ENDPOINT\)\./);
  });

  test("explicit provider self-hosted wins over inference even with storeId env set", () => {
    process.env.AGENT_MEMORY_STORE_ID = "env-store-id";

    const config = parseMemoryConfig({
      provider: "self-hosted",
      serverUrl: "http://localhost:8000",
    });

    expect(config.provider).toBe("self-hosted");
    expect(config.serverUrl).toBe("http://localhost:8000");
    // storeId env fallback is cloud-only; self-hosted doesn't pick it up.
    expect(config.storeId).toBeUndefined();
  });

  test("invalid provider value throws listing the two valid values", () => {
    expect(() => parseMemoryConfig({ provider: "on-prem" })).toThrow(
      /Invalid provider: on-prem\. Must be one of: cloud, self-hosted/,
    );
  });

  test("explicit provider cloud with bearerToken set throws and points to apiKey", () => {
    expect(() =>
      parseMemoryConfig({
        provider: "cloud",
        serverUrl: "https://cloud.example.com",
        apiKey: "valid-api-key",
        storeId: "valid-store-id",
        bearerToken: "some-token",
      }),
    ).toThrow(/apiKey/);
  });

  test("cloud config with extractionStrategy set parses fine and records cloudIgnoredOptions", () => {
    const config = parseMemoryConfig({
      provider: "cloud",
      serverUrl: "https://cloud.example.com",
      apiKey: "valid-api-key",
      storeId: "valid-store-id",
      extractionStrategy: "summary",
    });

    expect(config.provider).toBe("cloud");
    expect(config.extractionStrategy).toBe("summary");
    expect(config.cloudIgnoredOptions).toContain("extractionStrategy");
  });

  test("cloudIgnoredOptions detects options set only inside a scope, deduplicated, bare names", () => {
    const config = parseMemoryConfig({
      provider: "cloud",
      serverUrl: "https://cloud.example.com",
      apiKey: "valid-api-key",
      storeId: "valid-store-id",
      summaryTimeWindowDays: 14,
      scopes: {
        personal: {
          userId: "aditi",
          extractionStrategy: "preferences",
          summaryGroupBy: ["namespace"],
        },
        household: {
          userId: "household",
          extractionStrategy: "discrete",
        },
      },
    });

    // summaryTimeWindowDays set top-level, extractionStrategy + summaryGroupBy set inside scopes.
    expect(config.cloudIgnoredOptions.sort()).toEqual(
      ["extractionStrategy", "summaryGroupBy", "summaryTimeWindowDays"].sort(),
    );
    // Each option appears exactly once even though extractionStrategy is set in two scopes.
    expect(
      config.cloudIgnoredOptions.filter((o) => o === "extractionStrategy"),
    ).toHaveLength(1);
  });

  test("self-hosted config never populates cloudIgnoredOptions even when cloud-incompatible options are set", () => {
    const config = parseMemoryConfig({
      serverUrl: "http://localhost:8000",
      extractionStrategy: "summary",
    });

    expect(config.provider).toBe("self-hosted");
    expect(config.cloudIgnoredOptions).toEqual([]);
  });

  test("${VAR} substitution works for storeId", () => {
    process.env.CONFIG_TEST_STORE_ID = "substituted-store-id";

    const config = parseMemoryConfig({
      provider: "cloud",
      serverUrl: "https://cloud.example.com",
      apiKey: "valid-api-key",
      storeId: "${CONFIG_TEST_STORE_ID}",
    });

    expect(config.storeId).toBe("substituted-store-id");

    delete process.env.CONFIG_TEST_STORE_ID;
  });

  test("rejects an input config containing cloudIgnoredOptions as an unknown key", () => {
    expect(() =>
      parseMemoryConfig({
        serverUrl: "http://localhost:8000",
        cloudIgnoredOptions: ["extractionStrategy"],
      }),
    ).toThrow(/unknown keys.*cloudIgnoredOptions/i);
  });

  test.each([
    ["malformed", "not a URL", /absolute HTTP/],
    ["insecure cloud", "http://cloud.example.com", /must use HTTPS/],
    ["credentials", "https://user:password@cloud.example.com", /embedded credentials/],
    ["fragment", "https://cloud.example.com/#secret", /fragment/],
    ["query", "https://cloud.example.com/?token=secret", /query parameters/],
    ["path", "https://cloud.example.com/api", /must not contain a path/],
    ["unsupported scheme", "ftp://cloud.example.com", /HTTP or HTTPS/],
  ])("rejects %s cloud URLs", (_label, serverUrl, expected) => {
    expect(() => parseMemoryConfig({ ...validCloud, serverUrl })).toThrow(expected);
  });

  test("allows self-hosted HTTP only on loopback hosts", () => {
    for (const serverUrl of [
      "http://localhost:8000",
      "http://dev.localhost:8000",
      "http://127.44.1.9:8000",
      "http://[::1]:8000",
    ]) {
      expect(parseMemoryConfig({ provider: "self-hosted", serverUrl }).serverUrl).toBe(serverUrl);
    }
    expect(() =>
      parseMemoryConfig({ provider: "self-hosted", serverUrl: "http://10.0.0.8:8000" }),
    ).toThrow(/loopback/);
    expect(
      parseMemoryConfig({ provider: "self-hosted", serverUrl: "https://memory.internal" }).serverUrl,
    ).toBe("https://memory.internal");
  });

  test.each([
    ["apiKey", "   ", /apiKey must not be blank/],
    ["storeId", "bad/store", /storeId contains unsupported characters/],
    ["storeId", "x".repeat(65), /at most 64/],
    ["namespace", "bad_namespace", /namespace contains unsupported characters/],
    ["userId", "alice@example.com", /userId contains unsupported characters/],
    ["workingMemorySessionId", "session:one", /workingMemorySessionId contains unsupported/],
  ])("rejects invalid cloud %s", (field, value, expected) => {
    expect(() => parseMemoryConfig({ ...validCloud, [field]: value })).toThrow(expected);
  });

  test.each([
    ["timeout", 0, /between 100 and 120000/],
    ["timeout", -1, /between 100 and 120000/],
    ["timeout", 120_001, /between 100 and 120000/],
    ["timeout", 100.5, /finite integer/],
    ["recallLimit", 0, /between 1 and 100/],
    ["recallLimit", 101, /between 1 and 100/],
    ["recallLimit", 1.5, /finite integer/],
    ["minScore", -0.1, /between 0 and 1/],
    ["minScore", 1.1, /between 0 and 1/],
  ])("rejects out-of-contract numeric config %s=%s", (field, value, expected) => {
    expect(() => parseMemoryConfig({ ...validCloud, [field]: value })).toThrow(expected);
  });

  test.each([
    ["timeout", "30000"],
    ["autoCapture", "true"],
    ["namespace", 42],
    ["summaryGroupBy", "namespace"],
  ])("rejects wrong-type config field %s", (field, value) => {
    expect(() => parseMemoryConfig({ ...validCloud, [field]: value })).toThrow();
  });

  test("bounds configured scopes and route lists", () => {
    const tooManyScopes = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`scope_${index}`, {}]),
    );
    expect(() => parseMemoryConfig({ ...validCloud, scopes: tooManyScopes })).toThrow(/between 1 and 32/);
    expect(() => parseMemoryConfig({
      ...validCloud,
      scopes: { one: {} },
      agentScopes: {
        main: {
          primaryScope: "one",
          recallScopes: Array.from({ length: 33 }, () => "one"),
        },
      },
    })).toThrow(/at most 32/);
  });

  test("configuration failures never echo configured secrets", () => {
    const secret = "do-not-print-this-key";
    let message = "";
    try {
      parseMemoryConfig({
        ...validCloud,
        apiKey: secret,
        serverUrl: "https://user:password@cloud.example.com",
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain(secret);
    expect(message).not.toContain("password");
  });

  test("bounded numeric fuzz cases fail deterministically instead of being coerced", () => {
    const invalidNumbers = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      ...Array.from({ length: 50 }, (_, index) => index + 0.25),
    ];
    for (const timeout of invalidNumbers) {
      expect(() => parseMemoryConfig({ ...validCloud, timeout })).toThrow();
    }
  });
});
