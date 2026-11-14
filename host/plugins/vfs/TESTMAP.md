# L13-vfs-api 测试去向（`host/plugins/vfs`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L13-vfs-api：381 行（真实测试 381）· pending 86 · ported 290 · obsolete 5
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-vfs/src/dstu/error.rs::tests::test_error_display` | test | L144 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/error.rs::tests::test_error_to_string_conversion` | test | L156 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/exam_formatter.rs::tests::test_format_text_only` | test | L320 | ported:host/plugins/vfs/tests/exam-formatter.test.ts |
| `crates/dstu-vfs/src/dstu/exam_formatter.rs::tests::test_escape_xml` | test | L338 | ported:host/plugins/vfs/tests/exam-formatter.test.ts |
| `crates/dstu-vfs/src/dstu/exam_formatter.rs::tests::test_format_page_questions` | test | L347 | ported:host/plugins/vfs/tests/exam-formatter.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_valid_item_types` | test | L988 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_folder_id_format` | test | L996 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_folder_item_id_format` | test | L1003 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_title_validation` | test | L1010 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_folder_constraints` | test | L1025 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_folder_error_codes` | test | L1032 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_vfs_folder_new` | test | L1040 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_vfs_folder_item_new` | test | L1060 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_vfs_folder_serialization` | test | L1076 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/folder_handlers.rs::tests::test_vfs_folder_item_serialization` | test | L1094 | ported:host/plugins/vfs/tests/folders.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/content_helpers.rs::tests::test_format_exam_preview_for_read` | test | L616 | ported:host/plugins/vfs/tests/dstu-helpers.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_pdf` | test | L469 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_office_word` | test | L484 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_office_excel` | test | L491 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_office_powerpoint` | test | L502 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_text_plain` | test | L509 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_text_html` | test | L519 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_text_structured` | test | L527 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_text_ebook` | test | L537 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_unknown` | test | L545 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_get_textbook_preview_type_edge_cases` | test | L559 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_parse_timestamp_valid` | test | L581 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_parse_timestamp_invalid` | test | L590 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_item_type_to_dstu_node_type` | test | L600 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_create_type_folder` | test | L642 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_generate_resource_id` | test | L660 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_note_to_dstu_node_normalizes_absent_props_to_object` | test | L680 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_sanitize_keeps_normal_filenames` | test | L707 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_sanitize_replaces_pure_numeric_id` | test | L719 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_sanitize_replaces_document_colon_id` | test | L726 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_sanitize_replaces_generic_placeholder` | test | L734 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs::tests::test_sanitize_handles_no_extension` | test | L741 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs::tests::note_prop_filters_match_keys_and_scalar_values_case_insensitively` | test | L970 | ported:host/plugins/vfs/tests/dstu-helpers.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs::tests::note_prop_filters_agree_with_shared_key_vectors` | test | L997 | ported:host/plugins/vfs/tests/dstu-helpers.test.ts |
| `crates/dstu-vfs/src/dstu/handler_utils/search_helpers.rs::tests::note_prop_and_folder_filters_are_applied_before_limit` | test | L1056 | ported:host/plugins/vfs/tests/dstu-content-search.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_generate_resource_id` | test | L6660 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_create_type_folder` | test | L6673 | ported:host/plugins/vfs/tests/node-converters.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_simple_path_format` | test | L6689 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_build_simple_resource_path` | test | L6701 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_parse_note_metadata_update_preserves_typed_fields_and_null_clears_props` | test | L6710 | ported:host/plugins/vfs/tests/dstu-set-metadata.test.ts |
| `crates/dstu-vfs/src/dstu/handlers.rs::tests::test_parse_note_metadata_update_rejects_silent_field_drops` | test | L6736 | ported:host/plugins/vfs/tests/dstu-set-metadata.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_normalize_path` | test | L359 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_parent_path` | test | L369 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_parent_path` | test | L383 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_path_name` | test | L394 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_simple_resource_path_func` | test | L406 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_root` | test | L416 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_empty` | test | L427 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_single_folder` | test | L434 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_multi_folder` | test | L445 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_resource_at_root` | test | L455 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_resource_in_folder` | test | L465 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_all_resource_types` | test | L476 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_virtual_trash` | test | L497 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_virtual_recent` | test | L507 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_virtual_favorites` | test | L515 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_legacy_format` | test | L523 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_legacy_type_list` | test | L532 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_legacy_global` | test | L540 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_with_folder` | test | L552 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_at_root` | test | L559 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_empty_folder` | test | L566 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_root_folder` | test | L573 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_without_leading_slash` | test | L580 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_build_real_path_with_trailing_slash` | test | L587 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_root` | test | L598 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_normal` | test | L603 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_empty` | test | L610 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_no_leading_slash` | test | L615 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_trailing_slash` | test | L620 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_double_slash` | test | L625 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_path_traversal_attack` | test | L630 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_extract_resource_id` | test | L646 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_extract_folder_path` | test | L660 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_resource_type_all_prefixes` | test | L678 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_get_resource_type_invalid` | test | L694 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_resource_id_true` | test | L705 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_is_valid_resource_id_false` | test | L712 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_parser.rs::tests::test_parse_real_path_resource_id_length_limit` | test | L723 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_root` | test | L276 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_virtual` | test | L286 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_folder` | test | L295 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_resource` | test | L305 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_resource_at_root` | test | L316 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_get_resource_type_from_id` | test | L324 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_is_valid_resource_id` | test | L354 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_resource_id_length_limit` | test | L363 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_is_virtual_path_type` | test | L381 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_get_name` | test | L392 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/path_types.rs::tests::test_parsed_path_serialization` | test | L402 | ported:host/plugins/vfs/tests/paths.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_serialization` | test | L838 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_deserialization` | test | L875 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_from_str` | test | L892 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_node_type_to_path_segment` | test | L908 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_dstu_node_serialization_camel_case` | test | L915 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_dstu_node_skip_none` | test | L931 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_dstu_node_resource` | test | L943 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_list_options_defaults` | test | L958 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_list_options_builder` | test | L967 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_create_options_note` | test | L984 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_watch_event_serialization` | test | L993 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/dstu/types.rs::tests::test_watch_event_moved` | test | L1004 | ported:host/plugins/vfs/tests/dstu-types.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::allowed_origins_match_pdf_protocol_rule` | test | L749 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_parse_range_header` | test | L763 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_is_allowed_media_extension` | test | L785 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_extension_permitted_relaxed_inside_blob_dirs` | test | L813 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_get_mime_type` | test | L841 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_sanitize_mime_override` | test | L870 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_mime_override_from_query` | test | L906 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_has_hidden_segment_within` | test | L922 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_protocol_rejects_disallowed_paths` | test | L954 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_protocol_serves_chinese_path_and_rejects_outside_whitelist` | test | L1002 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_hidden_segment_check_with_mixed_verbatim_forms_on_windows` | test | L1038 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_protocol_serves_media_with_range_and_mime_override` | test | L1060 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_protocol_allows_extensionless_blob_with_mime_override` | test | L1110 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_oversized_get_is_rejected_and_media_ranges_are_served_in_chunks` | test | L1181 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_oversized_non_media_range_is_still_rejected_without_truncation` | test | L1227 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_opened_handle_rejects_path_replaced_after_open` | test | L1252 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_parse_range_header` | test | L655 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_is_allowed_origin` | test | L677 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_checked_response_len_enforces_platform_and_protocol_limits` | test | L695 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_oversized_get_and_open_range_are_rejected_without_reading_body` | test | L708 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_opened_handle_rejects_path_replaced_after_open` | test | L769 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_get_mime_type` | test | L794 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_windows_comparable_path_text_aligns_verbatim_and_plain_forms` | test | L806 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_windows_path_starts_with_aligns_whitelist_forms` | test | L830 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_path_is_within_preserves_unix_semantics` | test | L868 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_pdfstream_serves_chinese_path_via_encoded_url` | test | L884 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_pdfstream_still_rejects_chinese_path_outside_whitelist` | test | L917 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_path_is_within_mixed_verbatim_forms_on_windows` | test | L941 | ported:host/plugins/vfs/tests/protocols.test.ts |
| `crates/dstu-vfs/src/vfs/attachment_config.rs::tests::test_config_key_constants` | test | L134 | ported:host/plugins/vfs/tests/attachment-config.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_database_creation` | test | L549 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_current_schema_version_in_sync` | test | L565 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migrations_idempotent` | test | L575 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_foreign_keys_enabled` | test | L594 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_get_connection` | test | L604 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_get_statistics` | test | L621 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_tables_created` | test | L638 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folders_table_created` | test | L674 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folder_items_table_created` | test | L708 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folders_parent_cascade_delete` | test | L740 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folder_items_folder_set_null` | test | L791 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folder_items_unique_constraint` | test | L850 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_folders_indexes_created` | test | L882 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_hash_unique_constraint` | test | L926 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_resources_no_subject` | test | L948 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_005_cached_path_column` | test | L984 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_005_cached_path_nullable` | test | L1010 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_005_path_index_query` | test | L1066 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_subject_columns_removed` | test | L1127 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_009_path_cache_table` | test | L1172 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_indexes` | test | L1237 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_folders_without_subject` | test | L1282 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_009_path_cache_crud` | test | L1310 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_folder_items_unique_constraint` | test | L1366 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/database.rs::tests::test_migration_011_idempotent` | test | L1397 | ported:host/plugins/vfs/tests/database.test.ts |
| `crates/dstu-vfs/src/vfs/error.rs::tests::test_error_display` | test | L287 | ported:host/plugins/vfs/tests/errors.test.ts |
| `crates/dstu-vfs/src/vfs/error.rs::tests::test_error_to_string` | test | L305 | ported:host/plugins/vfs/tests/errors.test.ts |
| `crates/dstu-vfs/src/vfs/error.rs::tests::stable_code_is_independent_of_message` | test | L313 | ported:host/plugins/vfs/tests/errors.test.ts |
| `crates/dstu-vfs/src/vfs/error.rs::tests::stable_code_covers_key_variants` | test | L333 | ported:host/plugins/vfs/tests/errors.test.ts |
| `crates/dstu-vfs/src/vfs/error.rs::tests::command_error_envelope_carries_code_message_and_data` | test | L386 | ported:host/plugins/vfs/tests/errors.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_file_size_validation` | test | L7912 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_compute_hash` | test | L7933 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_max_size_bytes` | test | L7947 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_create_resource_input_deserialization` | test | L7964 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_create_note_input_deserialization` | test | L7978 | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_list_input_defaults` | test | L7992 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_search_all_input_deserialization` | test | L8002 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::rag_search_accepts_legacy_false_cross_dimension_flag` | test | L8020 | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_update_note_params_for_versioning` | test | L8038 | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_search_all_cross_type_params` | test | L8077 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_empty_query_validation` | test | L8125 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_resource_id_format_validation` | test | L8137 | ported:host/plugins/vfs-handlers/tests/resources.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_note_id_format_validation` | test | L8149 | ported:host/plugins/vfs-handlers/tests/notes.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_folder_id_format_validation` | test | L8165 | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_source_id_prefix_parsing` | test | L8178 | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_path_length_constraint` | test | L8195 | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::test_path_format` | test | L8209 | ported:host/plugins/vfs-handlers/tests/paths.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::embedding_model_validation_enforces_backend_protocol_contract` | test | L8222 | ported:host/plugins/vfs-handlers/tests/embedding.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_accepts_legacy_query` | test | L8257 | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_accepts_image_and_mixed_camel_case` | test | L8270 | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/handlers.rs::tests::multimodal_search_dto_rejects_mode_payload_mismatch` | test | L8295 | ported:host/plugins/vfs-handlers/tests/search.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::sync_resource_units_uses_single_pool_connection` | test | L539 | ported:host/plugins/vfs/tests/unit-index-service.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_text_mode_updates_unit_and_resource_atomically` | test | L580 | ported:host/plugins/vfs/tests/unit-index-service.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_mm_mode_updates_unit_and_resource_atomically` | test | L595 | ported:host/plugins/vfs/tests/unit-index-service.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_both_mode_updates_all_four_states` | test | L610 | ported:host/plugins/vfs/tests/unit-index-service.test.ts |
| `crates/dstu-vfs/src/vfs/index_service.rs::tests::reset_unit_index_unknown_mode_writes_nothing` | test | L628 | ported:host/plugins/vfs/tests/unit-index-service.test.ts |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::tokenizer_emits_cjk_unigrams_bigrams_and_whole_latin_words` | test | L208 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::idf_is_never_negative` | test | L220 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::single_character_query_matches_inside_words` | test | L226 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::full_coverage_beats_repeating_one_term` | test | L234 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::rare_terms_outweigh_common_terms` | test | L246 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::scoring_is_deterministic_and_case_insensitive` | test | L258 | pending |
| `crates/dstu-vfs/src/vfs/lexical_bm25.rs::tests::huge_documents_are_scored_on_a_bounded_head` | test | L271 | pending |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::timestamps_switch_to_hours_after_one_hour` | test | L379 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::windows_close_at_ninety_seconds` | test | L387 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::windows_close_at_char_budget_and_skip_empty_lines` | test | L408 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::transcript_files_index_as_time_window_units` | test | L480 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::refresh_after_transcript_change_rebuilds_lexical_units` | test | L538 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::media_hits_get_time_range_and_file_source_id` | test | L549 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::transcript_reads_are_capped_at_ten_minutes` | test | L606 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/media_index.rs::tests::metadata_round_trips_deterministically` | test | L629 | ported:host/plugins/vfs/tests/media-index.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::valid_operator_keys_pass_all_three_syntaxes` | test | L293 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::storable_keys_outside_operator_syntax_are_pinned` | test | L308 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::invalid_keys_are_rejected_with_expected_category` | test | L322 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::normalize_drops_only_empty_keys` | test | L344 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::parse_props_cell_accepts_nonempty_object_and_preserves_json_types` | test | L353 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::parse_props_cell_null_is_silent_and_uncounted` | test | L366 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::parse_props_cell_counts_invalid_json` | test | L377 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::parse_props_cell_counts_non_object` | test | L387 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::parse_props_cell_counts_empty_object` | test | L398 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/note_props.rs::tests::snippet_truncates_long_raw_on_char_boundary` | test | L408 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/ocr_utils.rs::tests::classifies_short_text_as_scanned` | test | L171 | ported:host/plugins/vfs/tests/ocr.test.ts |
| `crates/dstu-vfs/src/vfs/ocr_utils.rs::tests::rejects_failed_or_empty_ocr` | test | L183 | ported:host/plugins/vfs/tests/ocr.test.ts |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_content_hash_consistency` | test | L2017 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_conflict_strategy_conversion` | test | L2080 | obsolete:dead-in-rust question_sync_service.rs:1-16;approved:ac8989383 |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_merge_versions` | test | L2108 | obsolete:dead-in-rust question_sync_service.rs:1-16;approved:ac8989383 |
| `crates/dstu-vfs/src/vfs/question_sync_service.rs::tests::test_apply_keep_local_keeps_pending_push_and_recomputes_hash` | test | L2182 | obsolete:dead-in-rust question_sync_service.rs:1-16;approved:ac8989383 |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_ocr_priority` | test | L2066 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_extracted_fallback` | test | L2092 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_empty_ocr` | test | L2108 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_no_content` | test | L2130 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_nonexistent_file` | test | L2142 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_by_resource_id` | test | L2152 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_longer_wins` | test | L2173 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_extract_file_text_whitespace_only_extracted` | test | L2198 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_valid` | test | L2225 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_with_nulls` | test | L2244 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_empty_array` | test | L2265 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_all_empty` | test | L2277 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_ocr_pages_text_invalid_json` | test | L2289 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_valid` | test | L2305 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_empty` | test | L2323 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_whitespace_only` | test | L2334 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_extracted_text_none` | test | L2345 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_source_id_type` | test | L2360 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_source_id_type_essay_session_priority` | test | L2408 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_exam_coalesce_title` | test | L2426 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_translation_coalesce_title` | test | L2477 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_ref_with_conn_essay_coalesce_title` | test | L2526 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_vfs_context_ref_data_default` | test | L2576 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_vfs_resource_ref_serialization` | test | L2584 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_resolved_resource_serialization` | test | L2603 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_refs_input_deserialization` | test | L2623 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/ref_handlers.rs::tests::test_get_resource_refs_input_defaults` | test | L2637 | ported:host/plugins/vfs-handlers/tests/refs.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::database_work_does_not_run_on_the_async_runtime_thread` | tokio::test | L1264 | pending |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::blocking_runner_preserves_business_error_contracts` | tokio::test | L1277 | pending |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::parses_plain_string_array` | test | L1295 | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::parses_fenced_and_object_array` | test | L1301 | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::extracts_array_from_surrounding_text` | test | L1308 | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/todo_handlers.rs::tests::rejects_garbage_and_filters_empty` | test | L1314 | ported:host/plugins/vfs-handlers/tests/todo.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_resource_type_serialization` | test | L2909 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_resource_type_from_str` | test | L2926 | ported:host/plugins/vfs/tests/service-wiring.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_storage_mode_serialization` | test | L2939 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_resource_camel_case` | test | L2951 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_create_resource_result_camel_case` | test | L2977 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_note_camel_case` | test | L2989 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_option_skip_serializing` | test | L3009 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_resource_type_all` | test | L3033 | obsolete:dead-in-rust approved:migration/approvals.d/C2-platform.json |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_preview_type_serialization` | test | L3049 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_preview_type_from_extension` | test | L3092 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_preview_type_from_filename` | test | L3133 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_blob_generate_relative_path` | test | L3149 | obsolete:dead-in-rust approved:migration/approvals.d/C2-platform.json |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_list_item_serialization` | test | L3158 | ported:host/plugins/vfs/tests/service-wiring.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_translation_serialization` | test | L3176 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_essay_serialization` | test | L3201 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/types.rs::tests::test_vfs_textbook_serialization` | test | L3224 | ported:host/plugins/vfs/tests/vfs-wire-types.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::pdf_file_is_indexed_one_unit_per_page_with_page_images` | test | L757 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::scanned_pages_fall_back_to_page_ocr` | test | L776 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::unsplittable_legacy_text_keeps_whole_document_unit` | test | L791 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::test_note_builder` | test | L800 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::test_mindmap_builder_extracts_root_and_notes` | test | L824 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::test_textbook_builder` | test | L855 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::file_builder_never_writes_file_blob_into_image_field` | test | L885 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::single_page_attachment_never_writes_file_blob_into_image_field` | test | L908 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::parse_preview_pages_reads_camel_case_hashes_and_mime` | test | L928 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/builders.rs::tests::attachment_builder_uses_preview_page_hashes_not_file_blob` | test | L952 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/unit_builder/registry.rs::tests::test_registry_creation` | test | L69 | ported:host/plugins/vfs/tests/unit-builders.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::upload_without_blob_waits_for_concurrent_writer` | test | L311 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::upload_with_blob_waits_for_concurrent_writer` | test | L316 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_failure_after_blob_rolls_back_row_and_cleans_file` | test | L323 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_failure_after_dedup_blob_keeps_shared_blob` | test | L359 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_failure_after_file_row_rolls_back_everything` | test | L388 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_saga_abort_only_releases_refs_created_by_this_call` | test | L450 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_index_failure_enters_retryable_state_and_sync_is_idempotent` | test | L489 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_sync_units_rolls_back_partial_writes_on_failure` | test | L573 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `crates/dstu-vfs/src/vfs/upload_saga.rs::tests::test_failed_upload_retry_is_idempotent` | test | L617 | ported:host/plugins/vfs/tests/upload-saga.test.ts |
| `src/chat_v2/tools/attachment_executor.rs::tests::test_can_handle` | test | L609 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::test_strip_namespace` | test | L622 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::test_sensitivity_level` | test | L631 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::structured_errors_map_schema_args_and_not_found` | test | L653 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::attachment_queries_use_chat_v2_database_without_main_database` | tokio::test | L700 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::attachment_read_resolves_reference_image_to_blob_base64` | tokio::test | L881 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::attachment_read_resolves_indirect_document_reference_to_text` | tokio::test | L913 | pending |
| `src/chat_v2/tools/attachment_executor.rs::tests::attachment_read_reports_missing_source_bytes_explicitly` | tokio::test | L924 | pending |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_can_handle` | test | L5683 | pending |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_strip_namespace` | test | L5708 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_infer_type_from_id` | test | L5721 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_parse_resource_type` | test | L5753 | ported:host/plugins/vfs/tests/resource-list-search.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_is_supported_read_id` | test | L5789 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_sanitize_read_resource_id` | test | L5799 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_pick_resource_read_id_priority` | test | L5825 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_build_degradation_info_fallback` | test | L5845 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_sensitivity_level` | test | L5861 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::resource_read_disables_outer_result_budget` | test | L5889 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::resource_page_hash_covers_page_range_logical_content` | test | L5899 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::resource_read_budget_prunes_large_preview_sidecars_and_keeps_progress` | test | L5913 | ported:host/plugins/vfs/tests/resource-read.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::test_sanitize_essay_nodes_for_list` | test | L5946 | ported:host/plugins/vfs/tests/resource-list-search.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::mindmap_operation_to_agent_op_shapes` | test | L6037 | ported:host/plugins/vfs/tests/mindmap-edit.test.ts |
| `src/chat_v2/tools/builtin_resource_executor.rs::tests::mindmap_op_label_chinese` | test | L6090 | ported:host/plugins/vfs/tests/mindmap-edit.test.ts |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_can_handle` | test | L1767 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_strip_namespace` | test | L1786 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_sensitivity_level` | test | L1793 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::score_thresholds_filter_low_scores_with_absolute_min` | test | L1802 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::score_thresholds_keep_top1_when_all_below_absolute_min` | test | L1815 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::score_thresholds_apply_relative_only_for_rrf_scale` | test | L1826 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::snippet_truncation_respects_budget` | test | L1838 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::numbered_sources_use_type_local_citation_indexes` | test | L1853 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::numbered_sources_expose_multimodal_fields_for_frontend_adapter` | test | L1875 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::numbered_sources_carry_media_time_fields_only_for_media_hits` | test | L1884 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::dedup_removes_memory_notes_from_kb_results` | test | L1899 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::dedup_uses_source_note_ids_for_compressed_memory_entries` | test | L1909 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_route_to_unified_search` | test | L1930 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::multimodal_search_uses_dedicated_me_only_scope` | test | L1939 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::executor_failure_boundary_localizes_retrieval_errors` | test | L1955 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_citation_prefix_for_source_type` | test | L1965 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_citation_group_for_source_type` | test | L1972 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::reranker_selection_tracks_query_and_candidate_modality` | test | L1982 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::tests::test_preferred_read_resource_id` | test | L2014 | pending |
| `src/chat_v2/tools/builtin_retrieval_executor.rs::session_scope_tests::scope_is_a_hard_filter_that_model_args_can_only_narrow` | test | L2096 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::handles_exact_dstu_tool_surface` | test | L893 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::risk_levels_match_product_contract` | test | L908 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::list_trash_is_the_only_parallel_read` | test | L934 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::secx_08_upload_source_requires_managed_runtime_locator` | test | L947 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::mime_inference_covers_primary_document_types` | test | L969 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::structured_errors_are_machine_readable` | test | L980 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::trash_pagination_matches_global_read_limit` | test | L988 | pending |
| `src/chat_v2/tools/dstu_executor.rs::tests::folder_create_and_trash_listing_use_real_migrated_vfs_repository` | test | L1009 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::block_type_mapping_for_render_generative_ui_is_generative_ui` | test | L521 | ported:host/plugins/vfs/tests/generative-ui.test.ts |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_accepts_object` | test | L535 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_accepts_version_1_1` | test | L547 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_defaults_missing_version_as_v1` | test | L572 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_ignores_unknown_layout` | test | L584 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_unknown_version` | test | L599 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::validate_intent_version_rejects_version_2` | test | L612 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_accepts_json_string` | test | L622 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_empty_blocks` | test | L631 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_oversized_payload` | test | L637 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_too_many_blocks` | test | L650 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_missing_intent` | test | L665 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_unknown_block_type` | test | L672 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_missing_block_type` | test | L685 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_rejects_non_object_block` | test | L697 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_intent_accepts_all_registered_block_types` | test | L709 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_accepts_non_empty_string` | test | L731 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_rejects_blank` | test | L740 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_rejects_unsafe_or_oversized` | test | L746 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_falls_back_to_intent_meta` | test | L756 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_research_session_id_prefers_top_level_over_meta` | test | L770 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_preserves_research_session_id_in_output` | tokio::test | L782 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_skeleton_ref_accepts_valid_skill_id` | test | L812 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_skeleton_ref_rejects_invalid_or_absent` | test | L821 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_accepts_append_payload` | test | L842 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_rejects_invalid_operation` | test | L856 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_rejects_regex_flag` | test | L862 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_rejects_oversized_payload` | test | L871 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_strips_unknown_fields` | test | L882 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::parse_note_edit_rejects_non_string_fields` | test | L905 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::intent_has_apply_note_edit_detects_action_bar_id` | test | L914 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_preserves_note_edit_in_tool_arguments` | tokio::test | L926 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_fails_when_apply_note_edit_without_note_edit_payload` | tokio::test | L964 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::can_handle_namespaced_and_plain_tool_name` | test | L991 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_success_returns_rendered_status_and_block_count` | tokio::test | L999 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_failure_on_empty_blocks_returns_error_result` | tokio::test | L1034 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_v1_1_grid_layout_returns_rendered` | tokio::test | L1052 | pending |
| `src/chat_v2/tools/generative_ui_executor.rs::tests::execute_rejects_version_2` | tokio::test | L1092 | pending |
<!-- END GENERATED:testmap:rows -->

## WP-200 folder v0 语料证据（2026-11-05）

原测试去向未修改：实际 pending 83 → 83、ported 293、obsolete 5（生成表头保留）。
本包不恢复旧73资格，也不把场景计作新增 Rust 移植测试。

- `equivalence/folders.v0.json`：8目标、1辅助（create）、21场景208步；前端 `src/dstu/api/folderApi.ts`
  :99/118/138/165/197/313/327/421；Rust `folder_handlers.rs`:233–451/637–695/910–976。
  逐命令与错误分支/未覆盖分支见 `equivalence/README.md` 的 WP-200 节。
- 读过 `folder_handlers.rs:988–1108` 原10测试和 `tests/folders.test.ts:85–173` 对应用例；未变更映射或断言。
  起点 job `20261105203032-f6f72a`：该文件30 passed / 0 failed / 0 skipped、exit0、无Errors。
- 结构 job `20261105203626-a60302` exit0；真实Host观察 job `20261105203626-70d31e` exit0：
  21场景、208实际调用（145 result、63 error），无跳过；
  `equivalence/raw/wp200-node/` 保留全部原始返回/错误、逐步事件、全部DB/表及日志（gzip无损JSON）。
- Electron内置Node同组 job `20261105203905-7dc4a5`：21 passed / 0 failed / 0 skipped、208实际调用、exit0、无Errors；
  原始记录位于 `equivalence/raw/wp200-electron/`。这是Host命令观察，不是renderer/UI验证。
- 这组只验证B侧场景可执行与成功/错误意图，不等于Rust差分、≥80%覆盖率、分支充分性或A/C验收；
  join/SQL阶段故障、OCC并发、带资源级联/缓存及历史坏树等缺口仍保留待办，未自行批准不可达。
