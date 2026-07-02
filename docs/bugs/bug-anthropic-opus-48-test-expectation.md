# bug: Anthropic Opus 4.8 配置后 provider 测试期望未同步

## 现象

修改 cache proxy provider 配置新增 `claude-opus-4-8-1m` 后，执行
`node --test test/client-config.test.mjs` 失败。失败断言仍只期望
`claude-opus-4-6-200k` 和 `claude-opus-4-6-1m` 两个模型。

## 根因 (6 要素)

1. **触发条件**：`ANTHROPIC_OPUS_CONTEXT_MODELS` 新增 `claude-opus-4-8-1m`，并改为通过
   `reasoning: true` 让 OpenCode 自动生成 effort variants。
2. **期望链路**：provider 配置测试应覆盖所有被写入 `opencode.json` 的 Anthropic Idealab
   模型，并验证当前配置契约是 `reasoning: true`，不是手写 variants。
3. **实际链路**：测试仍按旧模型集合和旧 `variants` 字段断言，导致配置生成结果正确但测试失败。
4. **关键假设失效**：测试把旧的手工 effort variants 当作稳定输出；实际契约已迁移到
   OpenCode 的 `reasoning: true` 自动 variants 机制。
5. **旁证**：失败 diff 中 actual 包含 `claude-opus-4-8-1m`，expected 不包含；实际生成的模型对象
   含 `reasoning: true` 和 `options.effort = high`，不含 `variants` 字段。
6. **影响范围**：任何运行 provider 单测的提交/CI 都会失败，阻断新增 Opus 4.8 provider 配置落地。

## 修复方向

同步 `client-config.test.mjs` 与 `install-opencode.test.mjs` 中 Anthropic Idealab 模型列表、
context 断言和 reasoning 契约断言；补充 `anthropic-handler.test.mjs` 覆盖 4.8 context alias
重写，确保新增 4.8 1M 模型不会回归为错误上游模型。

## 验证

- RED：`node --test test/client-config.test.mjs` 在两个 Anthropic Idealab 模型列表断言失败。
- GREEN：更新测试期望后，provider 单测应通过，并继续验证 4.6 / 4.8 context 与 reasoning 配置。
