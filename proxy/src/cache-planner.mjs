import { createHash } from "node:crypto"

const DEFAULT_MIN_CACHE_TOKENS = 1024
const DEFAULT_MAX_MARKERS = 4

export const MARKER_STRATEGY_FRACTION = "fraction"
export const MARKER_STRATEGY_TURN_STABLE = "turn-stable"
export const DEFAULT_MARKER_STRATEGY = MARKER_STRATEGY_TURN_STABLE

// Fallback token-fraction positions for the two intermediate markers (used only
// when markerStrategy "fraction" is selected). The previous design used a fixed
// N-block rolling window which collapsed all three tail markers into the last
// 60 blocks once a conversation exceeded ~60 turns — any new request whose
// mid-prefix differed from the rolling window lost the dashscope cache for the
// entire middle of the prompt (~100K-200K tokens observed in production).
// Logarithmic fractions keep one marker around the halfway point and one near
// the tail of the conversation, so cache segments land at consistent token
// boundaries across requests of varying lengths.
export const DEFAULT_MARKER_FRACTIONS = Object.freeze([0.5, 0.85])
const CACHEABLE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"])
const TEXT_LIKE_PART_TYPES = new Set(["text", "input_text"])

const marker = Object.freeze({ type: "ephemeral" })

const shortHash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16)

const cloneJson = (value) => {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
  return `{${entries.join(",")}}`
}

const estimateTokens = (value) => {
  if (typeof value === "string") return Math.ceil(value.length / 4)
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return estimateTokens(value.text)
    if (typeof value.content === "string") return estimateTokens(value.content)
    return Math.ceil(JSON.stringify(value).length / 4)
  }
  return 0
}

const normalizeContentParts = (content) => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return { type: "text", text: part }
      if (part && typeof part === "object") {
        const cloned = { ...part }
        delete cloned.cache_control
        return cloned
      }
      return part
    })
  }
  if (content && typeof content === "object") {
    const cloned = { ...content }
    delete cloned.cache_control
    return [cloned]
  }
  return []
}

const canMarkPart = (part) => {
  if (!part || typeof part !== "object") return false
  if (!("type" in part)) return true
  return TEXT_LIKE_PART_TYPES.has(part.type) || "text" in part
}

const annotateMarker = (message, partIndex) => {
  message.content[partIndex] = {
    ...message.content[partIndex],
    cache_control: { ...marker },
  }
}

const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b)

// True when the block represents a user-role message carrying an actual user
// prompt / instruction (string or plain-text content) rather than a tool-call
// result. In OpenAI-compatible chat history:
//   - role="user" content="<string>"   → real user message (turn boundary)
//   - role="user" content=[{type:"tool_result",...}, ...] → tool result
// Tool-result user messages arrive in chains following assistant tool_calls;
// they sit INSIDE a turn and move between requests as more tool calls fire.
// Only plain-text user messages mark turn boundaries.
const blockIsTurnAnchor = (block) => {
  if (block.role !== "user") return false
  if (typeof block.content === "string") return block.content.length > 0
  if (block.content && typeof block.content === "object") {
    const type = block.content.type
    if (type === "tool_result") return false
    return Boolean(block.content.text)
  }
  return false
}

// Walk backward from the tail anchor, collecting up to `limit` user-role
// turn-anchor messages. The last one pushed is the "oldest" turn boundary
// relative to the tail — typically the start of the previous user turn.
// Returns them oldest-first so the caller can add them directly.
const findPreviousTurnAnchors = (blocks, tailBlock, limit = 2) => {
  const anchors = []
  for (let i = tailBlock.contentIndex - 1; i >= 0 && anchors.length < limit; i--) {
    if (blockIsTurnAnchor(blocks[i])) {
      anchors.unshift(blocks[i])
    }
  }
  return anchors
}

// Turn-stable strategy: instead of placing mid markers at fixed token
// fractions, anchor them at user-message turn boundaries.
//
// Why: within a single opencode turn the user sends one message, then the
// assistant fires many tool calls accumulating tool-result blocks until the
// turn ends. The prefix up to the user's message is constant across ALL tool
// calls in that turn — a marker at the user message boundary therefore hits
// the cache for every subsequent request in the same turn. By contrast, the
// fraction-based strategy drifts forward as token count grows, invalidating
// the cache on every request.
//
// Across turns, the previous turn's user message becomes a permanent prefix
// point (Turn N's history is a fixed prefix of Turn N+1's history). The new
// turn's user message takes the "current turn" slot, and markers cascade:
//   Request A (turn 1, in-flight):  [system, turn0_user, turn1_user, tail]
//   Request B (turn 2, in-flight):  [system, turn1_user, turn2_user, tail]
//   Markers 0, 1, 2 identical between A → B → 3 of 4 markers hit every
//   cross-turn request.
//
// Fallback: if fewer than 2 turn-boundary user messages exist (e.g. very
// short conversations or tool-only interactions), fall back to fraction-based
// placement so we don't waste slots.
const selectTurnStableMarkerIndexes = (blocks, eligible, tailBlock, maxMarkers) => {
  const selected = new Map()

  // 1. System/developer anchor (highest stability).
  const firstStable = eligible.find(
    (block) => block.role === "system" || block.role === "developer",
  )
  if (firstStable) selected.set(firstStable.contentIndex, "system")

  // 2. Tail anchor.
  selected.set(tailBlock.contentIndex, "tail")

  // 3. Turn-boundary anchors (up to maxMarkers - selected.size).
  //    Oldest-first: turnAnchors[0] is the previous turn boundary ("turn-prev"),
  //    turnAnchors[1] (if present) is the current turn boundary ("current").
  const turnAnchors = findPreviousTurnAnchors(
    blocks, tailBlock, maxMarkers - selected.size,
  )
  const turnLabels = ["turn-prev", "current"]
  for (let i = 0; i < turnAnchors.length; i++) {
    const anchor = turnAnchors[i]
    if (anchor.contentIndex !== tailBlock.contentIndex &&
        anchor.prefixTokens >= blocks[0]?.prefixTokens + 1) {
      selected.set(anchor.contentIndex, turnLabels[i])
    }
  }

  // 4. Fallback: fill remaining slots with fraction-based mid markers if we
  //    didn't find enough turn anchors.
  if (selected.size < maxMarkers) {
    const fallbackFractions = DEFAULT_MARKER_FRACTIONS
    const stableEnd = firstStable ? firstStable.prefixTokens : 0
    const totalTokens = tailBlock.prefixTokens
    const conversationTokens = totalTokens - stableEnd
    if (conversationTokens > 0) {
      for (const fraction of fallbackFractions) {
        if (selected.size >= maxMarkers) break
        const targetTokens = stableEnd + conversationTokens * fraction
        const block = eligible.findLast(
          (b) => b.prefixTokens <= targetTokens && b.contentIndex < tailBlock.contentIndex,
        )
        if (block && !selected.has(block.contentIndex)) {
          selected.set(block.contentIndex, "message")
        }
      }
    }
  }

  const sorted = [...selected.entries()].sort((a, b) => a[0] - b[0]).slice(-maxMarkers)
  return new Map(sorted)
}

const selectMarkerContentIndexes = (blocks, options) => {
  const {
    maxMarkers = DEFAULT_MAX_MARKERS,
    minCacheTokens = DEFAULT_MIN_CACHE_TOKENS,
    markerStrategy = DEFAULT_MARKER_STRATEGY,
    markerFractions = DEFAULT_MARKER_FRACTIONS,
    // Loud deprecation: the previous strategy honoured maxLookbackContentBlocks
    // to place rolling tail markers every N blocks. Marker strategies
    // (fraction and turn-stable) no longer use it; surface a warning so callers
    // passing the old option know it has no effect.
    maxLookbackContentBlocks,
  } = options
  if (maxLookbackContentBlocks !== undefined) {
    // Use console.warn rather than throwing so existing deployments don't
    // break on first request after upgrade.
    console.warn(
      "[bailian-cache-proxy] cache-planner: maxLookbackContentBlocks is deprecated " +
        "and ignored — markers are now placed by `markerStrategy` (default: turn-stable). " +
        "Set BAILIAN_CACHE_PROXY_MARKER_STRATEGY=fraction to restore token-fraction placement.",
    )
  }

  const eligible = blocks.filter((block) => block.canMark && block.prefixTokens >= minCacheTokens)
  if (eligible.length === 0 || maxMarkers <= 0) return new Map()
  if (markerStrategy === "none") return new Map()

  const tailBlock = eligible.at(-1)

  if (markerStrategy === MARKER_STRATEGY_TURN_STABLE) {
    return selectTurnStableMarkerIndexes(blocks, eligible, tailBlock, maxMarkers)
  }

  // Legacy fraction-based strategy.
  const totalTokens = tailBlock.prefixTokens
  const selected = new Map()

  // 1. Stable anchor: end of system/developer prefix. Same token position
  //    every request → dashscope reuses this segment for life of the chat.
  const firstStable = eligible.find(
    (b) => b.role === "system" || b.role === "developer",
  )
  if (firstStable) selected.set(firstStable.contentIndex, "system")

  // 2. Tail anchor: the very last eligible block, so the next-turn request
  //    can extend from here.
  selected.set(tailBlock.contentIndex, "tail")

  // 3. Mid-prefix anchors at fixed token fractions between firstStable and
  //    tail. By picking blocks closest to a target token count (rather than
  //    fixed N-block intervals from the tail), markers tend to land at the
  //    same dashscope cache key across consecutive requests with different
  //    conversation lengths — letting big mid-prefix segments hit instead of
  //    falling back to the system-only anchor.
  const stableEnd = firstStable ? firstStable.prefixTokens : 0
  const conversationTokens = totalTokens - stableEnd
  if (conversationTokens > 0) {
    for (const fraction of markerFractions) {
      if (selected.size >= maxMarkers) break
      const targetTokens = stableEnd + conversationTokens * fraction
      const block = eligible.findLast(
        (b) => b.prefixTokens <= targetTokens && b.contentIndex < tailBlock.contentIndex,
      )
      if (block && !selected.has(block.contentIndex)) {
        selected.set(block.contentIndex, "message")
      }
    }
  }

  const sorted = [...selected.entries()].sort((a, b) => a[0] - b[0]).slice(-maxMarkers)
  return new Map(sorted)
}

export const countCacheMarkers = (body) => {
  if (!body || !Array.isArray(body.messages)) return 0
  let count = 0
  for (const message of body.messages) {
    const parts = Array.isArray(message?.content) ? message.content : []
    for (const part of parts) {
      if (part && typeof part === "object" && part.cache_control) count += 1
    }
  }
  return count
}

export const planBailianCacheMarkers = (body, options = {}) => {
  return planBailianCacheMarkersWithDiagnostics(body, options).body
}

export const planBailianCacheMarkersWithDiagnostics = (body, options = {}) => {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return { body, diagnostics: null }
  }

  const resolvedStrategy = options.markerStrategy || DEFAULT_MARKER_STRATEGY

  if (resolvedStrategy === "none") {
    let contentBlockCount = 0
    for (const message of body.messages) {
      if (!message || typeof message !== "object") continue
      if (Array.isArray(message.content)) {
        contentBlockCount += message.content.length
      } else if (message.content !== undefined) {
        contentBlockCount += 1
      }
    }
    return {
      body,
      diagnostics: {
        version: 1,
        strategy: "none",
        message_count: body.messages.length,
        content_block_count: contentBlockCount,
        total_estimated_tokens: 0,
        marker_count: 0,
        messages_hash: null,
        marker_selection_hash: shortHash("[]"),
        markers: [],
      },
    }
  }

  const planned = cloneJson(body)
  const blocks = []
  let prefixTokens = 0
  const prefixParts = []

  planned.messages = planned.messages.map((message, messageIndex) => {
    if (!message || typeof message !== "object") return message

    const clonedMessage = { ...message }
    delete clonedMessage.cache_control
    clonedMessage.content = normalizeContentParts(clonedMessage.content)

    const role = String(clonedMessage.role || "")
    clonedMessage.content.forEach((part, partIndex) => {
      prefixTokens += estimateTokens(part)
      prefixParts.push(stableStringify({ role, content: part }))
      blocks.push({
        role,
        messageIndex,
        partIndex,
        prefixTokens,
        prefixHash: shortHash(prefixParts.join("\n")),
        contentIndex: blocks.length,
        canMark: CACHEABLE_ROLES.has(role) && canMarkPart(part),
        content: part,
      })
    })

    return clonedMessage
  })

  const messagesHash = shortHash(stableStringify(planned.messages))
  // selectMarkerContentIndexes returns a Map<contentIndex, label> where labels
  // are "system", "turn-prev", "current", "tail", or "message". The Bailian
  // planner uses the same convention as the Anthropic planner so that stats
  // scripts and monitoring can treat both protocols uniformly.
  const selected = selectMarkerContentIndexes(blocks, options)
  for (const block of blocks) {
    if (selected.has(block.contentIndex)) {
      annotateMarker(planned.messages[block.messageIndex], block.partIndex)
    }
  }

  const baseLocation = (role) =>
    role === "system" || role === "developer" ? "system" : "message"

  const markers = blocks
    .filter((block) => selected.has(block.contentIndex))
    .map((block) => ({
      location: selected.get(block.contentIndex) || baseLocation(block.role),
      role: block.role,
      message_index: block.messageIndex,
      part_index: block.partIndex,
      content_index: block.contentIndex,
      prefix_tokens: block.prefixTokens,
      prefix_hash: block.prefixHash,
    }))

  return {
    body: planned,
    diagnostics: {
      version: 1,
      strategy: resolvedStrategy,
      message_count: planned.messages.length,
      content_block_count: blocks.length,
      total_estimated_tokens: prefixTokens,
      marker_count: markers.length,
      messages_hash: messagesHash,
      marker_selection_hash: shortHash(stableStringify(markers)),
      markers,
    },
  }
}

export const truncateBodyForKeepalive = (body, markers) => {
  if (!body || typeof body !== "object" || !Array.isArray(body?.messages)) return null
  if (!Array.isArray(markers) || markers.length < 3) return null

  const cutoffMessageIndex = markers[2].message_index
  if (!Number.isFinite(cutoffMessageIndex) || cutoffMessageIndex < 0) return null

  const truncatedMessages = body.messages
    .slice(0, cutoffMessageIndex + 1)
    .map((msg) => {
      const cloned = { ...msg }
      delete cloned.cache_control
      if (Array.isArray(cloned.content)) {
        cloned.content = cloned.content.map((part) => {
          if (!part || typeof part !== "object") return part
          const p = { ...part }
          delete p.cache_control
          return p
        })
      }
      return cloned
    })

  return {
    model: body.model,
    messages: truncatedMessages,
    stream: false,
    max_tokens: 1,
    _keepalive: true,
  }
}
