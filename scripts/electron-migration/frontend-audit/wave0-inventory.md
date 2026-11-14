# WAVE0 前端可达命令 → owner → 场景清单

前端/契约/注册基线 = 固定 main `e1204ee8a02f1cfb3255fb1a75bb234c72236ce9`；扫描提交 `b5532109fa572b4dfed84196ebfb9d25aadb2c1c`（与基线只差 X2 自有文件，工具启动时校验；工作树 dirty）。生成器 `scripts/electron-migration/frontend-audit/inventory.ts`，机器可读件 `wave0-inventory.json`。

边界：静态 AST + 运行时 meta 探针（不 apply）。`registration.level` 只区分声明/静态注册证据，`differential` 恒为 `not-run`；场景存在不等于 G3 充分性（Rust 80% 行覆盖与可达 Err 点需运行器证据）。

可达口径：`callers` 是生产 src 中真正发出 invoke 的 AST 位置（固定命令的 API 封装在其内部计一次），不证明有 UI 调用该封装方法。例：`pluginsApi.start/stop/logout`（src/features/settings/api/pluginsApi.ts:57/58/67）在 src 中没有任何引用，仍按 invoke 点计入 `plugin_start/plugin_stop/plugin_logout`。

限制：本域/种子是启发式（文件 `commands[]` 的严格多数 owner lane），不是“目标命令/前置步骤”的作者证据。作者在 `commands[]` 中列为目标的命令另记 `declaredTargetIds`，`declaredTargetNotDomain=true` 表示作者把它列为目标、启发式却判为种子或跨 owner；两者并列，启发式不覆盖作者说明。`commands[]` 本身可能含辅助命令（见各 lane README），`declaredTargetIds` 只是作者列名，不等于已人工证明的目标充分性。

本快照 declaredTargetNotDomain（26，场景按 id 前两段归组；作者 `commands[]` 可能列入他域辅助/种子命令，是否目标须看该 lane README）：`chat_v2_create_session`（owner L04-chat-session；128 场景：chatanki.card, chatanki.library, chatanki.template）；`chat_v2_send_message`（owner L04-chat-session；128 场景：chatanki.card, chatanki.library, chatanki.template）；`chat_v2_tool_approval_respond`（owner L04-chat-session；27 场景：chatanki.library, chatanki.template）；`cloud_config_publish`（owner F4-security；14 场景：cloud.s3, cloud.webdav）；`cloud_config_ssot_save`（owner F4-security；15 场景：sync_support.prune_gap, sync_support.run_sync, sync_support.run_sync_progress, sync_support.tombstone）；`create_custom_template`（owner L16-anki；30 场景：chatanki.template）；`delete_anki_card`（owner L16-anki；1 场景：review.deleted-card）；`delete_document_session`（owner L16-anki；1 场景：review.deleted-document）；`dstu_create`（owner L13-vfs-api；9 场景：review.plan）；`dstu_folder_create`（owner L13-vfs-api；8 场景：sync.local）；`dstu_folder_rename`（owner L13-vfs-api；5 场景：sync.local）；`fsrs_enqueue_cards`（owner L15-review-analytics；1 场景：anki.sessions）；`fsrs_rate`（owner L15-review-analytics；1 场景：anki.sessions）；`get_all_custom_templates`（owner L16-anki；25 场景：chatanki.template）；`get_setting`（owner L19-mcp-browser；16 场景：integration.temp_session）；`list_anki_library_cards`（owner L16-anki；27 场景：chatanki.card, chatanki.library）；`qbank_batch_create_questions`（owner L14-qbank；2 场景：review.plan）；`qbank_create_question`（owner L14-qbank；7 场景：review.plan）；`qbank_delete_question`（owner L14-qbank；2 场景：review.plan）；`save_anki_cards`（owner L16-anki；57 场景：chatanki.card, chatanki.library, review.deleted-card, review.deleted-document, review.diagnostic, review.due, review.enqueue, review.mastery, review.rate, review.reset, review.schedule, review.suspend, review.undo）；`save_api_configurations`（owner L02-llm-manager；133 场景：chat-pipeline.workspace, chatanki.card, chatanki.library, chatanki.template）；`save_model_assignments`（owner L02-llm-manager；128 场景：chatanki.card, chatanki.library, chatanki.template）；`save_setting`（owner L19-mcp-browser；4 场景：integration.temp_session, skills.check_updates, skills.update_from_source）；`save_text_to_file`（owner F2-shell；7 场景：sync.local）；`secure_save_cloud_credentials`（owner F4-security；10 场景：sync_support.prune_gap, sync_support.run_sync, sync_support.run_sync_progress, sync_support.tombstone）；`update_anki_card`（owner L16-anki；1 场景：review.diagnostic）。

owner 取契约 lane，Host 实际注册插件见 `owner.plugins`，不改契约：`save_setting` owner L19-mcp-browser（contract），注册插件 dstu.browser；`get_setting` owner L19-mcp-browser（contract），注册插件 dstu.browser。

场景口径：只有 steps 中出现才算；文件的 domain = 其 `commands[]` 归属 lane 的严格多数，其他 lane 命令的步骤记为 `seedIds`（种子/观察），不计该命令覆盖，`missing` 仍为 true。`errorOnly` = 本域步骤全为 `expect:"error"`，缺成功场景。语料 = 固定 main 基线的 equivalence 文件 + 各候选 tip 自己改动的文件（相对其与基线的 merge-base，只读 git show）；候选继承的旧文件不读，候选不计作 main。均未在 A/B 运行。

## 计数

| 指标 | 数量 |
|---|---:|
| productionInvokeSites | 1446 |
| productionCommands | 981 |
| kind.no-rust-definition | 59 |
| kind.plugin-or-platform | 4 |
| kind.rust-contract | 918 |
| registration.kernel-registration | 2 |
| registration.meta+conditional-register | 1 |
| registration.meta+static-register | 869 |
| registration.meta-only | 45 |
| registration.none | 59 |
| registration.off-profile-declared | 3 |
| registration.shell-route-static | 2 |
| withScenario | 277 |
| withScenarioOnMain | 18 |
| withScenarioCandidateOnly | 259 |
| missingScenario | 704 |
| scenarioNestedOnly | 1 |
| scenarioSuccessStep | 263 |
| scenarioErrorOnly | 14 |
| scenarioSeedOnly | 15 |
| scenarioDeclaredTargetNotDomain | 26 |
| rust.cfg-gated | 6 |
| rust.not-in-generate_handler | 2 |
| rust.registered | 910 |
| rust.unknown | 63 |
| ownerUnknown | 59 |
| rustHandlerUnknown | 63 |
| dynamicSites | 1 |
| testOnlyCommands | 1 |
| demoOnlyCommands | 0 |
| corpusFiles | 64 |
| corpusFromMain | 7 |
| corpusCandidateNew | 59 |
| corpusCandidateModifiesMain | 0 |
| corpusCandidatesWithoutOwnFiles | 2 |
| corpusTopFiles | 52 |
| corpusAuxiliaryFiles | 2 |
| corpusScenarios | 1444 |
| corpusSteps | 7179 |
| corpusStepCommandsWithoutFrontendCaller | 6 |
| hostLoadFailed | 0 |
| differentialRun | 0 |
| problems | 886 |
| problem.dynamic-command-unresolved | 1 |
| problem.host-registration-unproven | 63 |
| problem.owner-unknown | 59 |
| problem.scenario-missing | 704 |
| problem.scenario-step-undeclared | 45 |
| problem.scenario-success-missing | 14 |

## 与方案 765 的差异

方案 765 来自 inventory.mjs 字面量正则（含测试/demo）；当前契约 frontend=app 标记 768 条，本扫描生产可达且有 Rust 契约 918 条。不凑数。

- 新增（AST 展开封装/常量/命令表后可达，契约 frontend 标记未标 app，属 inventory.mjs 字面量正则的抽取缺口，不手改生成契约）150：`browser_back`、`browser_close`、`browser_focus`、`browser_forward`、`browser_get_state`、`browser_get_surface_host_mode`、`browser_list_downloads`、`browser_navigate`、`browser_open_session`、`browser_release_surface_focus`、`browser_reload`、`browser_set_input_files`、`browser_set_surface_bounds`、`browser_set_surface_visibility`、`browser_take_over`、`chat_v2_emergency_stop`、`chat_v2_get_tags_batch`、`chat_v2_kill_switch_status`、`chat_v2_list_agent_sessions`、`chat_v2_record_skill_activation`、`chat_v2_resume_agents`、`chat_v2_resume_automations`、`chat_v2_set_permission_preset`、`check_test_dependencies`、`clear_debug_logs`、`ensure_debug_log_dir`、`estimate_tokens`、`export_unified_backup_data`、`fetch_vendor_models`、`fsrs_bury_card`、`fsrs_unbury_card`、`get_csv_exportable_fields`、`get_database_info`、`get_debug_logs_info`、`get_exam_sheet_session_detail`、`get_mcp_tools`、`get_pending_memory_candidates`、`get_startup_recovery_status`、`insight_add_relation`、`insight_confirm`、`insight_correct`、`insight_create_draft`、`insight_delete`、`insight_get`、`insight_list`、`insight_list_evidence`、`insight_list_relations`、`insight_list_revisions`、`insight_record_feedback`、`insight_run_jobs`、`is_feature_enabled`、`list_exam_sheet_sessions`、`list_importing_sessions`、`list_startup_recovery_incidents`、`media_bilibili_bridge_approve`、`media_bilibili_bridge_disconnect`、`media_bilibili_bridge_pair`、`media_bilibili_transport_configure`、`notes_editor_flush`、`notes_get_backlinks`、`notes_get_outgoing_links`、`notes_migrate_blocks`、`notes_transfer_blocks`、`notes_undo_transfer`、`open_logs_folder`、`open_system_permission_settings`、`openai_codex_login_cancel`、`openai_codex_login_start`、`openai_codex_logout`、`openai_codex_usage`、`opencode_go_get_usage`、`optimize_chat_embeddings_table`、`pomodoro_stats_overview`、`pomodoro_todo_focus_summary`、`qbank_count_by_type`、`qbank_get_authoring_draft`、`qbank_get_source_page`、`read_debug_log_file`、`rename_exam_sheet_session`、`reset_test_database`、`retry_startup_recovery_preflight`、`secure_store_get_keystore_protection`、`secure_store_set_keystore_protection`、`seed_test_database`、`set_backend_sentry_enabled`、`set_test_run_id`、`stream_chat_translation_aligned`、`stream_chat_translation_plain`、`study_time_range`、`switch_to_production_database`、`switch_to_test_database`、`test_pdfium_status`、`todo_ai_breakdown`、`todo_batch_complete`、`todo_batch_delete`、`todo_batch_move`、`todo_batch_purge`、`todo_batch_reschedule`、`todo_batch_restore`、`todo_batch_set_priority`、`todo_counts_snapshot`、`todo_create_item`、`todo_create_list`、`todo_delete_item`、`todo_delete_list`、`todo_ensure_inbox`、`todo_get_active_summary`、`todo_get_item`、`todo_get_list`、`todo_list_all_pending`、`todo_list_all_tags`、`todo_list_completed`、`todo_list_deleted_items`、`todo_list_deleted_lists`、`todo_list_items`、`todo_list_items_with_stats`、`todo_list_lists`、`todo_list_overdue`、`todo_list_reminders`、`todo_list_today`、`todo_list_upcoming`、`todo_move_item`、`todo_purge_deleted_items`、`todo_purge_deleted_lists`、`todo_purge_item`、`todo_purge_list`、`todo_reorder_items`、`todo_reorder_lists`、`todo_restore_item`、`todo_restore_list`、`todo_search`、`todo_stats_overview`、`todo_toggle_item`、`todo_toggle_list_favorite`、`todo_trash_counts`、`todo_update_item`、`todo_update_list`、`vfs_create_mindmap`、`vfs_delete_mindmap`、`vfs_get_batch_pdf_processing_status`、`vfs_get_mindmap`、`vfs_get_mindmap_content`、`vfs_get_mindmap_version`、`vfs_get_mindmap_version_content`、`vfs_get_mindmap_versions`、`vfs_list_mindmaps`、`vfs_restore_mindmap_version`、`vfs_set_mindmap_favorite`、`vfs_update_mindmap`、`workspace_save_agent_profile_file`
- 消失（契约标 app、生产 src 无可达调用点）0：无
- 动态未展开调用点 1：见下文。

## 旧 4 条未注册复核（当前 SHA 证据）

Rust 列 = `src-tauri/src/lib.rs` 唯一 `generate_handler!` 是否列出；B 列 = Host 官方 desktop profile 证据。Host 插件里存在实现不等于 B 官方可调用。

| 命令 | 调用点 | owner | Rust 定义 | Rust 注册 | B 注册证据 | 说明 |
|---|---|---|---|---|---|---|
| get_auto_backup_status | src/api/dataGovernance.ts:207 | F4-security（contract） | src-tauri/src/backup_config.rs:231 | not-in-generate_handler | off-profile-declared | Host 插件 dstu.platform.backup-config（host/platform/settings/backup-commands.ts）有实现，但不在 host/profiles/desktop.json，B 官方不可调 |
| get_backup_config | src/api/dataGovernance.ts:195 | F4-security（contract） | src-tauri/src/backup_config.rs:115 | registered | off-profile-declared | Host 插件 dstu.platform.backup-config（host/platform/settings/backup-commands.ts）有实现，但不在 host/profiles/desktop.json，B 官方不可调 |
| set_backup_config | src/api/dataGovernance.ts:203 | F4-security（contract） | src-tauri/src/backup_config.rs:121 | registered | off-profile-declared | Host 插件 dstu.platform.backup-config（host/platform/settings/backup-commands.ts）有实现，但不在 host/profiles/desktop.json，B 官方不可调 |
| chat_v2_super_deliver_inbox | src/features/chat/adapters/tauri/sendOperations.ts:329 | L06-agent-orchestration（contract） | src-tauri/crates/dstu-agent/src/chat_v2/super_session/commands.rs:58 | registered | meta+conditional-register | host/plugins/agent-orchestration/index.ts:569 仅在 inject([SEND_MESSAGE_PIPELINE_SERVICE]) 时注册 |

## 场景语料来源

基线 main `e1204ee8a` 提供 7 个文件（含无 `commands[]` 的辅助文件）。候选 tip 只读自有改动；继承文件（与 merge-base 相同）跳过，不覆盖他人语料。

| 候选 | tip | 自有 equivalence 文件 | 实际读入 | 跳过的继承文件 |
|---|---|---:|---:|---:|
| F4-security | `606bf4959` | 5 | 5 | 2 |
| L01-llm-providers | `dad7211e5` | 1 | 1 | 2 |
| L02-llm-manager | `4a26ae8d3` | 无新增 | 0 | 2 |
| L04-chat-session | `0bf6e313e` | 2 | 2 | 2 |
| L06-agent-orchestration | `eef275701` | 2 | 2 | 7 |
| L07-agent-skills-ptc | `e13c2ad16` | 3 | 3 | 2 |
| L10-notes | `7d4f68c07` | 2 | 2 | 2 |
| L13-vfs-api | `303fbc2d5` | 2 | 2 | 2 |
| L13b-vfs-handlers | `0cf0d8d9d` | 1 | 1 | 2 |
| L14-qbank | `a8f856ddb` | 5 | 5 | 3 |
| L15-review-analytics | `50c3b67f9` | 4 | 4 | 2 |
| L16-anki | `df37dca8b` | 4 | 4 | 7 |
| L17-memory-research | `8226b0ec1` | 3 | 3 | 3 |
| L18-media-docs | `ee5c43271` | 4 | 4 | 3 |
| L19-mcp-browser | `8a761e118` | 无新增 | 0 | 0 |
| L20-sync | `fb98daa36` | 1 | 1 | 0 |
| L20b-sync-support | `58f68140f` | 1 | 1 | 0 |
| L21-backup-governance | `e2b578e74` | 16 | 16 | 3 |
| L22-app-commands | `6286339cd` | 2 | 2 | 2 |
| L23-sync-providers | `af9676afc` | 1 | 1 | 7 |

## 场景语料对账

| 文件 | 来源 | 与 main | 层级 | domain lane | 场景 | 步骤 | 本域命令 | 种子/观察命令 | 无前端调用点的步骤命令 |
|---|---|---|---|---|---:|---:|---:|---|---|
| host/kernel/equivalence/plugins-seeded.json | main `e1204ee8a` | 同 main | top | F1-kernel | 17 | 102 | 10 | get_setting、save_setting | - |
| host/kernel/equivalence/plugins.json | main `e1204ee8a` | 同 main | top | F1-kernel | 34 | 83 | 11 | - | - |
| host/platform/settings/equivalence/backup-config.json | 候选 F4-security `606bf4959` | main 无此文件 | top | F4-security | 32 | 89 | 2 | save_setting | - |
| host/platform/settings/equivalence/cloud-config.json | 候选 F4-security `606bf4959` | main 无此文件 | top | F4-security | 51 | 229 | 7 | - | - |
| host/platform/settings/equivalence/keystore-protection.json | 候选 F4-security `606bf4959` | main 无此文件 | top | F4-security | 5 | 17 | 5 | - | - |
| host/platform/settings/equivalence/platform-gated/keystore-enable.json | 候选 F4-security `606bf4959` | main 无此文件 | platform-gated | F4-security | 2 | 10 | 5 | - | - |
| host/platform/settings/equivalence/secure-credentials.json | 候选 F4-security `606bf4959` | main 无此文件 | top | F4-security | 26 | 90 | 7 | - | - |
| host/plugins/agent-orchestration/equivalence/automations.json | 候选 L06-agent-orchestration `eef275701` | main 无此文件 | top | L06-agent-orchestration | 242 | 560 | 11 | chat_v2_emergency_stop、chat_v2_resume_agents、chat_v2_resume_automations | - |
| host/plugins/agent-orchestration/equivalence/super-session.json | 候选 L06-agent-orchestration `eef275701` | main 无此文件 | top | L06-agent-orchestration | 41 | 83 | 6 | chat_v2_create_session、chat_v2_emergency_stop、chat_v2_resume_agents、chat_v2_resume_automations、workspace_send_message | - |
| host/plugins/agent-skills/equivalence/skill-candidates.json | 候选 L07-agent-skills-ptc `e13c2ad16` | main 无此文件 | top | L07-agent-skills-ptc | 11 | 161 | 9 | - | chat_v2_list_skill_candidates、chat_v2_promote_skill_candidate、chat_v2_replay_skill_candidate、chat_v2_rollback_skill_candidate |
| host/plugins/agent-skills/equivalence/skill-updates.json | 候选 L07-agent-skills-ptc `e13c2ad16` | main 无此文件 | top | L07-agent-skills-ptc | 3 | 52 | 2 | save_setting | - |
| host/plugins/agent-skills/equivalence/skills-local.json | 候选 L07-agent-skills-ptc `e13c2ad16` | main 无此文件 | top | L07-agent-skills-ptc | 17 | 126 | 11 | - | - |
| host/plugins/agent-workspace/equivalence/inbox-recovery.json | main `e1204ee8a` | 同 main | top | L04-chat-session | 2 | 8 | 3 | - | - |
| host/plugins/anki/equivalence/cards-crud.json | 候选 L16-anki `df37dca8b` | main 无此文件 | top | L16-anki | 7 | 124 | 13 | - | - |
| host/plugins/anki/equivalence/document-sessions.json | 候选 L16-anki `df37dca8b` | main 无此文件 | top | L16-anki | 8 | 131 | 14 | fsrs_enqueue_cards、fsrs_rate | - |
| host/plugins/anki/equivalence/templates-crud.json | 候选 L16-anki `df37dca8b` | main 无此文件 | top | L16-anki | 13 | 122 | 8 | - | - |
| host/plugins/anki/equivalence/templates-import.json | 候选 L16-anki `df37dca8b` | main 无此文件 | top | L16-anki | 11 | 74 | 7 | - | - |
| host/plugins/backup/equivalence/assets.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 2 | 29 | 2 | - | - |
| host/plugins/backup/equivalence/audit.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 7 | 73 | 2 | - | - |
| host/plugins/backup/equivalence/diagnostics.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 4 | 27 | 4 | - | - |
| host/plugins/backup/equivalence/import.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 4 | 39 | 3 | - | - |
| host/plugins/backup/equivalence/inventory.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 5 | 69 | 5 | - | - |
| host/plugins/backup/equivalence/jobs.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 3 | 23 | 5 | - | - |
| host/plugins/backup/equivalence/metadata.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | top | L21-backup-governance | 2 | 6 | 2 | - | - |
| host/plugins/backup/equivalence/pending-runner/audit-cleanup-token.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-runner | L21-backup-governance | 11 | 32 | 2 | - | - |
| host/plugins/backup/equivalence/pending-runner/import-job-lifecycle.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-runner | L21-backup-governance | 4 | 38 | 12 | - | - |
| host/plugins/backup/equivalence/pending-seed/assets-seeded.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 5 | 18 | 1 | - | - |
| host/plugins/backup/equivalence/pending-seed/audit-seeded.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 2 | 25 | 1 | - | - |
| host/plugins/backup/equivalence/pending-seed/diagnostics-seeded.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 2 | 9 | 4 | - | - |
| host/plugins/backup/equivalence/pending-seed/historical-zip.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 2 | 12 | 6 | - | - |
| host/plugins/backup/equivalence/pending-seed/inventory-seeded.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 5 | 34 | 5 | - | - |
| host/plugins/backup/equivalence/pending-seed/jobs-persisted.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 2 | 18 | 6 | - | - |
| host/plugins/backup/equivalence/pending-seed/metadata-seeded.json | 候选 L21-backup-governance `e2b578e74` | main 无此文件 | pending-seed | L21-backup-governance | 2 | 4 | 2 | - | - |
| host/plugins/chat-pipeline/equivalence/workspace.json | main `e1204ee8a` | 同 main | top | L04-chat-session | 5 | 28 | 4 | save_api_configurations | - |
| host/plugins/chat/equivalence/messages.json | 候选 L04-chat-session `0bf6e313e` | main 无此文件 | top | L04-chat-session | 10 | 163 | 14 | - | - |
| host/plugins/chat/equivalence/sessions.json | 候选 L04-chat-session `0bf6e313e` | main 无此文件 | top | L04-chat-session | 14 | 184 | 16 | - | - |
| host/plugins/chatanki/equivalence/library-cards.json | main `e1204ee8a` | 同 main | top | 无多数（跨 owner：7 条，不计覆盖） | 42 | 274 | 0 | - | - |
| host/plugins/chatanki/equivalence/templates.json | main `e1204ee8a` | 同 main | top | 无多数（跨 owner：7 条，不计覆盖） | 86 | 405 | 0 | - | - |
| host/plugins/integration/equivalence/pending-seed/temp-sessions.seeded.json | 候选 L22-app-commands `6286339cd` | main 无此文件 | pending-seed | L18-media-docs | 21 | 59 | 2 | get_setting | pin_images、unpin_images |
| host/plugins/integration/equivalence/temp-sessions.json | 候选 L22-app-commands `6286339cd` | main 无此文件 | top | 无多数（跨 owner：4 条，不计覆盖） | 13 | 26 | 0 | - | pin_images、unpin_images |
| host/plugins/llm-providers/equivalence/codex-auth.json | 候选 L01-llm-providers `dad7211e5` | main 无此文件 | top | L01-llm-providers | 12 | 60 | 5 | - | - |
| host/plugins/media/equivalence/documents-parse.json | 候选 L18-media-docs `ee5c43271` | main 无此文件 | top | L18-media-docs | 7 | 55 | 1 | - | - |
| host/plugins/media/equivalence/media-transcripts.json | 候选 L18-media-docs `ee5c43271` | main 无此文件 | top | L18-media-docs | 4 | 52 | 5 | get_app_data_dir、read_file_text、save_text_to_file、vfs_upload_file | - |
| host/plugins/media/equivalence/ocr-handout-heic.json | 候选 L18-media-docs `ee5c43271` | main 无此文件 | top | L18-media-docs | 4 | 18 | 3 | - | - |
| host/plugins/media/equivalence/textbooks-files.json | 候选 L18-media-docs `ee5c43271` | main 无此文件 | top | L18-media-docs | 14 | 115 | 6 | get_app_data_dir、save_text_to_file | - |
| host/plugins/memory/equivalence/memory-config.json | 候选 L17-memory-research `8226b0ec1` | main 无此文件 | top | L17-memory-research | 19 | 99 | 9 | - | - |
| host/plugins/memory/equivalence/memory-crud.json | 候选 L17-memory-research `8226b0ec1` | main 无此文件 | top | L17-memory-research | 42 | 285 | 16 | - | - |
| host/plugins/memory/equivalence/memory-relations-tags.json | 候选 L17-memory-research `8226b0ec1` | main 无此文件 | top | L17-memory-research | 13 | 95 | 9 | - | - |
| host/plugins/notes/equivalence/history.json | 候选 L10-notes `7d4f68c07` | main 无此文件 | top | L10-notes | 10 | 180 | 10 | dstu_create、dstu_delete | - |
| host/plugins/notes/equivalence/lease.json | 候选 L10-notes `7d4f68c07` | main 无此文件 | top | L10-notes | 10 | 215 | 15 | dstu_create、dstu_delete | - |
| host/plugins/qbank/equivalence/ai-grading.json | 候选 L14-qbank `a8f856ddb` | main 无此文件 | top | L14-qbank | 24 | 99 | 5 | dstu_create、save_api_configurations、save_model_assignments | - |
| host/plugins/qbank/equivalence/answer-mastery.json | 候选 L14-qbank `a8f856ddb` | main 无此文件 | top | L14-qbank | 63 | 278 | 8 | dstu_create | - |
| host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.json | 候选 L14-qbank `a8f856ddb` | main 无此文件 | pending-provider | L14-qbank | 10 | 62 | 7 | dstu_create、save_api_configurations | - |
| host/plugins/qbank/equivalence/questions-crud.json | 候选 L14-qbank `a8f856ddb` | main 无此文件 | top | L14-qbank | 71 | 205 | 12 | dstu_create | - |
| host/plugins/review/equivalence/fsrs-config-and-reads.v0.json | 候选 L15-review-analytics `50c3b67f9` | main 无此文件 | top | L15-review-analytics | 8 | 93 | 9 | save_anki_cards | - |
| host/plugins/review/equivalence/fsrs-lifecycle.v0.json | 候选 L15-review-analytics `50c3b67f9` | main 无此文件 | top | L15-review-analytics | 15 | 178 | 13 | delete_anki_card、delete_document_session、save_anki_cards、update_anki_card | - |
| host/plugins/review/equivalence/fsrs-scheduling-and-mastery.v0.json | 候选 L15-review-analytics `50c3b67f9` | main 无此文件 | top | L15-review-analytics | 11 | 124 | 12 | save_anki_cards | - |
| host/plugins/review/equivalence/review-plan-lifecycle.v0.json | 候选 L15-review-analytics `50c3b67f9` | main 无此文件 | top | L15-review-analytics | 9 | 201 | 10 | dstu_create、qbank_batch_create_questions、qbank_create_question、qbank_delete_question | - |
| host/plugins/sync-providers/equivalence/cloud.scenarios.json | 候选 L23-sync-providers `af9676afc` | main 无此文件 | top | L23-sync-providers | 16 | 72 | 7 | cloud_config_publish | - |
| host/plugins/sync-support/equivalence/sync-state.json | 候选 L20b-sync-support `58f68140f` | main 无此文件 | top | L20-sync | 24 | 96 | 5 | cloud_config_ssot_save、secure_save_cloud_credentials | - |
| host/plugins/sync/equivalence/sync-local.json | 候选 L20-sync `fb98daa36` | main 无此文件 | top | L20-sync | 35 | 231 | 17 | dstu_folder_create、dstu_folder_rename、save_text_to_file | - |
| host/plugins/vfs-handlers/equivalence/filestream.json | 候选 L13b-vfs-handlers `0cf0d8d9d` | main 无此文件 | top | L13-vfs-api | 5 | 5 | 1 | - | - |
| host/plugins/vfs/equivalence/dstu-crud-limits.json | 候选 L13-vfs-api `303fbc2d5` | main 无此文件 | top | L13-vfs-api | 12 | 20 | 4 | - | - |
| host/plugins/vfs/equivalence/dstu-crud.json | 候选 L13-vfs-api `303fbc2d5` | main 无此文件 | top | L13-vfs-api | 231 | 685 | 15 | staged_upload_append、staged_upload_begin | - |

层级 top 才计覆盖；pending-*/platform-gated 等子目录只记 `nestedIds`。无 `commands[]` 的辅助文件（provider 脚本、harness sidecar）不当场景：host/plugins/chatanki/equivalence/harness.sidecar.json@main、host/plugins/qbank/equivalence/pending-provider/ai-grading-scripted.provider.json@a8f856ddb。无前端调用点的步骤命令不进 981，也不增前端覆盖。

仅错误步骤、缺成功场景（14）：`convert_heic_to_jpeg`、`data_governance_auto_verify_latest_backup`、`data_governance_check_disk_space_for_restore`、`data_governance_cleanup_audit_logs`、`data_governance_delete_backup`、`data_governance_import_zip`、`data_governance_resolve_conflicts`、`data_governance_resume_backup_job`、`data_governance_verify_backup`、`handout_vlm_caption`、`openai_codex_usage`、`skill_tap_catalog`、`skill_tap_install`、`skill_update_from_source`

## 按 owner lane（供 C1 拆包，每包 ≤20 条）

| lane | 命令 | main 有场景 | 仅候选有场景 | 仅错误步骤 | 仅 nested | 缺场景 | 注册未证实 | 包数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| F1-kernel | 13 | 11 | 0 | 0 | 0 | 2 | 0 | 1 |
| F2-shell | 23 | 0 | 0 | 0 | 0 | 23 | 0 | 2 |
| F3-storage | 32 | 0 | 0 | 0 | 0 | 32 | 0 | 2 |
| F4-security | 29 | 0 | 13 | 0 | 0 | 16 | 3 | 2 |
| L01-llm-providers | 5 | 0 | 5 | 1 | 0 | 0 | 0 | 1 |
| L02-llm-manager | 18 | 0 | 0 | 0 | 0 | 18 | 0 | 1 |
| L04-chat-session | 98 | 7 | 20 | 0 | 0 | 71 | 0 | 5 |
| L05-agent-workspace | 11 | 0 | 0 | 0 | 0 | 11 | 0 | 1 |
| L06-agent-orchestration | 17 | 0 | 17 | 0 | 0 | 0 | 1 | 1 |
| L07-agent-skills-ptc | 18 | 0 | 14 | 3 | 0 | 4 | 0 | 1 |
| L10-notes | 66 | 0 | 20 | 0 | 0 | 46 | 0 | 4 |
| L12-vfs-index | 3 | 0 | 0 | 0 | 0 | 3 | 0 | 1 |
| L13-vfs-api | 190 | 0 | 16 | 0 | 0 | 174 | 0 | 10 |
| L14-qbank | 81 | 0 | 18 | 0 | 0 | 63 | 0 | 5 |
| L15-review-analytics | 68 | 0 | 25 | 0 | 0 | 43 | 0 | 4 |
| L16-anki | 45 | 0 | 27 | 0 | 0 | 18 | 0 | 3 |
| L17-memory-research | 33 | 0 | 20 | 0 | 0 | 13 | 0 | 2 |
| L18-media-docs | 55 | 0 | 14 | 2 | 0 | 41 | 0 | 3 |
| L19-mcp-browser | 46 | 0 | 0 | 0 | 0 | 46 | 0 | 3 |
| L20-sync | 24 | 0 | 22 | 1 | 0 | 2 | 0 | 2 |
| L21-backup-governance | 33 | 0 | 21 | 7 | 1 | 12 | 0 | 2 |
| L23-sync-providers | 14 | 0 | 7 | 0 | 0 | 7 | 0 | 1 |
| UNASSIGNED | 59 | 0 | 0 | 0 | 0 | 59 | 59 | 3 |

缺场景最多的 owner（供 C1 派下一组）：L13-vfs-api 174/190、L04-chat-session 71/98、L14-qbank 63/81、UNASSIGNED 59/59、L10-notes 46/66、L19-mcp-browser 46/46、L15-review-analytics 43/68、L18-media-docs 41/55。

逐包命令名见 JSON `packages`。

## 未解析项

### 动态命令调用点（1）

| 位置 | 表达式 | 分类 |
|---|---|---|
| src/ui-kernel/bootstrap.ts:37 | command | 插件桥命令；独立于 Rust app-command 契约 |

### owner 未知（59）

`bulk_import_problem_cards`、`cleanup_orphaned_images`、`continue_unified_chat_stream`、`delete_memory_internalization_tasks`、`export_knowledge_graph_data`、`extract_memories_from_chat`、`fix_database_schema`、`get_all_tags`、`get_chat_index_stats`、`get_detailed_tag_hierarchy`、`get_document_state`、`get_storage_info`、`get_tag_mapping_history`、`graph_batch_reorder_tags`、`graph_recall_test`、`graph_reorder_tag`、`import_knowledge_graph_data`、`initialize_default_tag_hierarchy`、`initialize_unified_irec`、`llm_generate_answer_with_context`、`save_image_from_base64_path`、`search_chat_basic`、`search_chat_combined`、`search_chat_fulltext`、`search_existing_tags`、`search_user_messages_semantic`、`test_mcp_modelscope`、`unified_add_card_tag`、`unified_auto_generate_tag_hierarchy`、`unified_create_tag`、`unified_delete_card`、`unified_delete_tag`、`unified_export_tag_hierarchy`、`unified_fix_tag_hierarchy`、`unified_generate_missing_tag_vectors`、`unified_generate_tag_hierarchy_preview`、`unified_generate_tag_hierarchy_preview_stream`、`unified_get_all_cards`、`unified_get_card`、`unified_get_card_stats`、`unified_get_card_tag_metrics`、`unified_get_card_tags`、`unified_get_cards_by_tags`、`unified_get_cards_with_tags`、`unified_get_force_graph_data`、`unified_get_tag_hierarchy`、`unified_get_tag_tree_stats`、`unified_get_tags`、`unified_graph_recall_sql`、`unified_import_tag_hierarchy_from_content`、`unified_import_tag_hierarchy_from_content_stream`、`unified_log_metric_event`、`unified_outline_move_tag`、`unified_outline_update_tag`、`unified_remove_card_tag`、`unified_search_cards`、`unified_track_card_access`、`unified_update_card`、`update_card_content`

### Rust handler 未定位（63，非 Rust 契约命令或无 #[tauri::command]）

`bulk_import_problem_cards`(no-rust-definition)、`cleanup_orphaned_images`(no-rust-definition)、`continue_unified_chat_stream`(no-rust-definition)、`delete_memory_internalization_tasks`(no-rust-definition)、`export_knowledge_graph_data`(no-rust-definition)、`extract_memories_from_chat`(no-rust-definition)、`fix_database_schema`(no-rust-definition)、`get_all_tags`(no-rust-definition)、`get_chat_index_stats`(no-rust-definition)、`get_detailed_tag_hierarchy`(no-rust-definition)、`get_document_state`(no-rust-definition)、`get_storage_info`(no-rust-definition)、`get_tag_mapping_history`(no-rust-definition)、`graph_batch_reorder_tags`(no-rust-definition)、`graph_recall_test`(no-rust-definition)、`graph_reorder_tag`(no-rust-definition)、`import_knowledge_graph_data`(no-rust-definition)、`initialize_default_tag_hierarchy`(no-rust-definition)、`initialize_unified_irec`(no-rust-definition)、`llm_generate_answer_with_context`(no-rust-definition)、`plugin:clipboard-manager|read_text`(plugin-or-platform)、`plugin:clipboard-manager|write_text`(plugin-or-platform)、`plugin:host|call`(plugin-or-platform)、`plugin:ui|manifest`(plugin-or-platform)、`save_image_from_base64_path`(no-rust-definition)、`search_chat_basic`(no-rust-definition)、`search_chat_combined`(no-rust-definition)、`search_chat_fulltext`(no-rust-definition)、`search_existing_tags`(no-rust-definition)、`search_user_messages_semantic`(no-rust-definition)、`test_mcp_modelscope`(no-rust-definition)、`unified_add_card_tag`(no-rust-definition)、`unified_auto_generate_tag_hierarchy`(no-rust-definition)、`unified_create_tag`(no-rust-definition)、`unified_delete_card`(no-rust-definition)、`unified_delete_tag`(no-rust-definition)、`unified_export_tag_hierarchy`(no-rust-definition)、`unified_fix_tag_hierarchy`(no-rust-definition)、`unified_generate_missing_tag_vectors`(no-rust-definition)、`unified_generate_tag_hierarchy_preview`(no-rust-definition)、`unified_generate_tag_hierarchy_preview_stream`(no-rust-definition)、`unified_get_all_cards`(no-rust-definition)、`unified_get_card`(no-rust-definition)、`unified_get_card_stats`(no-rust-definition)、`unified_get_card_tag_metrics`(no-rust-definition)、`unified_get_card_tags`(no-rust-definition)、`unified_get_cards_by_tags`(no-rust-definition)、`unified_get_cards_with_tags`(no-rust-definition)、`unified_get_force_graph_data`(no-rust-definition)、`unified_get_tag_hierarchy`(no-rust-definition)、`unified_get_tag_tree_stats`(no-rust-definition)、`unified_get_tags`(no-rust-definition)、`unified_graph_recall_sql`(no-rust-definition)、`unified_import_tag_hierarchy_from_content`(no-rust-definition)、`unified_import_tag_hierarchy_from_content_stream`(no-rust-definition)、`unified_log_metric_event`(no-rust-definition)、`unified_outline_move_tag`(no-rust-definition)、`unified_outline_update_tag`(no-rust-definition)、`unified_remove_card_tag`(no-rust-definition)、`unified_search_cards`(no-rust-definition)、`unified_track_card_access`(no-rust-definition)、`unified_update_card`(no-rust-definition)、`update_card_content`(no-rust-definition)

### 仅测试调用（排除，1）

`write`

### 仅 demo 调用（排除，0）

无

## 读取

```sh
jq -r '.commands[] | select(.owner.lane=="L04-chat-session") | [.name, .registration.level, (.scenarios.missing|tostring), .rust.file] | @tsv' scripts/electron-migration/frontend-audit/wave0-inventory.json
```
