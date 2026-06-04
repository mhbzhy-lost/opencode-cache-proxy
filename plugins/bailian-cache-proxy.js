/**
 * Starts the OpenAI-compatible cache proxy and keeps it alive while OpenCode runs.
 *
 * Only the configured cached provider points at this local proxy; unrelated
 * OpenCode providers keep using their original upstreams.
 */

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const disabledValues = new Set(["0", "false", "no", "off"])
const defaultPort = "48761"

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
    env: {
      ...process.env,
      BAILIAN_CACHE_PROXY_IDLE_EXIT_MS: process.env.BAILIAN_CACHE_PROXY_IDLE_EXIT_MS || "0",
    },
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
} = {}) => async ({ client }) => {
  if (isDisabled()) {
    await log(client, "info", "disabled by OPENCODE_BAILIAN_CACHE_PROXY")
    return {}
  }

  if (!(await healthCheck(fetchImpl))) {
    startProxy({ client, spawnImpl })
  }

  await log(client, "info", "proxy ensured", {
    baseUrl: proxyBaseUrl(),
  })

  return {}
}

export const BailianCacheProxyPlugin = createBailianCacheProxyPlugin()
