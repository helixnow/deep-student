# L12-vfs-index 测试去向（`host/plugins/vfs-index`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L12-vfs-index：79 行（真实测试 79）· pending 0 · ported 79
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-vfs/src/lance_vector_store.rs::tests::parse_dim_from_table_name_accepts_any_dim_and_rejects_others` | test | L4654 | ported:host/plugins/vfs-index/tests/lance-vector-store.test.ts |
| `crates/dstu-vfs/src/lance_vector_store.rs::tests::rows_to_retrieved_input_dedup_semantics` | test | L4689 | obsolete:dead-in-rust |
| `crates/dstu-vfs/src/lance_vector_store.rs::tests::clear_all_success_means_sqlite_and_every_lance_table_are_empty` | tokio::test | L4709 | obsolete:dead-in-rust |
| `crates/dstu-vfs/src/vfs/embedding_service.rs::tests::test_modality_support` | test | L656 | ported:host/plugins/vfs-index/tests/embedding.test.ts |
| `crates/dstu-vfs/src/vfs/embedding_service.rs::tests::test_chunks_to_lance_rows` | test | L662 | ported:host/plugins/vfs-index/tests/embedding.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::legacy_cross_dimension_flag_always_selects_unified_profile_planner` | test | L5280 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::compatibility_scores_preserve_weighted_rrf_order_and_chat_thresholds` | test | L5292 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_chunk_fixed_size` | test | L5301 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_chunk_semantic` | test | L5317 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_extract_markdown` | test | L5332 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_extract_translation` | test | L5343 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_missing_note_with_inline_data_keeps_indexable_fallback` | test | L5355 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/indexing.rs::tests::test_missing_note_without_inline_data_disables_index` | test | L5379 | ported:host/plugins/vfs-index/tests/indexing.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::test_table_name` | test | L2650 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::dimension_only_search_apis_reject_bare_vectors` | tokio::test | L2659 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::stale_embedding_result_cannot_switch_the_writable_profile_back` | test | L2676 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::legacy_profile_rolls_to_strong_fingerprint_without_a_query_gap` | test | L2717 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::legacy_upgrade_rejects_unbound_or_mismatched_config_profiles` | test | L2868 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::test_build_filter_expr` | test | L2931 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::legacy_cleanup_preserves_queryable_tables_and_retirement_sweep_retries` | tokio::test | L3031 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::clear_all_discovers_actual_tables_and_verifies_no_rows_remain` | tokio::test | L3127 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/lance_store.rs::tests::tiny_legacy_profile_repairs_to_exact_and_unit_generation_is_authoritative` | tokio::test | L3196 | ported:host/plugins/vfs-index/tests/lance-store.test.ts |
| `crates/dstu-vfs/src/vfs/multimodal_service.rs::tests::legacy_multimodal_search_inputs_build_unified_profile_requests` | test | L1742 | ported:host/plugins/vfs-index/tests/multimodal.test.ts |
| `crates/dstu-vfs/src/vfs/multimodal_service.rs::tests::url_only_image_cannot_bypass_profile_aware_retrieval` | test | L1785 | ported:host/plugins/vfs-index/tests/multimodal.test.ts |
| `crates/dstu-vfs/src/vfs/multimodal_service.rs::tests::multimodal_compatibility_scores_preserve_rrf_order` | test | L1793 | ported:host/plugins/vfs-index/tests/multimodal.test.ts |
| `crates/dstu-vfs/src/vfs/multimodal_service.rs::tests::test_multimodal_page` | test | L1801 | ported:host/plugins/vfs-index/tests/multimodal.test.ts |
| `crates/dstu-vfs/src/vfs/multimodal_service.rs::tests::parses_blob_and_unit_provenance_without_using_source_id` | test | L1815 | ported:host/plugins/vfs-index/tests/multimodal.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::ocr_temp_image_extension_follows_mime` | test | L4370 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::cancelled_compression_does_not_read_or_decode_the_file` | tokio::test | L4382 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::processing_slots_are_shared_and_waits_are_cancellable` | tokio::test | L4397 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::cancelled_processing_does_not_consume_a_free_slot` | tokio::test | L4428 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_processing_stage_as_str` | test | L4440 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_processing_stage_from_str` | test | L4447 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_processing_stage_order` | test | L4463 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_processing_progress_default` | test | L4470 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_has_retriable_failure_with_retriable_ocr_issue` | test | L4480 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_has_retriable_failure_without_issues` | test | L4494 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_has_retriable_failure_ignores_non_retriable` | test | L4506 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/pdf_processing_service.rs::tests::test_has_retriable_failure_from_persisted_json` | test | L4522 | ported:host/plugins/vfs-index/tests/pdf-processing.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::all_32_capability_subsets_match_exact_generation_and_retrieval_matrix` | test | L1089 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::active_mm_receives_original_image_and_never_uses_ocr` | test | L1171 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::active_tm_prefers_mm_observation_then_ocr` | test | L1184 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::image_retrieval_never_routes_through_text_embedding_or_ocr` | test | L1208 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::unhealthy_or_incompatible_capability_keeps_fts_alive` | test | L1229 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::rrf_does_not_merge_distinct_chunks_or_pages_of_same_resource` | test | L1285 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::time_range_does_not_split_fused_identity` | test | L1302 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::rrf_fuses_same_unit_without_comparing_raw_scores` | test | L1321 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::failed_route_does_not_discard_successful_routes` | test | L1344 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::strict_protocol_prevents_text_api_from_impersonating_image_embedding` | test | L1369 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::route_family_budget_is_stable_when_profiles_are_duplicated` | test | L1377 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::fusion_prefers_media_rich_representative_and_normalizes_scores` | test | L1424 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::pooled_fusion_keeps_all_candidates_for_post_filter_backfill` | test | L1459 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::max_per_resource_caps_hits_in_rank_order` | test | L1469 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::mmr_diversifies_across_resources` | test | L1492 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::empty_success_does_not_reset_failure_streak_but_closes_half_open_probe` | test | L1528 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::profile_circuit_breaker_opens_cools_down_and_allows_one_probe` | test | L1556 | ported:host/plugins/vfs-index/tests/retrieval-planner.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::request_validation_matches_declared_modality` | test | L2199 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::image_fallback_gate_waits_only_for_multimodal_image_routes` | test | L2217 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::generic_multimodal_model_is_observer_but_not_ocr_capability` | test | L2255 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::dedicated_ocr_only_does_not_advertise_text_or_multimodal_model` | test | L2289 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::capability_aggregation_exposes_index_mismatch` | test | L2329 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::runtime_fingerprint_mismatch_isolated_to_its_profile` | test | L2353 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::planned_routes_reject_same_id_model_or_transport_changes_independently` | test | L2415 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::matching_bound_legacy_profile_remains_queryable` | test | L2501 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::bound_legacy_profile_with_changed_model_name_remains_queryable` | test | L2545 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::unbound_or_differently_bound_legacy_profiles_are_isolated` | test | L2579 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::bound_legacy_profile_still_requires_protocol_dimension_and_index_compatibility` | test | L2608 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::tiny_exact_profile_is_index_compatible` | test | L2636 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_route_finds_unit_text_without_embedding_segment` | test | L2645 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_scope_is_applied_before_candidate_limit` | test | L2686 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_type_scope_preserves_legacy_aliases_and_unknown_fallback` | test | L2804 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_terms_split_chinese_questions` | test | L2830 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_route_uses_keywords_from_long_multimodal_observation` | test | L2845 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_route_ranks_more_term_matches_first_deterministically` | test | L2865 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_route_reranks_equal_term_matches_with_bm25` | test | L2890 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::bm25_query_terms_drop_question_words` | test | L2928 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::lexical_route_escapes_percent_and_underscore_keywords` | test | L2937 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::multimodal_scope_drops_plain_text_hits_without_media_or_me_provenance` | test | L2962 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
| `crates/dstu-vfs/src/vfs/unified_retriever.rs::tests::vector_hits_require_active_ledger_and_use_canonical_folder` | test | L3030 | ported:host/plugins/vfs-index/tests/unified-retriever.test.ts |
<!-- END GENERATED:testmap:rows -->

## WP-205 分支增量（去向不变）

前后仍 **77 ported / 2 approved obsolete / 0 merged / 0 pending**，没有更改任何 Rust ID。
已再次完整阅读 Rust pdf_processing_service.rs:4366-4535 与 pdf-processing.test.ts:1-93，
十二项 MIME/取消/许可/阶段/默认/retriable 原断言保持。N1 :983-1030 没有 inventory 测试 ID。
新 `tests/media-failure-integration.test.ts` 对照源码补实际入口回归：

- 配置失败（audio/video）：:983 queued 初值、:1008-1030 原 payload/WARN/Ok。
- 真实 WAV→F7→L18→HTTP401：:987-997 最后 ASR progress，:1009 from_str→Asr，
  :1015 原 payload 写入/保 progress，:1022 emit→成功；SQLite error trigger 对照 :1017 ERROR。
- 真实排队取消：:1001-1007 INFO/Ok，保 cancelled 行，不发 completed/error。
- 旧代真实配置失败：:2869 与 :3258 的 generation guard，旧任务不写/发事件/移除新代。
- 真实 imported transcript SQLite 异常（非 MediaError）：原 :806-848 外层仍有效。
- `pdf-lifecycle.test.ts` 另加两条明确标注的契约补充：原字符串 `\u0085 AsR \u0085`、
  `future_asr` 均作为最后 progress；setError 分别使用 Asr/Pending，事件/持久化 progress
  保原字符串。此两条注入公开 MediaError，仅补 from_str 分支，不替代上面七条真实 provider 验证。

原192七例不改；raw运行证据见报告，不据绿色恢复任何旧资格。

## WP-192 分支增量（去向不变）

前后均 **77 ported / 2 approved obsolete / 0 merged / 0 pending**；不修改生成区去向。
已读 Rust pdf_processing_service.rs:4366-4535 全部十二条测试及
`tests/pdf-processing.test.ts:4-93`；阶段字符串/解析/顺序、默认 progress、四项 retriable、
MIME 与取消/许可断言保持。本包 N1–N3 没有新增 inventory Rust 测试 ID。

补充分支回归在 `tests/pdf-lifecycle.test.ts`：
- `WP-192 duplicate start warns...` → Rust :707-716：WARN、generation 消耗、同一请求、
  原信号/状态保持；原任务可以完成。
- `WP-192 PDF outer failure...` → Rust :799-848、:2862-2892：真实 PDF 最终状态写失败，
  保初始 ocr_processing，ERROR 及 Debug OcrProcessing；set_error 失败时仍发两种原错误事件。
  替换 WP-009 原音频 fixture 的归属错误，保原二次失败 ERROR 断言并增加 PDF 兼容事件断言。
- 原取消/drain/旧代/u64 四例保持原断言；N1 的 MediaError 公开面阻塞不借此关闭，见 BLOCKERS。

## WP-009 原测试核对（去向不变）

本包前后均 **77 ported / 2 approved obsolete / 0 merged / 0 pending**。
已完整阅读以下 Rust 测试与现有 TS 测试，没有修改原断言、超时或去向：

- `pdf_processing_service.rs::tests::cancelled_compression_does_not_read_or_decode_the_file`
  （Rust:4382-4394）→ `tests/pdf-processing.test.ts:76-93`：提前取消返回 None/null；
  TS 另断言没有读取/解码，生产实现由 native runtime 调用。
- `pdf_processing_service.rs::tests::processing_slots_are_shared_and_waits_are_cancellable`
  （Rust:4397-4425）→ `tests/pdf-processing.test.ts:10-20`：取满许可后为0；取消者得
  None/null；释放一个后可再次取得。原100ms上限保留。
- `pdf_processing_service.rs::tests::cancelled_processing_does_not_consume_a_free_slot`
  （Rust:4428-4437）→ `tests/pdf-processing.test.ts:21-25`：已取消 token 不占许可，
  返回 None/null 且空闲数仍为 MAX_OCR_CONCURRENCY=4。
- `lance_store.rs::tests::tiny_legacy_profile_repairs_to_exact_and_unit_generation_is_authoritative`
  （Rust:3196-3301）→ `tests/lance-store.test.ts:722-767`：exact metric、ANN版本、
  ensured缓存、两次查询均只有一行且分别命中 generation 1/2，全部对应原断言。

`tests/lance-store.test.ts:364-438` 的 R12-09 三例补充 i64 2^53+1、MAX饱和、
Unit/Segment/Lance 与多模态 metadata 精度；不是新增 Rust 测试 ID。
`tests/pdf-lifecycle.test.ts` 的五例依据 Rust :729-762 的 Arc/Drop、:812-822 的
二次错误日志、:2613-2634 的 OCR 清理及 :2946-2961 的 cancel 补充宿主卸载保证，
也不冒充原 inventory 测试或提升整 lane 完成等级。

## 2026-11-05 符号级核查：两项审批已 main

C2审批 `e4680aa8a` 已随正常merge `977c14fba` 可见，祖先检查exit0，
`migration/approvals.d/C2-platform.json`的obsolete字段包含下列精确两个ID。
按C2指令仅这两行改为`obsolete:dead-in-rust`。原Rust/TS测试保留、不skip，
活跃维度解析、VFS clear_all(modality)和chat/KB维护不在范围内。

当前行状态为 **77 ported / 0 pending / 0 merged / 2 obsolete（已批准）**。生成表头未手改，
以行状态及ledger计算为准。两项现有TS测试/断言全部保留并继续执行，未加skip；
仅模块可达不能证明相关方法生产可达，因此先撤回ported、待main审批后才应用obsolete，
本lane未自行扩大批准范围。

1. `crates/dstu-vfs/src/lance_vector_store.rs::tests::rows_to_retrieved_input_dedup_semantics`
   ——Rust:4689-4705保护rows_to_retrieved的排序/去重前置逻辑；该方法的调用仅在
   :3199/:3220/:3301/:3304的旧VectorStore检索实现。vector_store.rs:1-9明确本trait
   无dyn/泛型外部调用、活跃KB检索已迁VfsLanceStore。全src-tauri的这些检索方法引用
   仅trait定义和实现内部。TS dedupeRowsByChunkId也仅定义/本测试调用。
2. `crates/dstu-vfs/src/lance_vector_store.rs::tests::clear_all_success_means_sqlite_and_every_lance_table_are_empty`
   ——Rust:4709-4784走旧VectorStore.add_chunks/clear_all；全src-tauri零参数clear_all
   仅该测试，不能混同vfs/lance_store.rs的带modality活跃clear_all。add_chunks仅trait
   定义/实现、:3851遗留迁移内部和本测试；迁移唯一公开入口:3633-3642已明确deprecated
   “死入口：当前无任何调用方”。现有TS legacyKb属性提供不构成原Rust有活跃调用的证据。

维度解析不在申请范围：Rust parse_dim_from_table_name:388经existing_dim_tables:407
被聊天维护调用。保原六项输入/期望，TS测试改测实际ChatLanceStore维护路径的同义方法。
Rust lib.rs:1652-1654的聊天/KB优化仍活跃，也不在上述两项退役申请范围。
