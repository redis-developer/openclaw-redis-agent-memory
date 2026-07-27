/**
 * Provider factory: selects the backend implementation from resolved config.
 *
 * The plugin core (`index.ts`) constructs its provider only through this
 * function, so backend selection lives in exactly one place. Config resolution
 * (Story 04) has already decided `cfg.provider`; this just maps it to the
 * matching implementation. `"cloud"` → Redis Agent Memory (RAM); anything else
 * (`"self-hosted"`) → the open-source agent-memory-server (AMS).
 */

import type { MemoryConfig } from "../config.js";
import type { PluginLogger } from "../types.js";
import type { MemoryProvider } from "../provider.js";
import { createAmsProvider } from "./ams.js";
import { createRamProvider } from "./ram.js";

export function createProvider(cfg: MemoryConfig, logger?: PluginLogger): MemoryProvider {
  return cfg.provider === "cloud" ? createRamProvider(cfg, logger) : createAmsProvider(cfg, logger);
}
