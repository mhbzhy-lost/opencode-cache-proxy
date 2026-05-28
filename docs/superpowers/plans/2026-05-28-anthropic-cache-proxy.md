# Anthropic Cache Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Anthropic Messages API cache-marking pipeline to the existing proxy, so Claude Code + 百炼 Qwen thinking-prefill requests get explicit `cache_control` markers and stop wasting ~9.8M tokens/day.

**Architecture:** Same process/port, new independent modules for Anthropic message format. Route dispatch in server.mjs sends `/apps/anthropic/v1/messages` to the new pipeline. Shared infrastructure: lifecycle tracker, usage recorder, keepalive manager.

**Tech Stack:** Node.js ESM (`node:test`, `node:assert/strict`), no build step, no dependencies beyond Node stdlib + `fetch`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `proxy/src/anthropic-cache-planner.mjs` | Create | Marker placement for Anthropic message format |
| `proxy/src/anthropic-usage-extractor.mjs` | Create | Usage extraction from Anthropic SSE/JSON responses |
| `proxy/src/anthropic-handler.mjs` | Create | Full request pipeline (parse → plan → forward → stream → record) |
| `proxy/src/server.mjs` | Modify | Add route dispatch for `/apps/anthropic/*` paths |
| `proxy/bin/bailian-cache-proxy.mjs` | Modify | Add Anthropic env var parsing, pass to server factory |
| `proxy/test/anthropic-cache-planner.test.mjs` | Create | Unit tests for marker placement |
| `proxy/test/anthropic-usage-extractor.test.mjs` | Create | Unit tests for SSE/JSON usage extraction |
| `proxy/test/anthropic-handler.test.mjs` | Create | Integration test with mock upstream |

---

## Task 1: Anthropic Cache Planner — Core Logic

**Files:**
- Create: `proxy/src/anthropic-cache-planner.mjs`
- Create: `proxy/test/anthropic-cache-planner.test.mjs`

### Background for Implementer

The Anthropic Messages API format:
- `system`: top-level array of content blocks (NOT inside messages)
- `messages`: array of `{role, content}` where content is always an array of blocks
- Each block: `{type: "text", text: "..."}` or `{type: "tool_use", ...}` or `{type: "tool_result", ...}` or `{type: "thinking", thinking: "..."}`
- `cache_control: {type: "ephemeral"}` goes on any content block or system block

Turn anchor rule: `role=user` with at least one `type=text` block = turn boundary.
`role=user` with only `type=tool_result` blocks = NOT a boundary (mid-turn tool chain).

Marker placement: max 4 markers, min 1024 estimated tokens before placing.
- Slot 0: last system block
- Slot 1: previous user turn's first text block
- Slot 2: current user turn's first text block
- Slot 3: last markable block in messages
- Fallback: if <2 turn anchors, use token fraction (0.5, 0.85) for missing slots
- 20-block lookback guard: if slot 3 is >18 blocks from slot 2, pull slot 3 back

- [ ] **Step 1: Write failing tests for basic marker placement**

```js
// proxy/test/anthropic-cache-planner.test.mjs
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  planAnthropicCacheMarkers,
  countAnthropicCacheMarkers,
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
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body)
    assert.equal(diagnostics.marker_count, 2)
    // system block has marker
    assert.deepEqual(planned.system[0].cache_control, { type: "ephemeral" })
    // last message content block has marker
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
    const { body: planned, diagnostics } = planAnthropicCacheMarkers(body)
    assert.equal(diagnostics.marker_count, 4)
    // system marker
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
    const { body: planned } = planAnthropicCacheMarkers(body)
    // should have exactly 2 markers (re-placed by planner), not the originals
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
    // turn anchors: turn1 (messages[0]) and turn2 (messages[5])
    // NOT tool_result messages[2] or messages[4]
    const turnMarkers = diagnostics.markers.filter(
      (m) => m.location !== "system" && m.location !== "tail",
    )
    for (const tm of turnMarkers) {
      assert.notEqual(tm.role, "user-tool-result")
    }
  })

  test("respects 20-block lookback: pulls tail back when gap > 18", () => {
    // Create a conversation with many tool_use/tool_result pairs between
    // the current user turn and the tail
    const messages = [userText(repeat("turn1", 300))]
    // 10 tool call cycles = 20 messages between turn anchor and tail
    for (let i = 0; i < 10; i++) {
      messages.push(toolUse(`t${i}`, `tool_${i}`))
      messages.push(toolResult(`t${i}`, repeat(`result${i}`, 50)))
    }
    const body = {
      model: "qwen3.7-max",
      system: systemBlocks(repeat("system", 300)),
      messages,
    }
    const { diagnostics } = planAnthropicCacheMarkers(body)
    // The tail marker should NOT be on the very last block if gap > 18
    const tailMarker = diagnostics.markers.at(-1)
    const turnMarker = diagnostics.markers.find((m) => m.location === "turn-current" || m.location === "turn-prev")
    if (turnMarker) {
      const gap = tailMarker.block_index - turnMarker.block_index
      assert.ok(gap <= 18, `tail gap ${gap} exceeds 18-block lookback limit`)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-cache-planner.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement anthropic-cache-planner.mjs**

```js
// proxy/src/anthropic-cache-planner.mjs
import { createHash } from "node:crypto"

const DEFAULT_MIN_CACHE_TOKENS = 1024
const DEFAULT_MAX_MARKERS = 4
const DEFAULT_MARKER_FRACTIONS = Object.freeze([0.5, 0.85])
const MAX_LOOKBACK_GAP = 18

const marker = Object.freeze({ type: "ephemeral" })

const shortHash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16)

const estimateTokens = (value) => {
  if (typeof value === "string") return Math.ceil(value.length / 4)
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return estimateTokens(value.text)
    if (typeof value.thinking === "string") return estimateTokens(value.thinking)
    return Math.ceil(JSON.stringify(value).length / 4)
  }
  return 0
}

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(",")}}`
}

const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

const stripCacheControl = (block) => {
  if (!block || typeof block !== "object") return block
  const cloned = { ...block }
  delete cloned.cache_control
  return cloned
}

const canMarkBlock = (block) => {
  if (!block || typeof block !== "object") return false
  const t = block.type
  return t === "text" || t === "thinking" || !t
}

const isTurnAnchor = (message) => {
  if (message.role !== "user") return false
  if (!Array.isArray(message.content)) return false
  return message.content.some(
    (b) => b && typeof b === "object" && b.type === "text",
  )
}

export const countAnthropicCacheMarkers = (body) => {
  let count = 0
  if (Array.isArray(body?.system)) {
    for (const block of body.system) {
      if (block?.cache_control) count += 1
    }
  }
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg?.content)) continue
      for (const block of msg.content) {
        if (block?.cache_control) count += 1
      }
    }
  }
  return count
}

export const planAnthropicCacheMarkers = (body, options = {}) => {
  const {
    minCacheTokens = DEFAULT_MIN_CACHE_TOKENS,
    maxMarkers = DEFAULT_MAX_MARKERS,
    markerFractions = DEFAULT_MARKER_FRACTIONS,
  } = options

  if (!body || typeof body !== "object") return { body, diagnostics: null }

  const planned = cloneJson(body)

  // Strip existing markers
  if (Array.isArray(planned.system)) {
    planned.system = planned.system.map(stripCacheControl)
  }
  if (Array.isArray(planned.messages)) {
    planned.messages = planned.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg
      return { ...msg, content: msg.content.map(stripCacheControl) }
    })
  }

  // Build block index (system blocks + message blocks in sequence)
  const blocks = []
  let prefixTokens = 0
  const prefixParts = []

  if (Array.isArray(planned.system)) {
    for (let i = 0; i < planned.system.length; i++) {
      const block = planned.system[i]
      prefixTokens += estimateTokens(block)
      prefixParts.push(stableStringify({ location: "system", content: block }))
      blocks.push({
        location: "system",
        systemIndex: i,
        messageIndex: null,
        blockIndex: null,
        prefixTokens,
        prefixHash: shortHash(prefixParts.join("\n")),
        canMark: canMarkBlock(block),
        role: "system",
        isTurnAnchor: false,
        globalIndex: blocks.length,
      })
    }
  }

  if (Array.isArray(planned.messages)) {
    for (let mi = 0; mi < planned.messages.length; mi++) {
      const msg = planned.messages[mi]
      const msgIsTurnAnchor = isTurnAnchor(msg)
      const content = Array.isArray(msg.content) ? msg.content : []
      for (let bi = 0; bi < content.length; bi++) {
        const block = content[bi]
        prefixTokens += estimateTokens(block)
        prefixParts.push(
          stableStringify({ role: msg.role, content: block }),
        )
        blocks.push({
          location: "message",
          systemIndex: null,
          messageIndex: mi,
          blockIndex: bi,
          prefixTokens,
          prefixHash: shortHash(prefixParts.join("\n")),
          canMark: canMarkBlock(block),
          role: msg.role,
          isTurnAnchor: msgIsTurnAnchor && bi === 0,
          globalIndex: blocks.length,
        })
      }
    }
  }

  // Select marker positions
  const eligible = blocks.filter(
    (b) => b.canMark && b.prefixTokens >= minCacheTokens,
  )
  if (eligible.length === 0 || maxMarkers <= 0) {
    return {
      body: planned,
      diagnostics: {
        marker_count: 0,
        total_estimated_tokens: prefixTokens,
        strategy: "anthropic-turn-stable",
        markers: [],
      },
    }
  }

  const selected = new Map() // globalIndex → location label

  // Slot 0: last system block
  const lastSystem = [...eligible].reverse().find((b) => b.location === "system")
  if (lastSystem) selected.set(lastSystem.globalIndex, "system")

  // Slot 3: tail (last eligible block)
  const tail = eligible.at(-1)
  selected.set(tail.globalIndex, "tail")

  // Find turn anchors (from tail backward)
  const turnAnchors = []
  for (let i = eligible.length - 1; i >= 0 && turnAnchors.length < 2; i--) {
    const b = eligible[i]
    if (b.isTurnAnchor && b.globalIndex !== tail.globalIndex) {
      turnAnchors.unshift(b)
    }
  }

  // Slot 1 & 2: turn anchors
  if (turnAnchors.length >= 2) {
    selected.set(turnAnchors[0].globalIndex, "turn-prev")
    selected.set(turnAnchors[1].globalIndex, "turn-current")
  } else if (turnAnchors.length === 1) {
    selected.set(turnAnchors[0].globalIndex, "turn-current")
  }

  // Fallback: fill remaining with fraction-based if < maxMarkers
  if (selected.size < maxMarkers) {
    const stableEnd = lastSystem ? lastSystem.prefixTokens : 0
    const totalTokens = tail.prefixTokens
    const conversationTokens = totalTokens - stableEnd
    if (conversationTokens > 0) {
      for (const fraction of markerFractions) {
        if (selected.size >= maxMarkers) break
        const targetTokens = stableEnd + conversationTokens * fraction
        const block = eligible.findLast(
          (b) =>
            b.prefixTokens <= targetTokens &&
            b.globalIndex !== tail.globalIndex &&
            !selected.has(b.globalIndex),
        )
        if (block) selected.set(block.globalIndex, "fraction")
      }
    }
  }

  // 20-block lookback guard: find the highest non-tail marker and ensure
  // tail is within 18 blocks of it
  const sortedIndexes = [...selected.keys()].sort((a, b) => a - b)
  if (sortedIndexes.length >= 2) {
    const tailIdx = sortedIndexes.at(-1)
    const prevIdx = sortedIndexes.at(-2)
    if (tailIdx - prevIdx > MAX_LOOKBACK_GAP) {
      // Move tail back
      selected.delete(tailIdx)
      const cappedIdx = prevIdx + MAX_LOOKBACK_GAP
      const replacement = eligible.findLast(
        (b) => b.globalIndex <= cappedIdx && !selected.has(b.globalIndex),
      )
      if (replacement) {
        selected.set(replacement.globalIndex, "tail")
      }
    }
  }

  // Keep only last maxMarkers (sorted by position)
  const finalIndexes = [...selected.keys()]
    .sort((a, b) => a - b)
    .slice(-maxMarkers)
  const finalSet = new Set(finalIndexes)

  // Apply markers
  for (const block of blocks) {
    if (!finalSet.has(block.globalIndex)) continue
    if (block.location === "system") {
      planned.system[block.systemIndex] = {
        ...planned.system[block.systemIndex],
        cache_control: { ...marker },
      }
    } else {
      const msg = planned.messages[block.messageIndex]
      msg.content[block.blockIndex] = {
        ...msg.content[block.blockIndex],
        cache_control: { ...marker },
      }
    }
  }

  // Build diagnostics
  const markers = blocks
    .filter((b) => finalSet.has(b.globalIndex))
    .map((b) => ({
      location: selected.get(b.globalIndex) || b.location,
      role: b.role,
      global_index: b.globalIndex,
      block_index: b.globalIndex,
      prefix_tokens: b.prefixTokens,
      prefix_hash: b.prefixHash,
      ...(b.location === "system"
        ? { system_index: b.systemIndex }
        : { message_index: b.messageIndex, content_index: b.blockIndex }),
    }))

  return {
    body: planned,
    diagnostics: {
      marker_count: markers.length,
      total_estimated_tokens: prefixTokens,
      strategy: "anthropic-turn-stable",
      markers,
    },
  }
}

export const truncateAnthropicBodyForKeepalive = (body, markers) => {
  if (!body || !Array.isArray(body?.messages)) return null
  if (!Array.isArray(markers) || markers.length < 3) return null

  const cutMarker = markers[2]
  if (cutMarker.message_index == null) return null

  const truncatedMessages = body.messages
    .slice(0, cutMarker.message_index + 1)
    .map((msg) => {
      if (!Array.isArray(msg.content)) return msg
      return {
        ...msg,
        content: msg.content.map(stripCacheControl),
      }
    })

  const system = Array.isArray(body.system)
    ? body.system.map(stripCacheControl)
    : body.system

  return {
    model: body.model,
    system,
    messages: truncatedMessages,
    max_tokens: 1,
    stream: false,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-cache-planner.test.mjs`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add proxy/src/anthropic-cache-planner.mjs proxy/test/anthropic-cache-planner.test.mjs
git commit -m "feat(anthropic): add independent cache planner for Anthropic Messages format"
```

---

## Task 2: Anthropic Usage Extractor

**Files:**
- Create: `proxy/src/anthropic-usage-extractor.mjs`
- Create: `proxy/test/anthropic-usage-extractor.test.mjs`

### Background for Implementer

Anthropic streaming uses Server-Sent Events with `event:` + `data:` lines (different from OpenAI which only uses `data:` lines). Key events:
- `event: message_start` → `data: {"type":"message_start","message":{"usage":{input_tokens, cache_creation_input_tokens, cache_read_input_tokens}}}`
- `event: message_delta` → `data: {"type":"message_delta","delta":{"stop_reason":"..."},"usage":{"output_tokens":N}}`

For non-streaming: usage is at top level of response JSON `response.usage`.

Important: In Anthropic format, `input_tokens` does NOT include cached tokens. Total prompt = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

- [ ] **Step 1: Write failing tests**

```js
// proxy/test/anthropic-usage-extractor.test.mjs
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

  test("returns empty result on empty/garbled stream", () => {
    const result = extractAnthropicStreamUsage("")
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
  })

  test("dispatches to non-stream extractor when isStream=false", () => {
    const json = JSON.stringify({
      id: "msg_abc",
      usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    const result = extractAnthropicUsage({ buffer: Buffer.from(json), isStream: false })
    assert.equal(result.request_id, "msg_abc")
    assert.equal(result.usage.input_tokens, 100)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-usage-extractor.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement anthropic-usage-extractor.mjs**

```js
// proxy/src/anthropic-usage-extractor.mjs

export const extractAnthropicNonStreamUsage = (text) => {
  if (!text) return { usage: null, request_id: null }
  try {
    const obj = JSON.parse(text)
    return {
      usage: obj?.usage ?? null,
      request_id: obj?.id ?? null,
    }
  } catch {
    return { usage: null, request_id: null }
  }
}

export const extractAnthropicStreamUsage = (text) => {
  if (!text) return { usage: null, request_id: null, stop_reason: null, stream_usage_seen: false }

  let inputUsage = null
  let outputUsage = null
  let requestId = null
  let stopReason = null

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed.startsWith("data:")) continue
    const payload = trimmed.slice(5).trim()
    if (!payload) continue

    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }

    if (obj.type === "message_start" && obj.message) {
      requestId = obj.message.id ?? null
      if (obj.message.usage) inputUsage = obj.message.usage
    }

    if (obj.type === "message_delta") {
      if (obj.usage) outputUsage = obj.usage
      if (obj.delta?.stop_reason) stopReason = obj.delta.stop_reason
    }
  }

  if (!inputUsage && !outputUsage) {
    return { usage: null, request_id: requestId, stop_reason: stopReason, stream_usage_seen: false }
  }

  const usage = {
    input_tokens: inputUsage?.input_tokens ?? null,
    output_tokens: outputUsage?.output_tokens ?? null,
    cache_creation_input_tokens: inputUsage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: inputUsage?.cache_read_input_tokens ?? null,
  }

  return { usage, request_id: requestId, stop_reason: stopReason, stream_usage_seen: true }
}

export const extractAnthropicUsage = ({ buffer, isStream }) => {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "")
  if (isStream) return extractAnthropicStreamUsage(text)
  const result = extractAnthropicNonStreamUsage(text)
  return { ...result, stop_reason: null, stream_usage_seen: null }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-usage-extractor.test.mjs`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add proxy/src/anthropic-usage-extractor.mjs proxy/test/anthropic-usage-extractor.test.mjs
git commit -m "feat(anthropic): add usage extractor for Anthropic SSE/JSON responses"
```

---

## Task 3: Anthropic Handler + Server Routing

**Files:**
- Create: `proxy/src/anthropic-handler.mjs`
- Create: `proxy/test/anthropic-handler.test.mjs`
- Modify: `proxy/src/server.mjs` (add route dispatch)
- Modify: `proxy/bin/bailian-cache-proxy.mjs` (add Anthropic env vars)

### Background for Implementer

The handler receives an HTTP request, reads the JSON body, runs it through the cache planner, forwards to upstream, streams the response back, extracts usage, and writes a record.

Key differences from the OpenAI handler:
- Upstream URL: `https://dashscope.aliyuncs.com/apps/anthropic/v1/messages`
- Auth header: `x-api-key` (not `Authorization: Bearer`)
- Response streaming: Anthropic SSE format (different event types)
- Usage record: different field paths, `protocol: "anthropic"` field
- Body validation: must have `messages` array (system is optional)

The server.mjs modification is minimal: add a path check at the top of the request handler that delegates to the anthropic handler when the path starts with `/apps/anthropic/`.

- [ ] **Step 1: Write failing integration test**

```js
// proxy/test/anthropic-handler.test.mjs
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, test, afterEach } from "node:test"

import { createAnthropicHandler } from "../src/anthropic-handler.mjs"
import { NOOP_USAGE_RECORDER } from "../src/server.mjs"

const repeat = (word, n) => Array.from({ length: n }, () => word).join(" ")

const startMockUpstream = (responseBody, statusCode = 200, responseHeaders = {}) => {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        server._lastRequest = { body: JSON.parse(body), headers: req.headers, url: req.url }
        res.writeHead(statusCode, { "content-type": "application/json", ...responseHeaders })
        res.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({ server, port, url: `http://127.0.0.1:${port}` })
    })
  })
}

const makeRequest = async (proxyPort, body) => {
  const response = await fetch(`http://127.0.0.1:${proxyPort}/apps/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test-key-123",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { response, text }
}

describe("anthropic-handler integration", () => {
  let servers = []
  afterEach(() => {
    for (const s of servers) s.close()
    servers = []
  })

  test("forwards request with markers added, returns upstream response", async () => {
    const upstreamResponse = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_creation_input_tokens: 1200,
        cache_read_input_tokens: 0,
      },
    }
    const { server: upstream, port: upstreamPort } = await startMockUpstream(upstreamResponse)
    servers.push(upstream)

    const records = []
    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "fallback-key",
      usageRecorder: { fireAndForget: (r) => records.push(r) },
      cacheOptions: { minCacheTokens: 32 },
    })

    const proxyServer = createServer(handler)
    await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r))
    servers.push(proxyServer)
    const proxyPort = proxyServer.address().port

    const requestBody = {
      model: "qwen3.7-max",
      system: [{ type: "text", text: repeat("system-prompt", 100) }],
      messages: [{ role: "user", content: [{ type: "text", text: repeat("user-msg", 100) }] }],
      max_tokens: 4096,
      stream: false,
    }
    const { response, text } = await makeRequest(proxyPort, requestBody)
    const parsed = JSON.parse(text)

    assert.equal(response.status, 200)
    assert.equal(parsed.id, "msg_test")

    // Verify markers were added to the upstream request
    const upstreamBody = upstream._lastRequest.body
    const systemHasMarker = upstreamBody.system?.some((b) => b.cache_control)
    assert.ok(systemHasMarker, "system block should have cache_control marker")

    // Verify x-api-key was forwarded
    assert.equal(upstream._lastRequest.headers["x-api-key"], "test-key-123")

    // Verify usage was recorded
    assert.equal(records.length, 1)
    assert.equal(records[0].protocol, "anthropic")
    assert.equal(records[0].model, "qwen3.7-max")
    assert.equal(records[0].cache_creation_input_tokens, 1200)
  })

  test("uses fallback apiKey when x-api-key not in request", async () => {
    const { server: upstream, port: upstreamPort } = await startMockUpstream({
      id: "msg_2",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
    servers.push(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      apiKey: "my-fallback-key",
      usageRecorder: NOOP_USAGE_RECORDER,
      cacheOptions: { minCacheTokens: 32 },
    })

    const proxyServer = createServer(handler)
    await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r))
    servers.push(proxyServer)
    const proxyPort = proxyServer.address().port

    await fetch(`http://127.0.0.1:${proxyPort}/apps/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "qwen3.7-max",
        system: [{ type: "text", text: repeat("s", 200) }],
        messages: [{ role: "user", content: [{ type: "text", text: repeat("u", 200) }] }],
        max_tokens: 100,
      }),
    })

    assert.equal(upstream._lastRequest.headers["x-api-key"], "my-fallback-key")
  })

  test("returns 404 for non-messages paths", async () => {
    const handler = createAnthropicHandler({
      upstreamBaseUrl: "http://127.0.0.1:1",
      usageRecorder: NOOP_USAGE_RECORDER,
    })
    const proxyServer = createServer(handler)
    await new Promise((r) => proxyServer.listen(0, "127.0.0.1", r))
    servers.push(proxyServer)
    const proxyPort = proxyServer.address().port

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/apps/anthropic/v1/models`)
    assert.equal(resp.status, 404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-handler.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement anthropic-handler.mjs**

```js
// proxy/src/anthropic-handler.mjs
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { planAnthropicCacheMarkers, truncateAnthropicBodyForKeepalive } from "./anthropic-cache-planner.mjs"
import { extractAnthropicUsage } from "./anthropic-usage-extractor.mjs"

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
const DEFAULT_USAGE_SNIFF_BYTES = 64 * 1024

const HOP_BY_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
])
const RESPONSE_STRIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS, "content-encoding", "content-length",
])

const readBody = async (request, maxBytes) => {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      const err = new Error(`request body exceeds ${maxBytes} bytes`)
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const writeJson = (response, statusCode, body) => {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const writeProxyError = (response, statusCode, body) => {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  writeJson(response, statusCode, body)
}

const responseHeadersToObject = (headers) => {
  const result = {}
  for (const [key, value] of headers.entries()) {
    if (RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) continue
    result[key] = value
  }
  return result
}

const forwardHeaders = (request, bodyLength, fallbackApiKey) => {
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === "host" || lowerKey === "content-length") continue
    if (lowerKey === "content-encoding") continue
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue
    headers[key] = value
  }
  headers["content-length"] = String(bodyLength)
  if (!headers["x-api-key"] && fallbackApiKey) {
    headers["x-api-key"] = fallbackApiKey
  }
  return headers
}

const buildAnthropicUsageRecord = ({
  ts, model, status, duration_ms, usage, request_id,
  is_stream, stream_usage_seen, proxy_error, cache_diagnostic,
}) => {
  const input_tokens = usage?.input_tokens ?? null
  const output_tokens = usage?.output_tokens ?? null
  const cache_creation_input_tokens = usage?.cache_creation_input_tokens ?? null
  const cache_read_input_tokens = usage?.cache_read_input_tokens ?? null

  const total = (input_tokens || 0) + (cache_read_input_tokens || 0) + (cache_creation_input_tokens || 0)
  const cache_hit_ratio = total > 0
    ? Math.round(((cache_read_input_tokens || 0) / total) * 10000) / 10000
    : 0

  return {
    ts,
    protocol: "anthropic",
    proxy_pid: process.pid,
    model: model ?? null,
    status,
    duration_ms,
    is_stream: Boolean(is_stream),
    stream_usage_seen: is_stream ? Boolean(stream_usage_seen) : null,
    input_tokens,
    output_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    request_id: request_id ?? null,
    proxy_error: proxy_error ?? null,
    cache_hit_ratio,
    cache_diagnostic: cache_diagnostic ?? null,
  }
}

export const createAnthropicHandler = ({
  upstreamBaseUrl,
  apiKey = "",
  cacheOptions = {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  usageSniffBytes = DEFAULT_USAGE_SNIFF_BYTES,
  usageRecorder,
  keepaliveManager = null,
  logger = console,
  now = () => Date.now(),
}) => {
  return async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname

    // Only handle /v1/messages (relative to the /apps/anthropic prefix)
    if (!pathname.endsWith("/v1/messages")) {
      writeJson(response, 404, { type: "error", error: { type: "not_found", message: "Not found" } })
      return
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { type: "error", error: { type: "method_not_allowed", message: "Method not allowed" } })
      return
    }

    const requestStart = now()
    let parsedModel = null
    let isStream = false
    let cacheDiagnostic = null
    let keepaliveBody = null
    let keepaliveSessionKey = null
    let recorded = false

    const recordOnce = (overrides) => {
      if (recorded) return
      recorded = true
      usageRecorder.fireAndForget(buildAnthropicUsageRecord({
        ts: new Date(requestStart).toISOString(),
        model: parsedModel,
        duration_ms: now() - requestStart,
        is_stream: isStream,
        stream_usage_seen: false,
        usage: null,
        request_id: null,
        cache_diagnostic: cacheDiagnostic,
        ...overrides,
      }))
    }

    try {
      let bodyBuffer = await readBody(request, maxBodyBytes)
      const body = JSON.parse(bodyBuffer.toString("utf8"))

      parsedModel = body.model || null
      isStream = body.stream === true

      // Run cache planner
      const { body: planned, diagnostics } = planAnthropicCacheMarkers(body, cacheOptions)
      cacheDiagnostic = diagnostics

      if (diagnostics?.markers?.length >= 3) {
        keepaliveBody = truncateAnthropicBodyForKeepalive(planned, diagnostics.markers)
        keepaliveSessionKey = diagnostics.markers[0]?.prefix_hash ?? null
      }

      bodyBuffer = Buffer.from(JSON.stringify(planned))

      // Forward to upstream
      const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, "")}/v1/messages`
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: forwardHeaders(request, bodyBuffer.length, apiKey),
        body: bodyBuffer,
      })

      response.writeHead(upstreamResponse.status, responseHeadersToObject(upstreamResponse.headers))

      if (!upstreamResponse.body) {
        response.end()
        recordOnce({ status: upstreamResponse.status })
        return
      }

      // Sniff response for usage extraction
      const nonStreamMaxSniffBytes = Math.max(usageSniffBytes, 2 * 1024 * 1024)
      let sniffBuf = Buffer.alloc(0)
      let sniffOverflowed = false

      const collect = async function* (source) {
        for await (const chunk of source) {
          if (isStream) {
            sniffBuf = Buffer.concat([sniffBuf, chunk])
            if (sniffBuf.length > usageSniffBytes) {
              sniffBuf = sniffBuf.subarray(sniffBuf.length - usageSniffBytes)
            }
          } else if (!sniffOverflowed) {
            if (sniffBuf.length + chunk.length > nonStreamMaxSniffBytes) {
              sniffOverflowed = true
              sniffBuf = Buffer.alloc(0)
            } else {
              sniffBuf = Buffer.concat([sniffBuf, chunk])
            }
          }
          yield chunk
        }
      }

      let pipelineError = null
      try {
        await pipeline(Readable.fromWeb(upstreamResponse.body), collect, response)
      } catch (err) {
        pipelineError = err
        throw err
      } finally {
        const extracted = sniffOverflowed
          ? { usage: null, request_id: null, stream_usage_seen: null }
          : extractAnthropicUsage({ buffer: sniffBuf, isStream })

        recordOnce({
          status: pipelineError ? 502 : upstreamResponse.status,
          usage: extracted.usage,
          request_id: extracted.request_id,
          stream_usage_seen: extracted.stream_usage_seen,
          proxy_error: pipelineError ? String(pipelineError.message || pipelineError) : null,
        })

        if (!pipelineError && upstreamResponse.ok && keepaliveManager && keepaliveSessionKey && keepaliveBody) {
          keepaliveManager.registerHit({
            sessionKey: keepaliveSessionKey,
            pid: null,
            truncatedBody: keepaliveBody,
            model: parsedModel,
            url: upstreamUrl,
            authHeader: request.headers["x-api-key"]
              ? `Bearer ${request.headers["x-api-key"]}`
              : (apiKey ? `Bearer ${apiKey}` : null),
          })
        }
      }
    } catch (err) {
      if (err.statusCode === 413) {
        writeProxyError(response, 413, { type: "error", error: { type: "payload_too_large", message: err.message } })
        recordOnce({ status: 413, proxy_error: "payload_too_large" })
        return
      }
      logger.error?.(`anthropic-cache-proxy: ${err.stack || err}`)
      writeProxyError(response, 502, { type: "error", error: { type: "proxy_error", message: String(err.message || err) } })
      recordOnce({ status: 502, proxy_error: String(err.message || err) })
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test test/anthropic-handler.test.mjs`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add proxy/src/anthropic-handler.mjs proxy/test/anthropic-handler.test.mjs
git commit -m "feat(anthropic): add request handler with cache planning + usage recording"
```

---

## Task 4: Server Route Dispatch + Entry Point Config

**Files:**
- Modify: `proxy/src/server.mjs:205-217` (add route check before existing handler)
- Modify: `proxy/bin/bailian-cache-proxy.mjs` (add Anthropic env vars)

### Background for Implementer

The server.mjs currently has a single `createServer((request, response) => { ... })` handler that handles all requests. We need to add a path-based dispatch at the top that sends `/apps/anthropic/*` requests to the new anthropic handler, while keeping all existing behavior untouched.

The entry point needs new env vars: `ANTHROPIC_UPSTREAM_BASE_URL`, `ANTHROPIC_API_KEY`, `BAILIAN_CACHE_PROXY_ANTHROPIC_ENABLED`.

- [ ] **Step 1: Modify server.mjs to accept an anthropicHandler option and dispatch**

Add to `createBailianCacheProxy` options and insert path dispatch at the start of the request handler.

In `proxy/src/server.mjs`, add the `anthropicHandler` option to the factory function parameters (after `keepaliveHooks`):

```js
// Add to the destructured options of createBailianCacheProxy (line ~173):
  anthropicHandler = null,
```

Then insert at the TOP of the `createServer` callback (after `const requestPath = ...`, before the health check):

```js
    // Anthropic protocol dispatch — entirely separate pipeline
    if (anthropicHandler && requestPath.startsWith("/apps/anthropic/")) {
      lastActiveAt = Date.now()
      anthropicHandler(request, response)
      return
    }
```

- [ ] **Step 2: Modify bin/bailian-cache-proxy.mjs to wire up the Anthropic handler**

Add after the existing `const usageRecorder = ...` line and before `const { server } = createBailianCacheProxy(...)`:

```js
// Anthropic cache proxy — serves /apps/anthropic/v1/messages
import { createAnthropicHandler } from "../src/anthropic-handler.mjs"

const anthropicEnabled = process.env.BAILIAN_CACHE_PROXY_ANTHROPIC_ENABLED !== "0"
const anthropicUpstreamBaseUrl = process.env.ANTHROPIC_UPSTREAM_BASE_URL || "https://dashscope.aliyuncs.com/apps/anthropic"
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || ""

const anthropicHandler = anthropicEnabled
  ? createAnthropicHandler({
      upstreamBaseUrl: anthropicUpstreamBaseUrl,
      apiKey: anthropicApiKey,
      cacheOptions: { minCacheTokens: envNumber("BAILIAN_CACHE_PROXY_MIN_TOKENS", 1024) },
      usageRecorder,
      keepaliveManager: null,  // will wire up after server creation if keepalive enabled
    })
  : null
```

Then pass `anthropicHandler` to `createBailianCacheProxy`:

```js
const { server } = createBailianCacheProxy({
  // ... existing options ...
  anthropicHandler,
})
```

- [ ] **Step 3: Run full test suite to verify nothing broke**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test`
Expected: All existing tests still PASS, plus new anthropic tests PASS

- [ ] **Step 4: Commit**

```bash
git add proxy/src/server.mjs proxy/bin/bailian-cache-proxy.mjs
git commit -m "feat(anthropic): wire route dispatch and entry point config"
```

---

## Task 5: Keepalive Integration for Anthropic

**Files:**
- Modify: `proxy/bin/bailian-cache-proxy.mjs` (pass keepaliveManager to anthropic handler)
- Modify: `proxy/src/anthropic-handler.mjs` (already accepts keepaliveManager, just verify the registerHit call works with existing manager)

### Background for Implementer

The keepaliveManager already has a protocol-agnostic `registerHit` that takes `{sessionKey, pid, truncatedBody, model, url, authHeader}` and `sendKeepalive` sends a POST with the truncatedBody to the stored URL. For Anthropic, the truncatedBody is already in Anthropic format (from `truncateAnthropicBodyForKeepalive`), and the URL is the Anthropic messages endpoint. The existing `sendKeepalive` uses `fetch(entry.url, { body: JSON.stringify(entry.truncatedBody) })` — this works for both protocols since we store the full upstream URL and the body in the correct format.

The only issue: `sendKeepalive` sets `headers.authorization` but Anthropic uses `x-api-key`. We need to pass the auth header in a format the keepalive can use directly. The handler already stores `authHeader` as `Bearer <key>` which `sendKeepalive` puts in `headers.authorization`. For 百炼's Anthropic endpoint, `Authorization: Bearer <key>` is also accepted (alongside `x-api-key`), so this works without modification.

- [ ] **Step 1: Wire keepaliveManager to anthropicHandler in entry point**

In `proxy/bin/bailian-cache-proxy.mjs`, after `const { server } = createBailianCacheProxy(...)` is called (which creates and starts the keepalive manager), we need access to it. However, the keepalive manager is created inside `createBailianCacheProxy`. Two options:

The simplest fix: create the keepalive manager BEFORE calling `createBailianCacheProxy`, and pass it in. But this would require refactoring. Instead, since `createAnthropicHandler` already accepts `keepaliveManager`, just construct it directly for the Anthropic handler:

Replace the `anthropicHandler` creation block:

```js
import { createKeepaliveManager } from "../src/keepalive.mjs"

const anthropicKeepaliveManager = (anthropicEnabled && keepaliveEnabled)
  ? createKeepaliveManager({
      thresholdMs: keepaliveThresholdMs,
      scanIntervalMs: keepaliveScanIntervalMs,
      minHits: keepaliveMinHits,
      enabled: true,
    })
  : null

if (anthropicKeepaliveManager) anthropicKeepaliveManager.startTimer()

const anthropicHandler = anthropicEnabled
  ? createAnthropicHandler({
      upstreamBaseUrl: anthropicUpstreamBaseUrl,
      apiKey: anthropicApiKey,
      cacheOptions: { minCacheTokens: envNumber("BAILIAN_CACHE_PROXY_MIN_TOKENS", 1024) },
      usageRecorder,
      keepaliveManager: anthropicKeepaliveManager,
    })
  : null
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy && node --test`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add proxy/bin/bailian-cache-proxy.mjs
git commit -m "feat(anthropic): wire keepalive manager for TTL renewal"
```

---

## Task 6: End-to-End Validation

**Files:**
- No new files; uses existing proxy with real config

### Background for Implementer

This is a manual E2E test against 百炼. Requires `ANTHROPIC_API_KEY` set in `.env`.

- [ ] **Step 1: Update .env with Anthropic config**

Add to `proxy/.env`:

```
ANTHROPIC_UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/apps/anthropic
ANTHROPIC_API_KEY=<your-dashscope-api-key>
```

- [ ] **Step 2: Start the proxy**

```bash
cd /Users/leshi.zhy/claude-config/vendor/opencode-cache-proxy/proxy
node bin/bailian-cache-proxy.mjs
```

Verify log: `bailian-cache-proxy listening on http://127.0.0.1:48761`

- [ ] **Step 3: Send a test request to verify markers are added**

```bash
curl -s http://127.0.0.1:48761/apps/anthropic/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "qwen3.7-max",
    "system": [{"type":"text","text":"You are a helpful assistant. '"$(python3 -c "print('x '*300)")"'"}],
    "messages": [{"role":"user","content":[{"type":"text","text":"Say hello briefly. '"$(python3 -c "print('y '*300)")"'"}]}],
    "max_tokens": 50,
    "stream": false
  }' | jq '.usage'
```

Expected: response contains `cache_creation_input_tokens > 0` (markers were added and cache was created)

- [ ] **Step 4: Send same request again to verify cache hit**

Run the same curl command a second time.

Expected: `cache_read_input_tokens > 0` (cache hit from the first request's creation)

- [ ] **Step 5: Check usage.jsonl for the anthropic record**

```bash
tail -2 ~/.cache/bailian-cache-proxy/usage.jsonl | jq '{protocol, model, cache_hit_ratio, cache_creation_input_tokens, cache_read_input_tokens}'
```

Expected: `protocol: "anthropic"`, second record has `cache_hit_ratio > 0`

- [ ] **Step 6: Test with Claude Code pointing to proxy**

Create/update `~/.claude/bailian-settings-qwen37max.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:48761/apps/anthropic",
    ...existing...
  }
}
```

Start a Claude Code session with this config and verify:
1. Proxy receives requests (check stderr output)
2. Usage log shows `protocol: "anthropic"` entries with `cache_creation > 0` for thinking-prefill requests (these previously had 0)
