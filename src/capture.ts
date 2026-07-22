import type { PluginLogger } from "./types.js";
import {
  CaptureBatchError,
  type CaptureBatchResult,
  type CaptureCheckpoint,
  type CapturedMessage,
  type MemoryProvider,
} from "./provider.js";
import { MAX_MEMORY_TEXT_CHARS } from "./validation.js";

export const DEFAULT_CAPTURE_CONCURRENCY = 4;
export const DEFAULT_CAPTURE_CACHE_SIZE = 256;
export const DEFAULT_CAPTURE_QUEUE_SIZE = 512;
export const DEFAULT_CAPTURE_BATCH_SIZE = 256;
export const DEFAULT_CAPTURE_EVENT_BYTES = MAX_MEMORY_TEXT_CHARS;

type CaptureScope = Parameters<MemoryProvider["captureMessages"]>[2];

export type CaptureMetrics = {
  captured: number;
  duplicate: number;
  retried: number;
  dropped: number;
  permanentlyFailed: number;
  deferred: number;
};

type CaptureCoordinatorOptions = {
  concurrency?: number;
  cacheSize?: number;
  queueSize?: number;
  batchSize?: number;
  eventBytes?: number;
  readAttempts?: number;
  retryBaseMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const EMPTY_METRICS: CaptureMetrics = {
  captured: 0,
  duplicate: 0,
  retried: 0,
  dropped: 0,
  permanentlyFailed: 0,
  deferred: 0,
};

function emptyCheckpoint(): CaptureCheckpoint {
  return { maxTimestampMs: 0, messageIdsAtMax: [] };
}

function isRetryableReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  const status = candidate.status ?? candidate.statusCode;
  if (
    status === 0 ||
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) return true;
  if (
    candidate.name === "ConnectionError" ||
    candidate.name === "RequestTimeoutError" ||
    candidate.name === "FetchError"
  ) return true;
  return typeof candidate.code === "string" && [
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
  ].includes(candidate.code);
}

function advanceCheckpoint(
  checkpoint: CaptureCheckpoint,
  acceptedMessages: CapturedMessage[],
): CaptureCheckpoint {
  let maxTimestampMs = checkpoint.maxTimestampMs;
  let idsAtMax = new Set(checkpoint.messageIdsAtMax);

  for (const message of acceptedMessages) {
    if (message.timestampMs > maxTimestampMs) {
      maxTimestampMs = message.timestampMs;
      idsAtMax = new Set([message.id]);
    } else if (message.timestampMs === maxTimestampMs) {
      idsAtMax.add(message.id);
    }
  }

  return { maxTimestampMs, messageIdsAtMax: [...idsAtMax] };
}

export function truncateCapturedContent(content: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(content, "utf8");
  if (originalBytes <= maxBytes) return content;

  const marker = "\n[truncated]";
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const chunks: string[] = [];
  let usedBytes = 0;
  for (const character of content) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + bytes > contentBudget) break;
    chunks.push(character);
    usedBytes += bytes;
  }
  return chunks.join("") + marker;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
  ) {}

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(new CaptureQueueFullError("capture concurrency queue is full"));
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(() => this.release());
      return;
    }
    this.active -= 1;
  }
}

class CaptureQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureQueueFullError";
  }
}

/** Coordinates ordered, restart-safe capture without backend-specific logic. */
export class CaptureCoordinator {
  private readonly checkpoints = new Map<string, CaptureCheckpoint>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly inFlightByScope = new Map<string, Set<Promise<unknown>>>();
  private readonly semaphore: Semaphore;
  private readonly metrics: CaptureMetrics = { ...EMPTY_METRICS };
  private readonly cacheSize: number;
  private readonly queueSize: number;
  private readonly batchSize: number;
  private readonly eventBytes: number;
  private readonly readAttempts: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private pendingOperations = 0;
  private closing = false;

  constructor(
    private readonly provider: MemoryProvider,
    private readonly logger?: PluginLogger,
    options: CaptureCoordinatorOptions = {},
  ) {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CAPTURE_CONCURRENCY));
    this.cacheSize = Math.max(1, Math.floor(options.cacheSize ?? DEFAULT_CAPTURE_CACHE_SIZE));
    this.queueSize = Math.max(1, Math.floor(options.queueSize ?? DEFAULT_CAPTURE_QUEUE_SIZE));
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_CAPTURE_BATCH_SIZE));
    this.eventBytes = Math.max(64, Math.floor(options.eventBytes ?? DEFAULT_CAPTURE_EVENT_BYTES));
    this.readAttempts = Math.max(1, Math.floor(options.readAttempts ?? 3));
    this.retryBaseMs = Math.max(0, Math.floor(options.retryBaseMs ?? 50));
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.semaphore = new Semaphore(concurrency, this.queueSize);
  }

  getMetrics(): CaptureMetrics {
    return { ...this.metrics };
  }

  get cacheEntryCount(): number {
    return this.checkpoints.size;
  }

  get lockEntryCount(): number {
    return this.locks.size;
  }

  capture(params: {
    trackingKey: string;
    sessionId: string;
    messages: CapturedMessage[];
    scope: CaptureScope;
    /** Checked immediately before every provider write. */
    canWrite?: () => boolean;
  }): Promise<CaptureBatchResult> {
    if (this.closing) {
      this.metrics.dropped += 1;
      return Promise.reject(new Error("capture coordinator is closing"));
    }

    const task = this.withSessionLock(params.trackingKey, async () => {
      const release = await this.semaphore.acquire();
      try {
        return await this.captureLocked(params);
      } finally {
        release();
      }
    }).catch((error) => {
      if (error instanceof CaptureQueueFullError) this.metrics.dropped += 1;
      throw error;
    });
    this.inFlight.add(task);
    const scopeKey = params.scope.key ?? "default";
    const scopeTasks = this.inFlightByScope.get(scopeKey) ?? new Set<Promise<unknown>>();
    scopeTasks.add(task);
    this.inFlightByScope.set(scopeKey, scopeTasks);
    void task.then(
      () => this.finishTask(task, scopeKey),
      () => this.finishTask(task, scopeKey),
    );
    return task;
  }

  /** Wait for already-started capture in one scope without closing the coordinator. */
  async waitForScope(scopeKey: string, timeoutMs = 5000): Promise<boolean> {
    const tasks = [...(this.inFlightByScope.get(scopeKey) ?? [])];
    if (tasks.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    const completed = Promise.allSettled(tasks).then(() => true as const);
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  /** Stop accepting work and wait a bounded time for queued capture to finish. */
  async drain(timeoutMs = 5000): Promise<boolean> {
    this.closing = true;
    if (this.inFlight.size === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    const completed = Promise.allSettled([...this.inFlight]).then(() => true as const);
    const result = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    if (!result) {
      this.logger?.warn(
        `redis-memory: capture drain timed out pending=${this.inFlight.size}`,
      );
    }
    return result;
  }

  private async captureLocked(params: {
    trackingKey: string;
    sessionId: string;
    messages: CapturedMessage[];
    scope: CaptureScope;
    canWrite?: () => boolean;
  }): Promise<CaptureBatchResult> {
    const checkpoint = await this.getCheckpoint(params);
    const idsAtMax = new Set(checkpoint.messageIdsAtMax);
    const uniqueIds = new Set<string>();
    const candidates: CapturedMessage[] = [];

    for (const message of params.messages) {
      if (uniqueIds.has(message.id)) {
        this.metrics.duplicate += 1;
        continue;
      }
      uniqueIds.add(message.id);

      const alreadyCaptured =
        message.timestampMs < checkpoint.maxTimestampMs ||
        (message.timestampMs === checkpoint.maxTimestampMs && idsAtMax.has(message.id));
      if (alreadyCaptured) {
        this.metrics.duplicate += 1;
        continue;
      }

      const originalBytes = Buffer.byteLength(message.content, "utf8");
      if (originalBytes > this.eventBytes) {
        const truncated = truncateCapturedContent(message.content, this.eventBytes);
        this.logger?.warn(
          `redis-memory: capture event truncated id=${JSON.stringify(message.id)} original_bytes=${originalBytes} stored_bytes=${Buffer.byteLength(truncated, "utf8")}`,
        );
        candidates.push({ ...message, content: truncated });
        continue;
      }
      candidates.push(message);
    }

    if (candidates.length === 0) {
      this.logCounters(params.trackingKey);
      return { acceptedMessageIds: [] };
    }

    let workingCheckpoint = checkpoint;
    const allAcceptedIds: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += this.batchSize) {
      const batch = candidates.slice(offset, offset + this.batchSize);
      try {
        if (params.canWrite && !params.canWrite()) {
          throw new Error("capture is blocked for scope erasure");
        }
        const result = await this.provider.captureMessages(
          params.sessionId,
          batch,
          params.scope,
        );
        const acceptedIds = result?.acceptedMessageIds ?? batch.map((message) => message.id);
        const acceptedSet = new Set(acceptedIds);
        const acceptedMessages = batch.filter((message) => acceptedSet.has(message.id));
        if (acceptedMessages.length !== batch.length) {
          throw new CaptureBatchError(
            "capture provider returned an incomplete success",
            acceptedMessages.map((message) => message.id),
          );
        }
        allAcceptedIds.push(...acceptedIds);
        this.metrics.captured += acceptedMessages.length;
        workingCheckpoint = advanceCheckpoint(workingCheckpoint, acceptedMessages);
        this.setCheckpoint(params.trackingKey, workingCheckpoint);
      } catch (error) {
        const reportedAcceptedIds =
          error instanceof CaptureBatchError ? error.acceptedMessageIds : [];
        const batchIds = new Set(batch.map((message) => message.id));
        const acceptedIds = [...new Set(reportedAcceptedIds)].filter((id) => batchIds.has(id));
        this.metrics.captured += acceptedIds.length;
        this.metrics.permanentlyFailed += 1;
        // The failed request may have been persisted. Force the next delivery
        // to prove its state through a safe read before any replay.
        this.checkpoints.delete(params.trackingKey);
        this.logCounters(params.trackingKey);
        throw error;
      }
    }
    this.logCounters(params.trackingKey);
    return { acceptedMessageIds: allAcceptedIds };
  }

  private finishTask(task: Promise<unknown>, scopeKey: string): void {
    this.inFlight.delete(task);
    const scopeTasks = this.inFlightByScope.get(scopeKey);
    scopeTasks?.delete(task);
    if (scopeTasks?.size === 0) this.inFlightByScope.delete(scopeKey);
  }

  private async getCheckpoint(params: {
    trackingKey: string;
    sessionId: string;
    scope: CaptureScope;
  }): Promise<CaptureCheckpoint> {
    const cached = this.checkpoints.get(params.trackingKey);
    if (cached) {
      // Refresh insertion order for LRU eviction.
      this.checkpoints.delete(params.trackingKey);
      this.checkpoints.set(params.trackingKey, cached);
      return cached;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.readAttempts; attempt += 1) {
      try {
        const checkpoint = await this.provider.getCaptureCheckpoint(
          params.sessionId,
          params.scope,
        );
        this.setCheckpoint(params.trackingKey, checkpoint ?? emptyCheckpoint());
        return checkpoint ?? emptyCheckpoint();
      } catch (error) {
        lastError = error;
        if (attempt >= this.readAttempts || !isRetryableReadError(error)) throw error;
        this.metrics.retried += 1;
        await this.sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private setCheckpoint(key: string, checkpoint: CaptureCheckpoint): void {
    this.checkpoints.delete(key);
    this.checkpoints.set(key, checkpoint);
    while (this.checkpoints.size > this.cacheSize) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.checkpoints.delete(oldest);
    }
  }

  private async withSessionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.pendingOperations >= this.queueSize) {
      throw new CaptureQueueFullError("capture session queue is full");
    }
    this.pendingOperations += 1;
    const previous = this.locks.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      this.pendingOperations -= 1;
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  private logCounters(trackingKey: string): void {
    this.logger?.debug?.(
      `redis-memory: capture counters session=${JSON.stringify(trackingKey)} ` +
        `captured=${this.metrics.captured} duplicate=${this.metrics.duplicate} ` +
        `retried=${this.metrics.retried} dropped=${this.metrics.dropped} ` +
        `permanently_failed=${this.metrics.permanentlyFailed} deferred=${this.metrics.deferred}`,
    );
  }
}
