import assert from "node:assert/strict"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { describe, test } from "node:test"
import { gzipSync } from "node:zlib"

import {
  createBailianCacheProxy,
  NOOP_USAGE_RECORDER,
  resolveDefaultApiKey,
} from "../src/server.mjs"

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address()))
  })

const close = (server) => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))

const readJson = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

const mockRequest = ({ method = "POST", url, headers = {}, body = "", remoteAddress = "127.0.0.1" }) => {
  const request = Readable.from(body ? [Buffer.from(body)] : [])
  request.method = method
  request.url = url
  request.headers = headers
  request.socket = { remoteAddress }
  return request
}

const mockResponse = () => {
  const chunks = []
  let resolve
  const response = {
    destroyed: false,
    headersSent: false,
    statusCode: null,
    headers: null,
    done: new Promise((done) => {
      resolve = done
    }),
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode
      this.headers = headers
      this.headersSent = true
      return this
    },
    end(chunk = "") {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.body = Buffer.concat(chunks).toString("utf8")
      resolve(this)
    },
    destroy() {
      this.destroyed = true
      resolve(this)
    },
  }
  return response
}

describe("createBailianCacheProxy", () => {
  test("default lifecycle does not idle-exit the proxy", async () => {
    let idleExitCalled = false
    let closed = false
    const proxy = createBailianCacheProxy({
      lifecycleCheckMs: 10,
      onIdleExit: () => {
        idleExitCalled = true
      },
    })
    proxy.server.on("close", () => {
      closed = true
    })
    await listen(proxy.server)

    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(idleExitCalled, false)
      assert.equal(closed, false)
    } finally {
      if (!closed) await close(proxy.server)
    }
  })

  test("idleExitMs=0 disables lifecycle idle exit", async () => {
    let idleExitCalled = false
    let closed = false
    const proxy = createBailianCacheProxy({
      idleExitMs: 0,
      lifecycleCheckMs: 10,
      onIdleExit: () => {
        idleExitCalled = true
      },
    })
    proxy.server.on("close", () => {
      closed = true
    })
    await listen(proxy.server)

    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(idleExitCalled, false)
      assert.equal(closed, false)
    } finally {
      if (!closed) await close(proxy.server)
    }
  })

  test("registers and unregisters OpenCode pids through lifecycle control endpoints", async () => {
    const proxy = createBailianCacheProxy({ lifecycle: false })
    const proxyAddress = await listen(proxy.server)

    try {
      const register = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/__bailian_cache_proxy/register`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pid: process.pid }),
        },
      )
      assert.equal(register.status, 200)
      const registered = await register.json()
      assert.deepEqual(registered.activePids, [process.pid])

      const unregister = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/__bailian_cache_proxy/unregister`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pid: process.pid }),
        },
      )
      assert.equal(unregister.status, 200)
      const unregistered = await unregister.json()
      assert.deepEqual(unregistered.activePids, [])
    } finally {
      await close(proxy.server)
    }
  })

  test("injects cache markers and forwards authorization to Bailian upstream", async () => {
    let received
    const upstream = createServer(async (request, response) => {
      received = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: await readJson(request),
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-test", choices: [] }))
    })
    const upstreamAddress = await listen(upstream)

    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      cacheOptions: { minCacheTokens: 16 },
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            messages: [
              { role: "system", content: "stable ".repeat(120) },
              { role: "user", content: "go" },
            ],
          }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(received.method, "POST")
      assert.equal(received.url, "/compatible-mode/v1/chat/completions")
      assert.equal(received.authorization, "Bearer sk-test")
      assert.deepEqual(received.body.messages[0].content[0].cache_control, { type: "ephemeral" })
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("uses OpenCode provider control headers for upstream routing without forwarding them", async () => {
    let received
    const upstream = createServer(async (request, response) => {
      received = {
        url: request.url,
        authorization: request.headers.authorization,
        controlHeader: request.headers["x-cache-proxy-upstream-base-url"],
        markerHeader: request.headers["x-cache-proxy-marker-strategy"],
        body: await readJson(request),
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-provider-config", choices: [] }))
    })
    const upstreamAddress = await listen(upstream)

    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: "http://127.0.0.1:9/compatible-mode/v1",
      cacheOptions: { minCacheTokens: 16 },
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-client",
            "content-type": "application/json",
            "x-cache-proxy-upstream-base-url": `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
            "x-cache-proxy-marker-strategy": "fraction",
          },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            messages: [
              { role: "system", content: "stable ".repeat(120) },
              { role: "user", content: "go" },
            ],
          }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(received.url, "/compatible-mode/v1/chat/completions")
      assert.equal(received.authorization, "Bearer sk-client")
      assert.equal(received.controlHeader, undefined)
      assert.equal(received.markerHeader, undefined)
      assert.equal(received.body.model, "qwen3.6-plus")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("rejects upstream control headers from non-loopback clients", async () => {
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: "http://127.0.0.1:1/compatible-mode/v1",
      cacheOptions: { minCacheTokens: 16 },
      lifecycle: false,
      logger: { error: () => {} },
    })

    const request = mockRequest({
      url: "/compatible-mode/v1/chat/completions",
      remoteAddress: "203.0.113.10",
      headers: {
        authorization: "Bearer sk-client",
        "content-type": "application/json",
        "x-cache-proxy-upstream-base-url": "http://127.0.0.1:1/compatible-mode/v1",
      },
      body: JSON.stringify({
        model: "qwen3.6-plus",
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const response = mockResponse()

    proxy.server.emit("request", request, response)
    await response.done

    assert.equal(response.statusCode, 403)
    assert.deepEqual(JSON.parse(response.body), { error: "forbidden_proxy_control_header" })
  })

  test("resolveDefaultApiKey reads OPENAI_COMPATIBLE_API_KEY", () => {
    assert.equal(
      resolveDefaultApiKey({ OPENAI_COMPATIBLE_API_KEY: "sk-test" }),
      "sk-test",
    )
    assert.equal(resolveDefaultApiKey({}), "")
  })

  test("accepts Qwen Code style /v1 chat-completions path for compatible-mode upstreams", async () => {
    let receivedUrl
    const upstream = createServer(async (request, response) => {
      receivedUrl = request.url
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-qwen-path", choices: [] }))
    })
    const upstreamAddress = await listen(upstream)

    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3-coder-plus",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(receivedUrl, "/compatible-mode/v1/chat/completions")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("does not forward hop-by-hop or proxy headers", async () => {
    let receivedHeaders
    const upstream = createServer(async (request, response) => {
      receivedHeaders = request.headers
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ ok: true }))
    })
    const upstreamAddress = await listen(upstream)
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test",
            connection: "keep-alive",
            "proxy-authorization": "Bearer proxy-secret",
            te: "trailers",
            trailer: "x-debug",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "qwen3.6-plus", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(receivedHeaders.authorization, "Bearer sk-test")
      assert.equal(receivedHeaders["proxy-authorization"], undefined)
      assert.equal(receivedHeaders.te, undefined)
      assert.equal(receivedHeaders.trailer, undefined)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("rejects oversized request bodies before forwarding", async () => {
    let upstreamCalled = false
    const upstream = createServer((request, response) => {
      upstreamCalled = true
      response.writeHead(200)
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      maxBodyBytes: 64,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            messages: [{ role: "user", content: "x".repeat(200) }],
          }),
        },
      )

      assert.equal(response.status, 413)
      assert.equal(upstreamCalled, false)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("rejects compressed JSON requests before parsing", async () => {
    let upstreamCalled = false
    const upstream = createServer((request, response) => {
      upstreamCalled = true
      response.writeHead(200)
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
          },
          body: Buffer.from("not-gzip"),
        },
      )

      assert.equal(response.status, 415)
      assert.equal(upstreamCalled, false)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("strips transport-level response headers so client doesn't double-decode", async () => {
    // Regression for bug-bailian-proxy-content-encoding: undici fetch in the
    // proxy auto-decompresses upstream gzip; if we forward content-encoding
    // verbatim the client tries to gunzip the already-plain body and aborts.
    const payload = JSON.stringify({ ok: true, usage: { prompt_tokens: 7 } })
    const gzipped = gzipSync(Buffer.from(payload))
    const upstream = createServer(async (request, response) => {
      await readJson(request)
      // Mix of transport-level + business headers. transfer-encoding/trailer
      // are not asserted: combining them with content-length is a protocol
      // violation that either undici fetch or Node http server refuses. The
      // strip set still covers them via HOP_BY_HOP_HEADERS by source
      // inspection.
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(gzipped.length),
        "connection": "close",
        "proxy-authenticate": "Basic realm=upstream",
        "x-request-id": "trace-123",
      })
      response.end(gzipped)
    })
    const upstreamAddress = await listen(upstream)
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer sk-test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "qwen3.6-flash", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      // Transport-level headers must be stripped; client should never see
      // upstream's encoding/length/hop-by-hop signals.
      for (const stripped of [
        "content-encoding",
        "content-length",
        "proxy-authenticate",
      ]) {
        assert.equal(
          response.headers.get(stripped),
          null,
          `expected ${stripped} to be stripped`,
        )
      }
      // Business headers from upstream must be preserved.
      assert.equal(response.headers.get("x-request-id"), "trace-123")
      const body = await response.json()
      assert.deepEqual(body, { ok: true, usage: { prompt_tokens: 7 } })
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("records usage for non-streaming completions via the recorder", async () => {
    const upstream = createServer(async (request, response) => {
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "chatcmpl-non-stream",
          usage: {
            prompt_tokens: 200,
            completion_tokens: 5,
            prompt_tokens_details: {
              cached_tokens: 150,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      )
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget(entry) {
          records.push(entry)
        },
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sk-test",
          },
          body: JSON.stringify({
            model: "qwen3.6-flash",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )
      assert.equal(response.status, 200)
      await response.json()

      assert.equal(records.length, 1)
      const record = records[0]
      assert.equal(record.model, "qwen3.6-flash")
      assert.equal(record.is_stream, false)
      assert.equal(record.stream_usage_seen, null)
      assert.equal(record.prompt_tokens, 200)
      assert.equal(record.cached_tokens, 150)
      assert.equal(record.cache_hit_ratio, 0.75)
      assert.equal(record.request_id, "chatcmpl-non-stream")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("injects stream_options.include_usage and records usage from SSE", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write(
        'data: {"id":"chatcmpl-stream","choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n',
      )
      response.write(
        'data: {"id":"chatcmpl-stream","choices":[],"usage":{"prompt_tokens":300,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":288,"cache_creation_input_tokens":0}}}\n\n',
      )
      response.write("data: [DONE]\n\n")
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sk-test",
          },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            stream: true,
            messages: [{ role: "user", content: "go ".repeat(5000) }],
          }),
        },
      )
      assert.equal(response.status, 200)
      // Drain so the upstream pipeline finishes and finally fires.
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {
        // discard
      }

      assert.equal(receivedBody.stream_options.include_usage, true)
      assert.equal(records.length, 1)
      const record = records[0]
      assert.equal(record.is_stream, true)
      assert.equal(record.stream_usage_seen, true)
      assert.equal(record.model, "qwen3.6-plus")
      assert.equal(record.prompt_tokens, 300)
      assert.equal(record.cached_tokens, 288)
      assert.equal(record.cache_hit_ratio, 0.96)
      assert.equal(record.request_id, "chatcmpl-stream")
      assert.equal(record.cache_diagnostic.version, 1)
      assert.match(record.cache_diagnostic.messages_hash, /^[a-f0-9]{16}$/)
      assert.equal(record.cache_diagnostic.marker_count, 1)
      assert.equal(record.cache_diagnostic.markers.length, 1)
      assert.match(record.cache_diagnostic.markers[0].prefix_hash, /^[a-f0-9]{16}$/)
      assert.equal(JSON.stringify(record.cache_diagnostic).includes("go"), false)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("records a streaming entry with stream_usage_seen=false when upstream omits usage", async () => {
    const upstream = createServer(async (request, response) => {
      await readJson(request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write('data: {"id":"chatcmpl-no-usage","choices":[{"delta":{"content":"x"}}]}\n\n')
      response.write("data: [DONE]\n\n")
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-flash",
            stream: true,
            stream_options: { include_usage: false },
            messages: [{ role: "user", content: "x" }],
          }),
        },
      )
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {
        // drain
      }

      assert.equal(records.length, 1)
      assert.equal(records[0].is_stream, true)
      assert.equal(records[0].stream_usage_seen, false)
      assert.equal(records[0].cached_tokens, null)
      assert.equal(records[0].request_id, "chatcmpl-no-usage")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("records a failure entry when upstream fetch never reaches the pipeline", async () => {
    // Point the proxy at a port nothing is listening on; fetch should reject.
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: "http://127.0.0.1:1/compatible-mode/v1",
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
      logger: { error: () => {}, warn: () => {} },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-flash",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )
      assert.equal(response.status, 502)
      await response.json()

      assert.equal(records.length, 1, "fetch failure must still produce one record")
      assert.equal(records[0].status, 502)
      assert.equal(records[0].model, "qwen3.6-flash")
      assert.match(String(records[0].proxy_error), /(ECONNREFUSED|fetch failed|connect)/i)
    } finally {
      await close(proxy.server)
    }
  })

  test("captures usage from a non-streaming response larger than the sniff window", async () => {
    // Build a response whose JSON exceeds the default 64KB sliding window.
    // A naive sniffer that only retains the tail would lose the leading `{`
    // and JSON.parse would silently fail, yielding null usage.
    const fillerChoices = Array.from({ length: 800 }, (_, i) => ({
      index: i,
      message: { role: "assistant", content: "x".repeat(100) },
    }))
    const upstream = createServer(async (request, response) => {
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "chatcmpl-big",
          choices: fillerChoices,
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 600,
            prompt_tokens_details: {
              cached_tokens: 4900,
              cache_creation_input_tokens: 0,
            },
          },
        }),
      )
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageSniffBytes: 16 * 1024, // small window to force the would-be-truncated case
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-flash",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.choices.length, 800)

      assert.equal(records.length, 1)
      assert.equal(records[0].prompt_tokens, 5000)
      assert.equal(records[0].cached_tokens, 4900)
      assert.equal(records[0].request_id, "chatcmpl-big")
      assert.equal(records[0].proxy_error, null)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("records oversized request as 413 without contacting upstream", async () => {
    const upstreamCalls = []
    const upstream = createServer((request, response) => {
      upstreamCalls.push(request.url)
      response.writeHead(200)
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      maxBodyBytes: 64,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "qwen3.6-flash", messages: [{ role: "user", content: "x".repeat(200) }] }),
        },
      )
      assert.equal(response.status, 413)
      assert.equal(upstreamCalls.length, 0)
      assert.equal(records.length, 1)
      assert.equal(records[0].status, 413)
      assert.equal(records[0].proxy_error, "payload_too_large")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("rewrites -nothink alias to upstream model + enable_thinking=false", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          id: "chatcmpl-nothink",
          model: "qwen3.6-flash",
          usage: {
            prompt_tokens: 50,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 0 },
          },
        }),
      )
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-flash-nothink",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )
      assert.equal(response.status, 200)
      await response.json()

      // Upstream sees the real model + the injected override.
      assert.equal(receivedBody.model, "qwen3.6-flash")
      assert.equal(receivedBody.enable_thinking, false)

      // Usage record keeps the user-facing alias so cache-stats can group by
      // -nothink vs default cohort.
      assert.equal(records.length, 1)
      assert.equal(records[0].model, "qwen3.6-flash-nothink")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("non-JSON body bypasses transforms but still forwards (proxy doesn't crash)", async () => {
    // Edge case raised by external review: when content-type is not JSON,
    // shouldTransformChatBody is false. We must still forward the request
    // (let upstream return its own 400/415) without crashing or silently
    // dropping the request. The alias rewrite obviously cannot fire — there
    // is no JSON body to parse a model field out of.
    let receivedContentType
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedContentType = request.headers["content-type"]
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      receivedBody = Buffer.concat(chunks).toString("utf8")
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "Bad Request" }))
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "model: qwen3.6-flash-nothink\nthis is not JSON",
        },
      )
      assert.equal(response.status, 400)
      assert.equal(receivedContentType, "text/plain")
      assert.match(receivedBody, /qwen3.6-flash-nothink/, "body forwarded verbatim")
      assert.equal(records.length, 1, "still records the request")
      // model is null because we never parsed the body
      assert.equal(records[0].model, null)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("plain alias passes upstream untouched (no enable_thinking injected)", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-plain", model: "qwen3.6-flash", usage: {} }))
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.6-flash",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )

      assert.equal(receivedBody.model, "qwen3.6-flash")
      assert.equal(
        Object.prototype.hasOwnProperty.call(receivedBody, "enable_thinking"),
        false,
        "must NOT inject enable_thinking for plain alias",
      )
      assert.equal(records[0].model, "qwen3.6-flash")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("rewrites qwen3.7-max context aliases to the upstream model", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-qwen-context", model: "qwen3.7-max", usage: {} }))
    })
    const upstreamAddress = await listen(upstream)
    const records = []
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      usageRecorder: {
        fireAndForget: (entry) => records.push(entry),
        record: async () => {},
        filePath: "<test>",
      },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "qwen3.7-max-300k",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      )

      assert.equal(receivedBody.model, "qwen3.7-max")
      assert.equal(
        Object.prototype.hasOwnProperty.call(receivedBody, "enable_thinking"),
        false,
        "must NOT inject enable_thinking for context-only aliases",
      )
      assert.equal(records[0].model, "qwen3.7-max-300k")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("NOOP_USAGE_RECORDER is frozen and never throws", () => {
    // The exported no-op must be safe to share across the whole test suite
    // and any future caller that doesn't want stats persisted.
    assert.equal(Object.isFrozen(NOOP_USAGE_RECORDER), true)
    assert.doesNotThrow(() =>
      NOOP_USAGE_RECORDER.fireAndForget({ ts: "x", model: "y" }),
    )
    return NOOP_USAGE_RECORDER.record({ ts: "x" }) // returns a promise that resolves
  })

  test("server.mjs defaults usageRecorder to NOOP, not a live filesystem recorder", async () => {
    // Regression: the previous default was createUsageRecorder({...}), which
    // appended to ~/.cache/bailian-cache-proxy/usage.jsonl whenever a unit
    // test forgot to inject a mock. Verify by source inspection — this is
    // the cheapest way to catch a future revert without spying on fs.
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const serverSrc = readFileSync(join(here, "..", "src", "server.mjs"), "utf8")
    assert.match(
      serverSrc,
      /usageRecorder\s*=\s*NOOP_USAGE_RECORDER/,
      "createBailianCacheProxy must default usageRecorder to NOOP_USAGE_RECORDER",
    )
    assert.doesNotMatch(
      serverSrc,
      /usageRecorder\s*=\s*createUsageRecorder\(/,
      "src/server.mjs must NOT default usageRecorder to a live createUsageRecorder()",
    )
  })

  test("bin/bailian-cache-proxy.mjs is the only place that opts into a live usage recorder", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const binSrc = readFileSync(join(here, "..", "bin", "bailian-cache-proxy.mjs"), "utf8")
    assert.match(
      binSrc,
      /createUsageRecorder\(/,
      "production entrypoint must explicitly construct a real recorder",
    )
    assert.match(
      binSrc,
      /usageRecorder\s*[,}]/,
      "production entrypoint must pass usageRecorder into createBailianCacheProxy",
    )
    assert.doesNotMatch(
      binSrc,
      /loadEnvFile|envPath|proxy-local \.env|\.env present|\.env at/,
      "OpenCode production proxy entrypoint must not load proxy-local .env",
    )
    assert.doesNotMatch(
      binSrc,
      new RegExp(["BAILIAN", "CACHE_PROXY_ANTHROPIC_"].join("_")),
      "Anthropic-specific env vars must not be provider-prefixed",
    )
    assert.doesNotMatch(
      binSrc,
      /dashscope\.aliyuncs\.com\/apps\/anthropic/,
      "Anthropic route must not default to a platform-specific relay",
    )
  })

  test(".env.example does not ship a shared Anthropic metadata.user_id", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { dirname, join } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const envExample = readFileSync(join(here, "..", ".env.example"), "utf8")

    assert.doesNotMatch(
      envExample,
      /^#?\s*ANTHROPIC_CACHE_PROXY_METADATA_USER_ID=opencode-cache-proxy\b/m,
      "example config must not include a reusable shared metadata.user_id",
    )
  })

  test("keepalive: arms on successful chat request and fires exactly once when session idles past threshold", async () => {
    let clock = 1_000_000
    const upstreamBodies = []
    const pings = []
    const upstream = createServer(async (request, response) => {
      upstreamBodies.push(await readJson(request))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ id: "chatcmpl-keepalive", choices: [] }))
    })
    const upstreamAddress = await listen(upstream)

    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      cacheOptions: {
        minCacheTokens: 512,
        keepalive: {
          enabled: true,
          thresholdMs: 270_000,
          scanIntervalMs: 50,
          minHits: 1,
        },
      },
      keepaliveHooks: {
        onKeepaliveSent: (info) => pings.push(info),
      },
      lifecycle: false,
      now: () => clock,
      logger: { error: () => {}, warn: () => {} },
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer sk-keep",
            "x-opencode-pid": String(process.pid),
          },
          body: JSON.stringify({
            model: "qwen3.6-plus",
            messages: [
              { role: "system", content: "x".repeat(8000) },
              { role: "user", content: "turn 1 question" },
              { role: "assistant", content: "turn 1 reply ".repeat(100) },
              { role: "user", content: "turn 2 question" },
              { role: "assistant", content: "turn 2 reply ".repeat(100) },
              { role: "user", content: "final question ".repeat(300) },
            ],
          }),
        },
      )
      assert.equal(response.status, 200)
      await response.json()

      await new Promise((r) => setTimeout(r, 100))

      clock += 300_000

      await new Promise((r) => setTimeout(r, 400))

      const keepaliveBodies = upstreamBodies.filter((b) => b._keepalive === true)
      assert.equal(keepaliveBodies.length, 1, "exactly one keepalive request sent upstream")
      assert.equal(keepaliveBodies[0].stream, false, "keepalive is not streaming")
      assert.equal(keepaliveBodies[0].max_tokens, 1, "keepalive uses max_tokens=1")
      assert.equal(pings.length, 1, "onKeepaliveSent hook fired exactly once")
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })

  test("only forwards chat completions paths to Bailian", async () => {
    let upstreamCalled = false
    const upstream = createServer((request, response) => {
      upstreamCalled = true
      response.writeHead(200)
      response.end()
    })
    const upstreamAddress = await listen(upstream)
    const proxy = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
    })
    const proxyAddress = await listen(proxy.server)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/compatible-mode/v1/models`,
        {
          method: "GET",
        },
      )

      assert.equal(response.status, 404)
      assert.equal(upstreamCalled, false)
    } finally {
      await close(proxy.server)
      await close(upstream)
    }
  })
})
