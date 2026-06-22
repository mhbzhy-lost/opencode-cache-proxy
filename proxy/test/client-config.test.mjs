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
    assert.equal(config.provider["openai-compatible-cached"], undefined)
    assert.equal(
      config.provider["openai-bailiab-api"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
    )
    assert.equal(config.provider["openai-bailiab-api"].name, "OpenAI Bailian API")
    assert.equal(config.provider["openai-bailiab-api"].options.apiKey, undefined)
    assert.equal(
      config.provider["openai-bailiab-api"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    assert.equal(
      config.provider["openai-bailiab-api"].options.headers["x-cache-proxy-marker-strategy"],
      "turn-stable",
    )
    assert.equal(
      config.provider["openai-bailian-token-plan"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
    )
    assert.equal(config.provider["openai-bailian-token-plan"].name, "OpenAI Bailian token-plan")
    assert.equal(
      config.provider["openai-bailian-token-plan"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    )
    assert.equal(
      config.provider["openai-bailian-token-plan"].options.headers["x-cache-proxy-marker-strategy"],
      "turn-stable",
    )
    assert.equal(
      config.provider["openai-idealab"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
      "Idealab provider must go through local proxy so think-mode-rewriter can map -256k alias",
    )
    assert.equal(config.provider["openai-idealab"].name, "OpenAI Idealab")
    assert.equal(
      config.provider["openai-idealab"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://idealab.alibaba-inc.com/api/openai/v1",
    )
    assert.equal(
      config.provider["openai-idealab"].options.headers["x-cache-proxy-marker-strategy"],
      "none",
      "Idealab must not have proxy-injected cache_control markers; upstream honors its own caching if any",
    )
    const idealabModels = config.provider["openai-idealab"].models
    assert.equal(idealabModels["Qwen3.7-Max-DogFooding"].name, "Qwen 3.7 Max DogFooding")
    assert.equal(idealabModels["Qwen3.7-Max-DogFooding"].limit, undefined, "DogFooding base model must not set limit; upstream enforces its own 1M window")
    assert.ok(idealabModels["Qwen3.7-Max-DogFooding"].variants, "DogFooding model must have variants to trigger SDK cache_control markers")
    assert.equal(idealabModels["Qwen3.7-Max-DogFooding"].variants.default, undefined, "DogFooding variants must not include a 'default' key; opencode TUI auto-adds 'Default' for the base model config, so an explicit 'default' key produces a duplicate entry")
    assert.deepEqual(idealabModels["Qwen3.7-Max-DogFooding"].options, { enable_thinking: true })
    assert.deepEqual(idealabModels["Qwen3.7-Max-DogFooding"].variants.nothink, { enable_thinking: false })
    assert.equal(idealabModels["Qwen3.7-Max-DogFooding-256k"]?.name, "Qwen 3.7 Max DogFooding (256k)")
    assert.deepEqual(idealabModels["Qwen3.7-Max-DogFooding-256k"]?.limit, { context: 256000, output: 32768 })
    assert.equal(config.provider["anthropic-idealab"].npm, "@ai-sdk/anthropic")
    assert.equal(config.provider["anthropic-idealab"].name, "Anthropic Idealab")
    assert.equal(
      config.provider["anthropic-idealab"].options.baseURL,
      "http://127.0.0.1:49876/apps/anthropic/v1",
    )
    assert.equal(config.provider["anthropic-idealab"].options.apiKey, undefined)
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://idealab.alibaba-inc.com/api/anthropic",
    )
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-cache-strategy"],
      "cache",
    )
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-upstream-user-agent"],
      "claude-cli/2.1.156 (external, sdk-cli)",
    )
    assert.match(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-metadata-user-id"],
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    assert.deepEqual(Object.keys(config.provider["anthropic-idealab"].models), [
      "claude-opus-4-6-200k",
      "claude-opus-4-6-1m",
    ])
    assert.deepEqual(config.provider["anthropic-idealab"].models["claude-opus-4-6-200k"].options, {
      effort: "high",
    })
    assert.deepEqual(config.provider["anthropic-idealab"].models["claude-opus-4-6-200k"].limit, {
      context: 200000,
      output: 65536,
    })
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(config.provider["anthropic-idealab"].models)
          .map(([id, model]) => [id, model.limit.context]),
      ),
      {
        "claude-opus-4-6-200k": 200000,
        "claude-opus-4-6-1m": 1000000,
      },
    )
    assert.deepEqual(config.provider["anthropic-idealab"].models["claude-opus-4-6-200k"].variants, {
      low: { effort: "low" },
      medium: { effort: "medium" },
      high: { effort: "high" },
      max: { effort: "max" },
    })
    assert.deepEqual(Object.keys(config.provider["openai-bailiab-api"].models), [
      "qwen3.7-max",
      "qwen3.7-max-256k",
      "qwen3.7-max-512k",
      "qwen3.7-plus",
      "qwen3.7-plus-nothink",
      "qwen-latest-series-invite-beta-v34",
      "qwen-latest-series-invite-beta-v34-256k",
    ])
    assert.deepEqual(Object.keys(config.provider["openai-bailian-token-plan"].models), [
      "qwen3.7-max",
      "qwen3.7-max-256k",
      "qwen3.7-max-512k",
      "qwen3.7-plus",
      "qwen3.7-plus-nothink",
    ])
    assert.deepEqual(Object.keys(config.provider["openai-token-plan-coding"].models), [
      "qwen3.7-max",
      "qwen3.7-max-512k",
    ])
    assert.equal(config.provider["openai-token-plan-coding"].name, "OpenAI Token-plan coding")
    assert.equal(
      config.provider["openai-token-plan-coding"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
    )
    assert.equal(
      config.provider["openai-token-plan-coding"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    )
    assert.deepEqual(config.provider["openai-token-plan-coding"].models["qwen3.7-max-512k"].limit, {
      context: 512000,
      output: 65536,
    })
    assert.equal(config.provider["openai-token-plan-coding"].models["qwen3.7-max"].limit, undefined)
    assert.equal(config.provider["openai-bailiab-api"].models["qwen3.7-max"].limit, undefined, "qwen3.7-max base model must not set limit; upstream enforces its own window")
    assert.deepEqual(config.provider["openai-bailiab-api"].models["qwen3.7-max-256k"].limit, {
      context: 256000,
      output: 32768,
    })
    assert.equal(config.provider["openai-bailiab-api"].models["qwen3.7-plus"].name, "Qwen 3.7 Plus")
    assert.equal(config.provider["openai-bailiab-api"].models["qwen3.7-plus"].limit, undefined, "qwen3.7-plus base model must not set limit")
    assert.equal(config.provider["openai-bailiab-api"].models["qwen3.7-plus-nothink"].name, "Qwen 3.7 Plus (no thinking)")
    assert.equal(config.provider["openai-bailian-token-plan"].models["qwen3.7-max"].limit, undefined, "qwen3.7-max base model must not set limit; upstream enforces its own window")
    assert.deepEqual(config.provider["openai-bailian-token-plan"].models["qwen3.7-max-256k"].limit, {
      context: 256000,
      output: 32768,
    })
    assert.deepEqual(config.provider["openai-bailian-token-plan"].models["qwen3.7-max-512k"].limit, {
      context: 512000,
      output: 65536,
    })
    assert.equal(config.provider["bailian-custom-cached"], undefined)
    assert.equal(config.provider.other.name, "Other provider")

    await rm(dir, { recursive: true, force: true })
  })

  test("allows customizing OpenAI-compatible provider while keeping Anthropic Idealab fixed", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")

    const result = await configureOpenCodeCacheProxy({
      configPath,
      repoRoot,
      port: 49876,
      openaiUpstreamBaseUrl: "https://openai.example/v1",
      markerStrategy: "fraction",
      anthropicUpstreamBaseUrl: "https://anthropic.example",
      anthropicCacheStrategy: "bypass",
      anthropicMetadataUserId: "stable-user",
      anthropicModelIds: ["claude-opus-4-6", "claude-sonnet-4-6"],
    })

    const config = await readJson(configPath)

    assert.equal(result.changed, true)
    assert.equal(
      config.provider["openai-bailiab-api"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://openai.example/v1",
    )
    assert.equal(
      config.provider["openai-bailiab-api"].options.headers["x-cache-proxy-marker-strategy"],
      "fraction",
    )
    assert.equal(
      config.provider["openai-bailian-token-plan"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    )
    assert.equal(
      config.provider["openai-bailian-token-plan"].options.headers["x-cache-proxy-marker-strategy"],
      "fraction",
    )
    assert.equal(
      config.provider["openai-idealab"].options.baseURL,
      "http://127.0.0.1:49876/compatible-mode/v1",
      "Idealab provider must go through local proxy regardless of marker strategy override",
    )
    assert.equal(
      config.provider["openai-idealab"].options.headers["x-cache-proxy-marker-strategy"],
      "none",
      "Idealab must always use none strategy even when caller overrides other providers",
    )
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-upstream-base-url"],
      "https://idealab.alibaba-inc.com/api/anthropic",
    )
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-cache-strategy"],
      "cache",
    )
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-upstream-user-agent"],
      "claude-cli/2.1.156 (external, sdk-cli)",
    )
    assert.notEqual(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-metadata-user-id"],
      "stable-user",
    )
    assert.deepEqual(Object.keys(config.provider["anthropic-idealab"].models), [
      "claude-opus-4-6-200k",
      "claude-opus-4-6-1m",
    ])
    assert.deepEqual(config.provider["anthropic-idealab"].models["claude-opus-4-6-200k"].variants, {
      low: { effort: "low" },
      medium: { effort: "medium" },
      high: { effort: "high" },
      max: { effort: "max" },
    })

    await rm(dir, { recursive: true, force: true })
  })

  test("preserves an existing OpenCode Anthropic metadata user id", async () => {
    const dir = await makeTempDir()
    const configPath = join(dir, "opencode.json")
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          "anthropic-cached": {
            npm: "@ai-sdk/anthropic",
            name: "Anthropic cached",
            options: {
              baseURL: "http://127.0.0.1:48761/apps/anthropic/v1",
              headers: {
                "x-cache-proxy-metadata-user-id": "existing-stable-user",
              },
            },
            models: { "claude-opus-4-6": { name: "Claude Opus 4.6" } },
          },
        },
      }),
    )

    await configureOpenCodeCacheProxy({ configPath, repoRoot })

    const config = await readJson(configPath)
    assert.equal(config.provider["anthropic-cached"], undefined)
    assert.equal(
      config.provider["anthropic-idealab"].options.headers["x-cache-proxy-metadata-user-id"],
      "existing-stable-user",
    )

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
    assert.equal(config.provider["openai-bailiab-api"].models["qwen3.7-max"].name, "Qwen 3.7 Max")
    assert.equal(config.provider["openai-bailian-token-plan"].models["qwen3.7-max"].name, "Qwen 3.7 Max")

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
              id: "qwen3.7-plus",
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
      modelIds: ["qwen3.7-plus", "qwen3.7-max"],
    })

    const settings = await readJson(settingsPath)
    const providers = settings.modelProviders.openai
    const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]))

    assert.equal(result.changed, true)
    assert.deepEqual(settings.mcpServers, { existing: { command: "keep" } })
    assert.equal(byId["qwen3-coder-plus"], undefined)
    assert.equal(byId["deepseek-v3.2"].name, "DeepSeek")
    assert.equal(byId["qwen3.7-plus"].baseUrl, "http://127.0.0.1:49876/v1")
    assert.equal(byId["qwen3.7-plus"].generationConfig.enableCacheControl, true)
    assert.equal(byId["qwen3.7-plus"].generationConfig.contextWindowSize, 1000000)
    assert.deepEqual(byId["qwen3.7-plus"].generationConfig.extra_body, { enable_thinking: true })
    assert.equal(byId["qwen3.7-max"].name, "Qwen 3.7 Max")
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
