import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { describe, test } from "node:test"

import {
  listOpenCodeProviderChoices,
  readApiKey,
  writeOpenCodeCredential,
} from "../src/opencode-auth.mjs"

const makeTempDir = () => mkdtemp(join(tmpdir(), "opencode-auth-"))
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))

const makeTtyInput = () => {
  const input = new EventEmitter()
  input.isTTY = true
  input.isRaw = false
  input.rawModes = []
  input.resumeCalls = 0
  input.pauseCalls = 0
  input.setRawMode = (value) => {
    input.isRaw = value
    input.rawModes.push(value)
    return input
  }
  input.resume = () => {
    input.resumeCalls += 1
    return input
  }
  input.pause = () => {
    input.pauseCalls += 1
    return input
  }
  return input
}

const runNode = (args, { input = "" } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("close", (status) => resolve({ status, stdout, stderr }))
  child.stdin.end(input)
})

describe("OpenCode auth bootstrap", () => {
  test("lists providers from existing OpenCode config", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")
    await writeFile(configPath, JSON.stringify({
      provider: {
        "openai-compatible-cached": { name: "OpenAI-compatible cached", npm: "@ai-sdk/openai-compatible" },
        "anthropic-cached": { name: "Anthropic cached", npm: "@ai-sdk/anthropic" },
      },
    }))

    const choices = await listOpenCodeProviderChoices({ configPath })

    assert.deepEqual(choices, [
      { id: "anthropic-cached", name: "Anthropic cached", npm: "@ai-sdk/anthropic" },
      { id: "openai-compatible-cached", name: "OpenAI-compatible cached", npm: "@ai-sdk/openai-compatible" },
    ])

    await rm(dir, { recursive: true, force: true })
  })

  test("writes a provider api key while preserving existing auth entries", async () => {
    const dir = await makeTempDir()
    const authPath = join(dir, "auth.json")
    await writeFile(authPath, JSON.stringify({
      deepseek: { type: "api", key: "sk-deepseek" },
    }))
    await chmod(authPath, 0o644)

    const result = await writeOpenCodeCredential({
      authPath,
      providerId: "anthropic-cached",
      apiKey: "sk-anthropic",
    })

    const auth = await readJson(authPath)
    const mode = (await stat(authPath)).mode & 0o777
    assert.equal(result.providerId, "anthropic-cached")
    assert.deepEqual(auth, {
      deepseek: { type: "api", key: "sk-deepseek" },
      "anthropic-cached": { type: "api", key: "sk-anthropic" },
    })
    assert.equal(mode, 0o600)

    await rm(dir, { recursive: true, force: true })
  })

  test("serializes concurrent credential writes without dropping entries", async () => {
    const dir = await makeTempDir()
    const authPath = join(dir, "auth.json")

    await Promise.all(Array.from({ length: 12 }, (_, index) => writeOpenCodeCredential({
      authPath,
      providerId: `provider-${index}`,
      apiKey: `sk-${index}`,
    })))

    const auth = await readJson(authPath)
    assert.equal(Object.keys(auth).length, 12)
    for (let index = 0; index < 12; index += 1) {
      assert.deepEqual(auth[`provider-${index}`], { type: "api", key: `sk-${index}` })
    }

    await rm(dir, { recursive: true, force: true })
  })

  test("TTY API key input resumes stdin and does not echo typed characters", async () => {
    const input = makeTtyInput()
    let stdout = ""
    const output = { write: (chunk) => { stdout += chunk } }

    const apiKeyPromise = readApiKey({ providerId: "anthropic-cached", input, output })

    assert.equal(input.resumeCalls, 1)
    input.emit("keypress", "s", {})
    input.emit("keypress", "k", {})
    input.emit("keypress", "-", {})
    input.emit("keypress", "test", {})
    input.emit("keypress", "\r", { name: "return" })

    assert.equal(await apiKeyPromise, "sk-test")
    assert.deepEqual(input.rawModes, [true, false])
    assert.match(stdout, /API key for anthropic-cached:/)
    assert.doesNotMatch(stdout, /sk-test/)
  })

  test("TTY API key input restores terminal state on SIGINT", async () => {
    const input = makeTtyInput()
    const signalTarget = new EventEmitter()
    input.isPaused = () => true
    const output = { write: () => {} }

    const apiKeyPromise = readApiKey({
      providerId: "anthropic-cached",
      input,
      output,
      signalTarget,
    })

    signalTarget.emit("SIGINT")

    await assert.rejects(apiKeyPromise, /cancelled/)
    assert.deepEqual(input.rawModes, [true, false])
    assert.equal(input.pauseCalls, 1)
    assert.equal(signalTarget.listenerCount("SIGINT"), 0)
  })

  test("interactive CLI lets the user select a provider and enter a key", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")
    const authPath = join(dir, "auth.json")
    await writeFile(configPath, JSON.stringify({
      provider: {
        "openai-compatible-cached": { name: "OpenAI-compatible cached", npm: "@ai-sdk/openai-compatible" },
        "anthropic-cached": { name: "Anthropic cached", npm: "@ai-sdk/anthropic" },
      },
    }))

    const result = await runNode([
      new URL("../bin/opencode-cache-proxy-auth.mjs", import.meta.url).pathname,
      "--opencode-config",
      configPath,
      "--auth-path",
      authPath,
    ], { input: "1\nsk-interactive\n" })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /1\. anthropic-cached/)
    assert.match(result.stdout, /credential stored for anthropic-cached/)
    const auth = await readJson(authPath)
    assert.equal(auth["anthropic-cached"].key, "sk-interactive")

    await rm(dir, { recursive: true, force: true })
  })
})
