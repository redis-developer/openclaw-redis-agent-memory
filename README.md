# openclaw-redis-agent-memory

[![npm version](https://img.shields.io/npm/v/openclaw-redis-agent-memory.svg)](https://www.npmjs.com/package/openclaw-redis-agent-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Long-term memory plugin for [OpenClaw](https://github.com/openclaw/openclaw) using Redis vector search.

Give your AI agent persistent memory across conversations - it can remember user preferences, past decisions, important facts, and more.

## Features

- **Auto-recall**: Automatically inject relevant memories into context before each turn
- **Auto-capture**: Save conversations to working memory for background extraction
- **Manual tools**: `memory_recall`, `memory_store`, `memory_forget` for explicit control
- **Summary Views**: Rolling summaries of long-term memories for stable context
- **Multi-tenancy**: Namespace and userId support for memory isolation
- **Configurable tool descriptions**: Customize how the LLM sees and uses memory tools

## Quick Start

### 1. Start the Memory Server

The easiest way to run the memory server is with the standalone Docker image (includes Redis):

```bash
# Create .env file with your OpenAI key
echo "OPENAI_API_KEY=sk-your-key-here" > .env

# Run the standalone image
docker run -d \
  --name agent-memory \
  --platform linux/amd64 \
  --env-file .env \
  -p 8000:8000 \
  redislabs/agent-memory-server:0.13.1-standalone
```

For more configuration options, see the [agent-memory-server documentation](https://redis.github.io/agent-memory-server/).

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
          "namespace": "my-app",
          "userId": "user-123"
        }
      }
    }
  }
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serverUrl` | string | `http://localhost:8000` | Base URL of agent-memory-server |
| `apiKey` | string | - | API key for authentication |
| `bearerToken` | string | - | Bearer token for authentication |
| `namespace` | string | `default` | Namespace for memory isolation |
| `userId` | string | `default` | User ID for memory isolation |
| `timeout` | number | `30000` | Request timeout in milliseconds |
| `autoCapture` | boolean | `true` | Auto-save conversations for extraction |
| `autoRecall` | boolean | `true` | Auto-inject relevant memories |
| `minScore` | number | `0.3` | Minimum similarity score (0-1) |
| `recallLimit` | number | `3` | Max memories to recall |
| `extractionStrategy` | string | `discrete` | `discrete`, `summary`, `preferences`, or `custom` |
| `customPrompt` | string | - | Custom extraction prompt (for `custom` strategy) |
| `summaryViewName` | string | `agent_user_summary` | Name for the summary view |
| `summaryTimeWindowDays` | number | `30` | Rolling window for summaries |
| `summaryGroupBy` | array | `["user_id"]` | Fields to partition summaries |
| `recallDescription` | string | - | Custom description for memory_recall tool |
| `storeDescription` | string | - | Custom description for memory_store tool |
| `forgetDescription` | string | - | Custom description for memory_forget tool |

## Tools

### memory_recall

Search through long-term memories.

```json
{
  "query": "user preferences for notifications",
  "limit": 5
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

Categories: `preference`, `fact`, `decision`, `entity`, `other`

### memory_forget

Delete specific memories (GDPR-compliant).

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

## Extraction Strategies

- **discrete** (default): Extract semantic and episodic memories
- **summary**: Maintain a running conversation summary
- **preferences**: Focus on user preferences and settings
- **custom**: Use your own extraction prompt

## Environment Variables

Use `${VAR_NAME}` syntax for environment variable substitution:

```json
{
  "serverUrl": "${AGENT_MEMORY_SERVER_URL}",
  "apiKey": "${AGENT_MEMORY_API_KEY}"
}
```

## Server Configuration

The `.env` file for agent-memory-server supports many options:

```bash
# Required
OPENAI_API_KEY=sk-your-key-here

# Optional - customize the embedding model
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small

# Optional - use a different LLM for memory extraction
# OPENAI_LLM_MODEL=gpt-4o-mini
```

See the [full configuration reference](https://redis.github.io/agent-memory-server/) for all options.

## Programmatic Usage

```typescript
import redisMemoryPlugin, { memoryConfigSchema } from "openclaw-redis-agent-memory";

// Parse config
const config = memoryConfigSchema.parse({
  serverUrl: "http://localhost:8000",
  namespace: "my-app",
});

// Register with your plugin system
redisMemoryPlugin.register(yourPluginApi);
```

## Links

- [agent-memory-server documentation](https://redis.github.io/agent-memory-server/)
- [OpenClaw](https://github.com/openclaw/openclaw)

## License

MIT

