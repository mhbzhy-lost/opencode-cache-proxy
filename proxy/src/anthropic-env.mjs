export const DEFAULT_CLAUDE_COMPAT_USER_AGENT = "claude-cli/2.1.156 (external, sdk-cli)"

const isEnabled = (value) =>
  ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase().trim())

export const resolveAnthropicUpstreamUserAgent = (env = process.env) => {
  if (!isEnabled(env.ANTHROPIC_CACHE_PROXY_CLAUDE_COMPAT)) return ""

  const customUserAgent = String(env.ANTHROPIC_CACHE_PROXY_USER_AGENT || "").trim()
  return customUserAgent || DEFAULT_CLAUDE_COMPAT_USER_AGENT
}

export const resolveAnthropicMetadataUserId = (env = process.env) =>
  String(env.ANTHROPIC_CACHE_PROXY_METADATA_USER_ID || "").trim()
