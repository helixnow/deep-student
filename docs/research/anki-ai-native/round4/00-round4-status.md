# Round 4 状态盘点（续跑入口）

> 2026-08-24 · 分支 `cursor/anki-ai-native-research-bfca` · PR [#215](https://github.com/helixnow/deep-student/pull/215)
> Round 5 #8 复核修订：逐项对照代码重验接线状态（✅ = 已用 rg/Read 核实）

Round 4 部分子代理曾因环境中断未回传，但代码已大部分入库。本文件供 Round 5 子代理避免重复造轮子。

## 已在树中的能力（Round 5 复核后）

| 能力 | 位置 | 接线状态 |
|------|------|----------|
| run/start 参数 outputProtocol/contentFormat/visualHint/maxImages/enableQaPass/enableFsrsFeedback/enablePreferenceMemory | `chatanki_executor.rs` + skill schema `index.ts` | ✅ **Rust 与 skill schema 均已暴露**（run 全量；start 无 VLM 专属参数 visualHint/maxImages，符合纯文本路径语义）|
| 偏好 retrieve 注入 | `build_chatanki_requirements` | ⚠️ 读取侧已接（默认开、`enablePreferenceMemory=false` 可关，读 settings key `chatanki_preference_memory_store`）；**写入侧未接**——`extract_preferences`/`consolidate` 仅在模块单测中调用，生产路径无人写 store，注入实际恒为空 |
| LLM critic | `anki_critic.rs` + streaming 收尾 | ✅ opt-in 已接（options JSON `enable_critic_pass`/`enable_llm_critic`，默认关；失败一律降级全 keep；成功派发 `CriticSummary` 事件）；未暴露为 chatanki 工具参数 |
| FingerprintTracker 跨段 | `anki_qa_lint.rs` + streaming | ✅ document 级 registry 已接流式路径（`duplicate_in_document`/`near_duplicate`）|
| Sidekick 路由 | `anki_model_routing.rs` + streaming | ⚠️ Generator 已消费；Critic 已出现角色调用点但当前接线不完整；Planner/Vlm 仍未按计划分槽调用（详见 round5/05-wiring.md） |
| Phase 2 只读四工具 | `custom_agents.rs` + `workspace_handlers.rs` | ✅ 白名单已扩（get_cards/status/analyze/list_templates），fail-closed 测试双向钉死；所有权豁免文档见 agents/ |
| 图像遮挡纯函数 + overlay 组件 | `anki_image_occlusion.rs` + `ImageOcclusionOverlay.tsx` | ⚠️ VlmFull 直接图片 ref 已接 IMAGE_DESC → 启发式草稿 → `_occlusion`；PDF 页图与前端预览/编辑仍未接，网格不是 grounding |
| Structured Output | `anki_protocol.rs` | ✅ 已接 streaming（delimiter/json_object/json_schema + auto 按供应商能力解析，非法参数启动前拒绝）|
| transform script | `chatanki_transform_script.rs` | ✅ 已生产化并暴露 schema（python/node 沙箱、`CHATANKI_INPUT/OUTPUT` I/O 合同、结构化错误码、CAS 写回、High 审批卡展示脚本正文）|
| FSRS 回流 | `enhanced_anki_service.rs` + `anki_fsrs_feedback.rs` | ✅ 默认开（`fsrs_feedback: None` 视为开启）；画像 + 语义干扰 + 拆卡建议合计 ≤1200 token，任何失败降级为不注入 |
| 金标挖掘纯函数 | `anki_gold_set.rs` | ❌ 未接 critic grounded 参照（仅 `lib.rs` 注册）|
| 预览块 QA flags / mediaReport | `ankiCardsBlock.tsx` + `AnkiQaFlagBadge.tsx` + `AnkiMediaReportView.tsx` | ✅ 已接；Round 5 #8 发现并修复 i18n key 不一致（组件取 `anki:qaFlags.*`，文案原在 `agent.qaFlags.*` 下，UI 会显示原始 key——已把 `qaFlags` 提升为 anki.json 顶层块）|
| QA lint 规则面 | `anki_qa_lint.rs` | ✅ 25 个规则码（基础 16 + MCQ 3 + 字段规则 4 + cloze 组 + legacy 包装），flag 不毙卡 |

## Round 5 优先缺口（不要重复实现已有模块）

1. ~~把已有 Rust 参数暴露到 `chatanki` skill schema + 文档~~ ✅ 已完成（schema 已含全部调优旋钮）
2. 偏好记忆持久化 + 从 update_card/delete/extraRequirements 抽取（写入侧接线，缺口最大）
3. 遮挡卡接入 VLM 路径与预览块（纯函数/overlay 已备好，零改造成本）
4. critic 使用金标对做 grounded judge（`anki_gold_set.rs` 已备好）
5. Sidekick 三角色真正分槽（Planner/Critic/Vlm 按计划调用）
6. Phase 2 所有权豁免测试与档案（白名单已扩，补边界测试）
7. 跨模块集成测试补全
8. ~~文档/i18n/用户指南与代码对齐~~ ✅ Round 5 #8 交付（本次修订 + round5 汇总 + 用户指南 + i18n）
