# Anthropic Cache Proxy — Claude Code + 百炼 Qwen

## 背景与动机

Claude Code 通过百炼 Anthropic 兼容端点 (`dashscope.aliyuncs.com/apps/anthropic`)
使用 Qwen 模型时，缓存命中率仅 64.8%。

### 根因

Claude Code 开启 extended thinking 后，每个 turn 分两次 API 调用：

1. **Thinking prefill**：发送完整上下文 (~42K tokens)，获取 thinking 内容，
   `stop_reason=null`，**不携带 `cache_control` markers**
2. **Completion**：发送相同上下文 + thinking 结果，获取 tool_use/text，
   携带 markers，命中率 91%

百炼规则：显式缓存与隐式缓存互斥。无 marker → 走隐式（不保证命中）→ 实测 0%。
50% 的请求（thinking prefill）完全浪费缓存机会，每次 ~42K tokens 全量计费。

### 预期收益

- 当前：208 次 thinking prefill × 47K tokens = **~9.8M tokens/天** 无缓存
- 目标：统一加 markers 后预期 ~90% 命中率，净省 ~8.8M tokens/天

## 设计约束

| 来源 | 约束 |
|------|------|
| 百炼文档 | 最多 4 markers/请求 |
| 百炼文档 | 前缀匹配仅检查 marker 前最近 20 content blocks |
| 百炼文档 | 最小 1024 tokens 才创建缓存 |
| 百炼文档 | TTL 5 min，命中重置 |
| 百炼文档 | tools 定义中的 marker 被忽略 |
| 用户要求 | 与 OpenAI planner 代码完全独立，不做抽象共享 |
| 用户要求 | 同一 proxy 进程，同端口，路径分流 |

## 架构

```
Claude Code
    │
    │ ANTHROPIC_BASE_URL=http://127.0.0.1:48761/apps/anthropic
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  bailian-cache-proxy (port 48761)                   │
│                                                     │
│  /compatible-mode/v1/chat/completions               │
│      → 现有 OpenAI pipeline (不动)                  │
│                                                     │
│  /apps/anthropic/v1/messages                        │
│      → 新 Anthropic pipeline                        │
│         1. readBody + parse                         │
│         2. anthropicCachePlanner (独立模块)          │
│         3. forward to upstream                      │
│         4. stream/buffer response                   │
│         5. extract usage (Anthropic 格式)           │
│         6. record (共享 usageRecorder)              │
│                                                     │
│  共享基础设施: lifecycle, usageRecorder, keepalive   │
└─────────────────────────────────────────────────────┘
    │
    ▼
dashscope.aliyuncs.com/apps/anthropic/v1/messages
```

### 路径路由

```
请求路径                                    → 处理管线
/compatible-mode/v1/chat/completions        → 现有 OpenAI (不变)
/v1/chat/completions                        → 现有 OpenAI (不变)
/apps/anthropic/v1/messages                 → 新 Anthropic pipeline
/apps/anthropic/*                           → 直接转发 (非 messages 路径)
/__bailian_cache_proxy/*                    → 控制端点 (不变)
其他                                        → 404
```

## 新增模块

### `src/anthropic-cache-planner.mjs`

完全独立的缓存标记模块，不 import 现有 `cache-planner.mjs` 的任何内容。

#### 输入格式 (Anthropic Messages API)

```json
{
  "model": "qwen3.7-max",
  "system": [
    {"type": "text", "text": "You are...", "cache_control": {"type": "ephemeral"}}
  ],
  "messages": [
    {"role": "user", "content": [{"type": "text", "text": "..."}]},
    {"role": "assistant", "content": [
      {"type": "thinking", "thinking": "..."},
      {"type": "text", "text": "..."}
    ]},
    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "...", "content": "..."}]}
  ],
  "max_tokens": 16384
}
```

#### Marker 放置策略

剥离所有已有 `cache_control`，然后放置最多 4 个 markers：

| Slot | 位置 | 稳定性 | 说明 |
|------|------|--------|------|
| 0 | system 最后一个 block | 极高 | session 生命期内不变 |
| 1 | 上一个 user turn 的首条 text content | 高 | 跨 turn 稳定前缀点 |
| 2 | 当前 user turn 的首条 text content | 中高 | turn 内所有 tool call 共享此前缀 |
| 3 | messages 最后一个可标记 block | 低 | 每次请求移动，但保证创建最新缓存 |

**Turn anchor 识别规则** (Anthropic 格式)：
- `role=user` 且 content 包含 `type=text` 的 block → turn boundary
- `role=user` 且 content 仅含 `type=tool_result` → 非 turn boundary（tool call 链内部）

**Fallback**：若 turn boundary 不足 2 个（短对话），slot 1/2 改为 token 分位
（0.5 / 0.85）最近的可标记 block。

#### 与 OpenAI planner 的概念对应

| 概念 | OpenAI planner | Anthropic planner |
|------|---------------|-------------------|
| System anchor | messages[0] (role=system) 最后 part | system[] 最后 block |
| Turn boundary | role=user + content 是 string/text | role=user + content 含 type=text |
| Non-boundary user | role=user + content 是 tool_result | role=user + content 仅 tool_result |
| Tail anchor | messages 最后可标记 part | messages 最后可标记 block |
| Max markers | 4 | 4 |
| Min tokens | 1024 | 1024 |

概念相同，实现完全独立。

#### 20 block lookback 注意事项

百炼前缀匹配只看 marker 前最近 20 个 content blocks。对于长 tool call 链
（assistant tool_use + user tool_result 循环），单个 turn 可能积累 >20 blocks。
如果 slot 3（tail）距离 slot 2 超过 20 blocks，中间的 prefix match 可能失效。

应对：当 slot 2 到 slot 3 之间超过 18 blocks 时，将 slot 3 回退到 slot 2 + 18
的位置，牺牲 tail 的"最新缓存创建"换取 prefix match 的连续性。

### `src/anthropic-usage-extractor.mjs`

从 Anthropic SSE streaming 或 non-streaming response 中提取 usage。

#### Streaming 格式

```
event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_creation_input_tokens":45226,"cache_read_input_tokens":0}}}

...content events...

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":142}}

event: message_stop
data: {"type":"message_stop"}
```

- `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`
  在 `message_start` 中（Anthropic 格式 input_tokens 不含 cached）
- `output_tokens` 在 `message_delta` 中

#### Non-streaming 格式

```json
{
  "usage": {
    "input_tokens": 6,
    "output_tokens": 142,
    "cache_creation_input_tokens": 45226,
    "cache_read_input_tokens": 0
  }
}
```

### `src/anthropic-handler.mjs`

Anthropic 请求的完整处理管线（在 server.mjs 中通过路径判断调用）。

职责：
1. 验证请求（POST、JSON body、路径匹配）
2. 读取 body，解析 JSON
3. 调用 `anthropicCachePlanner` 放置 markers
4. 转发至 upstream（`https://dashscope.aliyuncs.com/apps/anthropic/v1/messages`）
5. 流式/非流式 passthrough response 回 client
6. 从 response 提取 usage（调用 `anthropicUsageExtractor`）
7. 写 usage record（调用共享 `usageRecorder`）
8. 注册 keepalive hit（共享 keepaliveManager）

#### 与现有 OpenAI handler 的关系

- 独立的请求处理函数，不与 server.mjs 现有逻辑混在一个 handler 中
- server.mjs 只在路由层判断路径后 dispatch 到不同 handler
- 共享：`usageRecorder.fireAndForget()`、`keepaliveManager.registerHit()`、
  `lifecycleTracker`

## Keepalive 适配

复用现有 keepaliveManager 概念（活动驱动，4.5min 阈值单次 ping），但：

- 百炼 Anthropic 端点的 keepalive ping 需要发 Anthropic 格式请求
  （`/v1/messages` + system/messages body）
- `truncateBodyForKeepalive` 需要 Anthropic 版本：截断到 marker 2 位置，
  `max_tokens: 1`，去掉 `cache_control`
- keepaliveManager 的 `sendKeepalive` 回调按协议区分发送格式

## Usage Record 适配

共享同一个 `usage.jsonl`，新增字段区分协议来源：

```json
{
  "ts": "...",
  "protocol": "anthropic",
  "model": "qwen3.7-max",
  "status": 200,
  "duration_ms": 1234,
  "is_stream": true,
  "input_tokens": 6,
  "output_tokens": 142,
  "cache_read_input_tokens": 45226,
  "cache_creation_input_tokens": 0,
  "cache_hit_ratio": 0.99,
  "cache_diagnostic": {
    "strategy": "anthropic-turn-stable",
    "marker_count": 4,
    "markers": [...]
  }
}
```

注意 Anthropic 格式下 `input_tokens` 不含 cached tokens（与 OpenAI 不同），
hit_ratio 计算公式：

```
hit_ratio = cache_read / (input_tokens + cache_read + cache_creation)
```

## 配置变更

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ANTHROPIC_UPSTREAM_BASE_URL` | `https://dashscope.aliyuncs.com/apps/anthropic` | Anthropic 上游 |
| `ANTHROPIC_API_KEY` | (从请求 header 取) | fallback API key |
| `BAILIAN_CACHE_PROXY_ANTHROPIC_ENABLED` | `1` | 开关 |

### Claude Code 侧配置

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:48761/apps/anthropic"
  }
}
```

只需改 base URL，其他不变。

### Header 转发

Anthropic 格式使用 `x-api-key` (非 `Authorization: Bearer`)。Proxy 转发规则：
- `x-api-key` → 原样转发；缺失时用 `ANTHROPIC_API_KEY` env 补充
- `anthropic-version` → 原样转发
- `content-type` → 原样转发
- hop-by-hop headers → 剥离（同现有逻辑）

## 文件清单

```
proxy/src/
  anthropic-cache-planner.mjs    # 独立缓存标记逻辑
  anthropic-usage-extractor.mjs  # Anthropic SSE/JSON usage 提取
  anthropic-handler.mjs          # 请求处理管线
  server.mjs                     # 修改: 加路由分流到 anthropic-handler

proxy/test/
  anthropic-cache-planner.test.mjs
  anthropic-usage-extractor.test.mjs
  anthropic-handler.test.mjs

proxy/bin/
  bailian-cache-proxy-configure.mjs  # 修改: 新增 claude 子命令
```

## 不做的事

- 不抽象 "upstream profile" 层（TODO.md 中记录的设计骨架暂不落地）
- 不共享 `cache-planner.mjs` 的任何代码
- 不做 OpenAI ↔ Anthropic 协议互转
- 不修改现有 OpenAI pipeline 的行为
- cache-stats.mjs 暂不改（后续按需加 `--protocol anthropic` 过滤）

## 验证计划

1. **单元测试**：anthropic-cache-planner 的 marker 放置、edge cases
2. **集成测试**：mock upstream，验证 full pipeline（request → markers → forward → usage extract）
3. **E2E 验证**：配置 Claude Code 指向 proxy，跑一轮 tool_use session，对比
   usage.jsonl 中 thinking prefill 的 `cache_creation > 0`（之前是 0）
4. **A/B 对比**：proxy 开/关各跑半天，`cache-stats` 对比命中率
