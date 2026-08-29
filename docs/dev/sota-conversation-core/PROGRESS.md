# 进度盘点

分支：`cursor/sota-responses-cache-review-6117`（调研与方案文档）
基线：`main` @ 启动时 HEAD

## 轮次

| 轮次 | 状态 | 子代理数 | 产出 |
| --- | --- | --- | --- |
| 0 立项 | 完成 | 0 | 本目录、目标、审阅范围 |
| 1 预审 + 并行切片 | 完成 | 12 | 见 README 索引 |
| 2 对标补全 | 完成 | Claude/Codex + replay | [ROUND-01-codex-claude.md](./ROUND-01-codex-claude.md) |
| 3 覆盖度矩阵收敛 | 完成 | — | [ROUND-01-native-coverage.md](./ROUND-01-native-coverage.md) |
| 4 方案冻结 | 完成 | — | [ROUND-02-synthesis.md](./ROUND-02-synthesis.md) |
| 5+ 落地与测试 | 进行中 | [#183](https://github.com/helixnow/deep-student/pull/183)：冻结方案 P0–P2 及审阅回归已提交。本轮补上跨轮 tools 会话冻结与 available_skills 会话快照；三处会话级前缀状态（tools 基线 `frozenToolSchemaOrder`、available_skills 目录 `availableSkillsSnapshot`、microcompact 锚点 `microcompactAnchor`）均已持久化到 session.metadata——重启 ≠ provider 冷缓存，进程重启后不再冷重建打碎缓存前缀。等待 CI。 | `cursor/sota-p0-cache-telemetry-6117` |

## 第一轮已派出的子代理（模型约定：`claude-fable-5-thinking-xhigh`）

| ID 前缀 | 课题 |
| --- | --- |
| [6de9f30f](6de9f30f-2bd1-4bea-9033-65139f5adb0c) | OpenAI Responses 适配器原生能力 vs 兼容层（已完成） |
| [17351f7e](17351f7e-9a67-4fe0-9e97-41f31c61bab1) | DeepSeek Responses 门控、web_search、缓存字段（已完成） |
| [ddb6d831](ddb6d831-cacf-4899-9b32-54af663b45ab) | 多轮缓存前缀断裂路径（已完成） |
| [5df53cf1](5df53cf1-bd09-4c34-a36f-24e053aa04ba) | 技能注入与工具变化对缓存的影响（已完成） |
| [9859559e](9859559e-9c33-4fde-a58e-16d7910cebe7) | 系统提示词稳定性与构建顺序（已完成） |
| [d3ab2581](d3ab2581-4092-434f-b965-925e046e6dee) | 工具面 / hosted tools / 回传格式（已完成） |
| [1fbd7859](1fbd7859-a620-44eb-a054-439a5834af8a) | OpenCode / Pi Agent 对标（已完成） |
| [b35b36be](b35b36be-d67a-49b5-ae7a-708cf76ebd9c) | Chat V2 流水线：裁剪、变体、usage 入库（已完成） |
| [b0ca75ca](b0ca75ca-0edf-4ca5-81ad-efcabefe32d5) | 2026 Responses 官方能力覆盖度（已完成） |
| [414d5fd1](414d5fd1-4b9c-440f-ad1b-f70d7f4c4439) | 各协议 cached_tokens 测量是否正确（已完成） |
| [b9e1515d](b9e1515d-cbd0-4606-a003-75d9107395a1) | V20260806 replay 列是否真正写入/回放（已完成：未落地） |
| [4d4caf7e](4d4caf7e-9e8e-4dc7-aefe-26d49eff2411) | Claude Code × Codex 对标（已完成） |

因异步子代理上限为 10，以下课题排入第二轮：

- Claude Code × Codex 缓存与协议对比
- replay consistency 是「重试字节一致」还是「多轮前缀稳定」

## 已确认的高优先级风险（父代理预审 + 官方文档）

1. Responses usage 三处漏读 `input_tokens_details.cached_tokens`（OpenAI 与 DeepSeek
   Responses 官方字段）。命中率报告可能长期显示 0。
2. `V20260806` 的 `llm_content` / `tool_call_id` / `round_text` **只有迁移没有写入/回放**。
3. `prompt_cache_key` 仅 Codex 写入；空 session 回落 `Uuid::new_v4()`。对 OpenAI 有害；
   对 DeepSeek 官方会静默忽略，不是修复点。
4. DeepSeek Responses 无状态，不能靠 `previous_response_id`。SOTA = 前缀稳定 +
   `web_search_call` 原样回传。
5. `store: false` 对桌面隐私正确；OpenAI 链式多轮必须做成显式开关。
6. 系统提示动态段（learner_profile / todos / format_guide）仍在 instructions 内。
7. 中途 `load_skills` 若改变 tools，各厂商整段前缀都会断。

## 实现分支（尚未创建）

落地代码将开独立分支，例如：

- `cursor/sota-responses-native-cache-6117`
- 后续按主题拆 PR，合适时再合并。
