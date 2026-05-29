import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { extractProxyControlHeaders } from "../src/proxy-control-headers.mjs"

describe("extractProxyControlHeaders", () => {
  test("extracts known control headers and strips proxy-only headers", () => {
    const result = extractProxyControlHeaders({
      authorization: "Bearer sk-test",
      "x-api-key": "sk-anthropic",
      "x-cache-proxy-upstream-base-url": " https://upstream.example/v1 ",
      "x-cache-proxy-cache-strategy": " bypass ",
      "x-cache-proxy-marker-strategy": " fraction ",
      "x-cache-proxy-metadata-user-id": " user-1 ",
      "x-cache-proxy-upstream-user-agent": " claude-cli/test ",
      "x-cache-proxy-unknown": "drop-me",
    })

    assert.deepEqual(result.control, {
      upstreamBaseUrl: "https://upstream.example/v1",
      cacheStrategy: "bypass",
      markerStrategy: "fraction",
      metadataUserId: "user-1",
      upstreamUserAgent: "claude-cli/test",
    })
    assert.deepEqual(result.headers, {
      authorization: "Bearer sk-test",
      "x-api-key": "sk-anthropic",
    })
  })

  test("ignores blank control header values", () => {
    const result = extractProxyControlHeaders({
      authorization: "Bearer sk-test",
      "x-cache-proxy-upstream-base-url": "   ",
      "x-cache-proxy-cache-strategy": "",
    })

    assert.deepEqual(result.control, {})
    assert.deepEqual(result.headers, { authorization: "Bearer sk-test" })
  })
})
