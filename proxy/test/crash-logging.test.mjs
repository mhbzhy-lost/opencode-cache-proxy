import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import { crashLog, defaultCrashLogPath, setupCrashHandlers } from "../src/crash-logging.mjs"

describe("defaultCrashLogPath", () => {
  test("canonicalizes XDG_CACHE_HOME containing path traversal", () => {
    const p = defaultCrashLogPath({ XDG_CACHE_HOME: "/tmp/../evil" })
    assert.equal(p, "/evil/bailian-cache-proxy/crash.log")
  })

  test("resolves relative XDG_CACHE_HOME to absolute", () => {
    const p = defaultCrashLogPath({ XDG_CACHE_HOME: "relative/path" })
    assert.ok(resolve("relative/path").includes("relative"))
    assert.ok(p.startsWith("/"))
  })
})

describe("crashLog", () => {
  let dir
  let logPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crash-log-"))
    logPath = join(dir, "crash.log")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes error stack to file", () => {
    const err = new Error("boom")
    const wrote = crashLog("uncaughtException", err, logPath)
    assert.equal(wrote, true)
    const content = readFileSync(logPath, "utf8")
    assert.match(content, /uncaughtException/)
    assert.match(content, /boom/)
  })

  test("stringifies non-Error reasons", () => {
    const wrote = crashLog("unhandledRejection", "some reason", logPath)
    assert.equal(wrote, true)
    const content = readFileSync(logPath, "utf8")
    assert.match(content, /some reason/)
  })

  test("returns false when file write fails", () => {
    const impossible = "/nonexistent/deeply/nested/path/nope.log"
    const wrote = crashLog("test", new Error("x"), impossible)
    assert.equal(wrote, false)
  })

  test("appends rather than overwrites", () => {
    crashLog("first", new Error("a"), logPath)
    crashLog("second", new Error("b"), logPath)
    const content = readFileSync(logPath, "utf8")
    assert.match(content, /first/)
    assert.match(content, /second/)
    assert.ok(content.indexOf("first") < content.indexOf("second"))
  })

  test("mkdirSync is called before appendSync when log dir may be missing", () => {
    let mkdirCalled = false
    const order = []
    const deep = join(dir, "subdir", "need-mkdir.log")
    const wrote = crashLog("tag", new Error("x"), deep, {
      mkdirImpl: (p) => { order.push("mkdir"); mkdirCalled = true; return mkdirSync(p, { recursive: true }) },
      appendImpl: (p, data) => { order.push("append"); return appendFileSync(p, data) },
    })
    assert.equal(wrote, true, "crashLog should succeed after mkdir")
    assert.equal(mkdirCalled, true, "mkdir should be called")
    assert.deepEqual(order, ["mkdir", "append"], "mkdir must run before append")
  })
})

describe("setupCrashHandlers", () => {
  test("registers handlers for critical events", () => {
    const registered = {}
    const fakeProcess = {
      on: (event, handler) => {
        registered[event] = handler
        return fakeProcess
      },
      stderr: { write() {} },
      pid: 123,
      ppid: 1,
      exit: () => assert.fail("exit should not be called during registration"),
    }

    setupCrashHandlers({ proc: fakeProcess, logPath: "/tmp/unused.log" })

    for (const event of ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT", "SIGHUP", "exit"]) {
      assert.ok(registered[event], `missing handler for ${event}`)
    }
  })

  test("uncaughtException handler exits with code 1", () => {
    const registered = {}
    let exitCode = null
    const stderrWrites = []
    const fakeProcess = {
      on: (event, handler) => { registered[event] = handler; return fakeProcess },
      stderr: { write: (s) => stderrWrites.push(s) },
      pid: 5,
      ppid: 1,
      exit: (code) => { exitCode = code },
    }

    setupCrashHandlers({ proc: fakeProcess, logPath: "/tmp/unused.log" })
    registered.uncaughtException(new Error("test"))

    assert.equal(exitCode, 1)
    assert.ok(stderrWrites.some((s) => s.includes("uncaughtException")))
  })

  test("unhandledRejection handler exits with code 1", () => {
    const registered = {}
    let exitCode = null
    const fakeProcess = {
      on: (event, handler) => { registered[event] = handler; return fakeProcess },
      stderr: { write() {} },
      pid: 5,
      ppid: 1,
      exit: (code) => { exitCode = code },
    }

    setupCrashHandlers({ proc: fakeProcess, logPath: "/tmp/unused.log" })
    registered.unhandledRejection(new Error("promise leaked"))

    assert.equal(exitCode, 1)
  })

  test("exit handler writes to stderr with pid and code", () => {
    const registered = {}
    const writes = []
    const fakeProcess = {
      on: (event, handler) => { registered[event] = handler; return fakeProcess },
      stderr: { write: (s) => writes.push(s) },
      pid: 99,
      ppid: 1,
      exit: () => {},
    }

    setupCrashHandlers({ proc: fakeProcess, logPath: "/tmp/unused.log" })
    registered.exit(42)

    assert.ok(writes.some((s) => /pid=99/.test(s) && /code=42/.test(s)))
  })

  test("uncaughtException writes to stderr even when crash.log is unwritable", () => {
    const registered = {}
    const writes = []
    let exitCode = null
    const fakeProcess = {
      on: (event, handler) => { registered[event] = handler; return fakeProcess },
      stderr: { write: (s) => writes.push(s) },
      pid: 7,
      ppid: 1,
      exit: (code) => { exitCode = code },
    }

    setupCrashHandlers({
      proc: fakeProcess,
      logPath: "/nonexistent/deeply/nested/nope.log", // cannot be written
    })

    registered.uncaughtException(new Error("silent-fail-check"))

    assert.equal(exitCode, 1)
    // Even though file write failed, stderr must contain the crash info
    assert.ok(writes.some((s) => /silent-fail-check/.test(s)),
      "stderr must contain crash info even when crash.log is unwritable")
  })

  test("unhandledRejection stringifies circular reason safely to stderr", () => {
    const registered = {}
    const writes = []
    const fakeProcess = {
      on: (event, handler) => { registered[event] = handler; return fakeProcess },
      stderr: { write: (s) => writes.push(s) },
      pid: 5,
      ppid: 1,
      exit: () => {},
    }
    setupCrashHandlers({ proc: fakeProcess, logPath: "/tmp/unused.log" })

    const circular = { tag: "loop" }
    circular.self = circular

    registered.unhandledRejection(circular)

    assert.ok(writes.length > 0, "stderr should be written even for circular reason")
    assert.ok(writes.some((s) => /\[crash\] unhandledRejection/.test(s)))
  })
})
