---
name: cache-proxy-providers
description: "Use when adding, removing, or modifying an OpenAI-compatible or Anthropic provider in the cache proxy — including changing upstream URLs, adding model aliases, 256k context variants, thinking-mode variants, marker strategies, or cache strategies"
---

# opencode-cache-proxy Provider 管理

opencode-cache-proxy 是一个本地反向代理，通过 `x-cache-proxy-*` 控制头将
OpenAI-compatible / Anthropic 请求转发到上游，同时注入 cache-control markers。

Provider 配置由两部分组成：
1. **`proxy/src/client-config.mjs`**：定义每个 provider 的构造函数及安装逻辑
2. **`~/.config/opencode/opencode.json`**：由 `install-opencode.sh` 写入实际配置

修改 provider **必须**改 `client-config.mjs` 然后重跑 `install-opencode.sh`，
不能直接手改 opencode.json（会被 install 脚本覆盖）。

---

## Provider 结构

每个 provider 在 opencode.json 中形如：

```jsonc
{
  "npm": "@ai-sdk/openai-compatible",   // 或 "@ai-sdk/anthropic"
  "name": "Provider 显示名",
  "options": {
    "baseURL": "http://127.0.0.1:48761/compatible-mode/v1",  // 本地代理
    "headers": {
      "x-cache-proxy-upstream-base-url": "https://actual.upstream/v1",  // 真实上游
      "x-cache-proxy-marker-strategy": "turn-stable",  // cache marker 策略
      "x-cache-proxy-cache-strategy": "cache",         // 仅 Anthropic
      "x-cache-proxy-upstream-user-agent": "claude-cli/...",  // 仅 Anthropic
      "x-cache-proxy-metadata-user-id": "uuid"          // 仅 Anthropic
    }
  },
  "models": { "model-id": { "name": "...", "limit": {...}, "variants": {...} } }
}
```

### 控制头说明

| Header | 用途 | 取值 |
|--------|------|------|
| `upstream-base-url` | 真实上游地址 | URL string |
| `marker-strategy` | cache marker 注入策略 | `turn-stable`(默认) / `fraction` / `none` |
| `cache-strategy` | Anthropic cache 控制 | `cache` |
| `upstream-user-agent` | 转发给上游的 UA | UA string |
| `metadata-user-id` | Anthropic 用户标识 | UUID |

proxy 转发请求前会**剥离所有 `x-cache-proxy-*` 头**，上游看不到这些控制信息。
非回环地址的客户端不能通过 `upstream-base-url` 覆盖上游（安全限制）。

---

## 上下文大小变体（Context Size Variants）

当同一模型需支持不同上下文窗口时，通过 model alias 实现：

### 256k 变体

```js
// proxy/src/client-config.mjs 中 QWEN_OPEN_CODE_MODELS 的写法：
"qwen3.7-max-256k": {
  name: "Qwen 3.7 Max (256k)",
  limit: { context: 256000, output: 32768 }  // 必须同时设
}
```

proxy 的 `think-mode-rewriter.mjs` 维护了 `QWEN_CONTEXT_ALIASES` 映射：
`-256k` 后缀的别名会被重写为真实上游 model ID（如 `qwen3.7-max-256k` → `qwen3.7-max`）。
**新增 256k 变体时必须同步更新 `QWEN_CONTEXT_ALIASES`。**

### Anthropic 上下文变体（200k / 1M）

直接在 `ANTHROPIC_OPUS_CONTEXT_MODELS` 中定义两个 model ID：
- `claude-opus-4-6-200k` (context: 200000)
- `claude-opus-4-6-1m` (context: 1000000)

不需要 alias rewrite，上游直接接受这两个 ID。

### Thinking-mode 变体（-nothink）

任何模型可通过 `-nothink` 后缀禁用思考模式：
- `qwen3.7-plus` → `qwen3.7-plus-nothink`（强制 `enable_thinking: false`）
- 该逻辑在 `think-mode-rewriter.mjs` 中自动处理，无需额外配置

---

## Effort Variants（仅 Anthropic）

Anthropic 模型支持 effort 级别切换，在 `options` 和 `variants` 中配置：

```js
{
  options: { effort: "high" },        // 默认 effort
  variants: {
    low:    { effort: "low" },
    medium: { effort: "medium" },
    high:   { effort: "high" },
    max:    { effort: "max" },         // max thinking budget
  }
}
```

---

## 新增 Provider 步骤

**upstream URL 复用规则**：`client-config.mjs` 中现有的 upstream URL 常量
（如 `DEFAULT_OPENAI_BAILIAN_TOKEN_PLAN_UPSTREAM_BASE_URL`）优先复用。
只有确认现有常量不适用于新 provider 时，才新增常量；且必须给出理由，
避免凭名称臆测专属域名。

1. **在 `client-config.mjs` 添加构造函数**

   参考 `buildOpenCodeIdealabProvider()` 或 `buildOpenCodeAnthropicProvider()`。

   ```js
   const buildOpenCodeMyNewProvider = ({ port = DEFAULT_PORT } = {}) => ({
     npm: "@ai-sdk/openai-compatible",
     name: "My New Provider",
     options: {
       baseURL: `http://127.0.0.1:${port}/compatible-mode/v1`,
       headers: {
         "x-cache-proxy-upstream-base-url": DEFAULT_OPENAI_BAILIAN_TOKEN_PLAN_UPSTREAM_BASE_URL,  // 优先复用已有常量
         "x-cache-proxy-marker-strategy": "turn-stable",  // 或 "none"
       },
     },
     models: { /* 模型列表 */ },
   })
   ```

2. **在 `configureOpenCodeCacheProxy()` 中注册**

   添加 provider ID 常量和注入逻辑：

   ```js
   const OPENCODE_MY_NEW_PROVIDER_ID = "openai-my-new"
   // ...
   const desired = buildOpenCodeMyNewProvider({ port })
   if (!jsonEqual(providers[OPENCODE_MY_NEW_PROVIDER_ID], desired)) {
     providers[OPENCODE_MY_NEW_PROVIDER_ID] = desired
   }
   ```

3. **如果该 provider 确实需要新的 upstream URL**（已评估现有常量均不适用），检查 `extractProxyControlHeaders` 是否需要新控制头（通常不需要）。

4. **更新测试** `proxy/test/client-config.test.mjs`

5. **重跑 install**

   ```bash
   bash install-opencode.sh
   ```

6. **重启 opencode** 使新 provider 生效

---

## 删除 Provider 步骤

1. **在 `client-config.mjs` 中**：
   - 删除对应的 `buildXxxProvider()` 函数
   - 删除 `configureOpenCodeCacheProxy()` 中的 desired-provider 块

2. **将旧 provider ID 加入 `LEGACY_OPENCODE_PROVIDER_IDS`**

   这样 `install-opencode.sh` 重跑时会自动从 opencode.json 中清除该 provider。

3. **删除相关测试**

4. **重跑 install + 重启 opencode**

   ```bash
   bash install-opencode.sh
   ```

---

## 修改 Provider 步骤

直接编辑 `client-config.mjs` 中对应的 `buildXxxProvider()` 函数，
然后重跑 `install-opencode.sh`。脚本会比较 JSON 是否相等，只在变更时写入。

**常见修改场景：**
- 上游 URL 变更：改 `DEFAULT_OPENAI_*_UPSTREAM_BASE_URL` 常量
- 改 marker 策略：改对应 builder 的 `markerStrategy` 参数
- 加新模型：往对应 `MODELS` 对象增加条目
- 改 context limit：修改 `limit.context` 值，若需 alias rewrite 同步更新 `QWEN_CONTEXT_ALIASES`

---

## 验证方式

Provider 变更后必须依次完成三层验证，全部通过才算完成。

### 1. 单元测试

```bash
cd proxy && node --test test/client-config.test.mjs
```

### 2. 安装脚本幂等性检查

```bash
bash install-opencode.sh 2>&1
# 应输出 "already up to date" 而非 "configured"
```

### 3. 端到端请求验证

health endpoint 仅检查 proxy 进程存活，**不会验证 provider 连通性**。
必须向 proxy 发送真实 chat completion 请求，验证完整链路：
proxy → alias rewrite → 上游 → 响应。

#### 提取 API key

从 opencode auth storage 中提取指定 provider 的 key：

```bash
TOKEN=$(node -e '
  const d=JSON.parse(require("fs").readFileSync(
    process.env.HOME+"/.local/share/opencode/auth.json","utf8"));
  console.log(d["<provider-id>"].key)
')
```

`<provider-id>` 替换为实际 provider ID，如 `openai-bailian-token-plan`。

#### 发送请求

```bash
curl -s --max-time 30 \
  http://127.0.0.1:48761/compatible-mode/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-cache-proxy-upstream-base-url: <upstream-url>' \
  -H 'x-cache-proxy-marker-strategy: turn-stable' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "<model-alias>",
    "messages": [{"role":"user","content":"Say hi"}],
    "max_tokens": 5
  }'
```

`<upstream-url>` 和 `<model-alias>` 取自对应 provider 的配置。

#### 验证要点

| 检查项 | 预期 | 异常说明 |
|--------|------|----------|
| HTTP 状态 | 200 | 401/403 → key 无效；5xx → 上游故障 |
| 返回 `model` 字段 | 真实上游 model ID（无后缀） | alias rewrite 未生效，检查 `QWEN_CONTEXT_ALIASES` |
| `reasoning_content` 存在 | 默认有（thinking 模式开启） | `-nothink` 变体则不应出现 |
| `usage` 字段完整 | prompt_tokens / completion_tokens | proxy marker 注入正常 |

#### 验证 -nothink 变体（如适用）

```bash
curl -s --max-time 30 \
  http://127.0.0.1:48761/compatible-mode/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-cache-proxy-upstream-base-url: <upstream-url>' \
  -H 'x-cache-proxy-marker-strategy: turn-stable' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "model": "<model-alias>-nothink",
    "messages": [{"role":"user","content":"Say hi"}],
    "max_tokens": 5
  }'
```

预期：响应中**无** `reasoning_content`，`enable_thinking: false` 已生效。

### Alias rewrite 静态验证（可选，不需要 proxy 运行）

不依赖 proxy 运行，直接测试 rewriter 逻辑：

```bash
cd proxy && node -e "
import('./src/think-mode-rewriter.mjs').then(({applyThinkModeRewrite}) => {
  const cases = ['<model>-512k', '<model>-256k', '<model>', '<model>-512k-nothink'];
  for (const model of cases)
    console.log(model, '=>', JSON.stringify(applyThinkModeRewrite({model, messages:[]})));
});
"
```

---

## 常见失败处理

- **`install-opencode.sh` 无 effect**：检查 Node.js >= 20（`node --version`）
- **opencode.json 被覆盖**：脚本是幂等的，但并发调用可能 race；确保只跑一次
- **新 provider 不出现**：必须重启 opencode（provider 配置不热加载）
- **上游 401/403**：检查 API key —— OpenCode 使用 auth storage (`~/.local/share/opencode/auth.json`)，运行 `node proxy/bin/opencode-cache-proxy-auth.mjs` 设置
- **256k/512k 变体不生效**：检查 `QWEN_CONTEXT_ALIASES` 是否已包含新 alias，且 `limit.context` 与后缀一致
- **Anthropic provider metadata-user-id 变化**：每次 `install-opencode.sh` 会保留现有 UUID，不要手动删除该字段

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `proxy/src/client-config.mjs` | Provider 定义（SSOT）|
| `proxy/src/proxy-control-headers.mjs` | 控制头解析逻辑 |
| `proxy/src/think-mode-rewriter.mjs` | -nothink / context alias 映射 |
| `proxy/src/cache-planner.mjs` | marker 策略实现 |
| `plugins/bailian-cache-proxy.js` | opencode 插件（保持 proxy 存活）|
| `install-opencode.sh` | 安装入口 |
| `proxy/test/client-config.test.mjs` | provider 配置测试 |
