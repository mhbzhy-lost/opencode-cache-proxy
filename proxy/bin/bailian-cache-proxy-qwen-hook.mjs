#!/usr/bin/env node

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnvFile } from "../src/load-env.mjs"
import {
  parseHookInput,
  parsePidFileArg,
  runQwenKeepalive,
  startQwenKeepalive,
  stopQwenKeepalive,
} from "../src/qwen-lifecycle.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const envPath = join(here, "..", ".env")
loadEnvFile(envPath)

const envNumber = (name, fallback) => {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

const readStdin = async (maxBytes = envNumber("QWEN_BAILIAN_CACHE_PROXY_MAX_STDIN_BYTES", 64 * 1024)) => {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > maxBytes) {
      throw new Error(`hook input exceeds ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const main = async () => {
  const command = process.argv[2] || "start"

  if (command === "keepalive") {
    await runQwenKeepalive({ pidFile: parsePidFileArg(process.argv.slice(3)) })
    return
  }

  const hookInput = parseHookInput(await readStdin())
  if (command === "start") {
    await startQwenKeepalive({ hookInput })
    return
  }
  if (command === "stop") {
    await stopQwenKeepalive({ hookInput })
    return
  }

  process.stderr.write(
    "bailian-cache-proxy-qwen-hook: expected command start, stop, or keepalive\n",
  )
  process.exitCode = 2
}

main().catch((err) => {
  process.stderr.write(`bailian-cache-proxy-qwen-hook: ${err.stack || err}\n`)
  process.exitCode = 1
})
