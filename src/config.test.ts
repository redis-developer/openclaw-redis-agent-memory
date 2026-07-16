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
  });

  test("empty config with all three env vars set resolves to cloud using env values", () => {
    process.env.AGENT_MEMORY_ENDPOINT = "https://cloud.example.com/memory";
    process.env.AGENT_MEMORY_API_KEY = "env-api-key";
    process.env.AGENT_MEMORY_STORE_ID = "env-store-id";

    const config = parseMemoryConfig({});

    expect(config.provider).toBe("cloud");
    expect(config.serverUrl).toBe("https://cloud.example.com/memory");
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
        serverUrl: "https://cloud.example.com/memory",
        apiKey: "valid-api-key",
        storeId: "valid-store-id",
        bearerToken: "some-token",
      }),
    ).toThrow(/apiKey/);
  });

  test("cloud config with extractionStrategy set parses fine and records cloudIgnoredOptions", () => {
    const config = parseMemoryConfig({
      provider: "cloud",
      serverUrl: "https://cloud.example.com/memory",
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
      serverUrl: "https://cloud.example.com/memory",
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
      serverUrl: "https://cloud.example.com/memory",
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
});
