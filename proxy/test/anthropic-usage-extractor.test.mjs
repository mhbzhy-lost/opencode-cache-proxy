import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  extractAnthropicUsage,
  extractAnthropicStreamUsage,
  extractAnthropicNonStreamUsage,
} from "../src/anthropic-usage-extractor.mjs"

describe("extractAnthropicNonStreamUsage", () => {
  test("extracts usage from a complete JSON response", () => {
    const text = JSON.stringify({
      id: "msg_123",
      type: "message",
      role: "assistant",
      usage: {
        input_tokens: 6,
        output_tokens: 142,
        cache_creation_input_tokens: 45226,
        cache_read_input_tokens: 0,
      },
    })
    const result = extractAnthropicNonStreamUsage(text)
    assert.equal(result.request_id, "msg_123")
    assert.equal(result.usage.input_tokens, 6)
    assert.equal(result.usage.cache_creation_input_tokens, 45226)
    assert.equal(result.usage.output_tokens, 142)
  })

  test("returns nulls on invalid JSON", () => {
    const result = extractAnthropicNonStreamUsage('{"id":"msg_x","usa')
    assert.equal(result.usage, null)
    assert.equal(result.request_id, null)
  })

  test("returns nulls on empty input", () => {
    const result = extractAnthropicNonStreamUsage("")
    assert.equal(result.usage, null)
    assert.equal(result.request_id, null)
  })
})

describe("extractAnthropicStreamUsage", () => {
  test("extracts input usage from message_start and output from message_delta", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_456","usage":{"input_tokens":6,"cache_creation_input_tokens":0,"cache_read_input_tokens":45226}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\": \\"ls\\"}"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":87}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
    ].join("\n")

    const result = extractAnthropicStreamUsage(sse)
    assert.equal(result.request_id, "msg_456")
    assert.equal(result.usage.input_tokens, 6)
    assert.equal(result.usage.cache_read_input_tokens, 45226)
    assert.equal(result.usage.cache_creation_input_tokens, 0)
    assert.equal(result.usage.output_tokens, 87)
    assert.equal(result.stop_reason, "tool_use")
    assert.equal(result.stream_usage_seen, true)
  })

  test("returns empty result on empty stream", () => {
    const result = extractAnthropicStreamUsage("")
    assert.equal(result.usage, null)
    assert.equal(result.stream_usage_seen, false)
  })

  test("handles garbled SSE gracefully", () => {
    const sse = "event: message_start\ndata: not-json\n\nevent: foo\ndata: {}\n"
    const result = extractAnthropicStreamUsage(sse)
    assert.equal(result.usage, null)
    assert.equal(result.stream_usage_seen, false)
  })
})

describe("extractAnthropicUsage", () => {
  test("dispatches to stream extractor when isStream=true", () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_789","usage":{"input_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":5000}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}',
    ].join("\n")
    const result = extractAnthropicUsage({ buffer: Buffer.from(sse), isStream: true })
    assert.equal(result.usage.input_tokens, 10)
    assert.equal(result.usage.output_tokens, 50)
    assert.equal(result.stop_reason, "end_turn")
    assert.equal(result.stream_usage_seen, true)
  })

  test("dispatches to non-stream extractor when isStream=false", () => {
    const json = JSON.stringify({
      id: "msg_abc",
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    const result = extractAnthropicUsage({ buffer: Buffer.from(json), isStream: false })
    assert.equal(result.request_id, "msg_abc")
    assert.equal(result.usage.input_tokens, 100)
    assert.equal(result.stream_usage_seen, null)
  })
})
