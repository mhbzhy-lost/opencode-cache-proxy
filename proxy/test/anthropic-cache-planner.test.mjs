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

const thinking = (text) => ({
  type: "thinking",
  thinking: text,
  signature: "sig-test",
})

const toolUse = (id, name) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
})

const repeat = (word, n) => Array.from({ length: n }, () => word).join(" ")

const collectMarkerLocations = (body) => {
  const locations = []
  if (Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i++) {
      if (body.tools[i]?.cache_control) locations.push(`tools.${i}`)
    }
  }
  if (Array.isArray(body.system)) {
    for (let i = 0; i < body.system.length; i++) {
      if (body.system[i]?.cache_control) locations.push(`system.${i}`)
    }
  }
  if (Array.isArray(body.messages)) {
    for (let mi = 0; mi < body.messages.length; mi++) {
      const content = body.messages[mi]?.content
      if (!Array.isArray(content)) continue
      for (let bi = 0; bi < content.length; bi++) {
        if (content[bi]?.cache_control) locations.push(`messages.${mi}.${bi}`)
      }
    }
  }
  return locations
}

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

  test("does not place multiple cache markers within one message content array", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: repeat("a", 80) },
            { type: "text", text: repeat("b", 80) },
            { type: "text", text: repeat("c", 80) },
            { type: "text", text: repeat("d", 80) },
            { type: "text", text: repeat("e", 80) },
          ],
        },
      ],
    }

    const { body: planned } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const markerIndexes = planned.messages[0].content
      .map((block, index) => block.cache_control ? index : null)
      .filter((index) => index !== null)

    assert.deepEqual(markerIndexes, [4])
  })

  test("does not mark thinking blocks and reports thinking-only tail as uncacheable", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn", 300)),
        { role: "assistant", content: [thinking(repeat("reason", 300))] },
      ],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })

    assert.equal(planned.messages[1].content[0].cache_control, undefined)
    assert.equal(diagnostics.thinking_uncacheable_tail, true)
  })

  test("uses a later legal tool_result marker to cache a prefix containing prior thinking", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn", 300)),
        {
          role: "assistant",
          content: [
            thinking(repeat("reason", 300)),
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
        toolResult("toolu_1", repeat("result", 300)),
      ],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })

    assert.equal(planned.messages[1].content[0].cache_control, undefined)
    assert.deepEqual(planned.messages[2].content[0].cache_control, { type: "ephemeral" })
    assert.equal(diagnostics.markers.at(-1).location, "tail")
    assert.equal(diagnostics.markers.at(-1).role, "user")
  })

  test("keeps one existing legal marker per message when normalizing incoming Claude Code markers", () => {
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: repeat("a", 80), cache_control: { type: "ephemeral" } },
            { type: "text", text: repeat("b", 80) },
            { type: "text", text: repeat("c", 80), cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    }

    const { body: planned } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const markerIndexes = planned.messages[0].content
      .map((block, index) => block.cache_control ? index : null)
      .filter((index) => index !== null)

    assert.deepEqual(markerIndexes, [2])
  })

  test("non-bypass cache strategy names do not change stable cache planning", () => {
    const body = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: repeat("system", 300), cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: repeat("a", 80), cache_control: { type: "ephemeral" } },
            { type: "text", text: repeat("b", 80) },
            { type: "text", text: repeat("c", 80), cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { ...thinking(repeat("reason", 80)), cache_control: { type: "ephemeral" } },
          ],
        },
        toolResult("toolu_1", repeat("result", 80)),
      ],
    }

    const baseline = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })

    for (const cacheStrategy of ["cache", "ignored-debug-value"]) {
      const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, {
        minCacheTokens: 32,
        cacheStrategy,
      })

      assert.equal(diagnostics.strategy, "anthropic-turn-stable")
      assert.deepEqual(planned, baseline.body)
      assert.deepEqual(diagnostics.markers, baseline.diagnostics.markers)
    }
  })

  test("bypass is handled outside the planner and does not alter stable cache planning", () => {
    const body = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: repeat("system", 300), cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: repeat("turn", 300), cache_control: { type: "ephemeral" } }],
        },
      ],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, {
      minCacheTokens: 32,
      cacheStrategy: "bypass",
    })

    assert.equal(diagnostics.strategy, "anthropic-turn-stable")
    assert.deepEqual(planned.system[0].cache_control, { type: "ephemeral" })
    assert.deepEqual(planned.messages[0].content[0].cache_control, { type: "ephemeral" })
    assert.equal(countAnthropicCacheMarkers(planned), 2)
  })

  test("reserves marker budget for existing tool cache markers", () => {
    const body = {
      model: "qwen3.7-max",
      tools: [
        {
          name: "Read",
          description: "Read files",
          input_schema: { type: "object", properties: {} },
          cache_control: { type: "ephemeral" },
        },
      ],
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn1", 200)),
        assistantText(repeat("turn1-assistant", 200)),
        userText(repeat("turn2", 200)),
        assistantText(repeat("turn2-assistant", 200)),
        userText(repeat("turn3", 200)),
      ],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const markerLocations = collectMarkerLocations(planned)

    assert.ok(markerLocations.includes("tools.0"))
    assert.equal(markerLocations.length, 4)
    assert.equal(countAnthropicCacheMarkers(planned), 4)
    assert.equal(diagnostics.marker_count, 3)
  })

  test("caps existing tool cache markers at the max marker budget", () => {
    const body = {
      model: "qwen3.7-max",
      tools: Array.from({ length: 5 }, (_, i) => ({
        name: `Tool${i}`,
        description: `Tool ${i}`,
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      })),
      system: systemBlocks(repeat("system", 300)),
      messages: [userText(repeat("turn", 300))],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const markerLocations = collectMarkerLocations(planned)

    assert.deepEqual(markerLocations, ["tools.0", "tools.1", "tools.2", "tools.3"])
    assert.equal(countAnthropicCacheMarkers(planned), 4)
    assert.equal(diagnostics.marker_count, 0)
  })

  test("converts long string system prompts into cacheable text blocks", () => {
    const body = {
      model: "claude-opus-4-6",
      system: repeat("system", 600),
      messages: [userText(repeat("turn", 300))],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })

    assert.equal(Array.isArray(planned.system), true)
    assert.deepEqual(planned.system[0].cache_control, { type: "ephemeral" })
    assert.equal(planned.system[0].type, "text")
    assert.ok(diagnostics.total_estimated_tokens > 700)
    assert.ok(diagnostics.markers.some((m) => m.location === "system"))
  })

  test("uses first user anchor for first-turn tool-heavy conversations", () => {
    const messages = [userText(repeat("initial-user", 300))]
    for (let i = 0; i < 6; i++) {
      messages.push(toolUse(`t${i}`, `tool_${i}`))
      messages.push(toolResult(`t${i}`, repeat(`result${i}`, 120)))
    }
    const body = {
      model: "claude-opus-4-6",
      system: systemBlocks(repeat("system", 300)),
      messages,
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const labels = diagnostics.markers.map((m) => m.location)

    assert.equal(diagnostics.marker_count, 4)
    assert.equal(countAnthropicCacheMarkers(planned), 4)
    assert.ok(labels.includes("system"))
    assert.ok(labels.includes("turn-current"))
    assert.ok(labels.includes("early-stable"))
    assert.ok(labels.includes("tail"))
    assert.equal(labels.includes("fraction"), false)
  })

  test("uses previous and current user anchors before falling back in two-turn conversations", () => {
    const body = {
      model: "claude-opus-4-6",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn1-user", 300)),
        assistantText(repeat("turn1-assistant", 300)),
        userText(repeat("turn2-user", 300)),
        toolUse("t1", "read"),
        toolResult("t1", repeat("result", 300)),
      ],
    }

    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })
    const labels = diagnostics.markers.map((m) => m.location)
    const messageMarkerCounts = planned.messages.map((msg) =>
      msg.content.filter((block) => block.cache_control).length
    )

    assert.equal(diagnostics.marker_count, 4)
    assert.ok(messageMarkerCounts.every((count) => count <= 1))
    assert.ok(labels.includes("turn-prev"))
    assert.ok(labels.includes("turn-current"))
    assert.ok(labels.includes("tail"))
  })

  test("emits OpenAI-compatible diagnostic hashes for marker drift analysis", () => {
    const body = {
      model: "claude-opus-4-6",
      system: systemBlocks(repeat("system", 300)),
      messages: [
        userText(repeat("turn1-user", 300)),
        assistantText(repeat("turn1-assistant", 300)),
        userText(repeat("turn2-user", 300)),
      ],
    }

    const { diagnostics } = planAnthropicCacheMarkers(body, { minCacheTokens: 32 })

    assert.equal(diagnostics.version, 1)
    assert.equal(diagnostics.message_count, 3)
    assert.equal(diagnostics.content_block_count, 4)
    assert.match(diagnostics.messages_hash, /^[a-f0-9]{16}$/)
    assert.match(diagnostics.marker_selection_hash, /^[a-f0-9]{16}$/)
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
