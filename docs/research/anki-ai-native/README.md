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
| [wrapup/00-final-readiness.md](./wrapup/00-final-readiness.md) | PR #215 最终就绪度、现码评分与逐项接线表 |
| [wrapup/18-sota-status.md](./wrapup/18-sota-status.md) | 收尾续作 #8：SOTA 目标达成状态与剩余缺口 |
| [wrapup/21-critic-switch.md](./wrapup/21-critic-switch.md) | ChatAnki grounded critic 公开开关、默认值与契约 |

## 核心结论（初版评估 + 多轮修订）

**当前架构**：「Agent 工具编排 + Rust 生成内核」混合方案，硬编码程度已大幅下降。

- **Agent 层（ChatAnki Skill）**：**29** 个 `builtin-chatanki_*` 工具，覆盖
  run → wait → get_cards → 验收修正（update/batch/transform/retemplate）→ export/sync 全闭环，
  外加库级复习管理与 APKG 导入。**AI-Native 程度高**。
- **生成内核（Rust Pipeline）**：`chatanki_executor` → `EnhancedAnkiService` → `StreamingAnkiService`。
  已接入 `plan_route` LLM 路由规划、Structured Output（json_schema/json_object/delimiter 自适应）、
  brace-depth 切卡器、确定性 QA lint（**26** 个稳定规则码 + 跨段查重）和
  FSRS 复习画像回流（默认开）。
- **学习与模型编排**：偏好记忆已接通 extraRequirements、成功编辑/批量编辑和删卡
  观察的 extract → consolidate → settings 写回，下次 run/start 检索注入；生成时也会
  首次写入有界 `_original_generation` 快照。Sidekick 的 Planner / Generator / Vlm
  均有 ChatAnki 生产消费者，Critic 也有条件调用点。
- **默认关闭的 opt-in critic**：LLM critic 已接入流式收尾、CAS 写回、同文档修正对
  检索和 Critic 角色路由；ChatAnki run/start 已公开 `enableCriticPass`，但缺省为
  `false`，只有用户明确要求质检/复审/critic 时才显式开启。
- **Script-native**：`chatanki_transform` 双模式落地——声明式 ops（纯 Rust，移动端可用）
  与沙箱脚本 script（python/node，网络恒禁、I/O 合同、CAS 写回），
  「Agent 现写脚本处理卡片」已是生产能力。
- **CardForge 2.0**：聊天内旧 executor/前端桥和无消费者结果回调已删除，ChatAnki
  是聊天主路径；但划词制卡仍消费 `CardAgent.startGeneration`，聊天导出仍复用其
  校验工具，因此不能把整个 `cardforge` 模块标成死代码。

**AI-Native 评分：8.5 / 10；尚未达到完整 SOTA。** Round 1 基线 6.5 → Round 3
预估 7.4 → Round 5 复核 8.0 → 当前现码 8.5。新增偏好写入、
`_original_generation` 及 Planner/Vlm 消费计入评分；critic 虽已具备公开 opt-in
入口，但保持默认关闭，接线开关不单独上调本次评分。评分明细与
接线证据见 [最终就绪度](./wrapup/00-final-readiness.md) 和
[SOTA 状态](./wrapup/18-sota-status.md)。

## 关键问题

> 如果是 Agent 来做的话，可以现写脚本进行处理——当前实现做到了吗？

**已做到（Round 3 起为生产能力），当前状态（Round 5 复核）：**

| 能力 | 初评现状 | 当前状态 |
|------|----------|----------|
| 沙箱脚本处理卡片 | Rust 端有沙箱，chatanki 未集成 | ✅ `transform.script` 生产化：无截断快照 → python/node 硬沙箱（网络恒禁、`CHATANKI_INPUT/OUTPUT` 合同）→ 逐卡乐观锁写回，High 审批卡完整展示脚本正文 |
| 声明式批量变换 | 无 transform 工具 | ✅ `transform.ops`：regex_replace / tag_add / tag_remove ≤20 按序应用，dry_run 逐卡 diff → apply CAS 写回，移动端可用 |
| Agent 动态规划步骤 | 仅 run/wait 固定流程 | ✅ `plan_route` LLM 路由规划（forced > LLM 计划 > 启发式回退），`chatanki_analyze` 与管线同源 |
| 生成调优旋钮 | 无 | ✅ run/start 暴露 outputProtocol / contentFormat / visualHint / maxImages / enableQaPass / enableFsrsFeedback / enablePreferenceMemory；`enableCriticPass` 默认关 |
| LLM 内容理解与生成 | 流式 JSON 卡片 | ✅ 核心路径 + Structured Output 三协议自适应；确定性 QA lint `_qa_flags` 留痕（预览块结构化展示） |
| LLM critic 终审 | 无 | ✅ 内核已接流式收尾、CAS、grounded 参照与 Critic 路由；run/start 可显式传 `enableCriticPass=true`，缺省 `false` 不执行 |
| 启发式路由/分段 | `decide_route` 硬编码 | ✅ 启发式降级为回退路径；brace-depth 切卡器替换分隔符依赖 |
| 复习数据回流 | 无 | ✅ FSRS 画像 + 语义干扰预警 + 拆卡建议默认注入（可关） |
| 用户偏好记忆 | 无 | ✅ extraRequirements、成功编辑/批量编辑、删卡观察会 best-effort 写入本地 settings；run/start 检索注入。`enablePreferenceMemory` 当前只控制检索，不关闭学习写入 |
| 图像遮挡制卡 | 无 | ⚠️ VlmFull 直接图片已接启发式 `_occlusion` 草稿，折叠/展开卡片预览可解析图片并交互揭罩；PDF 页图、真实 grounding、编辑器与可复习 Anki 导出未接 |
| Sidekick 角色分槽 | 无 | ✅ Planner / Generator / Vlm 已接生产调用；Critic 可由默认关闭的 `enableCriticPass` 显式触发；失败均回退既有 model2 路径 |

新生成卡会写入 `_original_generation`，后续用户编辑后可形成 grounded 修正对；
历史卡、超过 16 KiB 而跳过快照的卡仍会缺参照并回退规则 rubric。默认 ChatAnki
路径仍不执行 critic；只有显式 `enableCriticPass=true` 才进入评审。

## 调研方法

- 多轮持久优化：每轮 10 个子代理，覆盖不同子系统
- 成果及时提交 PR 至本分支（PR [#215](https://github.com/helixnow/deep-student/pull/215)）
- 多个 PR 在合适时合并

## 当前收口状态

- PR [#215](https://github.com/helixnow/deep-student/pull/215) 的最终现码口径为
  **8.5/10**：偏好写入、遮挡预览、Sidekick Planner/Generator/Vlm 消费和
  `_original_generation` 首次入库均已接通。
- critic 的内核调用点、Critic 角色路由和 run/start `enableCriticPass` 已接；
  该开关缺省 `false`，所以默认用户路径保持关闭。
- 图像遮挡完整闭环仍未完成：PDF 页图、真实 grounding、编辑器及
  APKG/AnkiConnect 可复习遮挡转换不在本次“遮挡预览已接”的范围内。
- CI 仍是发布门禁；required checks 全绿前，PR 不应视为可发布或可合并。
- 用户可见主路径、工具数量与限制以 ChatAnki skill 和
  [用户指南](../../user-guide/12-Anki制卡与模板.md) 为准；历史调研中的阶段性设计不作为现行入口说明。
