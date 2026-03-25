# openclaw-redis-agent-memory

[![npm version](https://img.shields.io/npm/v/openclaw-redis-agent-memory.svg)](https://www.npmjs.com/package/openclaw-redis-agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) using Redis vector search.

Give your AI agent persistent memory across conversations. It can remember user preferences, past decisions, important facts, and more.

## Features

- **Auto-recall**: Automatically inject relevant memories into context before each turn
- **Auto-capture**: Save conversations to working memory for background extraction
- **Manual tools**: `memory_recall`, `memory_store`, `memory_forget` for explicit control
- **Summary views**: Rolling summaries of long-term memories for stable context
- **Multi-tenancy**: Namespace and optional `userId` support for memory isolation
- **Multi-agent routing**: Named scopes and agent-specific routes for shared and personal memory
- **Configurable tool descriptions**: Customize how the LLM sees and uses memory tools

## Requirements

- OpenClaw `>=2025.0.0`
- Node.js `>=18` if you are building locally or using the package programmatically
- Docker for the quickest local memory-server setup
- An OpenAI API key for `agent-memory-server`

## Quick Start

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
          "serverUrl": "http://localhost:8000",
          "namespace": "hackathon-demo",
          "userId": "demo-user"
        }
      }
    }
  }
}
```

Set `userId` explicitly if you want per-user memory isolation. Leave `userId` unset only when you intentionally want everyone using the same `namespace` to share memory.

### 4. Verify It Works

Use a deterministic smoke test before building on top of the plugin:

1. Start OpenClaw with the plugin enabled.
2. Confirm the plugin can reach the server. The OpenClaw logs should include a line like `redis-memory: connected to server (...)`.
3. In a chat or tool playground, store a known fact:

```json
{
  "tool": "memory_store",
  "arguments": {
    "text": "Hackathon team name is Vector Cats",
    "category": "entity"
  }
}
```

4. Recall it immediately:

```json
{
  "tool": "memory_recall",
  "arguments": {
    "query": "hackathon team name",
    "limit": 3
  }
}
```

If recall works, your server URL, namespace, auth, and plugin wiring are all in a good state.

## Hackathon Setup Recipes

### Shared Team Memory

Use one shared `namespace` and leave `userId` unset:

```json
{
  "serverUrl": "http://localhost:8000",
  "namespace": "team-shared"
}
```

This is the fastest setup when the whole team should see the same long-term memory.

### Per-User Isolation

Use the same `namespace`, but assign each participant their own `userId`:

```json
{
  "serverUrl": "http://localhost:8000",
  "namespace": "hackathon-demo",
  "userId": "aditi"
}
```

This keeps memories isolated per person while still grouping the project under one namespace.

### Shared Plus Personal Memory Across Agents

For multi-agent demos, define named scopes and route each OpenClaw agent to the right memory boundary:

```json
{
  "plugins": {
    "entries": {
      "redis-memory": {
        "enabled": true,
        "config": {
          "serverUrl": "http://localhost:8000",
          "namespace": "hackathon-demo",
          "scopes": {
            "team": {
              "label": "Team Shared"
            },
            "aditi": {
              "label": "Aditi Personal",
              "userId": "aditi"
            },
            "research": {
              "label": "Research Shared"
            }
          },
          "agentScopes": {
            "main": {
              "primaryScope": "team",
              "recallScopes": ["team", "aditi"],
              "toolScopes": ["team", "aditi"],
              "defaultStoreScope": "team"
            },
            "researcher": {
              "primaryScope": "research",
              "recallScopes": ["team", "research"],
              "toolScopes": ["team", "research"],
              "defaultStoreScope": "research"
            }
          }
        }
      }
    }
  }
}
```

When multiple scopes are available, the manual memory tools expose an optional `scope` parameter so you can store, search, or delete within a specific memory boundary.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | string | `http://localhost:8000` | Base URL of `agent-memory-server` |
| `apiKey` | string | unset | API key for server authentication |
| `bearerToken` | string | unset | Bearer token for server authentication |
| `namespace` | string | `default` | Top-level memory boundary, usually one app, team, or project |
| `userId` | string | unset | Optional secondary boundary for per-user memory isolation |
| `workingMemorySessionId` | string | unset | Reuse one working-memory session across OpenClaw sessions |
| `timeout` | number | `30000` | Request timeout in milliseconds |
| `autoCapture` | boolean | `true` | Save new conversation turns to working memory |
| `autoRecall` | boolean | `true` | Inject relevant long-term memory before each turn |
| `minScore` | number | `0.3` | Minimum similarity score for memory recall |
| `recallLimit` | number | `3` | Max recalled memories per search |
| `extractionStrategy` | string | server default | `discrete`, `summary`, `preferences`, or `custom` |
| `customPrompt` | string | unset | Custom extraction prompt for `custom` strategy |
| `summaryViewName` | string | `agent_user_summary` | Summary view name for rolling memory summaries |
| `summaryTimeWindowDays` | number | `30` | Rolling window for summary generation |
| `summaryGroupBy` | array | `["user_id"]` | Fields to partition summaries by |
| `recallDescription` | string | built-in description | Override the LLM-facing description for `memory_recall` |
| `storeDescription` | string | built-in description | Override the LLM-facing description for `memory_store` |
| `forgetDescription` | string | built-in description | Override the LLM-facing description for `memory_forget` |
| `scopes` | object | unset | Named memory boundaries for multi-agent setups |
| `agentScopes` | object | unset | Map OpenClaw agent IDs to recall, capture, and tool scopes |

### Notes on Isolation

- `namespace` is the broadest isolation boundary. It is usually the right place to separate apps, demos, or hackathon projects.
- `userId` is optional. If you do not set it, memory is scoped only by `namespace`.
- For stable demos, prefer setting `userId` explicitly whenever memory should stay isolated to one person or one bot persona.

### Notes on Multi-Agent Routing

- `scopes` let you define named boundaries with their own `namespace`, `userId`, summary settings, and extraction strategy.
- `agentScopes` route an OpenClaw agent ID to one or more scopes.
- If you configure `scopes` but not `agentScopes`, the plugin falls back to the first defined scope. Add `agentScopes` for deterministic routing.

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

Delete specific memories.

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

## Extraction Strategies

- **discrete**: Extract semantic and episodic memories
- **summary**: Maintain a running conversation summary
- **preferences**: Focus on user preferences and settings
- **custom**: Use your own extraction prompt

If you do not set `extractionStrategy`, the plugin leaves extraction behavior to the server default.

## Environment Variables

Use `${VAR_NAME}` syntax for environment variable substitution:

```json
{
  "serverUrl": "${AGENT_MEMORY_SERVER_URL}",
  "apiKey": "${AGENT_MEMORY_API_KEY}",
  "userId": "${OPENCLAW_USER_ID}"
}
```

## Server Configuration

The `.env` file for `agent-memory-server` supports many options:

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

## Programmatic Usage

```typescript
import redisMemoryPlugin, {
  memoryConfigSchema,
  type PluginApi,
} from "openclaw-redis-agent-memory";

const pluginConfig = memoryConfigSchema.parse({
  serverUrl: "http://localhost:8000",
  namespace: "hackathon-demo",
  userId: "demo-user",
});

const pluginApi: PluginApi = {
  ...yourPluginApi,
  pluginConfig,
};

redisMemoryPlugin.register(pluginApi);
```

The plugin reads configuration from `api.pluginConfig`, so make sure the parsed config is attached there before calling `register`.

## Troubleshooting

- If you see `server not reachable`, make sure the container is running and `serverUrl` matches the exposed port.
- If auto-recall seems empty, verify that you are using the same `namespace` and `userId` across sessions.
- If you use `extractionStrategy: "custom"`, you must also set `customPrompt`.
- If you use `agentScopes`, every referenced scope must exist in `scopes`.
- If you want one shared memory pool for a demo, leave `userId` unset. If you want isolated memory, set it explicitly.

## Links

- [agent-memory-server documentation](https://redis.github.io/agent-memory-server/)
- [OpenClaw](https://github.com/openclaw/openclaw)

## License

MIT
