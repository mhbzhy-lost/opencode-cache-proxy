#!/usr/bin/env node
/**
 * E2E verification: prove that the local Bailian cache proxy actually wires
 * explicit context caching against the real DashScope (or token-plan) upstream.
 *
 * Manual run only — not part of `npm test`. Requires:
 *   opencode/proxy/.env with DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL.
 *
 * Cost budget: ~2 calls of qwen-turbo with ≈1100-token prompt and 8 max_tokens.
 *
 * Pass criteria: second call's usage.prompt_tokens_details.cached_tokens > 0.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvFile } from "../src/load-env.mjs"
import { createBailianCacheProxy } from "../src/server.mjs"
import { createUsageRecorder } from "../src/usage-recorder.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, "..", ".env")

// e2e — unlike the production proxy — must hard-fail when .env is missing or
// unreadable. Silently degrading would let the script continue with no creds
// and surface the failure as an opaque 401 from upstream, which the previous
// inline loader caught immediately by throwing on read.
{
  const result = loadEnvFile(envPath)
  if (!result.loaded) {
    const reason = result.error ? `unreadable: ${result.error.message}` : "not found"
    console.error(`❌ ${envPath} ${reason}; e2e cannot run without DASHSCOPE_API_KEY`)
    process.exit(1)
  }
}

const apiKey = process.env.DASHSCOPE_API_KEY
const upstreamBaseUrl =
  process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
const model = process.env.DASHSCOPE_E2E_MODEL || "qwen3.6-flash"
const cacheCreationWaitMs = Number(process.env.DASHSCOPE_E2E_WAIT_MS || 8000)
const fetchTimeoutMs = Number(process.env.DASHSCOPE_E2E_FETCH_TIMEOUT_MS || 30_000)

const usageLogPath =
  process.env.BAILIAN_CACHE_PROXY_USAGE_LOG ||
  join(
    process.env.XDG_CACHE_HOME || join(process.env.HOME || "", ".cache"),
    "bailian-cache-proxy",
    "usage.jsonl",
  )

const countUsageLines = async () => {
  try {
    const text = await readFile(usageLogPath, "utf8")
    return text.split("\n").filter((l) => l.trim()).length
  } catch {
    return 0
  }
}

// Snapshot baseline before we run requests so polling later only counts new
// records produced by this script — prevents stale logs from making the wait
// return immediately with leftover lines from a previous failed run.
const usageLogBaseline = await countUsageLines()

if (!apiKey) {
  console.error("❌ DASHSCOPE_API_KEY missing in .env")
  process.exit(1)
}

const upstreamUrl = new URL(upstreamBaseUrl)
const upstreamPathPrefix = upstreamUrl.pathname.replace(/\/$/, "")

// e2e is testing the *production* recording path, so opt into the real
// usage recorder here (createBailianCacheProxy now defaults to NOOP for unit
// safety — see test/server.test.mjs).
const usageRecorder = createUsageRecorder({})

const { server } = createBailianCacheProxy({
  upstreamBaseUrl,
  apiKey,
  cacheOptions: { minCacheTokens: 1024 },
  lifecycle: false,
  usageRecorder,
})

const address = await new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(server.address())),
)

const proxyUrl = `http://127.0.0.1:${address.port}${upstreamPathPrefix}/chat/completions`

const SYSTEM_BUFFER = "stable-context ".repeat(700)
const SYSTEM = `You are a quiet assistant. Reply with one short word only. ${SYSTEM_BUFFER}`

const callOnce = async (turn) => {
  const start = Date.now()
  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `turn ${turn}: reply OK` },
      ],
      max_tokens: 8,
      enable_thinking: false,
    }),
    signal: AbortSignal.timeout(fetchTimeoutMs),
  })
  let body
  try {
    body = await response.json()
  } catch (err) {
    body = { _parse_error: String(err) }
  }
  return { status: response.status, body, ms: Date.now() - start }
}

const summarize = (label, run) => {
  const u = run.body?.usage || {}
  const det = u.prompt_tokens_details || u.input_tokens_details || {}
  const summary = {
    status: run.status,
    ms: run.ms,
    prompt_tokens: u.prompt_tokens ?? u.input_tokens,
    completion_tokens: u.completion_tokens ?? u.output_tokens,
    cache_creation_input_tokens: det.cache_creation_input_tokens,
    cached_tokens: det.cached_tokens,
    error: run.body?.error,
  }
  console.log(`${label}:`, JSON.stringify(summary, null, 2))
  console.log(`  raw usage:`, JSON.stringify(u, null, 2))
  if (run.status !== 200) {
    console.log(`  raw body:`, JSON.stringify(run.body, null, 2))
  }
  return summary
}

let exitCode = 0
try {
  console.log(`Upstream: ${upstreamBaseUrl}`)
  console.log(`Model:    ${model}`)
  console.log(`Proxy:    http://${address.address}:${address.port}`)
  console.log()

  const r1 = await callOnce(1)
  const s1 = summarize("Run 1 (expect cache_creation > 0, cached_tokens == 0)", r1)

  if (r1.status !== 200) {
    console.error("\n❌ FAIL: Run 1 non-200")
    exitCode = 1
  } else {
    console.log(`\nWaiting ${cacheCreationWaitMs}ms before Run 2...\n`)
    await new Promise((resolve) => setTimeout(resolve, cacheCreationWaitMs))

    const r2 = await callOnce(2)
    const s2 = summarize("Run 2 (expect cached_tokens > 0)", r2)

    console.log("\n=== Verdict ===")
    if (r2.status !== 200) {
      console.error("❌ FAIL: Run 2 non-200")
      exitCode = 1
    } else if ((s2.cached_tokens || 0) > 0) {
      console.log(
        `✅ PASS: explicit cache hit confirmed (cached_tokens=${s2.cached_tokens}, ` +
          `cache_creation in run1=${s1.cache_creation_input_tokens || 0})`,
      )
    } else {
      console.error(
        `❌ FAIL: cached_tokens == 0 in Run 2.\n` +
          `   Possible causes: (1) DashScope explicit cache not enabled on this account/endpoint, ` +
          `(2) prompt < 1024 tokens after upstream tokenization, ` +
          `(3) proxy did not inject cache_control marker (check server logs), ` +
          `(4) AI SDK / openai-compatible adapter strips unknown fields.`,
      )
      exitCode = 1
    }
  }
} catch (err) {
  console.error(`❌ FAIL: ${err.stack || err}`)
  exitCode = 1
} finally {
  server.close()
  // Wait for fire-and-forget usage records to land. Poll until we observe at
  // least usageLogBaseline + expectedRuns *new* records, with a 5s timeout.
  // Comparing against the baseline (captured at script start) prevents stale
  // logs from satisfying the predicate without our writes ever finishing.
  const expectedRuns = 2
  const target = usageLogBaseline + expectedRuns
  const pollDeadline = Date.now() + 5000
  while (Date.now() < pollDeadline) {
    if ((await countUsageLines()) >= target) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  process.exit(exitCode)
}
