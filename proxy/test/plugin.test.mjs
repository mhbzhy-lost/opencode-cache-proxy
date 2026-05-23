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
      maxHeartbeatAttempts: 0,
      setIntervalImpl: () => ({ unref() {} }),
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

  test("logs periodic heartbeat failures", async () => {
    const logs = []
    let intervalCallback
    let requestCount = 0
    const plugin = createBailianCacheProxyPlugin({
      fetchImpl: async () => {
        requestCount += 1
        if (requestCount === 1) return { ok: true }
        throw new Error("connection refused")
      },
      sleep: async () => {},
      maxHeartbeatAttempts: 0,
      setIntervalImpl: (callback) => {
        intervalCallback = callback
        return { unref() {} }
      },
    })

    await plugin({
      client: {
        app: {
          log: async ({ body }) => logs.push(body),
        },
      },
    })
    await intervalCallback()

    assert.equal(logs.some((entry) => entry.level === "warn" && /heartbeat failed/.test(entry.message)), true)
    assert.equal(logs.some((entry) => /connection refused/.test(JSON.stringify(entry.extra))), true)
  })
})
