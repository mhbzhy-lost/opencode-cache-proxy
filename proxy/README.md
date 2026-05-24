# OpenCode Bailian Cache Proxy

This proxy is only for Alibaba Cloud Bailian / DashScope OpenAI-compatible chat
completions. It adds Bailian explicit context-cache markers before forwarding
requests to DashScope. It can be used by OpenCode through the bundled plugin or
by Qwen Code through the bundled SessionStart/SessionEnd hook helper.

Configure a custom OpenCode provider in `opencode.json`
(usually `~/.config/opencode/opencode.json`):

```json
{
  "provider": {
    "bailian-custom-cached": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Bailian custom cached",
      "options": {
        "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",
        "apiKey": "{env:DASHSCOPE_API_KEY}"
      }
    }
  }
}
```

See the [root README](../README.md) for full setup instructions.

Other providers do not use this proxy. The proxy has a fixed upstream default:

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

Only chat completions paths are forwarded upstream. Control endpoints under
`/__bailian_cache_proxy/*` stay local, and any other path returns `404`.

Qwen Code can use the same proxy by pointing an OpenAI-compatible model
provider at `http://127.0.0.1:48761/v1`. The proxy accepts both `/v1` and
`/compatible-mode/v1` local request paths and maps them onto the configured
upstream base path.

## Lifecycle

The `plugins/bailian-cache-proxy.js` plugin starts the proxy if it is
not already running and sends periodic heartbeats with the current OpenCode
process pid. For Qwen Code, use
`bin/bailian-cache-proxy-qwen-hook.mjs start` on `SessionStart` and
`bin/bailian-cache-proxy-qwen-hook.mjs stop` on `SessionEnd`; the start command
spawns a per-session keepalive process that sends the same heartbeat protocol.
The proxy exits after all registered client pids are gone and the idle timeout
elapses.

## Environment

- `DASHSCOPE_API_KEY`: DashScope API key used by OpenCode and as proxy fallback
  when the request has no `Authorization` header.
- `BAILIAN_CODING_PLAN_API_KEY`: Alibaba Cloud Coding Plan API key fallback,
  useful for Qwen Code setups that target `https://coding.dashscope.aliyuncs.com/v1`.
- `BAILIAN_CACHE_PROXY_PORT`: local proxy port, default `48761`.
- `BAILIAN_UPSTREAM_BASE_URL`: upstream base URL, default China DashScope
  compatible-mode endpoint.
- `BAILIAN_CACHE_PROXY_MIN_TOKENS`: minimum estimated prefix tokens before
  adding cache markers, default `1024`.
- `BAILIAN_CACHE_PROXY_MAX_LOOKBACK_BLOCKS`: Bailian content-block lookback
  window, default `20`.
- `BAILIAN_CACHE_PROXY_MAX_BODY_BYTES`: maximum accepted request body size,
  default `10485760`.
- `OPENCODE_BAILIAN_CACHE_PROXY=0`: disables plugin-managed proxy startup.
- `QWEN_BAILIAN_CACHE_PROXY=0`: disables Qwen hook-managed proxy startup.
- `BAILIAN_CACHE_PROXY_STATE_DIR`: Qwen hook pidfile directory.
- `QWEN_BAILIAN_CACHE_PROXY_HEARTBEAT_MS`: Qwen keepalive heartbeat interval,
  default `15000`.
- `QWEN_BAILIAN_CACHE_PROXY_MAX_STDIN_BYTES`: maximum accepted Qwen hook JSON
  input size, default `65536`.

## Thinking Mode Variants

Each Qwen3 model is exposed twice in `bailian-custom-cached`:

- `qwen3.6-plus` / `qwen3.6-flash` / `qwen3.7-max` — model defaults
  (`enable_thinking=true`, `thinking_budget=max`); model self-adapts depth.
- `qwen3.6-plus-nothink` / `qwen3.6-flash-nothink` / `qwen3.7-max-nothink` —
  proxy strips the suffix and injects `enable_thinking=false` before
  forwarding. Upstream sees only the real model id.

The user-facing alias (with the `-nothink` suffix when applicable) is kept on
the usage record so `cache-stats --by model` shows two cohorts and you can
compare hit rate / cost between thinking-on and thinking-off use of the same
underlying model.

## Usage Observability — Exporting Cache Hit-Rate Data

Every chat-completions request appends one **metadata-only** JSON line (no
prompt or completion text) to the usage log. Default location:

```
${BAILIAN_CACHE_PROXY_USAGE_LOG:-${XDG_CACHE_HOME:-~/.cache}/bailian-cache-proxy/usage.jsonl}
```

### Quick stats from the CLI

```bash
# Today, grouped by model (default) — overall + per-model hit ratio,
# avg duration, failure breakdown, streaming usage capture rate.
node proxy/scripts/cache-stats.mjs

# Time windows: --since 30m | 2h | 24h | YYYY-MM-DD | today | all
node proxy/scripts/cache-stats.mjs --since 2h

# Group by status to see failure distribution
node proxy/scripts/cache-stats.mjs --since today --by status

# JSON output for piping into a dashboard / further processing
node proxy/scripts/cache-stats.mjs --since today --json

# Different log path (e.g. ad-hoc analysis on a copied snapshot)
node proxy/scripts/cache-stats.mjs --log /tmp/usage-snapshot.jsonl --since all
```

### Raw NDJSON access

`usage.jsonl` is one JSON object per line; use `jq` for arbitrary cuts:

```bash
LOG=~/.cache/bailian-cache-proxy/usage.jsonl

# Hit ratio per request, last 50 requests
tail -n 50 "$LOG" | jq -r '[.ts, .model, .cache_hit_ratio] | @tsv'

# Failures only (status >= 400)
jq -c 'select(.status >= 400)' "$LOG"

# Total cached vs creation tokens for one model alias
jq -s '
  map(select(.model == "qwen3.6-flash-nothink")) |
  {cached: (map(.cached_tokens // 0) | add),
   created: (map(.cache_creation_input_tokens // 0) | add)}
' "$LOG"
```

### Record schema

Each line carries: `ts`, `proxy_pid`, `opencode_pid` (currently always null),
`model` (the OpenCode-facing alias including `-nothink` suffix when chosen),
`status`, `duration_ms`, `is_stream`, `stream_usage_seen`, `prompt_tokens`,
`completion_tokens`, `cached_tokens`, `cache_creation_input_tokens`,
`request_id`, `proxy_error`, `cache_hit_ratio`. No prompt or completion text
ever lands in the log — exfiltration risk is bounded to token counts and
model names.

### Concurrency safety

Writes use POSIX `O_APPEND`; each line is < 1 KB which is well under
`PIPE_BUF` (4096 B), so concurrent writers (multiple OpenCode processes
sharing one proxy, or rare multi-proxy races) cannot interleave bytes.
Records exceeding the PIPE_BUF safety margin are rejected with a stderr WARN
rather than risk torn writes.

## Cache Planning

The planner strips existing `cache_control` markers and emits at most four
markers:

- one early stable marker on the first eligible system/developer prefix
- rolling tail markers so long OpenCode sessions refresh cache points near the
  latest stable conversation prefix

Bailian creates cache blocks after a response returns, so the first request may
create cache while later requests should show cache reads in `usage`.

The proxy only accepts uncompressed JSON request bodies. Requests with
`content-encoding` other than `identity` return `415`.
