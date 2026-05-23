import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  applyThinkModeRewrite,
  resolveThinkMode,
} from "../src/think-mode-rewriter.mjs"

describe("resolveThinkMode", () => {
  test("plain alias has no override, upstreamModel == alias", () => {
    const r = resolveThinkMode("qwen3.6-flash")
    assert.equal(r.upstreamModel, "qwen3.6-flash")
    assert.equal(r.enableThinking, null)
    assert.equal(r.alias, "qwen3.6-flash")
  })

  test("-nothink alias strips suffix and forces enable_thinking=false", () => {
    const r = resolveThinkMode("qwen3.6-plus-nothink")
    assert.equal(r.upstreamModel, "qwen3.6-plus")
    assert.equal(r.enableThinking, false)
    assert.equal(r.alias, "qwen3.6-plus-nothink")
  })

  test("does NOT match models that merely contain 'nothink' in the middle", () => {
    const r = resolveThinkMode("nothink-special")
    assert.equal(r.upstreamModel, "nothink-special")
    assert.equal(r.enableThinking, null)
  })

  test("handles non-string / falsy model gracefully", () => {
    const r = resolveThinkMode(undefined)
    assert.equal(r.upstreamModel, undefined)
    assert.equal(r.enableThinking, null)
  })

  test("trims whitespace before suffix matching", () => {
    // A trailing space must NOT silently demote -nothink into the default
    // cohort and ship a fake model id upstream.
    const r = resolveThinkMode("qwen3.6-flash-nothink ")
    assert.equal(r.upstreamModel, "qwen3.6-flash")
    assert.equal(r.enableThinking, false)
    assert.equal(r.alias, "qwen3.6-flash-nothink")
  })

  test("trims whitespace from plain alias too", () => {
    const r = resolveThinkMode("  qwen3.6-flash  ")
    assert.equal(r.upstreamModel, "qwen3.6-flash")
    assert.equal(r.enableThinking, null)
  })
})

describe("applyThinkModeRewrite", () => {
  test("returns the body untouched for plain alias", () => {
    const body = { model: "qwen3.6-flash", messages: [{ role: "user", content: "hi" }] }
    const { body: out, alias } = applyThinkModeRewrite(body)
    assert.equal(out, body, "plain alias must be a no-op (same reference)")
    assert.equal(alias, "qwen3.6-flash")
  })

  test("strips -nothink suffix and injects enable_thinking=false", () => {
    const body = {
      model: "qwen3.6-flash-nothink",
      messages: [{ role: "user", content: "hi" }],
    }
    const { body: out, alias } = applyThinkModeRewrite(body)
    assert.notEqual(out, body, "must clone")
    assert.equal(out.model, "qwen3.6-flash")
    assert.equal(out.enable_thinking, false)
    assert.equal(alias, "qwen3.6-flash-nothink")
    // Original is preserved
    assert.equal(body.model, "qwen3.6-flash-nothink")
    assert.equal(body.enable_thinking, undefined)
  })

  test("alias choice overrides any pre-set enable_thinking from caller", () => {
    // The alias is the user's explicit, model-level decision and must win.
    const body = {
      model: "qwen3.6-plus-nothink",
      enable_thinking: true,
      messages: [],
    }
    const { body: out } = applyThinkModeRewrite(body)
    assert.equal(out.enable_thinking, false)
  })

  test("preserves other fields like messages / temperature / stream_options", () => {
    const body = {
      model: "qwen3.7-max-nothink",
      messages: [{ role: "system", content: "x" }, { role: "user", content: "y" }],
      temperature: 0.2,
      stream: true,
      stream_options: { include_usage: true },
    }
    const { body: out } = applyThinkModeRewrite(body)
    assert.equal(out.model, "qwen3.7-max")
    assert.equal(out.enable_thinking, false)
    assert.equal(out.temperature, 0.2)
    assert.equal(out.stream, true)
    assert.deepEqual(out.stream_options, { include_usage: true })
    assert.equal(out.messages.length, 2)
  })

  test("non-object body returns as-is", () => {
    const r = applyThinkModeRewrite(null)
    assert.equal(r.body, null)
    assert.equal(r.alias, null)
  })
})
