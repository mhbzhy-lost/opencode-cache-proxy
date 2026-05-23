const DEFAULT_MIN_CACHE_TOKENS = 1024
const DEFAULT_MAX_MARKERS = 4
// Token-fraction positions for the two intermediate markers between the
// stable system/developer anchor and the conversation tail. The previous
// design used a fixed N-block rolling window which collapsed all three tail
// markers into the last 60 blocks once a conversation exceeded ~60 turns —
// any new request whose mid-prefix differed from the rolling window lost the
// dashscope cache for the entire middle of the prompt (~100K-200K tokens
// observed in production). Logarithmic fractions keep one marker around the
// halfway point and one near the tail of the conversation, so cache segments
// land at consistent token boundaries across requests of varying lengths.
export const DEFAULT_MARKER_FRACTIONS = Object.freeze([0.5, 0.85])
const CACHEABLE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"])
const TEXT_LIKE_PART_TYPES = new Set(["text", "input_text"])

const marker = Object.freeze({ type: "ephemeral" })

const cloneJson = (value) => {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
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

const selectMarkerContentIndexes = (blocks, options) => {
  const {
    maxMarkers = DEFAULT_MAX_MARKERS,
    minCacheTokens = DEFAULT_MIN_CACHE_TOKENS,
    markerFractions = DEFAULT_MARKER_FRACTIONS,
    // Loud deprecation: the previous strategy honoured maxLookbackContentBlocks
    // to place rolling tail markers every N blocks. The current strategy uses
    // markerFractions instead (see comment near DEFAULT_MARKER_FRACTIONS); we
    // surface a warning so callers passing the old option know it has no
    // effect rather than silently inheriting the new fraction-based layout.
    maxLookbackContentBlocks,
  } = options
  if (maxLookbackContentBlocks !== undefined) {
    // Use console.warn rather than throwing so existing deployments don't
    // break on first request after upgrade.
    console.warn(
      "[bailian-cache-proxy] cache-planner: maxLookbackContentBlocks is deprecated " +
        "and ignored — markers are now placed at token fractions (see DEFAULT_MARKER_FRACTIONS). " +
        "Pass `markerFractions` to override the [0.5, 0.85] default.",
    )
  }

  const eligible = blocks.filter((block) => block.canMark && block.prefixTokens >= minCacheTokens)
  if (eligible.length === 0 || maxMarkers <= 0) return []

  const tailBlock = eligible.at(-1)
  const totalTokens = tailBlock.prefixTokens
  const selected = new Set()

  // 1. Stable anchor: end of system/developer prefix. Same token position
  //    every request → dashscope reuses this segment for life of the chat.
  const firstStable = eligible.find(
    (block) => block.role === "system" || block.role === "developer",
  )
  if (firstStable) selected.add(firstStable.contentIndex)

  // 2. Tail anchor: the very last eligible block, so the next-turn request
  //    can extend from here.
  selected.add(tailBlock.contentIndex)

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
      // Pick the eligible block whose accumulated prefixTokens is the largest
      // value <= targetTokens, and that lies *before* the tail (don't double
      // up on the tail anchor).
      const block = eligible.findLast(
        (b) => b.prefixTokens <= targetTokens && b.contentIndex < tailBlock.contentIndex,
      )
      if (block) selected.add(block.contentIndex)
    }
  }

  return [...selected].sort((a, b) => a - b).slice(-maxMarkers)
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
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return body

  const planned = cloneJson(body)
  const blocks = []
  let prefixTokens = 0

  planned.messages = planned.messages.map((message, messageIndex) => {
    if (!message || typeof message !== "object") return message

    const clonedMessage = { ...message }
    delete clonedMessage.cache_control
    clonedMessage.content = normalizeContentParts(clonedMessage.content)

    const role = String(clonedMessage.role || "")
    clonedMessage.content.forEach((part, partIndex) => {
      prefixTokens += estimateTokens(part)
      blocks.push({
        role,
        messageIndex,
        partIndex,
        prefixTokens,
        contentIndex: blocks.length,
        canMark: CACHEABLE_ROLES.has(role) && canMarkPart(part),
      })
    })

    return clonedMessage
  })

  const selectedIndexes = new Set(selectMarkerContentIndexes(blocks, options))
  for (const block of blocks) {
    if (selectedIndexes.has(block.contentIndex)) {
      annotateMarker(planned.messages[block.messageIndex], block.partIndex)
    }
  }

  return planned
}
