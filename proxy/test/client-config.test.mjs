import assert from "node:assert/strict"
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, test } from "node:test"

import {
  configureOpenCodeCacheProxy,
  configureQwenCacheProxy,
} from "../src/client-config.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, "..", "..")

const makeTempDir = () => mkdtemp(join(tmpdir(), "bailian-client-config-"))

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"))

describe("client cache proxy configuration", () => {
  test("configures standalone OpenCode provider and plugin list", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")
    await writeFile(
      configPath,
      JSON.stringify({
        plugin: ["/existing/plugin"],
        provider: {
          "bailian-custom-cached": { name: "Old Bailian provider" },
          other: { name: "Other provider" },
        },
      }),
    )

    const result = await configureOpenCodeCacheProxy({
      configPath,
      repoRoot,
      port: 49876,
    })

    const config = await readJson(configPath)
    assert.equal(result.changed, true)
    assert.deepEqual(config.plugin, ["/existing/plugin", join(repoRoot, "plugins")])
    assert.equal(
      config.provider["openai-compatible-cached"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
    )
    assert.equal(config.provider["openai-compatible-cached"].name, "OpenAI-compatible cached")
    assert.equal(config.provider["openai-compatible-cached"].options.apiKey, "{env:OPENAI_COMPATIBLE_API_KEY}")
    assert.deepEqual(Object.keys(config.provider["openai-compatible-cached"].models), [
      "qwen3.6-plus",
      "qwen3.6-plus-nothink",
      "qwen3.6-flash",
      "qwen3.6-flash-nothink",
      "qwen3.7-max",
      "qwen3.7-max-nothink",
    ])
    assert.equal(config.provider["bailian-custom-cached"], undefined)
    assert.equal(config.provider.other.name, "Other provider")

    await rm(dir, { recursive: true, force: true })
  })

  test("can install OpenCode plugin and proxy symlinks into a host-managed directory", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")
    const pluginDir = join(dir, "opencode", "plugins")

    const result = await configureOpenCodeCacheProxy({
      configPath,
      repoRoot,
      pluginMode: "symlink",
      pluginDir,
    })

    const config = await readJson(configPath)
    const pluginLink = await lstat(join(pluginDir, "bailian-cache-proxy.js"))
    const proxyLink = await lstat(join(dir, "opencode", "proxy"))

    assert.equal(result.changed, true)
    assert.equal(config.plugin, undefined)
    assert.equal(pluginLink.isSymbolicLink(), true)
    assert.equal(proxyLink.isSymbolicLink(), true)
    assert.equal(config.provider["openai-compatible-cached"].models["qwen3.7-max"].name, "Qwen 3.7 Max")

    await rm(dir, { recursive: true, force: true })
  })

  test("configures Qwen Code cached OpenAI providers and lifecycle hooks", async () => {
    const dir = await makeTempDir()
    const settingsPath = join(dir, "settings.json")
    await writeFile(
      settingsPath,
      JSON.stringify({
        mcpServers: { existing: { command: "keep" } },
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "echo keep", name: "keep" }],
            },
          ],
        },
        modelProviders: {
          openai: [
            {
              id: "qwen3.6-plus",
              name: "Existing Qwen",
              envKey: "BAILIAN_TOKEN_PLAN_API_KEY",
              baseUrl: "https://example.invalid/v1",
              generationConfig: {
                extra_body: { enable_thinking: true },
              },
            },
            {
              id: "qwen3-coder-plus",
              name: "Old cached Qwen",
              envKey: "BAILIAN_TOKEN_PLAN_API_KEY",
              baseUrl: "http://127.0.0.1:48761/v1",
              generationConfig: { enableCacheControl: true },
            },
            {
              id: "deepseek-v3.2",
              name: "DeepSeek",
              envKey: "BAILIAN_TOKEN_PLAN_API_KEY",
              baseUrl: "https://example.invalid/v1",
            },
          ],
        },
        security: { auth: { selectedType: "other" } },
      }),
    )

    const result = await configureQwenCacheProxy({
      settingsPath,
      repoRoot,
      port: 49876,
      modelIds: ["qwen3.6-plus", "qwen3.7-max"],
    })

    const settings = await readJson(settingsPath)
    const providers = settings.modelProviders.openai
    const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]))

    assert.equal(result.changed, true)
    assert.deepEqual(settings.mcpServers, { existing: { command: "keep" } })
    assert.equal(byId["qwen3-coder-plus"], undefined)
    assert.equal(byId["deepseek-v3.2"].name, "DeepSeek")
    assert.equal(byId["qwen3.6-plus"].baseUrl, "http://127.0.0.1:49876/v1")
    assert.equal(byId["qwen3.6-plus"].generationConfig.enableCacheControl, true)
    assert.equal(byId["qwen3.6-plus"].generationConfig.contextWindowSize, 1000000)
    assert.deepEqual(byId["qwen3.6-plus"].generationConfig.extra_body, { enable_thinking: true })
    assert.equal(byId["qwen3.7-max"].name, "Qwen 3.7 Max (cached)")
    assert.equal(settings.security.auth.selectedType, "openai")
    assert.equal(settings.hooks.SessionStart.length, 2)
    assert.equal(
      settings.hooks.SessionStart[1].hooks[0].command,
      `node ${join(repoRoot, "proxy", "bin", "bailian-cache-proxy-qwen-hook.mjs")} start`,
    )
    assert.equal(settings.hooks.SessionEnd[0].hooks[0].name, "bailian-cache-proxy-stop")

    await rm(dir, { recursive: true, force: true })
  })
})
