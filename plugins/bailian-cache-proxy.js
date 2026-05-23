/**
 * Starts the Bailian-only cache proxy and keeps it alive while OpenCode runs.
 *
 * The proxy is intentionally not a generic provider proxy: only the
 * `bailian-custom-cached` provider configured by init_opencode.sh points at it.
 */

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const disabledValues = new Set(["0", "false", "no", "off"])
const defaultPort = "48761"
const heartbeatMs = 15_000

const isDisabled = () =>
  disabledValues.has(String(process.env.OPENCODE_BAILIAN_CACHE_PROXY || "").trim().toLowerCase())

const log = async (client, level, message, extra = {}) => {
  try {
    await client.app.log({
      body: {
        service: "bailian-cache-proxy",
        level,
        message,
        extra,
      },
    })
  } catch {
    // OpenCode may not have logging available during early plugin startup.
  }
}

const proxyBaseUrl = () => {
  const host = process.env.BAILIAN_CACHE_PROXY_HOST || "127.0.0.1"
  const port = process.env.BAILIAN_CACHE_PROXY_PORT || defaultPort
  return `http://${host}:${port}`
}

const healthCheck = async (fetchImpl = fetch) => {
  try {
    const response = await fetchImpl(`${proxyBaseUrl()}/__bailian_cache_proxy/health`)
    return response.ok
  } catch {
    return false
  }
}

const heartbeat = async (fetchImpl = fetch) => {
  const response = await fetchImpl(`${proxyBaseUrl()}/__bailian_cache_proxy/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pid: process.pid }),
  })
  return response.ok
}

const startProxy = ({ client, spawnImpl = spawn }) => {
  const proxyEntry = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "proxy",
    "bin",
    "bailian-cache-proxy.mjs",
  )
  const nodeBin = process.env.OPENCODE_BAILIAN_CACHE_PROXY_NODE || "node"
  const child = spawnImpl(nodeBin, [proxyEntry], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  })
  child.on("error", (err) => {
    log(client, "error", `failed to start proxy: ${err.message}`)
  })
  child.stderr?.on?.("data", (chunk) => {
    log(client, "error", `proxy stderr: ${String(chunk).trim()}`)
  })
  child.unref()
}

export const createBailianCacheProxyPlugin = ({
  fetchImpl = fetch,
  spawnImpl = spawn,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setIntervalImpl = setInterval,
  maxHeartbeatAttempts = 20,
} = {}) => async ({ client }) => {
  if (isDisabled()) {
    await log(client, "info", "disabled by OPENCODE_BAILIAN_CACHE_PROXY")
    return {}
  }

  if (!(await healthCheck(fetchImpl))) {
    startProxy({ client, spawnImpl })
  }

  let attempts = 0
  while (attempts < maxHeartbeatAttempts) {
    attempts += 1
    if (await heartbeat(fetchImpl)) break
    await sleep(250)
  }

  const timer = setIntervalImpl(async () => {
    try {
      await heartbeat(fetchImpl)
    } catch (err) {
      log(client, "warn", "heartbeat failed", { error: err.message })
    }
  }, heartbeatMs)
  timer.unref?.()

  await log(client, "info", "heartbeat registered", {
    pid: process.pid,
    baseUrl: proxyBaseUrl(),
  })

  return {}
}

export const BailianCacheProxyPlugin = createBailianCacheProxyPlugin()
