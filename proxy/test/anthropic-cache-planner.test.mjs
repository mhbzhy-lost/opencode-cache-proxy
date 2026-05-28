import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  planAnthropicCacheMarkers,
  countAnthropicCacheMarkers,
  truncateAnthropicBodyForKeepalive,
} from "../src/anthropic-cache-planner.mjs"

const systemBlocks = (text) => [{ type: "text", text }]

const userText = (text) => ({
  role: "user",
  content: [{ type: "text", text }],
})

const assistantText = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const toolResult = (id, content) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
})

const toolUse = (id, name) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
})

const repeat = (word, n) => Array.from({ length: n }, () => word).join(" ")

describe("planAnthropicCacheMarkers", () => {
  test("returns body unchanged when system + messages too short", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks("short"),
      messages: [userText("hi")],
    }
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body)
    assert.equal(diagnostics.marker_count, 0)
    assert.equal(countAnthropicCacheMarkers(planned), 0)
  })

  test("places marker on system and tail for minimal qualifying conversation", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [userText(repeat("hello", 300))],
    }
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    assert.equal(diagnostics.marker_count, 2)
    assert.deepEqual(planned.system[0].cache_control, { type: "ephemeral" })
    const lastMsg = planned.messages.at(-1)
    const lastBlock = lastMsg.content.at(-1)
    assert.deepEqual(lastBlock.cache_control, { type: "ephemeral" })
  })

  test("places 4 markers with turn-stable anchors in multi-turn conversation", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn1-user", 200)),
        assistantText(repeat("turn1-assistant", 200)),
        userText(repeat("turn2-user", 200)),
        assistantText(repeat("turn2-assistant", 200)),
        userText(repeat("turn3-user", 200)),
        assistantText(repeat("turn3-assistant", 200)),
      ],
    }
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    assert.equal(diagnostics.marker_count, 4)
    assert.deepEqual(planned.system[0].cache_control, { type: "ephemeral" })
  })

  test("strips existing cache_control markers before placing new ones", () => {
    const body = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: repeat("system", 300), cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: repeat("user", 300), cache_control: { type: "ephemeral" } }] },
      ],
    }
    const { body: planned } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    assert.equal(countAnthropicCacheMarkers(planned), 2)
  })

  test("tool_result messages are NOT turn anchors", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn1", 200)),
        toolUse("t1", "read_file"),
        toolResult("t1", repeat("result", 200)),
        toolUse("t2", "write_file"),
        toolResult("t2", repeat("result2", 200)),
        userText(repeat("turn2", 200)),
      ],
    }
    const { diagnostics } = planAnthropicCacheMarkers(body)
    const turnMarkers = diagnostics.markers.filter(
      (m) => m.location === "turn-prev" || m.location === "turn-current",
    )
    for (const tm of turnMarkers) {
      assert.equal(tm.role, "user")
    }
  })

  test("respects 20-block lookback: pulls tail back when gap > 18", () => {
    const messages = [userText(repeat("turn1", 300))]
    for (let i = 0; i < 12; i++) {
      messages.push(toolUse(`t${i}`, `tool_${i}`))
      messages.push(toolResult(`t${i}`, repeat(`result${i}`, 50)))
    }
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages,
    }
    const { diagnostics } = planAnthropicCacheMarkers(body)
    if (diagnostics.markers.length >= 2) {
      const sorted = [...diagnostics.markers].sort((a, b) => a.block_index - b.block_index)
      const tailMarker = sorted.at(-1)
      const prevMarker = sorted.at(-2)
      const gap = tailMarker.block_index - prevMarker.block_index
      assert.ok(gap <= 18, `tail gap ${gap} exceeds 18-block lookback limit`)
    }
  })

  test("handles null/undefined body gracefully", () => {
    const { body, diagnostics } = planAnthropicCacheMarkers(null)
    assert.equal(body, null)
    assert.equal(diagnostics, null)
  })

  test("handles body without system field", () => {
    const body = {
      model: "qwen3.7-max",
      messages: [userText(repeat("hello", 600))],
    }
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    assert.ok(diagnostics.marker_count >= 1)
    assert.equal(countAnthropicCacheMarkers(planned), diagnostics.marker_count)
  })
})

describe("truncateAnthropicBodyForKeepalive", () => {
  test("truncates body at marker[2] position", () => {
    const body = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        userText("turn1"),
        assistantText("resp1"),
        userText("turn2"),
        assistantText("resp2"),
        userText("turn3"),
      ],
    }
    const markers = [
      { location: "system", system_index: 0, prefix_hash: "a" },
      { location: "turn-prev", message_index: 0, prefix_hash: "b" },
      { location: "turn-current", message_index: 2, prefix_hash: "c" },
      { location: "tail", message_index: 4, prefix_hash: "d" },
    ]

    const result = truncateAnthropicBodyForKeepalive(body, markers)
    assert.ok(result)
    assert.equal(result.model, "qwen3.7-max")
    assert.equal(result.max_tokens, 1)
    assert.equal(result.stream, false)
    assert.equal(result.messages.length, 3)
    assert.ok(!result.system[0].cache_control)
    assert.ok(!result.messages[0].content[0].cache_control)
  })

  test("returns null when fewer than 3 markers", () => {
    const result = truncateAnthropicBodyForKeepalive({ messages: [] }, [{ message_index: 0 }, { message_index: 1 }])
    assert.equal(result, null)
  })
})
