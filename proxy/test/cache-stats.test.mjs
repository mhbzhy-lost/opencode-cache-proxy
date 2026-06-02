import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const scriptPath = new URL("../scripts/cache-stats.mjs", import.meta.url)

const runStats = async (logPath, args = []) => {
  const { stdout } = await execFileAsync(process.execPath, [
    scriptPath.pathname,
    "--log",
    logPath,
    "--since",
    "all",
    "--json",
    ...args,
  ])
  return JSON.parse(stdout)
}

describe("cache-stats CLI", () => {
  test("preserves OpenAI-compatible cache hit ratio from cached prompt tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cache-stats-openai-"))
    const logPath = join(dir, "usage.jsonl")
    try {
      await writeFile(
        logPath,
        JSON.stringify({
          ts: "2026-05-30T00:00:00.000Z",
          model: "qwen3.7-max",
          status: 200,
          duration_ms: 10,
          is_stream: true,
          stream_usage_seen: true,
          prompt_tokens: 1000,
          cached_tokens: 900,
          cache_creation_input_tokens: 0,
          completion_tokens: 8,
        }) + "\n",
      )

      const result = await runStats(logPath)

      assert.equal(result.overall.requests, 1)
      assert.equal(result.overall.prompt_tokens, 1000)
      assert.equal(result.overall.cached_tokens, 900)
      assert.equal(result.overall.cache_hit_ratio_pct, 90)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("computes Anthropic cache hit ratio from cache_read_input_tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cache-stats-anthropic-"))
    const logPath = join(dir, "usage.jsonl")
    try {
      await writeFile(
        logPath,
        [
          JSON.stringify({
            ts: "2026-05-30T00:00:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 100,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
          }),
          JSON.stringify({
            ts: "2026-05-30T00:00:01.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 20,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 900,
            output_tokens: 7,
          }),
        ].join("\n") + "\n",
      )

      const result = await runStats(logPath)

      assert.equal(result.overall.requests, 2)
      assert.equal(result.overall.input_tokens, 200)
      assert.equal(result.overall.cache_read_input_tokens, 900)
      assert.equal(result.overall.cache_creation_input_tokens, 900)
      assert.equal(result.overall.cache_hit_ratio_pct, 45)
      assert.equal(result.groups["claude-opus-4-6"].cache_hit_ratio_pct, 45)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("groups Anthropic records by turn-prev marker cohort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cache-stats-cohort-"))
    const logPath = join(dir, "usage.jsonl")
    try {
      await writeFile(
        logPath,
        [
          JSON.stringify({
            ts: "2026-05-30T00:00:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 999,
            cache_diagnostic: { markers: [] },
          }),
          JSON.stringify({
            ts: "2026-05-30T00:00:01.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 1,
            cache_read_input_tokens: 999,
            cache_creation_input_tokens: 0,
            cache_diagnostic: {
              markers: [{ location: "turn-prev", prefix_hash: "prev-a" }],
            },
          }),
        ].join("\n") + "\n",
      )

      const result = await runStats(logPath, ["--by", "turn-prev"])

      assert.equal(result.by, "turn-prev")
      assert.equal(result.groups["no-turn-prev"].requests, 1)
      assert.equal(result.groups["no-turn-prev"].cache_hit_ratio_pct, 0)
      assert.equal(result.groups["prev-a"].requests, 1)
      assert.equal(result.groups["prev-a"].cache_hit_ratio_pct, 99.9)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("reports weighted ratio for the checked-in Anthropic Opus sample", async () => {
    const fixturePath = new URL(
      "./fixtures/anthropic-opus-cache-sample.jsonl",
      import.meta.url,
    ).pathname
    const result = await runStats(fixturePath)

    assert.equal(result.overall.requests, 3)
    assert.equal(result.overall.cache_read_input_tokens, 354300)
    assert.equal(result.overall.cache_creation_input_tokens, 103336)
    assert.equal(result.overall.input_tokens, 16888)
    assert.equal(result.overall.cache_hit_ratio_pct, 74.66)
  })

  test("reports warm-cache health and cold creation attribution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cache-stats-observability-"))
    const logPath = join(dir, "usage.jsonl")
    try {
      await writeFile(
        logPath,
        [
          JSON.stringify({
            ts: "2026-05-30T00:00:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1000,
            cache_diagnostic: {
              total_estimated_tokens: 120000,
              markers: [
                { location: "system", prefix_hash: "sys-a" },
                { location: "turn-prev", prefix_hash: "prev-a" },
                { location: "turn-current", prefix_hash: "cur-a" },
                { location: "tail", prefix_hash: "tail-a" },
              ],
            },
          }),
          JSON.stringify({
            ts: "2026-05-30T00:01:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 3,
            cache_read_input_tokens: 990,
            cache_creation_input_tokens: 10,
            cache_diagnostic: {
              total_estimated_tokens: 121000,
              markers: [
                { location: "system", prefix_hash: "sys-a" },
                { location: "turn-prev", prefix_hash: "prev-a" },
                { location: "turn-current", prefix_hash: "cur-b" },
                { location: "tail", prefix_hash: "tail-b" },
              ],
            },
          }),
          JSON.stringify({
            ts: "2026-05-30T00:16:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 3,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
            cache_diagnostic: {
              total_estimated_tokens: 260000,
              markers: [
                { location: "system", prefix_hash: "sys-b" },
                { location: "turn-current", prefix_hash: "cur-c" },
                { location: "300k-depth-anchor", prefix_hash: "deep-c" },
                { location: "tail", prefix_hash: "tail-c" },
              ],
            },
          }),
          JSON.stringify({
            ts: "2026-05-30T00:31:00.000Z",
            protocol: "anthropic",
            model: "claude-opus-4-6",
            status: 200,
            duration_ms: 10,
            is_stream: true,
            stream_usage_seen: true,
            input_tokens: 3,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 100,
            cache_diagnostic: {
              total_estimated_tokens: 60000,
              markers: [
                { location: "system", prefix_hash: "sys-c" },
                { location: "fraction", prefix_hash: "frac-c" },
                { location: "turn-prev", prefix_hash: "prev-b" },
                { location: "tail", prefix_hash: "tail-d" },
              ],
            },
          }),
        ].join("\n") + "\n",
      )

      const result = await runStats(logPath)

      assert.equal(result.overall.cache_hit_ratio_pct, 57.04)
      assert.equal(result.overall.warm_cache_hit_ratio_pct, 98.94)
      assert.equal(result.overall.cold_creation_requests, 2)
      assert.equal(result.overall.cold_creation_input_tokens, 1100)
      assert.equal(result.overall.target_gap_tokens, 1073)

      assert.equal(result.top_gap_cohorts[0].key, "prev-a")
      assert.equal(result.top_gap_cohorts[0].target_gap_tokens, 973)
      assert.equal(result.top_gap_cohorts[1].key, "prev-b")
      assert.equal(result.top_gap_cohorts[1].marker_signature, "system>fraction>turn-prev>tail")

      assert.equal(
        result.marker_signatures["system>fraction>turn-prev>tail"].cache_hit_ratio_pct,
        0,
      )
      assert.equal(result.context_buckets["100-200k"].requests, 2)
      assert.equal(result.time_windows["00:00"].requests, 2)
      assert.equal(result.time_windows["00:15"].cache_hit_ratio_pct, 99.4)
      assert.equal(result.time_windows["00:30"].target_gap_tokens, 100)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
