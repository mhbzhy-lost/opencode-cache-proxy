/**
 * Map an OpenCode-facing model alias to the real upstream model id and the
 * thinking-mode override (if any) that the alias implies.
 *
 * Convention:
 *   <real-model>           → upstream <real-model>, no override (model defaults
 *                            to enable_thinking=true with max budget)
 *   <real-model>-nothink   → upstream <real-model>, force enable_thinking=false
 *
 * The OpenCode side sees both the plain alias and the -nothink alias in the
 * provider model list, so the user can pick "with thinking" or "no thinking"
 * per chat without ever needing to know what enable_thinking is.
 */

const NO_THINK_SUFFIX = "-nothink"

export const resolveThinkMode = (modelName) => {
  if (typeof modelName !== "string" || !modelName) {
    return { upstreamModel: modelName, enableThinking: null, alias: modelName }
  }
  // Trim incidental whitespace before suffix matching: a stray trailing space
  // in the JSON payload should not silently demote a -nothink alias into the
  // default cohort and ship a fake model id upstream.
  const trimmed = modelName.trim()
  if (trimmed.endsWith(NO_THINK_SUFFIX)) {
    return {
      upstreamModel: trimmed.slice(0, -NO_THINK_SUFFIX.length),
      enableThinking: false,
      alias: trimmed,
    }
  }
  return { upstreamModel: trimmed, enableThinking: null, alias: trimmed }
}

/**
 * Apply the alias rewrite + enable_thinking override to a chat-completions
 * request body. Returns a new object; the original is left untouched. The
 * `alias` returned is the OpenCode-facing name and should be propagated to
 * usage records so stats can compare -nothink vs default cohorts.
 */
export const applyThinkModeRewrite = (body) => {
  if (!body || typeof body !== "object") {
    return { body, alias: null }
  }
  const { upstreamModel, enableThinking, alias } = resolveThinkMode(body.model)
  if (upstreamModel === body.model && enableThinking == null) {
    return { body, alias }
  }
  const rewritten = { ...body, model: upstreamModel }
  if (enableThinking != null) {
    // Override any prior enable_thinking — the alias choice is the user's
    // explicit, model-level decision and should win.
    rewritten.enable_thinking = enableThinking
  }
  return { body: rewritten, alias }
}
