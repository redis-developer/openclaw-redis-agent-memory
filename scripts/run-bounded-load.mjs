import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { CaptureCoordinator } from "../dist/capture.js";
import { distributeBudget, mapWithConcurrency } from "../dist/bounded.js";

const TARGETS = Object.freeze({
  configuredScopes: 32,
  concurrentSessions: 16,
  messagesPerSession: 256,
  maxCaptureConcurrency: 4,
  checkpoint429PerSession: 1,
  maxCaptureP95Ms: 2_000,
  maxRecallP95Ms: 2_000,
  maxErrorRate: 0,
});

let active = 0;
let maxActive = 0;
let checkpointAttempts = 0;
const checkpointAttemptsBySession = new Map();
const provider = {
  capabilities: { summaryViews: false, extractionStrategy: false, similarityScores: false },
  deriveCaptureSessionId(identity) { return identity; },
  async healthCheck() {},
  async searchLongTerm() { return []; },
  async createLongTerm() { return { id: "unused" }; },
  async deleteLongTerm() { return { deletedIds: [], notFoundIds: [], forbiddenIds: [], failedIds: [] }; },
  async eraseScope(scope) {
    return { scopeKey: scope.key, status: "verified_best_effort", passes: 2, memoryIds: [], sessionIds: [], failedMemoryIds: [], failedSessionIds: [], remainingMemoryIds: [], remainingSessionIds: [], residuals: [] };
  },
  async findDuplicate() { return null; },
  async getCaptureCheckpoint(sessionId) {
    checkpointAttempts += 1;
    const attempts = (checkpointAttemptsBySession.get(sessionId) ?? 0) + 1;
    checkpointAttemptsBySession.set(sessionId, attempts);
    if (attempts <= TARGETS.checkpoint429PerSession) {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }
    return { maxTimestampMs: 0, messageIdsAtMax: [] };
  },
  async captureMessages(_sessionId, messages) {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
    active -= 1;
    return { acceptedMessageIds: messages.map((message) => message.id) };
  },
};

const coordinator = new CaptureCoordinator(provider, undefined, {
  concurrency: TARGETS.maxCaptureConcurrency,
  queueSize: TARGETS.concurrentSessions,
  batchSize: TARGETS.messagesPerSession,
  readAttempts: 2,
  retryBaseMs: 0,
  sleep: async () => {},
});
const latencies = [];
let errors = 0;
await Promise.all(Array.from({ length: TARGETS.concurrentSessions }, async (_, sessionIndex) => {
  const started = performance.now();
  try {
    await coordinator.capture({
      trackingKey: `scope_${sessionIndex % TARGETS.configuredScopes}:session_${sessionIndex}`,
      sessionId: `session-${sessionIndex}`,
      scope: { key: `scope_${sessionIndex % TARGETS.configuredScopes}` },
      messages: Array.from({ length: TARGETS.messagesPerSession }, (_, messageIndex) => ({
        id: `s${sessionIndex}-m${messageIndex}`,
        role: messageIndex % 2 === 0 ? "user" : "assistant",
        content: `bounded load message ${messageIndex}`,
        timestampMs: messageIndex + 1,
      })),
    });
  } catch {
    errors += 1;
  } finally {
    latencies.push(performance.now() - started);
  }
}));

latencies.sort((left, right) => left - right);
const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)];
const metrics = {
  kind: "local_deterministic_coordinator_harness",
  targets: TARGETS,
  observations: {
    capturedMessages: coordinator.getMetrics().captured,
    retries: coordinator.getMetrics().retried,
    checkpointAttempts,
    errors,
    errorRate: errors / TARGETS.concurrentSessions,
    maxActive,
    latencyMs: {
      p50: Number(percentile(0.50).toFixed(2)),
      p95: Number(percentile(0.95).toFixed(2)),
      p99: Number(percentile(0.99).toFixed(2)),
    },
  },
};

let recallActive = 0;
let recallMaxActive = 0;
let recallErrors = 0;
let recalledRecords = 0;
const recallLatencies = [];
const scopeKeys = Array.from({ length: TARGETS.configuredScopes }, (_, index) => `scope_${index}`);
const recallQuotas = distributeBudget(
  Math.max(5, TARGETS.configuredScopes),
  TARGETS.configuredScopes,
);
for (let iteration = 0; iteration < 10; iteration += 1) {
  const started = performance.now();
  try {
    const pages = await mapWithConcurrency(
      scopeKeys,
      TARGETS.maxCaptureConcurrency,
      async (_scope, index) => {
        recallActive += 1;
        recallMaxActive = Math.max(recallMaxActive, recallActive);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
        recallActive -= 1;
        return Array.from({ length: recallQuotas[index] }, () => "record");
      },
    );
    recalledRecords += pages.flat().length;
  } catch {
    recallErrors += 1;
  } finally {
    recallLatencies.push(performance.now() - started);
  }
}
recallLatencies.sort((left, right) => left - right);
const recallPercentile = (value) => recallLatencies[
  Math.min(recallLatencies.length - 1, Math.ceil(recallLatencies.length * value) - 1)
];
metrics.observations.recall = {
  kind: "local_deterministic_32_scope_scheduler",
  iterations: recallLatencies.length,
  requestedScopesPerIteration: TARGETS.configuredScopes,
  recordsPerIteration: recalledRecords / recallLatencies.length,
  errors: recallErrors,
  maxActive: recallMaxActive,
  latencyMs: {
    p50: Number(recallPercentile(0.50).toFixed(2)),
    p95: Number(recallPercentile(0.95).toFixed(2)),
    p99: Number(recallPercentile(0.99).toFixed(2)),
  },
};

if (
  metrics.observations.capturedMessages !== TARGETS.concurrentSessions * TARGETS.messagesPerSession ||
  metrics.observations.retries !== TARGETS.concurrentSessions * TARGETS.checkpoint429PerSession ||
  metrics.observations.maxActive > TARGETS.maxCaptureConcurrency ||
  metrics.observations.errorRate > TARGETS.maxErrorRate ||
  metrics.observations.latencyMs.p95 > TARGETS.maxCaptureP95Ms ||
  metrics.observations.recall.recordsPerIteration !== TARGETS.configuredScopes ||
  metrics.observations.recall.errors > 0 ||
  metrics.observations.recall.maxActive > TARGETS.maxCaptureConcurrency ||
  metrics.observations.recall.latencyMs.p95 > TARGETS.maxRecallP95Ms
) {
  console.error(JSON.stringify(metrics, null, 2));
  process.exit(1);
}

const outputDirectory = resolve("artifacts", "load");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(resolve(outputDirectory, `node${process.versions.node.split(".")[0]}-results.json`), JSON.stringify(metrics, null, 2) + "\n");
console.log(JSON.stringify(metrics, null, 2));
