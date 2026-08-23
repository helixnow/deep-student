# 优化方案（草案，第一轮后）

本文件在多轮调研收敛前保持草案。落地必须以子代理交叉验证后的证据为准。

## 原则

1. **协议按语义使用，而不是只做字段改名。**
   Chat Completions 仍是内部规范可以，但 Responses 出口要保留
   `previous_response_id`、output items、hosted tools、usage 细节。
2. **前缀只往后追加，不改已经发出去的头部。**
   tools / instructions 稳定段 / cache key 在会话内冻结。
3. **易变事实离开稳定前缀。**
   日期、检索、待办、刚更新的画像、技能正文，放到 user 尾部或独立 cache breakpoint。
4. **测量必须能看见命中。**
   每种协议的 cached tokens 字段都要解析；报告按协议/供应商拆分。
5. **禁止静默破坏隐私默认。**
   `store` 默认保持 false；链式 Responses 必须是用户/会话显式选择。

## 候选工作包（实现阶段再拆 PR）

### P0 观测与 cache key

- 解析 `usage.input_tokens_details.cached_tokens`（及 output details）。
- 为 OpenAI / DeepSeek Responses 写入稳定的 `prompt_cache_key`（会话 id，禁止 UUID 回落）。
- Codex 空 session 时禁止 `new_v4()` 作为 cache key。
- `cache-hit-report.py` 增加 protocol / provider 维度。

### P1 前缀冻结

- 会话内冻结 tools 快照：中途 load_skills 的新工具延后到「新会话」或放到
  不破坏已缓存 tools 前缀的策略（行业对标后定）。
- `learner_profile` / `active_todos` 移出 instructions，改为当前 user 尾部
  或 session-stable 段（仅在未变更时保持）。
- 确认 `llm_content` 覆盖 runtime_facts，历史不得用「今天」重写昨天的 user 字节。

### P2 Responses 原生多轮（可选）

- 配置项：允许 store + 保存 `response.id`，后续请求带 `previous_response_id`。
- 仅追加本轮 input items，而不是全量重放。
- 失败时自动回落全量重放（兼容网关）。

### P3 DeepSeek / OpenAI hosted 能力

- 保持 DeepSeek `web_search` 门控（仅官方 + flash 系列）。
- 评估 OpenAI hosted web_search / file_search 是否应对齐，而不是永远走本地 function。
- 不把 SiliconFlow 等无 Responses 端点的托管模型切过去。

## 测试要求

- 单元：usage 字段矩阵、cache key 稳定性、tools 快照冻结、prompt 分段稳定性。
- 回放：同一会话连续两轮的 instructions+tools 字节相等（除允许的动态后缀）。
- 回归：DeepSeek 非 flash / 第三方托管不得误走 Responses。
- 不引入真实密钥的联调；用夹具模拟 Responses SSE 与 usage。
