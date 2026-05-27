import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createKeepaliveManager } from "../src/keepalive.mjs"

const mkBody = () => ({ model: "qwen3.7-max", messages: [{ role: "user", content: "a" }], stream: false, max_tokens: 1, _keepalive: true })

describe("createKeepaliveManager - registerHit", () => {
  test("records a new session entry with truncated body and session key", () => {
    const mgr = createKeepaliveManager({ now: () => 10_000, pidIsAlive: () => true })
    mgr.registerHit({
      sessionKey: "abc_system_hash",
      pid: 1234,
      truncatedBody: mkBody(),
      model: "qwen3.7-max",
      url: "http://test/upstream",
      authHeader: "Bearer sk",
    })
    assert.equal(mgr.activeKeys.size, 1)
    const entry = mgr.activeKeys.get("abc_system_hash")
    assert.equal(entry.totalHits, 1)
    assert.equal(entry.lastHitAt, 10_000)
    assert.ok(entry.clients.has(1234))
    assert.equal(entry.keepaliveSent, false)
  })

  test("updates lastHitAt and resets keepaliveSent on repeat hit", () => {
    let clock = 10_000
    const mgr = createKeepaliveManager({ now: () => clock, pidIsAlive: () => true })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    mgr.activeKeys.get("k").keepaliveSent = true
    clock = 400_000
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    const e = mgr.activeKeys.get("k")
    assert.equal(e.lastHitAt, 400_000)
    assert.equal(e.keepaliveSent, false)
    assert.equal(e.totalHits, 2)
  })

  test("tracks multiple clients per session key", () => {
    const mgr = createKeepaliveManager({ now: () => 10_000, pidIsAlive: () => true })
    mgr.registerHit({ sessionKey: "k", pid: 100, truncatedBody: mkBody(), model: "m", url: "u" })
    mgr.registerHit({ sessionKey: "k", pid: 200, truncatedBody: mkBody(), model: "m", url: "u" })
    const e = mgr.activeKeys.get("k")
    assert.equal(e.clients.size, 2)
    assert.ok(e.clients.has(100))
    assert.ok(e.clients.has(200))
  })

  test("evicts LRU entry when maxKeys is reached", () => {
    let clock = 0
    const mgr = createKeepaliveManager({ now: () => clock, pidIsAlive: () => true, maxKeys: 2 })
    clock = 1; mgr.registerHit({ sessionKey: "old", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock = 2; mgr.registerHit({ sessionKey: "mid", pid: 2, truncatedBody: mkBody(), model: "m", url: "u" })
    clock = 3; mgr.registerHit({ sessionKey: "new", pid: 3, truncatedBody: mkBody(), model: "m", url: "u" })
    assert.equal(mgr.activeKeys.size, 2)
    assert.ok(!mgr.activeKeys.has("old"))
    assert.ok(mgr.activeKeys.has("mid"))
    assert.ok(mgr.activeKeys.has("new"))
  })

  test("does nothing when enabled=false", () => {
    const mgr = createKeepaliveManager({ now: () => 10_000, pidIsAlive: () => true, enabled: false })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    assert.equal(mgr.activeKeys.size, 0)
  })

  test("ignores truncatedBody=null (planner returned null)", () => {
    const mgr = createKeepaliveManager({ now: () => 10_000, pidIsAlive: () => true })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: null, model: "m", url: "u" })
    assert.equal(mgr.activeKeys.size, 0)
  })
})

describe("createKeepaliveManager - tick", () => {
  test("sends keepalive when session age > threshold and no keepalive sent yet", async () => {
    let clock = 10_000
    const sent = []
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 4 * 60 * 1000 + 30 * 1000,
      minHits: 1,
      fetchImpl: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) })
        return { status: 200, body: null }
      },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "http://u/c" })
    clock += 271 * 1000
    await mgr.tick()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.stream, false)
    assert.equal(sent[0].body.max_tokens, 1)
    assert.equal(sent[0].body._keepalive, true)
    assert.equal(mgr.activeKeys.get("k").keepaliveSent, true)
  })

  test("does NOT re-send keepalive on next tick (single-shot property)", async () => {
    let clock = 10_000
    const sent = []
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 270_000,
      minHits: 1,
      fetchImpl: async () => { sent.push(1); return { status: 200, body: null } },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 300_000
    await mgr.tick()
    await mgr.tick()
    await mgr.tick()
    assert.equal(sent.length, 1, "only one keepalive per idle window")
  })

  test("does NOT send keepalive for fresh session (just hit)", async () => {
    let clock = 10_000
    const sent = []
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 270_000,
      minHits: 1,
      fetchImpl: async () => { sent.push(1); return { status: 200, body: null } },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 60_000
    await mgr.tick()
    assert.equal(sent.length, 0)
  })

  test("does NOT send keepalive when totalHits < minHits", async () => {
    let clock = 10_000
    const sent = []
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 270_000,
      minHits: 5,
      fetchImpl: async () => { sent.push(1); return { status: 200, body: null } },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 300_000
    await mgr.tick()
    assert.equal(sent.length, 0)
  })

  test("drops entries whose all clients are dead", () => {
    let clock = 10_000
    const alive = new Set([1, 2])
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: (pid) => alive.has(pid),
      thresholdMs: 270_000,
      minHits: 1,
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    alive.delete(1)
    clock += 10_000
    mgr.tick()
    assert.equal(mgr.activeKeys.size, 0)
  })

  test("resets keepaliveSent after real activity post-keepalive", async () => {
    let clock = 10_000
    const sent = []
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 270_000,
      minHits: 1,
      fetchImpl: async () => { sent.push(1); return { status: 200, body: null } },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 300_000
    await mgr.tick()
    assert.equal(sent.length, 1)

    clock += 1000
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 300_000
    await mgr.tick()
    assert.equal(sent.length, 2, "second keepalive after fresh real activity")
  })

  test("does not crash on fetch failure", async () => {
    let clock = 10_000
    const mgr = createKeepaliveManager({
      now: () => clock,
      pidIsAlive: () => true,
      thresholdMs: 270_000,
      minHits: 1,
      fetchImpl: async () => { throw new Error("network boom") },
    })
    mgr.registerHit({ sessionKey: "k", pid: 1, truncatedBody: mkBody(), model: "m", url: "u" })
    clock += 300_000
    await mgr.tick()
    // failure is swallowed, but keepaliveSent should still be set to prevent retry storm
    assert.equal(mgr.activeKeys.get("k").keepaliveSent, true)
  })
})
