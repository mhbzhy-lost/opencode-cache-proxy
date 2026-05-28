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
        prefixParts.push(stableStringify({ role: msg.role, content: block }))
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

  // Find turn anchors (from tail backward, skip tail itself)
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

  // 20-block lookback guard
  const sortedIndexes = [...selected.keys()].sort((a, b) => a - b)
  if (sortedIndexes.length >= 2) {
    const tailIdx = sortedIndexes.at(-1)
    const prevIdx = sortedIndexes.at(-2)
    if (tailIdx - prevIdx > MAX_LOOKBACK_GAP) {
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
      return { ...msg, content: msg.content.map(stripCacheControl) }
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
