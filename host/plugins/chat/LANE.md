# L04-chat-session：Chat 会话

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L04-chat-session（Chat 会话） |
| 目录 | `host/plugins/chat/` |
| Rust 范围（lanes.md） | chat_v2 的 handlers（101 个命令）、repo、events、types，以及 src/chat_v2 的 handlers |
| 主要提供 | `chatSession` |
| 主要消费 | L03、F3 |
| 特别注意 | 会话、消息、块的持久化；事件流（stream_start→block→complete）与前端严格一致 |
| 规模（本目录） | 54531 行 · 62 个文件 · 107 个命令（前端调用 90） · 527 个测试 |
| 规模（整条 lane，inventory） | 54531 行 · 62 个文件 · 107 个命令（前端 90） · 527 个测试 |
| 契约 | [`contracts/ipc/L04-chat-session.json`](../../../contracts/ipc/L04-chat-session.json) |
| 服务草稿 | [`contracts/services/DRAFT-L04-chat-session.md`](../../../contracts/services/DRAFT-L04-chat-session.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-agent/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/agents_md.rs` | 346 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/completion_dispatcher.rs` | 1177 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs` | 985 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/connector_providers/mod.rs` | 158 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/connector_providers/webhook.rs` | 805 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/database.rs` | 729 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/environment_manifest.rs` | 958 | 12 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/error.rs` | 266 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/events.rs` | 3157 | 57 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/goal/mod.rs` | 54 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/goal/runtime.rs` | 442 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/goal/steering.rs` | 98 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/grants.rs` | 1224 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs` | 205 | 0 | 3 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs` | 83 | 0 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs` | 1099 | 3 | 8 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs` | 259 | 0 | 2 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs` | 246 | 0 | 5 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs` | 466 | 0 | 9 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs` | 88 | 0 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_session.rs` | 154 | 2 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs` | 3021 | 17 | 22 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/migration.rs` | 65 | 0 | 3 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/mod.rs` | 124 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/ocr.rs` | 178 | 0 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs` | 154 | 0 | 8 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs` | 2589 | 14 | 7 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs` | 502 | 0 | 3 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs` | 1539 | 10 | 5 |
| `src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs` | 2904 | 3 | 22 |
| `src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs` | 532 | 7 | 4 |
| `src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs` | 1023 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/migration/mod.rs` | 15 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/migration/types.rs` | 190 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/mod.rs` | 270 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/repo.rs` | 9041 | 76 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/resource_repo.rs` | 844 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/resource_types.rs` | 627 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/role_packs.rs` | 440 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/session_export.rs` | 886 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/session_scope.rs` | 26 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/shell_command_policy.rs` | 545 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/state.rs` | 768 | 12 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/task_audit.rs` | 523 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/task_command.rs` | 1350 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tool_approval_policy.rs` | 302 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tool_descriptors.rs` | 887 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tool_policy.rs` | 344 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs` | 2544 | 29 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/executor.rs` | 989 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/executor_registry.rs` | 967 | 18 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/mod.rs` | 259 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/registry.rs` | 299 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/types.rs` | 262 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/types.rs` | 4393 | 69 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/user_message_builder.rs` | 481 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/variant_context.rs` | 1446 | 15 |  |
| `src-tauri/crates/dstu-agent/src/lib.rs` | 75 | 0 |  |
| `src-tauri/crates/dstu-agent/src/system_notification.rs` | 81 | 1 |  |
| `src-tauri/src/chat_v2/handlers/mod.rs` | 12 | 0 |  |
| `src-tauri/src/chat_v2/mod.rs` | 17 | 0 |  |

### 命令（107）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `chat_v2_add_tag` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:117` | async | app | src/features/chat/hooks/useSessionTags.ts:76 | (sessionId: string, tag: string) → null ! string |
| `chat_v2_archive_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:330` | async | none | — | (groupId: string) → null ! string |
| `chat_v2_archive_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:522` | async | app | src/components/ModernSidebar.tsx:571<br>src/features/chat/adapters/tauri/sessionCommands.ts:114<br>src/features/chat/pages/useSessionEdit.ts:155 | (sessionId: string) → null ! string |
| `chat_v2_ask_user_respond` | `crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs:44` | async | app | src/features/chat/components/input-bar/BlockingAskUserBar.tsx:138<br>src/features/chat/plugins/blocks/askUserBlock.tsx:188 | (toolCallId: string, selectedTexts: string[], selectedIndices: integer(i32)[], customText?: string \| null, source: string) → null ! string |
| `chat_v2_branch_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:710` | async | app | src/features/chat/adapters/tauri/sessionCommands.ts:129<br>src/features/chat/core/store/sessionActions.ts:797 | (sourceSessionId: string, upToMessageId: string) → ChatSession ! string |
| `chat_v2_cancel_stream` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:859` | async | app | src/features/chat/adapters/tauri/messageOperations.ts:80<br>src/quick-assistant/service.ts:213 | (sessionId: string, messageId: string) → null ! string |
| `chat_v2_cancel_variant` | `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:1085` | async | app | src/features/chat/adapters/tauri/variantOperations.ts:190 | (sessionId: string, variantId: string) → null ! string |
| `chat_v2_check_migration_status` | `crates/dstu-agent/src/chat_v2/handlers/migration.rs:18` | async | app | src/api/dataGovernance.ts:1200 | (（无）) → MigrationCheckResult ! string |
| `chat_v2_clear_approval_history` | `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:178` | async | app | src/features/settings/components/mcp-tools/useToolPermissions.tsx:355 | (（无）) → integer(usize) ! string |
| `chat_v2_compact_session` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:56` | async | app | src/features/chat/components/input-bar/InputBarV2.tsx:1022 | (sessionId: string, modelConfigId: string, contextLimit?: integer(u32) \| null) → CompactSessionResponse ! string |
| `chat_v2_continue_message` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:2010` | async | app | src/features/chat/adapters/tauri/messageOperations.ts:439 | (sessionId: string, messageId: string, variantId?: string \| null, options?: SendOptions \| null) → string ! string |
| `chat_v2_copy_block_content` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:258` | async | none | — | (blockId: string, format?: string \| null) → CopyBlockContentResponse ! string |
| `chat_v2_count_sessions` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:641` | async | app | src/features/chat/pages/useSessionLifecycle.ts:65<br>src/features/chat/pages/useSessionLifecycle.ts:259<br>src/features/chat/pages/useSessionLifecycle.ts:260 | (status?: string \| null, groupId?: string \| null) → integer(u32) ! string |
| `chat_v2_create_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:145` | async | app | src/features/chat/hooks/useGroupManagement.ts:49<br>src/quick-assistant/service.ts:130 | (request: CreateGroupRequest) → SessionGroup ! string |
| `chat_v2_create_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:329` | async | app | src/features/chat/adapters/tauri/sessionCommands.ts:80<br>src/features/chat/core/session/createSessionWithDefaults.ts:46<br>src/quick-assistant/service.ts:150 | (mode: string, title?: string \| null, metadata?: Value \| null, groupId?: string \| null) → ChatSession ! string |
| `chat_v2_delete_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:285` | async | app | src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:210 | (groupId: string) → null ! string |
| `chat_v2_delete_message` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:195` | async | app | src/features/chat/adapters/tauri/messageOperations.ts:243 | (sessionId: string, messageId: string) → null ! string |
| `chat_v2_delete_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:892` | async | app | src/components/ModernSidebar.tsx:601<br>src/demo/autoPlay.ts:73 (demo)<br>src/features/chat/debug/attachmentPipelineTestPlugin.ts:1212<br>…共 10 处 | (sessionId: string) → null ! string |
| `chat_v2_delete_variant` | `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:224` | async | app | src/features/chat/adapters/tauri/variantOperations.ts:53 | (sessionId: string, messageId: string, variantId: string) → DeleteVariantResult ! string |
| `chat_v2_edit_and_resend` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1267` | async | app | src/features/chat/adapters/tauri/messageOperations.ts:361 | (sessionId: string, messageId: string, newContent: string, newContextRefs?: SendContextRef[] \| null, newPathMap?: object \| null, options?: SendOptions \| null) → EditAndResendResult ! string |
| `chat_v2_emergency_stop` | `crates/dstu-agent/src/chat_v2/kill_switch.rs:194` | async | none | — | (reason?: string \| null) → KillSwitchStatus ! string |
| `chat_v2_empty_deleted_sessions` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:979` | async | none | — | (（无）) → integer(u32) ! string |
| `chat_v2_export_session` | `crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:56` | async | app | src/features/chat/api/sessionBrowserApi.ts:36 | (sessionId: string, format?: string \| null, includeThinking?: boolean \| null) → ExportSessionResponse ! string |
| `chat_v2_export_session_jsonl` | `crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:130` | async | none | — | (sessionId: string, targetPath: string, options?: SessionExportOptions \| null) → SessionExportSummary ! string |
| `chat_v2_export_session_messages` | `crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:116` | async | app | src/features/chat/api/sessionBrowserApi.ts:90 | (sessionId: string, offset: integer(usize), limit?: integer(usize) \| null) → ExportMessagesChunk ! string |
| `chat_v2_export_session_meta` | `crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82` | async | app | src/features/chat/api/sessionBrowserApi.ts:86 | (sessionId: string) → ExportSessionMeta ! string |
| `chat_v2_freeze_available_skills_snapshot` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:488` | async | app | src/features/chat/adapters/tauri/availableSkillsSnapshot.ts:144 | (sessionId: string, snapshot: string) → string ! string |
| `chat_v2_get_anki_cards_from_block_by_document_id` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:552` | async | app | src/features/anki-tasks/components/SessionRow.tsx:176 | (documentId: string) → AnkiCard[] ! string |
| `chat_v2_get_emit_failure_count` | `crates/dstu-agent/src/chat_v2/events.rs:827` | async | none | — | (（无）) → integer(u64) ! string |
| `chat_v2_get_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:368` | async | app | src/features/chat/core/store/restoreActions.ts:1086 | (groupId: string) → SessionGroup \| null ! string |
| `chat_v2_get_message_summary` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1109` | async | app | src/hooks/useChatV2Stats.ts:215 | (（无）) → MessageSummary ! string |
| `chat_v2_get_rag_scope` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2980` | async | app | src/features/chat/kbScope/kbScope.ts:28 | (sessionId: string) → string[] ! string |
| `chat_v2_get_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:413` | async | app | src/features/chat/pages/ensureActiveChatSession.ts:58<br>src/features/chat/pages/useChatPageEvents.ts:185<br>src/features/chat/pages/useSessionLifecycle.ts:104<br>…共 4 处 | (sessionId: string) → ChatSession \| null ! string |
| `chat_v2_get_session_tags` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:96` | async | none | — | (sessionId: string) → string[] ! string |
| `chat_v2_get_tags_batch` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:107` | async | none | — | (sessionIds: string[]) → object ! string |
| `chat_v2_goal_clear` | `crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:231` | async | app | src/features/chat/core/store/sessionActions.ts:528 | (sessionId: string) → null ! string |
| `chat_v2_goal_edit` | `crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:174` | async | app | src/features/chat/core/store/sessionActions.ts:517 | (sessionId: string, objective: string, tokenBudget?: integer(i64) \| null) → GoalRecord ! string |
| `chat_v2_goal_get` | `crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:75` | async | app | src/features/chat/core/store/sessionActions.ts:492 | (sessionId: string) → GoalRecord \| null ! string |
| `chat_v2_goal_pause` | `crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:85` | async | app | src/features/chat/core/store/sessionActions.ts:503 | (sessionId: string) → GoalRecord ! string |
| `chat_v2_goal_resume` | `crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:126` | async | app | src/features/chat/core/store/sessionActions.ts:510 | (sessionId: string) → GoalRecord ! string |
| `chat_v2_has_active_stream` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:890` | sync | app | src/features/chat/adapters/tauri/sendOperations.ts:52<br>src/features/chat/adapters/tauri/sendOperations.ts:376<br>src/features/chat/workspace/events.ts:265 | (sessionId: string) → boolean |
| `chat_v2_import_session` | `crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:189` | async | app | src/features/chat/api/sessionBrowserApi.ts:94 | (snapshotJson: string) → ImportSessionResult ! string |
| `chat_v2_kill_switch_status` | `crates/dstu-agent/src/chat_v2/kill_switch.rs:290` | async | none | — | (（无）) → KillSwitchStatus ! string |
| `chat_v2_list_agent_sessions` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:671` | async | none | — | (workspaceId?: string \| null, limit?: integer(u32) \| null) → ChatSession[] ! string |
| `chat_v2_list_all_tags` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:147` | async | app | src/features/chat/hooks/useSessionTags.ts:44 | (（无）) → ?[][] ! string |
| `chat_v2_list_groups` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:398` | async | app | src/features/chat/hooks/useGroupManagement.ts:35<br>src/features/chat/stores/sessionListStore.ts:105<br>src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:68<br>…共 5 处 | (status?: string \| null, workspaceId?: string \| null) → SessionGroup[] ! string |
| `chat_v2_list_sessions` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:597` | async | app | src/features/chat/hooks/useSessionManagement.ts:131<br>src/features/chat/hooks/useSessionManagement.ts:165<br>src/features/chat/stores/sessionListStore.ts:99<br>…共 8 处 | (status?: string \| null, groupId?: string \| null, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → ChatSession[] ! string |
| `chat_v2_list_sessions_referencing` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2938` | async | app | src/features/pdf/components/PdfRelatedPanel.tsx:29 | (sourceIds: string[], limit?: integer(u32) \| null) → SessionReferencingResource[] ! string |
| `chat_v2_load_messages_page` | `crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs:32` | async | app | src/features/chat/adapters/tauri/historyLoading.ts:217<br>src/features/chat/adapters/tauri/historyLoading.ts:427 | (sessionId: string, offset?: integer(u32) \| null, limit?: integer(u32) \| null) → LoadMessagesPageResponse ! string |
| `chat_v2_load_session` | `crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37` | async | app | src/demo/desktopHistory.ts:11 (demo)<br>src/features/chat/adapters/tauri/historyLoading.ts:65<br>src/features/chat/adapters/tauri/historyLoading.ts:268<br>…共 6 处 | (sessionId: string, tailLimit?: integer(u32) \| null) → LoadSessionResponse ! string |
| `chat_v2_migrate_legacy_chat` | `crates/dstu-agent/src/chat_v2/handlers/migration.rs:35` | async | app | src/api/dataGovernance.ts:1208 | (（无）) → MigrationReport ! string |
| `chat_v2_move_session_to_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:438` | async | app | src/components/ModernSidebar.tsx:648<br>src/features/chat/pages/useSessionEdit.ts:319 | (sessionId: string, groupId?: string \| null) → null ! string |
| `chat_v2_perform_ocr` | `crates/dstu-agent/src/chat_v2/handlers/ocr.rs:44` | async | app | src/features/chat/plugins/modes/analysis.ts:160<br>src/quick-assistant/service.ts:223 | (request: OcrRequest) → OcrResponse ! string |
| `chat_v2_plan_gate_respond` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2185` | async | app | src/features/chat/components/PlanGateCard.tsx:71 | (sessionId: string, planId: string, toolCallId: string, approved: boolean, reason?: string \| null) → null ! string |
| `chat_v2_remove_tag` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:132` | async | app | src/features/chat/hooks/useSessionTags.ts:93 | (sessionId: string, tag: string) → null ! string |
| `chat_v2_reorder_groups` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:427` | async | app | src/components/ModernSidebar.tsx:826<br>src/features/chat/hooks/useGroupManagement.ts:135 | (groupIds: string[]) → null ! string |
| `chat_v2_restore_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:341` | async | app | src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:171 | (groupId: string) → SessionGroup ! string |
| `chat_v2_restore_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:845` | async | app | src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:157 | (sessionId: string) → ChatSession ! string |
| `chat_v2_resume_agents` | `crates/dstu-agent/src/chat_v2/kill_switch.rs:255` | async | none | — | (（无）) → KillSwitchStatus ! string |
| `chat_v2_resume_automations` | `crates/dstu-agent/src/chat_v2/kill_switch.rs:272` | async | none | — | (（无）) → KillSwitchStatus ! string |
| `chat_v2_retry_message` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:918` | async | app | src/features/chat/adapters/tauri/messageOperations.ts:149 | (sessionId: string, messageId: string, options?: SendOptions \| null) → RetryMessageResult ! string |
| `chat_v2_retry_variant` | `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:401` | async | app | src/features/chat/adapters/tauri/variantOperations.ts:116 | (sessionId: string, messageId: string, variantId: string, modelOverride?: string \| null, options?: SendOptions \| null) → null ! string |
| `chat_v2_retry_variants` | `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:446` | async | app | src/features/chat/adapters/tauri/variantOperations.ts:165 | (sessionId: string, messageId: string, variantIds: string[], options?: SendOptions \| null) → null ! string |
| `chat_v2_rollback_migration` | `crates/dstu-agent/src/chat_v2/handlers/migration.rs:52` | async | app | src/api/dataGovernance.ts:1216 | (（无）) → MigrationReport ! string |
| `chat_v2_save_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:562` | async | app | src/features/chat/adapters/tauri/sessionCommands.ts:60 | (sessionId: string, sessionState: SessionState__De) → null ! string |
| `chat_v2_search_content` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:30` | async | app | src/features/chat/hooks/useContentSearch.ts:55<br>src/features/workbench/search/globalSearchProviders.ts:104 | (query: string, limit?: integer(u32) \| null, dateFrom?: string \| null, dateTo?: string \| null, sessionId?: string \| null, includeArchived?: boolean \| null) → ContentSearchResult[] ! string |
| `chat_v2_search_sessions` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:71` | async | app | src/features/chat/api/sessionBrowserApi.ts:53 | (query: string, limit?: integer(u32) \| null, includeArchived?: boolean \| null) → ChatSession[] ! string |
| `chat_v2_send_message` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:461` | async | app | src/features/chat/adapters/tauri/sendOperations.ts:186<br>src/features/chat/adapters/tauri/sendOperations.ts:571<br>src/quick-assistant/service.ts:188 | (request: SendMessageRequest) → string ! string |
| `chat_v2_session_message_count` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1079` | async | none | — | (sessionId: string) → integer(u32) ! string |
| `chat_v2_set_authority_mode` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2127` | async | app | src/features/chat/core/store/sessionActions.ts:400 | (sessionId: string, mode: string) → ChatSession ! string |
| `chat_v2_set_permission_preset` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2153` | async | none | — | (sessionId: string, preset: string, confirm?: boolean \| null) → ChatSession ! string |
| `chat_v2_set_rag_scope` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2988` | async | app | src/features/chat/kbScope/kbScope.ts:37 | (sessionId: string, folderIds: string[]) → null ! string |
| `chat_v2_soft_delete_session` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:771` | async | none | — | (sessionId: string) → null ! string |
| `chat_v2_stage_context_attachments` | `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1848` | async | app | src/features/chat/adapters/attachmentMaterialization.ts:161 | (sessionId: string, items: AutoStageContextAttachmentInput[]) → AutoStageContextAttachmentsResult ! string |
| `chat_v2_switch_variant` | `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:153` | async | app | src/features/chat/adapters/tauri/variantOperations.ts:25 | (sessionId: string, messageId: string, variantId: string) → null ! string |
| `chat_v2_tool_approval_cancel` | `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:153` | async | none | — | (toolCallId: string) → null ! string |
| `chat_v2_tool_approval_respond` | `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:39` | async | app | src/features/chat/components/ToolApprovalCard.tsx:189<br>src/features/chat/components/input-bar/BlockingApprovalBar.tsx:203 | (sessionId: string, toolCallId: string, toolName: string, approved: boolean, reason?: string \| null, remember: boolean, rememberSession?: boolean \| null, arguments?: Value \| null) → null ! string |
| `chat_v2_undo_compaction` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:118` | async | app | src/features/chat/plugins/blocks/compactionSummary.tsx:130 | (sessionId: string, compactionId: string) → UndoCompactionResponse ! string |
| `chat_v2_update_block_content` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:441` | async | app | src/features/chat/adapters/tauri/sessionCommands.ts:150 | (blockId: string, content: string) → null ! string |
| `chat_v2_update_block_tool_output` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:499` | async | app | src/features/chat/debug/chatAnkiIntegrationTestPlugin.ts:518<br>src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2263 | (blockId: string, toolOutputJson: string) → null ! string |
| `chat_v2_update_group` | `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:197` | async | app | src/components/ModernSidebar.tsx:709<br>src/features/chat/hooks/useGroupManagement.ts:70<br>src/features/chat/hooks/useGroupManagement.ts:92 | (groupId: string, request: UpdateGroupRequest) → SessionGroup ! string |
| `chat_v2_update_session_settings` | `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:448` | async | app | src/App.tsx:1235<br>src/components/ModernSidebar.tsx:465<br>src/components/ModernSidebar.tsx:542<br>…共 11 处 | (sessionId: string, settings: SessionSettings) → ChatSession ! string |
| `chat_v2_upsert_streaming_block` | `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:689` | async | app | src/features/chat/adapters/tauri/sessionCommands.ts:199<br>src/features/chat/plugins/events/toolCall.ts:562<br>src/features/chat/plugins/events/toolCall.ts:617<br>…共 6 处 | (blockId: string, messageId: string, sessionId?: string \| null, blockType: string, content: string, status?: string \| null, toolName?: string \| null, toolInputJson?: string \| null, toolOutputJson?: string \| null) → null ! string |
| `chat_v2_wake_session` | `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:717` | async | app | src/features/chat/adapters/tauri/sendOperations.ts:270 | (sessionId: string, content: string, assistantMessageId?: string \| null, options?: SendOptions \| null) → string ! string |
| `rebuild_chat_fts` | `crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:89` | async | app | src/utils/chatApi.ts:374 | (（无）) → integer(usize) ! string |
| `workspace_cancel_agent` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2139` | async | app | src/features/chat/workspace/api.ts:498 | (sessionId: string, workspaceId: string, agentSessionId: string) → boolean ! string |
| `workspace_cancel_sleep` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2308` | async | app | src/features/chat/workspace/api.ts:648 | (sessionId: string, workspaceId: string, sleepId: string) → boolean ! string |
| `workspace_close` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:642` | async | app | src/features/chat/workspace/api.ts:167 | (sessionId: string, workspaceId: string) → null ! string |
| `workspace_create` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:606` | async | app | src/features/chat/workspace/api.ts:128 | (sessionId: string, request: CreateWorkspaceRequest) → CreateWorkspaceResponse ! string |
| `workspace_create_agent` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:680` | async | app | src/features/chat/workspace/api.ts:189 | (request: CreateAgentRequest) → CreateAgentResponse ! string |
| `workspace_delete` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:661` | async | app | src/features/chat/workspace/api.ts:177 | (sessionId: string, workspaceId: string) → null ! string |
| `workspace_delete_agent_profile_file` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2789` | async | app | src/features/settings/components/SubagentProfilesSection.tsx:556 | (fileName: string) → null ! string |
| `workspace_get` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:622` | async | app | src/features/chat/workspace/api.ts:157 | (sessionId: string, workspaceId: string) → WorkspaceInfo \| null ! string |
| `workspace_get_context` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:972` | async | app | src/features/chat/workspace/api.ts:257 | (sessionId: string, workspaceId: string, key: string) → Value \| null ! string |
| `workspace_get_document` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1008` | async | app | src/features/chat/workspace/api.ts:285 | (sessionId: string, workspaceId: string, documentId: string) → string \| null ! string |
| `workspace_list_agent_profiles` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2638` | async | app | src/features/settings/components/SubagentProfilesSection.tsx:425 | (（无）) → ListAgentProfilesResponse ! string |
| `workspace_list_agents` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:866` | async | app | src/features/chat/workspace/api.ts:198 | (sessionId: string, workspaceId: string) → AgentInfo[] ! string |
| `workspace_list_all` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1021` | async | app | src/features/chat/workspace/api.ts:296 | (sessionId: string) → WorkspaceInfo[] ! string |
| `workspace_list_documents` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:985` | async | app | src/features/chat/workspace/api.ts:271 | (sessionId: string, workspaceId: string) → DocumentInfo[] ! string |
| `workspace_list_messages` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:935` | async | app | src/features/chat/workspace/api.ts:225 | (sessionId: string, workspaceId: string, limit?: integer(usize) \| null) → MessageInfo[] ! string |
| `workspace_manual_wake` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2274` | async | app | src/features/chat/workspace/api.ts:625 | (request: ManualWakeRequest) → ManualWakeResponse ! string |
| `workspace_read_agent_profile_file` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2709` | async | app | src/features/settings/components/SubagentProfilesSection.tsx:486 | (fileName: string) → AgentProfileFileResponse ! string |
| `workspace_restore_executions` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2413` | async | app | src/features/chat/workspace/api.ts:589 | (sessionId: string, workspaceId: string) → RestoreExecutionsResponse ! string |
| `workspace_run_agent` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1075` | async | app | src/features/chat/workspace/api.ts:465 | (request: RunAgentRequest) → RunAgentResponse ! string |
| `workspace_save_agent_profile_file` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2742` | async | none | — | (fileName: string, content: string, overwrite: boolean) → SaveAgentProfileFileResponse ! string |
| `workspace_send_message` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:902` | async | app | src/features/chat/workspace/api.ts:211 | (sessionId: string, request: WorkspaceSendMessageRequest) → SendMessageResponse ! string |
| `workspace_set_context` | `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:960` | async | app | src/features/chat/workspace/api.ts:241 | (sessionId: string, workspaceId: string, key: string, value: Value) → null ! string |

### 发出的事件（8）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `chat_v2_migration` | 常量 `MIGRATION_EVENT_CHANNEL` | crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:80 (emit)<br>crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:951 (emit)<br>crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:1018 (emit) |
| `chat_v2_request_audit` | 字面量 | crates/dstu-agent/src/chat_v2/handlers/send_message.rs:549 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/send_message.rs:764 (emit) |
| `chat_v2://kill_switch_changed` | 常量 `KILL_SWITCH_CHANGED_EVENT` | crates/dstu-agent/src/chat_v2/kill_switch.rs:153 (emit) |
| `workspace_agent_completion` | 常量 `WORKSPACE_AGENT_COMPLETION_EVENT` | crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:310 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1982 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2068 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2126 (emit) |
| `workspace_worker_ready` | 常量 `WORKSPACE_WORKER_READY_EVENT` | crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:840 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2001 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2545 (emit) |
| `channel` | 动态（表达式） | crates/dstu-agent/src/chat_v2/events.rs:904 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:913 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:937 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:945 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:39 (emit) |
| `event` | 动态（表达式） | crates/dstu-agent/src/chat_v2/events.rs:1340 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1359 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1387 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1453 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1472 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1488 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1518 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1537 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1553 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1650 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1688 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1725 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1864 (emit)<br>crates/dstu-agent/src/chat_v2/events.rs:1884 (emit) |
| `event_name` | 动态（表达式） | crates/dstu-agent/src/chat_v2/goal/mod.rs:28 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:368 (emit) |

### 契约中的事件（6，`contracts/ipc/L04-chat-session.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `chat_v2_session_{}` | 是 | object \| object \| Value | crates/dstu-agent/src/chat_v2/goal/mod.rs:28 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:39 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:368 (emit) |
| `chat_v2://kill_switch_changed` | 否 | KillSwitchStatus | crates/dstu-agent/src/chat_v2/kill_switch.rs:153 (emit) |
| `chat_v2_migration` | 否 | MigrationEvent | crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:80 (emit)<br>crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:951 (emit)<br>crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:1018 (emit) |
| `chat_v2_request_audit` | 否 | Value | crates/dstu-agent/src/chat_v2/handlers/send_message.rs:549 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/send_message.rs:764 (emit) |
| `workspace_agent_completion` | 否 | AgentCompletionEnvelope \| UNRESOLVED(payload type of `payload` not determinable statically) | crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:310 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1982 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2068 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2126 (emit) |
| `workspace_worker_ready` | 否 | object \| object \| object \| object | crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:840 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2001 (emit)<br>crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2545 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-168 · 授权 / Plan 原子仓储供方（2026-11-06）

- 新供方从真实 `ctx.chatSession` 提供 getSessionAuthorityState / setSessionPlanState / consumeSessionPlanBinding；`api.ts` 发布可执行 Plan 构造、bind、markApproved/Expired、active 判定，复用现有 session owner 和 F3 IMMEDIATE 事务。中央 dispatcher 由 L03 组合。
- 时间用 F4 `ParsedDateTime`，TTL 用 bigint 秒；Date 不满足纳秒边界，接口及用法见 SPEC WP-168。两个真实 Host/SQLite 连接竞争与 SQL 更新/提交故障回滚见 `tests/session-authority.test.ts`。
- TESTMAP 本包 114 pending → 114；没有对应原测试，不新增映射。WP-097 候选保持；起点定向 job `20261105190012-d69a18` 43 passed、1 个 RPC onTaskUpdate 超时、raw exit 1，不称全绿或自行定性豁免；typecheck 起点 `20261105190011-098e35` raw 0。

### WP-018 · C3-shell-policy（2026-11-05）

- 开始 merge main `967f43c75` 后实际 TESTMAP 为 386 ported / 122 pending / 19 obsolete（527 条）；生成表头的 334/174 是旧统计，以逐行统计为准。shell_command_policy.rs 的 8 条全部 pending，无已有同名 TS 映射。
- 本包测试经 L05 已公开且生产可达的 shell policy API，保留 Rust 8 条原输入与全部断言；复用其单一生产实现。生产调用及分支证据见 SPEC 的 WP-018 小节，逐条映射和门禁结果见 WP-018 交付报告。
- registry 类型/工厂不是当前缺口。完整 roster 和聊天 P1 由 F1/L03 后继核验；本包发现的 L05 typed serde/Unicode 差异已在 BLOCKERS 精确列出。

### 当前状态与下一步（2026-11-04 续作）

#### 续作增量（main 合并至 `ebd7674d0`）

- 缺失命令层继续推进：compact已按Rust block_actions.rs:57-115实现并具备真实kernel.invoke契约测试（Node11pass，Electron5pass，type0），仅真实provider提供runCompactionForSession时注册，实际L03执行未main前仍pending；不靠metadata声明计完成。L03新接口候选031640aa5已核，L06确认高层headless归其自身、消费L04原token/registration执行接口。阶段性工厂/契约与真实链路状态见BLOCKERS。

- main-red 16a254adf 的两条native OCR失败已有`afecaa49a`修复，按Rust桌面平台分发而非放宽Linux；本轮Node/Electron OCR定向均5pass/2平台skip/exit0（jobs 20261104141156-496de6、20261104141156-51c3be），未重做hunk。audit-L04-T1已在`f40b97793`记录精确比较与单命名输入，真实Rust输出双别名证据已报架构师，定向2case通过。

- 架构师补缺优先后先发布X5低层owned/headless执行契约：chatSession.createSendExecution、ChatSendExecution、runSendMessagePipeline；返回真实assistant ID，调用方传原registration/token/window，L03提供execute。Node两文件9pass/typecheck0，接口差异已直告L06；不注册固定失败chat.send服务。当前候选实际未注册12命令，逐名见BLOCKERS；待main集成不能等同已解除全局20条。
- P1并行增量：L03新要的四个WithConn已经接到同一chatSession仓储（Node10pass/type0）；GoalRuntime的150ms循环、i64精确预算、认领CAS、generation清理、轮末settle已有生产服务工厂与12个契约回归。它们不是完整send/goal_resume命令签收；后续继续按L03已发布候选执行签名写命令层，消费main到达的实现。

- R2 新验收续作：C04-04 typed skill JSON/legacy/顺序/u64 与 C04-05 事务 begin/commit 错误映射已修；C04-07 两个字面量反例改走工厂/emitter。Node `20261104115653-81f7b3` 63 文件 / 558 passed / 2 平台 skipped / exit 0，Electron 定向74 passed / exit 0；候选待复核。C04-01 plain Display 子项已修，完整原文 serde decoder仍待；C04-02创建roots、C04-03 goal续跑、C04-06日志仍有自有工作。
- C04-02 创建 roots 已补：持久化后依次消费 L05 artifactRoot/tempRoot，失败原 warn 后保留会话；与之前硬删/refs候选合并复验。C04-06 所列 create group/cancel/authority/variant 日志已补，Node `20261104120333-4da4ef` 4 文件61 passed / exit0，typecheck `20261104120333-c5395e` exit0；新增第五条 variant 日志时序回归在 Node `20261104121136-40eed0`、Electron `20261104121136-10ce79` 复验。
- C04-01 jsonc-parser@3.3.1 精确申请/API/严格选项/原token/重复属性/错误offset方案已在 BLOCKERS，已通过 coord escalate 直报架构师，未安装/改依赖。F1部分值级serde出口为候选待main，不能充当完整原文decoder；01与03/X5仍未闭合。按新standard-v2 §5，收尾先提交全部改动→merge main→运行绝对路径lane-gate，不以单元测试候选代替自检。

- send/wake 调用方 `chatSession.createMessageSender` 和后端 generation 执行端口已实现并经 Node/Electron 5 测试验证；L03 未发布完整 execute，未注册这两个 IPC，不声明 X5 完成。后续仍需本 lane goal runtime/retry 调用方。
- X6-SW-CHAT-01 已修于 `796ec7c9d`；真实 L11 folder owner 与 L21/L05/L04 workspace 删除链路 Node/Electron 均通过。复核状态与原样作业结果见 SPEC 验收问题处理，不重复迁移 registry。
- 集成恢复已修真实 paths 夹具、L21 治理装配、PathsOptions.platform 和 AGENTS.md worker home 夹具；typecheck `20261104110132-3b2ab6` exit 0，普通 boundaries 0 violations。宽路径最新只剩 L03 injectionBudget 测试装配缺口，见 BLOCKERS。
- 新 main 已公开 L05 validatePersonaModelConfig：persona save 不再是外部阻塞。原 174 pending 未虚标完成；先收敛当前门禁反馈，再继续 send/headless 与已解除依赖的自有命令。
- persona save 已通过真实 IPC 接入 L02 目录读取、L05 校验、L06 锁与原子写：Node `20261104111116-01b955`、Electron `20261104111509-a39e26` 各 8 passed / exit 0；L04 独立门禁上一个完整作业 `20261104110713-a52d4d` 61 文件、547 passed / 2 按 Rust 平台条件 skipped / exit 0。新增保存命令后的完整作业为 `20261104111841-a0dcc4`。
- 最新完整结果：`20261104111841-a0dcc4` exit 0，61 文件 / 550 passed / 2 平台 skipped / 无 Errors；typecheck `20261104111841-e7a5ec` exit 0。普通 boundaries 0 violations；strict 的 4 项仍在非本 lane 的 vfs/repository。L13 两面首次发布提交与安全拆分清单已写入 BLOCKERS；不因宽路径误选其他插件而复制提供方或弱化测试。

- 基线：`34597f314`，续作已 merge main（Already up to date）。已有仓储、事件、流状态、ExecutionContext、WithConn、X3-L04-01 SQL NULL 回读及 L13 附件错误/检索范围服务继续复用，不重做。TESTMAP 当前记录 334 ported / 19 已批准 obsolete / 174 pending；非完成声明。
- 剩余主线：X5 send → L03 execute 的真实接线优先，随后 retry_message / retry_variant / retry_variants 的 generation、持久化、终态。send/wake/goal runtime 与其余自有 pending 仍是 L04 工作，不能全算依赖阻塞。
- 已核真实跨 lane 缺口：当前 main `chat-pipeline/api.ts:214-496` 没有 execute / executeWithExistingUser / executeMultiVariant / runCompactionForSession；先完成 L04 调用方与最小端口并记录精确签名，不用固定失败命令冒充 X5 完成。persona save 待复核 L05 validatePersonaModelConfig 的公开状态；workspace 治理接线须用本次真实集成结果更新旧 BLOCKERS。
- 本目录没有 ACCEPTANCE.md。协调者必须修复项：X3 修复已在分支，需保留真实服务回归证据；X5 四命令仍未注册；D1 单写者接缝继续按消费者精确需求增补；F4 两项运行时原断言去向待核。
- 顺序：恢复检查（typecheck 作业 `20261104084253-defe0d`、本 lane 测试 `20261104084253-606fd1`）→ send/wake 行为及依赖端口 → generation/goal 收尾与原断言 → retry → 其他自有 pending。所有重检查走 jobs，结果保留退出码及 Errors。
- 开工已存在 SPEC.md 两段未提交说明（variant context / VFS 单写者），保留，待对应代码核验后单独提交。

#### 接管续作（2026-11-04 22:40–）

- 分支已 merge main `879e0a56b` 与 H1/H2/H3 分支；audit-L04-T1 已在 `f40b97793` 修复（单命名输入 + `toEqual` 精确比对，Rust types.rs:713-736 确实双写别名），本轮复核无需再改。
- 新增（`37231c612`）：`chat_v2_retry_message`、`chat_v2_edit_and_resend`、`chat_v2_retry_variant` 按 Rust 实现并在 meta.commands 声明，仅当 chatPipeline 真实提供 `execute` / `executeVariantRetry`（且 llm、vfsRepo、agentVfsResolver 已提供）时注册。`tests/retry-commands.test.ts` 24 passed（作业 `20261104151910-f63a92`；该次另有 1 个 vitest RPC `onTaskUpdate` 超时属负载噪声），typecheck `20261104151427-ebe8c2` exit 0。
- 自检：`20261104144...`（tip 43361b257）仅 tests 失败，3 条 `chatanki/tests/review-executor-real-l15.test.ts` 为 main 879e0a56b 既有红（L15 CAS 范围收紧 + L24 测试未跟进，修复在 L24 `342c61556`），单跑复现 `20261104145427-7bd6b2`；与本 lane 改动无关。
- 另：retry_variants 命令层已实现（按 `executeVariantsRetryBatch` 存在条件注册）；合入 H1/H2/H3 后修正其门禁问题（grants SQL 移入 repository/grants.ts、去掉构造参数属性、stage 命令改为 L11 `getInlineDataWithConn` 存在时才注册、3 处空 catch）。
- 未完成：retry_variants 生产生效（需 L03 `executeVariantsRetryBatch`）、continue_message（需 L06 todo 持久化/内存恢复接口）、send_message（需 L03 execute、以及 GoalRuntime.resolveWindow 所需的窗口枚举——Rust `resolve_emit_window` 取 main 否则第一个 webview，host 目前无窗口列表提供方）。均已写 BLOCKERS 并 coord 投递 L03/L06。

#### 接替续作（2026-11-05 03:30–，l04s）

- 合并：main（含 L15 i64 修复、L03 execute）与 H1 `bc10bd129`（与本分支 `349c969f1` 是同一边界修复的两种写法，保留本分支版本、删除重复文件）。
- `bc6e9fac0`：为 L03 多变体发布 `VariantExecutionContext.cancelController()`（= Rust child token，可直接 registerExistingToken）与 `chatSession.updateSessionSkillStateV2`（repo.rs:3688-3714）；作业 `20261104193820-75b59a` 27 passed。
- `dd35fd081`：`chatRetrievalScope.loadSessionRagScope(database, sessionId)` 对齐 L13 端口（修 vfs/index.ts TS2352）。
- `886f9e633`：注册 `chat_v2_send_message` / `chat_v2_wake_session`（chatPipeline.execute 存在时；GoalRuntime 用 F4 backgroundTasks、L05 escapeXmlContent，resolve_emit_window 用 host/window 生命周期表）与 `chat_v2_continue_message`（src/continue-actions.ts，经 L06 api 的 loadPersistedTodoListWithConn / restoreTodoListFromDbWithConn）。作业 `20261104200740-2dea9f` 12 passed。
- 当前 main 上的运行时生效情况：execute → retry_message / edit_and_resend / send_message / wake_session / continue_message、compact_session（runCompactionForSession）、workspace_run_agent / create_agent / restore_executions（execute + L06 headlessToolSchemas + L05 CHATANKI_READONLY_TOOLS 均已在 main）会注册；retry_variant / retry_variants 待 L03 executeVariantRetry / executeVariantsRetryBatch 进 main；stage_context_attachments 待 L11 getInlineDataWithConn 进 main。

- H1（分支 `ds-mig/L04-chat-session-h1`）：grants.rs 注册表/撤权代际（13 条原测试 ported）、completion_dispatcher.rs（6 条 ported）、workspace_handlers.rs worker 运行时（run/create/restore 三命令 + runtime_completion_tests 3 条 ported + 生产入口契约测试）。三命令已声明、已字面注册、有契约，但只在 L03 execute、L06 headlessToolSchemas、L05 CHATANKI_READONLY_TOOLS 都发布后才注册（缺口见 BLOCKERS「H1」）。workspace_cancel_agent / manual_wake / cancel_sleep 此前已在本 lane 完成。

## v2 排雷清单

### 核验口径与接续顺序

- 冻结编号补充：以 C2 报告 `0119143715c0bab2d8f698b7c1d58651358e85be`（源码基线 `2ee9a9cbe`）和 owner 裁定 `037376b1e / X6-OWN-C2-20261104` 为准。以下稳定 ID 是现有条目的索引别名，不新增整改、测试或状态变更；此前本地 `X6-UD-chat-*` 编号保留作追溯，后续提交使用稳定ID+原C04编号。

| 稳定ID | 现有条目/旧finding |
|---|---|
| X6-SW-0004 / 0005 / 0006 / 0007 | 分别 vfs-folders:144 / 175 / 186 / 198；同属 C04-08 / X6-SW-CHAT-01，候选796ec7c9d已修 |
| X6-UD-0019 | blocks:35 / X6-UD-chat-blocks-35 |
| X6-UD-0020 | blocks:192 / X6-UD-chat-blocks-192 |
| X6-UD-0021 | messages:44 / X6-UD-chat-messages-44 |
| X6-UD-0022 | session-state:25 / X6-UD-chat-session-state-25 |
| X6-UD-0023 | session-actions:237 / C04-04（ba462056e候选） |
| X6-UD-0024 | session-branch:46 / X6-UD-chat-session-branch-46 |
| X6-UD-0025 | session-export:177 / X6-UD-chat-session-export-177 |
| X6-UD-0026 | snapshot:102 / C04-01（完整decoder仍pending） |
| X6-AP-0139 / 0140 / 0141 | database-service:28 / :59、error:18；下文C04-07组合/fixture覆盖核验 |
| X6-AP-0142 / 0143 | events:438 / :712；分别题名后缀误关联与ordering-lock逐断言待核 |
| X6-AP-0144 / 0145 / 0146 / 0147 / 0148 / 0149 | session-commands:276 / 283 / 377 / 387 / 570 / 189；各原Rust ID见下表，均并入C04-07 |
| X6-AP-0150 / 0151 / 0152 / 0153 / 0154 | snapshot:184、sessions:12 / :55、messages:100、goals:36；并入C04-07，逐项状态见下表 |
| X6-AP-0155 / 0156 | session-export:138 / :182；并入C04-07 |
| X6-LP-0092 / 0093 / 0094 / 0095 / 0096 / 0097 | database error / events error / approval warn / blocks(block_actions) warn / goal warn / variant warn；C04-06（goal兼C04-03） |
| X6-LP-0098 / 0099 / 0100 / 0101 / 0102 | workspaces warn/error、kill-switch warn/error、legacy-migration warn；C04-06 |
| X6-LP-0103 / 0104 / 0105 / 0106 / 0107 | blocks(repo) warn/error、state warn/error、ask-user(executor) warn；C04-06 |
| X6-LP-0108 / 0109 | LANE插件warn/error聚合info；仍只是人工索引，不据总数改代码 |

- 本清单接收 C1/架构师的 X6 存量候选：报告基线 `2ee9a9cbe`；本次逐文件定位的代码 SHA 为 **`1915bd9f76e26466098a80a0b2f6457c1cccb52b`**。下表行号均为报告基线索引，不能当当前行号；当前入口用函数/测试名定位。候选原文来自 `git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/{single-writer,unchecked-decode,assert-parity,log-parity}.json`，只读提取本插件 findings，未重跑全量扫描/测试。
- 清单覆盖 single-writer **9**、unchecked-decode **10**、prod-reachable **0**、assert-parity **18**、log-parity **18** 条（含 info）。`info`、数量差与 `unknown` 都不是失败结论；“待逐项核对”是自有 pending，不冒充外部阻塞。复用 C04-01/03/04/06/07/08、X5-01、X6-SW-CHAT-01；其余新索引用 `X6-SW/UD-chat-文件短名-基线行`。
- 继续优先 C04-01 原文结构解码、X5/goal 调用链；本清单与现有事务/技能/生命周期修复合并。C04-04/05/07 候选 `ba462056e`，C04-02创建 roots/已定位日志候选 `d3eee89ad`，不重做已发布 registry。新清单不自动改 TESTMAP，不重开已批准 obsolete/query_rewriter。
- D1/D4：chat 表由 L04 写；外域仅用所有者正式业务 API，跨插件事务传同一 SqlExecutor。不能靠改 SQL 拼写/搬文件消除报告。L14 已裁定的 qbank_sources/materials/groups/group_materials/practice_attempts 不按旧 L11 owner 分类迁移。

### single-writer（9 条）

| 候选索引 / finding | 当前 SHA 核验与原 Rust 依据 | owner 接口 / 状态 |
|---|---|---|
| repository/vfs-folders.ts:144/175/186/198 foreign-table-write；:144/175/207 duplicate-repository(info)，共7条；**C04-08 / X6-SW-CHAT-01** | 当前文件仅37行，无 folders/path_cache/folder_items 写 SQL；Rust handlers/group_handlers.rs:62-104 使用 VfsFolderRepo，创建→root校验顺序在本 lane 保留。 | 已消费 L11 FolderRepository.getFolder/folderExists/generateUniqueFolderTitle/createFolder/updateFolder，传同一conn；修复 `796ec7c9d`，真实L11测试证据见SPEC；候选待复核，不重写。 |
| repository/blocks.ts:195 duplicate-repository chat_v2_messages(info)；**X6-SW-chat-blocks-195** | 当前 appendBlockIdToMessage 仍写自己的 chat_v2_messages；Rust handlers/block_actions.rs:842-879 同一读/解析/追加流程。原报告另一个writer是memory；当前memory/repository/learning.ts:242-251为旧fixture导出，现测试从tests/fixtures/learning-rows.ts导入，尚未找到该旧导出的生产调用。 | L04是owner，不能删本域UPDATE。createMessageWithConn / appendBlockIdToMessageWithConn已公开；无缺接口。L17旧helper归其自行核清，不能据info认定新的生产重复写。 |
| repository/compactions.ts:143 duplicate-repository chat_v2_sessions(info)；**X6-SW-chat-compactions-143** | 当前 clear/setSessionLastCompaction 写chat表，与Rust repo.rs:8372-8426一致；memory的报告关联同上fixture来源，不是证明L04必须把session写入搬走。 | L04是owner；setSessionLastCompactionWithConn/clearSessionLastCompactionWithConn已在api和service，调用方只传同tx；无新增owner请求，跨lane生产调用去向待对方确认。 |

### unchecked-decode（10 条）

| 候选索引 / finding | 当前 SHA 核验、Rust依据 | 状态 / 接口需求 |
|---|---|---|
| index.ts:106 double-assertion(info)；**C04-08** | 旧ctx.vfs双断言已消失，当前按VfsFolderServiceLike装配database及L11 folders；这是服务装配而非JSON入站。Rust group_handlers.rs:62-104。 | 已随owner接线修复 `796ec7c9d`，无新decoder任务。 |
| repository/blocks.ts:35；**X6-UD-chat-blocks-35** | 当前parseOptional仍有JSON.parse(value) as T；rowToBlock对SQL列类型检查不能代替citations的Vec<Citation>解码。toolInput/output则是任意JSON Value，合法嵌套null应保留。Rust repo.rs:2319-2402、dstu-core/agent.rs MessageBlock。 | 自有pending：按字段拆Value与typed Vec解码，保Rust解析失败分支；不把通用强断言当已验证。 |
| repository/blocks.ts:192；**X6-UD-chat-blocks-192** | 当前appendBlockIdToMessage仍把JSON直接断言string[]；`null`/非数组可到includes/push，混合数组也未按Vec<String>整体回退。Rust block_actions.rs:842-879（from_str::<Vec<String>>失败用默认Vec）。 | 自有pending，属于真实命令失败边界后续小单元；不能把它换成另一个SQL算法来逃检测。 |
| repository/messages.ts:44；**X6-UD-chat-messages-44** | 当前cloneJson是JSON.stringify已构造值再parse的内部克隆，非独立入站decoder；rowToMessage的JSON解析仍需另核。Rust repo.rs:1274-1378/1680-1740及types.rs MessageMeta/VariantMeta。 | 保留克隆业务，待核替换断言与上游typed decoder；不因“内部克隆”签收所有行解码。X3 NULL修复独立有效，不重做。 |
| repository/session-state.ts:25；**X6-UD-chat-session-state-25** | 当前通用parseJson<T>仍存在于chatParams/features/panelStates读回；C04-04已修skillStateJson，不覆盖这些字段。Rust repo.rs:2650-2800、types.rs SessionState/PanelStates/ChatParams。 | 自有pending：字段级default/Option/类型解码，保坏行回退/错误语义。 |
| src/session-actions.ts:237；**C04-04** | 旧parseJson断言已移除；save调用session-skill-state.ts的整体Vec/bool/u64解码，L20无损parser保数字token，失败回退existing。Rust manage_session.rs:2070-2098、types.rs:1196-1297。 | 候选已修 `ba462056e`；5个真实save IPC回归，精确大整数/保序/legacy=false；不新增同义decoder。 |
| src/session-branch.ts:46；**X6-UD-chat-session-branch-46** | 当前cloneJson仍为内部序列化克隆断言；分支skill state已复用C04-04，其他源metadata/messages克隆不同职责。Rust manage_session.rs:1578-2059。 | 自有pending：核上游解码与Clone语义后去断言；不改变深克隆/精确字符串ID重映射行为。 |
| src/session-export.ts:177；**X6-UD-chat-session-export-177** | 当前messageExportValue把序列化的ChatMessage投成Record再脱敏，属出站Value构造；不是直接文件入站。Rust session_export.rs:258-289 `serde_json::to_value`。 | 自有pending：保持Option省略、附件预览/secret脱敏行为，明确对象检查后消除无校验断言；不凭该行新造入站算法。 |
| src/session-metadata.ts:197 double-assertion(info)；**C04-04** | 当前resolvedSkillState直接委托真实resolveSkillState，旧as unknown as已消失；history/branch复用同一解析与饱和增量。Rust types.rs:2610-2620、manage_session.rs:2105-2121。 | 候选已修 `ba462056e`；无新增owner缺口。 |
| src/snapshot.ts:102；**C04-01** | 当前完整ConversationSnapshot结构解码仍缺；plain Display与begin/commit边界已修，不能覆盖缺session panic。Rust snapshot_handlers.rs:160-169,194-218。 | 自有decoder pending；jsonc-parser@3.3.1依赖已申请，F1部分serde出口候选不可当全validator；精确API/严格选项/offset方案见BLOCKERS，01不签收。 |

### assert-parity（18 条，合并 C04-07，以原测试 ID 定位）

以下Rust位置均相对 `src-tauri/crates/dstu-agent/src/chat_v2/`。已审“组合断言覆盖”与“题名匹配误关联”不补无意义expect；其他条目保留人工待核，不宣称原断言缺失已被证明。

| 基线TS索引 | 原Rust证据 / 测试名 | 当前SHA核验结果 |
|---|---|---|
| tests/database-service.test.ts:28 | database.rs:432 test_migrations_idempotent | 首次迁移success由database-fixture.ts:25-26失败抛错保证；本测试再核版本/二次迁移/重开后版本。该数量差不构成缺断言。 |
| tests/database-service.test.ts:59 | database.rs:525 test_get_statistics | toEqual同时覆盖4个零计数与schema_version，和5条Rust断言同义。无需按数量拆expect。 |
| tests/error.test.ts:18 | error.rs:220 test_error_to_string_conversion | toEqual同时精确核code与完整message，覆盖Rust两条。无需动作。 |
| tests/events.test.ts:438 | events.rs:2382 test_backend_event_deserialization | 原报告误匹配后缀_with_variant（Rust原测试7条，真正variant测试:2403仅2条）；当前两个TS测试分别7与2条。计数非缺陷；但仍JSON.parse测试本身，生产codec真实性并入C04-07继续pending，不能用误匹配解除它。 |
| tests/events.test.ts:712 | events.rs:2898 chunk_batching_flush_holds_ordering_lock_through_delivery | 当前同名测试存在；锁/重入/先chunk后terminal保证须逐分支对照，人工待核，不按5>3判失败。 |
| tests/session-commands.test.ts:276 | handlers/block_actions.rs:1084 test_block_id_validation | 当前走真实命令；逐个有效/无效ID覆盖待核，不能以用例总expect代替每个输入。 |
| tests/session-commands.test.ts:283 | handlers/block_actions.rs:1092 test_message_id_validation | 当前走真实命令；各前缀/空值原断言逐项待核。 |
| tests/session-commands.test.ts:377 | handlers/load_session.rs:107 test_session_id_validation | 当前真实load命令；需核sess/agent/subagent三类与拒绝值，人工待核。 |
| tests/session-commands.test.ts:387 | handlers/load_session.rs:120 loading_session_persists_retired_authority_mode_as_craft | 当前命令与回读测试存在；响应与持久化两侧所有原字段待逐项核，不按3>2加字面量。 |
| tests/session-commands.test.ts:570 | handlers/manage_session.rs:2416 settings_patch_preserves_runtime_metadata_against_stale_snapshot | 当前使用复合metadata断言；逐键对照Rust12项仍待，和C04-05事务边界已修并行，不重写settings主流程。 |
| tests/session-commands.test.ts:189 | handlers/manage_session.rs:2691 test_session_id_format_validation | 当前命令级校验用例；有效/无效集合覆盖待核。 |
| tests/snapshot.test.ts:184 | handlers/manage_session.rs:2746 test_remap_ids_in_value_remaps_only_exact_string_matches | 当前调用生产remapIdsInValue；需核8个标量/嵌套/URL不替换原断言与7个expect的对应，人工待核。 |
| tests/sessions.test.ts:12 | repo.rs:4861 test_session_crud | 当前真实仓储SQLite路径；生命周期各阶段值与不存在分支待逐条核。 |
| tests/sessions.test.ts:55 | repo.rs:5787 test_session_title_locked_persists_through_update | 当前真实仓储；初始/更新/回读三保证待核。 |
| tests/messages.test.ts:100 | repo.rs:6295 test_load_session_messages_page_with_role_filter | 当前真实分页查询；role过滤/总数/空页/顺序原9项待核。 |
| tests/goals.test.ts:36 | repo.rs:8917 goal_add_usage_accumulates | 两次toMatchObject分别核tokensUsed=150/timeUsedSeconds=12及stale goalId后两值不变，覆盖Rust4条，数量差非缺陷。 |
| tests/session-export.test.ts:138 | session_export.rs:538 export_line_order_and_footer_counts | 当前真实JSONL export；header/message/block/state/compaction/footer顺序、计数与原panic分支逐项待核，不按25>18补无意义断言。 |
| tests/session-export.test.ts:182 | session_export.rs:609 export_empty_session_writes_header_and_zero_count_footer | 当前真实export；空会话header/footer全部字段与顺序待逐项核，数量差本身不判失败。 |

### log-parity（18 条 info，合并 C04-06，goal 同时关联 C04-03）

| 基线TS索引 / 原报告规则（条数） | 原Rust位置与当前SHA定位 | 状态 / owner边界 |
|---|---|---|
| repository/database.ts:1 error（1） | database.rs:69目录创建、185/204 pool poison/recovery；当前repository/database.ts只统计/schema读取，连接创建已由F3持有。 | 人工pending：区分F3真实目录失败日志与JS无RwLock poison分支；不可在统计入口补3条假error，需按F3生命周期核。 |
| src/events.ts:1 error（1） | events.rs:905/915/938/947两种事件的首次/重试失败；当前BackendEventsSink共用emitWithRetry，error位于548/554，两个channel均经过它。 | 数量压缩有共享函数来源；保留重试与失败计数断言，逐载荷日志对应待核，不能按4>2补重复日志。 |
| src/approval.ts:1 warn（1） | handlers/approval_handlers.rs:80/114/137；当前respondToApproval含等待器缺失、无setting key与持久失败分支。 | 人工pending：逐个Rust分支/级别核（warn不能靠现有error数量抵消）；L05真实策略接口已存在，不复制。 |
| repository/blocks.ts:1 warn（1，block_actions源） | handlers/block_actions.rs:300-376 refs、823追加ID等；当前日志分散src/block-actions.ts、deletion.ts、reference-counts.ts。 | 已有C04-02/05候选涵盖部分，余warn逐位置核；不因仓储文件计数单独判缺。 |
| src/goal-actions.ts:1 warn（1） | handlers/goal_handlers.rs:39-43发射失败warn；当前register.emitGoal仍需收敛best-effort边界。 | C04-03/06自有pending，与idle续跑/取消登记同一单元，不另造goal实现。 |
| src/variant-actions.ts:1 warn（1） | handlers/variant_handlers.rs含delete块失败/事件失败及retry分支；当前非retry路径warn分散register与variant-actions。 | d3eee89ad补了已审info/debug，不代表6个warn全闭合；retry关联X5，自有pending。 |
| repository/workspaces.ts:1 warn/error（2） | handlers/workspace_handlers.rs；当前读取、profiles、workspace-runtime、register分担，剩余run/create/restore仍未接。 | C04-06/X5合并pending；L05管理器/roots/事件已main公开，不重复请求旧缺口。 |
| src/kill-switch.ts:1 warn/error（2） | kill_switch.rs:154 emit、186通知、241汇总、322缺ChatV2State准入；当前emit/通知/汇总warn已在kill-switch.ts。 | 通知候选已修；:322属headless准入接缝需逐对照，不在普通status查询凭空error；与X5合并。 |
| repository/legacy-migration.ts:1 warn（1） | migration/legacy_migration.rs:22/81/207/764/993；当前executor日志在src/legacy-migration.ts，repo仅SQL。 | 人工pending：逐个row-skip/事件失败/回滚分支核；保持原迁移continue/abort语义。 |
| repository/blocks.ts:1 warn/error（2，repo源） | repo.rs（全9000行，不只是blocks）；当前messages/blocks/history-replay/compactions/startup等多仓储共享logger。 | 人工pending：原25warn/5error逐点映射，不把全repo计数压到blocks。已完成变体大小限制/启动收尾日志不重做。 |
| src/state.ts:1 warn/error（2） | state.rs:152/183/196/209/235/246/257/268/284/297/335/346/372/379/386/433/445/530/555；含Mutex poison及真实覆盖/kill-switch拒绝。 | 人工pending：先分JS不可达poison与正常准入/覆盖日志；D6不允许造假的poison机制，也不因不可达而漏正常warn。 |
| src/ask-user.ts:1 warn（1） | 报告引用tools/executor.rs两个saveToolBlock缺DB/缺blockId warn；当前二者已在src/execution-context.ts:101/104，ask-user另有等待回调缺失warn。 | 旧跨文件计数关联不代表当前缺失；两个真实ExecutionContext分支已实现并测试，不在ask-user重复记录。 |
| LANE.md:1 plugin warn/error总计（2） | 基线Rust163warn/57error vs旧TS32/14仅聚合；当前文件拆分、已修日志和pending模块均影响数字。 | 仅索引，不是业务入口/失败证据；由以上具体位置消化，不给文档增加日志，不按数量填充测试。 |

### owner 请求与验收状态

- C04-01依赖申请精确版本/API及F1限制见BLOCKERS；01仍未完整解码。L03 execute/executeWithExistingUser/executeMultiVariant/runCompactionForSession的最小端口及发送generation责任见BLOCKERS，X5仍未闭合。其他上述自有decoder/断言/日志待核不伪称跨lane缺接口。
- L11 folder业务面已实际消费；L04的createSessionWithConn/createMessageWithConn/appendBlockIdToMessageWithConn与compaction WithConn已公开。对报告涉及的其他writer先确认生产调用，再由其传同一个事务；没有证据时不要求消费者复制或自行SQL。L17旧fixture导出线索向owner反馈，保留本域合法写入。
- 本次只是当前SHA候选归档与定向源码核验，不修改ACCEPTANCE/TESTMAP，不为登记清单重跑500+测试。文档提交后按§5提交→merge main→lane-gate；自检结果和候选/main状态分别报告，未收到复核签收前不把清单整项标完成。
- 已完成的统一自检（代码tip `1915bd9f7`，本次文档编辑前）：5项中typecheck/boundaries/changed-strict/importable通过；tests exit1，L03 `stream-hooks-guard.test.ts` 两条因真实llm缺 `injectionBudget` 未启动，另有2个 `Timeout calling onTaskUpdate`。整体lane-gate exit1，不记全绿；L03夹具/owner处置需求已在BLOCKERS并投递。不是本清单数量报警造成失败，不据此改本lane的行为断言。
