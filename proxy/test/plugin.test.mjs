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
})
