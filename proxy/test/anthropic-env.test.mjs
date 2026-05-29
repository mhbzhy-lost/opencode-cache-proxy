import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { DEFAULT_CLAUDE_COMPAT_USER_AGENT } from "../src/anthropic-env.mjs"

const here = dirname(fileURLToPath(import.meta.url))

describe("Anthropic provider identity constants", () => {
  test("keeps a fixed Claude-compatible user-agent without env switches", async () => {
    assert.equal(DEFAULT_CLAUDE_COMPAT_USER_AGENT, "claude-cli/2.1.156 (external, sdk-cli)")

    const source = await readFile(join(here, "..", "src", "anthropic-env.mjs"), "utf8")
    assert.doesNotMatch(source, /process\.env|ANTHROPIC_CACHE_PROXY|resolveAnthropic/)
  })
})
