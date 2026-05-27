# Keepalive for Upstream Cache TTL — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent DashScope cache TTL expiry (5min) for sessions that go idle > 5min but return within 9.5min, by sending a single activity-driven keepalive request once a session has been silent for 4.5 minutes.

**Architecture:** New first-class module `src/keepalive.mjs` (`createKeepaliveManager`) holds a per-session-key map. `server.mjs` calls `registerHit` on every successful chat request, passing the truncated body (messages up to marker 2) + session key (`markers[0].prefix_hash`). A 30s scan timer fires `sendKeepalive` for any entry older than 4.5 min that hasn't been sent yet; the "single shot per idle window" property comes from a `keepaliveSent` flag reset by each real `registerHit`.

**Tech Stack:** Node.js ESM, existing `node:test` harness, existing `cache-planner.mjs` marker infrastructure.

**Rationale from real data (2026-05-26):** 15 real TTL_EXPIRED events in turn-stable period, 9/15 (60%) fell in the 5–9.5min gap window (saveable by single keepalive). Net daily savings ¥7.76/day vs doing nothing (¥12.86 miss cost, ¥2.55 keepalive cost, 15 timer triggers).

---

## File structure

| File | Responsibility |
|---|---|
| `proxy/src/keepalive.mjs` (NEW) | Core module — `createKeepaliveManager` with `registerHit`, `tick`, `startTimer`, `stopTimer`, `sendKeepalive`. |
| `proxy/src/server.mjs` (MODIFY) | On successful chat-completions: compute session key + truncated body, call `keepalive.registerHit`. On start/stop: start/stop the tick timer. Gated by `cacheOptions.keepalive`. |
| `proxy/src/cache-planner.mjs` (MODIFY — small) | Export helper `truncateBodyForKeepalive(body, markers)` that strips messages after marker[2] and all `cache_control` annotations. Pure helper — planner stays stateless. |
| `proxy/bin/bailian-cache-proxy.mjs` (MODIFY) | Wire `BAILIAN_CACHE_PROXY_KEEPALIVE` env and forward into `cacheOptions.keepalive`. |
| `proxy/test/keepalive.test.mjs` (NEW) | Unit tests for the module — injectable `now`/`fetch`/`pidIsAlive`. |
| `proxy/test/cache-planner.test.mjs` (MODIFY) | Tests for `truncateBodyForKeepalive`. |
| `proxy/test/server.test.mjs` (MODIFY) | Integration test: real proxy + fake upstream + simulated >5min idle. |
| `proxy/.env.example` (MODIFY) | Document new env var. |
| `proxy/README.md` (MODIFY) | New "Keepalive" section explaining mechanism + env var. |
| `docs/TODO.md` (MODIFY) | Move item #2 to "已完成" appendix. |
| Parent repo: `docs/knowledge/openai-compatible-cache-proxy.md` (MODIFY) | Add keepalive entry to knowledge doc. |

---

## Task 1: `truncateBodyForKeepalive` pure helper

**Files:** `proxy/src/cache-planner.mjs`, `proxy/test/cache-planner.test.mjs`

- [ ] **Step 1: Add failing tests in `proxy/test/cache-planner.test.mjs`** (extend existing `describe("planBailianCacheMarkers")` or add a new describe block):

```js
import { truncateBodyForKeepalive } from "../src/cache-planner.mjs"

// ...

describe("truncateBodyForKeepalive", () => {
  test("returns null when markers has fewer than 3 entries", () => {
    const body = { model: "qwen3.7-max", messages: [{ role: "user", content: "hi" }] }
    assert.equal(truncateBodyForKeepalive(body, []), null)
    assert.equal(truncateBodyForKeepalive(body, [{ message_index: 0 }]), null)
  })

  test("truncates messages after the message containing marker index 2", () => {
    const body = {
      model: "qwen3.7-max",
      messages: [
        { role: "system", content: "sys " + "x".repeat(8000) },
        { role: "user", content: "first user turn" },
        { role: "assistant", content: "reply one" },
        { role: "user", content: "second user turn" },
        { role: "assistant", content: "reply two" },
        { role: "tool", content: "tool result" },
      ],
    }
    // markers[2] is at message_index 3 (second user turn)
    const markers = [
      { role: "system", message_index: 0 },
      { role: "user", message_index: 1 },
      { role: "user", message_index: 3 },
      { role: "tool", message_index: 5 },
    ]
    const truncated = truncateBodyForKeepalive(body, markers)
    assert.ok(truncated)
    assert.equal(truncated.messages.length, 4) // 0..3 inclusive
    assert.equal(truncated.messages[0].role, "system")
    assert.equal(truncated.messages[3].content, "second user turn")
  })

  test("strips cache_control annotations from messages", () => {
    const body = {
      model: "qwen3.7-max",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        { role: "assistant", content: "ok" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    }
    const markers = [
      { message_index: 0 }, { message_index: 0 }, { message_index: 0 }, { message_index: 1 },
    ]
    const truncated = truncateBodyForKeepalive(body, markers)
    for (const msg of truncated.messages) {
      const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
      for (const p of parts) {
        assert.ok(!p?.cache_control, "cache_control stripped")
      }
    }
  })

  test("preserves model and sets stream=false, max_tokens=1", () => {
    const body = {
      model: "qwen3.7-max",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }, { role: "assistant", content: "d" }],
      stream: true,
      stream_options: { include_usage: true },
    }
    const markers = [
      { message_index: 0 }, { message_index: 0 }, { message_index: 2 }, { message_index: 3 },
    ]
    const truncated = truncateBodyForKeepalive(body, markers)
    assert.equal(truncated.model, "qwen3.7-max")
    assert.equal(truncated.stream, false)
    assert.equal(truncated.max_tokens, 1)
    assert.equal(truncated.stream_options, undefined)
  })

  test("injects _keepalive marker for usage-log filtering", () => {
    const body = { model: "q", messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }, { role: "user", content: "d" }] }
    const markers = [
      { message_index: 0 }, { message_index: 1 }, { message_index: 2 }, { message_index: 3 },
    ]
    const truncated = truncateBodyForKeepalive(body, markers)
    assert.equal(truncated._keepalive, true)
  })

  test("returns null when input is not a chat body", () => {
    assert.equal(truncateBodyForKeepalive(null, []), null)
    assert.equal(truncateBodyForKeepalive({ model: "x" }, []), null)
    assert.equal(truncateBodyForKeepalive("string", []), null)
  })
})
```

- [ ] **Step 2: Run tests to confirm RED**

Run: `cd proxy && node --test test/cache-planner.test.mjs`
Expected: `truncateBodyForKeepalive is not a function`

- [ ] **Step 3: Implement `truncateBodyForKeepalive` in `proxy/src/cache-planner.mjs`**

Append near the existing `planBailianCacheMarkersWithDiagnostics` export block:

```js
// Build a minimal keepalive body from a chat-completions body + cache-planner
// markers. The resulting body contains only messages[0..markers[2].message_index]
// (inclusive), has stream=false, max_tokens=1, and no cache_control annotations
// (those get re-planned by the upstream call path when the real request arrives).
// Returns null if the input is malformed or has fewer than 3 markers.
export const truncateBodyForKeepalive = (body, markers) => {
  if (!body || typeof body !== "object" || !Array.isArray(body?.messages)) return null
  if (!Array.isArray(markers) || markers.length < 3) return null

  // marker[2] is the "current user turn" anchor; truncate AFTER it.
  const cutoffMessageIndex = markers[2].message_index
  if (!Number.isFinite(cutoffMessageIndex) || cutoffMessageIndex < 0) return null

  const truncatedMessages = body.messages
    .slice(0, cutoffMessageIndex + 1)
    .map((msg) => {
      const cloned = { ...msg }
      delete cloned.cache_control
      if (Array.isArray(cloned.content)) {
        cloned.content = cloned.content.map((part) => {
          if (!part || typeof part !== "object") return part
          const p = { ...part }
          delete p.cache_control
          return p
        })
      }
      return cloned
    })

  return {
    model: body.model,
    messages: truncatedMessages,
    stream: false,
    max_tokens: 1,
    _keepalive: true,
  }
}
```

- [ ] **Step 4: Run tests to confirm GREEN**

Run: `cd proxy && node --test test/cache-planner.test.mjs`
Expected: all `truncateBodyForKeepalive` tests pass.

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `cd proxy && node --test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add proxy/src/cache-planner.mjs proxy/test/cache-planner.test.mjs
git commit -m "feat(planner): truncateBodyForKeepalive helper for keepalive body construction"
```

---

## Task 2: `createKeepaliveManager` core — registerHit + tick (TDD)

**Files:** `proxy/src/keepalive.mjs` (NEW), `proxy/test/keepalive.test.mjs` (NEW)

- [ ] **Step 1: Create test file `proxy/test/keepalive.test.mjs` with registerHit + tick tests**

```js
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createKeepaliveManager } from "../src/keepalive.mjs"

const mkBody = () => ({ model: "qwen3.7-max", messages: [{ role: "user", content: "a" }], stream: false })

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
```

- [ ] **Step 2: Run new tests to confirm RED**

Run: `cd proxy && node --test test/keepalive.test.mjs`
Expected: `Cannot find module '../src/keepalive.mjs'`

- [ ] **Step 3: Implement `src/keepalive.mjs`**

```js
import { processPidIsAlive } from "./lifecycle.mjs"

const DEFAULT_THRESHOLD_MS = 4 * 60 * 1000 + 30 * 1000  // 4.5 minutes
const DEFAULT_SCAN_INTERVAL_MS = 30_000
const DEFAULT_MAX_KEYS = 8
const DEFAULT_MIN_HITS = 2

export const createKeepaliveManager = ({
  thresholdMs = DEFAULT_THRESHOLD_MS,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  maxKeys = DEFAULT_MAX_KEYS,
  minHits = DEFAULT_MIN_HITS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  pidIsAlive = processPidIsAlive,
  logger = console,
  onKeepaliveSent = () => {},
  enabled = true,
} = {}) => {
  const activeKeys = new Map()

  const evictLru = () => {
    if (activeKeys.size === 0) return
    const lruKey = [...activeKeys.entries()]
      .reduce((min, [k, v]) => (!min || v.lastHitAt < min[1].lastHitAt ? [k, v] : min), null)?.[0]
    if (lruKey) activeKeys.delete(lruKey)
  }

  const registerHit = ({ sessionKey, pid, truncatedBody, model, url, authHeader }) => {
    if (!enabled) return
    if (!sessionKey || !truncatedBody) return

    let entry = activeKeys.get(sessionKey)
    if (!entry) {
      if (activeKeys.size >= maxKeys) evictLru()
      entry = {
        sessionKey,
        lastHitAt: 0,
        truncatedBody: null,
        model: null,
        url: null,
        authHeader: null,
        clients: new Set(),
        totalHits: 0,
        keepaliveSent: false,
        keepaliveCount: 0,
      }
      activeKeys.set(sessionKey, entry)
    }

    entry.lastHitAt = now()
    entry.truncatedBody = truncatedBody
    entry.model = model
    entry.url = url
    if (authHeader) entry.authHeader = authHeader
    entry.keepaliveSent = false  // real activity resets the single-shot flag
    entry.totalHits += 1

    if (pid && Number.isSafeInteger(pid) && pid > 0) {
      entry.clients.add(pid)
    }
  }

  const sendKeepalive = async (entry) => {
    const bodyStr = JSON.stringify(entry.truncatedBody)
    const headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(bodyStr, "utf8")),
    }
    if (entry.authHeader) headers.authorization = entry.authHeader

    const response = await fetchImpl(entry.url, {
      method: "POST",
      headers,
      body: bodyStr,
    })
    if (response.body) {
      try { for await (const _ of response.body) {} } catch {}
    }
    onKeepaliveSent({ sessionKey: entry.sessionKey, status: response.status, model: entry.model })
  }

  const tick = async () => {
    if (!enabled) return
    const current = now()

    for (const [sessionKey, entry] of activeKeys) {
      for (const pid of [...entry.clients]) {
        if (!pidIsAlive(pid)) entry.clients.delete(pid)
      }
      if (entry.clients.size === 0) {
        activeKeys.delete(sessionKey)
        continue
      }

      const age = current - entry.lastHitAt
      if (age > thresholdMs && !entry.keepaliveSent && entry.totalHits >= minHits) {
        entry.keepaliveSent = true
        entry.keepaliveCount += 1
        sendKeepalive(entry).catch((err) => {
          logger.warn?.(`keepalive failed for ${sessionKey}: ${err.message || err}`)
        })
      }
    }
  }

  let timerHandle = null
  const startTimer = () => {
    if (timerHandle) return () => {}
    timerHandle = setInterval(() => { void tick() }, scanIntervalMs)
    timerHandle.unref?.()
    return () => { clearInterval(timerHandle); timerHandle = null }
  }

  const stopTimer = () => {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null }
  }

  return {
    registerHit, tick, startTimer, stopTimer,
    get activeKeys() { return activeKeys },
  }
}
```

- [ ] **Step 4: Run new tests to confirm GREEN**

Run: `cd proxy && node --test test/keepalive.test.mjs`

- [ ] **Step 5: Run full suite to confirm no regressions**

Run: `cd proxy && node --test`
Expected: 0 failures.

- [ ] **Step 6: Commit**

```bash
git add proxy/src/keepalive.mjs proxy/test/keepalive.test.mjs
git commit -m "feat(keepalive): createKeepaliveManager with registerHit + tick"
```

---

## Task 3: Wire keepalive into `server.mjs`

**Files:** `proxy/src/server.mjs`, `proxy/test/server.test.mjs`

(See main plan for detailed steps — integration test + server modifications)

---

## Task 4: Environment variable + `.env.example` + README

**Files:** `proxy/bin/bailian-cache-proxy.mjs`, `proxy/.env.example`, `proxy/README.md`

---

## Task 5: Update `docs/TODO.md` — move item #2 to "已完成"

---

## Task 6: Update parent knowledge doc + submodule bump

---

## DAG / concurrency opportunity

Tasks 1, 2 are independent and can be done in parallel. Task 3 depends on both. Tasks 4, 5, 6 depend on Task 3 but are independent of each other.

```
T1 (truncateBodyForKeepalive) ──┐
                                ├──> T3 (server wiring) ──> T4 (env+readme)
T2 (createKeepaliveManager) ────┘                        ──> T5 (TODO.md)
                                                         ──> T6 (parent bump)
```

## Acceptance criteria

- [ ] New module `src/keepalive.mjs` with 100% test coverage.
- [ ] `server.mjs` integration: keepalive armed on every successful chat request.
- [ ] Keepalive requests carry `_keepalive: true` filterable in usage stats.
- [ ] Default enabled, `BAILIAN_CACHE_PROXY_KEEPALIVE=0` disables.
- [ ] Single-shot per idle window verified.
- [ ] README documents mechanism + env vars.
- [ ] `docs/TODO.md` item #2 marked complete.
- [ ] Parent knowledge doc updated.
- [ ] Submodule bumped and pushed.
- [ ] Full test suite green.
