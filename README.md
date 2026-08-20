# openclaw-redis-agent-memory

[![npm version](https://img.shields.io/npm/v/openclaw-redis-agent-memory.svg)](https://www.npmjs.com/package/openclaw-redis-agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw), backed by **Redis Agent Memory**.

Give your AI agent persistent memory across conversations. It can remember user preferences, past decisions, important facts, and more.

The plugin supports two backends:

- **Redis Agent Memory (cloud)** — the managed service, part of Redis IRIS. This is the **default** for new installs; there's no server to run yourself.
- **Self-hosted agent-memory-server** — the open-source server you run and operate (e.g. via Docker). Existing configs that only set `serverUrl` keep working unchanged.

See [Backend Comparison](#backend-comparison) for what differs between the two, and pick the quick start that matches your setup below.

## Features

- **Auto-recall**: Automatically inject relevant memories into context before each turn
- **Auto-capture**: Save conversations to working memory for background extraction
- **Manual tools**: `memory_recall`, `memory_store`, `memory_forget` for explicit control
- **Summary views** (self-hosted only): Rolling summaries of long-term memories for stable context
- **Multi-tenancy**: Namespace and optional `userId` support for memory isolation
- **Multi-agent routing**: Named scopes and agent-specific routes for shared and personal memory
- **Configurable tool descriptions**: Customize how the LLM sees and uses memory tools

## Requirements

- OpenClaw `>=2025.0.0`
- Node.js `>=18` if you are building locally or using the package programmatically
- **Cloud (default)**: a Redis Agent Memory store (endpoint, API key, store ID) — see [Quick Start (Cloud, Default)](#quick-start-cloud-default)
- **Self-hosted**: Docker (or another way to run the server) and an OpenAI API key — see [Self-Hosted Setup](#self-hosted-setup)

## Quick Start (Cloud, Default)

Redis Agent Memory (cloud) is a managed service, so there's no server to install or run. This is the default backend whenever a config doesn't look like an existing self-hosted setup.

### 1. Get Your Credentials

Sign in to the [Redis Cloud console](https://cloud.redis.io/) and open **Redis IRIS → Agent Memory** to create a store. Copy its endpoint, API key, and store ID — you'll need all three. Dedicated Redis Agent Memory product documentation is forthcoming; until then, the Cloud console is the source of truth for provisioning.

### 2. Install the Plugin

```bash
openclaw plugins install openclaw-redis-agent-memory
```

### 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json`. This example reads credentials from environment variables so you never commit secrets to config:

```json
{
  "plugins": { "entries": { "redis-memory": { "enabled": true, "config": {
    "serverUrl": "${AGENT_MEMORY_ENDPOINT}",
    "apiKey": "${AGENT_MEMORY_API_KEY}",
    "storeId": "${AGENT_MEMORY_STORE_ID}",
    "namespace": "my-app",
    "userId": "user-123"
  }}}}
}
```

Then set the three variables in your shell or deployment environment:

```bash
export AGENT_MEMORY_ENDPOINT="https://<your-endpoint>"
export AGENT_MEMORY_API_KEY="<your-api-key>"
export AGENT_MEMORY_STORE_ID="<your-store-id>"
```

> With all three `AGENT_MEMORY_*` environment variables set, an empty config (`{}`) is enough — the plugin fills in `serverUrl`, `apiKey`, and `storeId` from the environment and defaults to the cloud provider.

Continue to [Verify It Works](#verify-it-works).

## Self-Hosted Setup

Prefer to run your own memory server? Set `"provider": "self-hosted"` and point `serverUrl` at your server instance.

If you have an existing config that only sets `serverUrl` (no `storeId`, and no `AGENT_MEMORY_STORE_ID` env var), the plugin auto-detects it as self-hosted for backwards compatibility — you don't need to add `provider` explicitly.

### 1. Start the Memory Server

The quickest way to run the latest tested memory server is with the standalone Docker image (includes Redis):

```bash
# Create .env file with your OpenAI key
echo "OPENAI_API_KEY=sk-your-key-here" > .env

# Run the standalone image (latest tested release)
docker run -d \
  --name agent-memory \
  --env-file .env \
  -p 8000:8000 \
  redislabs/agent-memory-server:0.14.0-standalone
```

If you want to use an external Redis instead of the standalone image, run the standard image with `REDIS_URL` and the `asyncio` task backend for local development:

```bash
docker run -d \
  --name agent-memory \
  -e OPENAI_API_KEY=sk-your-key-here \
  -e REDIS_URL=redis://localhost:6379 \
  -p 8000:8000 \
  redislabs/agent-memory-server:0.14.0 \
  agent-memory api --host 0.0.0.0 --port 8000 --task-backend=asyncio
```

For production-like deployments with the standard image, run a separate `agent-memory task-worker` process. For more configuration options, see the [agent-memory-server documentation](https://redis.github.io/agent-memory-server/).

### 2. Install the Plugin

```bash
openclaw plugins install openclaw-redis-agent-memory
```

### 3. Configure OpenClaw

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "redis-memory": {
        "enabled": true,
        "config": {
          "provider": "self-hosted",
          "serverUrl": "http://localhost:8000",
          "namespace": "project-memory",
          "userId": "demo-user"
        }
      }
    }
  }
}
```

Set `userId` explicitly if you want per-user memory isolation. Leave `userId` unset only when you intentionally want everyone using the same `namespace` to share memory.

### Server Configuration

The `.env` file for the self-hosted server supports many options:

```bash
# Required
OPENAI_API_KEY=sk-your-key-here

# For the standard (non-standalone) image
# REDIS_URL=redis://localhost:6379

# Recommended for local development if you are not running a separate worker
# TASK_BACKEND=asyncio

# Optional - customize the embedding model
# EMBEDDING_MODEL=text-embedding-3-small

# Optional - use a different LLM for memory extraction
# GENERATION_MODEL=gpt-4o-mini

# Optional - disable auth for local testing
# DISABLE_AUTH=true
```

See the [full configuration reference](https://redis.github.io/agent-memory-server/) for all options.

## Verify It Works

Use a deterministic smoke test before building on top of the plugin. The tool calls below are identical regardless of backend.

1. Start OpenClaw with the plugin enabled.
2. Confirm the plugin can reach the backend. The OpenClaw logs should include a registration line naming the resolved backend, e.g. `redis-memory: plugin registered (backend: cloud, server: ..., storeId: ..., namespace: ...)` or `redis-memory: plugin registered (backend: self-hosted, server: ..., namespace: ...)`, followed by `redis-memory: connected to server (...)` once the health check succeeds. With `eagerStartupCheck: false` that second line arrives shortly after startup instead of before it, since the check no longer blocks startup, so give it a moment when running this test.
3. In a chat or tool playground, store a known fact:

```json
{
  "tool": "memory_store",
  "arguments": {
    "text": "Project code name is Vector Cats",
    "category": "entity"
  }
}
```

4. Recall it immediately:

```json
{
  "tool": "memory_recall",
  "arguments": {
    "query": "project code name",
    "limit": 3
  }
}
```

If recall works, your server URL/credentials, namespace, and plugin wiring are all in a good state.

## Backend Comparison

| Capability | Redis Agent Memory (cloud, default) | Self-hosted agent-memory-server |
|---|---|---|
| Setup | Managed by Redis — no server to run | You run and operate the container/deployment |
| Authentication | Required: `apiKey` + `storeId` | Optional: `apiKey` or `bearerToken` |
| Memory extraction | Automatic, server-side — not configurable | Configurable via `extractionStrategy` (`discrete`, `summary`, `preferences`, `custom`) |
| Summary views | Not available | Available (`summaryViewName`, `summaryTimeWindowDays`, `summaryGroupBy`) |
| Recall similarity scores | Not returned — no percentage shown in recall output | Returned — recall results include a similarity percentage |
| Tenancy | `storeId` + an opaque owner boundary derived from scope, `namespace`, and optional `userId` | `namespace` + optional `userId` |

See [Configuration Options](#configuration-options) for the full field-by-field breakdown.

## Implementation Patterns

The examples below use self-hosted-style config (`serverUrl` only) for brevity. The same patterns work against the cloud backend — just swap in `apiKey` + `storeId` (or the `AGENT_MEMORY_*` env vars) as shown in [Quick Start (Cloud, Default)](#quick-start-cloud-default).

### Shared Memory

Use one shared `namespace` and leave `userId` unset:

```json
{
  "serverUrl": "http://localhost:8000",
  "namespace": "team-shared"
}
```

This is the fastest setup when multiple users or agents should share the same long-term memory.

### Per-User Isolation

Use the same `namespace`, but assign each user their own `userId`:

```json
{
  "serverUrl": "http://localhost:8000",
  "namespace": "project-memory",
  "userId": "user-123"
}
```

This keeps memories isolated per user while still grouping the application under one namespace.

### Shared Plus Personal Memory Across Agents

For multi-agent implementations, define named scopes and route each OpenClaw agent to the right memory boundary:

```json
{
  "plugins": {
    "entries": {
      "redis-memory": {
        "enabled": true,
        "config": {
          "serverUrl": "http://localhost:8000",
          "namespace": "project-memory",
          "scopes": {
            "shared": {
              "label": "Shared Memory"
            },
            "personal": {
              "label": "Personal Memory",
              "userId": "user-123"
            },
            "research": {
              "label": "Research Memory"
            }
          },
          "agentScopes": {
            "main": {
              "primaryScope": "shared",
              "recallScopes": ["shared", "personal"],
              "toolScopes": ["shared", "personal"],
              "defaultStoreScope": "shared"
            },
            "researcher": {
              "primaryScope": "research",
              "recallScopes": ["shared", "research"],
              "toolScopes": ["shared", "research"],
              "defaultStoreScope": "research"
            }
          }
        }
      }
    }
  }
}
```

When multiple scopes are available, the manual memory tools expose a `scope` parameter so you can operate within a specific memory boundary. Exact-ID deletion requires it; the plugin never tries an ID against several scopes.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `provider` | string | resolved (see below) | `"cloud"` (Redis Agent Memory, default) or `"self-hosted"`. If unset: resolves to `self-hosted` when `serverUrl` is set but `storeId` is not (and `AGENT_MEMORY_STORE_ID` is also unset); otherwise resolves to `cloud`. |
| `serverUrl` | string | `http://localhost:8000` (self-hosted) | Base URL of the backend. Cloud requires an HTTPS origin with no credentials, path, query, or fragment. Self-hosted HTTP is accepted only for loopback development endpoints; use HTTPS for remote servers. |
| `apiKey` | string | unset | API key for authentication. **Required for cloud** (falls back to `AGENT_MEMORY_API_KEY`); optional for self-hosted. |
| `bearerToken` | string | unset | Bearer token for authentication. **Self-hosted only** — not supported with the cloud provider (use `apiKey` instead). |
| `storeId` | string | unset | Redis Agent Memory store id. **Cloud only** (falls back to `AGENT_MEMORY_STORE_ID`); 1-64 alphanumeric/dash characters. |
| `namespace` | string | `default` | Top-level memory boundary. Cloud values are 1-64 alphanumeric/dash characters; self-hosted values are bounded to 255 characters. |
| `userId` | string | unset | Optional secondary boundary. Cloud values are 1-64 alphanumeric/dash characters; self-hosted values are bounded to 255 characters. |
| `workingMemorySessionId` | string | unset | Reuse one working-memory identity across OpenClaw sessions. Cloud accepts 1-64 alphanumeric/dash characters and hashes the value with the scope boundary; self-hosted accepts up to 255 characters and uses it as supplied. |
| `timeout` | integer | `30000` | Complete request timeout in milliseconds, from 100 through 120000 |
| `autoCapture` | boolean | `true` | Save eligible conversation turns to working memory; named scopes can override this |
| `autoRecall` | boolean | `true` | Inject relevant long-term memory before each turn |
| `assistantCapture` | string | `include` | `include` retains complete conversational turns for memory extraction; set `exclude` to capture user turns only |
| `sensitiveDataRedaction` | boolean | `false` | Opt in to heuristic redaction of common credentials and personal identifiers before capture |
| `sessionRetentionSeconds` | integer | unset | Self-hosted working-memory TTL, from 60 through 31536000 seconds. RAM cloud does not expose a session TTL and rejects this option. |
| `minScore` | number | `0.3` | Minimum similarity score for memory recall |
| `recallLimit` | integer | `3` | Max recalled memories per search, from 1 through 100 |
| `recallRecordMaxChars` | integer | `2000` | Maximum characters from one record in automatic recall, from 128 through 10000 |
| `recallContextMaxChars` | integer | `16000` | Maximum characters in the complete automatic recall envelope, from 1024 through 32000 |
| `erasureSettleMs` | integer | `2000` | Delay between best-effort scope-erasure sweeps, from 0 through 60000 milliseconds |
| `eagerStartupCheck` | boolean | `true` | Await the backend health check (and self-hosted summary-view setup) during service start. Set `false` on latency-sensitive hosts to run it in the background instead: startup returns immediately and failures still appear as log warnings. |
| `extractionStrategy` | string | server default | **Self-hosted only.** `discrete`, `summary`, `preferences`, or `custom`; ignored on cloud (logged once at startup) |
| `customPrompt` | string | unset | **Self-hosted only.** Custom extraction prompt for `custom` strategy |
| `summaryViewName` | string | `agent_user_summary` | **Self-hosted only.** Summary view name for rolling memory summaries |
| `summaryTimeWindowDays` | number | `30` | **Self-hosted only.** Rolling window for summary generation |
| `summaryGroupBy` | array | `["user_id"]` | **Self-hosted only.** Fields to partition summaries by |
| `recallDescription` | string | built-in description | Override the LLM-facing description for `memory_recall` |
| `storeDescription` | string | built-in description | Override the LLM-facing description for `memory_store` |
| `forgetDescription` | string | built-in description | Override the LLM-facing description for `memory_forget` |
| `scopes` | object | unset | Named memory boundaries for multi-agent setups |
| `agentScopes` | object | unset | Map OpenClaw agent IDs to recall, capture, and tool scopes |

### Input and Transport Limits

- Search and stored-memory text is limited to 50,000 characters. Topics are limited to 50 values of 100 characters each, and cloud memory identifiers are limited to 64 alphanumeric/dash characters.
- Captured conversation events are limited to 50,000 UTF-8 bytes. Longer content is truncated at a valid UTF-8 boundary and ends with `[truncated]`; the warning contains only the event id and byte counts.
- Tool schemas and runtime checks share the same integer, text, and identifier limits. Tool success output and automatically injected memory context are also bounded to prevent an oversized stored record from crowding out the current turn.
- Cloud requests do not follow redirects, so the authorization header is never forwarded to a second origin. Response bodies are read under the request timeout and are size-limited before the official SDK validates their schema.
- API keys, bearer tokens, authorization values, and server error bodies are not returned through tools. Operational logs use single-line, redacted error summaries; the official SDK debug logger remains disabled.

### Memory Trust and Privacy

Automatically recalled memories and self-hosted summaries are untrusted historical data. The plugin places them in one fixed warning envelope and JSON-encodes every record, escaping structural characters such as `<`, `>`, and `&`. Each record carries bounded scope, id, type, and source provenance where the backend exposes it. Per-record, record-count, and total-context budgets are deterministic; truncation and omitted counts appear in the envelope metadata.

This framing reduces the chance that stored instruction-shaped text is mistaken for current instructions, but it cannot eliminate model prompt injection. Keep tool permissions least-privileged, require confirmation for consequential tools, and do not use recalled memory as authorization evidence.

Assistant output is captured by default because Redis Agent Memory extracts from complete conversational turns. Assistant messages can echo credentials or other sensitive input, so review this retention choice and set `assistantCapture: "exclude"` when data minimization is more important; cloud extraction quality or triggering may be reduced when only user turns are sent. `sensitiveDataRedaction: true` enables deterministic pattern redaction for common keys, tokens, email addresses, phone/card/SSN-shaped values, and private-key blocks. It is a data-minimization aid, not a DLP system, and can miss sensitive values or redact benign text. Named scopes can override `autoRecall`, `autoCapture`, `assistantCapture`, `sensitiveDataRedaction`, and self-hosted `sessionRetentionSeconds`.

### Notes on Isolation

- `namespace` is the broadest isolation boundary. It is usually the right place to separate apps, environments, or product areas.
- `userId` is optional. If you do not set it, memory is scoped only by `namespace`.
- For stable deployments or repeatable demos, prefer setting `userId` explicitly whenever memory should stay isolated to one person or one bot persona.
- On cloud, server-extracted memories do not currently retain `namespace`. The plugin therefore derives a privacy-preserving RAM `ownerId` from the selected scope key, `namespace`, and `userId`, and uses that owner for manual storage, capture, and recall. Raw namespace, user, scope, and OpenClaw session identifiers are not placed in RAM session ids.
- A missing cloud `userId` intentionally creates a shared owner boundary within the selected named scope and namespace. Set `userId` whenever users must not share memories.
- Cloud working-memory ids are deterministic hashes and always match RAM's accepted character set and 64-character limit. Even an explicit `workingMemorySessionId` is encoded rather than sent verbatim; invalid empty values are rejected during config parsing.

### Notes on Multi-Agent Routing

- `scopes` let you define named boundaries with their own `namespace`, `userId`, summary settings, and extraction strategy.
- `agentScopes` route an OpenClaw agent ID to one or more scopes.
- If you configure `scopes` but not `agentScopes`, the plugin falls back to the first defined scope. Add `agentScopes` for deterministic routing.
- Summary and extraction settings inside a scope are subject to the same self-hosted-only restriction as their top-level counterparts.

## Tools

If multiple scopes are available for the current agent, the tools expose an optional `scope` parameter.

### memory_recall

Search through long-term memories.

```json
{
  "query": "user preferences for notifications",
  "limit": 5
}
```

Scoped recall example:

```json
{
  "query": "shipping deadline",
  "limit": 5,
  "scope": "team"
}
```

### memory_store

Save important information to long-term memory.

```json
{
  "text": "User prefers dark mode",
  "category": "preference"
}
```

Scoped store example:

```json
{
  "text": "Team demo is at 2 PM on Friday",
  "category": "decision",
  "scope": "team"
}
```

Categories: `preference`, `fact`, `decision`, `entity`, `other`

### memory_forget

Delete a specific memory from an authorized scope. Query-based requests return candidates for exact-ID confirmation when the backend does not provide similarity scores. On the score-bearing self-hosted backend, only a single result above 0.9 may be deleted directly from a query.

```json
{
  "query": "dark mode preference"
}
```

Or by ID:

```json
{
  "memoryId": "abc123"
}
```

Scoped delete example:

```json
{
  "memoryId": "abc123",
  "scope": "team"
}
```

Before deleting by ID, the plugin fetches the record and verifies the selected scope's complete identity. Cloud requires the exact opaque owner boundary and also checks namespace whenever RAM returns one. Self-hosted checks the record's namespace and user ID. Both backend APIs perform fetch and delete as separate requests, so administrators should restrict store credentials to trusted plugin instances; neither backend currently exposes an atomic conditional delete for this check.

`memory_forget` removes selected long-term records only. It is not a complete data-subject, session, or account erasure workflow.

### memory_erase_scope

`memory_erase_scope` performs the strongest scope-level erasure the configured backend can honestly support. It accepts only a scope already authorized for the current agent and requires an exact `ERASE <scope>` confirmation. During the operation this plugin process blocks new writes for that scope, waits for its in-flight capture, deletes paginated long-term records and related sessions, waits a configurable settling interval for asynchronous extraction output to appear, performs a second sweep, and verifies the RAM owner boundary again.

```json
{
  "scope": "personal",
  "confirm": "ERASE personal"
}
```

RAM cloud supports filter-only, owner-scoped pagination, so a clean result is reported as `verified_best_effort`, never as complete or compliant. The result contains ids, counts, status, and residual codes, but no erased text or credentials. The self-hosted AMS client currently has semantic search only and cannot exhaustively list a subject's long-term records, so it fails closed without deleting a partial subset.

No result certifies deletion from upstream backups, retention systems, queued jobs, or concurrent external writers. Capture quiescing is process-local and ends on restart; AMS summary views are not erased by this workflow. Legal or product owners must approve any compliance claim separately.

## Extraction Strategies (Self-Hosted Only)

The cloud backend always extracts memories automatically, server-side, with no client configuration — `extractionStrategy` and `customPrompt` are ignored there (the plugin logs a one-time warning at startup if you set them).

On the self-hosted backend:

- **discrete**: Extract semantic and episodic memories
- **summary**: Maintain a running conversation summary
- **preferences**: Focus on user preferences and settings
- **custom**: Use your own extraction prompt

If you do not set `extractionStrategy`, the self-hosted server leaves extraction behavior to its own default.

## Environment Variables

### `${VAR}` Substitution

Any string field supports `${VAR_NAME}` substitution, resolved from `process.env` at config-parse time:

```json
{
  "serverUrl": "${AGENT_MEMORY_SERVER_URL}",
  "apiKey": "${AGENT_MEMORY_API_KEY}",
  "userId": "${OPENCLAW_USER_ID}"
}
```

If a referenced variable is not set, config parsing fails with an error like `Environment variable AGENT_MEMORY_SERVER_URL is not set`.

### Cloud Credential Fallbacks

For the cloud provider only, three environment variables are read automatically whenever the matching config field is left unset entirely — you don't need `${...}` syntax for these three:

| Variable | Fills in |
|---|---|
| `AGENT_MEMORY_ENDPOINT` | `serverUrl` |
| `AGENT_MEMORY_API_KEY` | `apiKey` |
| `AGENT_MEMORY_STORE_ID` | `storeId` |

These fallbacks apply only when the corresponding config key is absent and only for the cloud provider. If `serverUrl` is set explicitly but `storeId` is missing from both the config and `AGENT_MEMORY_STORE_ID`, the plugin resolves to `self-hosted` instead — see [Upgrading from 0.x](#upgrading-from-0x).

## Programmatic Usage

```typescript
import redisMemoryPlugin, {
  memoryConfigSchema,
  type PluginApi,
} from "openclaw-redis-agent-memory";

const pluginConfig = memoryConfigSchema.parse({
  serverUrl: "http://localhost:8000",
  namespace: "project-memory",
  userId: "demo-user",
});

const pluginApi: PluginApi = {
  ...yourPluginApi,
  pluginConfig,
};

redisMemoryPlugin.register(pluginApi);
```

The plugin reads configuration from `api.pluginConfig`, so make sure the parsed config is attached there before calling `register`. `memoryConfigSchema.parse` works the same way for either backend — pass cloud fields (`apiKey`, `storeId`) instead of a bare `serverUrl` to get the cloud provider.

## Release Validation and Pilot Limits

The ordinary test suite is credential-free and keeps cloud integration tests
skipped when `AGENT_MEMORY_ENDPOINT`, `AGENT_MEMORY_API_KEY`, and
`AGENT_MEMORY_STORE_ID` are absent. The protected release gate requires all
three names, runs the real RAM suite twice back-to-back, rejects any skipped or
zero-test pass, and writes JUnit, cleanup, and bounded cloud-canary results to
`artifacts/ram-live/` for CI upload.

RAM cloud extraction is asynchronous and long-term memories may take several
minutes to become recallable, especially for sessions submitted back to back.
The protected release test allows up to six minutes for each extraction and
then fails hard; that ceiling is a release check, not a service-latency SLA.

```bash
npm test
npm run test:package
npm run test:load
npm run test:integration:release
```

`test:package` packs the candidate, rejects internal/environment paths, installs
it in an empty project, imports both public entry points, and registers the
plugin. CI runs build, unit, and package-consumer checks on Node 18, 20, and 22,
and runs `actionlint` plus dependency audit before a release can publish.

The deterministic local pilot harness covers 32 configured recall scopes, 16
concurrent capture sessions, 256 messages per session, one injected 429 on each
checkpoint read, and zero accepted errors. It records local p50/p95/p99 values;
these are coordinator/scheduler observations, not cloud service latency claims.
The release-only cloud canary is intentionally smaller (four concurrent
sessions, two events each) and records cloud capture and recall percentiles
with 30-second and 20-second p95 pilot thresholds respectively.

Recall, query-based forget, and summary retrieval use a single global record
budget and at most four provider calls at once. Capture likewise defaults to
four concurrent sessions with a bounded queue. RAM scope erasure is limited to
10,000 records or sessions per operation and validates/deletes at concurrency
four; larger scopes fail closed and should be divided operationally before a
customer pilot. Event writes are not automatically replayed after an ambiguous
failure because RAM does not expose an idempotency key; the coordinator instead
reconciles the remote checkpoint before retrying safe reads.

## Troubleshooting

- If config parsing fails with an error starting `Redis Agent Memory (cloud) is the default backend and requires serverUrl, apiKey, storeId...`, you're missing one or more cloud credentials. Either supply the missing config keys (or their `AGENT_MEMORY_*` env var fallbacks), or set `"provider": "self-hosted"` to use your own server instead.
- If you see `server not reachable`, make sure the container is running (self-hosted) or that your cloud endpoint and credentials are correct, and that `serverUrl` matches the exposed port or cloud endpoint.
- If you set `eagerStartupCheck: false` and see no `connected to server` line while the gateway starts, that is expected. The check runs in the background, so that line, or a `server not reachable` warning, appears shortly after startup rather than during it.
- If auto-recall seems empty, verify that you are using the same `namespace` and `userId` across sessions.
- **"Why don't I see summary context on cloud?"** Summary views are self-hosted only. The cloud backend has no summary-view equivalent, so `summaryViewName`, `summaryTimeWindowDays`, and `summaryGroupBy` are ignored there.
- **"Why are there no percentages in my recall results?"** The cloud backend does not return a similarity score per result, so recall output omits the `(NN%)` suffix. Self-hosted always returns scores.
- Authentication/lookup errors: a `401` means the request was rejected as unauthenticated — check `apiKey` (cloud) or `apiKey`/`bearerToken` (self-hosted). On cloud, a `404` usually means `storeId` is wrong or the store doesn't exist; on self-hosted it usually means an unknown session or memory id.
- If you use `extractionStrategy: "custom"` (self-hosted only), you must also set `customPrompt`.
- If you use `agentScopes`, every referenced scope must exist in `scopes`.
- If you want one shared memory pool for an implementation, leave `userId` unset. If you want isolated memory, set it explicitly.

## Upgrading from 0.x

Redis Agent Memory (cloud) is now the default backend for new installs, but nothing changes for existing deployments unless you opt in:

- **Existing safe `serverUrl`-only configs keep their provider resolution.** A config with `serverUrl` set and no `storeId` (and no `AGENT_MEMORY_STORE_ID` env var) is auto-detected as `self-hosted`. Remote plain-HTTP URLs and URLs containing credentials, query parameters, or fragments are now rejected; use HTTPS or a loopback development endpoint.
- **To move to cloud**, add `apiKey` and `storeId` to your config (or set the `AGENT_MEMORY_API_KEY` / `AGENT_MEMORY_STORE_ID` env vars), or set `"provider": "cloud"` explicitly.
- **Summary views and extraction-strategy settings stop applying once you move to cloud.** The plugin logs a one-time warning listing any such options it is ignoring; it does not fail to start.
- **Cloud scope identity is part of the memory boundary.** Changing a scope key, `namespace`, or `userId` selects a new opaque owner and does not automatically migrate records written under an earlier boundary mapping.
- **Long-term memories do not migrate automatically between backends.** Cloud and self-hosted are separate stores with no built-in data migration. If you need to move existing memories from self-hosted to cloud (or vice versa), you'll need to export and re-ingest them yourself — that's out of scope for this plugin.

## Links

- [Redis Cloud console](https://cloud.redis.io/) — provision Redis Agent Memory (cloud)
- [agent-memory-server documentation](https://redis.github.io/agent-memory-server/) — self-hosted backend
- [OpenClaw](https://github.com/openclaw/openclaw)

## License

MIT
