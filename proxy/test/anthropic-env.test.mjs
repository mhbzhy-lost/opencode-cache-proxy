import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DEFAULT_CLAUDE_COMPAT_USER_AGENT,
  resolveAnthropicMetadataUserId,
  resolveAnthropicUpstreamUserAgent,
} from "../src/anthropic-env.mjs"

describe("resolveAnthropicUpstreamUserAgent", () => {
  test("does not attach a Claude-compatible identity by default", () => {
    assert.equal(resolveAnthropicUpstreamUserAgent({}), "")
    assert.equal(
      resolveAnthropicUpstreamUserAgent({
        ANTHROPIC_CACHE_PROXY_USER_AGENT: "claude-cli/custom",
      }),
      "",
    )
  })

  test("uses the default Claude-compatible user-agent only when enabled", () => {
    assert.equal(
      resolveAnthropicUpstreamUserAgent({
        ANTHROPIC_CACHE_PROXY_CLAUDE_COMPAT: "1",
      }),
      DEFAULT_CLAUDE_COMPAT_USER_AGENT,
    )
  })

  test("allows customizing the Claude-compatible user-agent", () => {
    assert.equal(
      resolveAnthropicUpstreamUserAgent({
        ANTHROPIC_CACHE_PROXY_CLAUDE_COMPAT: "true",
        ANTHROPIC_CACHE_PROXY_USER_AGENT: "claude-cli/test (external, sdk-cli)",
      }),
      "claude-cli/test (external, sdk-cli)",
    )
  })
})

describe("resolveAnthropicMetadataUserId", () => {
  test("does not inject metadata.user_id by default", () => {
    assert.equal(resolveAnthropicMetadataUserId({}), "")
  })

  test("returns a trimmed metadata.user_id override when configured", () => {
    assert.equal(
      resolveAnthropicMetadataUserId({
        ANTHROPIC_CACHE_PROXY_METADATA_USER_ID: "  opencode-cache-user  ",
      }),
      "opencode-cache-user",
    )
  })
})
