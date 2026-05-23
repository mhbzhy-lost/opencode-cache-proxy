import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createLifecycleTracker } from "../src/lifecycle.mjs"

describe("createLifecycleTracker", () => {
  test("keeps the proxy alive while any registered opencode pid is active", () => {
    const live = new Set([101, 202])
    const tracker = createLifecycleTracker({
      now: () => 1_000,
      pidIsAlive: (pid) => live.has(pid),
      heartbeatTtlMs: 30_000,
    })

    tracker.register(101)
    tracker.register(202)
    live.delete(101)

    assert.equal(tracker.hasActiveParents(), true)
    assert.deepEqual(tracker.activePids(), [202])
  })

  test("drops stale or exited opencode pids", () => {
    let clock = 1_000
    const live = new Set([303])
    const tracker = createLifecycleTracker({
      now: () => clock,
      pidIsAlive: (pid) => live.has(pid),
      heartbeatTtlMs: 10_000,
    })

    tracker.register(303)
    clock = 12_001

    assert.equal(tracker.hasActiveParents(), false)
    assert.deepEqual(tracker.activePids(), [])
  })

  test("rejects invalid pids", () => {
    const tracker = createLifecycleTracker({
      now: () => 1_000,
      pidIsAlive: () => true,
    })

    assert.throws(() => tracker.register(0), /invalid pid/)
    assert.throws(() => tracker.register(Number.NaN), /invalid pid/)
  })
})
