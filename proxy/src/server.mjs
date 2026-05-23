import { createServer } from "node:http"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { planBailianCacheMarkers } from "./cache-planner.mjs"
import { createLifecycleTracker } from "./lifecycle.mjs"
import { applyThinkModeRewrite } from "./think-mode-rewriter.mjs"
import { ensureStreamUsageOption, extractUsage } from "./usage-extractor.mjs"
import { buildUsageRecord, createUsageRecorder } from "./usage-recorder.mjs"

const DEFAULT_UPSTREAM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const DEFAULT_IDLE_EXIT_MS = 60_000
const DEFAULT_LIFECYCLE_CHECK_MS = 5_000
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
// Cap how many response bytes we retain for usage extraction. SSE usage frames
// land in the tail; capping bounds memory regardless of conversation length.
const DEFAULT_USAGE_SNIFF_BYTES = 64 * 1024
const CONTROL_PREFIX = "/__bailian_cache_proxy"
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

// undici fetch transparently decompresses upstream gzip/br/deflate bodies, so
// any content-encoding/content-length we copy verbatim would mismatch the
// already-decoded bytes we pipe back. Strip transport-level headers and let
// Node http re-frame the response (chunked, no encoding).
const RESPONSE_STRIP_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "content-encoding",
  "content-length",
])

const readBody = async (request, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) => {
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

const responseHeadersToObject = (headers) => {
  const result = {}
  for (const [key, value] of headers.entries()) {
    if (RESPONSE_STRIP_HEADERS.has(key.toLowerCase())) continue
    result[key] = value
  }
  return result
}

const buildUpstreamUrl = (requestUrl, upstreamBaseUrl) => {
  const incoming = new URL(requestUrl, "http://127.0.0.1")
  const upstreamBase = new URL(upstreamBaseUrl)
  const upstreamPath = upstreamBase.pathname.replace(/\/$/, "")
  let requestPath = incoming.pathname

  if (requestPath.startsWith(upstreamPath)) {
    requestPath = requestPath.slice(upstreamPath.length)
  }
  if (!requestPath.startsWith("/")) requestPath = `/${requestPath}`

  return new URL(`${upstreamPath}${requestPath}${incoming.search}`, upstreamBase.origin)
}

const isJsonContent = (request) => {
  const contentType = request.headers["content-type"] || ""
  return contentType.toLowerCase().includes("application/json")
}

// True iff the proxy can safely parse the request body and apply our chain of
// transforms (alias rewrite + cache marker plan + stream_options.include_usage
// injection). All three transforms require a parsed JSON body, so they share
// a single gate. Non-POST / non-JSON / non chat-completions requests fall
// through untransformed and are forwarded verbatim — including any
// alias-bearing model name they may carry. That is the correct posture: with
// no JSON body we have no model field to rewrite anyway, and the upstream
// will return a clean 400 if the alias is invalid for it.
const shouldTransformChatBody = (request) =>
  request.method === "POST" &&
  isJsonContent(request) &&
  new URL(request.url, "http://127.0.0.1").pathname.endsWith("/chat/completions")

const isAllowedUpstreamPath = (request) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname
  return pathname.endsWith("/chat/completions")
}

const hasUnsupportedContentEncoding = (request) => {
  const encoding = request.headers["content-encoding"]
  return Boolean(encoding && String(encoding).toLowerCase() !== "identity")
}

const forwardHeaders = (request, bodyLength, apiKey) => {
  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    const lowerKey = key.toLowerCase()
    if (lowerKey === "host" || lowerKey === "content-length") continue
    if (lowerKey === "content-encoding") continue
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) continue
    headers[key] = value
  }
  headers["content-length"] = String(bodyLength)
  if (!headers.authorization && apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

const handleHeartbeat = async (request, response, tracker) => {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed" })
    return
  }

  try {
    const body = JSON.parse((await readBody(request)).toString("utf8"))
    tracker.register(body.pid)
    writeJson(response, 200, { ok: true, activePids: tracker.activePids() })
  } catch (err) {
    writeJson(response, 400, { error: "invalid_heartbeat", message: String(err.message || err) })
  }
}

const writeProxyError = (response, statusCode, body) => {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  writeJson(response, statusCode, body)
}

// Used as the default usage recorder to avoid silently writing to the user's
// real ~/.cache/bailian-cache-proxy/usage.jsonl when callers don't explicitly
// opt in. The production entrypoint (bin/bailian-cache-proxy.mjs) constructs
// a real recorder via createUsageRecorder(); unit tests either pass their own
// mock or get this no-op so they never pollute the user's stats data.
export const NOOP_USAGE_RECORDER = Object.freeze({
  fireAndForget: () => {},
  record: async () => {},
  filePath: null,
})

export const createBailianCacheProxy = ({
  upstreamBaseUrl = DEFAULT_UPSTREAM_BASE_URL,
  apiKey = process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "",
  cacheOptions = {},
  lifecycle = true,
  idleExitMs = DEFAULT_IDLE_EXIT_MS,
  lifecycleCheckMs = DEFAULT_LIFECYCLE_CHECK_MS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  onIdleExit = () => process.exit(0),
  logger = console,
  usageRecorder = NOOP_USAGE_RECORDER,
  usageSniffBytes = DEFAULT_USAGE_SNIFF_BYTES,
  now = () => Date.now(),
} = {}) => {
  const tracker = createLifecycleTracker()
  let lastActiveAt = Date.now()
  let lifecycleTimer

  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url, "http://127.0.0.1").pathname

    if (requestPath === `${CONTROL_PREFIX}/health`) {
      writeJson(response, 200, { ok: true, activePids: tracker.activePids() })
      return
    }

    if (requestPath === `${CONTROL_PREFIX}/heartbeat`) {
      await handleHeartbeat(request, response, tracker)
      lastActiveAt = Date.now()
      return
    }

    const requestStart = now()
    let parsedRequestModel = null
    let isStream = false
    let recorded = false
    const recordOnce = (overrides) => {
      if (recorded) return
      recorded = true
      usageRecorder.fireAndForget(
        buildUsageRecord({
          ts: new Date(requestStart).toISOString(),
          model: parsedRequestModel,
          duration_ms: now() - requestStart,
          is_stream: isStream,
          stream_usage_seen: false,
          usage: null,
          request_id: null,
          ...overrides,
        }),
      )
    }

    try {
      if (!isAllowedUpstreamPath(request)) {
        writeJson(response, 404, { error: "not_found" })
        recordOnce({ status: 404, proxy_error: "not_found" })
        return
      }
      if (hasUnsupportedContentEncoding(request)) {
        writeJson(response, 415, { error: "unsupported_content_encoding" })
        recordOnce({ status: 415, proxy_error: "unsupported_content_encoding" })
        return
      }

      let bodyBuffer = await readBody(request, maxBodyBytes)
      if (shouldTransformChatBody(request)) {
        const body = JSON.parse(bodyBuffer.toString("utf8"))
        // 1. Resolve OpenCode-facing model alias (e.g. qwen3.6-flash-nothink)
        //    to the real upstream model + any enable_thinking override BEFORE
        //    we plan cache markers; the cache planner only cares about the
        //    messages array and is alias-agnostic.
        const { body: rewrittenBody, alias } = applyThinkModeRewrite(body)
        // The alias is what the user picked in OpenCode — keep it on the
        // usage record so cache-stats can split -nothink vs default cohorts.
        parsedRequestModel = alias
        let planned = planBailianCacheMarkers(rewrittenBody, cacheOptions)
        // 2. Inject stream_options.include_usage so streaming responses still
        //    expose token usage in their trailing SSE frame. Without this,
        //    every OpenCode AI-SDK call (defaults to stream=true) would log
        //    no usage and the cache hit-rate dataset would be empty.
        planned = ensureStreamUsageOption(planned)
        isStream = planned?.stream === true
        bodyBuffer = Buffer.from(JSON.stringify(planned))
      }

      const upstreamResponse = await fetch(buildUpstreamUrl(request.url, upstreamBaseUrl), {
        method: request.method,
        headers: forwardHeaders(request, bodyBuffer.length, apiKey),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : bodyBuffer,
      })

      response.writeHead(upstreamResponse.status, responseHeadersToObject(upstreamResponse.headers))

      if (!upstreamResponse.body) {
        response.end()
        recordOnce({ status: upstreamResponse.status })
        return
      }

      // For streaming responses we only need the tail (usage SSE frame is at
      // the end), so a sliding window bounded by usageSniffBytes is enough.
      // For non-streaming responses the body is one JSON object — we MUST
      // accumulate the full body or JSON.parse will fail on the truncated
      // prefix when the response is larger than usageSniffBytes. Cap at
      // nonStreamMaxSniffBytes so a runaway response cannot OOM the proxy.
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
              // Body exceeded our non-stream sniff cap; usage will be missed
              // but we still forward the bytes to the client untouched.
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
          ? { usage: null, request_id: null, stream_usage_seen: null }
          : extractUsage({ buffer: sniffBuf, isStream })
        recordOnce({
          // A torn pipeline means the client did not receive a clean response,
          // so degrade the recorded status from 200 to 502 to keep the stats
          // honest even though writeHead has already flushed upstream's status.
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
      }
    } catch (err) {
      if (err.statusCode === 413) {
        writeProxyError(response, 413, { error: "payload_too_large", message: err.message })
        recordOnce({ status: 413, proxy_error: "payload_too_large" })
        return
      }
      logger.error?.(`bailian-cache-proxy: ${err.stack || err}`)
      writeProxyError(response, 502, { error: "bailian_proxy_failed", message: String(err.message || err) })
      // recordOnce is a no-op if the pipeline finally already wrote a record.
      recordOnce({ status: 502, proxy_error: String(err.message || err) })
    }
  })

  if (lifecycle) {
    lifecycleTimer = setInterval(() => {
      if (tracker.hasActiveParents()) {
        lastActiveAt = Date.now()
        return
      }
      if (Date.now() - lastActiveAt >= idleExitMs) {
        server.close(() => onIdleExit())
      }
    }, lifecycleCheckMs)
    lifecycleTimer.unref?.()
  }

  server.on("close", () => {
    if (lifecycleTimer) clearInterval(lifecycleTimer)
  })

  return { server, tracker }
}
