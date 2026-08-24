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

## 核心结论（初版）

**当前架构**：「Agent 工具编排 + Rust 硬编码 LLM Pipeline」混合方案。

- **Agent 层（ChatAnki Skill）**：28 个 `builtin-chatanki_*` 工具，负责 run → wait → get_cards → 验收修正 → export/sync 闭环。**AI-Native 程度高**。
- **生成内核（Rust Pipeline）**：`chatanki_executor` → `EnhancedAnkiService` → `StreamingAnkiService` 固定管线。**非 script-native**——Agent 不能现写脚本重组处理逻辑。
- **CardForge 2.0**：前端 LLM-First 抽象，设计文档宣称 Agent 化，但生产主路径已收敛到 Rust 后端。

**AI-Native 评分：6.5 / 10**

## 关键问题

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**部分做到，但未在 Anki 制卡路径落地：**

| 能力 | 项目现状 | Anki 制卡是否使用 |
|------|----------|-------------------|
| `local_shell_execute` + 平台沙箱 | ✅ Rust 端完整实现 | ❌ chatanki skill 未暴露/未集成 |
| Skill 包内 `scripts/` | ✅ 支持 | ❌ chatanki 无 transform 工具 |
| Agent 动态规划步骤 | ⚠️ 仅 run/wait 固定流程 | ❌ 无 planner 层 |
| LLM 内容理解与生成 | ✅ 流式 JSON 卡片 | ✅ 核心路径 |
| 启发式路由/分段 | ⚠️ `decide_route` 硬编码 | 半硬编码 |

## 调研方法

- 多轮持久优化：每轮 10 个子代理，覆盖不同子系统
- 成果及时提交 PR 至本分支
- 多个 PR 在合适时合并
