import {
  AgentMemoryError,
  RequestTimeoutError,
} from "@redis-iris/agent-memory/models/errors";

import { redactSecrets, sanitizeErrorBody } from "../validation.js";

function sanitizeMessage(value: string, secrets: Array<string | undefined>): string {
  return redactSecrets(value, secrets)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, 1_000);
}

function parseErrorBody(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function errorMessage(error: unknown, secrets: Array<string | undefined>): string {
  let message: string;
  if (error && typeof error === "object") {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim()) message = detail;
    else {
      const title = (error as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) message = title;
      else message = error instanceof Error ? error.message : "RAM request failed";
    }
  } else {
    message = error instanceof Error ? error.message : "RAM request failed";
  }
  return sanitizeMessage(message, secrets);
}

function safeCause(error: unknown, secrets: Array<string | undefined>): Error | undefined {
  if (!(error instanceof Error)) return undefined;
  const nested = (error as Error & { cause?: unknown }).cause;
  const source =
    nested instanceof Error && nested.name === "RamResponseTooLargeError"
      ? nested
      : error;
  const snapshot = new Error(sanitizeMessage(source.message, secrets));
  snapshot.name = sanitizeMessage(source.name, secrets).slice(0, 100);
  return snapshot;
}

/** Provider-neutral error surfaced by the RAM SDK adapter. */
export class RamApiError extends Error {
  readonly status: number;
  readonly body?: unknown;
  override readonly cause?: unknown;

  constructor(message: string, status: number, body?: unknown, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RamApiError";
    this.status = status;
    this.body = body;
    this.cause = cause;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class RamTimeoutError extends RamApiError {
  constructor(message = "RAM request timed out", cause?: unknown) {
    super(message, 408, undefined, cause);
    this.name = "RamTimeoutError";
  }
}

export function normalizeRamError(
  error: unknown,
  secrets: Array<string | undefined> = [],
): RamApiError {
  if (error instanceof RamApiError) {
    return new RamApiError(
      sanitizeMessage(error.message, secrets),
      error.status,
      sanitizeErrorBody(error.body, secrets),
      safeCause(error.cause, secrets),
    );
  }
  if (error instanceof RequestTimeoutError) {
    return new RamTimeoutError(errorMessage(error, secrets), safeCause(error, secrets));
  }
  if (error instanceof AgentMemoryError) {
    return new RamApiError(
      errorMessage(error, secrets),
      error.statusCode,
      sanitizeErrorBody(parseErrorBody(error.body), secrets),
      safeCause(error, secrets),
    );
  }
  return new RamApiError(
    errorMessage(error, secrets),
    0,
    undefined,
    safeCause(error, secrets),
  );
}
