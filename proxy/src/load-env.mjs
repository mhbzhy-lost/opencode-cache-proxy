/**
 * Tiny .env loader: reads KEY=VAL lines into process.env without overwriting
 * existing values. Quoted values (single/double) are unwrapped. Lines starting
 * with `#` and blank lines are skipped.
 *
 * **CAUTION — synchronous I/O.** This function uses readFileSync and is meant
 * for one-shot startup work only. Do **not** call it from request handlers,
 * tool.execute hooks, or any hot path — it will block the Node event loop.
 *
 * Used by:
 *   - bin/bailian-cache-proxy.mjs   so the proxy is self-sufficient when
 *                                   spawned by the OpenCode plugin (the
 *                                   OpenCode process env may not carry
 *                                   DASHSCOPE_API_KEY / DASHSCOPE_BASE_URL).
 *   - scripts/e2e-bailian-cache.mjs so manual e2e runs pick up the same .env.
 */

import { existsSync, readFileSync } from "node:fs"

export const loadEnvFile = (envPath, env = process.env) => {
  if (!envPath || !existsSync(envPath)) {
    return { loaded: false, vars: [], error: null }
  }
  let raw
  try {
    raw = readFileSync(envPath, "utf8")
  } catch (err) {
    // Permission denied / IO error must NOT crash the proxy. Surface a
    // diagnostic so the caller can log it, then degrade to the same posture
    // as if the file were missing — proxy still starts, fallback paths still
    // work, just no creds injected from disk.
    return { loaded: false, vars: [], error: err }
  }
  const vars = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    const [, key, valueRaw] = match
    let value = valueRaw.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (env[key] === undefined) {
      env[key] = value
      vars.push(key)
    }
  }
  return { loaded: true, vars, error: null }
}
