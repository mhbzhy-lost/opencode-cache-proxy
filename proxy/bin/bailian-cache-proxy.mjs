#!/usr/bin/env node

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvFile } from "../src/load-env.mjs"
import { createBailianCacheProxy } from "../src/server.mjs"
import { createUsageRecorder } from "../src/usage-recorder.mjs"

// The proxy is normally spawned by a client integration and inherits whatever
// env that parent process happened to have. GUI-launched clients may not read
// ~/.zshrc, so load the proxy-local .env directly.
const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, "..", ".env")
const { loaded, vars, error } = loadEnvFile(envPath)
if (error) {
  process.stderr.write(
    `bailian-cache-proxy: .env present at ${envPath} but unreadable (${error.message}); ` +
      `falling back to inherited env\n`,
  )
} else if (loaded) {
  if (vars.length > 0) {
    process.stderr.write(
      `bailian-cache-proxy: loaded .env from ${envPath} (${vars.length} new vars)\n`,
    )
  } else {
    process.stderr.write(
      `bailian-cache-proxy: .env at ${envPath} read OK; all vars already present in environment\n`,
    )
  }
}

const envNumber = (name, fallback) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const host = process.env.BAILIAN_CACHE_PROXY_HOST || "127.0.0.1"
const port = envNumber("BAILIAN_CACHE_PROXY_PORT", 48761)

const upstreamBaseUrl = process.env.OPENAI_COMPATIBLE_UPSTREAM_BASE_URL

// Marker strategy: "turn-stable" (default) anchors mid-markers at user-role
// turn boundaries, yielding stable cache keys across requests in the same
// turn. "fraction" restores the legacy 0.5/0.85 token-fraction placement.
// Override with BAILIAN_CACHE_PROXY_MARKER_STRATEGY in .env.
const markerStrategy = (
  process.env.BAILIAN_CACHE_PROXY_MARKER_STRATEGY || "turn-stable"
).toLowerCase().trim() || "turn-stable"

// Production recorder writes to ~/.cache/bailian-cache-proxy/usage.jsonl.
// createBailianCacheProxy itself defaults to a no-op recorder so unit tests
// don't pollute the user's stats file; this entrypoint is the only place that
// opts into the real one.
const usageRecorder = createUsageRecorder({})

const { server } = createBailianCacheProxy({
  upstreamBaseUrl,
  idleExitMs: envNumber("BAILIAN_CACHE_PROXY_IDLE_EXIT_MS", 60_000),
  lifecycleCheckMs: envNumber("BAILIAN_CACHE_PROXY_LIFECYCLE_CHECK_MS", 5_000),
  maxBodyBytes: envNumber("BAILIAN_CACHE_PROXY_MAX_BODY_BYTES", 10 * 1024 * 1024),
  cacheOptions: {
    minCacheTokens: envNumber("BAILIAN_CACHE_PROXY_MIN_TOKENS", 1024),
    markerStrategy,
    // Note: BAILIAN_CACHE_PROXY_MAX_LOOKBACK_BLOCKS is deprecated. The cache
    // planner no longer uses fixed N-block rolling tail markers. The env var
    // is intentionally not forwarded so the option doesn't get silently
    // ignored downstream.
  },
  usageRecorder,
})

server.listen(port, host, () => {
  process.stderr.write(`bailian-cache-proxy listening on http://${host}:${port}\n`)
})
