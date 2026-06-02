import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..")
const installScript = join(repoRoot, "install-opencode.sh")

const makeTempDir = () => mkdtemp(join(tmpdir(), "bailian-install-opencode-"))

test("install-opencode.sh configures OpenCode without requiring auth in --no-auth mode", async () => {
  const dir = await makeTempDir()
  const configPath = join(dir, "opencode.json")

  const result = spawnSync("bash", [
    installScript,
    "--no-auth",
    "--opencode-config",
    configPath,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)

  const config = JSON.parse(await readFile(configPath, "utf8"))
  assert.equal(config.provider["openai-compatible-cached"], undefined)
  assert.equal(
    config.provider["openai-bailiab-api"].options.baseURL,
    "http://127.0.0.1:48761/compatible-mode/v1",
  )
  assert.equal(
    config.provider["openai-bailian-token-plan"].options.baseURL,
    "http://127.0.0.1:48761/compatible-mode/v1",
  )
  assert.equal(
    config.provider["openai-bailian-token-plan"].options.headers["x-cache-proxy-upstream-base-url"],
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  )
  assert.equal(
    config.provider["anthropic-idealab-cached"].options.baseURL,
    "http://127.0.0.1:48761/apps/anthropic/v1",
  )
  assert.deepEqual(Object.keys(config.provider["anthropic-idealab-cached"].models), [
    "claude-opus-4-6",
    "claude-opus-4-6-200k",
    "claude-opus-4-6-300k",
    "claude-opus-4-6-500k",
    "claude-opus-4-6-1m",
  ])
  assert.ok(config.plugin.includes(join(repoRoot, "plugins")))
  assert.match(result.stdout, /OpenCode cache proxy configured/)

  await rm(dir, { recursive: true, force: true })
})
