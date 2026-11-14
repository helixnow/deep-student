# G3 报告（机器生成，勿手改）

规则：board/G3-LEDGER.md；HEAD `58f391ee7fd9b378851bb67c1983c6430cdddfeb`；分母 768（sha256 `4f47fa0afb7d4797ff46ccc82db860eaf7109a5114dd4f7edd9ff6f50d7d718e`，inventory `0be446253dd4f154ac4bee3216fc196d80ac0d66a473cb8415287598b2e5b941`）。

| pass | fail | no-scenario | blocked | excluded | 合计 |
|---:|---:|---:|---:|---:|---:|
| 0 | 0 | 768 | 0 | 0 | 768 |

通过率：**0/768 = 0%**。
有场景文件的命令：208（仅信息，不作分母）。
Rust 行覆盖率（instrument-coverage 实测）：未测量（no llvm-cov export summary supplied）。
扫描场景文件 46 个，有效 compare 产物 0 个，问题 0 条。

## 逐命令

| 命令 | owner | 状态 | 场景(owner/g3w) | 证据（scenario / A / B / compare，sha256） | 备注 |
|---|---|---|---|---|---|
| add_cards_to_anki_connect | L16-anki | no-scenario | 0/0 |  | no scenario |
| add_ocr_engine | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| anki_get_deck_names | L16-anki | no-scenario | 0/0 |  | no scenario |
| auto_install_package_manager | F4-security | no-scenario | 0/0 |  | no scenario |
| batch_export_cards | L16-anki | no-scenario | 0/0 |  | no scenario |
| browser_list_task_downloads | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| call_llm_for_boundary | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| cancel_document_processing | L16-anki | no-scenario | 0/0 |  | no scenario |
| cancel_mcp_oauth | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| cancel_question_bank_import | L14-qbank | no-scenario | 0/0 |  | no scenario |
| cancel_questions_csv_import | L14-qbank | no-scenario | 0/0 |  | no scenario |
| cancel_stream | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| canvas_note_append | L10-notes | no-scenario | 0/0 |  | no scenario |
| canvas_note_read | L10-notes | no-scenario | 0/0 |  | no scenario |
| canvas_note_replace | L10-notes | no-scenario | 0/0 |  | no scenario |
| canvas_note_set | L10-notes | no-scenario | 0/0 |  | no scenario |
| chat_v2_add_tag | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_archive_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_ask_user_respond | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_authorize_runtime_root | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_cancel_run | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_create | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_delete | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_list | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_retry_run | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_run_now | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_runs | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_set_background_enabled | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_set_enabled | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_summary | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_automation_update | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_branch_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_cancel_stream | L04-chat-session | no-scenario | 4/0 |  | scenario exists, A/B not run |
| chat_v2_cancel_variant | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_canvas_edit_ack | L10-notes | no-scenario | 0/0 |  | no scenario |
| chat_v2_canvas_edit_result | L10-notes | no-scenario | 0/0 |  | no scenario |
| chat_v2_check_migration_status | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_clear_approval_history | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_compact_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_continue_message | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_count_sessions | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_create_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_create_session | L04-chat-session | no-scenario | 132/0 |  | scenario exists, A/B not run |
| chat_v2_delete_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_delete_message | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_delete_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_delete_variant | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_edit_and_resend | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_export_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_export_session_messages | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_export_session_meta | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_freeze_available_skills_snapshot | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_get_anki_cards_from_block_by_document_id | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_get_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_get_message_summary | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_get_rag_scope | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_get_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_goal_clear | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_goal_edit | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_goal_get | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_goal_pause | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_goal_resume | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_has_active_stream | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_import_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_all_tags | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_groups | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_runtime_directory | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_runtime_roots | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_sessions | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_list_sessions_referencing | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_load_messages_page | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_load_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_migrate_legacy_chat | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_move_session_to_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_perform_ocr | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_plan_gate_respond | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_read_runtime_file | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_remove_tag | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_reorder_groups | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_reset_workspace_root | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_resolve_runtime_path | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_restore_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_restore_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_retry_message | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_retry_variant | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_retry_variants | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_revert_artifact_write | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_revert_workspace_change | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_revoke_runtime_root | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_rollback_migration | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_save_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_search_content | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_search_sessions | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_send_message | L04-chat-session | no-scenario | 136/0 |  | scenario exists, A/B not run |
| chat_v2_set_authority_mode | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_set_rag_scope | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_set_skill_trust | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_set_workspace_root | L05-agent-workspace | no-scenario | 0/0 |  | no scenario |
| chat_v2_stage_context_attachments | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_super_deliver_inbox | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| chat_v2_switch_variant | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_tool_approval_respond | L04-chat-session | no-scenario | 27/0 |  | scenario exists, A/B not run |
| chat_v2_undo_compaction | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_update_block_content | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_update_block_tool_output | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_update_group | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_update_session_settings | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_upsert_streaming_block | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| chat_v2_wake_session | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| check_all_package_managers | F4-security | no-scenario | 0/0 |  | no scenario |
| check_anki_connect_status | L16-anki | no-scenario | 0/0 |  | no scenario |
| check_package_manager | F4-security | no-scenario | 0/0 |  | no scenario |
| clear_message_embeddings | L12-vfs-index | no-scenario | 20/0 |  | scenario exists, A/B not run |
| clear_test_slots | F3-storage | no-scenario | 0/0 |  | no scenario |
| cloud_config_publish | F4-security | no-scenario | 32/0 |  | scenario exists, A/B not run |
| cloud_config_ssot_clear | F4-security | no-scenario | 5/0 |  | scenario exists, A/B not run |
| cloud_config_ssot_get | F4-security | no-scenario | 47/0 |  | scenario exists, A/B not run |
| cloud_config_ssot_save | F4-security | no-scenario | 46/0 |  | scenario exists, A/B not run |
| cloud_config_test_connection_draft | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| cloud_storage_check_connection | L23-sync-providers | no-scenario | 6/0 |  | scenario exists, A/B not run |
| cloud_storage_delete | L23-sync-providers | no-scenario | 4/0 |  | scenario exists, A/B not run |
| cloud_storage_exists | L23-sync-providers | no-scenario | 4/0 |  | scenario exists, A/B not run |
| cloud_storage_get | L23-sync-providers | no-scenario | 13/0 |  | scenario exists, A/B not run |
| cloud_storage_is_s3_enabled | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_storage_list | L23-sync-providers | no-scenario | 7/0 |  | scenario exists, A/B not run |
| cloud_storage_put | L23-sync-providers | no-scenario | 8/0 |  | scenario exists, A/B not run |
| cloud_storage_stat | L23-sync-providers | no-scenario | 4/0 |  | scenario exists, A/B not run |
| cloud_sync_delete_version | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_sync_download | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_sync_get_device_id | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_sync_get_status | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_sync_list_versions | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| cloud_sync_upload | L23-sync-providers | no-scenario | 0/0 |  | no scenario |
| convert_heic_to_jpeg | L18-media-docs | no-scenario | 1/0 |  | scenario exists, A/B not run |
| copy_file | F2-shell | no-scenario | 0/0 |  | no scenario |
| count_custom_template_references | L16-anki | no-scenario | 0/0 |  | no scenario |
| create_anki_deck | L16-anki | no-scenario | 0/0 |  | no scenario |
| create_custom_template | L16-anki | no-scenario | 30/0 |  | scenario exists, A/B not run |
| data_governance_auto_verify_latest_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_backup_and_export_zip | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_backup_tiered | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_cancel_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_cancel_sync | L20-sync | no-scenario | 1/0 |  | scenario exists, A/B not run |
| data_governance_check_disk_space_for_restore | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_cleanup_audit_logs | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_cleanup_persisted_jobs | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_count_record_conflicts | L20-sync | no-scenario | 6/0 |  | scenario exists, A/B not run |
| data_governance_delete_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_detect_conflicts | L20-sync | no-scenario | 5/0 |  | scenario exists, A/B not run |
| data_governance_detect_prune_gap | L20-sync | no-scenario | 6/0 |  | scenario exists, A/B not run |
| data_governance_discard_all_quarantine | L20-sync | no-scenario | 2/0 |  | scenario exists, A/B not run |
| data_governance_discard_quarantine | L20-sync | no-scenario | 2/0 |  | scenario exists, A/B not run |
| data_governance_export_sync_data | L20-sync | no-scenario | 17/0 |  | scenario exists, A/B not run |
| data_governance_export_zip | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_asset_types | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_audit_logs | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_backup_job | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_backup_list | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_database_status | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_maintenance_status | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_migration_diagnostic_report | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_migration_status | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_schema_registry | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_get_sync_status | L20-sync | no-scenario | 6/0 |  | scenario exists, A/B not run |
| data_governance_import_sync_data | L20-sync | no-scenario | 16/0 |  | scenario exists, A/B not run |
| data_governance_import_zip | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_list_backup_jobs | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_list_quarantine | L20-sync | no-scenario | 5/0 |  | scenario exists, A/B not run |
| data_governance_list_record_conflicts | L20-sync | no-scenario | 7/0 |  | scenario exists, A/B not run |
| data_governance_list_resumable_jobs | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_list_sync_snapshot_batches | L20-sync | no-scenario | 7/0 |  | scenario exists, A/B not run |
| data_governance_list_unsynced_items | L20-sync | no-scenario | 0/0 |  | no scenario |
| data_governance_mark_asset_deleted | L20-sync | no-scenario | 4/0 |  | scenario exists, A/B not run |
| data_governance_mark_blob_deleted | L20-sync | no-scenario | 7/0 |  | scenario exists, A/B not run |
| data_governance_purge_all_data | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_purge_resolved_conflicts | L20-sync | no-scenario | 4/0 |  | scenario exists, A/B not run |
| data_governance_repo_check | L20-sync | no-scenario | 0/0 |  | no scenario |
| data_governance_resolve_conflicts | L20-sync | no-scenario | 3/0 |  | scenario exists, A/B not run |
| data_governance_resolve_record_conflict | L20-sync | no-scenario | 7/0 |  | scenario exists, A/B not run |
| data_governance_restore_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_restore_with_assets | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_resume_backup_job | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_retry_all_quarantine | L20-sync | no-scenario | 2/0 |  | scenario exists, A/B not run |
| data_governance_retry_quarantine | L20-sync | no-scenario | 2/0 |  | scenario exists, A/B not run |
| data_governance_rollback_sync_snapshot_batch | L20-sync | no-scenario | 3/0 |  | scenario exists, A/B not run |
| data_governance_run_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_run_health_check | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_run_slot_c_empty_db_test | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_run_slot_d_clone_db_test | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_run_sync | L20-sync | no-scenario | 7/0 |  | scenario exists, A/B not run |
| data_governance_run_sync_with_progress | L20-sync | no-scenario | 6/0 |  | scenario exists, A/B not run |
| data_governance_scan_assets | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_verify_backup | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| data_governance_verify_backup_with_assets | L21-backup-governance | no-scenario | 0/0 |  | no scenario |
| delete_anki_card | L16-anki | no-scenario | 1/0 |  | scenario exists, A/B not run |
| delete_custom_template | L16-anki | no-scenario | 0/0 |  | no scenario |
| delete_document_session | L16-anki | no-scenario | 1/0 |  | scenario exists, A/B not run |
| delete_setting | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| dismiss_pending_memory_candidates | L16-anki | no-scenario | 0/0 |  | no scenario |
| dstu_batch_move | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_build_path | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_copy | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_create | L13-vfs-api | no-scenario | 361/0 |  | scenario exists, A/B not run |
| dstu_delete | L13-vfs-api | no-scenario | 29/0 |  | scenario exists, A/B not run |
| dstu_delete_many | L13-vfs-api | no-scenario | 12/0 |  | scenario exists, A/B not run |
| dstu_empty_trash | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_export | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_export_formats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_add_item | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_create | L13-vfs-api | no-scenario | 45/0 |  | scenario exists, A/B not run |
| dstu_folder_delete | L13-vfs-api | no-scenario | 6/0 |  | scenario exists, A/B not run |
| dstu_folder_get | L13-vfs-api | no-scenario | 13/0 |  | scenario exists, A/B not run |
| dstu_folder_get_all_resources | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_get_breadcrumbs | L13-vfs-api | no-scenario | 12/0 |  | scenario exists, A/B not run |
| dstu_folder_get_items | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_get_tree | L13-vfs-api | no-scenario | 13/0 |  | scenario exists, A/B not run |
| dstu_folder_list | L13-vfs-api | no-scenario | 14/0 |  | scenario exists, A/B not run |
| dstu_folder_move | L13-vfs-api | no-scenario | 6/0 |  | scenario exists, A/B not run |
| dstu_folder_move_item | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_remove_item | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_rename | L13-vfs-api | no-scenario | 12/0 |  | scenario exists, A/B not run |
| dstu_folder_reorder | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_reorder_items | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_folder_set_expanded | L13-vfs-api | no-scenario | 3/0 |  | scenario exists, A/B not run |
| dstu_get | L13-vfs-api | no-scenario | 52/0 |  | scenario exists, A/B not run |
| dstu_get_content | L13-vfs-api | no-scenario | 23/0 |  | scenario exists, A/B not run |
| dstu_get_path_by_id | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_get_resource_by_path | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_get_resource_location | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_list | L13-vfs-api | no-scenario | 61/0 |  | scenario exists, A/B not run |
| dstu_list_deleted | L13-vfs-api | no-scenario | 13/0 |  | scenario exists, A/B not run |
| dstu_list_trash | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_move | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_move_many | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_move_to_folder | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_parse_path | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_permanently_delete | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_purge | L13-vfs-api | no-scenario | 8/0 |  | scenario exists, A/B not run |
| dstu_purge_all | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_refresh_path_cache | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_rename | L13-vfs-api | no-scenario | 17/0 |  | scenario exists, A/B not run |
| dstu_restore | L13-vfs-api | no-scenario | 9/0 |  | scenario exists, A/B not run |
| dstu_restore_many | L13-vfs-api | no-scenario | 10/0 |  | scenario exists, A/B not run |
| dstu_search | L13-vfs-api | no-scenario | 12/0 |  | scenario exists, A/B not run |
| dstu_search_in_folder | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_set_favorite | L13-vfs-api | no-scenario | 8/0 |  | scenario exists, A/B not run |
| dstu_set_metadata | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_soft_delete | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_trash_restore | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_unwatch | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| dstu_update | L13-vfs-api | no-scenario | 34/0 |  | scenario exists, A/B not run |
| dstu_watch | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| essay_grading_create_custom_mode | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_create_session | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_delete_custom_mode | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_delete_session | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_latest_round_number | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_mode | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_models | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_modes | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_round | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_rounds | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_get_session | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_has_builtin_override | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_list_custom_modes | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_list_sessions | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_reset_builtin_mode | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_save_builtin_override | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_stream | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_toggle_favorite | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_update_custom_mode | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| essay_grading_update_session | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| export_anki_cards | L16-anki | no-scenario | 0/0 |  | no scenario |
| export_cards_as_apkg_with_template | L16-anki | no-scenario | 0/0 |  | no scenario |
| export_diagnostics_bundle | F4-security | no-scenario | 0/0 |  | no scenario |
| export_multi_template_apkg | L16-anki | no-scenario | 0/0 |  | no scenario |
| export_questions_csv | L14-qbank | no-scenario | 0/0 |  | no scenario |
| export_startup_recovery_incident | F3-storage | no-scenario | 0/0 |  | no scenario |
| export_startup_recovery_report | F3-storage | no-scenario | 0/0 |  | no scenario |
| export_template | L16-anki | no-scenario | 0/0 |  | no scenario |
| filestream_check_access | L13-vfs-api | no-scenario | 5/0 |  | scenario exists, A/B not run |
| fsrs_enqueue_cards | L15-review-analytics | no-scenario | 26/0 |  | scenario exists, A/B not run |
| fsrs_get_card_memory_history | L15-review-analytics | no-scenario | 20/0 |  | scenario exists, A/B not run |
| fsrs_get_due | L15-review-analytics | no-scenario | 16/0 |  | scenario exists, A/B not run |
| fsrs_get_memory_overview | L15-review-analytics | no-scenario | 8/0 |  | scenario exists, A/B not run |
| fsrs_get_review_statistics | L15-review-analytics | no-scenario | 14/0 |  | scenario exists, A/B not run |
| fsrs_get_scheduler_config | L15-review-analytics | no-scenario | 7/0 |  | scenario exists, A/B not run |
| fsrs_get_stats | L15-review-analytics | no-scenario | 14/0 |  | scenario exists, A/B not run |
| fsrs_optimize_parameters | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| fsrs_preview_intervals | L15-review-analytics | no-scenario | 14/0 |  | scenario exists, A/B not run |
| fsrs_rate | L15-review-analytics | no-scenario | 26/0 |  | scenario exists, A/B not run |
| fsrs_reset_card_progress | L15-review-analytics | no-scenario | 5/0 |  | scenario exists, A/B not run |
| fsrs_suspend_card | L15-review-analytics | no-scenario | 6/0 |  | scenario exists, A/B not run |
| fsrs_undo_last_review | L15-review-analytics | no-scenario | 11/0 |  | scenario exists, A/B not run |
| fsrs_unsuspend_card | L15-review-analytics | no-scenario | 5/0 |  | scenario exists, A/B not run |
| fsrs_update_scheduler_config | L15-review-analytics | no-scenario | 15/0 |  | scenario exists, A/B not run |
| get_all_custom_templates | L16-anki | no-scenario | 25/0 |  | scenario exists, A/B not run |
| get_anki_deck_names | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_anki_library_card_content | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_anki_model_names | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_anki_stats | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_api_configurations | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| get_app_data_dir | F2-shell | no-scenario | 16/0 |  | scenario exists, A/B not run |
| get_app_version | F2-shell | no-scenario | 1/0 |  | scenario exists, A/B not run |
| get_auto_backup_status | F4-security | no-scenario | 0/0 |  | no scenario |
| get_available_ocr_models | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| get_backup_config | F4-security | no-scenario | 32/0 |  | scenario exists, A/B not run |
| get_cn_whitelist_config | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_csv_preview | L14-qbank | no-scenario | 0/0 |  | no scenario |
| get_data_space_info | F3-storage | no-scenario | 0/0 |  | no scenario |
| get_default_template_id | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_document_cards | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_document_processing_state | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_document_tasks | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_enhanced_statistics | L14-qbank | no-scenario | 0/0 |  | no scenario |
| get_file_size | F2-shell | no-scenario | 0/0 |  | no scenario |
| get_image_as_base64 | L18-media-docs | no-scenario | 3/0 |  | scenario exists, A/B not run |
| get_learning_heatmap | L14-qbank | no-scenario | 0/0 |  | no scenario |
| get_mcp_oauth_access_token | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_mcp_oauth_status | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_mcp_status | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_mcp_stdio_allow_unapproved | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_model_adapter_options | L16-anki | no-scenario | 0/0 |  | no scenario |
| get_model_assignments | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| get_model_profiles | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| get_ocr_engine_type | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| get_ocr_engines | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| get_ocr_thinking_enabled | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| get_prevent_sleep | F2-shell | no-scenario | 0/0 |  | no scenario |
| get_provider_strategies_config | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_security_status | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_setting | L19-mcp-browser | no-scenario | 37/0 |  | scenario exists, A/B not run |
| get_settings_by_prefix | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| get_test_slot_info | F3-storage | no-scenario | 0/0 |  | no scenario |
| get_vendor_configs | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| handout_cancel | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| handout_llm_complete | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| handout_release | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| handout_vlm_caption | L18-media-docs | no-scenario | 1/0 |  | scenario exists, A/B not run |
| import_anki_package | L16-anki | no-scenario | 0/0 |  | no scenario |
| import_apkg_to_library | L16-anki | no-scenario | 0/0 |  | no scenario |
| import_builtin_templates | L16-anki | no-scenario | 0/0 |  | no scenario |
| import_custom_templates_bulk | L16-anki | no-scenario | 0/0 |  | no scenario |
| import_question_bank_stream | L14-qbank | no-scenario | 0/0 |  | no scenario |
| import_questions_csv | L14-qbank | no-scenario | 0/0 |  | no scenario |
| install_apk | F2-shell | no-scenario | 0/0 |  | no scenario |
| list_anki_library_cards | L16-anki | no-scenario | 27/0 |  | scenario exists, A/B not run |
| list_document_sessions | L16-anki | no-scenario | 0/0 |  | no scenario |
| llm_usage_by_caller | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_by_model | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_cleanup | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_daily | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_get_trends | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_recent | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_session_summary | F3-storage | no-scenario | 0/0 |  | no scenario |
| llm_usage_summary | F3-storage | no-scenario | 0/0 |  | no scenario |
| log_debug_message | F4-security | no-scenario | 0/0 |  | no scenario |
| mark_data_space_pending_switch_to_inactive | F3-storage | no-scenario | 0/0 |  | no scenario |
| mark_pending_memory_candidates_saved | L16-anki | no-scenario | 0/0 |  | no scenario |
| mastery_get_overview | L15-review-analytics | no-scenario | 7/0 |  | scenario exists, A/B not run |
| mcp_stdio_close | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| mcp_stdio_send | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| mcp_stdio_start | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| media_bilibili_auth_status | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_cancel | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_create | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_import_subtitle | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_link_get | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_login_qr_poll | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_login_qr_start | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_logout | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_probe | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_stream_quality | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_bilibili_transport_status | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_chapters | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_checkpoints | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_library_list | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_progress_get | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_progress_set | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_related_notes | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_study_ledger | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_transcribe_cancel | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_transcribe_estimate | L18-media-docs | no-scenario | 3/0 |  | scenario exists, A/B not run |
| media_transcribe_start | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| media_transcript_export | L18-media-docs | no-scenario | 3/0 |  | scenario exists, A/B not run |
| media_transcript_get | L18-media-docs | no-scenario | 4/0 |  | scenario exists, A/B not run |
| media_transcript_import | L18-media-docs | no-scenario | 3/0 |  | scenario exists, A/B not run |
| memory_add_relation | L17-memory-research | no-scenario | 8/0 |  | scenario exists, A/B not run |
| memory_batch_delete | L17-memory-research | no-scenario | 4/0 |  | scenario exists, A/B not run |
| memory_batch_move | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_create_root_folder | L17-memory-research | no-scenario | 12/0 |  | scenario exists, A/B not run |
| memory_delete | L17-memory-research | no-scenario | 6/0 |  | scenario exists, A/B not run |
| memory_export_all | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_get_audit_logs | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_get_config | L17-memory-research | no-scenario | 25/0 |  | scenario exists, A/B not run |
| memory_get_profile | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_get_related | L17-memory-research | no-scenario | 8/0 |  | scenario exists, A/B not run |
| memory_get_tags | L17-memory-research | no-scenario | 11/0 |  | scenario exists, A/B not run |
| memory_get_tree | L17-memory-research | no-scenario | 16/0 |  | scenario exists, A/B not run |
| memory_list | L17-memory-research | no-scenario | 29/0 |  | scenario exists, A/B not run |
| memory_move_to_folder | L17-memory-research | no-scenario | 5/0 |  | scenario exists, A/B not run |
| memory_read | L17-memory-research | no-scenario | 14/0 |  | scenario exists, A/B not run |
| memory_remove_relation | L17-memory-research | no-scenario | 5/0 |  | scenario exists, A/B not run |
| memory_restore_archived | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_restore_stale | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_search | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_set_auto_create_subfolders | L17-memory-research | no-scenario | 4/0 |  | scenario exists, A/B not run |
| memory_set_auto_extract_frequency | L17-memory-research | no-scenario | 3/0 |  | scenario exists, A/B not run |
| memory_set_default_category | L17-memory-research | no-scenario | 5/0 |  | scenario exists, A/B not run |
| memory_set_privacy_mode | L17-memory-research | no-scenario | 2/0 |  | scenario exists, A/B not run |
| memory_set_root_folder | L17-memory-research | no-scenario | 6/0 |  | scenario exists, A/B not run |
| memory_to_anki_document | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_update_by_id | L17-memory-research | no-scenario | 5/0 |  | scenario exists, A/B not run |
| memory_update_tags | L17-memory-research | no-scenario | 5/0 |  | scenario exists, A/B not run |
| memory_write | L17-memory-research | no-scenario | 44/0 |  | scenario exists, A/B not run |
| memory_write_batch | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| memory_write_smart | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| notes_assets_bulk_delete | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_assets_index_scan | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_assets_scan_orphans | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_db_stats | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_db_vacuum | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_delete_asset | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_begin | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_finish | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_freeze_ack | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_heartbeat | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_lease_status | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_refresh_ack | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_register | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_release | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_editor_unregister | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_empty_trash | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_enable_columns | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_export | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_export_docx | L18-media-docs | no-scenario | 2/0 |  | scenario exists, A/B not run |
| notes_export_single | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_get_format | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_get_pref | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_hard_delete | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_current | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_get | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_get_retention | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_list | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_restore_copy | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_restore_current | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_restore_selection_copy | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_set_pinned | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_history_set_retention | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_import | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_import_markdown | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_import_markdown_batch | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_list_assets | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_list_deleted | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_list_referencing_resource | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_list_tags | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_mentions_search | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_reference_status | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_relation_delete | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_relation_list | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_relation_put | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_resolve_asset_path | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_restore | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_review_save_as | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_save_asset | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_search | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_set_pref | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_state_delete | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_state_get | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_state_list | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_state_put | L10-notes | no-scenario | 0/0 |  | no scenario |
| notes_update | L10-notes | no-scenario | 0/0 |  | no scenario |
| ocr_extract_text | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| open_file_externally | F2-shell | no-scenario | 0/0 |  | no scenario |
| open_startup_recovery_incident_folder | F3-storage | no-scenario | 0/0 |  | no scenario |
| openai_codex_auth_status | L01-llm-providers | no-scenario | 12/0 |  | scenario exists, A/B not run |
| optimize_lance_database | L12-vfs-index | no-scenario | 7/0 |  | scenario exists, A/B not run |
| parse_document_from_base64 | L18-media-docs | no-scenario | 7/0 |  | scenario exists, A/B not run |
| pause_document_processing | L16-anki | no-scenario | 0/0 |  | no scenario |
| pdfstream_check_access | F2-shell | no-scenario | 0/0 |  | no scenario |
| plugin_begin_login | F1-kernel | no-scenario | 2/0 |  | scenario exists, A/B not run |
| plugin_cancel_login | F1-kernel | no-scenario | 3/0 |  | scenario exists, A/B not run |
| plugin_get_config | F1-kernel | no-scenario | 30/0 |  | scenario exists, A/B not run |
| plugin_get_status | F1-kernel | no-scenario | 29/0 |  | scenario exists, A/B not run |
| plugin_list | F1-kernel | no-scenario | 11/0 |  | scenario exists, A/B not run |
| plugin_logout | F1-kernel | no-scenario | 4/0 |  | scenario exists, A/B not run |
| plugin_set_config | F1-kernel | no-scenario | 13/0 |  | scenario exists, A/B not run |
| plugin_set_enabled | F1-kernel | no-scenario | 7/0 |  | scenario exists, A/B not run |
| plugin_start | F1-kernel | no-scenario | 6/0 |  | scenario exists, A/B not run |
| plugin_stop | F1-kernel | no-scenario | 6/0 |  | scenario exists, A/B not run |
| plugin_unbind | F1-kernel | no-scenario | 3/0 |  | scenario exists, A/B not run |
| pomodoro_create_record | L13-vfs-api | no-scenario | 1/0 |  | scenario exists, A/B not run |
| pomodoro_daily_stats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_delete_record | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_get_record | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_list_by_todo | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_list_range | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_list_today | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| pomodoro_today_stats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| preheat_mcp_tools | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| purge_active_data_dir_now | F3-storage | no-scenario | 0/0 |  | no scenario |
| purge_all_database_files | F3-storage | no-scenario | 0/0 |  | no scenario |
| qbank_ai_generate_questions | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_ai_grade | L14-qbank | no-scenario | 31/0 |  | scenario exists, A/B not run |
| qbank_batch_create_questions | L14-qbank | no-scenario | 11/0 |  | scenario exists, A/B not run |
| qbank_batch_delete_questions | L14-qbank | no-scenario | 4/0 |  | scenario exists, A/B not run |
| qbank_batch_update_questions | L14-qbank | no-scenario | 6/0 |  | scenario exists, A/B not run |
| qbank_cancel_generation_task | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_cancel_grading | L14-qbank | no-scenario | 5/0 |  | scenario exists, A/B not run |
| qbank_commit_authoring_draft | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_complete_paper_export | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_create_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_create_question | L14-qbank | no-scenario | 186/0 |  | scenario exists, A/B not run |
| qbank_crop_source_image | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_delete_group | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_delete_material | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_delete_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_delete_question | L14-qbank | no-scenario | 24/0 |  | scenario exists, A/B not run |
| qbank_export_document | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_export_paper_docx | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_export_portable | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_generate_mock_exam | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_generate_paper | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_activity_heatmap | L14-qbank | no-scenario | 13/0 |  | scenario exists, A/B not run |
| qbank_get_check_in_calendar | L14-qbank | no-scenario | 16/0 |  | scenario exists, A/B not run |
| qbank_get_daily_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_generation_task | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_history | L14-qbank | no-scenario | 11/0 |  | scenario exists, A/B not run |
| qbank_get_knowledge_stats_with_comparison | L14-qbank | no-scenario | 8/0 |  | scenario exists, A/B not run |
| qbank_get_learning_trend | L14-qbank | no-scenario | 15/0 |  | scenario exists, A/B not run |
| qbank_get_paper | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_question | L14-qbank | no-scenario | 33/0 |  | scenario exists, A/B not run |
| qbank_get_source_images | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_get_stats | L14-qbank | no-scenario | 20/0 |  | scenario exists, A/B not run |
| qbank_grade_practice_manually | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_legacy_audit | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_legacy_migrate_selected | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_list_authoring_drafts | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_list_generation_tasks | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_list_mistakes | L14-qbank | no-scenario | 6/0 |  | scenario exists, A/B not run |
| qbank_list_papers | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_list_practices | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_list_questions | L14-qbank | no-scenario | 16/0 |  | scenario exists, A/B not run |
| qbank_list_structure | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_rebuild_fts_index | L14-qbank | no-scenario | 3/0 |  | scenario exists, A/B not run |
| qbank_refresh_stats | L14-qbank | no-scenario | 3/0 |  | scenario exists, A/B not run |
| qbank_reparse_report | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_reparse_resolve | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_reset_progress | L14-qbank | no-scenario | 4/0 |  | scenario exists, A/B not run |
| qbank_reset_questions_progress | L14-qbank | no-scenario | 5/0 |  | scenario exists, A/B not run |
| qbank_resolve_authoring_route | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_resume_practice_grading | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_retry_practice_grading | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_save_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_search_questions | L14-qbank | no-scenario | 28/0 |  | scenario exists, A/B not run |
| qbank_start_timed_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_submit_answer | L14-qbank | no-scenario | 97/0 |  | scenario exists, A/B not run |
| qbank_submit_mock_exam | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_submit_practice | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_toggle_favorite | L14-qbank | no-scenario | 5/0 |  | scenario exists, A/B not run |
| qbank_update_group | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_update_material | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_update_paper | L14-qbank | no-scenario | 0/0 |  | no scenario |
| qbank_update_question | L14-qbank | no-scenario | 24/0 |  | scenario exists, A/B not run |
| quick_assistant_apply_enabled | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| quick_assistant_hide | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| quick_assistant_show | L17-memory-research | no-scenario | 0/0 |  | no scenario |
| read_anki_media | L16-anki | no-scenario | 0/0 |  | no scenario |
| read_file_bytes | F2-shell | no-scenario | 0/0 |  | no scenario |
| read_file_text | F2-shell | no-scenario | 1/0 |  | scenario exists, A/B not run |
| rebuild_chat_fts | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| recover_stuck_document_tasks | L16-anki | no-scenario | 0/0 |  | no scenario |
| reload_mcp_client | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| remove_ocr_engine | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| report_frontend_log | F4-security | no-scenario | 0/0 |  | no scenario |
| resolve_startup_recovery | F3-storage | no-scenario | 0/0 |  | no scenario |
| restart_app | F3-storage | no-scenario | 0/0 |  | no scenario |
| resume_document_processing | L16-anki | no-scenario | 0/0 |  | no scenario |
| resume_question_import | L14-qbank | no-scenario | 0/0 |  | no scenario |
| review_plan_batch_create | L15-review-analytics | no-scenario | 1/0 |  | scenario exists, A/B not run |
| review_plan_create | L15-review-analytics | no-scenario | 15/0 |  | scenario exists, A/B not run |
| review_plan_create_for_exam | L15-review-analytics | no-scenario | 1/0 |  | scenario exists, A/B not run |
| review_plan_delete | L15-review-analytics | no-scenario | 4/0 |  | scenario exists, A/B not run |
| review_plan_get_by_question | L15-review-analytics | no-scenario | 7/0 |  | scenario exists, A/B not run |
| review_plan_get_calendar_data | L15-review-analytics | no-scenario | 1/0 |  | scenario exists, A/B not run |
| review_plan_get_due | L15-review-analytics | no-scenario | 6/0 |  | scenario exists, A/B not run |
| review_plan_get_due_with_filter | L15-review-analytics | no-scenario | 3/0 |  | scenario exists, A/B not run |
| review_plan_get_history | L15-review-analytics | no-scenario | 7/0 |  | scenario exists, A/B not run |
| review_plan_get_or_create | L15-review-analytics | no-scenario | 5/0 |  | scenario exists, A/B not run |
| review_plan_get_stats | L15-review-analytics | no-scenario | 9/0 |  | scenario exists, A/B not run |
| review_plan_list_by_exam | L15-review-analytics | no-scenario | 3/0 |  | scenario exists, A/B not run |
| review_plan_process | L15-review-analytics | no-scenario | 10/0 |  | scenario exists, A/B not run |
| review_plan_refresh_stats | L15-review-analytics | no-scenario | 3/0 |  | scenario exists, A/B not run |
| review_plan_resume | L15-review-analytics | no-scenario | 5/0 |  | scenario exists, A/B not run |
| review_plan_suspend | L15-review-analytics | no-scenario | 7/0 |  | scenario exists, A/B not run |
| revoke_mcp_oauth | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| save_anki_cards | L16-anki | no-scenario | 57/0 |  | scenario exists, A/B not run |
| save_api_configurations | L02-llm-manager | no-scenario | 158/0 |  | scenario exists, A/B not run |
| save_available_ocr_models | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| save_model_assignments | L02-llm-manager | no-scenario | 138/0 |  | scenario exists, A/B not run |
| save_model_profiles | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| save_provider_strategies_config | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| save_setting | L19-mcp-browser | no-scenario | 44/0 |  | scenario exists, A/B not run |
| save_text_to_file | F2-shell | no-scenario | 21/0 |  | scenario exists, A/B not run |
| save_vendor_configs | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| save_webview_settings | F2-shell | no-scenario | 0/0 |  | no scenario |
| secure_clear_cloud_encryption_password | F4-security | no-scenario | 4/0 |  | scenario exists, A/B not run |
| secure_delete_cloud_credentials | F4-security | no-scenario | 4/0 |  | scenario exists, A/B not run |
| secure_get_cloud_credentials | F4-security | no-scenario | 46/0 |  | scenario exists, A/B not run |
| secure_save_cloud_credentials | F4-security | no-scenario | 37/0 |  | scenario exists, A/B not run |
| secure_store_is_available | F4-security | no-scenario | 4/0 |  | scenario exists, A/B not run |
| set_android_immersive_mode | F2-shell | no-scenario | 0/0 |  | no scenario |
| set_backup_config | F4-security | no-scenario | 18/0 |  | scenario exists, A/B not run |
| set_default_template | L16-anki | no-scenario | 0/0 |  | no scenario |
| set_document_session_source | L16-anki | no-scenario | 0/0 |  | no scenario |
| set_mcp_stdio_allow_unapproved | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| set_ocr_thinking_enabled | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| set_prevent_sleep | F2-shell | no-scenario | 0/0 |  | no scenario |
| set_sidebar_vibrancy | F2-shell | no-scenario | 0/0 |  | no scenario |
| set_window_appearance | F2-shell | no-scenario | 0/0 |  | no scenario |
| skill_check_updates | L07-agent-skills-ptc | no-scenario | 2/0 |  | scenario exists, A/B not run |
| skill_create | L07-agent-skills-ptc | no-scenario | 14/0 |  | scenario exists, A/B not run |
| skill_delete | L07-agent-skills-ptc | no-scenario | 2/0 |  | scenario exists, A/B not run |
| skill_export_tap | L07-agent-skills-ptc | no-scenario | 2/0 |  | scenario exists, A/B not run |
| skill_import_zip | L07-agent-skills-ptc | no-scenario | 2/0 |  | scenario exists, A/B not run |
| skill_list_directories | L07-agent-skills-ptc | no-scenario | 9/0 |  | scenario exists, A/B not run |
| skill_list_package_files | L07-agent-skills-ptc | no-scenario | 2/0 |  | scenario exists, A/B not run |
| skill_market_download_and_scan | L07-agent-skills-ptc | no-scenario | 0/0 |  | no scenario |
| skill_market_search | L07-agent-skills-ptc | no-scenario | 0/0 |  | no scenario |
| skill_market_skill_detail | L07-agent-skills-ptc | no-scenario | 0/0 |  | no scenario |
| skill_market_verify | L07-agent-skills-ptc | no-scenario | 0/0 |  | no scenario |
| skill_probe_requires | L07-agent-skills-ptc | no-scenario | 4/0 |  | scenario exists, A/B not run |
| skill_read_file | L07-agent-skills-ptc | no-scenario | 7/0 |  | scenario exists, A/B not run |
| skill_tap_catalog | L07-agent-skills-ptc | no-scenario | 1/0 |  | scenario exists, A/B not run |
| skill_tap_install | L07-agent-skills-ptc | no-scenario | 1/0 |  | scenario exists, A/B not run |
| skill_update | L07-agent-skills-ptc | no-scenario | 1/0 |  | scenario exists, A/B not run |
| skill_update_from_source | L07-agent-skills-ptc | no-scenario | 1/0 |  | scenario exists, A/B not run |
| staged_upload_abort | F3-storage | no-scenario | 0/0 |  | no scenario |
| staged_upload_append | F3-storage | no-scenario | 4/0 |  | scenario exists, A/B not run |
| staged_upload_begin | F3-storage | no-scenario | 4/0 |  | scenario exists, A/B not run |
| staged_upload_from_path | F3-storage | no-scenario | 0/0 |  | no scenario |
| start_enhanced_document_processing | L16-anki | no-scenario | 0/0 |  | no scenario |
| start_mcp_oauth | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| study_time_add | L15-review-analytics | no-scenario | 0/0 |  | no scenario |
| super_session_ensure | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| super_session_get_settings | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| super_session_get_state | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| super_session_set_enabled | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| super_session_set_settings | L06-agent-orchestration | no-scenario | 0/0 |  | no scenario |
| sync_titlebar_sidebar_material | F2-shell | no-scenario | 0/0 |  | no scenario |
| tauri_lab_frontend_log | F4-security | no-scenario | 0/0 |  | no scenario |
| test_all_search_engines | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_api_connection | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| test_mcp_connection | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_mcp_http | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_mcp_sse | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_mcp_websocket | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_ocr_engine | L18-media-docs | no-scenario | 2/0 |  | scenario exists, A/B not run |
| test_search_engine | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| test_web_search_connectivity | L19-mcp-browser | no-scenario | 0/0 |  | no scenario |
| textbooks_add | L18-media-docs | no-scenario | 9/0 |  | scenario exists, A/B not run |
| textbooks_relink | L18-media-docs | no-scenario | 2/0 |  | scenario exists, A/B not run |
| textbooks_update_bookmarks | L18-media-docs | no-scenario | 2/0 |  | scenario exists, A/B not run |
| toggle_devtools | F4-security | no-scenario | 0/0 |  | no scenario |
| translate_text_stream | L02-llm-manager | no-scenario | 0/0 |  | no scenario |
| trigger_task_processing | L16-anki | no-scenario | 0/0 |  | no scenario |
| tts_check_available | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| tts_speak | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| tts_stop | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| update_anki_card | L16-anki | no-scenario | 1/0 |  | scenario exists, A/B not run |
| update_custom_template | L16-anki | no-scenario | 0/0 |  | no scenario |
| update_exam_sheet_cards | L14-qbank | no-scenario | 0/0 |  | no scenario |
| update_ocr_engine_priority | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| updater_install_supported | F2-shell | no-scenario | 0/0 |  | no scenario |
| vfs_assign_dimension_model | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_batch_index_pending | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_cancel_pdf_processing | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_clear_default_embedding_dimension | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_clear_media_cache | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_clear_resource_ocr | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_create_attachment_root_folder | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_create_dimension | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_create_or_reuse | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_debug_index_status | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_decrement_ref | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_delete_attachment | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_delete_dimension | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_delete_file | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_delete_resource_index | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_diagnose_lance_schema | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_download_paper | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_all_index_status | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_attachment | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_attachment_config | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_attachment_content | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_blob_base64 | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_default_embedding_dimension | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_dimension_range | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_embedding_readiness | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_file | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_file_blob_path | L18-media-docs | no-scenario | 4/0 |  | scenario exists, A/B not run |
| vfs_get_file_content | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_lance_stats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_media_cache_stats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_pdf_page_image | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_pdf_processing_status | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_preset_dimensions | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_ocr_info | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_path | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_ref_count | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_refs | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_text_chunks | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_get_resource_units | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_increment_ref | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_inspect_retrieval_capabilities | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_list_dimensions | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_list_embedding_dims | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_list_files | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_delete | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_index | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_index_resource | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_search | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_search_detailed | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_multimodal_stats | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_optimize_lance | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_rag_search | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_reindex_resource | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_reindex_unit | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_reset_all_index_state | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_reset_disabled_to_pending | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_reset_indexed_without_embeddings | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_resolve_resource_refs | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_resource_exists | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_retry_pdf_processing | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_set_attachment_root_folder | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_set_default_embedding_dimension | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_start_pdf_processing | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_sync_resource_units | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_unified_batch_index | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_unified_index_status | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_update_path_cache | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_upload_attachment | L13-vfs-api | no-scenario | 0/0 |  | no scenario |
| vfs_upload_file | L13-vfs-api | no-scenario | 4/0 |  | scenario exists, A/B not run |
| voice_input_transcribe | L18-media-docs | no-scenario | 0/0 |  | no scenario |
| workspace_cancel_agent | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_cancel_sleep | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_close | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_create | L04-chat-session | no-scenario | 5/0 |  | scenario exists, A/B not run |
| workspace_create_agent | L04-chat-session | no-scenario | 5/0 |  | scenario exists, A/B not run |
| workspace_delete | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_delete_agent_profile_file | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_get | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_get_context | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_get_document | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_list_agent_profiles | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_list_agents | L04-chat-session | no-scenario | 2/0 |  | scenario exists, A/B not run |
| workspace_list_all | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_list_documents | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_list_messages | L04-chat-session | no-scenario | 2/0 |  | scenario exists, A/B not run |
| workspace_manual_wake | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_read_agent_profile_file | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_restore_executions | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_run_agent | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| workspace_send_message | L04-chat-session | no-scenario | 1/0 |  | scenario exists, A/B not run |
| workspace_set_context | L04-chat-session | no-scenario | 0/0 |  | no scenario |
| write_debug_logs | F4-security | no-scenario | 0/0 |  | no scenario |
