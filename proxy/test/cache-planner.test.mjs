import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  countCacheMarkers,
  DEFAULT_MARKER_FRACTIONS,
  planBailianCacheMarkers,
  planBailianCacheMarkersWithDiagnostics,
} from "../src/cache-planner.mjs"

const findMarkerMessageIndexes = (planned) => {
  const indexes = []
  planned.messages.forEach((msg, i) => {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && part.cache_control) {
          indexes.push(i)
          break
        }
      }
    }
  })
  return indexes
}

const longConversation = (turnCount, tokensPerTurn) => {
  const messages = [{ role: "system", content: "stable-system ".repeat(120) }]
  for (let i = 0; i < turnCount; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i} ${"context ".repeat(tokensPerTurn)}`,
    })
  }
  return messages
}

const repeatedText = (word, count) => Array.from({ length: count }, () => word).join(" ")

describe("planBailianCacheMarkers", () => {
  test("converts a long system string into a cacheable content block", () => {
    const body = {
      model: "qwen3.6-plus",
      messages: [
        { role: "system", content: repeatedText("stable-system", 140) },
        { role: "user", content: "What changed?" },
      ],
    }

    const planned = planBailianCacheMarkers(body, { minCacheTokens: 32 })

    assert.equal(countCacheMarkers(planned), 2)
    assert.deepEqual(planned.messages[0].content[0].cache_control, { type: "ephemeral" })
    assert.equal(planned.messages[0].content[0].text, body.messages[0].content)
    assert.deepEqual(planned.messages[1].content[0].cache_control, { type: "ephemeral" })
  })

  test("returns low-sensitive marker diagnostics for comparing cache prefixes", () => {
    const body = {
      model: "qwen3.7-max",
      messages: [
        { role: "system", content: repeatedText("stable-system", 120) },
        { role: "user", content: repeatedText("private-user-text", 40) },
        { role: "assistant", content: repeatedText("private-assistant-text", 40) },
        { role: "user", content: repeatedText("next-user-text", 40) },
      ],
    }

    const { body: planned, diagnostics } = planBailianCacheMarkersWithDiagnostics(body, {
      minCacheTokens: 16,
    })

    assert.equal(countCacheMarkers(planned), diagnostics.marker_count)
    assert.equal(diagnostics.version, 1)
    assert.equal(diagnostics.message_count, 4)
    assert.equal(diagnostics.content_block_count, 4)
    assert.match(diagnostics.messages_hash, /^[a-f0-9]{16}$/)
    assert.equal(diagnostics.markers.length, diagnostics.marker_count)
    assert.deepEqual(
      diagnostics.markers.map((entry) => entry.message_index),
      findMarkerMessageIndexes(planned),
    )
    for (const entry of diagnostics.markers) {
      assert.match(entry.prefix_hash, /^[a-f0-9]{16}$/)
      assert.equal(typeof entry.prefix_tokens, "number")
      assert.ok(entry.prefix_tokens > 0)
    }
    assert.equal(JSON.stringify(diagnostics).includes("private-user-text"), false)
    assert.equal(JSON.stringify(diagnostics).includes("private-assistant-text"), false)
  })

  test("strips existing markers and never emits more than four markers", () => {
    const messages = [
      {
        role: "system",
        content: [
          {
            type: "text",
            text: repeatedText("stable", 120),
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]

    for (let index = 0; index < 12; index += 1) {
      messages.push({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [
          {
            type: "text",
            text: repeatedText(`turn-${index}`, 20),
            cache_control: { type: "ephemeral" },
          },
        ],
      })
    }

    const planned = planBailianCacheMarkers(
      { model: "qwen3.6-plus", messages },
      { minCacheTokens: 16, maxLookbackContentBlocks: 3 },
    )

    assert.equal(countCacheMarkers(planned), 4)
  })

  test("keeps a rolling marker near the tail for long conversations", () => {
    const messages = [
      { role: "system", content: repeatedText("stable-system", 120) },
    ]

    for (let index = 0; index < 36; index += 1) {
      messages.push({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `turn ${index} ${repeatedText("context", 12)}`,
      })
    }

    const planned = planBailianCacheMarkers(
      { model: "qwen3.6-plus", messages },
      { minCacheTokens: 16, maxLookbackContentBlocks: 20 },
    )

    const lastMessage = planned.messages.at(-1)
    assert.deepEqual(lastMessage.content[0].cache_control, { type: "ephemeral" })
  })

  test("leaves non-chat bodies unchanged", () => {
    const body = { model: "qwen3.6-plus", input: "hello" }

    assert.deepEqual(planBailianCacheMarkers(body), body)
  })

  test("places mid-prefix markers at logarithmic token fractions, not at fixed block intervals", () => {
    // Regression for the production bug: with a long conversation, the old
    // strategy clustered three tail markers into the last 60 blocks, leaving
    // the middle 100K+ tokens of prefix uncovered. The fraction-based strategy
    // spreads markers by token fraction; test this explicitly with
    // markerStrategy="fraction" since the default is now "turn-stable".
    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages: longConversation(80, 30) },
      { minCacheTokens: 16, markerStrategy: "fraction" },
    )
    assert.equal(countCacheMarkers(planned), 4)
    const positions = findMarkerMessageIndexes(planned)
    assert.equal(positions[0], 0, "first marker must anchor the system prefix")
    assert.equal(
      positions[positions.length - 1],
      planned.messages.length - 1,
      "last marker must anchor the conversation tail",
    )
    const halfwayMessageIndex = Math.floor(planned.messages.length / 2)
    const midMarkers = positions.slice(1, -1)
    const hasEarlyMidMarker = midMarkers.some((idx) => idx <= halfwayMessageIndex)
    assert.ok(
      hasEarlyMidMarker,
      `expected at least one mid marker in the first half of ${planned.messages.length} messages, got mid=${JSON.stringify(midMarkers)}`,
    )
  })

  test("marker token positions remain stable as the conversation grows", () => {
    // Core value across either strategy: markers advance forward with the
    // conversation instead of jumping erratically. We test the fraction
    // strategy here since its positions are deterministic token fractions.
    const tokensPerTurn = 40
    const lengthsToTest = [40, 50, 60, 80]
    const tokenPositions = []
    for (const length of lengthsToTest) {
      const planned = planBailianCacheMarkers(
        { model: "qwen3.7-max", messages: longConversation(length, tokensPerTurn) },
        { minCacheTokens: 16, markerStrategy: "fraction" },
      )
      const positions = findMarkerMessageIndexes(planned)
      const midIndex = positions[1]
      const prefixTokens = planned.messages
        .slice(0, midIndex + 1)
        .reduce((sum, msg) => {
          const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
          return (
            sum +
            parts.reduce(
              (s, p) =>
                s +
                Math.ceil(
                  (typeof p === "string"
                    ? p
                    : typeof p?.text === "string"
                      ? p.text
                      : JSON.stringify(p)
                  ).length / 4,
                ),
              0,
            )
          )
        }, 0)
      tokenPositions.push({ length, midIndex, prefixTokens })
    }
    for (let i = 1; i < tokenPositions.length; i += 1) {
      assert.ok(
        tokenPositions[i].prefixTokens > tokenPositions[i - 1].prefixTokens,
        `mid marker prefix should grow: ${JSON.stringify(tokenPositions)}`,
      )
    }
  })

  test("DEFAULT_MARKER_FRACTIONS is a frozen 2-element array of values in (0,1)", () => {
    // Public surface guarantee: callers may want to override; we promise the
    // default is a stable shape with values strictly between system anchor
    // and tail anchor.
    assert.equal(Object.isFrozen(DEFAULT_MARKER_FRACTIONS), true)
    assert.equal(DEFAULT_MARKER_FRACTIONS.length, 2)
    for (const f of DEFAULT_MARKER_FRACTIONS) {
      assert.ok(f > 0 && f < 1, `fraction ${f} must be in open interval (0,1)`)
    }
  })

  test("markerFractions option is honoured for callers that want a different distribution", () => {
    // markerFractions only has effect under markerStrategy="fraction" — both
    // custom and default calls use "fraction" here so the test isolates the
    // fractions override rather than comparing fraction vs turn-stable.
    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages: longConversation(60, 30) },
      { minCacheTokens: 16, markerStrategy: "fraction", markerFractions: [0.25, 0.75] },
    )
    assert.equal(countCacheMarkers(planned), 4)
    const positionsCustom = findMarkerMessageIndexes(planned)
    const positionsDefault = findMarkerMessageIndexes(
      planBailianCacheMarkers(
        { model: "qwen3.7-max", messages: longConversation(60, 30) },
        { minCacheTokens: 16, markerStrategy: "fraction" },
      ),
    )
    assert.notDeepEqual(positionsCustom, positionsDefault)
  })

  test("warns loudly when caller passes the deprecated maxLookbackContentBlocks option", () => {
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(" "))
    try {
      planBailianCacheMarkers(
        { model: "qwen3.6-flash", messages: longConversation(40, 30) },
        { minCacheTokens: 16, maxLookbackContentBlocks: 20 },
      )
    } finally {
      console.warn = origWarn
    }
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /maxLookbackContentBlocks is deprecated/)
    assert.match(warnings[0], /markerStrategy/)
  })

  test("does NOT warn when maxLookbackContentBlocks is omitted (the normal path)", () => {
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(" "))
    try {
      planBailianCacheMarkers(
        { model: "qwen3.6-flash", messages: longConversation(40, 30) },
        { minCacheTokens: 16 },
      )
    } finally {
      console.warn = origWarn
    }
    assert.equal(warnings.length, 0)
  })

  test("falls back gracefully when conversation is too short for mid markers", () => {
    // Only system prefix + one user turn → 2 markers (firstStable + tail),
    // no mid-prefix markers because conversationTokens is small.
    const planned = planBailianCacheMarkers(
      {
        model: "qwen3.6-flash",
        messages: [
          { role: "system", content: "stable ".repeat(200) },
          { role: "user", content: "hi" },
        ],
      },
      { minCacheTokens: 16 },
    )
    // Should be 1 or 2 markers, never throw or return junk.
    const count = countCacheMarkers(planned)
    assert.ok(count >= 1 && count <= 2, `expected 1-2 markers, got ${count}`)
  })

  // --- Turn-stable strategy specific tests ---

  test("turn-stable anchors mid-markers at user turn boundaries, not at token fractions", () => {
    // OpenCode-style conversation: system + alternating user/assistant turns,
    // where the last turn has many assistant tool calls (simulated as extra
    // assistant+user pairs). Turn-stable should anchor at the LAST two user
    // messages with real text content, not drift by token count.
    const messages = [
      { role: "system", content: repeatedText("stable", 120) },
      { role: "user", content: "please do task A " + repeatedText("ctx-A", 40) },
      { role: "assistant", content: "doing A " + repeatedText("result-A", 40) },
      { role: "user", content: "please do task B " + repeatedText("ctx-B", 40) },
      { role: "assistant", content: repeatedText("tool-call-1", 30) },
      { role: "user", content: [{ type: "tool_result", content: "result-1" }] },
      { role: "assistant", content: repeatedText("tool-call-2", 30) },
      { role: "user", content: [{ type: "tool_result", content: "result-2" }] },
      { role: "assistant", content: repeatedText("tool-call-3", 30) },
    ]

    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages },
      { minCacheTokens: 16, markerStrategy: "turn-stable" },
    )
    const positions = findMarkerMessageIndexes(planned)
    assert.equal(countCacheMarkers(planned), 4)

    assert.equal(positions[0], 0)
    assert.equal(positions[positions.length - 1], 8)

    const midPositions = positions.slice(1, -1)
    for (const idx of midPositions) {
      const msg = planned.messages[idx]
      assert.equal(msg.role, "user", `mid-marker at index ${idx} must land on a user message`)
      if (typeof msg.content === "string") {
        // Real user text (good)
      } else {
        const hasTextPart = Array.isArray(msg.content) &&
          msg.content.some((p) => typeof p === "object" && p.type === "text")
        assert.ok(hasTextPart, `mid-marker at index ${idx} must have text content (not tool_result)`)
      }
    }
  })

  test("turn-stable keeps mid-markers stable across consecutive requests in the same turn", () => {
    const baseConversation = [
      { role: "system", content: repeatedText("stable", 120) },
      { role: "user", content: "do task A " + repeatedText("ctx-A", 40) },
      { role: "assistant", content: "result A " + repeatedText("res", 40) },
      { role: "user", content: "do task B " + repeatedText("ctx-B", 40) },
    ]

    const request1 = [
      ...baseConversation,
      { role: "assistant", content: repeatedText("tool-1", 30) },
      { role: "user", content: [{ type: "tool_result", content: "r1" }] },
      { role: "assistant", content: repeatedText("tool-2", 30) },
    ]
    const request2 = [
      ...request1,
      { role: "user", content: [{ type: "tool_result", content: "r2" }] },
      { role: "assistant", content: repeatedText("tool-3", 30) },
      { role: "user", content: [{ type: "tool_result", content: "r3" }] },
      { role: "assistant", content: repeatedText("tool-4", 30) },
    ]

    const planned1 = planBailianCacheMarkersWithDiagnostics(
      { model: "qwen3.7-max", messages: request1 },
      { minCacheTokens: 16, markerStrategy: "turn-stable" },
    )
    const planned2 = planBailianCacheMarkersWithDiagnostics(
      { model: "qwen3.7-max", messages: request2 },
      { minCacheTokens: 16, markerStrategy: "turn-stable" },
    )

    const hashes1 = planned1.diagnostics.markers.map((m) => m.prefix_hash)
    const hashes2 = planned2.diagnostics.markers.map((m) => m.prefix_hash)

    for (let i = 0; i < Math.min(hashes1.length - 1, hashes2.length - 1); i += 1) {
      assert.equal(
        hashes1[i], hashes2[i],
        `marker ${i} prefix hash should match between requests within the same turn`,
      )
    }
  })

  test("turn-stable diagnostics include strategy field set to turn-stable", () => {
    const { diagnostics } = planBailianCacheMarkersWithDiagnostics(
      {
        model: "qwen3.7-max",
        messages: [
          { role: "system", content: repeatedText("stable", 120) },
          { role: "user", content: "hi" },
        ],
      },
      { minCacheTokens: 16 },
    )
    assert.equal(diagnostics.strategy, "turn-stable")
  })

  test("turn-stable falls back to fraction placement when no turn boundaries found", () => {
    const messages = [
      { role: "system", content: repeatedText("stable", 120) },
      { role: "assistant", content: repeatedText("content", 40) },
      { role: "assistant", content: repeatedText("more-content", 40) },
      { role: "assistant", content: repeatedText("even-more", 40) },
    ]
    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages },
      { minCacheTokens: 16, markerStrategy: "turn-stable" },
    )
    const count = countCacheMarkers(planned)
    assert.ok(count >= 2 && count <= 4, `expected 2-4 markers, got ${count}`)
  })
})
