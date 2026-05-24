import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PROXY_PORT = "48761"
const DEFAULT_STARTUP_ATTEMPTS = 20
const DEFAULT_STARTUP_POLL_MS = 250
const DEFAULT_KEEPALIVE_MS = 15_000
const DISABLED_VALUES = new Set(["0", "false", "no", "off"])

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROXY_ENTRY = join(here, "..", "bin", "bailian-cache-proxy.mjs")
const DEFAULT_QWEN_HOOK_ENTRY = join(here, "..", "bin", "bailian-cache-proxy-qwen-hook.mjs")

const isDisabled = (env) =>
  DISABLED_VALUES.has(String(env.QWEN_BAILIAN_CACHE_PROXY || "").trim().toLowerCase())

const envNumber = (env, name, fallback) => {
  const raw = env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const defaultStateDir = (env = process.env) =>
  env.BAILIAN_CACHE_PROXY_STATE_DIR ||
  join(env.XDG_RUNTIME_DIR || env.TMPDIR || tmpdir(), "bailian-cache-proxy")

export const qwenSessionKey = (hookInput = {}) => {
  const raw =
    hookInput.session_id ||
    hookInput.transcript_path ||
    hookInput.cwd ||
    hookInput.source ||
    "default"
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16)
}

export const qwenPidFilePath = ({ hookInput = {}, stateDir = defaultStateDir() } = {}) =>
  join(stateDir, `qwen-${qwenSessionKey(hookInput)}.pid`)

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

export const sendHeartbeat = async ({
  fetchImpl = fetch,
  env = process.env,
  pid = process.pid,
} = {}) => {
  const response = await fetchImpl(`${proxyBaseUrl(env)}/__bailian_cache_proxy/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid }),
  })
  return response.ok
}

export const pidIsAlive = (pid, killImpl = process.kill) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    killImpl(pid, 0)
    return true
  } catch {
    return false
  }
}

const readPidFile = async (pidFile) => {
  try {
    const raw = await readFile(pidFile, "utf8")
    const pid = Number(raw.trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const acquireStartLock = async (lockFile, openImpl = open) => {
  try {
    return await openImpl(lockFile, "wx")
  } catch (err) {
    if (err?.code === "EEXIST") return null
    throw err
  }
}

const attachChildLogging = (child, logger) => {
  child.on?.("error", (err) => {
    logger.error?.(`bailian-cache-proxy qwen lifecycle: ${err.message || err}`)
  })
  child.stderr?.on?.("data", (chunk) => {
    const text = String(chunk).trim()
    if (text) logger.error?.(`bailian-cache-proxy qwen lifecycle stderr: ${text}`)
  })
}

export const startProxyProcess = ({
  spawnImpl = spawn,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  env = process.env,
  logger = console,
} = {}) => {
  const child = spawnImpl(nodeBin, [proxyEntry], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  })
  attachChildLogging(child, logger)
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
} = {}) => {
  if (await healthCheck({ fetchImpl, env })) return { status: "already-running" }

  const child = startProxyProcess({ spawnImpl, nodeBin, proxyEntry, env, logger })
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
  hookInput = {},
  stateDir = defaultStateDir(),
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  killImpl = process.kill,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  keepaliveEntry = DEFAULT_QWEN_HOOK_ENTRY,
  logger = console,
  sleep,
  startupAttempts,
  startupPollMs,
  writePidFileImpl = writeFile,
  openLockFileImpl = open,
} = {}) => {
  const pidFile = qwenPidFilePath({ hookInput, stateDir })
  if (isDisabled(env)) return { status: "disabled", pidFile }

  const existingPid = await readPidFile(pidFile)
  if (pidIsAlive(existingPid, killImpl)) {
    return { status: "already-running", pid: existingPid, pidFile }
  }

  await mkdir(dirname(pidFile), { recursive: true })
  const lockFile = `${pidFile}.lock`
  const lockHandle = await acquireStartLock(lockFile, openLockFileImpl)
  if (!lockHandle) {
    return { status: "starting", pid: null, pidFile }
  }

  try {
    await ensureProxyRunning({
      fetchImpl,
      spawnImpl,
      nodeBin,
      proxyEntry,
      env,
      logger,
      sleep,
      startupAttempts,
      startupPollMs,
    })

    const child = spawnImpl(nodeBin, [keepaliveEntry, "keepalive", "--pid-file", pidFile], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env,
    })
    attachChildLogging(child, logger)
    child.unref?.()

    const pid = child.pid ?? null
    if (pid) {
      try {
        await writePidFileImpl(pidFile, `${pid}\n`)
      } catch (err) {
        try {
          killImpl(pid, "SIGTERM")
        } catch {
          // The child may have exited between spawn and rollback.
        }
        throw err
      }
    }
    return { status: "started", pid, pidFile }
  } finally {
    await Promise.resolve(lockHandle.close?.()).catch(() => {})
    await unlink(lockFile).catch(() => {})
  }
}

export const stopQwenKeepalive = async ({
  hookInput = {},
  stateDir = defaultStateDir(),
  killImpl = process.kill,
} = {}) => {
  const pidFile = qwenPidFilePath({ hookInput, stateDir })
  const pid = await readPidFile(pidFile)
  if (pid) {
    try {
      killImpl(pid, "SIGTERM")
    } catch {
      // Stale pidfiles should not make SessionEnd fail.
    }
  }
  await unlink(pidFile).catch(() => {})
  return { status: pid ? "stopped" : "not-running", pid, pidFile }
}

export const runQwenKeepalive = async ({
  pidFile,
  env = process.env,
  fetchImpl = fetch,
  spawnImpl = spawn,
  nodeBin = process.execPath,
  proxyEntry = DEFAULT_PROXY_ENTRY,
  logger = console,
  intervalMs = envNumber(env, "QWEN_BAILIAN_CACHE_PROXY_HEARTBEAT_MS", DEFAULT_KEEPALIVE_MS),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  signalTarget = process,
  unlinkImpl = unlink,
  once = false,
} = {}) => {
  if (!pidFile) throw new Error("--pid-file is required")
  await mkdir(dirname(pidFile), { recursive: true })
  await writeFile(pidFile, `${process.pid}\n`)

  const beat = async () => {
    try {
      await ensureProxyRunning({ fetchImpl, spawnImpl, nodeBin, proxyEntry, env, logger })
      await sendHeartbeat({ fetchImpl, env, pid: process.pid })
    } catch (err) {
      logger.warn?.(`bailian-cache-proxy qwen keepalive failed: ${err.message || err}`)
    }
  }

  let isBeating = false
  const scheduleBeat = async () => {
    if (isBeating) return
    isBeating = true
    try {
      await beat()
    } finally {
      isBeating = false
    }
  }

  await scheduleBeat()
  if (once) return

  await new Promise((resolve) => {
    const timer = setIntervalImpl(() => {
      void scheduleBeat()
    }, intervalMs)
    timer.unref?.()

    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearIntervalImpl(timer)
      void unlinkImpl(pidFile).catch(() => {}).finally(resolve)
    }

    signalTarget.once("SIGTERM", finish)
    signalTarget.once("SIGINT", finish)
  })
}

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

export const parsePidFileArg = (argv) => {
  const idx = argv.indexOf("--pid-file")
  if (idx === -1 || !argv[idx + 1]) return null
  return argv[idx + 1]
}
