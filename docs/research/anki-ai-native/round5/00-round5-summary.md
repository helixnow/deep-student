# Round 5 汇总（进行中）

> 2026-08-24 · 分支 `cursor/anki-ai-native-research-bfca` · PR [#215](https://github.com/helixnow/deep-student/pull/215)
> 状态：**10 个子代理并行进行中**。本文件由 #8（文档/i18n 对齐）先行创建，只记录已核实项；
> 其余子代理交付后应各自补充本表，以最终 commit 为准。

## 本轮已知交付与进行中

| 主题 | 状态 |
|------|------|
| #1 run/start skill schema 补齐生成调优参数（outputProtocol/visualHint/contentFormat/QA/FSRS/偏好/maxImages 全暴露 + 选用指南 + 契约测试） | ✅ `d1b827d9` |
| #8 文档/进度/i18n/用户指南对齐当前代码 | ✅ 本文件对应提交 |
| #10 eval lint 与 anki_qa_lint 完全对齐（`anki_qa_lint::codes` 稳定常量导出 + JS ALIGNED/RUST_ONLY/EVAL_ONLY 三分区表名值双对齐 + answer_leak 码点/cloze u32 语义对齐 + 6 边界 fixture，good 集仍 0 误伤，详见 `10-eval-align.md`） | ✅ `9da66ebd` |
| 偏好记忆写入侧持久化、遮挡接线、critic × 金标 grounded、Sidekick 分槽、Phase 2 豁免测试、跨模块集成测试等 | ⏳ 并行进行中（工作树可见未提交改动涉及 `anki_critic.rs` / `anki_gold_set.rs` / `anki_model_routing.rs` / `anki_preference_memory.rs` / `streaming_anki_service.rs` 等），**以各子代理最终 commit 为准，此处不预记** |

## #8 已交付（文档/i18n 对齐）

对照代码逐项重验后交付：

1. **`round4/00-round4-status.md` 修订**：纠正两处过时记载——
   run/start 调优参数（outputProtocol/contentFormat/visualHint/maxImages/enableQaPass/
   enableFsrsFeedback/enablePreferenceMemory）**实际已全部暴露到 skill schema**；
   同时把每项接线状态标注为代码核实结论（偏好写入侧未接、遮挡双端未接、
   Sidekick 仅 Generator 槽消费等）。
2. **`02-ai-native-gap-analysis.md`**：分层评分与 SOTA 对标矩阵按当前代码重算，
   综合评分 6.5 → **8.0 / 10**（评分依据见该文档）。
3. **`03-optimization-roadmap.md`**：20 项路线图逐项勾选（P0 7/7、P1 6/6 完成，
   P2 完成 5/7、部分 2/7）。
4. **`README.md` / `progress-log.md`**：核心结论、能力对照表、轮次日志
   与变更记录同步到 Round 5。
5. **用户指南 12 章**：补脚本级批量变换（沙箱审批语义）、质检标记徽标 UI、
   APKG 媒体导入报告、FSRS 复习画像回流、生成过程精细控制（调优参数面）；
   偏好记忆表述与"读取已接/抽取未接"现状对齐；critic 与图像遮挡**不写入**
   用户指南（critic 未暴露为用户可触达开关、遮挡未接线，避免文档先行）。
6. **i18n（zh-CN/en-US `anki.json`）**：
   - **修复真实 UI bug**：`AnkiQaFlagBadge` 组件以 `useTranslation('anki')` +
     `t('qaFlags.*')` 取文案，而文案原挂在 `agent.qaFlags.*` 下（无 keyPrefix），
     质检徽标此前会显示原始 key。已把 `qaFlags` 块提升为顶层。
   - `agent.transform.scriptModeUnimplemented`（已过时）替换为 script 模式
     全套文案：模式名 + `script_sandbox_unavailable` / `interpreter_unavailable` /
     `script_timed_out` / `script_failed` / `invalid_script_output` 等结构化错误码。
   - 新增 `agent.generation.*`（调优参数名 + 说明）、`agent.critic.*`
     （CriticSummary 摘要文案）、`agent.fsrsFeedback.*`、`agent.occlusion.*`
     （校验错误码文案，供接线后即取即用）。
   - 中英 key 全量对称（脚本校验通过）。

## 已核实的当前代码基线（供本轮其他子代理引用）

- **29 个** `builtin-chatanki_*` 工具（skill 白名单与执行器一致）。
- transform **ops + script 双模式**生产化：script 走沙箱（python/node、网络恒禁、
  I/O 合同 `CHATANKI_INPUT/OUTPUT`）、dry_run → apply 逐卡乐观锁。
- Structured Output：`anki_protocol.rs` 三协议 + auto 解析，已接流式管线。
- QA lint：25 规则码 + FingerprintTracker document 级跨段查重，flag 不毙卡，
  `_qa_flags` 已在预览块结构化展示（徽标 + 摘要条）。
- FSRS 回流默认开；critic opt-in 已接流式收尾。
- 偏好记忆：retrieve 已接（默认开），**写侧未接**（store 恒空）。
- 图像遮挡：VlmFull 直接图片已接启发式 `_occlusion` 草稿；PDF 页图、真实
  grounding 与前端预览/编辑仍未接。
- Sidekick：Generator 已消费；Critic 有角色调用点但当前接线不完整；
  Planner/Vlm 仍未消费。

## 评分

**8.0 / 10**（Round 1 基线 6.5 → Round 3 预估 7.4 → Round 5 复核 8.0）。
script-native 已实打实落地是本次上调主因；未满分的主要扣分项：
偏好记忆写入侧、遮挡接线、critic grounded、Sidekick 分槽仍未收口
（正是本轮其余子代理的任务面）。
