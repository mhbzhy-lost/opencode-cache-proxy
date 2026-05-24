import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import {
  qwenPidFilePath,
  parseHookInput,
  runQwenKeepalive,
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

  test("starts the proxy when unhealthy and records a Qwen keepalive pid", async () => {
    const stateDir = await makeTempStateDir()
    const spawnCalls = []
    const fetchCalls = []

    const result = await startQwenKeepalive({
      hookInput: { session_id: "session/with spaces" },
      stateDir,
      env: { BAILIAN_CACHE_PROXY_PORT: "49876" },
      nodeBin: "node",
      proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
      keepaliveEntry: "/repo/proxy/bin/bailian-cache-proxy-qwen-hook.mjs",
      fetchImpl: async (url, options = {}) => {
        fetchCalls.push({ url: String(url), method: options.method || "GET" })
        return { ok: fetchCalls.length > 1 }
      },
      sleep: async () => {},
      spawnImpl: (command, args, options) => {
        const child = {
          pid: spawnCalls.length === 0 ? 1111 : 4242,
          on() {},
          unref() {},
        }
        spawnCalls.push({ command, args, options, pid: child.pid })
        return child
      },
      killImpl: () => {
        throw new Error("no pid should be probed before pidfile exists")
      },
    })

    assert.equal(result.status, "started")
    assert.equal(result.pid, 4242)
    assert.equal(await readFile(result.pidFile, "utf8"), "4242\n")
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
    assert.equal(spawnCalls.length, 2)
    assert.deepEqual(spawnCalls[0].args, ["/repo/proxy/bin/bailian-cache-proxy.mjs"])
    assert.equal(spawnCalls[0].options.detached, true)
    assert.deepEqual(spawnCalls[0].options.stdio, ["ignore", "ignore", "pipe"])
    assert.deepEqual(spawnCalls[1].args, [
      "/repo/proxy/bin/bailian-cache-proxy-qwen-hook.mjs",
      "keepalive",
      "--pid-file",
      result.pidFile,
    ])
    assert.equal(spawnCalls[1].options.detached, true)
    assert.deepEqual(spawnCalls[1].options.stdio, ["ignore", "ignore", "pipe"])

    await rm(stateDir, { recursive: true, force: true })
  })

  test("does not spawn a duplicate keeper when the session pidfile is alive", async () => {
    const stateDir = await makeTempStateDir()
    const hookInput = { session_id: "same-session" }
    const pidFile = qwenPidFilePath({ hookInput, stateDir })
    await writeFile(pidFile, "4242\n")

    const result = await startQwenKeepalive({
      hookInput,
      stateDir,
      fetchImpl: async () => {
        throw new Error("health check should be skipped for an alive keeper")
      },
      spawnImpl: () => {
        throw new Error("spawn should be skipped for an alive keeper")
      },
      killImpl: (pid, signal) => {
        assert.equal(pid, 4242)
        assert.equal(signal, 0)
        return true
      },
    })

    assert.equal(result.status, "already-running")
    assert.equal(result.pid, 4242)
    assert.equal(result.pidFile, pidFile)

    await rm(stateDir, { recursive: true, force: true })
  })

  test("does not spawn a duplicate keeper while another start owns the lock", async () => {
    const stateDir = await makeTempStateDir()
    const hookInput = { session_id: "locked-session" }
    const pidFile = qwenPidFilePath({ hookInput, stateDir })
    await writeFile(`${pidFile}.lock`, "starting\n")

    const result = await startQwenKeepalive({
      hookInput,
      stateDir,
      fetchImpl: async () => {
        throw new Error("health check should be skipped while lock is held")
      },
      spawnImpl: () => {
        throw new Error("spawn should be skipped while lock is held")
      },
    })

    assert.equal(result.status, "starting")
    assert.equal(result.pid, null)
    assert.equal(result.pidFile, pidFile)

    await rm(stateDir, { recursive: true, force: true })
  })

  test("does not spawn a keeper when the proxy never becomes healthy", async () => {
    const stateDir = await makeTempStateDir()
    const spawnCalls = []

    await assert.rejects(
      startQwenKeepalive({
        hookInput: { session_id: "startup-fails" },
        stateDir,
        nodeBin: "node",
        proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
        keepaliveEntry: "/repo/proxy/bin/bailian-cache-proxy-qwen-hook.mjs",
        fetchImpl: async () => ({ ok: false }),
        sleep: async () => {},
        startupAttempts: 1,
        spawnImpl: (command, args, options) => {
          const child = { pid: 1111, on() {}, unref() {} }
          spawnCalls.push({ command, args, options, pid: child.pid })
          return child
        },
      }),
      /proxy did not become healthy/,
    )

    assert.equal(spawnCalls.length, 1, "must only spawn the proxy process")
    const pidFile = qwenPidFilePath({
      hookInput: { session_id: "startup-fails" },
      stateDir,
    })
    await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" })

    await rm(stateDir, { recursive: true, force: true })
  })

  test("kills the keeper if writing its pidfile fails", async () => {
    const stateDir = await makeTempStateDir()
    const killed = []
    const spawnCalls = []

    await assert.rejects(
      startQwenKeepalive({
        hookInput: { session_id: "pidfile-write-fails" },
        stateDir,
        nodeBin: "node",
        proxyEntry: "/repo/proxy/bin/bailian-cache-proxy.mjs",
        keepaliveEntry: "/repo/proxy/bin/bailian-cache-proxy-qwen-hook.mjs",
        fetchImpl: async () => ({ ok: spawnCalls.length > 0 }),
        sleep: async () => {},
        spawnImpl: (command, args, options) => {
          const child = {
            pid: spawnCalls.length === 0 ? 1111 : 4242,
            on() {},
            unref() {},
          }
          spawnCalls.push({ command, args, options, pid: child.pid })
          return child
        },
        killImpl: (pid, signal) => {
          killed.push({ pid, signal })
          return true
        },
        writePidFileImpl: async () => {
          throw new Error("disk full")
        },
      }),
      /disk full/,
    )

    assert.equal(spawnCalls.length, 2)
    assert.deepEqual(killed, [{ pid: 4242, signal: "SIGTERM" }])

    await rm(stateDir, { recursive: true, force: true })
  })

  test("stops a Qwen keepalive process and removes its pidfile", async () => {
    const stateDir = await makeTempStateDir()
    const hookInput = { session_id: "session-to-stop" }
    const pidFile = qwenPidFilePath({ hookInput, stateDir })
    await writeFile(pidFile, "4242\n")

    const killed = []
    const result = await stopQwenKeepalive({
      hookInput,
      stateDir,
      killImpl: (pid, signal) => {
        killed.push({ pid, signal })
        return true
      },
    })

    assert.equal(result.status, "stopped")
    assert.deepEqual(killed, [{ pid: 4242, signal: "SIGTERM" }])
    await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" })

    await rm(stateDir, { recursive: true, force: true })
  })

  test("does not overlap keepalive heartbeats when an interval fires twice", async () => {
    const stateDir = await makeTempStateDir()
    const pidFile = join(stateDir, "qwen-overlap.pid")
    const signalTarget = new EventEmitter()
    let intervalCallback
    let clearCalled = false
    let resolveBlockedFetch
    let fetchCalls = 0

    const runPromise = runQwenKeepalive({
      pidFile,
      signalTarget,
      fetchImpl: async () => {
        fetchCalls += 1
        if (fetchCalls === 3) {
          await new Promise((resolve) => {
            resolveBlockedFetch = resolve
          })
        }
        return { ok: true }
      },
      spawnImpl: () => {
        throw new Error("proxy should not spawn when health checks are healthy")
      },
      setIntervalImpl: (callback) => {
        intervalCallback = callback
        return { unref() {} }
      },
      clearIntervalImpl: () => {
        clearCalled = true
      },
    })

    while (!intervalCallback) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    intervalCallback()
    intervalCallback()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetchCalls, 3, "second interval must not start an overlapping beat")

    resolveBlockedFetch()
    await new Promise((resolve) => setImmediate(resolve))
    signalTarget.emit("SIGTERM")
    await runPromise

    assert.equal(clearCalled, true)
    await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" })

    await rm(stateDir, { recursive: true, force: true })
  })
})
