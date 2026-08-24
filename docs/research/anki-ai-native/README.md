# Anki 卡片生成 AI-Native 调研与 SOTA 优化

> 专属分支：`cursor/anki-ai-native-research-bfca`  
> Goal：深度评估 DeepStudent Anki 制卡逻辑的 AI-Native 符合度，并持续优化至 SOTA 级别。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01-initial-assessment.md](./01-initial-assessment.md) | 初版评估：架构、流程、AI-Native 评分 |
| [02-ai-native-gap-analysis.md](./02-ai-native-gap-analysis.md) | 与 AI-Native / SOTA Agent 的差距矩阵 |
| [03-optimization-roadmap.md](./03-optimization-roadmap.md) | 分阶段优化路线图（P0/P1/P2） |
| [progress-log.md](./progress-log.md) | 多轮迭代进度日志 |
| [round1/00-round1-summary.md](./round1/00-round1-summary.md) | Round 1：10 子代理深度分析汇总 |
| [round3/00-round3-summary.md](./round3/00-round3-summary.md) | Round 3：P1/P2 落地 + 可合并质量打磨汇总 |
| [agents/README.md](./agents/README.md) | Multi-agent 制卡自定义档案（content-curator / card-qa） |

## 核心结论（初版评估 + 多轮修订）

**当前架构**：「Agent 工具编排 + Rust 硬编码 LLM Pipeline」混合方案。

- **Agent 层（ChatAnki Skill）**：**29** 个 `builtin-chatanki_*` 工具（Round 2 新增
  `chatanki_transform`），负责 run → wait → get_cards → 验收修正 → export/sync 闭环。**AI-Native 程度高**。
- **生成内核（Rust Pipeline）**：`chatanki_executor` → `EnhancedAnkiService` → `StreamingAnkiService` 管线。
  Round 2 起接入 `plan_route` LLM 路由规划与 brace-depth 切卡器，硬编码程度持续下降。
- **CardForge 2.0**：初评时的"设计文档 vs 生产路径 divergence"已在 Round 3 收口——
  死链路清理、划词制卡迁向 chatanki 生产路径，文档不再描述 CardForge 主路径。

**AI-Native 评分：初评 6.5 / 10**（Round 1 基线；Round 2-3 落地项见进度日志，终评待全轮次结束后复测）

## 关键问题

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**初评时未落地，Round 2-3 已逐项收窄：**

| 能力 | 初评现状 | 当前状态（Round 3） |
|------|----------|---------------------|
| `local_shell_execute` + 平台沙箱 | Rust 端完整实现，chatanki 未集成 | ⚠️ 声明式 `chatanki_transform` ops 已落地；沙箱脚本模式（`transform.script`）预留探索中 |
| Skill 包内 `scripts/` | 支持但 chatanki 无 transform 工具 | ✅ `builtin-chatanki_transform`：dry_run 逐卡 diff → apply 乐观锁写回 |
| Agent 动态规划步骤 | 仅 run/wait 固定流程 | ⚠️ `plan_route` LLM 路由规划已接入（forced > LLM 计划 > 启发式回退） |
| LLM 内容理解与生成 | 流式 JSON 卡片 | ✅ 核心路径；确定性 QA lint + 字段校验 `_qa_flags` 兜底 |
| 启发式路由/分段 | `decide_route` 硬编码 | ⚠️ 启发式降级为回退路径；brace-depth 切卡器替换分隔符依赖 |
| 用户偏好记忆 | 无 | ⚠️ Mem0 风格 ADD-only 纯逻辑就绪（`anki_preference_memory.rs`），待接线 |

## 调研方法

- 多轮持久优化：每轮 10 个子代理，覆盖不同子系统
- 成果及时提交 PR 至本分支
- 多个 PR 在合适时合并
