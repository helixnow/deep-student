# L13b Rust test destinations / wiring input

Apply these destinations to the matching ids in `host/plugins/vfs/TESTMAP.md`.
The five L12 unit-builder/reset tests and three L11 path tests now use real published
services. Two blocking-runner tests remain pending until command code consumes the
published maintenance-managed worker; CRUD success does not prove thread isolation. Three retired
question-sync tests have approved obsolete destinations. Counts: 63 ported / 2 pending / 3 obsolete.
This lane-local copy is consumed by `migration:wiring -- --lane vfs-handlers`.
L13's inventory and authoritative ledger still use `host/plugins/vfs/TESTMAP.md`;
the coordinator must import these destinations there. An empty wiring scan is not acceptance.

| Rust test id | Destination |
|---|---|
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_content_hash_consistency` | ported:host/plugins/vfs-handlers/tests/question-sync.test.ts |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_conflict_strategy_conversion` | obsolete:dead-in-rust question_sync_service.rs:1-16,2009-2010，已由 migration/approvals.json 批准 |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_merge_versions` | obsolete:dead-in-rust 仅已退役 resolve_conflict 和测试调用，已由 migration/approvals.json 批准 |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_apply_keep_local_keeps_pending_push_and_recomputes_hash` | obsolete:dead-in-rust 仅已退役 resolve_conflict 和测试调用，已由 migration/approvals.json 批准 |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::sync_resource_units_uses_single_pool_connection` | ported:host/plugins/vfs-handlers/tests/index-admin.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_is_allowed_media_extension` | ported:host/plugins/vfs-handlers/tests/filestream.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_extension_permitted_relaxed_inside_blob_dirs` | ported:host/plugins/vfs-handlers/tests/filestream.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_has_hidden_segment_within` | ported:host/plugins/vfs-handlers/tests/filestream.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_hidden_segment_check_with_mixed_verbatim_forms_on_windows` | ported:host/plugins/vfs-handlers/tests/filestream.test.ts |
| `crates/dstu-vfs/src/vfs/attachment_config.rs::tests::test_config_key_constants` | ported:host/plugins/vfs-handlers/tests/attachments.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_file_size_validation` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_compute_hash` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_max_size_bytes` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_create_resource_input_deserialization` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_create_note_input_deserialization` | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_list_input_defaults` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_search_all_input_deserialization` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::rag_search_accepts_legacy_false_cross_dimension_flag` | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_update_note_params_for_versioning` | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_search_all_cross_type_params` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_empty_query_validation` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_resource_id_format_validation` | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_note_id_format_validation` | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_folder_id_format_validation` | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_source_id_prefix_parsing` | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_path_length_constraint` | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_path_format` | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::embedding_model_validation_enforces_backend_protocol_contract` | ported:host/plugins/vfs-handlers/tests/embedding.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_accepts_legacy_query` | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_accepts_image_and_mixed_camel_case` | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_rejects_mode_payload_mismatch` | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_text_mode_updates_unit_and_resource_atomically` | ported:host/plugins/vfs-handlers/tests/index-admin.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_mm_mode_updates_unit_and_resource_atomically` | ported:host/plugins/vfs-handlers/tests/index-admin.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_both_mode_updates_all_four_states` | ported:host/plugins/vfs-handlers/tests/index-admin.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_unknown_mode_writes_nothing` | ported:host/plugins/vfs-handlers/tests/index-admin.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_ocr_priority` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_extracted_fallback` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_empty_ocr` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_no_content` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_nonexistent_file` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_by_resource_id` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_longer_wins` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_whitespace_only_extracted` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_valid` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_with_nulls` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_empty_array` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_all_empty` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_invalid_json` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_valid` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_empty` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_whitespace_only` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_none` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_source_id_type` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_source_id_type_essay_session_priority` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_exam_coalesce_title` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_translation_coalesce_title` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_essay_coalesce_title` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_vfs_context_ref_data_default` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_vfs_resource_ref_serialization` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_resolved_resource_serialization` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_refs_input_deserialization` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_refs_input_defaults` | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::database_work_does_not_run_on_the_async_runtime_thread` | pending | R13-02：F3维护纳管/L11 worker和日志已main，待本lane消费并验证线程/事件/维护顺序；CRUD不证明线程隔离，见BLOCKERS |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::blocking_runner_preserves_business_error_contracts` | pending | R13-02：待本lane经真实worker命令验证错误传播；普通命令错误断言不证明blocking runner传播，见BLOCKERS |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::parses_plain_string_array` | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::parses_fenced_and_object_array` | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::extracts_array_from_surrounding_text` | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::rejects_garbage_and_filters_empty` | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
