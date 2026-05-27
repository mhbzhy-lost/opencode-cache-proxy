
# TODO — 子仓远期待办

记录未来可能要做但目前没有真实数据驱动的改动。**不要提前实现**，每个条目都
写明"何时该做"的触发条件，避免空想式设计。

## 1. 上游 profile 抽象（Upstream Profile）

**状态**：未开工
**阻塞因素**：当前只接入 DashScope，无第二个上游可对照，做抽象容易过度
**触发条件**：真正接入第二个 OpenAI-compatible upstream（Anthropic direct、OpenAI
直连、AWS Bedrock、自建网关等），出现第二组真实数据时立即重构

### 当前硬编码假设

以下常量目前按 DashScope 规则硬编码，接入其他平台时需要差异化：

| 常量 / 行为 | DashScope 当前值 | 其他平台可能值 |
|---|---|---|
| Cache TTL | 5min（显式、可续期） | Anthropic: 5min；OpenAI: 隐式无 TTL；Bedrock: 5min |
| `DEFAULT_MAX_MARKERS` | 4 | Anthropic: 4；OpenAI: 不支持显式 marker 应设 0 |
| `DEFAULT_MIN_CACHE_TOKENS` | 1024 | Anthropic Sonnet/Haiku: 1024；Opus: 2048 |
| `cache_control.type` | `"ephemeral"` | 同 |
| Usage 缓存命中字段路径 | `prompt_tokens_details.cached_tokens` | Anthropic: `cache_read_input_tokens`（顶层）；OpenAI: `usage.cached_tokens`（顶层） |
| Usage 缓存创建字段路径 | `prompt_tokens_details.cache_creation_input_tokens` | Anthropic: `cache_creation_input_tokens`（顶层）；OpenAI: 无 |
| Chat API path 白名单 | `/compatible-mode/v1/chat/completions` + `/v1/...` | Anthropic: `/messages`；Bedrock: `/model/<id>/invoke` |

### 设计骨架（未来直接落地用）

引入 `src/upstream-profiles.mjs`：

```js
export const PROFILES = {
  dashscope: { id: 'dashscope', ttlMs: 300_000, maxMarkers: 4, minCacheTokens: 1024,
               cacheUsagePaths: ['prompt_tokens_details.cached_tokens'],
               creationUsagePaths: ['prompt_tokens_details.cache_creation_input_tokens'],
               chatPath: '/compatible-mode/v1/chat/completions' },
  anthropic: { id: 'anthropic', ttlMs: 300_000, maxMarkers: 4, minCacheTokens: 1024,
               cacheUsagePaths: ['cache_read_input_tokens'],
               creationUsagePaths: ['cache_creation_input_tokens'],
               chatPath: '/messages' },
  openai:    { id: 'openai',    ttlMs: null, maxMarkers: 0, minCacheTokens: 0,
               cacheUsagePaths: ['usage.cached_tokens'],
               creationUsagePaths: [],
               chatPath: '/v1/chat/completions' },
}

export const resolveProfile = (env, upstreamUrl) => {
  const explicit = env.BAILIAN_CACHE_PROXY_UPSTREAM_PROFILE
  if (explicit && PROFILES[explicit]) return PROFILES[explicit]
  if (/anthropic/.test(upstreamUrl)) return PROFILES.anthropic
  if (/dashscope|aliyun/.test(upstreamUrl)) return PROFILES.dashscope
  if (/openai/.test(upstreamUrl)) return PROFILES.openai
  return PROFILES.dashscope
}
```

### 重构涉及的模块

| 模块 | 当前耦合 | 改动 |
|---|---|---|
| `proxy/src/cache-planner.mjs` | `DEFAULT_MAX_MARKERS=4`、`DEFAULT_MIN_CACHE_TOKENS=1024` 常量 | 从 options 注入 |
| `proxy/src/usage-extractor.mjs` | 硬编码 `prompt_tokens_details.{cached_tokens,cache_creation_input_tokens}` | 按 `cacheUsagePaths`/`creationUsagePaths` 取值 |
| `proxy/src/server.mjs` | `isAllowedUpstreamPath` 白名单写死两条 | 按 `chatPath` 动态配置 |
| `proxy/src/cache-stats.mjs` | 输出固定 | 显示当前 profile id |
| keepalive 调度（未开工） | 硬编码 5min / `keepalive=on` | 按 `ttlMs` 调度；OpenAI profile 直接禁用整块 |

### 接入 OpenAI 的特殊处理

OpenAI 不暴露显式 cache marker，靠内容前缀自动命中。profile 落地时：
- `maxMarkers=0` 让 cache-planner 跳过 marker 注入
- keepalive 模块整体禁用（隐式缓存没有可控的 TTL 续期语义）
- usage 字段名在 `usage.cached_tokens`，顶层路径与 dashscope 不一致

---

## 2. ~~Keepalive 防 TTL 过期~~ (已完成, 2026-05-26)

已落地为活动驱动 + 单次 keepalive 方案 (4.5min threshold, 默认启用)。

- 入口 env: `BAILIAN_CACHE_PROXY_KEEPALIVE` (默认 `1`)
- 模块: `proxy/src/keepalive.mjs` — `createKeepaliveManager`
- 设计文档: `proxy/README.md` → "## Keepalive" 节
- 真实数据验证 (2026-05-26 862 请求): 15 次 TTL_EXPIRED 中 9 次 (60%)
  落在 5–9.5min "可救" 区间, 日净收益 ≈ ¥7.76

---

## 3. cache-stats 按策略分段输出

**状态**：未开工
**触发条件**：turn-stable 上线稳定后，需要定期对比 fraction 与 turn-stable 的真实收益

### 当前问题

`cache-stats.mjs` 输出整体命中率，无法区分 fraction / turn-stable 各自贡献。切换
策略的头几天，新旧数据混在同一个窗口内，整体数字会掩盖真实表现。

### 实现要点

- 读取每条记录 `cache_diagnostic.strategy` 字段，按策略分别累计
- 输出新增 `BY STRATEGY` 区块，与 `BY MODEL` 并列
- 旧记录（切换前）标记为 `strategy=none`

---

## 流程约定（维护人须知）

- 每完成一项 TODO：从本文件移除（或移到"已完成"附录），并在相关模块 README 增加对应说明
- 新增待办条目：写明 `状态 / 阻塞因素 / 触发条件 / 实现要点` 四段，避免一句话占位
- 不要在这里记录已在代码注释中显式说明的"TODO: ..." —— 代码注释优先，本文件只
  放**跨模块或跨文件**的改造项，以及**设计层面**的待决定事项
