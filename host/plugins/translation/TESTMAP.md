# L02-llm-manager 测试去向（`host/plugins/translation`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L02-llm-manager：42 行（真实测试 42）· ported 42
<!-- END GENERATED:testmap:header -->

## 测试

2026-11-05 逐函数接线核对：ported 40、pending 2（R1-TR-03 metadata owner组合及R1-TR-07注册表证据缺口）。
两条decode_payload原断言已迁到公开ocr_extract_text命令→真实FreeOCR/provider入口，
使用F4公开strict base64；20261104154626-f3d816五项生产入口测试通过（exit0），不再借同文件wiring计分。
原纯函数测试保留；F7大图测试只证明真实适配器可运行和尺寸/quality参数，不冒充D5/C像素签收。

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-tutor/src/translation/chat_popover.rs::tests::popover_leaves_output_limit_to_model_configuration` | test | L371 | ported:host/plugins/translation/tests/transport.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::extracted_policy_matches_pre_migration_implementation` | test | L1045 | ported:host/plugins/translation/tests/policy_legacy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::translation_payload_uses_model_and_provider_output_budget` | test | L1083 | ported:host/plugins/translation/tests/transport.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::translation_payload_preserves_explicit_output_budget` | test | L1102 | ported:host/plugins/translation/tests/transport.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::detect_japanese_with_kanji_mix` | test | L1117 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::detect_chinese` | test | L1123 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::detect_korean` | test | L1131 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::detect_english` | test | L1136 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::accented_latin_not_reported_as_english` | test | L1144 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::empty_text_returns_none` | test | L1153 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::segments_roundtrip_preserves_text` | test | L1158 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::small_text_stays_single_segment` | test | L1169 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::oversized_paragraph_falls_back_to_sentence_chunks` | test | L1177 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::latin_sentence_chunks_keep_word_spacing` | test | L1189 | ported:host/plugins/translation/tests/policy.test.ts |
| `crates/dstu-tutor/src/translation/pipeline.rs::tests::no_punctuation_text_hard_splits_on_char_boundary` | test | L1201 | ported:host/plugins/translation/tests/policy.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::handles_translation_tools_and_sensitivity` | test | L1580 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::registers_before_general_catch_all` | test | L1611 | pending |
| `src/chat_v2/tools/translation_executor.rs::tests::translated_output_limit_is_proportional_with_floor_and_ceiling` | test | L1629 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::translate_args_accept_prompt_override_and_reject_blank_or_oversized` | test | L1648 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_read_args_are_strict_and_bounded` | test | L1670 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::translate_args_parse_strict_inline_terms` | test | L1704 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::translate_args_reject_glossary_id_and_invalid_enums` | test | L1729 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::language_validation_is_bounded_and_target_cannot_be_auto` | test | L1747 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::unicode_preview_never_splits_a_character` | test | L1761 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::paragraph_aware_segmentation_is_bounded_and_lossless` | test | L1770 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::cancellation_guard_rejects_before_or_between_segments` | test | L1798 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_cache_enforces_owner_ttl_entry_and_character_bounds` | test | L1823 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_cache_is_consumed_explicitly` | test | L1850 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_cache_claim_prevents_concurrent_double_save_and_can_be_released` | test | L1860 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_cache_stale_claim_is_reclaimable_after_crash_window` | test | L1890 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::result_cache_peek_does_not_consume_or_respect_claims` | test | L1917 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::global_result_cache_rejects_expired_save_source` | test | L1934 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::persisted_metadata_snapshot_matches_workbench_keys` | test | L1968 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::save_args_require_exactly_one_source_mode` | test | L2007 | ported:host/plugins/translation/tests/tool_executor.test.ts |
| `src/chat_v2/tools/translation_executor.rs::tests::save_repo_normal_path_and_folder_error_mapping` | test | L2049 | pending |
| `src/cmd/translation.rs::tests::decode_payload_infers_png_from_signature` | test | L139 | ported:host/plugins/translation/tests/ocr_command.test.ts |
| `src/cmd/translation.rs::tests::decode_payload_prefers_data_url_mime_when_signature_is_insufficient` | test | L148 | ported:host/plugins/translation/tests/ocr_command.test.ts |
| `tests/c1_cross_lang_consistency.rs::workbench_mode_missing_defaults_open_with_browser_child_on` | test | L13 | ported:host/plugins/translation/tests/c1_cross_lang.test.ts |
| `tests/c1_cross_lang_consistency.rs::workbench_mode_explicit_false_closes_even_when_browser_child_on` | test | L21 | ported:host/plugins/translation/tests/c1_cross_lang.test.ts |
| `tests/c1_cross_lang_consistency.rs::browser_child_gate_remains_opt_in_when_parent_defaults_open` | test | L28 | ported:host/plugins/translation/tests/c1_cross_lang.test.ts |
| `tests/c1_cross_lang_consistency.rs::incremental_backup_disabled_message_matches_data_governance_english` | test | L38 | ported:host/plugins/translation/tests/c1_cross_lang.test.ts |
| `tests/c1_cross_lang_consistency.rs::set_params_rejects_incremental_job_with_english_removed_message` | test | L51 | ported:host/plugins/translation/tests/c1_cross_lang.test.ts |
<!-- END GENERATED:testmap:rows -->
