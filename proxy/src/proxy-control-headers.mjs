const CONTROL_PREFIX = "x-cache-proxy-"

const CONTROL_KEYS = new Map([
  ["x-cache-proxy-upstream-base-url", "upstreamBaseUrl"],
  ["x-cache-proxy-cache-strategy", "cacheStrategy"],
  ["x-cache-proxy-marker-strategy", "markerStrategy"],
  ["x-cache-proxy-metadata-user-id", "metadataUserId"],
  ["x-cache-proxy-upstream-user-agent", "upstreamUserAgent"],
])

export const extractProxyControlHeaders = (headers = {}) => {
  const cleanHeaders = {}
  const control = {}

  for (const [key, value] of Object.entries(headers ?? {})) {
    const lowerKey = key.toLowerCase()
    if (lowerKey.startsWith(CONTROL_PREFIX)) {
      const controlKey = CONTROL_KEYS.get(lowerKey)
      const trimmed = String(value ?? "").trim()
      if (controlKey && trimmed) control[controlKey] = trimmed
      continue
    }
    cleanHeaders[key] = value
  }

  return { control, headers: cleanHeaders }
}
