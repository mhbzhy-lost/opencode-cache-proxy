# opencode-cache-proxy

Local reverse proxy + [OpenCode](https://opencode.ai) plugin for Alibaba Cloud
Bailian (DashScope) chat completions. Intercepts requests, injects Bailian
explicit context-cache markers before forwarding, records usage metrics, and
provides thinking-mode model aliases.

## What it does

```
OpenCode ──► localhost:48761 ──► dashscope.aliyuncs.com
                  │
                  ├─ Injects cache_control markers on stable prefixes
                  ├─ Rewrites -nothink model aliases
                  ├─ Extracts & records token usage to JSONL
                  └─ Lifecycle: auto-exits when all OpenCode pids gone
```

## Repository layout

```
proxy/
  bin/        Proxy entry point (bailian-cache-proxy.mjs)
  src/        Server, cache planner, lifecycle, usage recorder
  test/       Unit tests (Node built-in test runner)
  scripts/    CLI tools (cache-stats, e2e)
  .env.example
plugins/
  bailian-cache-proxy.js    OpenCode plugin (auto-start + heartbeat)
```

## Prerequisites

- **Node.js** >= 20 (uses `node:test`, `fetch`, ESM)
- **OpenCode** ([install](https://opencode.ai))
- **DashScope API key** ([Bailian console](https://bailian.console.aliyun.com/))

## Setup

### 1. Clone or submodule

```bash
# As a git submodule (recommended for config repos)
git submodule add https://github.com/mhbzhy-lost/opencode-cache-proxy.git vendor/opencode-cache-proxy

# Or standalone clone
git clone https://github.com/mhbzhy-lost/opencode-cache-proxy.git
cd opencode-cache-proxy
```

### 2. Configure credentials

```bash
cp proxy/.env.example proxy/.env
# Edit proxy/.env — at minimum set DASHSCOPE_API_KEY
```

`.env` is gitignored. The proxy loads it on startup so it works even when
OpenCode is launched from a GUI (no shell env).

### 3. Configure OpenCode provider

Add a custom provider in your `opencode.json` (usually at
`~/.config/opencode/opencode.json`):

```jsonc
{
  "provider": {
    "bailian-custom-cached": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Bailian custom cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",
        "apiKey": "{env:DASHSCOPE_API_KEY}"
      },
      "models": {
        "qwen3.6-plus":           { "name": "Qwen 3.6 Plus" },
        "qwen3.6-plus-nothink":   { "name": "Qwen 3.6 Plus (no thinking)" },
        "qwen3.6-flash":          { "name": "Qwen 3.6 Flash" },
        "qwen3.6-flash-nothink":  { "name": "Qwen 3.6 Flash (no thinking)" },
        "qwen3.7-max":            { "name": "Qwen 3.7 Max" },
        "qwen3.7-max-nothink":    { "name": "Qwen 3.7 Max (no thinking)" }
      }
    }
  }
}
```

The `baseURL` points at the local proxy. Only `bailian-custom-cached` goes
through the proxy; other OpenCode providers are unaffected.

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

**Option B — Manual start.** Run without the plugin — useful for debugging or
non-OpenCode setups:

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
| `DASHSCOPE_API_KEY` | — | DashScope API key (required) |
| `BAILIAN_CACHE_PROXY_PORT` | `48761` | Local listen port |
| `BAILIAN_UPSTREAM_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Upstream endpoint |
| `BAILIAN_CACHE_PROXY_MIN_TOKENS` | `1024` | Min prefix tokens before adding cache markers |
| `BAILIAN_CACHE_PROXY_MAX_BODY_BYTES` | `10485760` | Max request body size |
| `BAILIAN_CACHE_PROXY_USAGE_LOG` | `~/.cache/bailian-cache-proxy/usage.jsonl` | Usage log path |
| `BAILIAN_CACHE_PROXY_IDLE_EXIT_MS` | `60000` | Idle timeout after all pids gone |
| `OPENCODE_BAILIAN_CACHE_PROXY` | — | Set `0` to disable plugin proxy startup |

## See also

- [`proxy/README.md`](proxy/README.md) — cache planning strategy, record schema,
  concurrency safety
