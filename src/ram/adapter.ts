import {
  AgentMemory,
  HTTPClient,
} from "@redis-iris/agent-memory";
import type { Fetcher } from "@redis-iris/agent-memory";
import type {
  AddSessionEventRequestContent,
  BulkCreateLongTermMemoriesRequestContent,
  BulkCreateLongTermMemoriesResponseContent,
  BulkDeleteLongTermMemoriesRequestContent,
  BulkDeleteLongTermMemoriesResponseContent,
  GetSessionMemoryResponseContent,
  GetLongTermMemoryResponseContent,
  HealthResponseContent,
  ListSessionsResponseContent,
  SearchLongTermMemoryRequestContent,
  SearchLongTermMemoryResponseContent,
} from "@redis-iris/agent-memory/models";

import { normalizeRamError } from "./errors.js";
import {
  MAX_ACTOR_ID_CHARS,
  MAX_ERROR_RESPONSE_BYTES,
  MAX_EVENT_METADATA_BYTES,
  MAX_MEMORY_TEXT_CHARS,
  MAX_PAGE_TOKEN_CHARS,
  MAX_RECALL_LIMIT,
  MAX_SUCCESS_RESPONSE_BYTES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  assertBoundedString,
  assertIntegerInRange,
  assertMemoryText,
  assertNumberInRange,
  assertSearchText,
  assertServiceIdentifier,
  assertTopics,
  validateServerUrl,
} from "../validation.js";

export type RamSdkAdapterOptions = {
  serverUrl: string;
  apiKey: string;
  storeId: string;
  timeoutMs?: number;
  /** Test-only transport injection. Production callers use the hardened client. */
  httpClient?: HTTPClient;
  fetcher?: Fetcher;
};

export type RamListSessionsOptions = {
  limit?: number;
  pageToken?: string;
  filterOwnerId?: string;
  includeAll?: boolean;
};

export const DEFAULT_RAM_TIMEOUT_MS = 30000;

// Passing an explicit logger prevents AGENT_MEMORY_DEBUG from enabling the
// generated SDK's request logger, which would include the Authorization header.
const SILENT_LOGGER = {
  group() {},
  groupEnd() {},
  log() {},
};

export class RamResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`RAM response exceeded the ${limitBytes} byte limit`);
    this.name = "RamResponseTooLargeError";
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

async function bufferBoundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const limit = response.ok ? MAX_SUCCESS_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new RamResponseTooLargeError(limit);
    }
  }
  if (!response.body) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) throw new RamResponseTooLargeError(limit);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Production transport: no automatic redirects and bounded, abort-aware body reads. */
export function createHardenedRamHttpClient(fetcher: Fetcher = globalThis.fetch): HTTPClient {
  return new HTTPClient({
    fetcher: async (input, init) => {
      const request = new Request(input, { ...init, redirect: "manual" });
      const response = await fetcher(request);
      return bufferBoundedResponse(response, request.signal);
    },
  });
}

function assertMemoryRecordInput(
  memory: BulkCreateLongTermMemoriesRequestContent["memories"][number],
  label: string,
): void {
  assertServiceIdentifier(memory.id, `${label}.id`);
  assertMemoryText(memory.text, `${label}.text`);
  if (memory.sessionId !== undefined) assertServiceIdentifier(memory.sessionId, `${label}.sessionId`);
  if (memory.ownerId !== undefined) assertServiceIdentifier(memory.ownerId, `${label}.ownerId`);
  if (memory.namespace !== undefined) assertServiceIdentifier(memory.namespace, `${label}.namespace`);
  if (memory.topics !== undefined) assertTopics(memory.topics, `${label}.topics`);
}

function assertReturnedMemory(memory: GetLongTermMemoryResponseContent, label: string): void {
  assertServiceIdentifier(memory.id, `${label}.id`);
  assertMemoryText(memory.text, `${label}.text`);
  if (memory.sessionId !== undefined) assertServiceIdentifier(memory.sessionId, `${label}.sessionId`);
  if (memory.ownerId !== undefined) assertServiceIdentifier(memory.ownerId, `${label}.ownerId`);
  if (memory.namespace !== undefined) assertServiceIdentifier(memory.namespace, `${label}.namespace`);
  if (memory.topics !== undefined) assertTopics(memory.topics, `${label}.topics`);
}

function assertFilterValues(
  filter: { eq?: string; ne?: string; in?: string[]; all?: string[] } | undefined,
  label: string,
  assertion: (value: unknown, label: string) => void,
): void {
  if (!filter) return;
  if (filter.eq !== undefined) assertion(filter.eq, `${label}.eq`);
  if (filter.ne !== undefined) assertion(filter.ne, `${label}.ne`);
  for (const key of ["in", "all"] as const) {
    const values = filter[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) {
      throw new Error(`${label}.${key} must contain between 1 and 50 values`);
    }
    values.forEach((value, index) => assertion(value, `${label}.${key}[${index}]`));
  }
}

/** Thin, injectable boundary around the official Redis Agent Memory SDK. */
export class RamSdkAdapter {
  private readonly sdk: AgentMemory;
  private readonly secrets: Array<string | undefined>;

  constructor(options: RamSdkAdapterOptions) {
    validateServerUrl(options.serverUrl, "cloud");
    assertBoundedString(options.apiKey, "apiKey", { min: 1, max: 4_096 });
    if (!options.apiKey.trim()) throw new Error("apiKey must not be blank");
    assertServiceIdentifier(options.storeId, "storeId");
    const timeoutMs = options.timeoutMs ?? DEFAULT_RAM_TIMEOUT_MS;
    assertIntegerInRange(timeoutMs, "timeoutMs", MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.secrets = [options.apiKey];
    this.sdk = new AgentMemory({
      serverURL: options.serverUrl,
      apiKey: options.apiKey,
      storeId: options.storeId,
      timeoutMs,
      retryConfig: { strategy: "none" },
      debugLogger: SILENT_LOGGER,
      httpClient: options.httpClient ?? createHardenedRamHttpClient(options.fetcher),
    });
  }

  health(): Promise<HealthResponseContent> {
    return this.call(() => this.sdk.health());
  }

  async bulkCreateLongTermMemories(
    request: BulkCreateLongTermMemoriesRequestContent,
  ): Promise<BulkCreateLongTermMemoriesResponseContent> {
    if (!Array.isArray(request.memories) || request.memories.length < 1 || request.memories.length > 100) {
      throw normalizeRamError(new Error("memories must contain between 1 and 100 records"));
    }
    request.memories.forEach((memory, index) => assertMemoryRecordInput(memory, `memories[${index}]`));
    return await this.call(async () => {
      const response = await this.sdk.bulkCreateLongTermMemories(request);
      if (
        response.created.length > request.memories.length ||
        (response.errors?.length ?? 0) > request.memories.length ||
        response.created.length + (response.errors?.length ?? 0) > request.memories.length
      ) {
        throw new Error("bulk create response contained too many results");
      }
      for (const id of response.created) assertServiceIdentifier(id, "created memory id");
      for (const failure of response.errors ?? []) assertServiceIdentifier(failure.id, "failed memory id");
      return {
        ...response,
        errors: response.errors?.map((failure) => ({ id: failure.id, error: "item failed" })),
      };
    });
  }

  async bulkDeleteLongTermMemories(
    request: BulkDeleteLongTermMemoriesRequestContent,
  ): Promise<BulkDeleteLongTermMemoriesResponseContent> {
    if (!Array.isArray(request.memoryIds) || request.memoryIds.length < 1 || request.memoryIds.length > 100) {
      throw normalizeRamError(new Error("memoryIds must contain between 1 and 100 ids"));
    }
    request.memoryIds.forEach((id, index) => assertServiceIdentifier(id, `memoryIds[${index}]`));
    return await this.call(async () => {
      const response = await this.sdk.bulkDeleteLongTermMemories(request);
      if (
        response.deleted.length > request.memoryIds.length ||
        (response.errors?.length ?? 0) > request.memoryIds.length ||
        response.deleted.length + (response.errors?.length ?? 0) > request.memoryIds.length
      ) {
        throw new Error("bulk delete response contained too many results");
      }
      for (const id of response.deleted) assertServiceIdentifier(id, "deleted memory id");
      for (const failure of response.errors ?? []) assertServiceIdentifier(failure.id, "failed memory id");
      return {
        ...response,
        errors: response.errors?.map((failure) => ({ id: failure.id, error: "item failed" })),
      };
    });
  }

  async searchLongTermMemory(
    request?: SearchLongTermMemoryRequestContent,
  ): Promise<SearchLongTermMemoryResponseContent> {
    if (request?.text !== undefined) assertSearchText(request.text, "search text");
    if (request?.similarityThreshold !== undefined) {
      assertNumberInRange(request.similarityThreshold, "similarityThreshold", 0, 1);
    }
    if (request?.limit !== undefined) {
      assertIntegerInRange(request.limit, "limit", 1, MAX_RECALL_LIMIT);
    }
    if (request?.pageToken !== undefined) {
      assertBoundedString(request.pageToken, "pageToken", { min: 1, max: MAX_PAGE_TOKEN_CHARS });
    }
    const filter = request?.filter;
    assertFilterValues(filter?.sessionId, "filter.sessionId", assertServiceIdentifier);
    assertFilterValues(filter?.ownerId, "filter.ownerId", assertServiceIdentifier);
    assertFilterValues(filter?.namespace, "filter.namespace", assertServiceIdentifier);
    assertFilterValues(filter?.topics, "filter.topics", (value, label) => {
      assertBoundedString(value, label, { min: 1, max: 100 });
    });
    return await this.call(async () => {
      const response = await this.sdk.searchLongTermMemory(request);
      if (response.items.length > MAX_RECALL_LIMIT) {
        throw new Error(`search response exceeded ${MAX_RECALL_LIMIT} items`);
      }
      response.items.forEach((memory, index) => assertReturnedMemory(memory, `items[${index}]`));
      if (response.nextPageToken !== undefined) {
        assertBoundedString(response.nextPageToken, "nextPageToken", {
          min: 1,
          max: MAX_PAGE_TOKEN_CHARS,
        });
      }
      return response;
    });
  }

  async getLongTermMemory(memoryId: string): Promise<GetLongTermMemoryResponseContent> {
    assertServiceIdentifier(memoryId, "memoryId");
    return await this.call(async () => {
      const response = await this.sdk.getLongTermMemory(memoryId);
      assertReturnedMemory(response, "memory");
      return response;
    });
  }

  async addSessionEvent(request: AddSessionEventRequestContent): Promise<void> {
    if (request.sessionId !== undefined) assertServiceIdentifier(request.sessionId, "sessionId");
    assertBoundedString(request.actorId, "actorId", { min: 1, max: MAX_ACTOR_ID_CHARS });
    if (!Array.isArray(request.content) || request.content.length < 1 || request.content.length > 10) {
      throw normalizeRamError(new Error("event content must contain between 1 and 10 parts"));
    }
    let totalText = 0;
    for (const [index, part] of request.content.entries()) {
      assertBoundedString(part.text, `content[${index}].text`, { min: 1, max: MAX_MEMORY_TEXT_CHARS });
      totalText += part.text.length;
    }
    if (totalText > MAX_MEMORY_TEXT_CHARS) throw normalizeRamError(new Error("event content is too long"));
    if (!(request.createdAt instanceof Date) || !Number.isFinite(request.createdAt.getTime())) {
      throw normalizeRamError(new Error("createdAt must be a valid Date"));
    }
    if (request.metadata !== undefined) {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(request.metadata);
      } catch {
        throw normalizeRamError(new Error("metadata must be JSON-serializable"));
      }
      if (encoded === undefined) throw normalizeRamError(new Error("metadata must be a JSON value"));
      if (Buffer.byteLength(encoded, "utf8") > MAX_EVENT_METADATA_BYTES) {
        throw normalizeRamError(new Error("metadata is too large"));
      }
    }
    await this.call(() => this.sdk.addSessionEvent(request));
  }

  async getSessionMemory(sessionId: string): Promise<GetSessionMemoryResponseContent> {
    assertServiceIdentifier(sessionId, "sessionId");
    return await this.call(async () => {
      const response = await this.sdk.getSessionMemory(sessionId);
      assertServiceIdentifier(response.sessionId, "session.sessionId");
      assertBoundedString(response.ownerId, "session.ownerId", { min: 1, max: MAX_ACTOR_ID_CHARS });
      for (const [index, event] of response.events.entries()) {
        assertServiceIdentifier(event.sessionId, `events[${index}].sessionId`);
        assertBoundedString(event.actorId, `events[${index}].actorId`, { min: 1, max: MAX_ACTOR_ID_CHARS });
        let totalText = 0;
        for (const part of event.content) totalText += part.text.length;
        if (totalText > MAX_MEMORY_TEXT_CHARS) throw new Error(`events[${index}] content is too long`);
      }
      return response;
    });
  }

  async deleteSessionMemory(sessionId: string): Promise<void> {
    assertServiceIdentifier(sessionId, "sessionId");
    await this.call(() => this.sdk.deleteSessionMemory(sessionId));
  }

  async listSessions(options: RamListSessionsOptions = {}): Promise<ListSessionsResponseContent> {
    if (options.limit !== undefined) assertIntegerInRange(options.limit, "limit", 1, MAX_RECALL_LIMIT);
    if (options.filterOwnerId !== undefined) assertServiceIdentifier(options.filterOwnerId, "filterOwnerId");
    if (options.filterOwnerId !== undefined && options.includeAll !== undefined) {
      throw normalizeRamError(new Error("includeAll must not be combined with filterOwnerId"));
    }
    if (options.filterOwnerId === undefined && options.includeAll === false) {
      throw normalizeRamError(new Error("includeAll must be true when no filterOwnerId is provided"));
    }
    if (options.pageToken !== undefined) {
      assertBoundedString(options.pageToken, "pageToken", { min: 1, max: MAX_PAGE_TOKEN_CHARS });
    }
    return await this.call(async () => {
      const response = await this.sdk.listSessions(
        options.limit,
        options.pageToken,
        options.filterOwnerId,
        options.filterOwnerId === undefined ? options.includeAll ?? true : undefined,
      );
      if (response.items.length > MAX_RECALL_LIMIT) throw new Error("session response contained too many items");
      response.items.forEach((id, index) => assertServiceIdentifier(id, `items[${index}]`));
      if (response.nextPageToken !== undefined) {
        assertBoundedString(response.nextPageToken, "nextPageToken", {
          min: 1,
          max: MAX_PAGE_TOKEN_CHARS,
        });
      }
      return response;
    });
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeRamError(error, this.secrets);
    }
  }
}
