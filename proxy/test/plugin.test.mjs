import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, test } from "node:test"

import { createBailianCacheProxyPlugin } from "../../plugins/bailian-cache-proxy.js"
describe("BailianCacheProxyPlugin", () => {
  test("logs proxy spawn failures", async () => {
    const logs = []
    const child = new EventEmitter()
    child.unref = () => {}

    const plugin = createBailianCacheProxyPlugin({
      spawnImpl: () => child,
      fetchImpl: async () => ({ ok: false }),
      sleep: async () => {},
    })

    await plugin({
      client: {
        app: {
          log: async ({ body }) => logs.push(body),
        },
      },
    })

    child.emit("error", new Error("node missing"))
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(logs.some((entry) => entry.level === "error" && /node missing/.test(entry.message)), true)
  })

  test("starts the proxy when health check fails without registering a pid", async () => {
    const logs = []
    const requests = []
    const spawns = []
    const plugin = createBailianCacheProxyPlugin({
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init })
        return { ok: false }
      },
      spawnImpl: (command, args, options) => {
        spawns.push({ command, args, options })
        return { on() {}, unref() {} }
      },
    })

    await plugin({
      client: {
        app: {
          log: async ({ body }) => logs.push(body),
        },
      },
    })

    assert.equal(requests.length, 1)
    assert.match(requests[0].url, /\/health$/)
    assert.equal(spawns.length, 1)
    assert.equal(spawns[0].options.env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS, "0")
    assert.equal(logs.some((entry) => entry.level === "info" && /proxy ensured/.test(entry.message)), true)
  })

  test("does not start a duplicate proxy when health check succeeds", async () => {
    const requests = []
    const spawns = []
    const plugin = createBailianCacheProxyPlugin({
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init })
        return { ok: true }
      },
      spawnImpl: (...args) => {
        spawns.push(args)
        return { on() {}, unref() {} }
      },
    })

    await plugin({
      client: {
        app: {
          log: async () => {},
        },
      },
    })

    assert.equal(requests.length, 1)
    assert.match(requests[0].url, /\/health$/)
    assert.equal(spawns.length, 0)
  })

  test("periodic health check restarts proxy when it dies", async () => {
    const logs = []
    const requests = []
    const spawns = []
    let healthy = true
    const timers = []

    const fakeSetInterval = (fn, ms) => {
      timers.push({ fn, ms })
      return { unref: () => {} }
    }

    const plugin = createBailianCacheProxyPlugin({
      setIntervalImpl: fakeSetInterval,
      fetchImpl: async (url, init = {}) => {
        requests.push({ url, init })
        return { ok: healthy }
      },
      spawnImpl: (...args) => {
        spawns.push(args)
        return { on() {}, unref() {} }
      },
    })

    await plugin({
      client: {
        app: {
          log: async ({ body }) => logs.push(body),
        },
      },
    })

    // Initial: healthy, so no spawn from periodic check
    assert.equal(spawns.length, 0)

    // Simulate proxy dying
    healthy = false
    const timer = timers[0]
    await timer.fn()

    assert.ok(spawns.length >= 1, "should restart proxy when health check fails")
    assert.equal(spawns[spawns.length - 1][2].env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS, "0")
  })

  test("cooldown resets when proxy becomes healthy again", async () => {
    const logs = []
    const spawns = []
    const timers = []
    let currentTime = 0
    let healthy = false

    const fakeSetInterval = (fn, ms) => { timers.push({ fn, ms }); return { unref: () => {} } }

    const plugin = createBailianCacheProxyPlugin({
      setIntervalImpl: fakeSetInterval,
      fetchImpl: async () => ({ ok: healthy }),
      spawnImpl: (...args) => { spawns.push(args); return { on() {}, unref() {} } },
      now: () => currentTime,
      restartCooldownMs: 60_000,
    })

    await plugin({ client: { app: { log: async ({ body }) => logs.push(body) } } })
    // Initial: unhealthy → spawn @ t=0
    assert.equal(spawns.length, 1)

    // t=30s: still unhealthy, cooldown blocks
    currentTime = 30_000
    await timers[0].fn()
    assert.equal(spawns.length, 1)

    // t=60s: proxy comes back healthy
    currentTime = 60_000
    healthy = true
    await timers[0].fn()
    assert.equal(spawns.length, 1)  // no spawn needed

    // t=61s: proxy crashes again — cooldown should have reset, so immediate respawn
    currentTime = 61_000
    healthy = false
    await timers[0].fn()
    assert.equal(spawns.length, 2, "after healthy period, new crash must trigger immediate spawn")
  })

  test("periodic health timer has unref called", async () => {
    let unrefCalled = false
    const fakeTimer = { unref: () => { unrefCalled = true } }

    const plugin = createBailianCacheProxyPlugin({
      setIntervalImpl: () => fakeTimer,
      fetchImpl: async () => ({ ok: true }),
      spawnImpl: () => {
        return { on() {}, unref() {} }
      },
    })

    await plugin({
      client: {
        app: {
          log: async () => {},
        },
      },
    })

    assert.equal(unrefCalled, true, "timer.unref() should be called to not block exit")
  })

  test("periodic health check does not fork-storm on repeated failures", async () => {
    const logs = []
    const spawns = []
    let healthy = false
    const timers = []
    let currentTime = 0

    const fakeSetInterval = (fn, ms) => {
      timers.push({ fn, ms })
      return { unref: () => {} }
    }

    const plugin = createBailianCacheProxyPlugin({
      setIntervalImpl: fakeSetInterval,
      fetchImpl: async () => ({ ok: healthy }),
      spawnImpl: (...args) => {
        spawns.push(args)
        return { on() {}, unref() {} }
      },
      now: () => currentTime,
      restartCooldownMs: 60_000,
    })

    await plugin({
      client: { app: { log: async ({ body }) => logs.push(body) } },
    })

    // Plugin startup spawned once because initial health check failed
    assert.equal(spawns.length, 1)

    // 10 consecutive timer ticks, all unhealthy. Time advances 10s each tick.
    // Cooldown = 60s. So only every other tick can succeed, but because
    // guardedSpawn only resets lastSpawnAt on success, ticks are bounded.
    const timer = timers[0]
    for (let i = 0; i < 10; i++) {
      currentTime += 10_000  // 10 seconds
      await timer.fn()
    }

    // Should not be anywhere near 11 spawns; cooldown bounded them.
    // Initial (t=0), t=60, t=120 succeed = max 3 over 100s with 60s cooldown.
    assert.ok(spawns.length <= 3, `expected <= 3 spawns, got ${spawns.length}`)
  })

  test("periodic health check swallows async callback errors", async () => {
    const logs = []
    const timers = []

    const fakeSetInterval = (fn, ms) => {
      timers.push({ fn, ms })
      return { unref: () => {} }
    }

    let fetchCalls = 0
    const plugin = createBailianCacheProxyPlugin({
      setIntervalImpl: fakeSetInterval,
      fetchImpl: async () => {
        fetchCalls += 1
        if (fetchCalls > 1) throw new Error("network exploded")
        return { ok: true }
      },
      spawnImpl: () => ({ on() {}, unref() {} }),
    })

    await plugin({ client: { app: { log: async ({ body }) => logs.push(body) } } })

    // Timer tick's health check throws — must not surface as unhandled rejection
    const rejected = await Promise.resolve().then(() => timers[0].fn()).then(
      () => false,
      () => true,
    )
    assert.equal(rejected, false, "timer callback rejection must not escape to caller")

    // Should have logged a warning about health check failure
    assert.ok(logs.some((e) => e.level === "warn" && /health/i.test(e.message)),
      "should log warn when health check throws")
  })
})
