# r7-test-inventory：Wave2-A 反例测试全量索引（第 7 轮 #10）

- 作者：0824 Wave2-A 第 7 轮子代理 #10「索引员」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 基线：枝 `cursor/0824-wave2-agent-cache-a875` tip `618634a6`；第 7 轮 #1–#8
  的测试改动均在工作区未提交（3 M + 5 untracked 测试文件）。
- 取证时点：第 7 轮各席并行写作。本席对八个第 7 轮测试文件做了**间隔 90 秒的
  双快照 md5 对比（全部一致）**后才定稿本索引，函数名与行号以该稳定态为准；
  与 #9 台账（`docs/dev/wave2-A-ledger.md` R7 节，17:12:43Z 快照）逐文件核对
  行数/测试数一致。
- 纪律自证：本席只写本文件，未改任何测试/产品代码，未执行 cargo / npm /
  任何测试，未 commit / push（父代理收轮）。

---

## 0. 读法与状态图例

「预期红/绿」全部是**静态推演**——自第 1 轮起没有任何一条测试被执行过，
连 `cargo check` 都没跑过（铁律）。图例：

| 标记 | 含义 |
|---|---|
| 绿 | 按当前 tip 生产语义（或文件内契约副本）静态推演应通过 |
| 绿·旧行为红 | 现在应绿；文件头论证了在方案 A 落地前的旧行为下该测试会红（这就是「反例」的红面） |
| 绿·留档 | 现在应绿，但断言钉的是**已留档的现状缺口/兼容代价**——语义收口后对应断言应翻转（文件内有明示），届时不改即红 |
| 绿·合同预演 | 以假件模拟**尚未落地的修复合同**的目标语义；修复落地后应改为对生产断言 |
| 未执行 | 所有行恒为「未执行」，表内不再重复；未挂 mod 的文件更是**连编译面都没进**（见 §3） |

「挂载」列：已挂 = `pipeline.rs:87-98` 已有 `#[cfg(test)] mod` 声明，参与
测试构建编译；未挂 = mod 声明待父代理补（`pipeline.rs` ×3、
`providers/mod.rs` ×2），当前为纯源码存在。

## 1. 文件级总表（10 个反例测试文件，共 69 个测试函数）

| # | 文件 | 来源轮/席 | 行数 | 测试数 | 挂载 | 主题 |
|---|---|---|---|---|---|---|
| 1 | `src-tauri/src/chat_v2/pipeline/prefix_generation_fork_tests.rs` | r2 #5 + r7 #1 强化 | 359 | 4 | 已挂（pipeline.rs:92） | 多变体 tools 前缀分叉→索引序收敛+切代，T+2 终局 |
| 2 | `src-tauri/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs` | r7 #2 新建 | 473 | 4 | **未挂** | 分叉后稳态：后轮同现 X+Y、多轮/重启/迟到写回免疫 |
| 3 | `src-tauri/src/chat_v2/pipeline/prefix_generation_restore_tests.rs` | r2 #6 | 539 | 3 | 已挂（:94） | 代际快照跨进程恢复、并发首建、advance 无变更跳写 |
| 4 | `src-tauri/src/chat_v2/pipeline/prefix_snapshot_tests.rs` | 前置厚工单（wave2-A 前） | 234 | 4 | 已挂（:90) | system/tools 跨轮字节前缀稳定（本波反例族的存量地基） |
| 5 | `src-tauri/src/chat_v2/pipeline/skill_replay_digest_tests.rs` | r3 #5 + r7 #3 强化 | 745 | 7 | 已挂（:98） | 技能锚定重放 digest 门禁契约 + 生产门禁终局 |
| 6 | `src-tauri/src/chat_v2/pipeline/skill_replay_edit_delete_tests.rs` | r7 #4 新建 | 479 | 7 | **未挂** | 技能编辑/删除全生命周期，直打生产门禁+信号+插入层 |
| 7 | `src-tauri/src/chat_v2/pipeline/llm_content_crash_tests.rs` | r3 #4 + r7 #5 强化 | 607 | 13 | 已挂（:96） | llm_content sidecar 崩溃窗口全崩溃点谱系（假件） |
| 8 | `src-tauri/src/chat_v2/pipeline/llm_content_retry_gap_tests.rs` | r7 #6 新建 | 454 | 7 | **未挂** | retry 路径 sidecar 四缺口现状 + 修复合同预演（假件） |
| 9 | `src-tauri/src/providers/wave2_a_prefix_snapshot_tests.rs` | r7 #7 新建 | 417 | 6 | **未挂** | 三家 post-adapter body 稳定前缀段字节对比（生产适配器） |
| 10 | `src-tauri/src/providers/wave2_a_anthropic_budget_tests.rs` | r7 #8 新建 | 463 | 14 | **未挂** | Anthropic 四槽预算守卫直调 + marker 透传（生产守卫） |

范围界定：`pipeline/parallel_exec_tests.rs`（2026-07 并行工具改造的常规
单测，非反例）不入本索引主表；散布在产品文件里的 wave2-A 相关内联
`#[cfg(test)]` 模块见 §4 伴随清单。

## 2. 函数级索引

### 2.1 `prefix_generation_fork_tests.rs`（r2 #5，r7 #1 补 1 条终局）

打契约副本 `converge_orders_by_variant_index`（#1 席位落地
`helpers::converge_session_tool_face_prefix` 后应改调生产函数，断言原样保留），
append-only 合并原语复用生产 `tool_loop::merge_frozen_tool_schema_order_baseline`。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :136 | `divergent_variant_tails_x_vs_y_converge_by_variant_index_and_bump_generation` | 绿·旧行为红 | A 追加 X、B 追加 Y：收敛序由**变体索引序**唯一确定（非完成竞态序、非字母序），真分叉 generation 0→1，重复收敛幂等不再 bump；测试体内并陈旧 append-only 竞态两结局互异的反例 |
| :214 | `single_variant_prefix_extension_does_not_bump_generation` | 绿 | 单写者纯前缀扩展永不切代，generation 保持 0，旧缓存前缀仍有效 |
| :246 | `later_round_both_variants_see_xy_share_generation_1_order` | 绿 | T+1 两变体从同一 (g=1, B₁) 出发，order/字节逐位一致，Δg=0、应跳过写库 |
| :292 | `t_plus_2_steady_state_after_fork_both_variants_share_order_and_generation`（r7 #1 新增） | 绿·旧行为红 | 从分叉轮 T 连跑 T→T+1→T+2：整条时间线只切一次代（generation 恒 1）、稳态 order 是轮 T 收敛结果的不动点、请求字节跨变体且跨轮全等、稳态重复收敛幂等 |

### 2.2 `prefix_generation_fork_finale_tests.rs`（r7 #2 新建，未挂）

同源契约三副本（converge / `snapshot_from_metadata` /
`advance_snapshot_into_metadata`，测试模块间无法互 import 故独立成副本），
快照类型直接用生产 `types::ToolFacePrefixSnapshot`。文件头明示：旧竞态行为
下测试 1/2 会红，方案 A 下四条全绿。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :246 | `after_fork_next_round_both_variants_see_x_and_y_with_stable_generation` | 绿·旧行为红 | 轮 T 收敛持久化后，T+1 两变体**同现** X+Y（非各见各的）、字节一致、Δg=0、advance 跳写，generation 稳定在 1 |
| :318 | `steady_state_survives_many_rounds_and_variant_index_shuffles` | 绿·旧行为红 | T+1..T+4 连续空轮 + 变体索引洗牌：generation 恒 1、order 字节恒等，稳态不因轮数或索引分配抖动 |
| :374 | `restart_between_fork_and_next_round_preserves_xy_visibility_and_generation` | 绿 | 轮 T 与 T+1 之间桌面 App 重启（内存清空）：从 metadata 恢复后依然同现 X+Y、generation 仍为 1 |
| :427 | `stale_pre_fork_writeback_cannot_regress_steady_state` | 绿 | 掉队变体把分叉前旧快照（g=0, B̂+[Y]）写回：advance 必须跳过写库，稳态 generation/order 一个字节不回退 |

### 2.3 `prefix_generation_restore_tests.rs`（r2 #6，本轮未动）

契约副本对齐 `repo.rs` 读写路径（`tool_face_prefix_from_metadata` /
`advance_session_tool_face_prefix_with_conn`）与 helpers 加锁回填段。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :172 | `cleared_memory_map_restores_same_generation_and_order_from_metadata` | 绿 | 重启清内存后从 metadata 恢复 generation+order 逐项一致；禁字母序冷重建、禁 generation 归零；含 serde camelCase 往返与旧会话缺代际键兼容（视为 0） |
| :333 | `concurrent_first_build_converges_to_single_generation_zero_baseline` | 绿 | 双调用同时内存 miss：先写 wins、后写 append-only merge 不 bump，两种加锁先后序收敛到同一终态 |
| :406 | `advance_skips_write_when_generation_order_digest_unchanged` | 绿 | 三者全同→跳写且 metadata 字节不动（不推 updated_at）；子集写回/无 digest 写回同样跳过；对照组：追加新名或 digest 变化写库但均不 bump generation |

### 2.4 `prefix_snapshot_tests.rs`（wave2-A 前置存量，本轮未动）

打生产 `PromptBuilder::build_split` 与 tool_loop 冻结原语。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :87 | `system_prefix_bytes_identical_across_rounds_while_volatile_inputs_change` | 绿 | todos/canvas/检索/画像逐轮漂移时 stable_system 字节逐轮相等，变化全落 turn-volatile |
| :115 | `todos_and_canvas_never_leak_into_stable_system` | 绿 | 六类 volatile 标签 + 具体动态文本零泄漏进 system |
| :146 | `emitted_tools_serialization_is_strict_byte_prefix_of_later_rounds` | 绿 | 已发出 tools 字节是后轮严格前缀（含进程重启 JSON 往返、来源乱序、环内披露），第 3 轮无新工具字节幂等 |
| :199 | `combined_request_prefix_only_grows_at_the_tail_across_rounds` | 绿 | system+tools 组合前缀跨轮只允许尾部追加 |

### 2.5 `skill_replay_digest_tests.rs`（r3 #5，r7 #3 补第 5 节终局）

第 1–4 节仍为 r3 契约副本（FNV 摘要 + `contract_rebuild_anchored_skill_messages`）；
r7 第 5 节改打**生产门禁** `history::rebuild_anchored_skill_messages_gated_with_signal`
+ `types::skill_body_digest`（sha256，对 (id, body) 联合取摘要）。生产二参兼容
入口 `rebuild_anchored_skill_messages` 专为既有反例段保留。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :209 | `modified_skill_digest_mismatch_skips_instead_of_forging_history` | 绿 | 正文 v1→v2：契约副本 skip 且携双侧 digest；📌 反例段用无门禁生产二参入口证明「盲取输出 v2 字节 ≠ 轮 1 真实历史」 |
| :273 | `multi_anchor_mismatch_skips_only_the_drifted_skill_keeping_order` | 绿 | 只 skip 漂移锚点，完好锚点按序重建与 live 同字节 |
| :326 | `deleted_skill_missing_content_warns_and_skips_without_blocking` | 绿 | 缺正文→结构化 MissingContent skip 不阻塞；映射整体 None 全 skip；与生产 None 分支同字节对齐 |
| :388 | `matching_digest_replays_byte_identical_to_live` | 绿 | digest 一致→重建与 live 逐字节相等（role+content+metadata）；钉死 escape_xml_attr 与渲染模板字节形态 |
| :447 | `digest_is_deterministic_and_sensitive_to_any_byte_change` | 绿 | 摘要两性质：确定性 + 任意字节差异敏感（单字符/尾换行/CRLF/空串/空格互异）；换算法测试原样保留 |
| :508 | `finale_modified_skill_gate_skips_signals_and_recovers_on_revert`（r7 #3 新增） | 绿 | **生产门禁**终局：mismatch→skip + `mismatched_skill_ids` 去重信号；停在 v2 多少轮结果恒等（skip 是终局）；正文逐字节回退 v1 即恢复 live 同字节且不再发信号 |
| :625 | `finale_deleted_skill_gate_skips_without_signal_and_recovery_needs_exact_bytes`（r7 #3 新增） | 绿·留档 | 删除（缺正文）skip 且**永不**发换代信号（与 mismatch 严格区分，r5 刻意收窄口径）；同 id 重建仅字节精确还原才恢复，字节不同转 mismatch 档 |

### 2.6 `skill_replay_edit_delete_tests.rs`（r7 #4 新建，未挂）

直打生产入口（门禁 + 锚点 meta JSON 序列化往返 + `insert_transient_skill_messages`
插入层），覆盖编辑/删除两条用户动作的完整生命周期。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :107 | `edit_lifecycle_anchor_persist_reload_gate_skips_edited_body_and_signals` | 绿 | 锚定→meta JSON 落库→反序列化→门禁 skip + skill_id 进切代信号；隐私红线：锚点 JSON 只含 digest 不含正文 |
| :177 | `edit_then_revert_heals_replay_byte_identical_without_new_signal` | 绿 | 正文改回 v1：digest 重新命中、与轮 1 live 逐字节相等、回滚轮不追加新信号（门禁只认字节） |
| :227 | `deleted_skill_skips_without_signal_documenting_residual_gap` | 绿·留档 | 删除（锚点有 digest 但正文缺失）→ skip 无信号不阻塞；📌 钉死 r6 #4 观察 1 残余缺口现状——若后续把「有 digest 但缺正文」计入信号，最后两条断言应翻转 |
| :273 | `deleted_live_skill_with_replay_snapshot_still_replays_old_bytes` | 绿 | live 目录已删但 replay 快照携旧正文（消费点 `replay_skill_contents.or(skill_contents)` 快照优先）→ digest 命中照常按旧字节重建 |
| :306 | `mixed_edit_delete_intact_judged_per_anchor_with_deduped_signal` | 绿 | 完好/编辑/删除三命运同轮共存：逐锚判定、skip 不阻塞不换序；turn 级+tool 级共查同一 digest map，信号按 id 去重且共享聚合器既有条目保留 |
| :372 | `legacy_anchor_without_digest_blindly_replays_edited_body` | 绿·留档 | 旧锚点（无 digest 字段，空 map）走向后兼容档「有正文就重建」——无从发现编辑，会输出新字节冒充旧历史（兼容代价，r3 契约明文非 bug）；对照：锚点带上 digest 立即转 skip |
| :438 | `all_anchors_skipped_leaves_history_untouched_including_request_anchor` | 绿 | 全部 skip → 插入层 no-op：历史一条不动、不产生 `<request_context>` 锚壳；对照组有一条命中则锚壳照常 |

### 2.7 `llm_content_crash_tests.rs`（r3 #4，r7 #5 补 10 条）

假件（`FakeUserBlockRow` / `FakeTurnTimeline`）复刻 repo/persistence/history
语义，不触真实 DB；崩溃点谱系全覆盖。retry 轮包装缺口不在本文件（见 2.8）。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :227 | `crash_after_send_without_early_persist_replays_bare_user_content` | 绿 | 无前移：已发 provider、save_results 前崩溃 → sidecar NULL、下轮只回裸文本、与 live 字节漂移（记录前移改造要消灭的缺陷形态） |
| :266 | `crash_after_send_with_early_persist_replays_live_wrapped_bytes` | 绿 | 有前移（阶段 4.6）：同一崩溃点重放=live 完整包装字节 |
| :300 | `empty_llm_content_sidecar_falls_back_to_bare_content` | 绿 | 空串 sidecar 视同缺失回退裸文本（对齐 history.rs filter） |
| :317 | `whitespace_only_llm_content_sidecar_is_replayed_verbatim`（r7 #5） | 绿·留档 | 空白串**不**视同缺失、原样回放（读侧只滤 is_empty 的理论角落）；文件内明示：若判空改成 trim 语义，本测试应当红提醒同步回退合同 |
| :338 | `crash_before_first_send_is_harmless_no_cross_turn_drift`（r7 #5） | 绿 | 早写与发送前崩溃：模型未见任何字节，下轮裸文本重建是首发非漂移——钉死早写窗口下界 |
| :364 | `crash_after_early_persist_before_send_replays_persisted_wrapper`（r7 #5） | 绿 | 早写后、发送前崩溃：sidecar 成为确定性锚点，下轮起字节恒定不随 runtime_facts 抖动 |
| :395 | `save_point_rebuild_preserves_early_sidecar_and_rewrites_idempotently`（r7 #5） | 绿 | 保存点重建行（ON CONFLICT DO UPDATE 列清单不含 llm_content，r6 §2.4）不抹早写；persist_replay_sidecar 同值幂等重写 |
| :435 | `edit_resend_invalidates_stale_sidecar_then_early_persist_backfills`（r7 #5） | 绿 | 编辑事务失效旧 sidecar 后早写补新包装：任何崩溃点都不复活编辑前旧字节 |
| :480 | `unmigrated_db_early_persist_silently_skips_and_never_blocks_send`（r7 #5） | 绿 | V20260806 列未迁移：早写静默跳过（no such column → Ok），核心合同是不阻断发送 |
| :511 | `legacy_multi_content_blocks_write_and_read_hit_same_first_row`（r7 #5） | 绿 | legacy 多 CONTENT 块（A1 前孤儿）：写侧首块、读侧 find_map 同序首个 Some——写读同行 |
| :536 | `legacy_multi_content_blocks_empty_first_sidecar_masks_later_wrapper`（r7 #5） | 绿·留档 | 首块空串遮蔽后块非空值（filter 挂在 find_map 之后）的现状角落钉死 |
| :562 | `early_persist_preserves_multibyte_bytes_exactly`（r7 #5） | 绿 | 多字节 UTF-8 逐字节保真——sidecar 是字节权威不得规范化 |
| :591 | `multi_variant_fanout_without_early_persist_crash_window_remains`（r7 #5） | 绿·留档 | multi_variant 扇出不经 execute_internal 阶段 4.6、无早写，崩溃窗口仍在（r6 §3.2，记录非修复） |

### 2.8 `llm_content_retry_gap_tests.rs`（r7 #6 新建，未挂）

假件模拟 retry ctx / sidecar 查找 / history 组装。测试 1–4 固化 R6-6 遗留 1
的**现状缺口**（retry 用全新 `msg_{uuid}`，各保存点查行全部落空且无兜底），
5–6 为修复合同（复用前置 user id，对齐编辑重发语义）。修复落地时 1–4 应
翻转、5–6 转为生产断言（文件头明示）。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :204 | `retry_fresh_user_message_id_skips_early_and_save_point_sidecar_writes` | 绿·留档 | 缺口 1：全新 uuid 查不到行，前移与 save 点双双跳过，retry 轮 live 新包装任何保存点都不落库 |
| :247 | `retry_leaves_stale_sidecar_next_turn_drifts_from_retry_live_bytes` | 绿·留档 | 缺口 2：前置用户行保留原始轮旧包装，下轮重放 ≠ retry 轮 live 字节（跨轮漂移，cache 自分叉点 miss） |
| :283 | `retry_after_crash_window_null_sidecar_misses_backfill` | 绿·留档 | 缺口 3：原始轮崩溃留 NULL，retry 明明重编译发送了完整包装却不回填 |
| :323 | `retry_live_request_double_includes_preceding_user_message` | 绿·留档 | 缺口 4：排除集不含前置用户 id + 未设 is_continue → 同一问题以旧/新两种包装在 live 请求中出现两次 |
| :364 | `retry_reusing_preceding_user_id_closes_sidecar_gaps` | 绿·合同预演 | 修复合同：复用前置 user id → 排除集吃掉重复、前移命中既有行覆写陈旧 sidecar、下轮重放 == retry 轮 live 字节 |
| :405 | `retry_reusing_preceding_user_id_backfills_null_sidecar` | 绿·合同预演 | 修复合同边界：崩溃遗留 NULL 经 retry 自然回填 |
| :431 | `empty_live_content_never_persists_and_empty_sidecar_falls_back_bare` | 绿 | 边界不变量：写侧空编译内容不落库、读侧空串视同缺失——修复实现必须保持两个 filter |

### 2.9 `providers/wave2_a_prefix_snapshot_tests.rs`（r7 #7 新建，未挂）

直打生产适配器三条转换路径（`OpenAIAdapter::build_request` /
`OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint` /
`AnthropicAdapter::convert_openai_to_anthropic`）；字节确定性依赖 serde_json
preserve_order（Cargo.toml 已启用，源码推理未运行时对拍——R2-6 旧债）。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :157 | `openai_chat_prefix_segments_byte_identical_across_consecutive_requests` | 绿 | OpenAI Chat：连续两请求 sanitize 后 tools/tool_choice/system 首位序列化字节逐字相等（含缺 parameters 工具的归一化稳定） |
| :201 | `openai_responses_developer_breakpoint_prefix_byte_identical_across_consecutive_requests` | 绿 | gpt-5.6 官方端点：input[0] developer 显式断点块与 tools 前缀字节跨请求相等 |
| :248 | `anthropic_system_and_tools_prefix_byte_identical_across_consecutive_requests` | 绿 | Anthropic：system 尾/tools 尾 ephemeral 断点自动补齐后前缀段字节跨请求相等 |
| :292 | `deepseek_chat_prefix_segments_byte_identical_across_consecutive_requests` | 绿 | DeepSeek chat（同 OpenAI Chat 路径）自动前缀缓存面字节稳定 |
| :332 | `deepseek_responses_instructions_prefix_byte_identical_across_consecutive_requests` | 绿 | DeepSeek Responses：顶层 instructions 前缀字节稳定 |
| :374 | `reconverting_identical_body_is_fully_byte_deterministic_for_all_three_providers` | 绿 | 同一入站 body 重复转换：三家输出全字节确定（任何 marker/字段序抖动以字节 diff 暴露） |

### 2.10 `providers/wave2_a_anthropic_budget_tests.rs`（r7 #8 新建，未挂）

直调生产 `enforce_anthropic_cache_breakpoint_budget`（mod.rs:2930）+
`convert_openai_to_anthropic` 端到端；对 mod.rs 既有 ROUND-05 内联用例做
增量补位不重复。R6-6 §6 所记「system 剥除循环零测试覆盖」由 :133/:183 补上。

| 行 | 函数 | 预期 | 断言要点 |
|---|---|---|---|
| :88 | `budget_constant_matches_anthropic_hard_limit` | 绿 | `ANTHROPIC_CACHE_BREAKPOINT_BUDGET == 4` 先钉死，常量漂移则边界用例失义 |
| :95 | `guard_noop_when_block_markers_within_budget` | 绿 | 预算内（≤3 块级）守卫零改动 |
| :118 | `guard_without_tools_keeps_system_markers_within_budget` | 绿 | tools=None 时 system markers 在预算内原样保留 |
| :133 | `guard_without_tools_strips_earliest_system_markers_on_overflow` | 绿 | 纯 system 超载：按 prompt 序从最靠前 marker 剥除 |
| :155 | `guard_strips_earliest_tool_markers_and_leaves_no_null_on_serialize` | 绿 | 纯 tools 超载：靠前先剥且剥后 Option 归 None（序列化无 `cache_control: null` 残留） |
| :183 | `guard_overflow_crosses_from_tools_into_system` | 绿 | 剥除跨 tools→system 边界（tools 先于 system） |
| :204 | `guard_preserves_surviving_marker_payload_verbatim` | 绿 | 存活 marker 载荷（含 ttl 扩展形态）逐字节保真，只整体保留或整体剥除 |
| :226 | `guard_handles_empty_inputs_without_panic` | 绿 | 空入参（None/空 vec）不 panic |
| :244 | `anthropic_tool_marker_passthrough_keeps_position_and_payload` | 绿 | 透传契约：非尾工具 marker 位置保持、载荷逐字节透传 |
| :286 | `anthropic_marker_nested_in_function_object_is_not_a_tool_marker` | 绿 | marker 必须在 tools[] 条目顶层，嵌进 `function` 对象不算 |
| :316 | `anthropic_dropped_tool_entry_marker_has_no_side_effects` | 绿 | 非 function 条目被丢弃时其 marker 不抑制尾部保险断点、不占预算 |
| :350 | `anthropic_all_invalid_tools_yield_no_tools_key` | 绿 | 全无效 tools → 输出无 tools 键 |
| :382 | `anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers` | 绿 | 守卫×保险断点交互：自动 tools 尾断点参与预算、超载时先于调用方 system marker 被剥 |
| :441 | `anthropic_passthrough_marker_survives_budget_guard_within_budget` | 绿 | 预算内透传 marker 经守卫存活 |

## 3. 挂载与执行状态汇总（收轮硬事实）

1. **全部未执行**：上表 69 个测试（连同 §4 内联存量）自 r1 起累计零执行、
   零编译验证（`cargo check` / `cargo test` / rustfmt 均未跑，铁律）。
2. **五文件未进编译面**：`prefix_generation_fork_finale_tests` /
   `skill_replay_edit_delete_tests` / `llm_content_retry_gap_tests`（待
   `pipeline.rs` 挂 `#[cfg(test)] mod`）与 `wave2_a_prefix_snapshot_tests` /
   `wave2_a_anthropic_budget_tests`（待 `providers/mod.rs` 挂）——mod 声明
   按任务卡由父代理加；未挂前「预期绿」连编译门都未过。
3. **风险梯度**（首验建议顺序，与 #9 台账 R7-4 一致）：直打生产符号的
   2.6/2.5 第 5 节/2.9/2.10（签名或可见性漂移即编译错）＞ 契约副本的
   2.1/2.2/2.3（副本与生产语义漂移则绿得虚假）＞ 纯假件的 2.7/2.8
   （假件复刻语义若与生产不符则固化了错误契约）。
4. **已知的「应转红」触发器**（语义收口时不改测试即红，全部在文件内明示）：
   删除计入换代信号（2.5 :625、2.6 :227）、旧锚点兼容档收紧（2.6 :372）、
   sidecar 判空改 trim（2.7 :317）、multi_variant 早写补齐（2.7 :591）、
   retry 复用前置 user id 落地（2.8 :204/:247/:283/:323 翻转，:364/:405
   转生产断言）。

## 4. 伴随清单：产品文件内的 wave2-A 相关内联测试（已挂、同样未执行）

不属「反例测试文件」但属同一验证欠账，验证轮应一并跑：

| 文件 | 模块/函数 | 来源 |
|---|---|---|
| `pipeline/history.rs` | `mod skill_replay_gate_tests`（:1240）：`gate_skips_mismatch_and_rebuilds_match_in_anchor_order`（:1265）、`legacy_anchor_without_digest_keeps_old_rebuild_behavior`（:1285）、`gate_signal_collects_only_digest_mismatches_deduped`（:1313） | r3 #3 / r5 #8 |
| `pipeline/history.rs` | `mod replay_consistency_tests`（:1478，6 条 async 重放对拍） | P1-8 存量 |
| `pipeline/helpers.rs` | `test_p1_8_cross_turn_injection_point_bytes_live_eq_replay`（:2338）、`test_p1_8_in_loop_skills_do_not_touch_prefix_before_current_user`（:2418） | r3 |
| `pipeline/hooks.rs` | `audit_consumed_admission_fields_start_fail_closed`（:1531；伴既有 `default_hooks_keep_approval_gate_first` :1517） | r1 #6 |
| `utils/model_special_tokens.rs` | 游标化/过滤器套件（:639-:863，17 条；其中 `strips_tail_glued_closer_followed_by_blank_lines_at_flush` :813 为 r6 #5 tail-hold 泄漏回归） | r4 #2 / r6 #5 |
| `providers/mod.rs` | 内联 provider 套件（如 `openai_adapter_choice_completion_keeps_event_sequence_until_done_marker` :3973——R5-6 曾判「执行必挂」、R6 #9 复核已改正；breakpoint 门控 :5194/:5278/:5317；Anthropic 断点/预算 :5685-:5845；usage cache 字段 :6135 起） | r5 #2 及前后 |

## 5. 交叉引用

- 任务卡：`docs/dev/wave2-A/ROUND-07-TASKS.md`（本索引为 #10 可写面）。
- 汇总台账：`docs/dev/wave2-A-ledger.md` R7 节（#9，17:12:43Z 快照口径；
  其 R7-2 表行数/测试数与本索引逐文件一致，本索引提供函数级明细，
  #9 台账明示以本索引为最终口径）。
- 设计依据：`r1-multi-variant-design.md` §4 方案 A（2.1/2.2/2.3）、
  `r3-llm-content-forward.md` + `r6-llm-content.md`（2.7/2.8）、
  `r3-skill-digest-types.md` + `r6-skill.md`（2.5/2.6）、
  `r5-provider-p2.md` + `r6-p2.md`（2.10）、`r6-p0.md`/`r6-p1.md`（2.9）。
- 本席未 commit / push（遵嘱）；待 add 清单与验证轮欠账见 #9 台账 R7-5。
