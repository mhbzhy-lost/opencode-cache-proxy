const DEFAULT_HEARTBEAT_TTL_MS = 45_000

export const processPidIsAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const createLifecycleTracker = ({
  now = () => Date.now(),
  pidIsAlive = processPidIsAlive,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
} = {}) => {
  const parents = new Map()

  const prune = () => {
    const currentTime = now()
    for (const [pid, lastHeartbeat] of parents.entries()) {
      if (currentTime - lastHeartbeat > heartbeatTtlMs || !pidIsAlive(pid)) {
        parents.delete(pid)
      }
    }
  }

  return {
    register(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`invalid pid: ${pid}`)
      }
      parents.set(pid, now())
    },
    prune,
    hasActiveParents() {
      prune()
      return parents.size > 0
    },
    activePids() {
      prune()
      return [...parents.keys()].sort((a, b) => a - b)
    },
  }
}
