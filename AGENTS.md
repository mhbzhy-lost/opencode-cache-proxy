# opencode-cache-proxy

本仓是 opencode 的 cache proxy vendor 子模块，提供本地反向代理将 OpenAI-compatible / Anthropic 请求转发到上游，同时注入 cache-control markers。

## Provider 变更约束

新增或修改 cache-proxy provider 时，**必须先评估是否可以复用 `client-config.mjs` 中已有的 upstream URL 常量**（如 `DEFAULT_OPENAI_BAILIAN_TOKEN_PLAN_UPSTREAM_BASE_URL`）。只有确认现有常量均不适用于新 provider 时，才新增常量，且必须在实现说明中给出理由，避免凭名称臆测专属域名。

验证方式见 `cache-proxy-providers` skill。
