# L10-notes 测试去向（`host/plugins/notes`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L10-notes：135 行（真实测试 135）· ported 135
<!-- END GENERATED:testmap:header -->

## 测试

> 执行器接线：`src/canvas-tool.ts` / `src/user-todo-tool.ts` / `src/notes-import-tool.ts` 由
> `index.ts` 实例化，随 `notes.tools` 暴露，并在 L07 发布 `agentTools` 后通过
> `registerToolExecutors` 注册（`tests/agent-tools-registration.test.ts` 走真实插件入口）。
> L04 的消费者 `ToolExecutorRegistry` 目前只存在于 `ds-mig/L04-chat-session`，未合入 `main`；
> 测试按 Rust `get_executor` 的首个 `canHandle` 匹配语义自行断言，真实聊天派发仍未在 `main` 验证。
> `execute` 的参数校验、OCC、事件载荷、Canvas ACR/backend 分支与 L11 仓储调用均在生产代码中实现
> （补充覆盖见 `tests/canvas-execute.test.ts`、`tests/user-todo-execute.test.ts` /
> `tests/notes-import-execute.test.ts`）。

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::plain_markdown_flattens_columns_but_preserves_literal_directives` | test | L3716 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::columns_and_relations_zip_preserves_structure_and_remaps_only_real_vfs_targets` | test | L3730 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::history_zip_roundtrip_remaps_lineage_props_and_history_only_assets` | test | L3823 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::history_zip_exclusion_and_unknown_manifest_fail_before_writes` | test | L3949 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::history_zip_future_format_and_late_asset_failure_roll_back_then_retry` | test | L4012 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::legacy_zip_remaps_both_old_asset_prefixes_and_rejects_future_marker_before_writing` | test | L4124 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::rejects_parent_dir_traversal` | test | L4206 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::rejects_windows_drive_and_absolute` | test | L4224 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::rejects_mixed_separator_traversal` | test | L4234 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::accepts_legitimate_asset_entry` | test | L4250 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::vfs_export_collects_referenced_assets_without_legacy_assets_table` | test | L4268 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::manifestless_markdown_zip_imports_into_vfs_without_legacy_notes_table` | test | L4322 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::is_unsafe_archive_relative_covers_variants` | test | L4357 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_exporter.rs::zip_slip_tests::zip_with_malicious_entries_does_not_escape_base` | test | L4368 | ported:host/plugins/notes/tests/exporter.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_get_heading_level` | test | L2104 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_extract_section_content` | test | L2126 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_extract_section_content_without_hash` | test | L2176 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_append_to_section` | test | L2195 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_append_to_last_section` | test | L2228 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_extract_section_ignores_headings_inside_code_fence` | test | L2249 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_extract_section_with_atx_closing_hashes` | test | L2275 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_section_query_level_must_match_when_specified` | test | L2287 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_build_notes_fts_match_query` | test | L2297 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_regex_replace` | test | L2313 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-notes/src/notes_manager.rs::canvas_tests::test_string_replace` | test | L2325 | ported:host/plugins/notes/tests/markdown.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs::columns_are_one_root_node_and_fenced_escaped_quoted_examples_are_literals` | test | L28 | ported:host/plugins/notes/tests/note-columns.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs::enabling_columns_is_lossless_pins_baseline_and_demands_capable_cas_saves` | test | L61 | ported:host/plugins/notes/tests/note-columns.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs::stable_columns_transfer_requires_both_page_optins_and_moves_entire_container_atomically` | test | L142 | ported:host/plugins/notes/tests/note-columns.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs::history_selection_cannot_cut_column_containers_and_full_restore_preserves_capability` | test | L209 | ported:host/plugins/notes/tests/note-columns.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs::current_restore_cas_preserves_live_and_source_and_restores_full_envelope` | test | L33 | ported:host/plugins/notes/tests/note-history-integration.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs::selection_rejects_partial_code_list_and_markers_and_copies_complete_nodes` | test | L118 | ported:host/plugins/notes/tests/note-history-integration.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs::selected_restore_replaces_whole_current_body_and_failed_history_rolls_back_everything` | test | L184 | ported:host/plugins/notes/tests/note-history-integration.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs::retention_is_persistent_deferred_and_controls_coalescing_and_budget` | test | L233 | ported:host/plugins/notes/tests/note-history-integration.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs::v20260923_backfills_existing_versions_by_identity_and_logs_only_immutable_inserts` | test | L310 | ported:host/plugins/notes/tests/note-history-integration.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::pending_fences_repo_raw_sql_and_other_connection_and_preserves_history` | test | L49 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::unanimous_drafts_flush_once_commit_and_hold_until_all_refresh` | test | L91 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::late_registration_reopens_barrier_and_divergent_or_stale_ack_cannot_authorize` | test | L143 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::heartbeat_does_not_extend_pending_deadline_and_close_cancels_whole_lease` | test | L180 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::sorted_multi_note_acquisition_rolls_back_on_overlap_and_grants_rollback_on_failure` | test | L215 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::authorized_multi_step_writes_advance_the_frozen_baseline` | test | L271 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs::relationship_logs_and_pin_backfill_use_row_sync_identity_and_replay_suppression` | test | L298 | ported:host/plugins/notes/tests/note-lease.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_create_note` | test | L3141 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_get_note_content` | test | L3161 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_changes_resource_on_content_change` | test | L3182 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_keeps_resource_when_content_unchanged` | test | L3223 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_soft_delete_and_restore` | test | L3263 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_list_all_notes` | test | L3304 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_reclaims_old_resources` | test | L3347 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_search_notes_fts_and_like_fallback` | test | L3385 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_fts_index_follows_soft_delete_and_restore` | test | L3431 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_fts_index_follows_content_update` | test | L3455 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_list_tags_uses_normalized_table` | test | L3488 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_purge_note_removes_all_owned_resources` | test | L3524 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_extract_note_links_syntax_matrix` | test | L3573 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_extract_note_links_skips_code_regions` | test | L3596 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_make_search_snippet_utf8_boundaries` | test | L3628 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_title_and_tags_validation` | test | L3652 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_note_links_resolution_backlinks_and_unresolved` | test | L3701 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_note_links_purge_target_downgrades_to_unresolved` | test | L3742 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_rebuild_note_links_and_unlinked_mentions` | test | L3770 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_create_note_maintains_links_in_repo_layer` | test | L3794 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_refreshes_links_in_repo_layer` | test | L3820 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_unchanged_content_and_title_only_skip_link_refresh` | test | L3849 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_soft_delete_and_restore_preserve_outgoing_links` | test | L3923 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_backfill_note_links_once_flag_and_retry_semantics` | test | L3951 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_search_notes_by_tags_with_snippets_exact_and_keyword` | test | L3986 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_search_note_titles_prefers_prefix` | test | L4051 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_set_note_props_roundtrip_and_updated_at` | test | L4068 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_set_note_props_validation` | test | L4113 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_update_note_metadata_is_atomic_and_honors_occ` | test | L4165 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_props_survive_metadata_and_content_updates` | test | L4257 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_row_to_note_malformed_props_fall_back_with_trace` | test | L4286 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_repo.rs::tests::test_note_props_shared_key_vectors_round_trip_write_side` | test | L4330 | ported:host/plugins/notes/tests/notes-repo.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_review_tests.rs::save_as_create_and_update_retries_never_duplicate_or_clobber_a_newer_edit` | test | L5 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_review_tests.rs::save_as_receipt_failure_rolls_back_copy_folder_history_and_identity` | test | L81 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::full_body_survives_resource_cleanup_and_copy_preserves_metadata` | test | L35 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::noop_structural_props_empty_body_and_a_b_a_have_correct_identity` | test | L103 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::occ_and_history_failure_roll_back_body_metadata_and_resources` | test | L138 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::legacy_baseline_is_captured_before_first_write_and_pagination_is_stable` | test | L190 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::edits_coalesce_without_mutation_and_budget_preserves_pins` | test | L216 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::full_sqlite_backup_restores_history_and_local_classification` | test | L248 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::asset_manifest_distinguishes_owned_and_external_references` | test | L271 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::preview_is_read_only_and_a_pruned_restore_target_never_falls_back` | test | L285 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::explicit_release_preserves_body_assets_and_restore_protection_until_user_releases_it` | test | L324 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs::retained_filter_finds_older_pins_and_release_is_scoped_to_the_note` | test | L380 | ported:host/plugins/notes/tests/note-history.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::stable_parser_rejects_partial_duplicate_and_nested_markers` | test | L45 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::transfer_is_idempotent_and_undo_restores_exact_bytes_and_assets` | test | L62 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::transfer_rejects_body_tampering_and_target_occ_rolls_back_source` | test | L115 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::receipt_failure_rolls_back_both_pages_history_and_resource_cleanup` | test | L165 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::undo_never_clobbers_a_later_edit_even_with_fresh_caller_tokens` | test | L196 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::migration_is_explicit_lossless_and_baseline_is_retained` | test | L236 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::per_entry_cas_and_tombstone_prevent_lost_reviews_and_aba` | test | L303 | ported:host/plugins/notes/tests/state.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::relationships_follow_note_resource_replacement_and_invalidate_deleted_blocks` | test | L371 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::contract_serializes_type_and_deserializes_flat_state_requests` | test | L425 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::anki_reference_uses_real_card_and_document_rows_and_observes_deletion` | test | L440 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::future_body_header_is_not_overwritten_even_when_format_metadata_is_legacy` | test | L500 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs::second_page_history_failure_rolls_back_source_and_all_retention_changes` | test | L523 | ported:host/plugins/notes/tests/note-storage.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::note_create_vfs_path_persists_in_requested_folder` | test | L2027 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::note_create_vfs_path_returns_structured_missing_folder_error` | test | L2065 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_can_handle` | test | L2089 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_sensitivity_level` | test | L2117 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::destructive_note_backend_fallback_requires_occ_revision` | test | L2176 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_name` | test | L2214 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_should_delegate_frontend` | test | L2220 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_extract_probe_state` | test | L2236 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_build_note_agent_op_append_end` | test | L2244 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_build_note_agent_op_append_section` | test | L2257 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/canvas_executor.rs::tests::test_build_note_agent_op_replace_set` | test | L2269 | ported:host/plugins/notes/tests/canvas-executor.test.ts |
| `src/chat_v2/tools/notes_import_executor.rs::tests::test_can_handle` | test | L207 | ported:host/plugins/notes/tests/notes-import-executor.test.ts |
| `src/chat_v2/tools/notes_import_executor.rs::tests::test_sensitivity_level` | test | L216 | ported:host/plugins/notes/tests/notes-import-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::todo_revision_is_required_for_mutations` | test | L1559 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::todo_conflicts_use_one_structured_code` | test | L1578 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::executor_failure_boundary_localizes_plain_errors_and_preserves_domain_errors` | test | L1595 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::optional_todo_fields_preserve_omit_and_support_clear` | test | L1611 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::real_todo_writes_are_not_low_sensitivity` | test | L1656 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::undo_contract_never_claims_an_unexecutable_restore` | test | L1694 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::user_text_is_unicode_safely_bounded_and_reports_fields` | test | L1719 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::occ_contract_tests::executor_validates_text_tags_pagination_and_views` | test | L1763 | ported:host/plugins/notes/tests/user-todo-executor.test.ts |
| `src/chat_v2/tools/user_todo_executor.rs::mfjs_schema_tests::mfjs_normalizes_real_rust_builtin_tool_schemas` | test | L1821 | pending |
| `src/cmd/notes.rs::referencing_resource_tests::finds_notes_by_origin_and_relation_without_prefix_collisions` | test | L852 | ported:host/plugins/notes/tests/notes-referencing.test.ts |
| `src/cmd/notes.rs::tests::decode_markdown_bytes_strips_utf8_bom` | test | L2834 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::decode_markdown_bytes_supports_utf16le` | test | L2842 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::derive_markdown_note_title_uses_file_stem` | test | L2850 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::extract_first_heading_finds_h1` | test | L2855 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::split_leading_heading_moves_h1_into_title` | test | L2863 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::split_leading_heading_requires_leading_h1` | test | L2878 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::extract_first_heading_skips_h2` | test | L2886 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::extract_first_heading_returns_none_for_no_heading` | test | L2891 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::extract_first_heading_trims_whitespace` | test | L2896 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::is_generic_note_title_detects_placeholder` | test | L2904 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::is_generic_note_title_detects_opaque_document_ids` | test | L2912 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::is_generic_note_title_allows_real_names` | test | L2921 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/cmd/notes.rs::tests::cleanup_materialized_import_files_removes_existing_files` | test | L2929 | ported:host/plugins/notes/tests/import-markdown.test.ts |
| `src/notes_app_tests.rs::note_history_app_tests::history_trash_and_shared_asset_references_guard_journal_deletion` | test | L46 | ported:host/plugins/notes/tests/notes-app.test.ts |
| `src/notes_app_tests.rs::note_history_app_tests::zip_overwrite_captures_body_and_writes_fresh_assets_without_overwriting_history_bytes` | test | L92 | ported:host/plugins/notes/tests/notes-app.test.ts |
<!-- END GENERATED:testmap:rows -->

## 剩余阻塞

`B-MFJS / X6-PR-0113`：`mfjs_normalizes_real_rust_builtin_tool_schemas` 的原测试仍保留在 `tests/user-todo-executor.test.ts`，断言未删未改；但规范化主体 `normalizeMfjsForTest` 是测试内副本，不能计作生产入口移植。2026-11-05 续作核对 `host/plugins/llm/api.ts` 未发布正式 MFJS 规范化入口；`MFJS-EVIDENCE.md` 同时记录 Rust schema 函数 test-only 的精确事实，待 C1/C2 裁定，不自行 obsolete。现将该行如实改 pending，其余 134 行 ported；上方 GENERATED 表头是历史生成快照，未手改统计。
