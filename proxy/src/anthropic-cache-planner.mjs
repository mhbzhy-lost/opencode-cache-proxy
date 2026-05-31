import { createHash } from "node:crypto"

const DEFAULT_MIN_CACHE_TOKENS = 1024
const DEFAULT_MAX_MARKERS = 4
const DEFAULT_MARKER_FRACTIONS = Object.freeze([0.5, 0.85])
const MAX_LOOKBACK_GAP = 18

const marker = Object.freeze({ type: "ephemeral" })
const CACHEABLE_CONTENT_TYPES = new Set(["text", "tool_use", "tool_result"])

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
  return CACHEABLE_CONTENT_TYPES.has(block.type)
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
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (tool?.cache_control) count += 1
    }
  }
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
  if (typeof planned.system === "string") {
    planned.system = [{ type: "text", text: planned.system }]
  }
  if (Array.isArray(planned.system)) {
    planned.system = planned.system.map(stripCacheControl)
  }
  if (Array.isArray(planned.messages)) {
    planned.messages = planned.messages.map((msg) => {
      if (!msg || !Array.isArray(msg.content)) return msg
      return { ...msg, content: msg.content.map(stripCacheControl) }
    })
  }
  if (Array.isArray(planned.tools)) {
    let keptToolMarkers = 0
    planned.tools = planned.tools.map((tool) => {
      if (!tool?.cache_control) return tool
      if (keptToolMarkers < maxMarkers) {
        keptToolMarkers += 1
        return tool
      }
      return stripCacheControl(tool)
    })
  }

  // Build block index (system blocks + message blocks in sequence).
  // Bailian Qwen3.5+ treats cache breakpoints at message granularity. Keep
  // selection to one marker per message so we do not generate schema-valid
  // Anthropic shapes that the compatibility endpoint rejects.
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
        groupKey: "system",
        blockType: block?.type ?? null,
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
          groupKey: `message:${mi}`,
          blockType: block?.type ?? null,
          globalIndex: blocks.length,
        })
      }
    }
  }

  const messagesHash = shortHash(stableStringify({
    system: planned.system,
    messages: planned.messages,
    tools: planned.tools,
  }))
  const thinkingUncacheableTail = blocks.at(-1)?.blockType === "thinking" ||
    blocks.at(-1)?.blockType === "redacted_thinking"
  const existingToolMarkerCount = Array.isArray(planned.tools)
    ? planned.tools.filter((tool) => tool?.cache_control).length
    : 0
  const markerBudget = Math.max(0, maxMarkers - existingToolMarkerCount)

  const selected = new Map() // globalIndex → location label
  const selectedByGroup = new Map() // system/message group → globalIndex

  const removeSelectedIndex = (globalIndex) => {
    selected.delete(globalIndex)
    for (const [groupKey, selectedIndex] of selectedByGroup.entries()) {
      if (selectedIndex === globalIndex) {
        selectedByGroup.delete(groupKey)
        break
      }
    }
  }

  const selectBlock = (block, label, { replaceLaterInGroup = false } = {}) => {
    if (!block) return false
    const existingIndex = selectedByGroup.get(block.groupKey)
    if (existingIndex !== undefined) {
      if (!replaceLaterInGroup || block.globalIndex <= existingIndex) return false
      removeSelectedIndex(existingIndex)
    }
    selected.set(block.globalIndex, label)
    selectedByGroup.set(block.groupKey, block.globalIndex)
    return true
  }

  const finishSelected = (strategy) => {
    // Keep only the remaining budget after existing tool markers.
    const finalIndexes = markerBudget > 0
      ? [...selected.keys()].sort((a, b) => a - b).slice(-markerBudget)
      : []
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
        version: 1,
        message_count: Array.isArray(planned.messages) ? planned.messages.length : 0,
        content_block_count: blocks.length,
        marker_count: markers.length,
        total_estimated_tokens: prefixTokens,
        strategy,
        messages_hash: messagesHash,
        marker_selection_hash: shortHash(stableStringify(markers)),
        thinking_uncacheable_tail: thinkingUncacheableTail,
        markers,
      },
    }
  }

  // Select marker positions
  const eligible = blocks.filter(
    (b) => b.canMark && b.prefixTokens >= minCacheTokens,
  )
  if (eligible.length === 0) {
    return finishSelected("anthropic-turn-stable")
  }

  // Slot 0: last system block
  const lastSystem = [...eligible].reverse().find((b) => b.location === "system")
  if (lastSystem) selectBlock(lastSystem, "system", { replaceLaterInGroup: true })

  // Slot 3: tail (last eligible block)
  const tail = eligible.at(-1)
  selectBlock(tail, "tail", { replaceLaterInGroup: true })

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
    selectBlock(turnAnchors[0], "turn-prev")
    selectBlock(turnAnchors[1], "turn-current")
  } else if (turnAnchors.length === 1) {
    selectBlock(turnAnchors[0], "turn-current")
  }

  if (turnAnchors.length < 2 && selected.size < markerBudget) {
    const anchorIndex = turnAnchors.at(-1)?.globalIndex ?? lastSystem?.globalIndex ?? -1
    const earlyStable = eligible.find(
      (b) =>
        b.globalIndex > anchorIndex &&
        b.globalIndex !== tail.globalIndex &&
        !selected.has(b.globalIndex) &&
        !selectedByGroup.has(b.groupKey),
    )
    if (earlyStable) selectBlock(earlyStable, "early-stable")
  }

  // Fallback: fill remaining with fraction-based if < markerBudget
  if (selected.size < markerBudget) {
    const stableEnd = lastSystem ? lastSystem.prefixTokens : 0
    const totalTokens = tail.prefixTokens
    const conversationTokens = totalTokens - stableEnd
    if (conversationTokens > 0) {
      for (const fraction of markerFractions) {
        if (selected.size >= markerBudget) break
        const targetTokens = stableEnd + conversationTokens * fraction
        const block = eligible.findLast(
          (b) =>
            b.prefixTokens <= targetTokens &&
            b.globalIndex !== tail.globalIndex &&
            !selected.has(b.globalIndex) &&
            !selectedByGroup.has(b.groupKey),
        )
        if (block) selectBlock(block, "fraction")
      }
    }
  }

  // 20-block lookback guard
  const sortedIndexes = [...selected.keys()].sort((a, b) => a - b)
  if (sortedIndexes.length >= 2) {
    const tailIdx = sortedIndexes.at(-1)
    const prevIdx = sortedIndexes.at(-2)
    if (tailIdx - prevIdx > MAX_LOOKBACK_GAP) {
      removeSelectedIndex(tailIdx)
      const cappedIdx = prevIdx + MAX_LOOKBACK_GAP
      const replacement = eligible.findLast(
        (b) =>
          b.globalIndex <= cappedIdx &&
          !selected.has(b.globalIndex) &&
          !selectedByGroup.has(b.groupKey),
      )
      if (replacement) {
        selectBlock(replacement, "tail")
      }
    }
  }

  return finishSelected("anthropic-turn-stable")
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
