import { processPidIsAlive } from "./lifecycle.mjs"

const DEFAULT_THRESHOLD_MS = 4 * 60 * 1000 + 30 * 1000  // 4.5 minutes
const DEFAULT_SCAN_INTERVAL_MS = 30_000
const DEFAULT_MAX_KEYS = 8
const DEFAULT_MIN_HITS = 2

export const createKeepaliveManager = ({
  thresholdMs = DEFAULT_THRESHOLD_MS,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  maxKeys = DEFAULT_MAX_KEYS,
  minHits = DEFAULT_MIN_HITS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  pidIsAlive = processPidIsAlive,
  logger = console,
  onKeepaliveSent = () => {},
  enabled = true,
} = {}) => {
  const activeKeys = new Map()

  const evictLru = () => {
    if (activeKeys.size === 0) return
    const lruKey = [...activeKeys.entries()]
      .reduce((min, [k, v]) => (!min || v.lastHitAt < min[1].lastHitAt ? [k, v] : min), null)?.[0]
    if (lruKey) activeKeys.delete(lruKey)
  }

  const registerHit = ({ sessionKey, pid, truncatedBody, model, url, authHeader }) => {
    if (!enabled) return
    if (!sessionKey || !truncatedBody) return

    let entry = activeKeys.get(sessionKey)
    if (!entry) {
      if (activeKeys.size >= maxKeys) evictLru()
      entry = {
        sessionKey,
        lastHitAt: 0,
        truncatedBody: null,
        model: null,
        url: null,
        authHeader: null,
        clients: new Set(),
        totalHits: 0,
        keepaliveSent: false,
        keepaliveCount: 0,
      }
      activeKeys.set(sessionKey, entry)
    }

    entry.lastHitAt = now()
    entry.truncatedBody = truncatedBody
    entry.model = model
    entry.url = url
    if (authHeader) entry.authHeader = authHeader
    entry.keepaliveSent = false  // real activity resets the single-shot flag
    entry.totalHits += 1

    if (pid && Number.isSafeInteger(pid) && pid > 0) {
      entry.clients.add(pid)
    }
  }

  const sendKeepalive = async (entry) => {
    const bodyStr = JSON.stringify(entry.truncatedBody)
    const headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(bodyStr, "utf8")),
    }
    if (entry.authHeader) headers.authorization = entry.authHeader

    const response = await fetchImpl(entry.url, {
      method: "POST",
      headers,
      body: bodyStr,
    })
    if (response.body) {
      try { for await (const _ of response.body) {} } catch {}
    }
    onKeepaliveSent({ sessionKey: entry.sessionKey, status: response.status, model: entry.model })
  }

  const tick = async () => {
    if (!enabled) return
    const current = now()

    for (const [sessionKey, entry] of activeKeys) {
      for (const pid of [...entry.clients]) {
        if (!pidIsAlive(pid)) entry.clients.delete(pid)
      }
      if (entry.clients.size === 0) {
        activeKeys.delete(sessionKey)
        continue
      }

      const age = current - entry.lastHitAt
      if (age > thresholdMs && !entry.keepaliveSent && entry.totalHits >= minHits) {
        entry.keepaliveSent = true
        entry.keepaliveCount += 1
        sendKeepalive(entry).catch((err) => {
          logger.warn?.(`keepalive failed for ${sessionKey}: ${err.message || err}`)
        })
      }
    }
  }

  let timerHandle = null
  const startTimer = () => {
    if (timerHandle) return () => {}
    timerHandle = setInterval(() => { void tick() }, scanIntervalMs)
    timerHandle.unref?.()
    return () => { clearInterval(timerHandle); timerHandle = null }
  }

  const stopTimer = () => {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null }
  }

  return {
    registerHit, tick, startTimer, stopTimer,
    get activeKeys() { return activeKeys },
  }
}
