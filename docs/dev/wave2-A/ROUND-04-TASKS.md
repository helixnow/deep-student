# Wave2-A 第 4 轮任务卡（过滤器统一挂接 + 技能目录生命周期）

枝 tip：`6069675e`。模型全是 `claude-fable-5-thinking-high`。禁止编译/测试执行。

## 红线

- 保守三形态哲学：负例测试（`preserves_literal_tokens_in_prose` 等）一条不许删
- 不碰 coordinator / hooks 准入 / TOCTOU / ApprovalGateHook 首位
- streaming_anki_service.rs 只改常量引用，**不改 E 域算法**
- Composer 只碰缓存/技能快照相关；移动热区归 C、桌面行为归 B
- 不修 #122

## 独占

| # | 可写 |
|---|---|
| 1 | `llm_adapter.rs` + `variant_adapter.rs`（reasoning 独立过滤器） |
| 2 | `model_special_tokens.rs` + `streaming_anki_service.rs`（仅常量引用） |
| 3 | 翻译/作文/非流式 `call_unified_model_2` 出口：只改那些调用点文件；豁免则只写文档 |
| 5 | `src/features/chat/adapters/TauriAdapter.ts` |
| 6 | compaction 落盘路径（`compaction.rs` / 相关 repo）；不要改 TauriAdapter |
| 7 | `progressiveDisclosure.ts` 最小落地 + `docs/dev/wave2-A/r4-catalog-delta.md` |
| 8 | 只写 `r4-review-filter-philosophy.md` |
| 9 | 只写 `r4-review-frontend.md` |
| 10 | 追加 ledger 第 4 轮 |

## #1 reasoning 过滤

两适配器 `on_reasoning_chunk` 挂**独立** `ModelWrapTokenStreamFilter` 实例（或 StreamFilterCore.process_reasoning 若已可填），**不与 content 共享行状态**。空 chunk 仍早退。不要改 content 路径语义。

## #2 常量表 + O(n²)

- 将 `MODEL_SPECIAL_TOKENS` 提升为 `pub(crate)`（或 `pub`）单源
- `streaming_anki_service.rs` 删除本地表，改为 `use crate::utils::model_special_tokens::MODEL_SPECIAL_TOKENS`（或再导出包装）。**算法函数体不动**
- `consume_prefix`（约 :289）改游标制，避免反复 drain/remove 造成 O(n²)；加大 chunk 回归测试源码（只写不跑）
- 复核 `process_newline` 重置 inline-code（Step 22 daf5b78e 已修，先核现状再决定是否补）

## #3 出口盘点

grep `call_unified_model_2` / 翻译 / 作文评分。统一挂接过滤器或书面豁免（为何该出口不会泄漏 special tokens）。

## #5 目录原子首发

`buildSystemPromptWithSkills` / 发送路径：首次 catalog **持久化成功后再发请求**。失败策略：fail-closed 不发或明确降级并文档化。保持 first-write-wins。

## #6 compaction 刷新

compaction 落盘同一事务按 live registry 重生成/换代 available_skills 快照（零缓存成本时机）。不要破坏 first-write-wins 语义除非是显式换代键。

## #7 目录 delta

设计 `available_skills_delta` 或显式刷新代际；最小落地（能落一处写键就落，否则只定稿设计）。
