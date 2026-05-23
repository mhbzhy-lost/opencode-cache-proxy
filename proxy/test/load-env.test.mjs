import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { loadEnvFile } from "../src/load-env.mjs"

const withTmpEnv = async (contents, fn) => {
  const dir = await mkdtemp(join(tmpdir(), "bailian-loadenv-"))
  const envPath = join(dir, ".env")
  await writeFile(envPath, contents, "utf8")
  try {
    await fn(envPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("loadEnvFile", () => {
  test("returns loaded=false when file does not exist", () => {
    const env = {}
    const result = loadEnvFile("/no/such/.env", env)
    assert.equal(result.loaded, false)
    assert.deepEqual(env, {})
  })

  test("imports KEY=VAL pairs into env", async () => {
    await withTmpEnv("FOO=bar\nBAZ=qux\n", async (path) => {
      const env = {}
      const result = loadEnvFile(path, env)
      assert.equal(result.loaded, true)
      assert.deepEqual(result.vars.sort(), ["BAZ", "FOO"])
      assert.equal(env.FOO, "bar")
      assert.equal(env.BAZ, "qux")
    })
  })

  test("does not overwrite values already in env (caller wins)", async () => {
    await withTmpEnv("FOO=from-file\n", async (path) => {
      const env = { FOO: "from-shell" }
      const result = loadEnvFile(path, env)
      assert.equal(env.FOO, "from-shell")
      assert.deepEqual(result.vars, [])
    })
  })

  test("strips surrounding double or single quotes", async () => {
    await withTmpEnv(`A="quoted"\nB='single'\nC=plain\n`, async (path) => {
      const env = {}
      loadEnvFile(path, env)
      assert.equal(env.A, "quoted")
      assert.equal(env.B, "single")
      assert.equal(env.C, "plain")
    })
  })

  test("skips comments and blank lines", async () => {
    await withTmpEnv("# comment\n\nA=1\n# B=2\nC=3\n", async (path) => {
      const env = {}
      loadEnvFile(path, env)
      assert.equal(env.A, "1")
      assert.equal(env.B, undefined)
      assert.equal(env.C, "3")
    })
  })

  test("ignores lines without `=` rather than throwing", async () => {
    await withTmpEnv("garbage line\nKEY=value\n", async (path) => {
      const env = {}
      loadEnvFile(path, env)
      assert.equal(env.KEY, "value")
    })
  })

  test("does NOT crash when file exists but is unreadable", async () => {
    // Regression: previously readFileSync would propagate and abort proxy
    // startup. Spec says we must degrade gracefully — file unreadable should
    // behave like file missing (proxy still starts, no vars injected).
    if (process.platform === "win32") return // POSIX-only chmod semantics
    await withTmpEnv("FOO=bar\n", async (path) => {
      try {
        await chmod(path, 0o000)
        const env = {}
        const result = loadEnvFile(path, env)
        assert.equal(result.loaded, false, "loaded should be false on read error")
        assert.notEqual(result.error, null, "error should be reported")
        assert.match(result.error.message, /EACCES|permission/i)
        assert.equal(env.FOO, undefined, "no vars should leak through on read failure")
      } finally {
        // Restore so withTmpEnv cleanup can rm
        await chmod(path, 0o600)
      }
    })
  })
})
