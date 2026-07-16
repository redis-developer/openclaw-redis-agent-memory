/**
 * Backend-neutral memory provider interface.
 *
 * The plugin core (`index.ts`) depends only on this interface; all differences
 * between backends (self-hosted AMS, cloud RAM) live inside the provider
 * implementations under `src/providers/`.
 */

import type { MemoryStrategy } from "./config.js";
import type { ScopedMemoryTarget } from "./scopes.js";

export type ProviderCapabilities = {
  summaryViews: boolean;
  extractionStrategy: boolean;
  similarityScores: boolean;
};

export type ProviderSearchResult = {
  id: string;
  text: string;
  score?: number; // undefined when !capabilities.similarityScores
  topics?: string[];
  entities?: string[];
};

export type CapturedMessage = {
  role: "user" | "assistant";
  content: string;
  id: string;
  timestampMs: number;
};

export type SummaryPartition = {
  summary: string;
  memoryCount: number;
  computedAt?: string;
};

export interface SummaryViewOperations {
  ensureView(scope: ScopedMemoryTarget): Promise<string | null>;
  getSummaryPartition(scope: ScopedMemoryTarget): Promise<SummaryPartition | null>;
  refreshView(scope: ScopedMemoryTarget): Promise<void>;
}

export interface MemoryProvider {
  readonly capabilities: ProviderCapabilities;
  healthCheck(): Promise<void>;
  searchLongTerm(params: {
    text: string;
    limit: number;
    namespace?: string;
    userId?: string;
    minScore?: number;
  }): Promise<ProviderSearchResult[]>;
  createLongTerm(params: {
    text: string;
    topics?: string[];
    namespace?: string;
    userId?: string;
  }): Promise<{ id: string }>;
  deleteLongTerm(ids: string[], params: { namespace?: string }): Promise<void>;
  findDuplicate(params: {
    text: string;
    namespace?: string;
    userId?: string;
  }): Promise<{ id: string; text: string } | null>;
  getCaptureCheckpoint(
    sessionId: string,
    scope: { namespace?: string; userId?: string },
  ): Promise<number>; // max message epoch ms, 0 if none
  captureMessages(
    sessionId: string,
    messages: CapturedMessage[],
    scope: {
      namespace?: string;
      userId?: string;
      extractionStrategy?: MemoryStrategy;
      customPrompt?: string;
    },
  ): Promise<void>;
  summaries?: SummaryViewOperations; // present only when capabilities.summaryViews
}
