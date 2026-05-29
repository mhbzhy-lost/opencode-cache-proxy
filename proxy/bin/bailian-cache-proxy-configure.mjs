#!/usr/bin/env node

import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  configureOpenCodeCacheProxy,
  configureQwenCacheProxy,
  defaultOpenCodeConfigPath,
  defaultQwenSettingsPath,
} from "../src/client-config.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const defaultRepoRoot = resolve(join(here, "..", ".."))

const usage = () => `Usage:
  bailian-cache-proxy-configure.mjs [all|opencode|qwen] [options]

Options:
  --repo-root <path>                 opencode-cache-proxy repo root
  --port <number>                    local proxy port (default: 48761)
  --opencode-config <path>           opencode.json path
  --opencode-plugin-mode <mode>      plugin-list or symlink (default: plugin-list)
  --opencode-plugin-dir <path>       host-managed plugin dir for symlink mode
  --opencode-openai-upstream-base-url <url>
                                      OpenCode proxy upstream header for OpenAI-compatible route
  --opencode-marker-strategy <name>  OpenCode proxy cache marker strategy header
  --opencode-anthropic-upstream-base-url <url>
                                      OpenCode proxy upstream header for Anthropic route
  --opencode-anthropic-cache-strategy <name>
                                      OpenCode proxy Anthropic cache strategy header
  --opencode-anthropic-metadata-user-id <id>
                                      OpenCode proxy stable Anthropic metadata.user_id header
  --opencode-anthropic-models <csv>  OpenCode Anthropic model ids (default: claude-opus-4-6)
  --qwen-settings <path>             Qwen Code settings.json path
  --qwen-base-url <url>              Qwen local provider baseUrl
  --qwen-models <csv>                managed Qwen model ids
  --qwen-stale-models <csv>          stale cached Qwen model ids to remove
  --qwen-env-key <name>              Qwen provider envKey
  --qwen-context-window-size <num>   Qwen contextWindowSize
  --node-command <command>           command used in Qwen hooks (default: node)
`

const splitCsv = (value) => String(value || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)

const parseArgs = (argv) => {
  const args = [...argv]
  let client = "all"
  if (args[0] && !args[0].startsWith("-")) client = args.shift()

  const options = {}
  while (args.length > 0) {
    const key = args.shift()
    if (key === "--help" || key === "-h") return { help: true }
    const value = args.shift()
    if (!key?.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key || ""}`)
    }
    options[key.slice(2)] = value
  }
  return { client, options }
}

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(usage())
    return
  }

  const { client, options } = parsed
  if (!["all", "opencode", "qwen"].includes(client)) {
    throw new Error(`unknown client: ${client}`)
  }

  const repoRoot = resolve(options["repo-root"] || defaultRepoRoot)
  const port = options.port ? Number(options.port) : 48761
  if (!Number.isFinite(port)) throw new Error(`invalid --port: ${options.port}`)

  const results = []
  if (client === "all" || client === "opencode") {
    results.push(await configureOpenCodeCacheProxy({
      configPath: options["opencode-config"] || defaultOpenCodeConfigPath(),
      repoRoot,
      port,
      openaiUpstreamBaseUrl: options["opencode-openai-upstream-base-url"] || undefined,
      markerStrategy: options["opencode-marker-strategy"] || undefined,
      anthropicUpstreamBaseUrl: options["opencode-anthropic-upstream-base-url"] || undefined,
      anthropicCacheStrategy: options["opencode-anthropic-cache-strategy"] || undefined,
      anthropicMetadataUserId: options["opencode-anthropic-metadata-user-id"] || undefined,
      anthropicModelIds: options["opencode-anthropic-models"]
        ? splitCsv(options["opencode-anthropic-models"])
        : undefined,
      pluginMode: options["opencode-plugin-mode"] || "plugin-list",
      pluginDir: options["opencode-plugin-dir"] || null,
    }))
  }

  if (client === "all" || client === "qwen") {
    results.push(await configureQwenCacheProxy({
      settingsPath: options["qwen-settings"] || defaultQwenSettingsPath(),
      repoRoot,
      port,
      baseUrl: options["qwen-base-url"] || undefined,
      modelIds: options["qwen-models"] ? splitCsv(options["qwen-models"]) : undefined,
      staleModelIds: options["qwen-stale-models"] ? splitCsv(options["qwen-stale-models"]) : undefined,
      envKey: options["qwen-env-key"] || "BAILIAN_TOKEN_PLAN_API_KEY",
      contextWindowSize: options["qwen-context-window-size"]
        ? Number(options["qwen-context-window-size"])
        : undefined,
      nodeCommand: options["node-command"] || "node",
    }))
  }

  for (const result of results) {
    for (const message of result.messages) process.stdout.write(`${message}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`bailian-cache-proxy-configure: ${err.stack || err}\n`)
  process.exitCode = 1
})
