import assert from "node:assert/strict"
import { createServer } from "node:http"
import { describe, test } from "node:test"
import { gzipSync } from "node:zlib"

import { createBailianCacheProxy, NOOP_USAGE_RECORDER } from "../src/server.mjs"

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

describe("createBailianCacheProxy", () => {
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
            messages: [{ role: "user", content: "go" }],
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
