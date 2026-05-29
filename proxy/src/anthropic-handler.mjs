import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import {
  countAnthropicCacheMarkers,
  planAnthropicCacheMarkers,
  truncateAnthropicBodyForKeepalive,
} from "./anthropic-cache-planner.mjs"
import { extractAnthropicUsage } from "./anthropic-usage-extractor.mjs"

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
const DEFAULT_USAGE_SNIFF_BYTES = 64 * 1024

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const RESPONSE_STRIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
])

const readBody = async (request, maxBodyBytes) => {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxBodyBytes) {
      const err = new Error(`request body exceeds ${maxBodyBytes} bytes`)
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const writeJson = (response, statusCode, body) => {
  response.writeHead(statusCode, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const writeProxyError = (response, statusCode, body) => {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  writeJson(response, statusCode, body)
}

const responseHeadersToObject = (headers) => {
  const result = {}
  for (const [key, value] of headers.entries()) {
    if (RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) continue
    result[key] = value
  }
  return result
}

const forwardHeaders = (request, bodyLength, fallbackApiKey, { userAgent = "" } = {}) => {
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === "host" || lowerKey === "content-length") continue
    if (lowerKey === "content-encoding") continue
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue
    headers[key] = value
  }
  headers["content-length"] = String(bodyLength)
  if (!headers["x-api-key"] && fallbackApiKey) {
    headers["x-api-key"] = fallbackApiKey
  }
  if (userAgent) {
    headers["user-agent"] = userAgent
  }
  return headers
}

const computeAnthropicCacheHitRatio = (usage) => {
  if (!usage) return 0
  const inputTokens = Number(usage.input_tokens || 0)
  const cacheRead = Number(usage.cache_read_input_tokens || 0)
  const cacheCreation = Number(usage.cache_creation_input_tokens || 0)
  const total = inputTokens + cacheRead + cacheCreation
  if (total <= 0) return 0
  return Math.round((cacheRead / total) * 10000) / 10000
}

const shouldBypassCachePlanning = (cacheOptions) =>
  String(cacheOptions?.cacheStrategy || "").toLowerCase().trim() === "bypass"

const fillMissingMetadataUserId = (body, metadataUserId) => {
  if (!metadataUserId) return body
  const metadata = body?.metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.user_id !== undefined) {
    return body
  }
  return {
    ...body,
    metadata: {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      user_id: metadataUserId,
    },
  }
}

export const createAnthropicHandler = ({
  upstreamBaseUrl,
  apiKey = "",
  cacheOptions = {},
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  usageSniffBytes = DEFAULT_USAGE_SNIFF_BYTES,
  usageRecorder = { fireAndForget: () => {} },
  keepaliveManager = null,
  upstreamUserAgent = "",
  metadataUserId = "",
  logger = console,
  now = () => Date.now(),
} = {}) => {
  return async (request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname

    // Strip the /apps/anthropic prefix that the server.mjs router adds
    const relativePath = requestPath.replace(/^\/apps\/anthropic/, "")

    if (!relativePath.endsWith("/v1/messages")) {
      writeJson(response, 404, { error: "not_found" })
      return
    }

    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" })
      return
    }

    const requestStart = now()
    let parsedModel = null
    let isStream = false
    let cacheDiagnostic = null
    let recorded = false

    const recordOnce = (overrides) => {
      if (recorded) return
      recorded = true
      const record = {
        ts: new Date(requestStart).toISOString(),
        protocol: "anthropic",
        proxy_pid: process.pid,
        model: parsedModel,
        status: overrides.status ?? null,
        duration_ms: now() - requestStart,
        is_stream: isStream,
        stream_usage_seen: overrides.stream_usage_seen ?? false,
        input_tokens: overrides.usage?.input_tokens ?? null,
        output_tokens: overrides.usage?.output_tokens ?? null,
        cache_read_input_tokens: overrides.usage?.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: overrides.usage?.cache_creation_input_tokens ?? null,
        request_id: overrides.request_id ?? null,
        proxy_error: overrides.proxy_error ?? null,
        cache_hit_ratio: computeAnthropicCacheHitRatio(overrides.usage),
        cache_diagnostic: cacheDiagnostic,
      }
      usageRecorder.fireAndForget(record)
    }

    try {
      let bodyBuffer = await readBody(request, maxBodyBytes)
      let body = JSON.parse(bodyBuffer.toString("utf8"))

      parsedModel = body.model || null
      isStream = body.stream === true

      const bypassCachePlanning = shouldBypassCachePlanning(cacheOptions)
      let planned = body
      if (bypassCachePlanning) {
        cacheDiagnostic = {
          marker_count: 0,
          total_estimated_tokens: null,
          strategy: "anthropic-bypass",
          forwarded_marker_count: countAnthropicCacheMarkers(body),
          markers: [],
        }
      } else {
        body = fillMissingMetadataUserId(body, metadataUserId)
        const result = planAnthropicCacheMarkers(body, cacheOptions)
        planned = result.body
        cacheDiagnostic = result.diagnostics
      }

      // Build keepalive body from markers
      let keepaliveBody = null
      let keepaliveSessionKey = null
      if (cacheDiagnostic?.markers?.length >= 3) {
        keepaliveBody = truncateAnthropicBodyForKeepalive(planned, cacheDiagnostic.markers)
        keepaliveSessionKey = cacheDiagnostic.markers[0]?.prefix_hash ?? null
      }

      if (!bypassCachePlanning) {
        bodyBuffer = Buffer.from(JSON.stringify(planned))
      }

      const upstreamUrl = `${upstreamBaseUrl.replace(/\/$/, "")}/v1/messages`
      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: forwardHeaders(request, bodyBuffer.length, apiKey, {
          userAgent: upstreamUserAgent,
        }),
        body: bodyBuffer,
      })

      response.writeHead(upstreamResponse.status, responseHeadersToObject(upstreamResponse.headers))

      if (!upstreamResponse.body) {
        response.end()
        recordOnce({ status: upstreamResponse.status })
        return
      }

      // Sliding-window sniff for usage extraction
      const nonStreamMaxSniffBytes = Math.max(usageSniffBytes, 2 * 1024 * 1024)
      let sniffBuf = Buffer.alloc(0)
      let sniffOverflowed = false
      const collect = async function* (source) {
        for await (const chunk of source) {
          if (isStream) {
            sniffBuf = Buffer.concat([sniffBuf, chunk])
            if (sniffBuf.length > usageSniffBytes) {
              sniffBuf = sniffBuf.subarray(sniffBuf.length - usageSniffBytes)
            }
          } else if (!sniffOverflowed) {
            const projected = sniffBuf.length + chunk.length
            if (projected > nonStreamMaxSniffBytes) {
              sniffOverflowed = true
              sniffBuf = Buffer.alloc(0)
            } else {
              sniffBuf = Buffer.concat([sniffBuf, chunk])
            }
          }
          yield chunk
        }
      }

      let pipelineError = null
      try {
        await pipeline(Readable.fromWeb(upstreamResponse.body), collect, response)
      } catch (err) {
        pipelineError = err
        throw err
      } finally {
        const extracted = sniffOverflowed
          ? { usage: null, request_id: null, stop_reason: null, stream_usage_seen: null }
          : extractAnthropicUsage({ buffer: sniffBuf, isStream })

        recordOnce({
          status: pipelineError ? 502 : upstreamResponse.status,
          usage: extracted.usage,
          request_id: extracted.request_id,
          stream_usage_seen: extracted.stream_usage_seen,
          proxy_error: pipelineError
            ? String(pipelineError.message || pipelineError)
            : sniffOverflowed
              ? "non_stream_body_exceeded_sniff_cap"
              : null,
        })

        if (!pipelineError && upstreamResponse.ok && keepaliveManager && keepaliveSessionKey && keepaliveBody) {
          keepaliveManager.registerHit({
            sessionKey: keepaliveSessionKey,
            pid: request.headers["x-opencode-pid"] ? Number(request.headers["x-opencode-pid"]) : null,
            truncatedBody: keepaliveBody,
            model: parsedModel,
            url: upstreamUrl,
            authHeader: request.headers["x-api-key"] || (apiKey ? apiKey : null),
          })
        }
      }
    } catch (err) {
      if (err.statusCode === 413) {
        writeProxyError(response, 413, { error: "payload_too_large", message: err.message })
        recordOnce({ status: 413, proxy_error: "payload_too_large" })
        return
      }
      logger.error?.(`anthropic-handler: ${err.stack || err}`)
      writeProxyError(response, 502, { error: "anthropic_proxy_failed", message: String(err.message || err) })
      recordOnce({ status: 502, proxy_error: String(err.message || err) })
    }
  }
}
