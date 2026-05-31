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
  input_tokens: 0,
  prompt_tokens: 0,
  cache_read_input_tokens: 0,
  cached_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_denominator_tokens: 0,
  output_tokens: 0,
  completion_tokens: 0,
  total_duration_ms: 0,
  stream_count: 0,
  stream_usage_seen: 0,
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
  bucket.count += 1
  if (typeof r.status === "number" && r.status >= 400) bucket.failures += 1
  bucket.input_tokens += usage.input
  bucket.prompt_tokens += usage.input
  bucket.cache_read_input_tokens += usage.read
  bucket.cached_tokens += usage.read
  bucket.cache_creation_input_tokens += usage.created
  bucket.cache_denominator_tokens += usage.cacheDenominator
  bucket.output_tokens += usage.output
  bucket.completion_tokens += usage.output
  bucket.total_duration_ms += Number(r.duration_ms || 0)
  if (r.is_stream) {
    bucket.stream_count += 1
    if (r.stream_usage_seen) bucket.stream_usage_seen += 1
  }
}

const turnPrevKey = (r) =>
  r.cache_diagnostic?.markers?.find((m) => m.location === "turn-prev")?.prefix_hash ||
  "no-turn-prev"

const overall = initBucket()
const groups = new Map()

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
}

const ratio = (numer, denom) =>
  denom > 0 ? Math.round((numer / denom) * 10000) / 100 : 0

const summarize = (b) => ({
  requests: b.count,
  failures: b.failures,
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
  stream_requests: b.stream_count,
  stream_usage_capture_pct: ratio(b.stream_usage_seen, b.stream_count),
})

const result = {
  log_path: logPath,
  since: args.since,
  total_records_in_file: totalLineCount,
  records_in_window: filtered.length,
  by: args.by,
  overall: summarize(overall),
  groups: Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [k, summarize(v)]),
  ),
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
    `streaming requests:       ${fmtNum(summary.stream_requests)} (${summary.stream_usage_capture_pct}% with usage frame)`,
  ]
  return lines.join("\n")
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
