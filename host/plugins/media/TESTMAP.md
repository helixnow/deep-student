# L18-media-docs 测试去向（`host/plugins/media`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L18-media-docs：243 行（真实测试 243）· pending 166 · ported 77
<!-- END GENERATED:testmap:header -->

## 已移植但未接入（pending）

按 `docs/dev/electron-migration/quality.md` §3.3，以下测试所测模块尚无生产调用方，去向保持 `pending`：

- `tests/bilibili-bridge.test.ts`（2 行）已接入：`media_bilibili_bridge_pair` 启动本机 bridge 服务器，配对页/用户脚本由 `src/bilibili-bridge-server.ts` 提供，origin/redirect 校验在连接与能力探测路径上均有生产调用方。
- `tests/document-parser.test.ts::test_bounded_xlsx_writer_rejects_growth_past_limit`（R1-MD-06）：`BoundedCursor` 只被该测试调用，真实 XLSX writer 依赖 F7（L18-B04）未接，故保持 `pending`。
- `tests/bilibili-live.test.ts`（2 行）与 Rust 同名测试一致，默认由 `DS_BILIBILI_LIVE=1` 才执行；本机未联网验证，只验证了模块可加载。

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-docs/src/document_parser.rs::tests::test_document_parser_creation` | test | L4181 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_support` | test | L4187 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_with_unicode` | test | L4196 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_md_support` | test | L4205 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_file_too_large` | test | L4214 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_gbk_decoding` | test | L4229 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_txt_utf8_bom_decoding` | test | L4242 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_markdown_extension_alias` | test | L4253 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_base64_decoding_error` | test | L4263 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_base64_size_is_checked_before_decode` | test | L4270 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_bounded_xlsx_writer_rejects_growth_past_limit` | test | L4279 | pending |
| `crates/dstu-docs/src/document_parser.rs::tests::test_epub_extract_text_from_bytes` | test | L4356 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_epub_invalid_zip_reports_epub_error` | test | L4370 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_epub_extension_case_insensitive` | test | L4377 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_with_encrypted_package` | test | L4391 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_office_encryption_rejects_real_cfb_container_signature` | test | L4422 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_xlsx_text_sheet_header_carries_row_count` | test | L4442 | pending |
| `crates/dstu-docs/src/document_parser.rs::tests::test_xlsx_replace_rejects_empty_find_term` | test | L4463 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_xlsx_replace_iterates_only_populated_sparse_cells` | test | L4474 | pending |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_missing_content_types` | test | L4503 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_valid_document` | test | L4531 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_has_office_structure_but_missing_content_types` | test | L4572 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_with_encrypt_marker` | test | L4607 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_normal_pdf` | test | L4630 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_encrypt_in_trailer` | test | L4646 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_from_bytes` | test | L4663 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_empty_zip` | test | L4683 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_office_encryption_invalid_zip` | test | L4700 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_small_file` | test | L4711 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_large_file_encrypt_in_middle` | test | L4721 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_check_pdf_encryption_encrypt_as_content` | test | L4741 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_integration_extract_encrypted_docx` | test | L4754 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_integration_extract_encrypted_xlsx` | test | L4775 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/document_parser.rs::tests::test_xlsx_edit_paths_reject_zip_bombs_before_parsing` | test | L4808 | ported:host/plugins/media/tests/document-parser.test.ts |
| `crates/dstu-docs/src/docx_handout.rs::tests::decode_accepts_data_url_and_raw` | test | L437 | ported:host/plugins/media/tests/docx-handout.test.ts |
| `crates/dstu-docs/src/docx_handout.rs::tests::fit_emu_scales_wide_images_to_content_width` | test | L448 | ported:host/plugins/media/tests/docx-handout.test.ts |
| `crates/dstu-docs/src/docx_handout.rs::tests::default_spec_renders_image_block` | test | L457 | ported:host/plugins/media/tests/notes-export-docx.test.ts |
| `crates/dstu-docs/src/docx_handout.rs::tests::broken_image_degrades_to_placeholder` | test | L478 | ported:host/plugins/media/tests/notes-export-docx.test.ts |
| `crates/dstu-docs/src/docx_handout.rs::tests::handout_template_applies_official_layout` | test | L491 | ported:host/plugins/media/tests/notes-export-docx.test.ts |
| `crates/dstu-docs/src/pdfium_utils.rs::tests::linux_candidate_scan_finds_product_name_dir_with_spaces` | test | L357 | ported:host/plugins/media/tests/pdfium-utils.test.ts |
| `crates/dstu-docs/src/pdfium_utils.rs::tests::linux_candidate_scan_skips_missing_root` | test | L378 | ported:host/plugins/media/tests/pdfium-utils.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::aimd_additive_increase_multiplicative_decrease` | test | L646 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::failure_classification` | test | L676 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::verbose_json_bounds_parsed` | test | L706 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::runner_completes_and_grows_concurrency` | tokio::test | L724 | ported:host/plugins/media/tests/asr-runner.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::runner_backs_off_on_429_and_skips_400` | tokio::test | L744 | ported:host/plugins/media/tests/asr-runner.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::runner_aborts_on_auth_failure` | tokio::test | L771 | ported:host/plugins/media/tests/asr-runner.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::runner_stops_after_consecutive_failures` | tokio::test | L795 | ported:host/plugins/media/tests/asr-runner.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::runner_cancellation_keeps_completed_segments` | tokio::test | L813 | ported:host/plugins/media/tests/asr-runner.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::http_backend_posts_wav_and_records_bounds` | tokio::test | L839 | ported:host/plugins/media/tests/asr-backend.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::http_backend_sends_qwen_flash_segments_as_input_audio` | tokio::test | L866 | ported:host/plugins/media/tests/asr-backend.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::http_backend_downgrades_when_verbose_json_rejected` | tokio::test | L897 | ported:host/plugins/media/tests/asr-backend.test.ts |
| `crates/dstu-media/src/media/asr.rs::tests::http_backend_surfaces_retry_after` | tokio::test | L927 | ported:host/plugins/media/tests/asr-backend.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::parses_links_share_text_and_bare_ids` | test | L1386 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::default_track_prefers_creator_chinese_then_ai_chinese` | test | L1465 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::descriptor_file_name_and_validation` | test | L1503 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::subtitle_urls_must_stay_on_bilibili_hosts` | test | L1552 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::lookup_picks_page_tracks_and_downloads_bcc` | tokio::test | L1602 | ported:host/plugins/media/tests/bilibili-client.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::api_errors_and_missing_subtitles_have_stable_codes` | tokio::test | L1687 | ported:host/plugins/media/tests/bilibili-client.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::unknown_subtitles_use_same_route_grpc_and_never_claim_empty_on_failure` | tokio::test | L1733 | ported:host/plugins/media/tests/bilibili-client.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::relative_multihop_short_links_and_loops_are_bounded` | tokio::test | L1768 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::new_import_commits_subtitles_atomically_and_reimport_preserves_user_edits` | test | L1808 | ported:host/plugins/media/tests/bilibili-link-items.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::short_links_follow_one_redirect` | tokio::test | L1843 | ported:host/plugins/media/tests/bilibili-links.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::live_lookup_fetches_real_subtitles` | tokio::test | L1882 | ported:host/plugins/media/tests/bilibili-live.test.ts |
| `crates/dstu-media/src/media/bilibili.rs::tests::link_items_are_created_reused_and_never_decoded` | test | L1910 | ported:host/plugins/media/tests/bilibili-link-items.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::keeps_only_session_cookies_from_set_cookie` | test | L545 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::falls_back_to_session_fields_in_the_success_url` | test | L565 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::validates_qrcode_key_and_maps_poll_codes` | test | L573 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::face_only_from_bilibili_image_host_over_https` | test | L585 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::session_profile_falls_back_to_cookie_mid` | test | L595 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::poll_success_extracts_cookie_and_nav_marks_expired_on_101` | tokio::test | L603 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_auth.rs::tests::poll_waiting_returns_no_cookie` | tokio::test | L632 | ported:host/plugins/media/tests/bilibili-auth.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::live_native_playurl_and_range_share_one_attempt` | tokio::test | L1010 | ported:host/plugins/media/tests/bilibili-live.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::failed_primary_uses_backup_and_validates_the_range` | tokio::test | L1036 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::rejects_ignored_range_invalid_range_and_short_reads` | tokio::test | L1067 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::cdn_timeout_is_bounded_and_eof_is_preserved` | tokio::test | L1107 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::retains_backups_and_expires_signed_sources` | test | L1145 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::stream_path_accepts_vfs_file_ids_only` | test | L1156 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::upstream_range_is_clamped_to_one_chunk` | test | L1176 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::only_https_bilibili_cdn_urls_are_proxied` | test | L1192 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::picks_single_mp4_and_falls_back_to_backup_url` | test | L1207 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::resolves_play_url_through_the_api_with_cookie` | tokio::test | L1227 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::stream_qn_comes_from_query_and_falls_back_to_default` | test | L1266 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::cache_key_separates_qualities` | test | L1282 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::quality_options_keep_only_mp4_levels_from_accept_quality` | test | L1305 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::requests_selected_qn_and_reports_downgraded_quality` | tokio::test | L1371 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::downgraded_advertised_quality_checks_standard_mp4_on_the_same_account` | tokio::test | L1413 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream.rs::tests::standard_mp4_does_not_replace_a_playable_source_with_flv_or_a_lower_quality` | tokio::test | L1436 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream/linux.rs::tests::http_ranges_cover_the_requested_extent_instead_of_one_cdn_chunk` | test | L309 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_stream/linux.rs::tests::loopback_rejects_foreign_hosts_and_web_origins` | test | L333 | ported:host/plugins/media/tests/bilibili-stream.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::pairing_is_one_use_port_bound_and_requires_app_approval` | test | L597 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::reconnect_rotates_token_and_requires_same_account` | test | L634 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::live_approved_pairing_renews_the_idle_lease_but_disconnect_does_not` | test | L659 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::probe_failure_remains_visible_without_leaving_an_authorized_connection` | test | L677 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::stream_ack_sequence_limit_and_drop_cancellation` | tokio::test | L695 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge.rs::tests::cancelled_requests_release_slots_and_send_abort` | tokio::test | L759 | ported:host/plugins/media/tests/bilibili-bridge-hub.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs::tests::manual_redirect_accepts_manager_normalization_but_not_followed_or_unsafe_targets` | test | L541 | ported:host/plugins/media/tests/bilibili-bridge.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs::tests::actual_loopback_socket_checks_origin_pairs_probes_and_transfers_binary` | tokio::test | L587 | ported:host/plugins/media/tests/bilibili-bridge-server.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/bridge_server.rs::tests::loopback_origin_and_host_cannot_be_rebound` | test | L710 | ported:host/plugins/media/tests/bilibili-bridge.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/grpc.rs::tests::rejects_truncation_missing_state_flags_and_bad_trailers` | test | L149 | ported:host/plugins/media/tests/bilibili-grpc.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/grpc.rs::tests::parses_gzip_typed_tracks` | test | L166 | ported:host/plugins/media/tests/bilibili-grpc.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/policy.rs::tests::exact_domains_https_ports_and_credential_scopes` | test | L94 | ported:host/plugins/media/tests/bilibili-policy.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/session.rs::tests::auto_uses_the_app_account_without_requiring_a_browser_on_every_platform` | test | L452 | ported:host/plugins/media/tests/bilibili-session.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/session.rs::tests::native_guest_keeps_the_capable_bridge_preference` | test | L464 | ported:host/plugins/media/tests/bilibili-session.test.ts |
| `crates/dstu-media/src/media/bilibili_transport/session.rs::tests::native_preference_never_overrides_an_explicit_route` | test | L476 | ported:host/plugins/media/tests/bilibili-session.test.ts |
| `crates/dstu-media/src/media/commands.rs::tests::status_derivation` | test | L654 | ported:host/plugins/media/tests/media-types.test.ts |
| `crates/dstu-media/src/media/commands.rs::tests::import_get_export_flow` | test | L688 | ported:host/plugins/media/tests/media-commands.test.ts |
| `crates/dstu-media/src/media/commands.rs::tests::estimate_decodes_short_media` | test | L735 | ported:host/plugins/media/tests/media-commands.test.ts |
| `crates/dstu-media/src/media/commands.rs::tests::auto_transcribe_only_for_short_untranscribed_audio` | test | L752 | ported:host/plugins/media/tests/media-commands.test.ts |
| `crates/dstu-media/src/media/commands.rs::tests::non_media_files_are_rejected` | test | L770 | ported:host/plugins/media/tests/media-commands.test.ts |
| `crates/dstu-media/src/media/decoder.rs::tests::decodes_stereo_44k_wav_to_mono_16k_on_grid` | test | L445 | ported:host/plugins/media/tests/decoder.test.ts |
| `crates/dstu-media/src/media/decoder.rs::tests::probe_reports_duration_without_decoding` | test | L478 | ported:host/plugins/media/tests/decoder.test.ts |
| `crates/dstu-media/src/media/decoder.rs::tests::garbage_is_reported_as_unsupported` | test | L488 | ported:host/plugins/media/tests/decoder.test.ts |
| `crates/dstu-media/src/media/decoder.rs::tests::cancellation_stops_decoding` | test | L499 | ported:host/plugins/media/tests/decoder.test.ts |
| `crates/dstu-media/src/media/ledger.rs::tests::parses_handout_sections_into_chapters` | test | L503 | ported:host/plugins/media/tests/ledger.test.ts |
| `crates/dstu-media/src/media/ledger.rs::tests::tallies_cards_by_task_source_ref` | test | L524 | ported:host/plugins/media/tests/media-ledger.test.ts |
| `crates/dstu-media/src/media/ledger.rs::tests::tallies_questions_by_resource_ids_and_assembles_in_request_order` | test | L555 | ported:host/plugins/media/tests/media-ledger.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::lists_only_live_audio_video_files` | test | L499 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::transcript_status_matches_transcript_get_vocabulary` | test | L554 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::progress_duration_and_sort_by_recent_activity` | test | L625 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::folder_path_is_resolved` | test | L691 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::related_notes_match_exactly_and_skip_deleted` | test | L750 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/library.rs::tests::related_notes_accept_res_id_alias` | test | L819 | ported:host/plugins/media/tests/media-library.test.ts |
| `crates/dstu-media/src/media/mod.rs::tests::media_kind_by_mime_and_extension` | test | L136 | ported:host/plugins/media/tests/media-types.test.ts |
| `crates/dstu-media/src/media/mod.rs::tests::bilibili_link_items_are_video_without_local_media` | test | L148 | ported:host/plugins/media/tests/media-types.test.ts |
| `crates/dstu-media/src/media/mod.rs::tests::error_payload_has_stable_code` | test | L160 | ported:host/plugins/media/tests/media-types.test.ts |
| `crates/dstu-media/src/media/pipeline.rs::tests::decode_and_plan_produces_spans` | test | L588 | ported:host/plugins/media/tests/pipeline.test.ts |
| `crates/dstu-media/src/media/pipeline.rs::tests::transcribe_resource_end_to_end_with_mock_asr_and_resume` | tokio::test | L616 | ported:host/plugins/media/tests/media-transcriber.test.ts |
| `crates/dstu-media/src/media/pipeline.rs::tests::transcription_is_single_flight_and_cancellable_while_queued` | tokio::test | L737 | ported:host/plugins/media/tests/media-transcriber.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::output_length_tracks_global_grid_without_drift` | test | L223 | ported:host/plugins/media/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::chunking_does_not_change_output` | test | L236 | ported:host/plugins/media/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::impulse_lands_on_the_global_grid` | test | L246 | ported:host/plugins/media/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::silence_fill_keeps_timeline` | test | L266 | ported:host/plugins/media/tests/resample.test.ts |
| `crates/dstu-media/src/media/resample.rs::tests::passband_preserved_and_alias_suppressed` | test | L283 | ported:host/plugins/media/tests/resample.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::cue_time_variants` | test | L320 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::parses_srt_with_markup_and_crlf` | test | L328 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::parses_vtt_with_settings_notes_and_voice_tags` | test | L344 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::parses_bilibili_bcc_json` | test | L361 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::decodes_gbk_and_rejects_garbage` | test | L377 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/subtitle.rs::tests::export_roundtrips_through_parsers` | test | L386 | ported:host/plugins/media/tests/subtitle.test.ts |
| `crates/dstu-media/src/media/transcript.rs::tests::timestamps_roundtrip` | test | L68 | ported:host/plugins/media/tests/transcript.test.ts |
| `crates/dstu-media/src/media/transcript.rs::tests::transcript_text_skips_pending_and_empty` | test | L79 | ported:host/plugins/media/tests/transcript.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::detects_speech_regions_with_padding` | test | L354 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::frame_features_independent_of_chunking` | test | L373 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::short_gaps_merge` | test | L381 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::long_speech_is_split_at_most_max` | test | L405 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::short_segment_absorbed_into_previous` | test | L429 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::isolated_click_is_dropped_and_silence_yields_nothing` | test | L445 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/vad.rs::tests::continuous_speech_without_dynamics_is_still_speech` | test | L455 | ported:host/plugins/media/tests/vad.test.ts |
| `crates/dstu-media/src/media/wav.rs::tests::wav_header_is_valid` | test | L138 | ported:host/plugins/media/tests/wav.test.ts |
| `crates/dstu-media/src/media/wav.rs::tests::spool_roundtrip_by_time_range` | test | L148 | ported:host/plugins/media/tests/wav.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::asr_names_cover_suffix_style_and_exclude_tts` | test | L1021 | ported:host/plugins/media/tests/asr-models.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::protocol_follows_model_family` | test | L1054 | ported:host/plugins/media/tests/asr-models.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::provider_support_excludes_non_openai_protocols` | test | L1077 | ported:host/plugins/media/tests/asr-models.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::relay_config_uses_its_own_base_url_key_and_headers` | test | L1097 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::endpoint_url_tolerates_full_endpoint_base_urls` | test | L1146 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::chat_transcript_parsing_strips_qwen_language_prefix` | test | L1158 | ported:host/plugins/media/tests/asr.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_with_transcriptions_endpoint_posts_multipart_form` | tokio::test | L1178 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_with_qwen_flash_posts_input_audio_chat_request` | tokio::test | L1213 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_maps_401_to_auth_failed` | tokio::test | L1248 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_maps_429_to_rate_limited` | tokio::test | L1269 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_maps_5xx_to_transcription_failed` | tokio::test | L1289 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_rejects_empty_transcripts` | tokio::test | L1309 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-media/src/voice_input.rs::tests::transcribe_maps_transport_failures_to_network_codes` | tokio::test | L1329 | ported:host/plugins/media/tests/voice-input.test.ts |
| `crates/dstu-vision/src/exam_sheet_service.rs::exam_name_update_tests::card_only_updates_keep_the_existing_name` | test | L1845 | ported:host/plugins/media/tests/exam-sheet.test.ts |
| `crates/dstu-vision/src/exam_sheet_service.rs::exam_name_update_tests::explicit_names_rename_and_blank_names_clear` | test | L1854 | ported:host/plugins/media/tests/exam-sheet.test.ts |
| `crates/dstu-vision/src/llm_structurer.rs::tests::reusable_batch_result_distinguishes_failure_from_success` | test | L420 | ported:host/plugins/media/tests/llm-structurer.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_vlm_request_payload_honors_only_configured_limits` | test | L1568 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_truncate_utf8_ascii` | test | L1617 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_truncate_utf8_multibyte_boundary` | test | L1624 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_docx_vlm_stream_budget_rejects_limit_and_integer_overflow` | test | L1636 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_prepare_docx_image_fails_closed_for_malformed_input` | test | L1647 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_prepare_docx_image_resizes_and_enforces_hard_output_limit` | test | L1654 | ported:host/plugins/media/tests/question-import-vision.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_prepare_docx_images_applies_count_budget_before_processing` | test | L1674 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_remap_docx_question_image_indices_drops_invalid_entries` | test | L1686 | ported:host/plugins/media/tests/vlm-grounding.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_crop_figure_default_bbox_yields_minimal_crop` | test | L1703 | ported:host/plugins/media/tests/question-import-vision.test.ts |
| `crates/dstu-vision/src/vlm_grounding_service.rs::tests::test_crop_figure_inverted_and_out_of_range_bbox` | test | L1718 | ported:host/plugins/media/tests/question-import-vision.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::test_can_handle` | test | L389 | ported:host/plugins/media/tests/document-processing.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::test_sensitivity_level` | test | L402 | ported:host/plugins/media/tests/document-processing.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::test_sanitize_id` | test | L419 | ported:host/plugins/media/tests/document-processing.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::test_parse_stage` | test | L435 | ported:host/plugins/media/tests/document-processing.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::test_check_media_supported` | test | L474 | ported:host/plugins/media/tests/document-processing.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::resolve_file_supports_att_prefix_and_upload_resource` | test | L525 | ported:host/plugins/media/tests/document-processing-resolve.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::resolve_file_resolves_reference_resource_via_source_id` | test | L539 | ported:host/plugins/media/tests/document-processing-resolve.test.ts |
| `src/chat_v2/tools/document_processing_executor.rs::tests::resolve_file_rejects_unresolvable_resource` | test | L554 | ported:host/plugins/media/tests/document-processing-resolve.test.ts |
| `src/chat_v2/tools/docx_executor.rs::tests::test_can_handle` | test | L508 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/docx_executor.rs::tests::test_sensitivity_level` | test | L523 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/docx_executor.rs::tests::g06_docx_replace_blocks_tracked_revisions` | test | L574 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/docx_executor.rs::tests::g06_docx_replace_blocks_images_sdt_ole_and_complex_headers` | test | L591 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/docx_executor.rs::tests::g06_docx_replace_plain_document_passes_gate_and_edits` | test | L628 | pending |
| `src/chat_v2/tools/docx_executor.rs::tests::g06_docx_replace_comments_document_passes_with_warning` | test | L649 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::maps_supported_aspect_ratios_to_openai_image_sizes` | test | L802 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::maps_supported_aspect_ratios_to_sensenova_image_sizes` | test | L830 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::builds_image_generation_endpoint_without_double_slashes` | test | L867 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::parses_b64_json_before_url_response` | test | L883 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::returns_openai_error_message_when_present` | test | L899 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::decodes_data_url_base64_payloads` | test | L909 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/image_generation_executor.rs::tests::recognizes_explicit_image_generation_model_flag` | test | L915 | ported:host/plugins/media/tests/image-generation.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::handles_media_contract_tools` | test | L576 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::video_capability_reports_in_app_pipeline` | test | L583 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::transcription_is_medium_sensitivity` | test | L594 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::only_proven_audio_signatures_are_accepted` | test | L607 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::unavailable_capability_is_not_advertised_as_ready` | test | L641 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/media_executor.rs::tests::capability_reflects_resolved_asr_configuration` | test | L649 | ported:host/plugins/media/tests/media-executor.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_inventory_detects_macro_signature_and_revision_without_executing` | test | L954 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::xlsx_inventory_hashes_formula_validation_chart_pivot_and_external_link_evidence` | test | L978 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::pdf_inventory_reports_forms_signatures_attachments_and_encryption` | test | L1007 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::preflight_for_edit_separates_critical_from_high_features` | test | L1025 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::preflight_for_edit_plain_xlsx_has_no_gate_features` | test | L1055 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_preflight_blocks_revisions_sdt_images_and_ole` | test | L1073 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_preflight_table_borders_are_not_revisions` | test | L1101 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_preflight_plain_header_warns_but_complex_header_blocks` | test | L1119 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_preflight_toc_and_crossref_fields_are_critical_but_plain_fields_not` | test | L1152 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::docx_preflight_footnotes_and_comments_warn_without_blocking` | test | L1183 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::pptx_preflight_blocks_media_and_ole` | test | L1206 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::pptx_preflight_masters_notes_charts_warn_without_blocking` | test | L1224 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::shared_gate_error_carries_format_specific_wording` | test | L1274 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_fidelity_executor.rs::tests::shared_warning_switches_semantics_by_write_path` | test | L1302 | ported:host/plugins/media/tests/office-fidelity.test.ts |
| `src/chat_v2/tools/office_output.rs::tests::vfs_defaults_preserve_legacy_target` | test | L497 | ported:host/plugins/media/tests/office-output.test.ts |
| `src/chat_v2/tools/office_output.rs::tests::workspace_replace_requires_hash_bound_policy` | test | L503 | ported:host/plugins/media/tests/office-output.test.ts |
| `src/chat_v2/tools/office_output.rs::tests::fidelity_manifest_is_explicit_about_macro_policy` | test | L515 | ported:host/plugins/media/tests/office-output.test.ts |
| `src/chat_v2/tools/office_output.rs::tests::edit_cells_operation_uses_edit_semantics_not_create` | test | L536 | ported:host/plugins/media/tests/office-output.test.ts |
| `src/chat_v2/tools/office_output.rs::tests::docx_pptx_delivery_handles_carry_lineage_and_capabilities` | test | L552 | ported:host/plugins/media/tests/office-output.test.ts |
| `src/chat_v2/tools/pptx_executor.rs::tests::test_can_handle` | test | L607 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/pptx_executor.rs::tests::test_sensitivity_level` | test | L622 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/pptx_executor.rs::tests::g06_pptx_replace_blocks_media_and_embedded_ole` | test | L668 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/pptx_executor.rs::tests::g06_pptx_replace_masters_and_notes_pass_with_warning` | test | L693 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/pptx_executor.rs::tests::g06_pptx_replace_self_generated_deck_passes_gate_and_edits` | test | L720 | pending |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::rejects_unknown_fields_and_invalid_normalized_rectangles` | test | L1266 | ported:host/plugins/media/tests/textbook-pdf.test.ts |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::paginates_at_twenty_and_marks_long_text_truncated` | test | L1275 | ported:host/plugins/media/tests/textbook-pdf.test.ts |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::rejects_stale_occ_with_bounded_current_value` | test | L1310 | ported:host/plugins/media/tests/textbook-pdf.test.ts |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::repository_persists_highlights_and_rejects_stale_version` | test | L1327 | ported:host/plugins/media/tests/media-commands.test.ts |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::compresses_large_page_images_below_output_limits` | test | L1356 | pending |
| `src/chat_v2/tools/textbook_pdf_executor.rs::tests::sensitivity_keeps_reads_low_and_annotation_writes_medium` | test | L1371 | ported:host/plugins/media/tests/textbook-pdf.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::test_can_handle` | test | L692 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::test_sensitivity_level` | test | L708 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_preflight_blocks_macro_workbook` | test | L741 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_formula_workbook_allows_edit_with_warning` | test | L752 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_non_formula_edit_preserves_other_formulas` | test | L771 | pending |
| `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_overwritten_formula_cells_are_listed` | test | L786 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/chat_v2/tools/xlsx_executor.rs::tests::g06_edit_cells_plain_workbook_has_no_warning` | test | L801 | ported:host/plugins/media/tests/office-executors.test.ts |
| `src/cmd/handout.rs::tests::cancel_marks_shared_token` | tokio::test | L197 | ported:host/plugins/media/tests/handout.test.ts |
| `src/cmd/handout.rs::tests::cancelled_token_short_circuits` | tokio::test | L209 | ported:host/plugins/media/tests/handout.test.ts |
<!-- END GENERATED:testmap:rows -->

## WP-138（2026-11-06）

- 前后实际行统计均为 **pending 7 / ported 236 / merged 0 / obsolete 0**（243 行），生成表头的旧统计未手改。
- `dstu-vision/src/pdf_ocr_service.rs` 无 Rust 测试行；本包不改任何映射资格。
  `tests/pdf-ocr-service.test.ts` 新增 7 个 `WP-138` 生产路径用例，逐分支对应 :888-897、:1094-1097、
  :1111-1117、:798-804、:1020-1078/:669-760。完整对应见 SPEC 的 WP-138 小节。
- WP-105 异常退出测试保留全部原 expect 和 10s/100ms 等待预算，故障输入从单页 bbox 改为外层 finished
  logger 抛错：页任务 panic 现必须由 JoinSet 隔离，不能继续把该输入当成 outer worker crash。
  这不是修改 Rust 单测断言（该源文件无单测）；原 receiver Drop 的阻塞/后续上传错误与已保存图片断言不变。
