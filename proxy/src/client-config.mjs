import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile, lstat, readlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { DEFAULT_CLAUDE_COMPAT_USER_AGENT } from "./anthropic-env.mjs"

const DEFAULT_PORT = 48761
const DEFAULT_OPENAI_COMPATIBLE_UPSTREAM_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const DEFAULT_ANTHROPIC_IDEALAB_UPSTREAM_BASE_URL = "https://idealab.alibaba-inc.com/api/anthropic"
const DEFAULT_MARKER_STRATEGY = "turn-stable"
const DEFAULT_ANTHROPIC_CACHE_STRATEGY = "cache"
const OPENCODE_PROVIDER_ID = "openai-compatible-cached"
const OPENCODE_ANTHROPIC_PROVIDER_ID = "anthropic-idealab-cached"
const LEGACY_OPENCODE_PROVIDER_IDS = ["bailian-cache", "bailian-custom-cached", "anthropic-cached"]
const QWEN_HOOK_START_NAME = "bailian-cache-proxy-start"
const QWEN_HOOK_STOP_NAME = "bailian-cache-proxy-stop"

const ANTHROPIC_MODEL_NAMES = {
  "claude-opus-4-6": "Claude Opus 4.6",
}

const QWEN_MODEL_NAMES = {
  "qwen3.6-plus": "Qwen 3.6 Plus (cached)",
  "qwen3.7-max": "Qwen 3.7 Max (cached)",
}

export const defaultOpenCodeConfigPath = (env = process.env) =>
  join(env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode"), "opencode.json")

export const defaultQwenSettingsPath = (env = process.env) =>
  join(env.QWEN_CONFIG_DIR || join(homedir(), ".qwen"), "settings.json")

const readJsonIfExists = async (filePath) => {
  try {
    return JSON.parse(await readFile(filePath, "utf8"))
  } catch (err) {
    if (err?.code === "ENOENT") return {}
    throw new Error(`${filePath} is not valid JSON: ${err.message || err}`)
  }
}

const writeJsonAtomic = async (filePath, value) => {
  await mkdir(dirname(filePath), { recursive: true })
  const tempPath = join(dirname(filePath), `.tmp-${process.pid}-${Date.now()}.json`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tempPath, filePath)
}

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right)

const ensureSymlink = async ({ linkPath, targetPath, messages }) => {
  await mkdir(dirname(linkPath), { recursive: true })
  try {
    const stat = await lstat(linkPath)
    if (stat.isSymbolicLink()) {
      const current = await readlink(linkPath)
      if (current === targetPath) {
        messages.push(`[ok] ${linkPath} -> ${targetPath}`)
        return false
      }
      await rm(linkPath)
      await symlink(targetPath, linkPath)
      messages.push(`[link] ${linkPath} -> ${targetPath}`)
      return true
    }
    if (stat.isDirectory()) {
      const entries = await readdir(linkPath)
      if (entries.length === 0) {
        await rm(linkPath, { recursive: true })
        await symlink(targetPath, linkPath)
        messages.push(`[link] ${linkPath} -> ${targetPath}`)
        return true
      }
    }
    messages.push(`[warn] ${linkPath} exists and is not a managed symlink; left unchanged`)
    return false
  } catch (err) {
    if (err?.code !== "ENOENT") throw err
    await symlink(targetPath, linkPath)
    messages.push(`[link] ${linkPath} -> ${targetPath}`)
    return true
  }
}

const ensureArrayIncludes = (value, item) => {
  const list = Array.isArray(value) ? [...value] : []
  if (!list.includes(item)) list.push(item)
  return list
}

export const buildOpenCodeProvider = ({
  port = DEFAULT_PORT,
  upstreamBaseUrl = DEFAULT_OPENAI_COMPATIBLE_UPSTREAM_BASE_URL,
  markerStrategy = DEFAULT_MARKER_STRATEGY,
} = {}) => ({
  npm: "@ai-sdk/openai-compatible",
  name: "OpenAI-compatible cached",
  options: {
    baseURL: `http://127.0.0.1:${port}/compatible-mode/v1`,
    headers: {
      "x-cache-proxy-upstream-base-url": upstreamBaseUrl,
      "x-cache-proxy-marker-strategy": markerStrategy,
    },
  },
  models: {
    "qwen3.6-plus": { name: "Qwen 3.6 Plus" },
    "qwen3.6-plus-nothink": { name: "Qwen 3.6 Plus (no thinking)" },
    "qwen3.6-flash": { name: "Qwen 3.6 Flash" },
    "qwen3.6-flash-nothink": { name: "Qwen 3.6 Flash (no thinking)" },
    "qwen3.7-max": { name: "Qwen 3.7 Max" },
    "qwen3.7-max-nothink": { name: "Qwen 3.7 Max (no thinking)" },
  },
})

export const buildOpenCodeAnthropicProvider = ({
  port = DEFAULT_PORT,
  existing = null,
} = {}) => ({
  npm: "@ai-sdk/anthropic",
  name: "Anthropic Idealab cached",
  options: {
    baseURL: `http://127.0.0.1:${port}/apps/anthropic/v1`,
    headers: {
      "x-cache-proxy-upstream-base-url": DEFAULT_ANTHROPIC_IDEALAB_UPSTREAM_BASE_URL,
      "x-cache-proxy-cache-strategy": DEFAULT_ANTHROPIC_CACHE_STRATEGY,
      "x-cache-proxy-upstream-user-agent": DEFAULT_CLAUDE_COMPAT_USER_AGENT,
      "x-cache-proxy-metadata-user-id": existing?.options?.headers?.["x-cache-proxy-metadata-user-id"] ||
        randomUUID(),
    },
  },
  models: Object.fromEntries(
    ["claude-opus-4-6"].map((modelId) => [modelId, { name: ANTHROPIC_MODEL_NAMES[modelId] || modelId }]),
  ),
})

export const configureOpenCodeCacheProxy = async ({
  configPath = defaultOpenCodeConfigPath(),
  repoRoot,
  port = DEFAULT_PORT,
  openaiUpstreamBaseUrl = DEFAULT_OPENAI_COMPATIBLE_UPSTREAM_BASE_URL,
  markerStrategy = DEFAULT_MARKER_STRATEGY,
  pluginMode = "plugin-list",
  pluginDir = null,
} = {}) => {
  if (!repoRoot) throw new Error("repoRoot is required")

  const messages = []
  let changed = false
  const config = await readJsonIfExists(configPath)
  const original = JSON.stringify(config)

  const providers = config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
    ? config.provider
    : {}
  if (config.provider !== providers) config.provider = providers
  const existingAnthropicProvider = providers[OPENCODE_ANTHROPIC_PROVIDER_ID] || providers["anthropic-cached"]
  for (const legacyProviderId of LEGACY_OPENCODE_PROVIDER_IDS) {
    if (providers[legacyProviderId]) {
      delete providers[legacyProviderId]
      messages.push(`[provider] removed legacy ${legacyProviderId}`)
    }
  }

  const desiredProvider = buildOpenCodeProvider({
    port,
    upstreamBaseUrl: openaiUpstreamBaseUrl,
    markerStrategy,
  })
  if (!jsonEqual(providers[OPENCODE_PROVIDER_ID], desiredProvider)) {
    providers[OPENCODE_PROVIDER_ID] = desiredProvider
    messages.push(`[provider] ${OPENCODE_PROVIDER_ID} configured`)
  } else {
    messages.push(`[provider] ${OPENCODE_PROVIDER_ID} already up to date`)
  }

  const desiredAnthropicProvider = buildOpenCodeAnthropicProvider({
    port,
    existing: existingAnthropicProvider,
  })
  if (!jsonEqual(providers[OPENCODE_ANTHROPIC_PROVIDER_ID], desiredAnthropicProvider)) {
    providers[OPENCODE_ANTHROPIC_PROVIDER_ID] = desiredAnthropicProvider
    messages.push(`[provider] ${OPENCODE_ANTHROPIC_PROVIDER_ID} configured`)
  } else {
    messages.push(`[provider] ${OPENCODE_ANTHROPIC_PROVIDER_ID} already up to date`)
  }

  const pluginSourceDir = join(repoRoot, "plugins")
  if (pluginMode === "plugin-list") {
    const nextPluginList = ensureArrayIncludes(config.plugin, pluginSourceDir)
    if (!jsonEqual(config.plugin, nextPluginList)) {
      config.plugin = nextPluginList
      messages.push(`[plugin] added ${pluginSourceDir} to opencode plugin list`)
    } else {
      messages.push(`[plugin] ${pluginSourceDir} already in opencode plugin list`)
    }
  } else if (pluginMode === "symlink") {
    if (!pluginDir) throw new Error("pluginDir is required when pluginMode=symlink")
    changed = (await ensureSymlink({
      linkPath: join(pluginDir, "bailian-cache-proxy.js"),
      targetPath: join(repoRoot, "plugins", "bailian-cache-proxy.js"),
      messages,
    })) || changed
    changed = (await ensureSymlink({
      linkPath: join(dirname(pluginDir), "proxy"),
      targetPath: join(repoRoot, "proxy"),
      messages,
    })) || changed
  } else {
    throw new Error(`unknown OpenCode plugin mode: ${pluginMode}`)
  }

  if (JSON.stringify(config) !== original) {
    await writeJsonAtomic(configPath, config)
    changed = true
    messages.push(`[write] ${configPath}`)
  } else {
    messages.push(`[ok] ${configPath} unchanged`)
  }

  return { changed, messages, configPath }
}

const qwenProviderBaseUrl = (port) => `http://127.0.0.1:${port}/v1`

const isLocalProxyBaseUrl = (baseUrl) =>
  typeof baseUrl === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/v1\/?$/.test(baseUrl)

const buildQwenProvider = ({
  modelId,
  existing = {},
  port = DEFAULT_PORT,
  baseUrl = qwenProviderBaseUrl(port),
  envKey = "BAILIAN_TOKEN_PLAN_API_KEY",
  contextWindowSize = 1000000,
} = {}) => {
  const generationConfig = {
    ...(existing && typeof existing.generationConfig === "object" ? existing.generationConfig : {}),
    enableCacheControl: true,
    contextWindowSize,
  }
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    id: modelId,
    name: QWEN_MODEL_NAMES[modelId] || `${modelId} (cached)`,
    envKey,
    baseUrl,
    generationConfig,
  }
}

const upsertNamedHook = (hooks, eventName, desiredHook) => {
  const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] : []
  let found = false
  const nextGroups = groups.map((group) => {
    const groupHooks = Array.isArray(group?.hooks) ? group.hooks : []
    const nextHooks = groupHooks.map((hook) => {
      if (hook?.name !== desiredHook.name) return hook
      found = true
      return desiredHook
    })
    return { ...group, hooks: nextHooks }
  })
  if (!found) nextGroups.push({ hooks: [desiredHook] })
  hooks[eventName] = nextGroups
}

export const configureQwenCacheProxy = async ({
  settingsPath = defaultQwenSettingsPath(),
  repoRoot,
  port = DEFAULT_PORT,
  baseUrl = qwenProviderBaseUrl(port),
  modelIds = ["qwen3.6-plus", "qwen3.7-max"],
  staleModelIds = ["qwen3-coder-plus"],
  envKey = "BAILIAN_TOKEN_PLAN_API_KEY",
  contextWindowSize = 1000000,
  nodeCommand = "node",
} = {}) => {
  if (!repoRoot) throw new Error("repoRoot is required")
  if (!Array.isArray(modelIds) || modelIds.length === 0) throw new Error("modelIds must not be empty")

  const messages = []
  const settings = await readJsonIfExists(settingsPath)
  const original = JSON.stringify(settings)

  const modelProviders = settings.modelProviders && typeof settings.modelProviders === "object"
    ? settings.modelProviders
    : {}
  settings.modelProviders = modelProviders
  const openaiProviders = Array.isArray(modelProviders.openai) ? modelProviders.openai : []
  const managedIds = new Set(modelIds)
  const staleIds = new Set(staleModelIds)
  const seen = new Set()
  const nextProviders = []

  for (const provider of openaiProviders) {
    if (!provider || typeof provider !== "object") {
      nextProviders.push(provider)
      continue
    }
    const providerId = provider.id
    if (managedIds.has(providerId)) {
      seen.add(providerId)
      nextProviders.push(buildQwenProvider({ modelId: providerId, existing: provider, port, baseUrl, envKey, contextWindowSize }))
      continue
    }
    if (staleIds.has(providerId) && provider.envKey === envKey && isLocalProxyBaseUrl(provider.baseUrl)) {
      messages.push(`[provider] removed stale Qwen model ${providerId}`)
      continue
    }
    nextProviders.push(provider)
  }

  for (const modelId of modelIds) {
    if (!seen.has(modelId)) {
      nextProviders.push(buildQwenProvider({ modelId, port, baseUrl, envKey, contextWindowSize }))
    }
  }
  modelProviders.openai = nextProviders

  const security = settings.security && typeof settings.security === "object" ? settings.security : {}
  settings.security = security
  const auth = security.auth && typeof security.auth === "object" ? security.auth : {}
  security.auth = auth
  auth.selectedType = "openai"

  const hookEntry = join(repoRoot, "proxy", "bin", "bailian-cache-proxy-qwen-hook.mjs")
  const hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {}
  settings.hooks = hooks
  upsertNamedHook(hooks, "SessionStart", {
    type: "command",
    command: `${nodeCommand} ${hookEntry} start`,
    name: QWEN_HOOK_START_NAME,
    timeout: 10000,
  })
  upsertNamedHook(hooks, "SessionEnd", {
    type: "command",
    command: `${nodeCommand} ${hookEntry} stop`,
    name: QWEN_HOOK_STOP_NAME,
    timeout: 10000,
  })

  let changed = false
  if (JSON.stringify(settings) !== original) {
    await writeJsonAtomic(settingsPath, settings)
    changed = true
    messages.push(`[write] ${settingsPath}`)
  } else {
    messages.push(`[ok] ${settingsPath} unchanged`)
  }
  return { changed, messages, settingsPath }
}
