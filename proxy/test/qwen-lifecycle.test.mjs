import assert from "node:assert/strict"
import { writeSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import {
  parseHookInput,
  startProxyProcess,
  startQwenKeepalive,
  stopQwenKeepalive,
} from "../src/qwen-lifecycle.mjs"

const makeTempStateDir = () => mkdtemp(join(tmpdir(), "bailian-qwen-lifecycle-"))

describe("Qwen Code lifecycle hook support", () => {
  test("warns and falls back when Qwen hook input is malformed JSON", () => {
    const warnings = []

    const parsed = parseHookInput("{not-json", {
      warn: (message) => warnings.push(message),
    })

    assert.deepEqual(parsed, {})
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /invalid hook JSON/)
  })

  test("does not leave an unread stderr pipe when child stderr logging is disabled", () => {
    const spawnCalls = []
    let unrefCalled = false

    startProxyProcess({
      spawnImpl: (command, args, options) => {
        const child = {
          pid: 1111,
          stderr: {
            on() {
              throw new Error("stderr listener should not be attached")
            },
          },
          on() {},
          unref() {
            unrefCalled = true
          },
        }
        spawnCalls.push({ command, args, options })
        return child
      },
      nodeBin: "node",
      proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
      logStderr: false,
    })

    assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "ignore", "ignore"])
    assert.equal(spawnCalls[0].options.env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS, "0")
    assert.equal(unrefCalled, true)
  })

  test("can redirect child stderr to a log file without retaining a parent pipe", async () => {
    const stateDir = await makeTempStateDir()
    const stderrLogPath = join(stateDir, "qwen-cache-proxy.stderr.log")
    const spawnCalls = []

    startProxyProcess({
      spawnImpl: (command, args, options) => {
        writeSync(options.stdio[2], "proxy failed early\n")
        const child = { pid: 1111, on() {}, unref() {} }
        spawnCalls.push({ command, args, options })
        return child
      },
      nodeBin: "node",
      proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
      logStderr: false,
      stderrLogPath,
    })

    assert.equal(typeof spawnCalls[0].options.stdio[2], "number")
    assert.equal(await readFile(stderrLogPath, "utf8"), "proxy failed early\n")

    await rm(stateDir, { recursive: true, force: true })
  })

  test("start hook starts only the proxy and does not spawn a keepalive process", async () => {
    const spawnCalls = []
    const fetchCalls = []

    const result = await startQwenKeepalive({
      env: { BAILIAN_CACHE_PROXY_PORT: "49876" },
      nodeBin: "node",
      proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
      fetchImpl: async (url, options = {}) => {
        fetchCalls.push({ url: String(url), method: options.method || "GET" })
        return { ok: fetchCalls.length > 1 }
      },
      sleep: async () => {},
      spawnImpl: (command, args, options) => {
        const child = { pid: 1111, on() {}, once() {}, unref() {} }
        spawnCalls.push({ command, args, options, pid: child.pid })
        return child
      },
    })

    assert.equal(result.status, "started")
    assert.equal(result.pid, 1111)
    assert.deepEqual(
      fetchCalls.map(({ url, method }) => ({ url, method })),
      [
        {
          url: "http://127.0.0.1:49876/__bailian_cache_proxy/health",
          method: "GET",
        },
        {
          url: "http://127.0.0.1:49876/__bailian_cache_proxy/health",
          method: "GET",
        },
      ],
    )
    assert.equal(spawnCalls.length, 1)
    assert.deepEqual(spawnCalls[0].args, ["/repo/proxy/bin/bailian-cache-proxy.mjs"])
    assert.equal(spawnCalls[0].options.env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS, "0")
  })

  test("start hook does not spawn a duplicate proxy when health check succeeds", async () => {
    const result = await startQwenKeepalive({
      fetchImpl: async () => ({ ok: true }),
      spawnImpl: () => {
        throw new Error("spawn should be skipped when proxy is healthy")
      },
    })

    assert.equal(result.status, "already-running")
  })

  test("stop hook is a no-op because proxy lifecycle is shared", async () => {
    const result = await stopQwenKeepalive()

    assert.deepEqual(result, { status: "noop" })
  })
})
