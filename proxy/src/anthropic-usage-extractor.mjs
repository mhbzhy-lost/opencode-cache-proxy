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
