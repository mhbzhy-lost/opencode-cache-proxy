import assert from "node:assert/strict"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { describe, test } from "node:test"

import { createAnthropicHandler } from "../src/anthropic-handler.mjs"

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

const readText = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

const makeRequest = async (url, { method = "POST", headers = {}, body } = {}) => {
  const opts = { method, headers: { "content-type": "application/json", ...headers } }
  if (body !== undefined) opts.body = typeof body === "string" ? body : JSON.stringify(body)
  return fetch(url, opts)
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

describe("createAnthropicHandler", () => {
  test("bypass strategy forwards the original request body without mutation while recording usage", async () => {
    let receivedRawBody
    const upstream = createServer(async (request, response) => {
      receivedRawBody = await readText(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_bypass",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const records = []
    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: { cacheStrategy: "bypass", minCacheTokens: 1 },
      metadataUserId: "proxy-user",
      usageRecorder: { fireAndForget: (entry) => records.push(entry) },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    const rawBody = [
      "{",
      '"model":"claude-opus-4-6",',
      '"max_tokens":10,',
      '"system":[{"type":"text","text":"stable","cache_control":{"type":"ephemeral"}}],',
      '"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]',
      "}",
    ].join("\n")

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: { "x-api-key": "sk-user-key" },
          body: rawBody,
        },
      )

      assert.equal(response.status, 200)
      await response.json()
      assert.equal(receivedRawBody, rawBody)
      assert.equal(records.length, 1)
      assert.equal(records[0].cache_diagnostic.strategy, "anthropic-bypass")
      assert.equal(records[0].cache_diagnostic.forwarded_marker_count, 1)
      assert.equal(records[0].cache_diagnostic.marker_count, 0)
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("uses OpenCode provider control headers for Anthropic upstream config and strips them", async () => {
    let received
    const upstream = createServer(async (request, response) => {
      received = {
        url: request.url,
        xApiKey: request.headers["x-api-key"],
        controlHeader: request.headers["x-cache-proxy-upstream-base-url"],
        strategyHeader: request.headers["x-cache-proxy-cache-strategy"],
        rawBody: await readText(request),
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_provider_config",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: "http://127.0.0.1:9",
      cacheOptions: { cacheStrategy: "cache", minCacheTokens: 1 },
      metadataUserId: "constructor-user",
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    const rawBody = JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 10,
      system: [{ type: "text", text: "stable" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: {
            "x-api-key": "sk-client",
            "x-cache-proxy-upstream-base-url": `http://127.0.0.1:${upstreamAddress.port}`,
            "x-cache-proxy-cache-strategy": "bypass",
            "x-cache-proxy-metadata-user-id": "header-user",
          },
          body: rawBody,
        },
      )

      assert.equal(response.status, 200)
      assert.equal(received.url, "/v1/messages")
      assert.equal(received.xApiKey, "sk-client")
      assert.equal(received.controlHeader, undefined)
      assert.equal(received.strategyHeader, undefined)
      assert.equal(received.rawBody, rawBody)
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("rejects Anthropic upstream control headers from non-loopback clients", async () => {
    const handler = createAnthropicHandler({
      upstreamBaseUrl: "http://127.0.0.1:1",
      cacheOptions: { cacheStrategy: "cache", minCacheTokens: 1 },
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const request = mockRequest({
      url: "/apps/anthropic/v1/messages",
      remoteAddress: "203.0.113.10",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-client",
        "x-cache-proxy-upstream-base-url": "http://127.0.0.1:1",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    })
    const response = mockResponse()

    await handler(request, response)

    assert.equal(response.statusCode, 403)
    assert.deepEqual(JSON.parse(response.body), { error: "forbidden_proxy_control_header" })
  })

  test("forwards request with cache markers added, returns upstream response, records usage with protocol anthropic", async () => {
    let received
    const upstream = createServer(async (request, response) => {
      received = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readJson(request),
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_test123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "claude-sonnet-4-20250514",
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const records = []
    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-fallback",
      cacheOptions: { minCacheTokens: 16 },
      usageRecorder: { fireAndForget: (entry) => records.push(entry) },
      logger: { error: () => {} },
    })

    // Create a proxy server that routes to the handler
    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: { "x-api-key": "sk-user-key", "anthropic-version": "2023-06-01" },
          body: {
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: [{ type: "text", text: "stable system ".repeat(120) }],
            messages: [
              { role: "user", content: [{ type: "text", text: "Hello" }] },
            ],
          },
        },
      )

      assert.equal(response.status, 200)
      const responseBody = await response.json()
      assert.equal(responseBody.id, "msg_test123")

      // Verify upstream received the request with cache markers
      assert.equal(received.method, "POST")
      assert.equal(received.url, "/v1/messages")
      assert.equal(received.headers["x-api-key"], "sk-user-key")
      assert.equal(received.headers["anthropic-version"], "2023-06-01")
      // The system block should have a cache_control marker
      assert.deepEqual(received.body.system[0].cache_control, { type: "ephemeral" })

      // Verify usage record
      assert.equal(records.length, 1)
      const record = records[0]
      assert.equal(record.protocol, "anthropic")
      assert.equal(record.model, "claude-sonnet-4-20250514")
      assert.equal(record.status, 200)
      assert.equal(record.is_stream, false)
      assert.equal(record.input_tokens, 100)
      assert.equal(record.output_tokens, 5)
      assert.equal(record.cache_read_input_tokens, 800)
      assert.equal(record.cache_creation_input_tokens, 0)
      assert.equal(record.request_id, "msg_test123")
      assert.equal(record.proxy_error, null)
      // cache_hit_ratio = 800 / (100 + 800 + 0) = 0.8889
      assert.equal(record.cache_hit_ratio, 0.8889)
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("fills missing metadata.user_id in cache mode when configured", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_metadata_user",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-4-6",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: { minCacheTokens: 1 },
      metadataUserId: "opencode-cache-user",
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          body: {
            model: "claude-opus-4-6",
            max_tokens: 10,
            metadata: { trace_id: "trace-1" },
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )

      assert.equal(response.status, 200)
      assert.deepEqual(receivedBody.metadata, {
        trace_id: "trace-1",
        user_id: "opencode-cache-user",
      })
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("preserves existing metadata.user_id in cache mode", async () => {
    let receivedBody
    const upstream = createServer(async (request, response) => {
      receivedBody = await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_existing_metadata_user",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-4-6",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: { minCacheTokens: 1 },
      metadataUserId: "proxy-user",
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          body: {
            model: "claude-opus-4-6",
            max_tokens: 10,
            metadata: { user_id: "client-user" },
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )

      assert.equal(response.status, 200)
      assert.equal(receivedBody.metadata.user_id, "client-user")
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("uses fallback apiKey when x-api-key not in request headers", async () => {
    let receivedHeaders
    const upstream = createServer(async (request, response) => {
      receivedHeaders = request.headers
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_fallback",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-fallback-key",
      cacheOptions: {},
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          // No x-api-key header
          body: {
            model: "claude-sonnet-4-20250514",
            max_tokens: 10,
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )

      assert.equal(response.status, 200)
      await response.json()
      assert.equal(receivedHeaders["x-api-key"], "sk-fallback-key")
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("overrides upstream user-agent when configured", async () => {
    let receivedHeaders
    const upstream = createServer(async (request, response) => {
      receivedHeaders = request.headers
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_user_agent",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-opus-4-6",
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: { cacheStrategy: "bypass" },
      upstreamUserAgent: "claude-cli/test (external, sdk-cli)",
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: {
            "x-api-key": "sk-user",
            "user-agent": "opencode/1.15.10",
          },
          body: {
            model: "claude-opus-4-6",
            max_tokens: 10,
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )

      assert.equal(response.status, 200)
      assert.equal(receivedHeaders["user-agent"], "claude-cli/test (external, sdk-cli)")
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("returns 404 for non-messages paths", async () => {
    const handler = createAnthropicHandler({
      upstreamBaseUrl: "http://127.0.0.1:1",
      apiKey: "",
      cacheOptions: {},
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/models`,
        { method: "GET" },
      )
      assert.equal(response.status, 404)
      const body = await response.json()
      assert.equal(body.error, "not_found")
    } finally {
      await close(proxy)
    }
  })

  test("returns 405 for non-POST requests to messages endpoint", async () => {
    const handler = createAnthropicHandler({
      upstreamBaseUrl: "http://127.0.0.1:1",
      apiKey: "",
      cacheOptions: {},
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        { method: "GET" },
      )
      assert.equal(response.status, 405)
      const body = await response.json()
      assert.equal(body.error, "method_not_allowed")
    } finally {
      await close(proxy)
    }
  })

  test("records usage from streaming response", async () => {
    const upstream = createServer(async (request, response) => {
      await readJson(request)
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","usage":{"input_tokens":50,"cache_read_input_tokens":400,"cache_creation_input_tokens":0}}}\n\n')
      response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n')
      response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n')
      response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      response.end()
    })
    const upstreamAddress = await listen(upstream)

    const records = []
    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: {},
      usageRecorder: { fireAndForget: (entry) => records.push(entry) },
      logger: { error: () => {} },
    })

    const proxy = createServer((req, res) => handler(req, res))
    const proxyAddress = await listen(proxy)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: { "x-api-key": "sk-user" },
          body: {
            model: "claude-sonnet-4-20250514",
            max_tokens: 100,
            stream: true,
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )
      assert.equal(response.status, 200)
      // Drain stream
      const reader = response.body.getReader()
      while (!(await reader.read()).done) {}

      assert.equal(records.length, 1)
      const record = records[0]
      assert.equal(record.protocol, "anthropic")
      assert.equal(record.is_stream, true)
      assert.equal(record.stream_usage_seen, true)
      assert.equal(record.input_tokens, 50)
      assert.equal(record.output_tokens, 3)
      assert.equal(record.cache_read_input_tokens, 400)
      assert.equal(record.request_id, "msg_stream")
      // cache_hit_ratio = 400 / (50 + 400 + 0) = 0.8889
      assert.equal(record.cache_hit_ratio, 0.8889)
    } finally {
      await close(proxy)
      await close(upstream)
    }
  })

  test("routes via server.mjs anthropicHandler option", async () => {
    // Import the full proxy to verify integration
    const { createBailianCacheProxy } = await import("../src/server.mjs")

    let upstreamCalled = false
    const upstream = createServer(async (request, response) => {
      upstreamCalled = true
      await readJson(request)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "msg_routed",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "routed" }],
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }))
    })
    const upstreamAddress = await listen(upstream)

    const handler = createAnthropicHandler({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      apiKey: "sk-test",
      cacheOptions: {},
      usageRecorder: { fireAndForget: () => {} },
      logger: { error: () => {} },
    })

    const { server } = createBailianCacheProxy({
      upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/compatible-mode/v1`,
      lifecycle: false,
      anthropicHandler: handler,
    })
    const proxyAddress = await listen(server)

    try {
      const response = await makeRequest(
        `http://127.0.0.1:${proxyAddress.port}/apps/anthropic/v1/messages`,
        {
          headers: { "x-api-key": "sk-user" },
          body: {
            model: "claude-sonnet-4-20250514",
            max_tokens: 10,
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
          },
        },
      )

      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.id, "msg_routed")
      assert.equal(upstreamCalled, true)
    } finally {
      await close(server)
      await close(upstream)
    }
  })
})
