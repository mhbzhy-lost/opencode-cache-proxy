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
  bailian-cache-proxy.js    OpenCode plugin (auto-start local proxy singleton)
```

## Prerequisites

- **Node.js** >= 20 (uses `node:test`, `fetch`, ESM)
- **OpenCode** ([install](https://opencode.ai)), **Qwen Code**, or another
  OpenAI-compatible client
- For OpenCode, provider API keys are stored in OpenCode auth storage via the
  bundled interactive bootstrap.

## Setup

### 1. Clone or submodule

```bash
# As a git submodule (recommended for config repos)
git submodule add https://github.com/mhbzhy-lost/opencode-cache-proxy.git vendor/opencode-cache-proxy

# Or standalone clone
git clone https://github.com/mhbzhy-lost/opencode-cache-proxy.git
cd opencode-cache-proxy
```

### 2. One-command OpenCode install

For a new machine that only needs OpenCode, run:

```bash
bash install-opencode.sh
```

The script configures `~/.config/opencode/opencode.json`, adds this repo's
OpenCode plugin path, and then prompts for provider API keys via OpenCode auth
storage. Restart OpenCode after the script exits; the plugin starts the proxy
automatically on the next launch.

For non-interactive verification or CI:

```bash
bash install-opencode.sh --no-auth
```

### 3. Configure OpenCode credentials manually

```bash
node proxy/bin/bailian-cache-proxy-configure.mjs opencode
node proxy/bin/opencode-cache-proxy-auth.mjs
```

The auth bootstrap reads the provider list from OpenCode's existing
`opencode.json`, lets you choose a provider, and writes the API key to
`~/.local/share/opencode/auth.json`. Run it once per provider you want to use.
The OpenCode provider config carries proxy-only upstream/cache settings in
`options.headers`; the proxy strips those `x-cache-proxy-*` headers before
forwarding requests upstream.
The dynamic upstream override header is honored only for loopback clients; if
the proxy is bound to a non-local interface, remote clients cannot choose an
arbitrary upstream URL.

### 4. Configure a client

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
    "openai-bailiab-api": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAI Bailian API cached",
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
        "qwen3.7-max-512k":       { "name": "Qwen 3.7 Max (512k)", "limit": { "context": 512000, "output": 65536 } },
        "qwen3.7-max-1m":         { "name": "Qwen 3.7 Max (1M)", "limit": { "context": 1000000, "output": 65536 } },
        "qwen3.7-max-nothink":    { "name": "Qwen 3.7 Max (no thinking)" }
      }
    },
    "openai-bailian-token-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAI Bailian token-plan cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",
        "headers": {
          "x-cache-proxy-upstream-base-url": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
          "x-cache-proxy-marker-strategy": "turn-stable"
        }
      },
      "models": {
        "qwen3.6-plus":           { "name": "Qwen 3.6 Plus" },
        "qwen3.6-plus-nothink":   { "name": "Qwen 3.6 Plus (no thinking)" },
        "qwen3.6-flash":          { "name": "Qwen 3.6 Flash" },
        "qwen3.6-flash-nothink":  { "name": "Qwen 3.6 Flash (no thinking)" },
        "qwen3.7-max":            { "name": "Qwen 3.7 Max" },
        "qwen3.7-max-512k":       { "name": "Qwen 3.7 Max (512k)", "limit": { "context": 512000, "output": 65536 } },
        "qwen3.7-max-1m":         { "name": "Qwen 3.7 Max (1M)", "limit": { "context": 1000000, "output": 65536 } },
        "qwen3.7-max-nothink":    { "name": "Qwen 3.7 Max (no thinking)" }
      }
    },
    "openai-idealab": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenAI Idealab",
      "options": {
        "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",
        "headers": {
          "x-cache-proxy-upstream-base-url": "https://idealab.alibaba-inc.com/api/openai/v1",
          "x-cache-proxy-marker-strategy": "turn-stable"
        }
      },
      "models": {
        "Qwen3.7-Max-DogFooding": { "name": "Qwen 3.7 Max DogFooding" }
      }
    },
    "anthropic-idealab-cached": {
      "npm": "@ai-sdk/anthropic",
      "name": "Anthropic Idealab cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/apps/anthropic/v1",
        "headers": {
          "x-cache-proxy-upstream-base-url": "https://idealab.alibaba-inc.com/api/anthropic",
          "x-cache-proxy-cache-strategy": "cache",
          "x-cache-proxy-upstream-user-agent": "claude-cli/2.1.156 (external, sdk-cli)",
          "x-cache-proxy-metadata-user-id": "<stable-generated-id>"
        }
      },
      "models": {
        "claude-opus-4-6": {
          "name": "Claude Opus 4.6",
          "options": { "effort": "high" },
          "variants": {
            "low": { "effort": "low" },
            "medium": { "effort": "medium" },
            "high": { "effort": "high" },
            "max": { "effort": "max" }
          }
        }
      }
    }
  }
}
```

The cached provider `baseURL` values point at the local proxy.
`openai-bailiab-api` and `openai-bailian-token-plan` use the OpenAI-compatible
chat-completions route with DashScope/Bailian and token-plan upstreams.
`openai-idealab` uses the OpenAI-compatible chat-completions route with the same
`turn-stable` marker strategy as the bailian providers and exposes
`Qwen3.7-Max-DogFooding`; it appears in cache usage stats like other OpenAI-compatible providers. `anthropic-idealab-cached` uses the Anthropic
Messages route via `@ai-sdk/anthropic` and carries the Idealab upstream plus
Claude-compatible upstream user-agent in provider headers. Add another platform-specific
Anthropic provider when another upstream is needed.
The Opus model defaults to high effort and exposes `low`, `medium`, `high`,
and `max` OpenCode variants for switching thinking intensity.
Other OpenCode providers are unaffected.

Use the bundled auth bootstrap so provider keys are stored in
`~/.local/share/opencode/auth.json`:

```bash
node proxy/bin/opencode-cache-proxy-auth.mjs
```

The command shows the existing OpenCode providers, prompts for one API key, and
preserves any credentials already present in `auth.json`.

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

### 5. Start the proxy

**Option A — OpenCode plugin (recommended).** The plugin checks the local
health endpoint when OpenCode launches. If the proxy is not already running,
it starts one detached local proxy process and disables that child process's
idle exit. Repeated OpenCode launches do not start duplicate proxies because
the health check succeeds once the singleton is listening.

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
# {"ok":true,"activePids":[]}
```

**Option B — Qwen Code hooks.** Add a SessionStart hook that calls the same
local proxy ensure helper. SessionEnd is optional and currently a no-op because
proxy lifecycle is shared across clients.

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

Manual starts also keep the proxy running by default. To make a manual debug
proxy exit after an idle window, set a positive timeout:

```bash
BAILIAN_CACHE_PROXY_IDLE_EXIT_MS=60000 node proxy/bin/bailian-cache-proxy.mjs
```

## Thinking Mode Variants

Each Qwen3 model is exposed twice:

| Alias | Behavior |
|-------|----------|
| `qwen3.7-max` | Model defaults (`enable_thinking=true`, `thinking_budget=max`) |
| `qwen3.7-max-512k` | OpenCode context limit 512k / output limit 64k; proxy forwards upstream as `qwen3.7-max` |
| `qwen3.7-max-1m` | OpenCode context limit 1M / output limit 64k; proxy forwards upstream as `qwen3.7-max` |
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
| `BAILIAN_CACHE_PROXY_IDLE_EXIT_MS` | `0` | Idle timeout; `0` disables proxy idle exit |
| `OPENCODE_BAILIAN_CACHE_PROXY` | — | Set `0` to disable plugin proxy startup |
| `QWEN_BAILIAN_CACHE_PROXY` | — | Set `0` to disable Qwen hook proxy startup |

## See also

- [`proxy/README.md`](proxy/README.md) — cache planning strategy, record schema,
  concurrency safety
