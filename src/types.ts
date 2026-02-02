/**
 * Type definitions for the agent-memory-plugin.
 *
 * These types allow the plugin to work both with OpenClaw and standalone.
 */

import { Type } from "@sinclair/typebox";

// ============================================================================
// TypeBox Helpers
// ============================================================================

type StringEnumOptions<T extends readonly string[]> = {
  description?: string;
  title?: string;
  default?: T[number];
};

/**
 * Create a TypeBox schema for a string enum.
 * Avoids Type.Union([Type.Literal(...)]) which compiles to anyOf.
 * Some providers reject anyOf in tool schemas; a flat string enum is safer.
 */
export function stringEnum<T extends readonly string[]>(
  values: T,
  options: StringEnumOptions<T> = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

// ============================================================================
// Plugin API Types (compatible with OpenClaw)
// ============================================================================

/**
 * Logger interface for the plugin.
 */
export type PluginLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

/**
 * Tool result content block.
 */
export type ToolResultContent = {
  type: "text";
  text: string;
};

/**
 * Tool result returned by tool execute functions.
 */
export type ToolResult = {
  content: ToolResultContent[];
  details?: unknown;
};

/**
 * Tool definition for registering with the plugin API.
 */
export type ToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<ToolResult>;
};

/**
 * Hook event for before_agent_start.
 */
export type BeforeAgentStartEvent = {
  prompt: string;
};

/**
 * Hook event for agent_end.
 */
export type AgentEndEvent = {
  success: boolean;
  messages?: unknown[];
};

/**
 * Hook context.
 */
export type HookContext = {
  sessionKey?: string;
};

/**
 * Hook handler function type.
 */
export type HookHandler<E> = (
  event: E,
  ctx: HookContext,
) =>
  | void
  | undefined
  | Promise<void>
  | Promise<undefined>
  | { prependContext?: string }
  | Promise<{ prependContext?: string }>
  | Promise<{ prependContext?: string } | undefined>;

/**
 * Service definition for the plugin.
 */
export type ServiceDefinition = {
  id: string;
  start: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};

/**
 * CLI registration callback.
 */
export type CliRegistration = (ctx: { program: unknown }) => void;

/**
 * Plugin API interface (compatible with OpenClaw's OpenClawPluginApi).
 */
export type PluginApi = {
  logger: PluginLogger;
  pluginConfig?: Record<string, unknown>;
  registerTool: (tool: ToolDefinition, opts?: { name?: string }) => void;
  registerCli?: (fn: CliRegistration, opts?: { commands?: string[] }) => void;
  registerService: (service: ServiceDefinition) => void;
  on: <E>(event: string, handler: HookHandler<E>) => void;
};

/**
 * Plugin definition interface.
 */
export type PluginDefinition = {
  id: string;
  name: string;
  description: string;
  kind: "memory";
  configSchema: unknown;
  register: (api: PluginApi) => void;
};

