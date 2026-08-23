# 进度盘点

分支：`cursor/sota-responses-cache-review-6117`（调研与方案文档）
基线：`main` @ 启动时 HEAD

## 轮次

| 轮次 | 状态 | 子代理数 | 产出 |
| --- | --- | --- | --- |
| 0 立项 | 完成 | 0 | 本目录、目标、审阅范围 |
| 1 预审 + 并行切片 | 进行中 | 10（异步上限） | [ROUND-01-findings.md](./ROUND-01-findings.md) |
| 2 对标补全 | 排队 | — | Claude Code / Codex / OpenCode / Pi |
| 3 覆盖度矩阵收敛 | 排队 | — | 官方字段 × 实现 |
| 4 方案冻结 | 排队 | — | 更新 DESIGN.md |
| 5+ 落地与测试 | 未开始 | 修复子代理 | 独立实现分支 |

## 第一轮已派出的子代理（模型约定：`claude-fable-5-thinking-xhigh`）

| ID 前缀 | 课题 |
| --- | --- |
| 6de9f30f | OpenAI Responses 适配器原生能力 vs 兼容层 |
| 17351f7e | DeepSeek Responses 门控、web_search、缓存字段 |
| ddb6d831 | 多轮缓存前缀断裂路径 |
| 5df53cf1 | 技能注入与工具变化对缓存的影响 |
| 9859559e | 系统提示词稳定性与构建顺序 |
| d3ab2581 | 工具面 / hosted tools / 回传格式 |
| 1fbd7859 | OpenCode / Pi Agent 对标 |
| b35b36be | Chat V2 流水线：裁剪、变体、usage 入库 |
| b0ca75ca | 2026 Responses 官方能力覆盖度 |
| 414d5fd1 | 各协议 cached_tokens 测量是否正确 |

因异步子代理上限为 10，以下课题排入第二轮：

- Claude Code × Codex 缓存与协议对比
- replay consistency 是「重试字节一致」还是「多轮前缀稳定」

## 已确认的高优先级风险（父代理预审，待子代理交叉验证）

1. `prompt_cache_key` 仅在 Codex OAuth 路径写入；官方 OpenAI / DeepSeek Responses 未设。
2. Codex 路径在 session_id 为空时用 `Uuid::new_v4()`，会把 cache key 变成每请求随机值。
3. usage 解析只读 `prompt_tokens_details.cached_tokens`，未读 Responses 原生
   `input_tokens_details.cached_tokens`，命中率可能被系统性低估。
4. `store: false` 默认正确（桌面隐私），但因此无法使用 `previous_response_id` 服务端状态链。
5. 系统提示动态段（learner_profile / todos / format_guide）仍在 instructions 内，
   会缩短可命中的稳定前缀。
6. 中途 `load_skills` 若改变 tools 数组，Anthropic / OpenAI / DeepSeek 的整段前缀都会断。

## 实现分支（尚未创建）

落地代码将开独立分支，例如：

- `cursor/sota-responses-native-cache-6117`
- 后续按主题拆 PR，合适时再合并。
