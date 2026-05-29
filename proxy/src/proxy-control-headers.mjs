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

export const isLoopbackRemoteAddress = (address) => {
  const normalized = String(address || "").trim().toLowerCase()
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true

  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized
  const parts = ipv4.split(".")
  return parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
}
