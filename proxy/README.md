# OpenAI-Compatible Cache Proxy

This proxy is for OpenAI-compatible chat-completions clients. It adds explicit
`cache_control` markers before forwarding requests to an OpenAI-compatible
upstream, then records cache usage metadata. The default upstream/profile is
DashScope/Qwen-compatible, but the proxy is not tied to OpenCode or to a single
client.

Configure clients with the bundled CLI:

```bash
node bin/bailian-cache-proxy-configure.mjs all
```

This updates OpenCode and Qwen Code settings idempotently while preserving
unrelated providers and hooks. The OpenCode providers it writes to
`opencode.json` (usually `~/.config/opencode/opencode.json`) looks like:

```json
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

Authenticate cached providers with OpenCode auth storage:

```bash
opencode auth login -p openai-compatible-cached
opencode auth login -p anthropic-cached
```

See the [root README](../README.md) for full setup instructions.

Other providers do not use this proxy. The proxy has this upstream default:

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

Only chat completions paths are forwarded upstream. Control endpoints under
`/__bailian_cache_proxy/*` stay local, and any other path returns `404`.

Any client that can set an OpenAI-compatible base URL can use the same proxy by
pointing at `http://127.0.0.1:48761/v1` or
`http://127.0.0.1:48761/compatible-mode/v1`. The proxy maps both local paths
onto the configured upstream base path.

## Lifecycle

The `plugins/bailian-cache-proxy.js` plugin starts the proxy if it is
not already running and sends periodic heartbeats with the current OpenCode
process pid. For Qwen Code, use
`bin/bailian-cache-proxy-qwen-hook.mjs start` on `SessionStart` and
`bin/bailian-cache-proxy-qwen-hook.mjs stop` on `SessionEnd`; the start command
spawns a per-session keepalive process that sends the same heartbeat protocol.
The proxy exits after all registered client pids are gone and the idle timeout
elapses.

## Runtime Environment

OpenCode provider credentials and upstream routing are not read from
`proxy/.env`. The production OpenCode path uses OpenCode auth storage for keys
and provider `options.headers` for upstream/cache settings.
The upstream URL control header is accepted only from loopback clients, so a
proxy bound to a non-local interface cannot be used by remote clients as an
arbitrary upstream forwarder.

- `BAILIAN_CACHE_PROXY_PORT`: local proxy port, default `48761`.
- `BAILIAN_CACHE_PROXY_MIN_TOKENS`: minimum estimated prefix tokens before
  adding cache markers, default `1024`.
- `BAILIAN_CACHE_PROXY_MAX_BODY_BYTES`: maximum accepted request body size,
  default `10485760`.
- `BAILIAN_CACHE_PROXY_MARKER_STRATEGY`: cache marker placement algorithm.
  Values: `turn-stable` (default) or `fraction`. See the
  [Cache Planning](#cache-planning) section for details.
- `BAILIAN_CACHE_PROXY_KEEPALIVE`: activity-driven keepalive. Set to `0` to
  disable; default is `1` (enabled, 4.5 min threshold). See [Keepalive](#keepalive).
- `OPENCODE_BAILIAN_CACHE_PROXY=0`: disables plugin-managed proxy startup.
- `QWEN_BAILIAN_CACHE_PROXY=0`: disables Qwen hook-managed proxy startup.

## Thinking Mode Variants

Each Qwen3 model is exposed twice in `openai-compatible-cached`:

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
`model` (the client-facing alias including `-nothink` suffix when chosen),
`status`, `duration_ms`, `is_stream`, `stream_usage_seen`, `prompt_tokens`,
`completion_tokens`, `cached_tokens`, `cache_creation_input_tokens`,
`request_id`, `proxy_error`, `cache_hit_ratio`. No prompt or completion text
ever lands in the log — exfiltration risk is bounded to token counts and
model names.

### Concurrency safety

Writes use POSIX `O_APPEND`; each line is < 1 KB which is well under
`PIPE_BUF` (4096 B), so concurrent writers (multiple client processes sharing
one proxy, or rare multi-proxy races) cannot interleave bytes.
Records exceeding the PIPE_BUF safety margin are rejected with a stderr WARN
rather than risk torn writes.

## Cache Planning

The planner strips existing `cache_control` markers and emits at most four
markers. Placement strategy is controlled by
`BAILIAN_CACHE_PROXY_MARKER_STRATEGY`.

### `turn-stable` (default)

Anchors mid-markers at **user-message turn boundaries**, the points in
conversation history where the user sends a genuine prompt (as opposed to
`role=user` tool-result blocks which shift as more tool calls accumulate).

Marker layout for a typical coding-agent turn:

| Slot | Role | Position |
|------|------|----------|
| 0 | system | End of system/developer prefix (stable for life of chat) |
| 1 | user | First message of the previous user turn (stable until next turn) |
| 2 | user | First message of the current user turn (stable within the turn) |
| 3 | any | Last eligible block (tail anchor, advances on every request) |

Within a single opencode turn the user sends one message, the assistant fires
many tool calls (accumulating tool-result `user` blocks), then produces the
final response. The prefix up to the user's real prompt is **constant** across
every tool call in that turn — a marker at the user message boundary therefore
hits the upstream cache for every subsequent request in the turn.

Across turns, the previous turn's user message becomes a stable prefix point
since Turn N's full history is a fixed prefix of Turn N+1's history:

```
Request A (turn 1, in-flight): [system, turn0_user, turn1_user, tail]
Request B (turn 2, in-flight): [system, turn1_user, turn2_user, tail]
                                ^^^^^^^^ ^^^^^^^^^^ ^^^^^^^^^^
                                stable across both requests
```

If fewer than two turn-boundary user messages are found (short conversations
or tool-only interactions), the planner falls back to the `fraction` strategy
for the remaining slots.

### `fraction` (legacy)

Places two mid-markers at token-fraction positions `[0.5, 0.85]` between the
system anchor and the tail anchor. Markers drift forward with the growing
conversation; each new request invalidates the previous request's mid-prefix
cache until the next 5-minute renewal window.

Production data from a full day of opencode use showed that 44% of consecutive
4-marker request pairs under this strategy had **zero** matching marker hashes
— mid-markers shifted on nearly every request. Turn-stable eliminates this
drift within a turn.

### Record schema note

Each usage record carries `cache_diagnostic.strategy` (= `turn-stable` or
`fraction`), so `cache-stats` and raw `jq` queries can segment hit-rate
analysis by the strategy in effect:

```bash
jq -r '[.ts, .model, .cache_diagnostic.strategy, .cache_hit_ratio] | @tsv' \
  ~/.cache/bailian-cache-proxy/usage.jsonl
```

Qwen/DashScope-compatible backends create cache blocks after a response
returns, so the first request may create cache while later requests should show
cache reads in `usage`.

The proxy only accepts uncompressed JSON request bodies. Requests with
`content-encoding` other than `identity` return `415`.

## Keepalive

DashScope invalidates cache blocks 5 minutes after the last request that
touched them. For interactive coding sessions, gaps longer than 5 minutes
between requests are common (reading docs, reviewing diffs, stepping away).
Without intervention the next request after such a gap gets a full cache miss
and pays the creation cost again.

The keepalive module (`src/keepalive.mjs`) watches every session for activity
and sends **one** lightweight ping to upstream when a session has been silent
for 4.5 minutes. The ping resets the 5-minute TTL window, so a session that
returns within 9.5 minutes of its last real request still finds a warm cache.

### Mechanism

- Every successful chat-completions request calls `registerHit(sessionKey,
  truncatedBody)`, where `sessionKey` is the marker-0 `prefix_hash` (stable
  within a conversation).
- A 30-second scan timer checks the activity map. Any entry older than the
  threshold that has not yet been pinged fires `sendKeepalive`.
- The ping is a single upstream POST carrying the truncated body (messages up
  to marker 2, with `cache_control` stripped). The response is discarded; only
  the upstream's TTL refresh matters.
- A `keepaliveSent` flag prevents repeated pings in the same idle window. The
  flag resets on every real `registerHit`, so the mechanism is single-shot per
  idle gap.

### Trade-offs

| Parameter | Default | Effect |
|-----------|---------|--------|
| `thresholdMs` | 270 000 (4.5 min) | Idle time before the ping fires. Must be < DashScope TTL (5 min). Lower = more headroom but more pings on short pauses. |
| `scanIntervalMs` | 30 000 | How often the activity map is scanned. Lower = tighter timing but more CPU. |
| `minHits` | 2 | Minimum real hits a session needs before the keepalive arms. Prevents pinging one-shot requests that won't return. |

Disable entirely with `BAILIAN_CACHE_PROXY_KEEPALIVE=0` if your upstream
does not use DashScope-style TTL, or if you prefer to pay the occasional
cache-miss cost rather than send background requests.
