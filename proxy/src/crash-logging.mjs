import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { inspect } from "node:util"

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
}

const MAX_STDERR_MESSAGE_BYTES = 8 * 1024

export const defaultCrashLogPath = (env = process.env) => {
  // resolve() canonicalizes path traversal (e.g. $XDG_CACHE_HOME/../etc).
  const cacheRoot = resolve(env.XDG_CACHE_HOME || join(homedir(), ".cache"))
  return join(cacheRoot, "bailian-cache-proxy", "crash.log")
}

const safeStringify = (value) => {
  if (value === null || value === undefined) return String(value)
  try {
    if (value instanceof Error && value.stack) return value.stack
    return inspect(value, { depth: 2, maxArrayLength: 8, maxStringLength: 2048 })
  } catch {
    return String(value)
  }
}

export const crashLog = (tag, err, logPath = defaultCrashLogPath(), {
  mkdirImpl = mkdirSync,
  appendImpl = appendFileSync,
} = {}) => {
  const ts = new Date().toISOString()
  const stack = safeStringify(err)
  try {
    mkdirImpl(dirname(logPath), { recursive: true })
    appendImpl(logPath, `[${ts}] ${tag}: ${stack}\n`)
    return true
  } catch {
    return false
  }
}

export const setupCrashHandlers = ({
  proc = process,
  logPath = defaultCrashLogPath(),
} = {}) => {
  const writeStderr = (message) => {
    // Cap size to avoid blocking stderr on huge dumps (circular objects,
    // giant buffers). Use safeStringify for non-Error inputs.
    const safeMsg = typeof message === "string"
      ? message.slice(0, MAX_STDERR_MESSAGE_BYTES)
      : safeStringify(message).slice(0, MAX_STDERR_MESSAGE_BYTES)
    try {
      proc.stderr?.write?.(safeMsg + "\n")
    } catch {
      // stderr may already be broken; do not let this throw.
    }
  }

  proc.on("uncaughtException", (err) => {
    crashLog("uncaughtException", err, logPath)
    writeStderr(`[crash] uncaughtException: ${safeStringify(err)}`)
    proc.exit(1)
  })

  proc.on("unhandledRejection", (reason) => {
    crashLog("unhandledRejection", reason, logPath)
    writeStderr(`[crash] unhandledRejection: ${safeStringify(reason)}`)
    proc.exit(1)
  })

  for (const sig of Object.keys(SIGNAL_EXIT_CODES)) {
    proc.on(sig, () => {
      crashLog(`signal:${sig}`, `pid=${proc.pid} ppid=${proc.ppid}`, logPath)
      writeStderr(`[crash] received ${sig} (pid=${proc.pid}, ppid=${proc.ppid})`)
      proc.exit(SIGNAL_EXIT_CODES[sig])
    })
  }

  proc.on("exit", (code) => {
    writeStderr(`[exit] code=${code} pid=${proc.pid}`)
  })
}
