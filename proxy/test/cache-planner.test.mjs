import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  countCacheMarkers,
  DEFAULT_MARKER_FRACTIONS,
  planBailianCacheMarkers,
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
    // the middle 100K+ tokens of prefix uncovered. The new strategy spreads
    // markers by token fraction so a mid-prefix cache segment can hit.
    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages: longConversation(80, 30) },
      { minCacheTokens: 16 },
    )
    assert.equal(countCacheMarkers(planned), 4)
    const positions = findMarkerMessageIndexes(planned)
    // 4 markers, well-spread: system anchor + two mid-prefix + tail.
    assert.equal(positions[0], 0, "first marker must anchor the system prefix")
    assert.equal(
      positions[positions.length - 1],
      planned.messages.length - 1,
      "last marker must anchor the conversation tail",
    )
    // Regression check: the OLD rolling-tail strategy collapsed all 3 tail
    // markers into the last ~60 blocks. The fix needs at least ONE mid marker
    // in the first half of the conversation so dashscope can cache the
    // mid-prefix segment instead of having to fall back to the system anchor
    // when the rolling window slides past the marker positions.
    const halfwayMessageIndex = Math.floor(planned.messages.length / 2)
    const midMarkers = positions.slice(1, -1)
    const hasEarlyMidMarker = midMarkers.some((idx) => idx <= halfwayMessageIndex)
    assert.ok(
      hasEarlyMidMarker,
      `expected at least one mid marker in the first half of ${planned.messages.length} messages, got mid=${JSON.stringify(midMarkers)}`,
    )
  })

  test("marker token positions remain stable as the conversation grows", () => {
    // Core value of the new strategy: across requests of growing length, the
    // same token-fraction targets land at consistent prefix-token boundaries
    // → dashscope hits the mid-prefix cache segment instead of rebuilding.
    const tokensPerTurn = 40
    const lengthsToTest = [40, 50, 60, 80]
    const tokenPositions = []
    for (const length of lengthsToTest) {
      const planned = planBailianCacheMarkers(
        { model: "qwen3.7-max", messages: longConversation(length, tokensPerTurn) },
        { minCacheTokens: 16 },
      )
      const positions = findMarkerMessageIndexes(planned)
      // Track the token position of the first MID-prefix marker (the one
      // matching DEFAULT_MARKER_FRACTIONS[0] ~= 0.5). It should grow
      // proportionally with the conversation, not snap back to the tail.
      const midIndex = positions[1] // [system, mid1, mid2, tail]
      // Compute the prefix-token count for that message index.
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
    // Mid marker prefix-token grows monotonically with conversation length
    // (i.e. the marker is *moving with* the conversation centre, not pinned
    // to the tail or to a fixed early block).
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
    const planned = planBailianCacheMarkers(
      { model: "qwen3.7-max", messages: longConversation(60, 30) },
      { minCacheTokens: 16, markerFractions: [0.25, 0.75] },
    )
    assert.equal(countCacheMarkers(planned), 4)
    // Smoke check: positions are different from default fractions [0.5, 0.85]
    // for the same conversation. We don't pin exact indexes (those depend on
    // tokenizer estimation), only that the override actually changes
    // something compared to default — otherwise the option would be a no-op.
    const positionsCustom = findMarkerMessageIndexes(planned)
    const positionsDefault = findMarkerMessageIndexes(
      planBailianCacheMarkers(
        { model: "qwen3.7-max", messages: longConversation(60, 30) },
        { minCacheTokens: 16 },
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
    assert.match(warnings[0], /markerFractions/)
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
})
