# L11-vfs-repos 测试去向（`host/plugins/vfs-repos`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L11-vfs-repos：158 行（真实测试 158）· pending 0 · ported 158
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_decode_base64_plain` | test | L3311 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_decode_base64_data_url` | test | L3318 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_decode_base64_checks_limit_before_allocating_output` | test | L3325 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::archive_magic_accepts_supported_formats` | test | L3335 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::archive_magic_rejects_spoofing_and_declared_mismatch` | test | L3354 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_read_file_bounded_rejects_oversized_sparse_file` | test | L3373 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_is_probably_base64_rejects_path_like_content` | test | L3384 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_is_probably_base64_supports_urlsafe_without_padding` | test | L3391 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_compute_hash` | test | L3401 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_infer_type_from_mime` | test | L3407 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_infer_extension` | test | L3427 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_is_safe_original_path_allows_textbooks_dir` | test | L3443 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_is_safe_original_path_rejects_external_path` | test | L3467 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_original_path_rejects_symlink_escaping_slot` | test | L3494 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_extract_relative_from_slot_path_macos` | test | L3521 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_extract_relative_from_slot_path_windows` | test | L3529 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_extract_relative_from_slot_path_nested` | test | L3537 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_extract_relative_from_slot_path_no_match` | test | L3545 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_extract_relative_from_slot_path_slot_root_only` | test | L3556 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::test_build_original_path_candidates_cross_platform_remap` | test | L3562 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs::tests::resolve_file_id_maps_resource_ids_to_files` | test | L3593 | ported:host/plugins/vfs-repos/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_store_blob` | test | L1162 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_blob_dedup` | test | L1184 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_blob_dedup_different_extension_no_orphan` | test | L1203 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_get_blob_path` | test | L1231 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_ref_count_operations` | test | L1247 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_compute_hash` | test | L1273 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::test_blob_path_structure` | test | L1284 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::deletion_prepare_failure_keeps_blob_metadata_and_file` | test | L1296 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::recovers_blob_crash_after_prepare` | test | L1319 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/blob_repo.rs::tests::blob_ready_outbox_failure_is_visible_and_recoverable` | test | L1349 | ported:host/plugins/vfs-repos/tests/blobs.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::test_has_indexing_units_for_dimension_text` | test | L1358 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::test_has_indexing_units_for_dimension_multimodal` | test | L1386 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::model_name_change_rolls_profiles_without_a_query_gap` | test | L1414 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::legacy_profile_registration_without_override_creates_a_new_space` | test | L1525 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::assigned_unit_without_committed_manifest_rebuilds_without_queryable_old_profile` | test | L1637 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::profile_activation_requires_committed_unit_generation_manifest` | test | L1698 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::profile_identity_includes_dimension_and_registration_is_atomic` | test | L1802 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::endpoint_change_rolls_profile_without_hashing_secrets` | test | L1867 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs::tests::dimension_cascade_enqueues_orphans_and_collects_all_profile_tables` | test | L1934 | ported:host/plugins/vfs-repos/tests/embedding-dims.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::test_register_dimension` | test | L1089 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::requeue_paged_pdfs_runs_once_and_only_for_multi_page_files` | test | L1106 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::test_revive_config_blocked_only_touches_embedding_config_failures` | test | L1139 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::test_index_state` | test | L1196 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::failed_resources_stop_requeueing_after_max_retries` | test | L1225 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs::tests::mm_claim_skips_resources_already_indexing` | test | L1295 | ported:host/plugins/vfs-repos/tests/embedding-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/essay_repo.rs::tests::test_essay_id_generation` | test | L1592 | ported:host/plugins/vfs-repos/tests/essays.test.ts |
| `crates/dstu-vfs/src/vfs/repos/exam_repo.rs::tests::test_exam_sheet_id_generation` | test | L2182 | ported:host/plugins/vfs-repos/tests/exams.test.ts |
| `crates/dstu-vfs/src/vfs/repos/exam_repo.rs::tests::test_purge_exam_sheet_dereferences_page_and_question_blobs` | test | L2191 | ported:host/plugins/vfs-repos/tests/exams.test.ts |
| `crates/dstu-vfs/src/vfs/repos/exam_repo.rs::tests::test_copy_exam_sheet_shares_blobs_and_copies_questions` | test | L2271 | ported:host/plugins/vfs-repos/tests/exams.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_create_file` | test | L1807 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_file_dedup_by_sha256` | test | L1831 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_list_files` | test | L1862 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_list_files_by_type` | test | L1895 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_soft_delete_and_restore` | test | L1924 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/file_repo.rs::tests::test_copy_file_shares_blobs_and_survives_source_purge` | test | L1968 | ported:host/plugins/vfs-repos/tests/files.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_create_folder` | test | L3123 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_get_folder` | test | L3136 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_nested_folders_recursive` | test | L3157 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_build_folder_path` | test | L3203 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_folder_depth_limit` | test | L3229 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_get_all_resources_empty` | test | L3272 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_folder_item_crud` | test | L3288 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::moving_item_marks_enabled_vector_routes_pending` | test | L3322 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_list_items_by_folder_handles_text_created_at` | test | L3377 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_purge_deleted_folders_reuses_resource_purge_chain` | test | L3402 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_delete_folder_soft_deletes_owned_notes_and_restore_brings_them_back` | test | L3494 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_purge_folder_skips_still_active_legacy_children` | test | L3536 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_purge_folder_tree_handles_image_items` | test | L3578 | ported:host/plugins/vfs-repos/tests/folders.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs::tests::replace_is_idempotent_and_removal_is_durable` | test | L793 | ported:host/plugins/vfs-repos/tests/index-segments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs::tests::bare_segment_deletes_enqueue_orphans_by_default` | test | L910 | ported:host/plugins/vfs-repos/tests/index-segments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs::tests::image_segment_falls_back_to_multimodal_dims_profile` | test | L956 | ported:host/plugins/vfs-repos/tests/index-segments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs::tests::reenqueue_makes_a_high_retry_orphan_due_immediately` | test | L991 | ported:host/plugins/vfs-repos/tests/index-segments.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::test_purge_index_artifacts_cascades_and_enqueues_lance_rows` | test | L1145 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::test_sweep_orphan_index_units_only_removes_orphans` | test | L1180 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::sync_units_content_change_invalidates_stale_segments` | test | L1215 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::sync_multimodal_image_change_invalidates_stale_segments` | test | L1278 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::bare_unit_delete_enqueues_lance_orphans` | test | L1359 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs::tests::sync_multimodal_page_rehashes_image_and_preserves_text` | test | L1376 | ported:host/plugins/vfs-repos/tests/index-units.test.ts |
| `crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs::tests::rebuild_threshold_is_twenty_percent` | test | L568 | ported:host/plugins/vfs-repos/tests/media-transcripts.test.ts |
| `crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs::tests::plan_create_resume_and_rebuild` | test | L578 | ported:host/plugins/vfs-repos/tests/media-transcripts.test.ts |
| `crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs::tests::imported_segments_replace_plan_and_are_not_overwritten_by_asr_plan` | test | L643 | ported:host/plugins/vfs-repos/tests/media-transcripts.test.ts |
| `crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs::tests::invalid_spans_are_rejected` | test | L688 | ported:host/plugins/vfs-repos/tests/media-transcripts.test.ts |
| `crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs::tests::progress_merge_semantics` | test | L699 | ported:host/plugins/vfs-repos/tests/media-transcripts.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_ensure_table_exists` | test | L1080 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_set_and_get_path` | test | L1096 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_invalidate` | test | L1122 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_cache_miss` | test | L1151 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_get_by_full_path` | test | L1161 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_batch_set` | test | L1186 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_stats` | test | L1218 | ported:host/plugins/vfs-repos/tests/path-cache.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs::tests::test_pdf_preview_config_default` | test | L378 | ported:host/plugins/vfs-repos/tests/pdf-preview.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::focus_seconds_by_local_date_sums_work_focus_only` | test | L1121 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::create_record_writes_updated_at_equal_to_created_at` | test | L1179 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::delete_record_soft_deletes_and_rolls_back_completed_pomodoros` | test | L1204 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::delete_record_does_not_touch_counter_for_break_or_interrupted` | test | L1251 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::delete_record_counter_never_goes_negative` | test | L1273 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::td02_create_and_delete_recount_tracks_fact_table` | test | L1297 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::td02_create_record_recount_heals_drifted_cache` | test | L1321 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::td02_recount_is_idempotent_and_skips_noop_writes` | test | L1357 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::list_range_filters_by_local_day_and_excludes_deleted` | test | L1405 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs::tests::list_range_rejects_bad_input` | test | L1430 | ported:host/plugins/vfs-repos/tests/pomodoros.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::escape_fts5_query_quotes_every_token` | test | L3485 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::sanitize_search_keyword_trims_and_limits` | test | L3508 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::list_mistakes_spans_live_exams_with_names_counts_and_sorting` | test | L3568 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::get_question_by_card_id_accepts_question_id_fallback` | test | L3727 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::update_question_occ_is_atomic_and_rejects_stale_writes` | test | L3777 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::concurrent_question_updates_allow_exactly_one_occ_winner` | test | L3818 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::list_and_single_reads_hydrate_group_materials_without_duplicating_membership` | test | L3934 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::canonical_read_returns_all_questions_beyond_repo_page_cap` | test | L4006 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::count_by_type_excludes_soft_deleted_questions` | test | L4041 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::submission_freezes_question_and_material_snapshot_for_historical_review` | test | L4081 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::question_mutation_marks_linked_resource_index_pending` | test | L4133 | ported:host/plugins/vfs-repos/tests/questions.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_create_or_reuse_dedup` | test | L1005 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_get_resource` | test | L1041 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_ref_count` | test | L1066 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_list_by_type` | test | L1113 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_compute_hash` | test | L1159 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_concurrent_create_same_hash` | test | L1173 | ported:host/plugins/vfs-repos/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/repos/review_plan_repo.rs::tests::global_stats_bind_today_without_exam_parameter` | test | L1204 | ported:host/plugins/vfs-repos/tests/review-plans.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_create_textbook` | test | L2066 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_textbook_dedup_by_sha256` | test | L2086 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_update_reading_progress` | test | L2103 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_list_textbooks` | test | L2124 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_copy_textbook_shares_blobs_and_survives_source_purge` | test | L2199 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/textbook_repo.rs::tests::test_purge_textbook_decrements_compressed_blob_refs` | test | L2249 | ported:host/plugins/vfs-repos/tests/textbooks.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_create_todo_item_rejects_cross_list_parent` | test | L4300 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_update_todo_item_rejects_parent_cycle` | test | L4332 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_list_today_items_include_completed_flag_controls_completed_visibility` | test | L4356 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_list_today_items_includes_overdue_pending_excludes_overdue_completed` | test | L4385 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_todo_insert_trigger_rejects_invalid_status` | test | L4433 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_create_todo_item_rejects_invalid_priority` | test | L4468 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_update_todo_item_rejects_invalid_status` | test | L4498 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_parse_repeat_rule_validation` | test | L4545 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_parse_repeat_rule_by_weekday` | test | L4557 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_step_due_date_weekly_by_weekday` | test | L4573 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_step_due_date_weekly_by_weekday_interval` | test | L4590 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_step_due_date_monthly_clamps_to_month_end` | test | L4601 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_shift_reminder_follows_due_date` | test | L4611 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_step_due_date_weekdays_skips_weekend` | test | L4627 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_compute_next_due_date_skips_missed_cycles` | test | L4637 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_complete_repeating_item_spawns_next_occurrence` | test | L4654 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_complete_without_due_date_or_rule_spawns_nothing` | test | L4712 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_create_todo_item_rejects_invalid_repeat_json` | test | L4745 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_deleted_items_trash_roundtrip` | test | L4779 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::test_purge_all_deleted_items_keeps_alive_ones` | test | L4817 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::agent_list_update_and_delete_enforce_atomic_occ` | test | L4836 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::agent_item_delete_enforces_occ_and_is_restorable` | test | L4880 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::agent_cannot_delete_default_inbox` | test | L4910 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::agent_reorder_requires_exact_unique_list_membership` | test | L4919 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::reorder_lists_requires_exact_unique_membership_and_persists_order` | test | L4967 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::move_todo_item_moves_subtree_to_target_list_tail` | test | L4999 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/todo_repo.rs::tests::move_todo_item_rejects_missing_or_deleted_target_list` | test | L5039 | ported:host/plugins/vfs-repos/tests/todos.test.ts |
| `crates/dstu-vfs/src/vfs/repos/translation_repo.rs::tests::test_translation_id_generation` | test | L1217 | ported:host/plugins/vfs-repos/tests/translations.test.ts |
| `crates/dstu-vfs/src/vfs/repos/translation_repo.rs::tests::test_identical_content_translations_get_distinct_resources` | test | L1259 | ported:host/plugins/vfs-repos/tests/translations.test.ts |
| `crates/dstu-vfs/src/vfs/repos/translation_repo.rs::tests::test_update_translation_content_in_place_refreshes_hash_and_index_state` | test | L1273 | ported:host/plugins/vfs-repos/tests/translations.test.ts |
| `crates/dstu-vfs/src/vfs/repos/translation_repo.rs::tests::test_update_shared_resource_uses_copy_on_write` | test | L1308 | ported:host/plugins/vfs-repos/tests/translations.test.ts |
| `crates/dstu-vfs/src/vfs/repos/translation_repo.rs::tests::test_purge_translation_keeps_shared_resource_until_last_reference` | test | L1350 | ported:host/plugins/vfs-repos/tests/translations.test.ts |
<!-- END GENERATED:testmap:rows -->
