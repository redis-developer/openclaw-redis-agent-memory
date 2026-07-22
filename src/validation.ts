import { createHash } from "node:crypto";

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_RECALL_LIMIT = 100;
export const MAX_CONFIG_SCOPES = 32;
export const MAX_AGENT_ROUTES = 128;
export const MAX_ROUTE_SCOPES = 32;
export const MAX_IDENTIFIER_CHARS = 64;
export const MAX_ACTOR_ID_CHARS = 255;
export const MAX_MEMORY_TEXT_CHARS = 50_000;
export const MAX_SEARCH_TEXT_CHARS = 50_000;
export const MAX_TOPIC_COUNT = 50;
export const MAX_TOPIC_CHARS = 100;
export const MAX_PAGE_TOKEN_CHARS = 4_096;
export const MAX_EVENT_METADATA_BYTES = 16 * 1024;
export const MAX_CUSTOM_PROMPT_CHARS = 20_000;
export const MAX_DESCRIPTION_CHARS = 4_000;
export const MAX_SERVER_URL_CHARS = 2_048;
export const MAX_INJECTED_CONTEXT_CHARS = 32_000;
export const MAX_SUCCESS_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export const SERVICE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+$/;
export const CONFIG_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const GENERIC_IDENTIFIER_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

export class MemoryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryInputError";
  }
}

type StringBounds = {
  min?: number;
  max?: number;
  pattern?: RegExp;
};

export function assertBoundedString(
  value: unknown,
  label: string,
  bounds: StringBounds = {},
): asserts value is string {
  if (typeof value !== "string") {
    throw new MemoryInputError(`${label} must be a string`);
  }
  const min = bounds.min ?? 0;
  if (value.length < min) {
    throw new MemoryInputError(`${label} must be at least ${min} character${min === 1 ? "" : "s"}`);
  }
  if (bounds.max !== undefined && value.length > bounds.max) {
    throw new MemoryInputError(`${label} must be at most ${bounds.max} characters`);
  }
  if (bounds.pattern && !bounds.pattern.test(value)) {
    throw new MemoryInputError(`${label} contains unsupported characters`);
  }
}

export function assertServiceIdentifier(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, {
    min: 1,
    max: MAX_IDENTIFIER_CHARS,
    pattern: SERVICE_IDENTIFIER_PATTERN,
  });
}

export function assertGenericIdentifier(value: unknown, label: string): asserts value is string {
  assertBoundedString(value, label, {
    min: 1,
    max: MAX_ACTOR_ID_CHARS,
    pattern: GENERIC_IDENTIFIER_PATTERN,
  });
}

export function assertMemoryText(value: unknown, label = "text"): asserts value is string {
  assertBoundedString(value, label, { min: 1, max: MAX_MEMORY_TEXT_CHARS });
  if (!value.trim()) throw new MemoryInputError(`${label} must not be blank`);
}

export function assertSearchText(value: unknown, label = "query"): asserts value is string {
  assertBoundedString(value, label, { min: 1, max: MAX_SEARCH_TEXT_CHARS });
  if (!value.trim()) throw new MemoryInputError(`${label} must not be blank`);
}

export function assertIntegerInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MemoryInputError(`${label} must be a finite integer`);
  }
  if (value < minimum || value > maximum) {
    throw new MemoryInputError(`${label} must be between ${minimum} and ${maximum}`);
  }
}

export function assertNumberInRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MemoryInputError(`${label} must be a finite number`);
  }
  if (value < minimum || value > maximum) {
    throw new MemoryInputError(`${label} must be between ${minimum} and ${maximum}`);
  }
}

export function assertTopics(value: unknown, label = "topics"): asserts value is string[] {
  if (!Array.isArray(value)) throw new MemoryInputError(`${label} must be an array`);
  if (value.length > MAX_TOPIC_COUNT) {
    throw new MemoryInputError(`${label} must contain at most ${MAX_TOPIC_COUNT} topics`);
  }
  value.forEach((topic, index) => {
    assertBoundedString(topic, `${label}[${index}]`, { min: 1, max: MAX_TOPIC_CHARS });
    if (!topic.trim()) throw new MemoryInputError(`${label}[${index}] must not be blank`);
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part)) && Number(octets[0]) === 127;
}

export function validateServerUrl(
  value: unknown,
  provider: "cloud" | "self-hosted",
): string {
  assertBoundedString(value, "serverUrl", { min: 1, max: MAX_SERVER_URL_CHARS });
  if (value !== value.trim()) throw new MemoryInputError("serverUrl must not have surrounding whitespace");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new MemoryInputError("serverUrl must not contain control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MemoryInputError("serverUrl must be an absolute HTTP(S) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new MemoryInputError("serverUrl must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new MemoryInputError("serverUrl must not contain embedded credentials");
  }
  if (parsed.hash) throw new MemoryInputError("serverUrl must not contain a fragment");
  if (parsed.search) throw new MemoryInputError("serverUrl must not contain query parameters");

  if (provider === "cloud") {
    if (parsed.protocol !== "https:") {
      throw new MemoryInputError("cloud serverUrl must use HTTPS");
    }
    if (parsed.pathname !== "/") {
      throw new MemoryInputError("cloud serverUrl must not contain a path");
    }
  } else if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new MemoryInputError(
      "self-hosted HTTP serverUrl is allowed only for localhost or loopback development endpoints; use HTTPS otherwise",
    );
  }

  return value;
}

export function normalizeExternalMessageId(value: unknown, seed: string): string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    SERVICE_IDENTIFIER_PATTERN.test(value)
  ) {
    return value;
  }
  return `oc-msg-${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 56)}`;
}

function redactKnownPatterns(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api[_-]?key|bearer[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

export function redactSecrets(value: string, secrets: Array<string | undefined>): string {
  let redacted = redactKnownPatterns(value);
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function safeErrorMessage(
  error: unknown,
  secrets: Array<string | undefined> = [],
): string {
  const rawName = error instanceof Error && error.name ? error.name : "Error";
  const name = stripControlCharacters(redactSecrets(rawName, secrets)).slice(0, 100);
  const rawMessage = error instanceof Error ? error.message : "request failed";
  const status =
    error && typeof error === "object" &&
      typeof (error as { status?: unknown }).status === "number"
      ? ` status=${(error as { status: number }).status}`
      : "";
  const message = stripControlCharacters(redactSecrets(rawMessage, secrets)).slice(0, 500);
  return `${name}${status}: ${message}`;
}

export function sanitizeErrorBody(
  body: unknown,
  secrets: Array<string | undefined> = [],
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return typeof body === "string"
      ? stripControlCharacters(redactSecrets(body, secrets)).slice(0, 1_000)
      : undefined;
  }
  const source = body as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["title", "detail", "type", "status"]) {
    const value = source[key];
    if (typeof value === "string") {
      safe[key] = stripControlCharacters(redactSecrets(value, secrets)).slice(0, 1_000);
    }
    else if (key === "status" && typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}
