# OpenAI-Compatible Cache Proxy

Local reverse proxy for OpenAI-compatible chat-completions clients. It injects
explicit `cache_control` markers before forwarding, records usage metrics, and
provides model-alias helpers such as Qwen thinking-mode variants.

The current default profile targets DashScope / Alibaba Cloud Qwen-compatible
endpoints because they support OpenAI-compatible chat completions plus explicit
context cache markers. The repository is no longer scoped to OpenCode only:
OpenCode and Qwen Code are bundled integrations, and other clients can use the
same local `/v1` or `/compatible-mode/v1` proxy URL.

## What it does

```
OpenAI-compatible client ──► localhost:48761 ──► OpenAI-compatible upstream
                              │
                              ├─ Injects cache_control markers on stable prefixes
                              ├─ Rewrites -nothink model aliases
                              ├─ Extracts & records token usage to JSONL
                              └─ Lifecycle: OpenCode plugin or Qwen hooks keep it alive
```

## Repository layout

```
proxy/
  bin/        Proxy entry point (bailian-cache-proxy.mjs)
              Client config entry (bailian-cache-proxy-configure.mjs)
              Qwen hook entry (bailian-cache-proxy-qwen-hook.mjs)
  src/        Server, cache planner, lifecycle, usage recorder
  test/       Unit tests (Node built-in test runner)
  scripts/    CLI tools (cache-stats, e2e)
  .env.example  Deprecated for the OpenCode-managed path
plugins/
  bailian-cache-proxy.js    OpenCode plugin (auto-start + heartbeat)
```

## Prerequisites

- **Node.js** >= 20 (uses `node:test`, `fetch`, ESM)
- **OpenCode** ([install](https://opencode.ai)), **Qwen Code**, or another
  OpenAI-compatible client
- For OpenCode, provider API keys are collected with `opencode auth login`.

## Setup

### 1. Clone or submodule

```bash
# As a git submodule (recommended for config repos)
git submodule add https://github.com/mhbzhy-lost/opencode-cache-proxy.git vendor/opencode-cache-proxy

# Or standalone clone
git clone https://github.com/mhbzhy-lost/opencode-cache-proxy.git
cd opencode-cache-proxy
```

### 2. Configure OpenCode credentials

```bash
node proxy/bin/bailian-cache-proxy-configure.mjs opencode
opencode auth login -p openai-compatible-cached
opencode auth login -p anthropic-cached
```

OpenCode stores provider keys in `~/.local/share/opencode/auth.json`. The
OpenCode provider config carries proxy-only upstream/cache settings in
`options.headers`; the proxy strips those `x-cache-proxy-*` headers before
forwarding requests upstream.

### 3. Configure a client

Run the bundled configurator from this repository:

```bash
# Configure both OpenCode and Qwen Code
node proxy/bin/bailian-cache-proxy-configure.mjs all

# Or configure one client
node proxy/bin/bailian-cache-proxy-configure.mjs opencode
node proxy/bin/bailian-cache-proxy-configure.mjs qwen
```

The configurator is idempotent. It preserves unrelated providers/hooks and
only manages this proxy's provider, plugin, and Qwen lifecycle hooks.

For host repositories that already manage an OpenCode plugin directory, install
the plugin/proxy symlinks there instead of editing `opencode.json.plugin`:

```bash
node proxy/bin/bailian-cache-proxy-configure.mjs opencode \
  --opencode-plugin-mode symlink \
  --opencode-plugin-dir /absolute/path/to/opencode/plugins
```

The JSON below shows what the configurator writes.

#### OpenCode provider

Add a custom provider in your `opencode.json` (usually at
`~/.config/opencode/opencode.json`):

```jsonc
{
  "provider": {
    "openai-compatible-cached": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAI-compatible cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",
        "headers": {
          "x-cache-proxy-upstream-base-url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "x-cache-proxy-marker-strategy": "turn-stable"
        }
      },
      "models": {
        "qwen3.6-plus":           { "name": "Qwen 3.6 Plus" },
        "qwen3.6-plus-nothink":   { "name": "Qwen 3.6 Plus (no thinking)" },
        "qwen3.6-flash":          { "name": "Qwen 3.6 Flash" },
        "qwen3.6-flash-nothink":  { "name": "Qwen 3.6 Flash (no thinking)" },
        "qwen3.7-max":            { "name": "Qwen 3.7 Max" },
        "qwen3.7-max-nothink":    { "name": "Qwen 3.7 Max (no thinking)" }
      }
    },
    "anthropic-cached": {
      "npm": "@ai-sdk/anthropic",
      "name": "Anthropic cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/apps/anthropic/v1",
        "headers": {
          "x-cache-proxy-upstream-base-url": "https://api.anthropic.com",
          "x-cache-proxy-cache-strategy": "cache",
          "x-cache-proxy-metadata-user-id": "<stable-generated-id>"
        }
      },
      "models": {
        "claude-opus-4-6": { "name": "Claude Opus 4.6" }
      }
    }
  }
}
```

The `baseURL` values point at the local proxy. `openai-compatible-cached` uses
the OpenAI-compatible chat-completions route; `anthropic-cached` uses the
Anthropic Messages route via `@ai-sdk/anthropic`. Other OpenCode providers are
unaffected.

Use OpenCode's provider auth flow so provider keys are stored in
`~/.local/share/opencode/auth.json`:

```bash
opencode auth login -p openai-compatible-cached
opencode auth login -p anthropic-cached
```

#### Qwen Code provider

Qwen Code's OpenAI-compatible provider can point at the same local proxy. This
example uses the standard `/v1` local path; the proxy maps it to the configured
upstream path.

```jsonc
// ~/.qwen/settings.json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-plus",
        "name": "Qwen 3.6 Plus (cached)",
        "envKey": "BAILIAN_TOKEN_PLAN_API_KEY",
        "baseUrl": "http://127.0.0.1:48761/v1",
        "generationConfig": {
          "enableCacheControl": true,
          "contextWindowSize": 1000000
        }
      },
      {
        "id": "qwen3.7-max",
        "name": "Qwen 3.7 Max (cached)",
        "envKey": "BAILIAN_TOKEN_PLAN_API_KEY",
        "baseUrl": "http://127.0.0.1:48761/v1",
        "generationConfig": {
          "enableCacheControl": true,
          "contextWindowSize": 1000000
        }
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  }
}
```

For OpenCode-managed traffic, do not configure provider credentials in
`proxy/.env`; the production OpenCode path does not load that file.

### 4. Start the proxy

**Option A — OpenCode plugin (recommended).** The plugin auto-starts the proxy
when OpenCode launches and sends heartbeats to keep it alive. OpenCode exits =
proxy exits after idle timeout.

OpenCode loads plugins from a directory. Point your plugin path to
`<repo-root>/plugins/`:

```jsonc
// opencode.json
{
  "plugin": ["<absolute-path-to>/opencode-cache-proxy/plugins"]
}
```

OpenCode will discover and load `bailian-cache-proxy.js` from that directory.
Verify:

```bash
curl -s http://127.0.0.1:48761/__bailian_cache_proxy/health
# {"ok":true,"activePids":[...]}
```

**Option B — Qwen Code hooks.** Add SessionStart and SessionEnd hooks that call
the helper. SessionStart starts the proxy if needed and spawns a per-session
keepalive process; SessionEnd stops that keepalive so the proxy can idle-exit.

```jsonc
// ~/.qwen/settings.json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <absolute-path-to>/opencode-cache-proxy/proxy/bin/bailian-cache-proxy-qwen-hook.mjs start",
            "name": "bailian-cache-proxy-start",
            "timeout": 10000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <absolute-path-to>/opencode-cache-proxy/proxy/bin/bailian-cache-proxy-qwen-hook.mjs stop",
            "name": "bailian-cache-proxy-stop",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

Disable Qwen hook-managed startup with `QWEN_BAILIAN_CACHE_PROXY=0`.

**Option C — Manual start.** Run without plugin/hooks — useful for debugging:

```bash
node proxy/bin/bailian-cache-proxy.mjs

# Verify
curl -s http://127.0.0.1:48761/__bailian_cache_proxy/health
```

Without heartbeats the proxy exits after `BAILIAN_CACHE_PROXY_IDLE_EXIT_MS`
(default 60s). Send manual heartbeats:

```bash
curl -s -X POST http://127.0.0.1:48761/__bailian_cache_proxy/heartbeat \
  -H 'content-type: application/json' \
  -d "{\"pid\": $$}"
```

## Thinking Mode Variants

Each Qwen3 model is exposed twice:

| Alias | Behavior |
|-------|----------|
| `qwen3.7-max` | Model defaults (`enable_thinking=true`, `thinking_budget=max`) |
| `qwen3.7-max-nothink` | Proxy strips suffix, injects `enable_thinking=false` upstream |

Same for `qwen3.6-plus` and `qwen3.6-flash`. The `-nothink` suffix is retained
on usage records so `cache-stats --by model` shows two cohorts.

## Usage Observability

Every request appends a metadata-only JSON line (no prompt/completion text) to:

```
${BAILIAN_CACHE_PROXY_USAGE_LOG:-~/.cache/bailian-cache-proxy/usage.jsonl}
```

### CLI stats

```bash
# Today, grouped by model
node proxy/scripts/cache-stats.mjs

# Time windows
node proxy/scripts/cache-stats.mjs --since 2h
node proxy/scripts/cache-stats.mjs --since today --by status

# JSON output for piping
node proxy/scripts/cache-stats.mjs --since today --json

# Different log path
node proxy/scripts/cache-stats.mjs --log /tmp/usage-snapshot.jsonl --since all
```

### Raw JSONL access

```bash
LOG=~/.cache/bailian-cache-proxy/usage.jsonl

tail -n 50 "$LOG" | jq -r '[.ts, .model, .cache_hit_ratio] | @tsv'
jq -c 'select(.status >= 400)' "$LOG"
```

## Tests

```bash
(cd proxy && node --test)
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BAILIAN_CACHE_PROXY_PORT` | `48761` | Local listen port |
| `BAILIAN_CACHE_PROXY_MIN_TOKENS` | `1024` | Min prefix tokens before adding cache markers |
| `BAILIAN_CACHE_PROXY_MAX_BODY_BYTES` | `10485760` | Max request body size |
| `BAILIAN_CACHE_PROXY_USAGE_LOG` | `~/.cache/bailian-cache-proxy/usage.jsonl` | Usage log path |
| `BAILIAN_CACHE_PROXY_IDLE_EXIT_MS` | `60000` | Idle timeout after all pids gone |
| `OPENCODE_BAILIAN_CACHE_PROXY` | — | Set `0` to disable plugin proxy startup |
| `QWEN_BAILIAN_CACHE_PROXY` | — | Set `0` to disable Qwen hook proxy startup |

## See also

- [`proxy/README.md`](proxy/README.md) — cache planning strategy, record schema,
  concurrency safety
