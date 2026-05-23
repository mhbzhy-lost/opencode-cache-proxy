import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  ensureStreamUsageOption,
  extractFromNonStream,
  extractFromStream,
  extractUsage,
} from "../src/usage-extractor.mjs"

describe("extractUsage non-streaming", () => {
  test("parses usage from a JSON chat completion body", () => {
    const text = JSON.stringify({
      id: "chatcmpl-abc",
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 12,
        prompt_tokens_details: {
          cached_tokens: 1400,
          cache_creation_input_tokens: 0,
        },
      },
    })
    const result = extractUsage({ buffer: Buffer.from(text), isStream: false })
    assert.equal(result.request_id, "chatcmpl-abc")
    assert.equal(result.usage.prompt_tokens, 1500)
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 1400)
    assert.equal(result.stream_usage_seen, null)
  })

  test("returns nulls on truncated/invalid JSON without throwing", () => {
    const result = extractUsage({ buffer: Buffer.from('{"id":"x","usa'), isStream: false })
    assert.equal(result.usage, null)
    assert.equal(result.request_id, null)
  })
})

describe("extractUsage streaming SSE", () => {
  test("picks up usage from the last data frame before [DONE]", () => {
    const sse = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}],"usage":null}',
      "",
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":" there"}}],"usage":null}',
      "",
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":80,"cache_creation_input_tokens":0}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    const result = extractUsage({ buffer: Buffer.from(sse), isStream: true })
    assert.equal(result.request_id, "chatcmpl-1")
    assert.equal(result.usage.prompt_tokens, 100)
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 80)
    assert.equal(result.stream_usage_seen, true)
  })

  test("marks stream_usage_seen=false when no usage frame appears", () => {
    const sse = [
      'data: {"id":"chatcmpl-2","choices":[{"delta":{"content":"hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n")
    const result = extractFromStream(sse)
    assert.equal(result.stream_usage_seen, false)
    assert.equal(result.usage, null)
    assert.equal(result.request_id, "chatcmpl-2")
  })

  test("tolerates partial trailing line without crashing", () => {
    const sse =
      'data: {"id":"chatcmpl-3","choices":[],"usage":{"prompt_tokens":42,"prompt_tokens_details":{"cached_tokens":40}}}\ndata: [DON'
    const result = extractFromStream(sse)
    assert.equal(result.request_id, "chatcmpl-3")
    assert.equal(result.usage.prompt_tokens, 42)
  })

  test("tolerates CRLF line endings", () => {
    const sse =
      'data: {"id":"chatcmpl-4","choices":[],"usage":{"prompt_tokens":7}}\r\n\r\ndata: [DONE]\r\n\r\n'
    const result = extractFromStream(sse)
    assert.equal(result.usage.prompt_tokens, 7)
  })
})

describe("extractFromNonStream direct", () => {
  test("returns nulls on empty input", () => {
    const result = extractFromNonStream("")
    assert.deepEqual(result, { usage: null, request_id: null })
  })
})

describe("ensureStreamUsageOption", () => {
  test("does nothing for non-streaming bodies", () => {
    const body = { model: "qwen3.6-flash", stream: false }
    assert.equal(ensureStreamUsageOption(body), body)
  })

  test("injects include_usage when streaming and option is missing", () => {
    const body = { model: "qwen3.6-flash", stream: true }
    const result = ensureStreamUsageOption(body)
    assert.notEqual(result, body, "should clone")
    assert.equal(result.stream_options.include_usage, true)
  })

  test("respects explicit include_usage:false from caller", () => {
    const body = {
      stream: true,
      stream_options: { include_usage: false },
    }
    const result = ensureStreamUsageOption(body)
    assert.equal(result.stream_options.include_usage, false)
  })

  test("preserves other stream_options keys", () => {
    const body = {
      stream: true,
      stream_options: { something_else: "keep-me" },
    }
    const result = ensureStreamUsageOption(body)
    assert.equal(result.stream_options.something_else, "keep-me")
    assert.equal(result.stream_options.include_usage, true)
  })

  test("handles null/non-object input safely", () => {
    assert.equal(ensureStreamUsageOption(null), null)
    assert.equal(ensureStreamUsageOption("not-an-object"), "not-an-object")
  })
})
