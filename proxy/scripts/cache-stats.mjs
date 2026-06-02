#!/usr/bin/env node
/**
 * Read the bailian-cache-proxy usage log and print cache hit-rate stats.
 *
 * Default window is "today" (local-day boundary). Override with --since:
 *   --since 2h           last 2 hours
 *   --since 30m          last 30 minutes
 *   --since 2026-05-23   from given local date 00:00 onward
 *   --since all          no time filter (whole file)
 *
 * Other options:
 *   --log <path>         path to usage.jsonl (default: $BAILIAN_CACHE_PROXY_USAGE_LOG
 *                        or $XDG_CACHE_HOME/bailian-cache-proxy/usage.jsonl
 *                        or ~/.cache/bailian-cache-proxy/usage.jsonl)
 *   --by model|status|protocol|turn-prev
 *                        grouping for the breakdown table (default: model)
 *   --json               emit summary as JSON instead of formatted text
 */

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { defaultUsageLogPath } from "../src/usage-recorder.mjs"

const argv = process.argv.slice(2)
const args = {
  since: "today",
  log: null,
  by: "model",
  json: false,
}
const validGroupBys = new Set(["model", "status", "protocol", "turn-prev"])
const TARGET_CACHE_HIT_RATIO = 0.97
const WARM_HIT_THRESHOLD = 0.5
const requireValue = (flag, value) => {
  if (value === undefined) {
    console.error(`${flag} requires a value`)
    process.exit(2)
  }
  return value
}

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === "--since") args.since = requireValue("--since", argv[++i])
  else if (a === "--log") args.log = requireValue("--log", argv[++i])
  else if (a === "--by") {
    args.by = requireValue("--by", argv[++i])
    if (!validGroupBys.has(args.by)) {
      console.error(`invalid --by: ${args.by}`)
      process.exit(2)
    }
  }
  else if (a === "--json") args.json = true
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      [
        "Usage: cache-stats.mjs [--since today|24h|30m|YYYY-MM-DD|all]",
        "                       [--log path/to/usage.jsonl]",
        "                       [--by model|status|protocol|turn-prev] [--json]",
      ].join("\n") + "\n",
    )
    process.exit(0)
  } else {
    console.error(`unknown arg: ${a}`)
    process.exit(2)
  }
}

const logPath = args.log || defaultUsageLogPath()

const parseSince = (spec) => {
  if (!spec || spec === "all") return null
  if (spec === "today") {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const durationMatch = spec.match(/^(\d+)([smhd])$/)
  if (durationMatch) {
    const [, n, unit] = durationMatch
    const ms = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
    return Date.now() - Number(n) * ms
  }
  const dateMatch = spec.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateMatch) {
    const [, y, mo, d] = dateMatch.map(Number)
    return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
  }
  console.error(`invalid --since: ${spec}`)
  process.exit(2)
}

const sinceMs = parseSince(args.since)

try {
  await stat(logPath)
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`no usage log at ${logPath}`)
    console.error("run something through the proxy first; default location:")
    console.error("  ~/.cache/bailian-cache-proxy/usage.jsonl")
    process.exit(0)
  }
  throw err
}

// Read line-by-line to avoid loading one huge string for multi-day logs.
// Parsed records are kept in memory so they can be grouped after filtering.
const records = []
let totalLineCount = 0
const lineStream = createInterface({
  input: createReadStream(logPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
})
for await (const line of lineStream) {
  const trimmed = line.trim()
  if (!trimmed) continue
  totalLineCount += 1
  try {
    records.push(JSON.parse(trimmed))
  } catch {
    // skip malformed lines silently
  }
}

const filtered =
  sinceMs == null
    ? records
    : records.filter((r) => {
        const t = Date.parse(r.ts)
        return Number.isFinite(t) && t >= sinceMs
      })

const initBucket = () => ({
  count: 0,
  failures: 0,
  first_seen: null,
  last_seen: null,
  input_tokens: 0,
  prompt_tokens: 0,
  cache_read_input_tokens: 0,
  cached_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_denominator_tokens: 0,
  warm_count: 0,
  warm_cache_read_input_tokens: 0,
  warm_cache_denominator_tokens: 0,
  cold_creation_count: 0,
  cold_creation_input_tokens: 0,
  target_gap_tokens: 0,
  output_tokens: 0,
  completion_tokens: 0,
  total_duration_ms: 0,
  stream_count: 0,
  stream_usage_seen: 0,
  context_tokens_total: 0,
  context_tokens_seen: 0,
  marker_signatures: new Map(),
})

const normalizedUsage = (r) => {
  const isAnthropic =
    r.protocol === "anthropic" ||
    r.cache_read_input_tokens !== undefined ||
    r.input_tokens !== undefined
  const input = Number(isAnthropic ? r.input_tokens || 0 : r.prompt_tokens || 0)
  const read = Number(isAnthropic ? r.cache_read_input_tokens || 0 : r.cached_tokens || 0)
  const created = Number(r.cache_creation_input_tokens || 0)
  const output = Number(isAnthropic ? r.output_tokens || 0 : r.completion_tokens || 0)
  const cacheDenominator = isAnthropic ? input + read + created : input
  return { input, read, created, output, cacheDenominator }
}

const accumulate = (bucket, r) => {
  const usage = normalizedUsage(r)
  const hitRatio = usage.cacheDenominator > 0 ? usage.read / usage.cacheDenominator : 0
  const targetGap = Math.max(0, TARGET_CACHE_HIT_RATIO * usage.cacheDenominator - usage.read)
  const tsMs = Date.parse(r.ts)
  bucket.count += 1
  if (typeof r.status === "number" && r.status >= 400) bucket.failures += 1
  if (Number.isFinite(tsMs)) {
    bucket.first_seen = bucket.first_seen == null ? r.ts : bucket.first_seen
    bucket.last_seen = r.ts
  }
  bucket.input_tokens += usage.input
  bucket.prompt_tokens += usage.input
  bucket.cache_read_input_tokens += usage.read
  bucket.cached_tokens += usage.read
  bucket.cache_creation_input_tokens += usage.created
  bucket.cache_denominator_tokens += usage.cacheDenominator
  if (hitRatio >= WARM_HIT_THRESHOLD) {
    bucket.warm_count += 1
    bucket.warm_cache_read_input_tokens += usage.read
    bucket.warm_cache_denominator_tokens += usage.cacheDenominator
  }
  if (hitRatio < WARM_HIT_THRESHOLD && usage.created > 0) {
    bucket.cold_creation_count += 1
    bucket.cold_creation_input_tokens += usage.created
  }
  bucket.target_gap_tokens += targetGap
  bucket.output_tokens += usage.output
  bucket.completion_tokens += usage.output
  bucket.total_duration_ms += Number(r.duration_ms || 0)
  if (r.is_stream) {
    bucket.stream_count += 1
    if (r.stream_usage_seen) bucket.stream_usage_seen += 1
  }
  const contextTokens = Number(r.cache_diagnostic?.total_estimated_tokens || 0)
  if (contextTokens > 0) {
    bucket.context_tokens_total += contextTokens
    bucket.context_tokens_seen += 1
  }
  const signature = markerSignature(r)
  if (signature) {
    bucket.marker_signatures.set(signature, (bucket.marker_signatures.get(signature) || 0) + 1)
  }
}

const turnPrevKey = (r) =>
  r.cache_diagnostic?.markers?.find((m) => m.location === "turn-prev")?.prefix_hash ||
  "no-turn-prev"

const markerSignature = (r) =>
  (r.cache_diagnostic?.markers || [])
    .map((m) => m.location)
    .filter(Boolean)
    .join(">")

const topMarkerSignature = (bucket) =>
  [...bucket.marker_signatures.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null

const timeWindowKey = (r, minutes = 15) => {
  const d = new Date(r.ts)
  if (!Number.isFinite(d.getTime())) return "unknown"
  const minute = Math.floor(d.getUTCMinutes() / minutes) * minutes
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

const contextBucketKey = (r) => {
  const tokens = Number(r.cache_diagnostic?.total_estimated_tokens || 0)
  if (tokens < 50_000) return "<50k"
  if (tokens < 100_000) return "50-100k"
  if (tokens < 200_000) return "100-200k"
  if (tokens < 300_000) return "200-300k"
  if (tokens < 500_000) return "300-500k"
  return ">=500k"
}

const overall = initBucket()
const groups = new Map()
const turnPrevGroups = new Map()
const markerSignatureGroups = new Map()
const timeWindowGroups = new Map()
const contextBucketGroups = new Map()

const groupKeyFor = (r) => {
  if (args.by === "status") return String(r.status ?? "unknown")
  if (args.by === "protocol") return r.protocol || "openai-compatible"
  if (args.by === "turn-prev") return turnPrevKey(r)
  return r.model || "unknown"
}

for (const r of filtered) {
  accumulate(overall, r)
  const key = groupKeyFor(r)
  if (!groups.has(key)) groups.set(key, initBucket())
  accumulate(groups.get(key), r)

  const turnPrev = turnPrevKey(r)
  if (!turnPrevGroups.has(turnPrev)) turnPrevGroups.set(turnPrev, initBucket())
  accumulate(turnPrevGroups.get(turnPrev), r)

  const signature = markerSignature(r) || "(none)"
  if (!markerSignatureGroups.has(signature)) markerSignatureGroups.set(signature, initBucket())
  accumulate(markerSignatureGroups.get(signature), r)

  const windowKey = timeWindowKey(r)
  if (!timeWindowGroups.has(windowKey)) timeWindowGroups.set(windowKey, initBucket())
  accumulate(timeWindowGroups.get(windowKey), r)

  const contextKey = contextBucketKey(r)
  if (!contextBucketGroups.has(contextKey)) contextBucketGroups.set(contextKey, initBucket())
  accumulate(contextBucketGroups.get(contextKey), r)
}

const ratio = (numer, denom) =>
  denom > 0 ? Math.round((numer / denom) * 10000) / 100 : 0

const summarize = (b) => ({
  requests: b.count,
  failures: b.failures,
  first_seen: b.first_seen,
  last_seen: b.last_seen,
  success_rate_pct: ratio(b.count - b.failures, b.count),
  avg_duration_ms: b.count > 0 ? Math.round(b.total_duration_ms / b.count) : 0,
  input_tokens: b.input_tokens,
  prompt_tokens: b.prompt_tokens,
  cache_read_input_tokens: b.cache_read_input_tokens,
  cached_tokens: b.cached_tokens,
  cache_creation_input_tokens: b.cache_creation_input_tokens,
  output_tokens: b.output_tokens,
  completion_tokens: b.completion_tokens,
  cache_hit_ratio_pct: ratio(b.cache_read_input_tokens, b.cache_denominator_tokens),
  target_cache_hit_ratio_pct: TARGET_CACHE_HIT_RATIO * 100,
  target_gap_tokens: Math.round(b.target_gap_tokens),
  warm_requests: b.warm_count,
  warm_cache_hit_ratio_pct: ratio(
    b.warm_cache_read_input_tokens,
    b.warm_cache_denominator_tokens,
  ),
  cold_creation_requests: b.cold_creation_count,
  cold_creation_input_tokens: b.cold_creation_input_tokens,
  cold_creation_pct: ratio(b.cold_creation_input_tokens, b.cache_creation_input_tokens),
  avg_context_tokens:
    b.context_tokens_seen > 0 ? Math.round(b.context_tokens_total / b.context_tokens_seen) : 0,
  marker_signature: topMarkerSignature(b),
  stream_requests: b.stream_count,
  stream_usage_capture_pct: ratio(b.stream_usage_seen, b.stream_count),
})

const summarizeEntries = (entries, sorter = (a, b) => b[1].count - a[1].count) =>
  Object.fromEntries(
    [...entries]
      .sort(sorter)
      .map(([k, v]) => [k, summarize(v)]),
  )

const summarizeTopGap = (entries, limit = 12) =>
  [...entries]
    .map(([key, bucket]) => ({ key, ...summarize(bucket) }))
    .sort((a, b) => b.target_gap_tokens - a.target_gap_tokens)
    .slice(0, limit)

const result = {
  log_path: logPath,
  since: args.since,
  total_records_in_file: totalLineCount,
  records_in_window: filtered.length,
  by: args.by,
  overall: summarize(overall),
  groups: summarizeEntries(groups.entries()),
  top_gap_cohorts: summarizeTopGap(turnPrevGroups.entries()),
  marker_signatures: summarizeEntries(markerSignatureGroups.entries()),
  time_windows: summarizeEntries(timeWindowGroups.entries(), (a, b) => a[0].localeCompare(b[0])),
  context_buckets: summarizeEntries(contextBucketGroups.entries()),
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n))

const renderTable = (label, summary) => {
  const lines = [
    `--- ${label} ---`,
    `requests:                 ${fmtNum(summary.requests)} (${fmtNum(summary.failures)} failures, ${summary.success_rate_pct}% success)`,
    `avg duration:             ${fmtNum(summary.avg_duration_ms)}ms`,
    `prompt tokens:            ${fmtNum(summary.prompt_tokens)}`,
    `cached tokens:            ${fmtNum(summary.cached_tokens)}`,
    `cache_creation tokens:    ${fmtNum(summary.cache_creation_input_tokens)}`,
    `completion tokens:        ${fmtNum(summary.completion_tokens)}`,
    `cache hit ratio:          ${summary.cache_hit_ratio_pct}%`,
    `warm cache hit ratio:     ${summary.warm_cache_hit_ratio_pct}% (${fmtNum(summary.warm_requests)} warm requests)`,
    `97% gap tokens:           ${fmtNum(summary.target_gap_tokens)}`,
    `cold creation:            ${fmtNum(summary.cold_creation_input_tokens)} tokens across ${fmtNum(summary.cold_creation_requests)} requests`,
    `avg context tokens:       ${fmtNum(summary.avg_context_tokens)}`,
    `marker signature:         ${summary.marker_signature || "(none)"}`,
    `streaming requests:       ${fmtNum(summary.stream_requests)} (${summary.stream_usage_capture_pct}% with usage frame)`,
  ]
  return lines.join("\n")
}

const renderCompact = (label, entries, limit = 8) => {
  const rows = Object.entries(entries).slice(0, limit)
  if (rows.length === 0) return ""
  return [
    `--- ${label} ---`,
    ...rows.map(
      ([name, summary]) =>
        `${name}: requests=${fmtNum(summary.requests)}, hit=${summary.cache_hit_ratio_pct}%, warm=${summary.warm_cache_hit_ratio_pct}%, gap=${fmtNum(summary.target_gap_tokens)}, cold_creation=${fmtNum(summary.cold_creation_input_tokens)}, signature=${summary.marker_signature || "(none)"}`,
    ),
  ].join("\n")
}

const renderTopGap = (entries, limit = 8) => {
  if (entries.length === 0) return ""
  return [
    "--- TOP 97% GAP COHORTS ---",
    ...entries.slice(0, limit).map(
      (summary) =>
        `${summary.key}: requests=${fmtNum(summary.requests)}, hit=${summary.cache_hit_ratio_pct}%, warm=${summary.warm_cache_hit_ratio_pct}%, gap=${fmtNum(summary.target_gap_tokens)}, cold_creation=${fmtNum(summary.cold_creation_input_tokens)}, signature=${summary.marker_signature || "(none)"}`,
    ),
  ].join("\n")
}

console.log(`log:               ${result.log_path}`)
console.log(`window:            since=${result.since}`)
console.log(`records in window: ${result.records_in_window} / ${result.total_records_in_file}`)
console.log()
console.log(renderTable("OVERALL", result.overall))
console.log()
const groupHeader = `BY ${args.by.toUpperCase()}`
for (const [name, summary] of Object.entries(result.groups)) {
  console.log(renderTable(`${groupHeader}: ${name}`, summary))
  console.log()
}
console.log(renderTopGap(result.top_gap_cohorts))
console.log()
console.log(renderCompact("BY MARKER SIGNATURE", result.marker_signatures))
console.log()
console.log(renderCompact("BY TIME WINDOW", result.time_windows))
console.log()
console.log(renderCompact("BY CONTEXT BUCKET", result.context_buckets))
