# Anki 卡片生成 AI-Native 调研与 SOTA 优化

> 专属分支：`cursor/anki-ai-native-research-bfca`  
> Goal：深度评估 DeepStudent Anki 制卡逻辑的 AI-Native 符合度，并持续优化至 SOTA 级别。

## 文档索引

| 文档 | 说明 |
|------|------|
| [01-initial-assessment.md](./01-initial-assessment.md) | 初版评估：架构、流程、AI-Native 评分 |
| [02-ai-native-gap-analysis.md](./02-ai-native-gap-analysis.md) | 与 AI-Native / SOTA Agent 的差距矩阵（随轮次修订） |
| [03-optimization-roadmap.md](./03-optimization-roadmap.md) | 分阶段优化路线图（P0/P1/P2，含完成勾选） |
| [progress-log.md](./progress-log.md) | 多轮迭代进度日志 |
| [round1/00-round1-summary.md](./round1/00-round1-summary.md) | Round 1：10 子代理深度分析汇总 |
| [round3/00-round3-summary.md](./round3/00-round3-summary.md) | Round 3：P1/P2 落地 + 可合并质量打磨汇总 |
| [round4/00-round4-status.md](./round4/00-round4-status.md) | Round 4：能力扩展状态盘点（Round 5 复核修订） |
| [round5/00-round5-summary.md](./round5/00-round5-summary.md) | Round 5：接线收口与文档对齐（当前分支交付状态） |
| [agents/README.md](./agents/README.md) | Multi-agent 制卡自定义档案（content-curator / card-qa / card-coordinator） |
| [eval/README.md](./eval/README.md) | 制卡质量 eval harness 与金标集方案 |

## 核心结论（初版评估 + 多轮修订）

**当前架构**：「Agent 工具编排 + Rust 生成内核」混合方案，硬编码程度已大幅下降。

- **Agent 层（ChatAnki Skill）**：**29** 个 `builtin-chatanki_*` 工具，覆盖
  run → wait → get_cards → 验收修正（update/batch/transform/retemplate）→ export/sync 全闭环，
  外加库级复习管理与 APKG 导入。**AI-Native 程度高**。
- **生成内核（Rust Pipeline）**：`chatanki_executor` → `EnhancedAnkiService` → `StreamingAnkiService`。
  已接入 `plan_route` LLM 路由规划、Structured Output（json_schema/json_object/delimiter 自适应）、
  brace-depth 切卡器、确定性 QA lint（25 规则码 + 跨段查重）、FSRS 复习画像回流（默认开）、
  opt-in LLM critic 终审（可引用同文档用户修正对，缺参照时回退规则 rubric）、
  Sidekick 模型分层路由（Generator 槽已消费）。
- **Script-native**：`chatanki_transform` 双模式落地——声明式 ops（纯 Rust，移动端可用）
  与沙箱脚本 script（python/node，网络恒禁、I/O 合同、CAS 写回），
  「Agent 现写脚本处理卡片」已是生产能力。
- **CardForge 2.0**：初评时的"设计文档 vs 生产路径 divergence"已在 Round 3 收口——
  死链路清理、划词制卡迁向 chatanki 生产路径，文档不再描述 CardForge 主路径。

**AI-Native 评分：8.0 / 10**（Round 1 基线 6.5 → Round 3 预估 7.4 → Round 5 复核 8.0，
评分依据见 [02-ai-native-gap-analysis.md](./02-ai-native-gap-analysis.md)）

## 关键问题

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**已做到（Round 3 起为生产能力），当前状态（Round 5 复核）：**

| 能力 | 初评现状 | 当前状态 |
|------|----------|----------|
| 沙箱脚本处理卡片 | Rust 端有沙箱，chatanki 未集成 | ✅ `transform.script` 生产化：无截断快照 → python/node 硬沙箱（网络恒禁、`CHATANKI_INPUT/OUTPUT` 合同）→ 逐卡乐观锁写回，High 审批卡完整展示脚本正文 |
| 声明式批量变换 | 无 transform 工具 | ✅ `transform.ops`：regex_replace / tag_add / tag_remove ≤20 按序应用，dry_run 逐卡 diff → apply CAS 写回，移动端可用 |
| Agent 动态规划步骤 | 仅 run/wait 固定流程 | ✅ `plan_route` LLM 路由规划（forced > LLM 计划 > 启发式回退），`chatanki_analyze` 与管线同源 |
| 生成调优旋钮 | 无 | ✅ run/start 暴露 outputProtocol / contentFormat / visualHint / maxImages / enableQaPass / enableFsrsFeedback / enablePreferenceMemory |
| LLM 内容理解与生成 | 流式 JSON 卡片 | ✅ 核心路径 + Structured Output 三协议自适应；确定性 QA lint `_qa_flags` 留痕（预览块结构化展示） |
| LLM critic 终审 | 无 | ✅ opt-in 接入流式收尾；优先使用同文档修正对作为 grounded 参照，参照不可用时安全回退规则 rubric；开关默认关闭 |
| 启发式路由/分段 | `decide_route` 硬编码 | ✅ 启发式降级为回退路径；brace-depth 切卡器替换分隔符依赖 |
| 复习数据回流 | 无 | ✅ FSRS 画像 + 语义干扰预警 + 拆卡建议默认注入（可关） |
| 用户偏好记忆 | 无 | ⚠️ retrieve 已接 run/start（默认开）；**写入侧（extract/consolidate 持久化）未接**，store 恒空 |
| 图像遮挡制卡 | 无 | ⚠️ VlmFull 直接图片已接启发式 `_occlusion` 草稿；PDF 页图与预览/编辑仍未接，非真实 grounding |

Grounded critic 仍有一个数据可用性限制：生成路径尚未稳定写入
`_original_generation` 原始快照，因此很多现有文档没有可挖掘的修正对，会按设计回退到规则 rubric。
这不影响默认路径，因为 critic 本身仍是 opt-in。

## 调研方法

- 多轮持久优化：每轮 10 个子代理，覆盖不同子系统
- 成果及时提交 PR 至本分支（PR [#215](https://github.com/helixnow/deep-student/pull/215)）
- 多个 PR 在合适时合并

## 当前收口状态

- Round 4 能力扩展已完成状态盘点；Round 5 当前分支已交付 skill 参数补齐、
  grounded critic、eval lint 对齐与文档/i18n 终检。
- 仍未伪装成已完成的项目：偏好记忆写入侧、图像遮挡管线/预览接线、
  Sidekick Planner/Critic/Vlm 真正分槽，以及 `_original_generation` 稳定埋点。
- 用户可见主路径、工具数量与限制以 ChatAnki skill 和
  [用户指南](../../user-guide/12-Anki制卡与模板.md) 为准；历史调研中的阶段性设计不作为现行入口说明。
