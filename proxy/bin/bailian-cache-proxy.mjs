#!/usr/bin/env node

import { createAnthropicHandler } from "../src/anthropic-handler.mjs"
import { createKeepaliveManager } from "../src/keepalive.mjs"
import { createBailianCacheProxy } from "../src/server.mjs"
import { createUsageRecorder } from "../src/usage-recorder.mjs"
import { setupCrashHandlers } from "../src/crash-logging.mjs"

const envNumber = (name, fallback) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const host = process.env.BAILIAN_CACHE_PROXY_HOST || "127.0.0.1"
const port = envNumber("BAILIAN_CACHE_PROXY_PORT", 48761)

// Keepalive: activity-driven cache TTL renewal. Sends ONE ping to upstream
// after a session goes idle for 4.5 min, extending the DashScope 5min TTL.
// Default enabled; set BAILIAN_CACHE_PROXY_KEEPALIVE=0 to disable.
const keepaliveEnabled = process.env.BAILIAN_CACHE_PROXY_KEEPALIVE !== "0"
const keepaliveThresholdMs = envNumber("BAILIAN_CACHE_PROXY_KEEPALIVE_THRESHOLD_MS", 270_000)
const keepaliveScanIntervalMs = envNumber("BAILIAN_CACHE_PROXY_KEEPALIVE_SCAN_INTERVAL_MS", 30_000)
const keepaliveMinHits = envNumber("BAILIAN_CACHE_PROXY_KEEPALIVE_MIN_HITS", 2)

// Production recorder writes to ~/.cache/bailian-cache-proxy/usage.jsonl.
// createBailianCacheProxy itself defaults to a no-op recorder so unit tests
// don't pollute the user's stats file; this entrypoint is the only place that
// opts into the real one.
const usageRecorder = createUsageRecorder({})

const anthropicKeepaliveManager = keepaliveEnabled
  ? createKeepaliveManager({
      thresholdMs: keepaliveThresholdMs,
      scanIntervalMs: keepaliveScanIntervalMs,
      minHits: keepaliveMinHits,
      enabled: true,
    })
  : null
if (anthropicKeepaliveManager) anthropicKeepaliveManager.startTimer()

const anthropicHandler = createAnthropicHandler({
  upstreamBaseUrl: "https://api.anthropic.com",
  cacheOptions: {
    minCacheTokens: envNumber("BAILIAN_CACHE_PROXY_MIN_TOKENS", 1024),
  },
  usageRecorder,
  keepaliveManager: anthropicKeepaliveManager,
})

const { server } = createBailianCacheProxy({
  idleExitMs: envNumber("BAILIAN_CACHE_PROXY_IDLE_EXIT_MS", 0),
  lifecycleCheckMs: envNumber("BAILIAN_CACHE_PROXY_LIFECYCLE_CHECK_MS", 5_000),
  maxBodyBytes: envNumber("BAILIAN_CACHE_PROXY_MAX_BODY_BYTES", 10 * 1024 * 1024),
  cacheOptions: {
    minCacheTokens: envNumber("BAILIAN_CACHE_PROXY_MIN_TOKENS", 1024),
    keepalive: keepaliveEnabled
      ? {
          enabled: true,
          thresholdMs: keepaliveThresholdMs,
          scanIntervalMs: keepaliveScanIntervalMs,
          minHits: keepaliveMinHits,
        }
      : { enabled: false },
    // Note: BAILIAN_CACHE_PROXY_MAX_LOOKBACK_BLOCKS is deprecated. The cache
    // planner no longer uses fixed N-block rolling tail markers. The env var
    // is intentionally not forwarded so the option doesn't get silently
    // ignored downstream.
  },
  usageRecorder,
  anthropicHandler,
})

// Diagnostic: catch all fatal async paths (uncaughtException, unhandledRejection,
// signals, exit) and write to ~/.cache/bailian-cache-proxy/crash.log so proxy
// crashes are never silent.
setupCrashHandlers()

server.listen(port, host, () => {
  process.stderr.write(
    `bailian-cache-proxy listening on http://${host}:${port} (pid=${process.pid}, ppid=${process.ppid})\n`
  )
})
