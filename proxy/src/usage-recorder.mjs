import { mkdir, appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const DEFAULT_DIR_NAME = "bailian-cache-proxy"
const DEFAULT_FILE_NAME = "usage.jsonl"
// PIPE_BUF on macOS/Linux is 4096; we keep a margin so trailing newline plus
// any kernel/userland buffering stays within the atomic-write guarantee.
const LINE_LIMIT_BYTES = 3500

export const defaultUsageLogPath = () => {
  const explicit = process.env.BAILIAN_CACHE_PROXY_USAGE_LOG
  if (explicit) {
    // Always resolve to absolute so a stray relative override does not write
    // the log file relative to whichever cwd the proxy happened to spawn in.
    return isAbsolute(explicit) ? explicit : resolve(explicit)
  }
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(cacheRoot, DEFAULT_DIR_NAME, DEFAULT_FILE_NAME)
}

export const computeCacheHitRatio = (record) => {
  const prompt = Number(record?.prompt_tokens || 0)
  const cached = Number(record?.cached_tokens || 0)
  if (prompt <= 0) return 0
  return Math.round((cached / prompt) * 10000) / 10000
}

export const buildUsageRecord = ({
  ts,
  model,
  status,
  duration_ms,
  usage,
  request_id,
  is_stream,
  stream_usage_seen,
  proxy_pid = process.pid,
  opencode_pid = null,
  proxy_error = null,
}) => {
  const details = usage?.prompt_tokens_details || usage?.input_tokens_details || {}
  const prompt_tokens = usage?.prompt_tokens ?? usage?.input_tokens ?? null
  const completion_tokens = usage?.completion_tokens ?? usage?.output_tokens ?? null
  const cached_tokens = details.cached_tokens ?? null
  const cache_creation_input_tokens = details.cache_creation_input_tokens ?? null

  const record = {
    ts,
    proxy_pid,
    opencode_pid,
    model: model ?? null,
    status,
    duration_ms,
    is_stream: Boolean(is_stream),
    stream_usage_seen: is_stream ? Boolean(stream_usage_seen) : null,
    prompt_tokens,
    completion_tokens,
    cached_tokens,
    cache_creation_input_tokens,
    request_id: request_id ?? null,
    proxy_error: proxy_error ?? null,
  }
  record.cache_hit_ratio = computeCacheHitRatio(record)
  return record
}

export const createUsageRecorder = ({
  filePath = defaultUsageLogPath(),
  appendImpl = appendFile,
  mkdirImpl = mkdir,
  logger = console,
} = {}) => {
  let dirEnsured = false

  const ensureDir = async () => {
    if (dirEnsured) return
    await mkdirImpl(dirname(filePath), { recursive: true })
    dirEnsured = true
  }

  const record = async (entry) => {
    try {
      const line = `${JSON.stringify(entry)}\n`
      if (Buffer.byteLength(line, "utf8") > LINE_LIMIT_BYTES) {
        // O_APPEND is only atomic for writes ≤ PIPE_BUF (4096); skip oversized
        // lines rather than risk interleaved writes from concurrent proxy
        // instances. This is conservative — the standard record is ~400 bytes.
        logger.warn?.(
          `bailian-cache-proxy: usage record skipped, exceeds ${LINE_LIMIT_BYTES} bytes (atomicity guarantee limit)`,
        )
        return
      }
      await ensureDir()
      await appendImpl(filePath, line, { encoding: "utf8" })
    } catch (err) {
      logger.warn?.(`bailian-cache-proxy: usage record failed: ${err.message || err}`)
    }
  }

  // Fire-and-forget wrapper so the proxy hot path never awaits us.
  const fireAndForget = (entry) => {
    void record(entry)
  }

  return { record, fireAndForget, filePath }
}
