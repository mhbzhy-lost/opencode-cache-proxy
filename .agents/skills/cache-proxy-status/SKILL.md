---
name: cache-proxy-status
description: "Use when checking cache proxy health, cache hit rates, token usage statistics, keepalive status, or diagnosing cache performance issues"
---

# Cache Proxy 状态检查

快速查看 opencode-cache-proxy 的运行状态和缓存效果。

## Proxy 存活检查

```bash
# 健康检查（liveness）
curl -s http://127.0.0.1:48761/__bailian_cache_proxy/health

# 预期输出：{"status":"ok","pid":12345,"...}
```

如果 health 端点无响应，proxy 进程未运行或端口不可达。

**确认进程状态：**

```bash
# 检查进程
ps aux | grep bailian-cache-proxy | grep -v grep

# 检查端口占用
lsof -i :48761
```

## 缓存命中率统计

使用 `cache-stats.mjs` 工具查看缓存效果：

```bash
# 默认：今日统计
node proxy/scripts/cache-stats.mjs

# 最近 2 小时
node proxy/scripts/cache-stats.mjs --since 2h

# 最近 30 分钟
node proxy/scripts/cache-stats.mjs --since 30m

# 指定日期
node proxy/scripts/cache-stats.mjs --since 2026-05-26

# 全量历史
node proxy/scripts/cache-stats.mjs --since all
```

### 按维度分组

```bash
# 按模型分组（默认）
node proxy/scripts/cache-stats.mjs --by model

# 按协议分组（openai-compatible / anthropic）
node proxy/scripts/cache-stats.mjs --by protocol

# 按 HTTP 状态码分组
node proxy/scripts/cache-stats.mjs --by status

# 按上一轮对话分组（检测 cache 复用情况）
node proxy/scripts/cache-stats.mjs --by turn-prev
```

### JSON 输出（用于脚本处理）

```bash
node proxy/scripts/cache-stats.mjs --json | jq '.overall.cache_hit_ratio_pct'
```

## 关键指标解读

### Overall 汇总行

```
requests:                 156 (3 failures, 98.08% success)
avg duration:             2340ms
prompt tokens:            1,245,678
cached tokens:            1,098,234
cache_creation tokens:    147,444
completion tokens:        89,012
cache hit ratio:          88.17%
warm cache hit ratio:     95.23% (142 warm requests)
97% gap tokens:           23,456
cold creation:            12,345 tokens across 8 requests
avg context tokens:       45,678
marker signature:         system>turn-prev>current>tail
streaming requests:       150 (96.15% with usage frame)
```

**核心指标：**

- **cache hit ratio**: 缓存命中率 = cached_tokens / prompt_tokens
  - 目标：≥97%（生产环境合理值）
  - 低于 80%：可能有 cache marker 配置问题或上下文频繁变化
  - 低于 50%：几乎无缓存效果，需排查

- **warm cache hit ratio**: 预热请求的命中率
  - warm 定义：该 session 之前至少有 2 次真实请求
  - 应接近 95-99%
  - 低于 90%：keepalive 可能未生效（检查环境变量）

- **97% gap tokens**: 距离 97% 目标的 token 缺口
  - 值越小越好
  - 大值说明某些请求的 cache 未命中

- **cold creation**: 冷启动创建的 cache token
  - 首次请求或 session 切换时必然产生
  - 频繁出现说明 session 频繁切换

### 上下文分桶

```
--- BY CONTEXT BUCKET ---
<50k:     requests=45, hit=92.34%, warm=96.78%
50-100k:  requests=67, hit=89.12%, warm=94.56%
100-200k: requests=32, hit=85.67%, warm=92.34%
200-300k: requests=12, hit=78.45%, warm=88.90%
```

上下文越大，cache hit ratio 通常越低（marker 策略限制）。

### Marker 签名

```
--- BY MARKER SIGNATURE ---
system>turn-prev>current>tail: requests=145, hit=92.45%
system>current>tail:           requests=8,  hit=76.23%
(none):                        requests=3,  hit=0.00%
```

- **system>turn-prev>current>tail**: 标准 4-marker 布局，效果最佳
- **system>current>tail**: 缺少 turn-prev 锚点，可能是首轮对话
- **(none)**: 未注入 cache marker，检查 provider 配置

### Top Gap Cohorts

列出 cache gap 最大的对话组，用于定位问题 session：

```
--- TOP 97% GAP COHORTS ---
session_abc123: requests=12, hit=45.67%, gap=12,345, cold_creation=8,901
session_def456: requests=8,  hit=62.34%, gap=8,901,  cold_creation=5,678
```

## 常见排查场景

### 1. 缓存命中率低于 80%

**可能原因：**

- Provider 的 `marker-strategy` 设为 `none`
- 上下文频繁大幅变化（每轮新增 >50% tokens）
- Session 频繁切换（冷启动多）

**检查：**

```bash
# 查看 marker 签名分布
node proxy/scripts/cache-stats.mjs --json | jq '.marker_signatures'

# 查看冷启动比例
node proxy/scripts/cache-stats.mjs --json | jq '.overall.cold_creation_pct'
```

**修复：**

- 确认 provider 配置中 `x-cache-proxy-marker-strategy: "turn-stable"`
- 减少跨 session 的上下文跳跃
- 避免频繁重启 opencode（丢失 warm cache）

### 2. Warm cache hit ratio 低于 90%

**可能原因：**

- Keepalive 被禁用
- Keepalive 阈值过长（>5 分钟，DashScope TTL 为 5 分钟）
- Session 间隔超过 10 分钟

**检查环境变量：**

```bash
# Keepalive 是否启用
echo $BAILIAN_CACHE_PROXY_KEEPALIVE  # 应为 1

# Keepalive 间隔（毫秒）
echo $BAILIAN_CACHE_PROXY_KEEPALIVE_THRESHOLD_MS  # 默认 270000 (4.5min)

# Keepalive 扫描频率
echo $BAILIAN_CACHE_PROXY_KEEPALIVE_SCAN_INTERVAL_MS  # 默认 30000 (30s)
```

**修复：**

```bash
# 启用 keepalive（如被禁用）
export BAILIAN_CACHE_PROXY_KEEPALIVE=1

# 降低阈值（确保 < 5 分钟 TTL）
export BAILIAN_CACHE_PROXY_KEEPALIVE_THRESHOLD_MS=240000  # 4 分钟

# 重启 proxy 生效
pkill -f bailian-cache-proxy
# 下次 API 调用时 plugin 会自动重启
```

### 3. 特定模型命中率异常低

**检查该模型的 marker 签名：**

```bash
node proxy/scripts/cache-stats.mjs --by model
```

**对比不同模型的上下文大小：**

```bash
node proxy/scripts/cache-stats.mjs --json | jq '.groups | to_entries[] | {model: .key, avg_context: .value.avg_context_tokens, hit: .value.cache_hit_ratio_pct}'
```

大上下文模型（如 1M）的 cache hit ratio 通常低于小上下文模型。

### 4. 大量 4xx/5xx 失败

**失败请求统计：**

```bash
node proxy/scripts/cache-stats.mjs --by status
```

**常见状态码：**

- **401/403**: API key 无效或过期
  - 重跑 `node proxy/bin/opencode-cache-proxy-auth.mjs`
- **429**: 上游限流
  - 检查配额或降低请求频率
- **500/502/503**: 上游服务异常
  - 等待或切换 provider
- **504**: 上游超时
  - 检查网络连接或上游服务状态

### 5. Streaming 无 usage frame

**检查：**

```bash
node proxy/scripts/cache-stats.mjs --json | jq '.overall.stream_usage_capture_pct'
```

低于 90% 说明部分 streaming 请求未正确注入 `stream_options.include_usage: true`，需检查 proxy 配置。

## 日志位置

```bash
# 默认日志路径
echo $XDG_CACHE_HOME/bailian-cache-proxy/usage.jsonl
# 或
echo ~/.cache/bailian-cache-proxy/usage.jsonl

# 自定义路径（环境变量）
export BAILIAN_CACHE_PROXY_USAGE_LOG=/custom/path/usage.jsonl

# 查看最近 10 条记录
tail -n 10 ~/.cache/bailian-cache-proxy/usage.jsonl | jq

# 统计文件总大小
ls -lh ~/.cache/bailian-cache-proxy/usage.jsonl
```

**日志格式（JSONL，每行一条记录）：**

```json
{
  "ts": "2026-05-26T14:32:01.234Z",
  "proxy_pid": 12345,
  "opencode_pid": 67890,
  "model": "qwen3.7-max",
  "status": 200,
  "duration_ms": 2340,
  "is_stream": true,
  "stream_usage_seen": true,
  "prompt_tokens": 45678,
  "completion_tokens": 1234,
  "cached_tokens": 34567,
  "cache_creation_input_tokens": 11111,
  "cache_hit_ratio": 0.7568,
  "cache_diagnostic": {
    "total_estimated_tokens": 45678,
    "markers": [
      {"location": "system", "prefix_hash": "abc123"},
      {"location": "turn-prev", "prefix_hash": "def456"},
      {"location": "current", "prefix_hash": "ghi789"},
      {"location": "tail", "prefix_hash": "jkl012"}
    ]
  }
}
```

## 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BAILIAN_CACHE_PROXY_KEEPALIVE` | `1` | 启用 keepalive（0=禁用） |
| `BAILIAN_CACHE_PROXY_KEEPALIVE_THRESHOLD_MS` | `270000` | Keepalive 触发阈值（4.5min） |
| `BAILIAN_CACHE_PROXY_KEEPALIVE_SCAN_INTERVAL_MS` | `30000` | Keepalive 扫描频率（30s） |
| `BAILIAN_CACHE_PROXY_KEEPALIVE_MIN_HITS` | `2` | 触发 keepalive 的最小请求数 |
| `BAILIAN_CACHE_PROXY_MARKER_STRATEGY` | `turn-stable` | Marker 策略：`turn-stable` / `fraction` / `none` |
| `BAILIAN_CACHE_PROXY_MIN_TOKENS` | `1024` | 注入 marker 的最小 token 数 |
| `BAILIAN_CACHE_PROXY_USAGE_LOG` | - | 自定义日志路径 |

## 相关文件

- **统计工具**: `proxy/scripts/cache-stats.mjs`
- **日志写入**: `proxy/src/usage-recorder.mjs`
- **Keepalive 管理**: `proxy/src/keepalive.mjs`
- **健康检查**: `proxy/src/server.mjs` (CONTROL_PREFIX)
- **测试**: `proxy/test/cache-stats.test.mjs`
