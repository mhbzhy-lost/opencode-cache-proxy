#!/usr/bin/env node

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvFile } from "../src/load-env.mjs"
import { createBailianCacheProxy } from "../src/server.mjs"
import { createUsageRecorder } from "../src/usage-recorder.mjs"

// The proxy is normally spawned by the OpenCode plugin and inherits whatever
// env that parent process happened to have. OpenCode launched from a desktop
// shortcut won't read ~/.zshrc, so DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL may
// be missing from the inherited env. Load the skill-local .env directly so the
// proxy is self-sufficient regardless of how OpenCode itself was started.
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

// Accept DASHSCOPE_BASE_URL as a fallback for BAILIAN_UPSTREAM_BASE_URL: the
// .env file uses the dashscope-namespaced var because users copy it from
// dashscope's onboarding doc; the proxy historically only honoured its own
// BAILIAN_-prefixed name.
const upstreamBaseUrl =
  process.env.BAILIAN_UPSTREAM_BASE_URL || process.env.DASHSCOPE_BASE_URL

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
    // Note: BAILIAN_CACHE_PROXY_MAX_LOOKBACK_BLOCKS is deprecated. The cache
    // planner no longer uses fixed N-block rolling tail markers; it places
    // markers at token fractions instead (see DEFAULT_MARKER_FRACTIONS in
    // src/cache-planner.mjs). The env var is intentionally not forwarded so
    // the option doesn't get silently ignored downstream.
  },
  usageRecorder,
})

server.listen(port, host, () => {
  process.stderr.write(`bailian-cache-proxy listening on http://${host}:${port}\n`)
})
