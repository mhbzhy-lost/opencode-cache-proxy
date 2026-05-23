/**
 * Extract usage from a buffered upstream chat-completions response.
 *
 * For non-streaming responses the body is a single JSON object containing
 * `usage`. For streaming responses (when the client passes
 * `stream_options.include_usage: true`) the trailing SSE event before
 * `data: [DONE]` carries `usage`. We parse both shapes uniformly.
 */

const SSE_PREFIX = "data:"
const SSE_DONE = "[DONE]"

const parseDataLine = (rawLine) => {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith(SSE_PREFIX)) return null
  const payload = trimmed.slice(SSE_PREFIX.length).trim()
  if (!payload || payload === SSE_DONE) return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

export const extractFromNonStream = (text) => {
  if (!text) return { usage: null, request_id: null }
  try {
    const obj = JSON.parse(text)
    return { usage: obj?.usage ?? null, request_id: obj?.id ?? null }
  } catch {
    return { usage: null, request_id: null }
  }
}

export const extractFromStream = (text) => {
  if (!text) return { usage: null, request_id: null, stream_usage_seen: false }
  let lastUsage = null
  let lastRequestId = null
  for (const rawLine of text.split(/\r?\n/)) {
    const obj = parseDataLine(rawLine)
    if (!obj) continue
    if (obj.id) lastRequestId = obj.id
    if (obj.usage) lastUsage = obj.usage
  }
  return {
    usage: lastUsage,
    request_id: lastRequestId,
    stream_usage_seen: lastUsage != null,
  }
}

export const extractUsage = ({ buffer, isStream }) => {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "")
  if (isStream) return extractFromStream(text)
  const non = extractFromNonStream(text)
  return { ...non, stream_usage_seen: null }
}

/**
 * Inject `stream_options.include_usage = true` for streaming chat-completions
 * requests so the upstream emits usage in the trailing SSE frame. We honour an
 * explicit `false` from the caller to avoid surprising them.
 */
export const ensureStreamUsageOption = (body) => {
  if (!body || typeof body !== "object") return body
  if (body.stream !== true) return body
  const existing = body.stream_options
  if (existing && typeof existing === "object" && "include_usage" in existing) {
    return body
  }
  return {
    ...body,
    stream_options: { ...(existing || {}), include_usage: true },
  }
}
