# Wave2-E 第 1 轮 · 二检报告 01：QA / CardAgent（Step 22 五 pick 实证）

- 审阅角色：二检员-QA/CardAgent（静态审阅，未运行任何编译/测试）
- 工作区：`/workspace`，分支 `cursor/0824-wave2-anki-qbank-a875`，tip = `a07fbad8`
- 基线：`origin/cursor/0824-cde6` @ `061b4815`
- 审阅方法：`git show --stat` + `git merge-base --is-ancestor` + `git diff <pick> HEAD -- <files>` + 逐行阅读 tip 上的生产文件与测试区

## 总结论

五个 pick **全部「仍在」tip**，无一回退。`git merge-base --is-ancestor` 证实五个 SHA 均为 HEAD 祖先；关键补充证据是：`git diff 4756e93c HEAD` 对 `streaming_anki_service.rs`、`anki_protocol.rs`、`anki_fsrs_feedback.rs`、`chatanki_executor.rs`、`document_processing_service.rs` **全部为空**，`git diff 307449e2 HEAD` 对全部前端 cardforge / skills / 契约夹具 / models / enhanced_anki_service 文件也**为空**——即 pick 之后没有任何提交动过这些语义。唯一后续改动是 `d8a606c2`（APKG 导入与金标溯源加固）触及 `anki_critic.rs`，经逐行 diff 确认为**纯加法加固**（金标参照剔除 critic 修订卡），不回退 #336 门控。

---

## 1. `1a5b6f6a`（#328 QA：disabled 模式 QA flag 持久化修复）——仍在

语义：`enable_qa_pass=false` 时 `_qa_flags` 的移除必须发生在 `merge_flags` **之后**（旧代码在 merge 之前移除，被 lint 写回导致留痕泄漏）；并补一条三态契约测试。

tip 证据（`src-tauri/src/streaming_anki_service.rs`）：

- 生产收口：L2045 `merge_flags(...)` → L2047-2051 注释「必须在 merge_flags 之后移除，避免 lint 将 _qa_flags 写回」+ `if !qa_pass_enabled { cleaned_extra_fields.remove(QA_FLAGS_FIELD); }`。顺序正确，旧位置（提交 diff 中 L1901 附近被删的 pre-merge 移除）在 tip 上已不存在。
- 契约测试：L4672-4730 `parse_and_save_card_honors_qa_pass_flag_persistence_contract`，三态遍历 disabled/enabled/default，断言：默认必须开启（L4676-4679）；返回卡与落库卡的 `_qa_flags` 有无均按 `expect_flags`（L4707-4711、L4723-4727）；enabled 态必须保留 `front_back_identical` lint 码（L4712-4719）。

## 2. `d9a314cb`（#328 QA 续：测试 rustfmt）——仍在

仅将上述测试中的单行 `assert!` 展开为多行格式。tip L4676-4679 即多行形态，与该提交产物逐字一致。

## 3. `7077075a`（#336：critic QA flag 持久化按 enable_qa_pass 门控）——仍在

语义：critic 裁决/统计照常，但 `enable_qa_pass=false` 时 flag 留痕、`llm_critic_revised` 审计、revise 后 relint 的 `_qa_flags` 一律不落盘；flag-only 更新整体丢弃避免空写回触发 CAS/local_version/同步。

tip 证据（`src-tauri/src/anki_critic.rs`）：

- 模块头契约文档：L24-27。
- 纯函数收口：L692 `sanitize_plan_for_disabled_qa_pass`（剥 `_qa_flags` + 对照原卡忽略历史留痕做无差异判定后丢弃 flag-only 更新）。
- 生产接线：L945-954，`run_critic_pass` 内从同一份 options JSON 二次解析 `StructuredOutputOptions::from_options_json(...).qa_pass_enabled()`，false 时调用 sanitize。
- 三条单测：L1295 `disabled_qa_pass_drops_flag_only_updates`（flag-only 丢弃、统计不受影响）、L1315 `disabled_qa_pass_keeps_revision_content_without_qa_flags`（revise 内容写回但审计+relint 留痕不落盘）、L1347 `disabled_qa_pass_ignores_legacy_flags_when_diffing`（历史留痕不得触发「纯留痕删除」写回）。
- 后续 `d8a606c2` 对本文件的改动：`CRITIC_REVISED_CODE` 改为引用 `anki_gold_set::CRITIC_REVISED_QA_CODE` 常量（值语义不变）、`gold_references_from_cards` 增加 `has_critic_revision_marker` 剔除过滤 + 新测试 `gold_references_exclude_critic_revised_cards`（tip L1699-1724）。**纯加法加固，未触碰 QA 门控。**

## 4. `307449e2`（#338 四项红线修复）——仍在（四项逐一核实）

### 4a. FSRS 显式 opt-in

- `src-tauri/src/models.rs` L1319-1325：`fsrs_feedback: Option<bool>`，文档明确「None 与 Some(false) 均视为关闭，仅显式 Some(true) 开启」。
- `src-tauri/src/enhanced_anki_service.rs` L49-50 `fsrs_feedback_authorized(flag) = flag == Some(true)`；L165-180 仅授权后注入；单测 L1094-1099 断言三态。
- `src-tauri/src/anki_fsrs_feedback.rs`：L68/L83 `include_card_excerpts` 默认 false；L369、L760 卡片原文摘要/干扰预警仅显式开启才渲染；L18「渲染文案不得声称数据不上传」，测试 L1009-1027 断言默认不含卡片原文、文案不含「不上传/仅本地」。虚假本地声明已移除。
- 前端：`src/components/anki/cardforge/types/index.ts` L57 `options.fsrsFeedback?: boolean`；`CardAgent.ts` L555-556 `fsrs_feedback: input.options?.fsrsFeedback === true`（严格等于 true 才授权）；`src/features/chat/skills/builtin/index.ts` L207/L327/L1290 skill schema 与文档均声明 `enableFsrsFeedback` 默认关闭、需用户明确授权；`chatanki_executor.rs` L474/L582-583/L682-683 参数透传（Option<bool>），L11002-11004 注释明确「只认显式 Some(true)」。
- 前端测试 `tests/vitest/anki/cardforge/CardAgent.test.ts` L325-338 覆盖不传/false 不开启、true 才开启。

### 4b. 协议中立 prompt（输出协议后端单点）

- `src/components/anki/cardforge/prompts/index.ts` L10-13/L26/L49：`buildCardGenerationSystemPrompt` 协议中立，前端不再持有 END 标记；`cardforge/index.ts` L123 注明 `CARD_JSON_END` 常量已删除（cardforge 目录下 rg 无残留）。
- 跨层契约夹具 `src-tauri/tests/fixtures/cardagent_system_prompt.txt` 存在；Rust 侧 `streaming_anki_service.rs` L4436-4443 `include_str!` 钉住并断言不含 `ANKI_CARD_JSON_END`，L4445 起以 CardAgent 真实 options 装配完整请求验证 json_schema 与 delimiter 两种协议；TS 侧 `tests/vitest/anki/cardforge/prompts.test.ts` L37-79 断言字节级一致 + 无协议标记导出。
- 注意：`src/utils/enhancedPromptGenerator.ts` L43/L68/L75 仍含 END 标记，但其唯一非测试调用方是 `templateService.generatePrompt` → `MinimalTemplateEditor.tsx` L1151 的**模板编辑器预览 UI**，不在 CardAgent 生成链路上，不构成红线违反（见行动建议）。

### 4c. lossless-only JSON 修复（截断不得静默吞）

- `src-tauri/src/anki_protocol.rs`：L690 `repair_json_detailed` 返回 `truncated_string` 标记（L666-676 文档）；L776-778 `repair_json` 过滤 `!truncated_string`，仅返回可证无损的修复；单测 L1144-1157 覆盖中途截断/悬挂转义置标、尾逗号不置标。
- `src-tauri/src/streaming_anki_service.rs` 生产侧：L1832-1841 `parse_and_save_card` 在 serde 失败后若 `repair.truncated_string` 则 `return Err(AppError::validation("JSON在字符串中途截断..."))`（上游降级为错误卡），仅无损形态才继续；L1756-1798 `expand_wrapper_payloads` 将有损修复的最后一张卡标记 `truncated`；L1471-1487 收尾处 `truncated` 卡计入 `failed_cards` 并 `create_error_card` 落错误卡保留残片——**截断要么错误卡要么显式 Err，无静默路径**。

### 4d. maxCards 全局配额

- 前端 `CardAgent.ts`：L197-218 `resolveMaxCardsTotal` 显式校验（undefined/null/非有限数/<1 回退默认 50，替代旧 `input.maxCards || 50` 的 falsy 巧合）；L542-553 写入 `max_cards_total`，`max_cards_per_mistake` 钳制为 `min(total, BACKEND_MAX_CARDS_PER_SEGMENT)`。
- 后端 `models.rs` L1266 `max_cards_total: Option<i32>`；`document_processing_service.rs` L85-95 建任务时 `distribute_global_max_cards`（L887）按分段分配额度；`streaming_anki_service.rs` L543-555 额度为 0 的分段直接完结跳过（防「0 = 无限制」）。
- 测试：Rust 侧 `document_processing_service.rs` L1404 `distribute_global_max_cards_cases`、L1417 `max_cards_total_distributes_quota_across_persisted_segments`（真实建任务路径落库验证分段额度总和 = total）；TS 侧 `CardAgent.test.ts` L249-320（maxCards=10 → max_cards_total=10、非法值回退 50、250 不截断透传）。

## 5. `4756e93c`（#341 rustfmt 收口）——仍在

触及 `document_processing_service.rs`、`streaming_anki_service.rs`、`tests/anki_fsrs_feedback.rs` 三个文件的纯格式化。`git diff 4756e93c HEAD` 对三个文件**均为空 diff**，格式化产物即 tip 现状，完整保留。

---

## 冲突点核查：`streaming_anki_service.rs` 测试区（MERGE-PLAN 加法保留）

两侧测试**都在、顺序相邻、语义完好、互不覆盖**：

| 侧 | 测试函数 | tip 行号 | 断言要点 |
|---|---|---|---|
| HEAD（#336/#328） | `parse_and_save_card_honors_qa_pass_flag_persistence_contract` | L4672-4730 | 三态（disabled/enabled/default）下返回卡与落库卡 `_qa_flags` 有无契约；默认开启；enabled 保留 `front_back_identical` |
| incoming（#338） | `parse_and_save_card_rejects_mid_string_truncation_as_error` | L4734-4766 | 字符串中途截断 payload 必须 `Err` 且错误信息含「字符串中途截断」，DB 中零卡入库 |
| incoming（#338） | `parse_and_save_card_still_repairs_lossless_damage` | L4768-4792 | 尾逗号+缺闭合括号（字符串已闭合）仍自动修复为正常卡入库 |
| incoming（#338，wrapper 侧） | `expand_wrapper_payloads_expands_wrapper_and_repairs_truncation` / `expand_wrapper_payloads_marks_mid_string_truncated_last_card` | L4546-4575 / L4578-4593 | wrapper 展开无损不误标；中途截断只标记最后一张 |

互不干扰的依据：三条 `parse_and_save_card` 测试各用独立 `task_id`（`qa-pass-{label}-task` / `truncated-task` / `lossless-task`）与独立 `document_id`（每次 `uuid::new_v4()` 后缀），且测试前后均 `release_document_tracker` 清理文档级去重指纹，不存在共享状态覆盖。HEAD 侧测试走 QA 门控断言、incoming 侧走截断/修复断言，语义正交。分节注释「0824 评审 #3：截断残卡不得静默入库」（L4732）也完整保留。

## 红线复核（是否回退）

| 红线 | 状态 | 关键证据 |
|---|---|---|
| enableQaPass/enable_qa_pass 门控 | 未回退 | 入库侧 L2047-2051（merge 后移除）；critic 侧 anki_critic.rs L945-954 + L692；executor 透传 chatanki_executor.rs L576-577/L6678/L11009 |
| FSRS opt-in | 未回退 | 仅 `Some(true)` / `=== true` 授权；默认摘要关闭；skill 文档默认关 |
| 协议中立 | 未回退 | cardforge prompt 无 END 标记，夹具双侧钉死；遗留 END 仅存于模板编辑器预览链路（非 CardAgent） |
| maxCards 全局配额 | 未回退 | `max_cards_total` 分配 + 0 额度分段跳过 + 显式校验回退 50 |
| lossless-only | 未回退 | `repair_json` 过滤 truncated；生产侧截断 → Err/错误卡，无静默路径 |

pick 之后唯一触及相关文件的提交 `d8a606c2` 为**加固方向**（金标溯源剔除 critic 修订卡，防自我强化回灌），符合「只许加固不许回退」。

## 给第 2 轮的行动建议

1. **无需针对本组五个 pick 做任何补救**——语义全部在 tip 上，冲突点两侧测试完好。
2. `src/utils/enhancedPromptGenerator.ts` 仍持有 `<<<ANKI_CARD_JSON_START/END>>>` 协议标记，当前仅被模板编辑器预览 UI（`MinimalTemplateEditor.tsx` L1151 经 `templateService.generatePrompt`）消费。第 2 轮若做协议单点化收尾，可评估：该预览文案与后端实际协议（json_schema 升级时无分隔符）可能不一致，建议要么在预览中声明「实际协议由后端协商」，要么让预览复用后端协议描述。**本轮不改产品代码，仅记录。**
3. `d8a606c2` 引入的 `CRITIC_REVISED_QA_CODE` 常量单点化（anki_critic.rs L65 引用 anki_gold_set）值得在金标组的二检中交叉确认常量值与前端 QA 面板过滤码一致。
4. 编译/测试均未运行（本轮禁令）；第 2 轮如安排动态验证，优先跑 `streaming_anki_service` 测试模块（冲突点所在）与 `anki_critic`、`document_processing_service` 的新测试，确认加法保留的测试区无编译级冲突（如重复辅助函数定义——静态检视未发现，`qa_flag_codes`/`seed_task`/`fingerprint_options` 各只有一处定义）。
