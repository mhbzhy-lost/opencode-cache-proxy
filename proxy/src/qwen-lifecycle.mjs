import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PROXY_PORT = "48761"
const DEFAULT_STARTUP_ATTEMPTS = 20
const DEFAULT_STARTUP_POLL_MS = 250
const DISABLED_VALUES = new Set(["0", "false", "no", "off"])

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROXY_ENTRY = join(here, "..", "bin", "bailian-cache-proxy.mjs")

const isDisabled = (env) =>
  DISABLED_VALUES.has(String(env.QWEN_BAILIAN_CACHE_PROXY || "").trim().toLowerCase())

export const proxyBaseUrl = (env = process.env) => {
  const host = env.BAILIAN_CACHE_PROXY_HOST || "127.0.0.1"
  const port = env.BAILIAN_CACHE_PROXY_PORT || DEFAULT_PROXY_PORT
  return `http://${host}:${port}`
}

export const healthCheck = async ({ fetchImpl = fetch, env = process.env } = {}) => {
  try {
    const response = await fetchImpl(`${proxyBaseUrl(env)}/__bailian_cache_proxy/health`)
    return response.ok
  } catch {
    return false
  }
}

const attachChildLogging = (child, logger, { logStderr = true } = {}) => {
  child.on?.("error", (err) => {
    logger.error?.(`bailian-cache-proxy qwen lifecycle: ${err.message || err}`)
  })
  if (!logStderr) return
  child.stderr?.on?.("data", (chunk) => {
    const text = String(chunk).trim()
    if (text) logger.error?.(`bailian-cache-proxy qwen lifecycle stderr: ${text}`)
  })
}

const normalizeStdioForLogging = (stdio, logStderr, stderrTarget = "ignore") => {
  if (logStderr) return stdio
  if (typeof stdio === "string") return ["ignore", "ignore", stderrTarget]
  if (Array.isArray(stdio)) {
    const normalized = [...stdio]
    if (stderrTarget !== "ignore" || normalized[2] === "pipe") {
      normalized[2] = stderrTarget
    }
    return normalized
  }
  return stdio
}

const openStderrLogFile = (stderrLogPath, logger) => {
  if (!stderrLogPath) return null
  try {
    return openSync(stderrLogPath, "a")
  } catch (err) {
    logger.warn?.(
      `bailian-cache-proxy qwen lifecycle: cannot open stderr log: ${err.message || err}`,
    )
    return null
  }
}

const closeStderrLogFile = (fd) => {
  if (fd === null) return
  try {
    closeSync(fd)
  } catch {
    // The child has already been spawned; losing the parent fd close is non-fatal.
  }
}

export const startProxyProcess = ({
  spawnImpl = spawn,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  env = process.env,
  logger = console,
  stdio = ["ignore", "ignore", "pipe"],
  logStderr = true,
  stderrLogPath,
} = {}) => {
  const stderrLogFd = logStderr ? null : openStderrLogFile(stderrLogPath, logger)
  const childStdio = normalizeStdioForLogging(stdio, logStderr, stderrLogFd ?? "ignore")
  let child
  try {
    child = spawnImpl(nodeBin, [proxyEntry], {
      detached: true,
      stdio: childStdio,
      env: {
        ...env,
        BAILIAN_CACHE_PROXY_IDLE_EXIT_MS: env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS || "0",
      },
    })
  } finally {
    closeStderrLogFile(stderrLogFd)
  }
  attachChildLogging(child, logger, { logStderr })
  child.unref?.()
  return child
}

export const ensureProxyRunning = async ({
  fetchImpl = fetch,
  spawnImpl = spawn,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  env = process.env,
  logger = console,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  startupAttempts = DEFAULT_STARTUP_ATTEMPTS,
  startupPollMs = DEFAULT_STARTUP_POLL_MS,
  stdio,
  logStderr,
  stderrLogPath,
} = {}) => {
  if (await healthCheck({ fetchImpl, env })) return { status: "already-running" }

  const child = startProxyProcess({
    spawnImpl,
    nodeBin,
    proxyEntry,
    env,
    logger,
    stdio,
    logStderr,
    stderrLogPath,
  })
  let childExit = null
  child.once?.("exit", (code, signal) => {
    childExit = { code, signal }
  })

  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    if (await healthCheck({ fetchImpl, env })) {
      return { status: "started", pid: child.pid ?? null }
    }
    if (childExit) {
      throw new Error(
        `proxy exited during startup (code=${childExit.code ?? "null"}, signal=${childExit.signal ?? "null"})`,
      )
    }
    await sleep(startupPollMs)
  }
  throw new Error(`proxy did not become healthy after ${startupAttempts} checks`)
}

export const startQwenKeepalive = async ({
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  logger = console,
  sleep,
  startupAttempts,
  startupPollMs,
} = {}) => {
  if (isDisabled(env)) return { status: "disabled" }
  return ensureProxyRunning({
    fetchImpl,
    spawnImpl,
    nodeBin,
    proxyEntry,
    env,
    logger,
    sleep,
    startupAttempts,
    startupPollMs,
    stdio: ["ignore", "ignore", "ignore"],
    logStderr: false,
  })
}

export const stopQwenKeepalive = async () => ({ status: "noop" })

export const parseHookInput = (raw, logger = console) => {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch (err) {
    logger.warn?.(`bailian-cache-proxy qwen hook: invalid hook JSON (${err.message || err})`)
    return {}
  }
}
