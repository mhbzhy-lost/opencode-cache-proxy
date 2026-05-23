import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import {
  buildUsageRecord,
  computeCacheHitRatio,
  createUsageRecorder,
  defaultUsageLogPath,
} from "../src/usage-recorder.mjs"

describe("buildUsageRecord", () => {
  test("normalizes OpenAI-style usage and computes hit ratio", () => {
    const record = buildUsageRecord({
      ts: "2026-05-23T11:00:00.000Z",
      model: "qwen3.6-flash",
      status: 200,
      duration_ms: 481,
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 1450,
          cache_creation_input_tokens: 0,
        },
      },
      request_id: "chatcmpl-abc",
      is_stream: true,
      stream_usage_seen: true,
      proxy_pid: 4242,
    })

    assert.equal(record.proxy_pid, 4242)
    assert.equal(record.opencode_pid, null)
    assert.equal(record.prompt_tokens, 1500)
    assert.equal(record.cached_tokens, 1450)
    assert.equal(record.cache_creation_input_tokens, 0)
    assert.equal(record.cache_hit_ratio, 0.9667)
    assert.equal(record.is_stream, true)
    assert.equal(record.stream_usage_seen, true)
  })

  test("sets stream_usage_seen=null for non-streaming records", () => {
    const record = buildUsageRecord({
      ts: "2026-05-23T11:00:00.000Z",
      status: 200,
      duration_ms: 100,
      usage: { prompt_tokens: 10, completion_tokens: 1 },
      is_stream: false,
    })
    assert.equal(record.is_stream, false)
    assert.equal(record.stream_usage_seen, null)
    assert.equal(record.cache_hit_ratio, 0)
  })

  test("handles null usage gracefully", () => {
    const record = buildUsageRecord({
      ts: "2026-05-23T11:00:00.000Z",
      status: 502,
      duration_ms: 23,
      usage: null,
      is_stream: false,
    })
    assert.equal(record.prompt_tokens, null)
    assert.equal(record.cached_tokens, null)
    assert.equal(record.cache_hit_ratio, 0)
    assert.equal(record.status, 502)
    assert.equal(record.proxy_error, null)
  })

  test("preserves proxy_error when provided", () => {
    const record = buildUsageRecord({
      ts: "2026-05-23T11:00:00.000Z",
      status: 502,
      duration_ms: 50,
      usage: null,
      is_stream: false,
      proxy_error: "fetch failed: ECONNREFUSED",
    })
    assert.equal(record.proxy_error, "fetch failed: ECONNREFUSED")
  })
})

describe("computeCacheHitRatio", () => {
  test("returns 0 when prompt_tokens is missing or zero", () => {
    assert.equal(computeCacheHitRatio({}), 0)
    assert.equal(computeCacheHitRatio({ prompt_tokens: 0 }), 0)
    assert.equal(computeCacheHitRatio({ prompt_tokens: 100 }), 0)
  })

  test("rounds to 4 decimals", () => {
    assert.equal(computeCacheHitRatio({ prompt_tokens: 3, cached_tokens: 1 }), 0.3333)
  })
})

describe("defaultUsageLogPath", () => {
  test("respects BAILIAN_CACHE_PROXY_USAGE_LOG override", () => {
    const original = process.env.BAILIAN_CACHE_PROXY_USAGE_LOG
    process.env.BAILIAN_CACHE_PROXY_USAGE_LOG = "/tmp/explicit-usage.jsonl"
    try {
      assert.equal(defaultUsageLogPath(), "/tmp/explicit-usage.jsonl")
    } finally {
      if (original === undefined) delete process.env.BAILIAN_CACHE_PROXY_USAGE_LOG
      else process.env.BAILIAN_CACHE_PROXY_USAGE_LOG = original
    }
  })

  test("resolves a relative BAILIAN_CACHE_PROXY_USAGE_LOG to absolute", () => {
    const original = process.env.BAILIAN_CACHE_PROXY_USAGE_LOG
    process.env.BAILIAN_CACHE_PROXY_USAGE_LOG = "relative/usage.jsonl"
    try {
      const resolved = defaultUsageLogPath()
      assert.equal(resolved.startsWith("/"), true, `expected absolute, got ${resolved}`)
      assert.equal(resolved.endsWith("/relative/usage.jsonl"), true)
    } finally {
      if (original === undefined) delete process.env.BAILIAN_CACHE_PROXY_USAGE_LOG
      else process.env.BAILIAN_CACHE_PROXY_USAGE_LOG = original
    }
  })
})

describe("createUsageRecorder.record", () => {
  test("appends one JSONL line per record and creates parent dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bailian-usage-test-"))
    const filePath = join(dir, "subdir", "usage.jsonl")
    const recorder = createUsageRecorder({ filePath })
    try {
      await recorder.record({ ts: "t1", marker: "first" })
      await recorder.record({ ts: "t2", marker: "second" })
      const text = await readFile(filePath, "utf8")
      const lines = text.trim().split("\n")
      assert.equal(lines.length, 2)
      assert.deepEqual(JSON.parse(lines[0]), { ts: "t1", marker: "first" })
      assert.deepEqual(JSON.parse(lines[1]), { ts: "t2", marker: "second" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("survives concurrent writers without producing partial JSON lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bailian-usage-concurrency-"))
    const filePath = join(dir, "usage.jsonl")
    const recorder = createUsageRecorder({ filePath })
    try {
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          recorder.record({ idx: i, payload: "x".repeat(100) }),
        ),
      )
      const text = await readFile(filePath, "utf8")
      const lines = text.trim().split("\n")
      assert.equal(lines.length, 50)
      const ids = new Set()
      for (const line of lines) {
        const obj = JSON.parse(line)
        assert.equal(obj.payload, "x".repeat(100))
        ids.add(obj.idx)
      }
      assert.equal(ids.size, 50)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("skips records that exceed PIPE_BUF safety margin", async () => {
    const warnings = []
    const appended = []
    const recorder = createUsageRecorder({
      filePath: "/tmp/limit-test.jsonl",
      mkdirImpl: async () => {},
      appendImpl: async (_, line) => {
        appended.push(line)
      },
      logger: { warn: (msg) => warnings.push(msg) },
    })
    // 4500-byte JSON value: well over the 3500-byte cap.
    await recorder.record({
      ts: "t",
      bloated: "x".repeat(4500),
    })
    assert.equal(appended.length, 0, "oversized record should not be written")
    assert.match(warnings[0], /exceeds 3500 bytes/)
  })

  test("warns but does not throw when append fails", async () => {
    const warnings = []
    const recorder = createUsageRecorder({
      filePath: "/tmp/will-fail/usage.jsonl",
      mkdirImpl: async () => {},
      appendImpl: async () => {
        throw new Error("disk full")
      },
      logger: { warn: (msg) => warnings.push(msg) },
    })
    await recorder.record({ ts: "t1" })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /usage record failed/)
    assert.match(warnings[0], /disk full/)
  })

  test("fireAndForget never throws even when underlying record rejects", async () => {
    const recorder = createUsageRecorder({
      filePath: "/tmp/x.jsonl",
      mkdirImpl: async () => {
        throw new Error("nope")
      },
      logger: { warn: () => {} },
    })
    assert.doesNotThrow(() => recorder.fireAndForget({ ts: "t1" }))
    // Wait for the microtask to settle so any rejection would surface.
    await new Promise((resolve) => setImmediate(resolve))
  })
})
