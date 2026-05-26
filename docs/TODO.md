
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

## 2. Keepalive 防 TTL 过期

**状态**：未开工
**前置**：当前 turn-stable 策略已上线，命中率已达 97.66%（剔首）；未命中主因是上游 5min TTL 被触发
**触发条件**：用户反馈"思考间隙命中率骤降"，或 stats 显示 TTL_EXPIRED 占比 > 5%

### 实现要点（落地时照此做）

- 加 env 开关 `BAILIAN_CACHE_PROXY_KEEPALIVE=0|1`，默认 0
- 主存储按 **prefix hash** 索引，不按 PID（多个 opencode 实例可能共享同一前缀）
- 数据结构：
  ```js
  activeCacheKeys: Map<prefixHash, {
    lastHitAt,          // Timestamp，决定是否需要 keepalive
    body,               // 最近一次成功命中请求的完整 body（用于构造 ping）
    clients: Set<pid>,  // 引用此 cache key 的活跃 client
    totalHits: number,  // 热度指标；冷的 cache key 不续期
  })
  pidToKeys: Map<pid, Set<prefixHash>>  // 反查
  ```
- 每 30s 扫一次 `activeCacheKeys`：
  - 客户端 PID 全死 → 丢弃
  - `now - lastHitAt > 4min30s` 且 `totalHits >= 阈值` → 用 body 构造最小 keepalive ping
  - keepalive 请求 **不计入 usage log**（避免污染命中率统计）
- LRU cap：`activeCacheKeys` 最多保留 8 个 entry；body 只保留到 marker 3 之前的 messages

### 敏感数据顾虑

keepalive 必须在内存持有请求 body = 持有用户会话上下文的一部分。缓解：
- 仅内存，不写盘（`usage-recorder` 不触碰 body 字段）
- body 截断：删掉 marker 3 之后的所有 messages（通常是尾部对话历史）
- 进程退出时自动销毁

### 与 profile 的关系

keepalive 调度周期 `4min30s` 目前是写死的常量。未来接 Anthropic 等同样有 TTL
的平台时，要读 `profile.ttlMs * 0.9`；接 OpenAI 时整块跳过。所以这个 TODO 与
上一个"上游 profile 抽象" 高度相关 —— 两个改动最好同期做，不要分开。

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
