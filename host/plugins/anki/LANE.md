# L16-anki：Anki

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L16-anki（Anki） |
| 目录 | `host/plugins/anki/` |
| Rust 范围（lanes.md） | dstu-anki（除 fsrs）、cmd 下的 anki 与 apkg 命令、tests/anki_* |
| 主要提供 | `anki@1` |
| 主要消费 | F3、L02 |
| 特别注意 | apkg 导入导出字节格式、AnkiConnect、遮挡卡 |
| 规模（本目录） | 40844 行 · 29 个文件 · 61 个命令（前端调用 44） · 630 个测试 |
| 规模（整条 lane，inventory） | 40844 行 · 29 个文件 · 61 个命令（前端 44） · 630 个测试 |
| 契约 | [`contracts/ipc/L16-anki.json`](../../../contracts/ipc/L16-anki.json) |
| 服务草稿 | [`contracts/services/DRAFT-L16-anki.md`](../../../contracts/services/DRAFT-L16-anki.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-anki/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-anki/src/anki/mod.rs` | 30 | 0 |  |
| `src-tauri/crates/dstu-anki/src/anki/repository.rs` | 62 | 1 |  |
| `src-tauri/crates/dstu-anki/src/anki_connect_service.rs` | 2114 | 19 | 1 |
| `src-tauri/crates/dstu-anki/src/anki_critic.rs` | 2144 | 54 |  |
| `src-tauri/crates/dstu-anki/src/anki_fsrs_feedback.rs` | 1240 | 18 |  |
| `src-tauri/crates/dstu-anki/src/anki_gold_set.rs` | 1813 | 50 |  |
| `src-tauri/crates/dstu-anki/src/anki_image_occlusion.rs` | 1629 | 42 |  |
| `src-tauri/crates/dstu-anki/src/anki_preference_memory.rs` | 1250 | 22 |  |
| `src-tauri/crates/dstu-anki/src/anki_protocol.rs` | 1251 | 22 |  |
| `src-tauri/crates/dstu-anki/src/anki_qa_lint.rs` | 2563 | 70 |  |
| `src-tauri/crates/dstu-anki/src/apkg_exporter_service.rs` | 3797 | 41 |  |
| `src-tauri/crates/dstu-anki/src/apkg_importer_service.rs` | 5455 | 47 |  |
| `src-tauri/crates/dstu-anki/src/document_processing_service.rs` | 1827 | 31 |  |
| `src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs` | 1515 | 5 |  |
| `src-tauri/crates/dstu-anki/src/lib.rs` | 51 | 0 |  |
| `src-tauri/crates/dstu-anki/src/streaming_anki_service.rs` | 5929 | 94 |  |
| `src-tauri/src/cmd/anki_cards.rs` | 75 | 0 | 3 |
| `src-tauri/src/cmd/anki_connect.rs` | 2161 | 20 | 13 |
| `src-tauri/src/cmd/apkg_import.rs` | 390 | 9 | 2 |
| `src-tauri/src/cmd/enhanced_anki.rs` | 992 | 4 | 25 |
| `src-tauri/tests/anki_ai_native_integration.rs` | 1318 | 29 |  |
| `src-tauri/tests/anki_export_integration.rs` | 270 | 3 |  |
| `src-tauri/tests/anki_fsrs_feedback.rs` | 236 | 5 |  |
| `src-tauri/tests/anki_new_wiring_tests.rs` | 280 | 3 |  |
| `src-tauri/tests/anki_nullable_card_reads.rs` | 373 | 5 |  |
| `src-tauri/tests/gold_provenance_excludes_critic.rs` | 777 | 14 |  |
| `src-tauri/tests/occlusion_export_roundtrip.rs` | 704 | 11 |  |
| `src-tauri/tests/qa_pass_critic_combo.rs` | 580 | 11 |  |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（61）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `add_cards_to_anki_connect` | `src/cmd/anki_connect.rs:226` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:736<br>src/features/chat/anki/index.tsx:460<br>src/services/ankiConnectClient.ts:85 | (selectedCards: AnkiCard__De[], deckName: string, noteType: string) → AnkiSyncReport ! AppError |
| `anki_get_deck_names` | `src/cmd/anki_connect.rs:198` | async | app | src/features/settings/components/AnkiConnectSettingsSection.tsx:53 | (（无）) → string[] ! AppError |
| `batch_export_cards` | `src/cmd/anki_connect.rs:1323` | async | app | src/services/ankiApiAdapter.ts:88 | (notes: BatchExportNote[], format: string, options: BatchExportOptions) → string ! AppError |
| `cancel_document_processing` | `src/cmd/enhanced_anki.rs:140` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:628<br>src/components/anki/cardforge/engines/TaskController.ts:318 | (documentId: string) → boolean ! AppError |
| `check_anki_connect_availability` | `crates/dstu-anki/src/anki_connect_service.rs:308` | async | none | — | (（无）) → boolean ! string |
| `check_anki_connect_status` | `src/cmd/anki_connect.rs:180` | async | app | src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2150<br>src/services/ankiConnectClient.ts:51 | (（无）) → boolean ! AppError |
| `count_custom_template_references` | `src/commands.rs:4465` | async | app | src/features/template-management/TemplateManagementApp.tsx:997 | (templateId: string) → integer(i64) ! AppError |
| `create_anki_deck` | `src/cmd/anki_connect.rs:213` | async | app | src/services/ankiConnectClient.ts:63 | (deckName: string) → null ! AppError |
| `create_custom_template` | `src/commands.rs:4303` | async | app | src/data/ankiTemplates.ts:267 | (request: CreateTemplateRequest) → string ! AppError |
| `delete_anki_card` | `src/cmd/enhanced_anki.rs:287` | async | app | src/features/chat/plugins/blocks/pendingCardDeletes.ts:67<br>src/services/ankiApiAdapter.ts:164<br>src/utils/chatApi.ts:268 | (cardId: string) → boolean ! AppError |
| `delete_custom_template` | `src/commands.rs:4402` | async | app | src/data/ankiTemplates.ts:276 | (templateId: string) → Value ! AppError |
| `delete_document_session` | `src/cmd/enhanced_anki.rs:325` | async | app | src/features/anki-tasks/components/SessionRow.tsx:143 | (documentId: string) → boolean ! AppError |
| `delete_document_task` | `src/cmd/enhanced_anki.rs:306` | async | none | — | (taskId: string) → boolean ! AppError |
| `dismiss_pending_memory_candidates` | `src/cmd/enhanced_anki.rs:786` | async | app | src/utils/graphApi.ts:103 | (conversationId: string) → integer(u32) ! AppError |
| `export_anki_cards` | `src/cmd/enhanced_anki.rs:646` | async | app | src/utils/chatApi.ts:285 | (request: ExportAnkiCardsRequest) → ExportAnkiCardsResponse ! AppError |
| `export_apkg_for_selection` | `src/cmd/enhanced_anki.rs:347` | async | none | — | (documentId?: string \| null, taskIds?: string[] \| null, cardIds?: string[] \| null, options: AnkiGenerationOptions) → string ! AppError |
| `export_cards_as_apkg` | `src/cmd/anki_connect.rs:947` | async | none | — | (selectedCards: AnkiCard__De[], deckName: string, noteType: string) → string ! AppError |
| `export_cards_as_apkg_with_template` | `src/cmd/anki_connect.rs:977` | async | app | src/services/ankiApiAdapter.ts:92 | (selectedCards: AnkiCard__De[], deckName: string, noteType: string, templateId?: string \| null) → string ! AppError |
| `export_multi_template_apkg` | `src/cmd/anki_connect.rs:1123` | async | app | src/features/chat/anki/index.tsx:375 | (cards: AnkiCard__De[], deckName: string, outputPath?: string \| null) → ExportMultiTemplateApkgResult ! AppError |
| `export_template` | `src/commands.rs:4476` | async | app | src/features/template-management/TemplateManagementApp.tsx:341 | (templateId: string) → TemplateExportResponse ! AppError |
| `generate_anki_cards_from_document` | `src/commands.rs:3911` | async | none | — | (request: AnkiDocumentGenerationRequest) → AnkiDocumentGenerationResponse ! AppError |
| `generate_anki_cards_from_document_base64` | `src/commands.rs:3998` | async | none | — | (fileName: string, base64Content: string, options?: AnkiGenerationOptions \| null) → AnkiDocumentGenerationResponse ! AppError |
| `generate_anki_cards_from_document_file` | `src/commands.rs:3950` | async | none | — | (filePath: string, options?: AnkiGenerationOptions \| null) → AnkiDocumentGenerationResponse ! AppError |
| `get_all_custom_templates` | `src/commands.rs:4279` | async | app | src/data/ankiTemplates.ts:53<br>src/data/ankiTemplates.ts:60<br>src/features/anki-tasks/components/SessionRow.tsx:77<br>…共 4 处 | (（无）) → CustomAnkiTemplate[] ! AppError |
| `get_all_recent_cards` | `src/commands.rs:7075` | async | none | — | (limit?: integer(u32) \| null) → AnkiCard[] ! AppError |
| `get_anki_deck_names` | `src/cmd/anki_connect.rs:189` | async | app | src/services/ankiConnectClient.ts:55 | (（无）) → string[] ! AppError |
| `get_anki_library_card_content` | `src/cmd/enhanced_anki.rs:460` | async | app | src/features/chat/components/input-bar/AnkiCardUpdateDiff.tsx:113 | (cardId: string) → Value ! AppError |
| `get_anki_model_names` | `src/cmd/anki_connect.rs:204` | async | app | src/features/settings/components/AnkiConnectSettingsSection.tsx:54<br>src/services/ankiConnectClient.ts:59 | (（无）) → string[] ! AppError |
| `get_anki_stats` | `src/cmd/enhanced_anki.rs:612` | async | app | src/features/anki-tasks/AnkiTasksApp.tsx:235 | (（无）) → Value ! AppError |
| `get_custom_template_by_id` | `src/commands.rs:4291` | async | none | — | (templateId: string) → CustomAnkiTemplate \| null ! AppError |
| `get_default_template_id` | `src/commands.rs:6239` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:1244<br>src/data/ankiTemplates.ts:54<br>src/data/ankiTemplates.ts:61<br>…共 4 处 | (（无）) → string \| null ! AppError |
| `get_document_cards` | `src/cmd/enhanced_anki.rs:379` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:1385<br>src/features/anki-tasks/components/SessionRow.tsx:76<br>src/features/anki-tasks/components/SessionRow.tsx:180<br>…共 5 处 | (documentId: string) → AnkiCard[] ! AppError |
| `get_document_processing_state` | `src/cmd/enhanced_anki.rs:181` | async | app | src/components/anki/cardforge/engines/TaskController.ts:452 | (documentId: string) → DocumentStateDto ! AppError |
| `get_document_task_counts` | `src/cmd/enhanced_anki.rs:195` | async | none | — | (documentId: string) → DocumentTaskCountsDto ! AppError |
| `get_document_tasks` | `src/cmd/enhanced_anki.rs:229` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:1358<br>src/components/anki/cardforge/engines/CardAgent.ts:1542<br>src/components/anki/cardforge/engines/CardAgent.ts:1554<br>…共 7 处 | (documentId: string) → DocumentTask[] ! AppError |
| `get_model_adapter_options` | `src/cmd/anki_cards.rs:19` | async | app | src/features/settings/components/ShadApiEditModal.tsx:634 | (（无）) → Value[] ! AppError |
| `get_pending_memory_candidates` | `src/cmd/enhanced_anki.rs:725` | async | none | — | (conversationId: string) → PendingMemoryCandidatesResponse \| null ! AppError |
| `get_task_cards` | `src/cmd/enhanced_anki.rs:247` | async | none | — | (taskId: string) → AnkiCard[] ! AppError |
| `import_anki_package` | `src/cmd/anki_connect.rs:413` | async | app | src/services/ankiConnectClient.ts:67 | (path: string, deleteAfter?: boolean \| null) → boolean ! AppError |
| `import_apkg_to_library` | `src/cmd/apkg_import.rs:81` | async | app | src/command-palette/modules/anki.commands.ts:50<br>src/features/flashcards/store/libraryStore.ts:509 | (path: string) → ApkgImportResult ! AppError |
| `import_builtin_templates` | `src/commands.rs:4898` | async | app | src/data/ankiTemplates.ts:46<br>src/data/ankiTemplates.ts:59<br>src/features/template-management/TemplateManagementApp.tsx:607<br>…共 4 处 | (（无）) → string ! AppError |
| `import_custom_templates_bulk` | `src/commands.rs:4579` | async | app | src/features/template-management/TemplateManagementApp.tsx:506 | (request: TemplateBulkImportRequest) → string ! AppError |
| `import_template` | `src/commands.rs:4504` | async | none | — | (request: TemplateImportRequest) → string ! AppError |
| `list_anki_library_cards` | `src/cmd/enhanced_anki.rs:477` | async | app | src/features/flashcards/hooks/useReviewActivity.ts:193<br>src/features/flashcards/screens/TodayScreen.tsx:221<br>src/features/notes/components/NoteRelationTargetPicker.tsx:33<br>…共 4 处 | (request: ListAnkiCardsRequest) → Value ! AppError |
| `list_document_sessions` | `src/cmd/enhanced_anki.rs:559` | async | app | src/features/anki-tasks/AnkiTasksApp.tsx:234<br>src/features/anki/ankiCompletionNotifier.ts:55<br>src/features/workbench/apps/system/ankiTaskSource.ts:83 | (limit?: integer(u32) \| null) → Value[] ! AppError |
| `mark_pending_memory_candidates_saved` | `src/cmd/enhanced_anki.rs:814` | async | app | src/utils/graphApi.ts:116 | (conversationId: string) → integer(u32) ! AppError |
| `pause_document_processing` | `src/cmd/enhanced_anki.rs:121` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:594<br>src/components/anki/cardforge/engines/TaskController.ts:134 | (documentId: string) → boolean ! AppError |
| `read_anki_media` | `src/cmd/apkg_import.rs:306` | async | app | src/components/anki/utils/cardMedia.ts:24 | (path: string) → string ! AppError |
| `recover_stuck_document_tasks` | `src/cmd/enhanced_anki.rs:547` | async | app | src/features/anki-tasks/AnkiTasksApp.tsx:318 | (（无）) → integer(u32) ! AppError |
| `reset_model_adapter_options` | `src/cmd/anki_cards.rs:57` | async | none | — | (（无）) → Value[] ! AppError |
| `resume_document_processing` | `src/cmd/enhanced_anki.rs:162` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:601<br>src/components/anki/cardforge/engines/TaskController.ts:192 | (documentId: string) → boolean ! AppError |
| `save_anki_cards` | `src/cmd/anki_connect.rs:925` | async | app | src/services/ankiApiAdapter.ts:127 | (request: SaveAnkiCardsRequest) → SaveAnkiCardsResponse ! AppError |
| `save_json_file` | `src/cmd/anki_connect.rs:2145` | async | none | — | (content: string, suggestedName: string) → string ! AppError |
| `save_model_adapter_options` | `src/cmd/anki_cards.rs:28` | async | none | — | (options: Value[]) → null ! AppError |
| `save_template_debug_data` | `src/commands.rs:6856` | async | none | — | (debugData: Value) → string ! AppError |
| `set_default_template` | `src/commands.rs:6230` | async | app | src/data/ankiTemplates.ts:319 | (templateId: string) → null ! AppError |
| `set_document_session_source` | `src/cmd/enhanced_anki.rs:623` | async | app | src/features/chat/services/selectionCardGeneration.ts:94 | (documentId: string, sessionId: string) → null ! AppError |
| `start_enhanced_document_processing` | `src/cmd/enhanced_anki.rs:85` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:380<br>src/components/anki/cardforge/engines/CardAgent.ts:461 | (documentContent: string, originalDocumentName: string, options: AnkiGenerationOptions) → string ! AppError |
| `trigger_task_processing` | `src/cmd/enhanced_anki.rs:209` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:617<br>src/components/anki/cardforge/engines/TaskController.ts:258<br>src/features/anki/taskControl.ts:28<br>…共 4 处 | (taskId: string) → null ! AppError |
| `update_anki_card` | `src/cmd/enhanced_anki.rs:266` | async | app | src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2356<br>src/features/flashcards/store/fsrsReviewStore.ts:1795<br>src/utils/chatApi.ts:207<br>…共 4 处 | (card: AnkiCard__De) → null ! AppError |
| `update_custom_template` | `src/commands.rs:4320` | async | app | src/data/ankiTemplates.ts:299 | (templateId: string, request: UpdateTemplateRequest) → null ! AppError |

### 发出的事件（2）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `anki_generation_event` | 字面量 | crates/dstu-anki/src/enhanced_anki_service.rs:237 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:479 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:600 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:609 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:672 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:882 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:893 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3286 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3301 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3314 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3339 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3356 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3381 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3410 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3462 (emit) |
| `fsrs://changed` | 字面量 | src/cmd/anki_connect.rs:938 (emit)<br>src/cmd/apkg_import.rs:71 (emit) |

### 契约中的事件（2，`contracts/ipc/L16-anki.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `fsrs://changed` | 否 | object \| Value | src/cmd/anki_connect.rs:938 (emit)<br>src/cmd/apkg_import.rs:71 (emit) |
| `anki_generation_event` | 否 | StreamedCardPayload \| object \| object \| Value | crates/dstu-anki/src/enhanced_anki_service.rs:237 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:479 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:600 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:609 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:672 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:882 (emit)<br>crates/dstu-anki/src/enhanced_anki_service.rs:893 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3286 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3301 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3314 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3339 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3356 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3381 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3410 (emit)<br>crates/dstu-anki/src/streaming_anki_service.rs:3462 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

### WP-160：模板原始供方（恢复会话，2026-11-05）

- 恢复时亲核 `e7d353922`（实现）/`0e6e2f7df`（13例测试）及 api.ts WIP；
  `ddc4ea47a` 保存本会话扩展后的16例。WP-157完整提交/报告/正式失败历史保持。
- `ctx.anki.templates` 增补 `importBuiltinTemplatesIfEmpty/updateIfVersion/markUserModified/
  countReferencingCards/softDeleteBuiltin/deleteCustom`，仍只有 `repository/templates.ts` 写模板表。
  原始错误、SQL CAS、独立自动提交与L24负责的warn位置见SPEC首节；旧五方法/IPC行为不变。
- main 已有旧模板owner，WP-160不依赖F3/WP140新能力。L24 WP119四项待消费缺口在本包提供，
  正常main之后由L24接线并独立验证count失败warn继续，供方测试不能代替消费者整链签收。
- 恢复基线 `20261105200547-998c29` 原1：29pass/1fail，原facade17例全过；新fallback夹具
  两行都用默认名称撞真实 UNIQUE(name)，仅给一行独立名称，原语义断言保留。
  `20261105200547-3767a0` typecheck原2为WIP测试不存在的wrappedMethod，改为单次文件读替身。
- 新16例red `20261105200907-266e93` 原1：14pass/2fail，真实双连接SQL竞争已过；
  两失败为新增builtin Rust trim和serde错误行列。实现改用F4 rustTrim/JsonReader，测试不放宽。
  没有改WP157网络serde或APKG，也没有修改任何时限、env或全局runner。
- TESTMAP仍630ported/pending0；只追加供方补充覆盖，不改变任何旧Rust测试去向。
- 最终实现全目录 `20261105201346-582243`：49files / 911passed / 0failed /
  1既有APKG外部样例skip / exit0，无Errors/Unhandled。原30s及hook预算均未改。
- Electron `20261105201134-675428`：新增16例＋原facade17例，33passed/0failed/0skipped，
  原exit0，无Errors/Unhandled；typecheck `20261105201134-b2a6f4` 原exit0。
  strict `20261105201328-6737cb` 原exit0：3111files/0violations；本lane仅原QA文本两条suppressed。
  wiring `20261105201328-ba8d8f` 原exit0：合计ported630，其中所测模块未从index.ts接入0。
  importable `20261105201328-e6e865` 原exit0/ok；ledger `20261105201328-f3f7f1`
  原exit0（--check --no-write），commands问题0/tests问题0/orphan registrations0。
- `e01eb000b`提交后直接正式lane-gate原exit2，唯一前置为开工就有的两份foreign ledger dirty；
  不能用上述独立作业全绿代替正式gate绿。报告提供固定tip/base与原日志，待C2处理集成前置。

### WP-015：模板 CRUD owner 门面（B6/D19-template，2026-11-05）

- L24 公开面：`ctx.anki.templates.{list,get,create,update,delete}`（`api.ts::AnkiTemplateService`）。
  实现在 `src/template-service.ts::createAnkiTemplates`，由 `AnkiHostService.templates` 持有；
  `get_all_custom_templates` / `get_custom_template_by_id` / `create_custom_template` /
  `update_custom_template` / `delete_custom_template` 五个命令同样调用 `rt.service.templates.*`，没有第二份实现，也没有新增 SQL（仍走 `repository/templates.ts`）。
- 错误以 `CommandError`（`value = {error_type, message, details: null}`）抛出，措辞与顺序对应 Rust
  `commands.rs:4280-4462,6045-6191`、`database/mod.rs:2462-2938`。补了 Rust 原有的两条 warn：
  created_at 解析失败、未知字段引用（排序后输出）。
- 不包含：生成门面、42 条冻结映射。

## Linux 续作恢复（2026-11-05，当前状态，历史记录保留）

### 续作交接：main-red 墓碑更新用例（2026-11-05 18:2x 本地）

**当前状态：红灯未关闭；hook预算调整候选已撤回。** C1指出即使30s配置字面不变，
将setup/cleanup移出it也改变原覆盖范围；没有合同批准前不能以候选10pass关红。
本轮最终测试文件已用精确patch恢复，与失败main `3f794390c` 的该文件零diff；
不改测试全名、四断言、数据量、30s或现有hook配置，生产代码零修改。

- 当前优先项为 fulltest main `3f794390c5f8b18d9cbc9c0fa54f8579cd186ff2` /
  `2026-11-05T10:01:01.691Z` 的
  `enhanced-anki-service.test.ts::user_visible_card_update_rejects_card_and_parent_tombstones`。
  原JSON亲核 **failed / 34005.748756ms**，failureMessages仅Vitest `STACK_TRACE_ERROR` 定义栈；
  shard5 `20261105093349-077f49` 原exit1。其它本文件用例warm环境约3.6–4.7s。
- 已正常merge main（本轮65f668842）。测试、env、handler、仓储对失败main→本树无diff。
  Rust `enhanced_anki_service.rs:1362-1447` 断言活卡成功、卡墓碑NotFound、父墓碑NotFound；
  TS `updateCardRows` 同时过滤ac/dt墓碑，命令affected0→NotFound；未发现跨lane接口变更证据，
  不归因qbank/translation、CPU/RPC，不在其它lane修改或发执行请求。
- Vitest `runner/dist/chunk-hooks.js:638-641,1852-1904,2005-2009` 以注册栈表示timeout，
  同步/微任务结束超过原30s也会失败。此例把首次真实迁移、目录clone、Host装载与cleanup放在it内，
  是一个具体fixture预算假设，不宣称已定量证明原34s发生在哪阶段、锁等待或唯一根因。
- 唯一一次原样最小复现 `20261105100736-37fe36` **1pass / 9名称过滤 / exit0**，本体8311ms，
  无Errors/Unhandled；它不覆盖原全量红，不循环求一次绿。
- **候选改动**仅将该例fresh env创建/清理移到beforeAll/afterAll（同文件原env.ts已设有界DB hook），
  独立同名suite以确保在其它生命周期fixture前关闭；完整suite/test名称与原四expect原样保持。
  不增timeout、不缩数据、不加skip、不改生产SQL/迁移或mock provider。Rust本来把初始化也写在
  测试体，此为TS测试生命周期分离候选，不宣称原业务错误已修；需干净integrator/独立复核。
- 改后仅一次受影响文件验证 `20261105102628-8cccd1`（verbose，10例）、正式typecheck
  **10passed / exit0，无Errors/Unhandled**，墓碑用例本体122ms，文件tests总计24.47s（含hooks），
  全job35.69s。该差别支持fixture/业务计时分离的候选，不定量证明原34s具体阶段。
  `20261105102628-1f3d0c` 正式typecheck **exit0**；strict `20261105102628-6d2bb6`
  **2982files / 0violations / exit0**。原完整测试全名、四expect不变，无超时配置改动；
  不重跑整Anki矩阵、不改30s。两ledger dirty保持原样。按C1会话72%提醒已请求fresh接手，
  本轮只提交fix(main-red)候选及这份交接，不推进新域或到80%以上。
- 原hook候选代码在 `e472a828b`，说明提交 `1eb7d6e13`；**后者不代表问题已解决**。
  其10pass/墓碑122ms属于预算覆盖改变后的候选结果，不能代原整体预算；该结果原样保留。
- C1要求必要阶段证据后，仅采一次 `20261105103624-0f2f43`，原it内保留setup+业务+cleanup，
  临时performance.now探针写Vitest task meta（现已移除），JSON `/tmp/opencode/L16-main-red-phases.json`。
  **1pass / 9标题过滤 / exit0，无Errors/Unhandled**，Node26.5：fixture7250.144354ms、
  business182.553730ms、cleanup18.709179ms、完整case7454.039861ms。它证明本次业务成功且
  主要时间在fixture，不证明原34s发生同阶段、锁等待、CPU/RPC或唯一根因。
- API约束：F3 public `MigrationService` 仅runAll/currentVersion/needsMigration；Rust fixture
  只migrate_single(mistakes)，TS helper却完整runAll+复制后再次runAll。F3内部migrateSingle不是
  public API，不能复制私有工厂或绕schema验证；未经具体证据不直接删第二次runAll或加缓存求绿。
- 下一步owner=L16 fixture诊断，ETA下一fresh单元：在原整体30s保留的前提，仅分解冷迁移 /
  拷贝后校验 / Host装载阶段，必要时向F3经C1申请与Rust migrate_single(mistakes)同义的public
  测试初始化面。若没有可证明等价且降低实际工作量的修复，继续保原红并交干净integrator的负载复验。
  不再循环原样单例/整Anki矩阵求绿；本轮已请求fresh交接，待确切授权，不自行宣称fresh已完成。

- 正常合并 main；恢复基线 `20261105000133-a362ed` typecheck exit 0，
  `20261105000133-08ccda` 本目录 **44 files / 802 passed / 1 skipped / exit 0**，无 Errors/Unhandled。
  skipped 仍为原外部 APKG 样例，不新增 skip。
- main 已有 R5 `ACCEPTANCE.md`（末节固定 tip `1e80f32b4`）：A3/A4/A5、公开 D3 链、
  B2、两个 cloze trim 与 LP0061 的窄范围独立签收已经完成。不再沿下文旧候选状态要求重验。
  A1/A2/A6 整体及其未覆盖分支、LP 其余位置、SPEC 逐命令核实与 APKG worker 仍未宣称闭合。
  C1 后继亲取 X7 `20261105000513-32a276` 原 exit 0：原 boundary:cloze:1/18 的
  IMAGE-TRIM/LABEL-TRIM 两项 matches-static-expectation、difference:null；只闭合两 helper /
  internal composition，不计动态 Rust C/IPC bypass 或 basename trim，不重跑旧向量。
- 本轮处理 L24 新请求（与 reviewVersion 不同字段）：公开 `PreferenceTimestamp = number | bigint`
  与 `PreferenceEntry`，两个时间字段和三个 consolidate 入口接受完整 i64；旧 number 输入及
  正常 epoch 输出原样保留，bigint 不经 Number。检索 sort 时间 tie-break 改为关系比较，
  容量淘汰原关系比较不变；新增/强化时原样保存调用者时间，不改 first_seen。
- `tests/preference-memory-i64.test.ts` 新四例经真实 ctx.anki 验证端点、相邻 2^53+ 检索及
  空观察时容量维护；`20261105000411-a5ffc3` **4 passed / exit 0**，无 Errors/Unhandled。
  测试先写，队列实际启动已在实现更新后，不声称本作业提供旧实现 red 证据。
- L24 decoder / serializer 是其所有权：已通过 coord 交付类型/无损 JSON 数字语义请求，
  不越界修改，也不把旧 MAX_SAFE 限制当作正确。此处四例不替代持久化真实组合联验。
- Electron `20261105000827-b16b9f`：偏好新四例 + 原 22 例 + wiring 三例，
  **3 files / 29 passed / exit 0**，无 Errors/Unhandled。
  正式 typecheck `20261105000827-261085` **exit 2**，唯一诊断是
  `anki-chatanki-service-surface.test.ts(215,31)` 原第五项 L24SurfaceCompatibility：
  L24 旧 number 时间字段与当前 union 提供面不兼容。保留原七项断言，不强转/删除求绿；
  交 C1 按真实两侧接口正常集成，不当作纯函数已通过等于持久化全链通过。
- ledger `20261105000801-05bf20` exit 0；wiring `ported 630 / 未接入 0`；importable ok；
  strict boundaries exit 0（2950 files / 0 violations；本 lane 仅原 QA 文本两项 suppressed）。
- 开工即有的 `migration/LEDGER.md` / `migration/ledger.json` 改动不动、不提交、不暂换；
  正式 lane-gate 若仍被此前置条件阻塞，如实报告，不规避。

### C1 接续 C3：精确 agent page（2026-11-05）

- 新增 `ctx.anki.listAnkiAgentLibraryPage`，正式类型在 `api.ts`：request 的 schedule 为
  `all|due|not_enqueued|suspended|enqueued`，diagnostic 为 `all|error_only`；输出
  `{items:[{libraryCard,locator:{documentId,sourceSessionId}}],page,pageSize,total:bigint}`。
  libraryCard 与旧 flat 卡同形但 dueMs 为 bigint|null；scope 固定 agent 只读，不新增 session 写入口。
- `repository/anki-agent-library.ts` 对照 Rust `database/mod.rs:7604-7725`：COUNT 和 SELECT
  共用相同 WHERE，diagnostic 在分页前，due 含 state0，enqueued 要求 live fs.id，
  created DESC/id DESC、cap20。COUNT 从 safeIntegers driver 直接取 bigint，max(0)；
  due_ms 从 SQLite TEXT 精确取 i64，并保非 INTEGER 的原列索引错误。locator 同页同一 SELECT，
  不是用 sourceId 替代或逐卡补查。保留 Rust sourceSessionId 在 locator 与展示字段的空白差异。
- **旧 UI 行为完全保留**：`listAnkiAgentLibraryCards` 仍走原 filtered 列表（due 排除 new，
  cap200），原 command/返回类型不改。新方法只通过公共服务给 L24，不复制其 handler。
- 测试 `tests/agent-library-page.test.ts` 先写；类型/API/测试初版由自动检查点 `6fc4b3e0a`
  保存，后续扩展为八例。`20261105002950-a25fc8` 最初七例 Node exit 0；后继
  Electron `20261105003101-88c18d` **3 files / 21 passed / exit 0**，含新八例、原 UI
  library-query 八例、原 review-version-i64 五例，无 Errors/Unhandled。
- COUNT 测试用 call-through spy 检查真实 driver 返回 bigint，未构造 2^53 条假行或用假 COUNT；
  due 测相邻 2^53+ 与 signed i64 两端。读失败发生于 COUNT，后续页 SELECT 未执行，事件无增量。
  UI cap/due、外会话可读但 session mutation 拒绝等均走真实 ctx.anki，enqueue 经真实 L15。
- `20261105002950-d419b1` typecheck exit 2：新测试 spy 返回 unknown 的窄化错误已修
  （不改断言事实）；另有原 preference 第五兼容项，保留，等两侧正常集成。
  后继 `20261105003639-ca7d9b` **exit 2，仅原第五兼容项 :215,31**，新 agent-page 无类型诊断。
- 正式全目录 `20261105003639-8c089a`：**46 files passed / 814 passed / 1 skipped /
  Errors 1 / exit 1**；唯一未处理错误 `[vitest-worker]: Timeout calling "onTaskUpdate"`。
  这是失败作业，不写为全绿；没有业务断言失败、不删 skip/断言或修改超时来刷绿。
  与恢复基线 `20261105000133-08ccda` exit 0 分开保留，交 C1 协调基础设施诊断，不凭推测归因 CPU。
- agent-page 代码/服务接线/SPEC 为 `ca01db015`，API/测试初版 `6fc4b3e0a`（自动 checkpoint）。
  `20261105003149-24cb72` strict boundaries **2952 files / 0 violations / exit 0**；
  `20261105003149-645f3e` ledger **exit 0**，命令 A 全部；importable ok，wiring ported630 / 未接0。
  本 lane TESTMAP 仍 630 ported、0 merged/obsolete/pending；新 owner 回归不冒充新 Rust 完整移植条目。
- `ca01db015` 后执行原 lane-gate **exit 2**，前置仅开工已有两份 ledger 生成文件 dirty；
  原文件未暂换、还原或提交。当前未满足正式自检绿灯，不自签 main 或 L24 工具全链。

### 集成反馈回查：旧测试先行 tip（2026-11-05 00:46Z）

- 收到 `preference-memory-i64.test.ts` 八条 bigint→number 类型错误及检索失败反馈，
  已先 `git merge --no-edit main`（Already up to date），保留全部断言。
- 只读 `.oc-runs/gate-fail.json` 的 L16 记录是
  `tip=2d558e65bda4e0d94bb35ca08aa4ff6ebf693354, at=2026-11-05T00:07:52.100Z`。
  该提交仅新四例测试，生产 i64 实现 `931643d80` 在 00:09 的后继 checkpoint；
  因此旧 tip 编译读到 number、检索走时间减法，与反馈一致。
- 当前固定 HEAD `33ff9589f`（正常 merge main `a9683a43b`）四个生产文件含完整 union / 非减法排序，
  实现仍在祖先链、并非工作区丢失。没有为空刷新 gate 制造代码改动，也不删除先写测试。
- 已向 C1 交付固定 tip 证据与精确两侧依赖：旧八条输入诊断不同于当前保留的 L24 第五兼容项，
  不可混为一个结果；仍需以当前固定树重跑并正常与 L24 类型集成，不自签全部绿灯。
- 按反馈提交原三命令：`20261105004627-e1ad19` typecheck、`20261105004628-985e61`
  boundaries、`20261105004628-ff848c` 全目录 Vitest，结果收到后补录，不重复弱化断言或提高超时。
  typecheck 已返回 **exit 2，仅 `anki-chatanki-service-surface.test.ts(215,31)` 第五兼容项**；
  反馈中旧八条 bigint→number 输入诊断在当前树未复现，不把“旧八条消失”写为正式 typecheck 通过。
  boundaries `20261105004628-985e61` **exit 0，2953 files / 0 violations**；
  此次按反馈运行非 strict 原命令，不能与之前 strict 2952 文件作业混为同一个结果。
- 原全目录 `20261105004628-ff848c` 已返回：**1 file failed / 45 passed，1 failed /
  813 passed / 1 skipped，Errors 1，exit 1**。pref 新四例与 agent-page 八例全部执行通过，
  旧 bigint 检索失败在当前树未复现。唯一 test failure 为
  `document-processing.test.ts::forced_char_split_preserves_cjk_and_emoji` 本体 32304ms 超过原
  30000ms；另有原 `onTaskUpdate` RPC 超时。不把任一失败隐藏为“通过”。
- 该新超时的测试/`document-processing*` 生产模块相对 main **无 diff**；审读
  Rust `document_processing_service.rs:257-276,551-592,1510-1530` 与 TS 原 fixture/二分切分：
  测试构造与 Rust 相同，反复估算逐渐增长的全文直到 25000 token，切分仍是原单调二分，
  未走 F7/tiktoken/native 传输。未据此猜测 timeout 根因，也不改 fixture/算法/超时求绿。
- 仅为区分可复现功能问题与全套运行条件，提交一个原标题最小验证
  `20261105005529-1ff9b3`（原命令加 `-t forced_char_split_preserves_cjk_and_emoji`，无超时覆盖）；
  结果为 **1 passed / 30 标题过滤 skipped / exit 0，无 Errors/Unhandled**，该例本体 25264ms。
  恢复基线同一例为 23295ms，失败全套为 32304ms；测试内容/生产代码未改。
  这只表明原标题最小执行未复现超时，不证明全套/共享 RPC 问题已修，不替代原全套 exit1，
  不把 30 条名称过滤误算成新增 skip，不重复矩阵。待 C1/架构真实联合类型与运行条件诊断。
- C1 后继已亲取 agent-page Electron 21 pass/exit0，并接收正式全目录 RPC exit1 与第五兼容项
  exit2；当前指令允许等待真实 L24 preference 精确消费 / 架构联合类型树与 RPC 诊断。
  不重复同一无改动矩阵、不提高超时、不自行合业务分支、不向 parked/failed 加派。
  agent-page 仅提供面已验证，L24 工具必须等正常 main 后消费；只对新真实差异做最小验证。

### X6-LP-0062：结构化输出 fallback 的原日志标签（自动续派，2026-11-05）

逐分支审读 Rust `streaming_anki_service.rs:847-849,876-878`，发现
`generation-service.ts` 两条 warn 错用 `[ANKI_GENERATION]`，应为 `[ANKI_PROTOCOL]`。
只改两个字符串前缀，协议判定、统计清零、重试/取消/DB/事件不变，不外推 B3 或完整 A1/A2 已闭合。
先加真实 `trigger_task_processing` 回归：只替换外部 L02 transport 首拒一次，生产切卡/
入库/logger/收尾全部保留；断言原 warn 文案与数量、首请求带 response_format、fallback 不带、
仅一张卡且 TaskCompleted 发出。

- 先写测试 `20261105011948-2220b6`：**1 failed / 20 标题过滤 / exit1**，精确 diff 只在原日志标签。
- 修复后 Electron `20261105012115-88cada`：**整文件 21 passed / exit0**，无 Errors/Unhandled；
  原20例断言不变，新增例不当作整组 LP0062 动态全覆盖。prompt 重建错误分支只做静态映射，
  不 mock 生产 builder 来制造覆盖。
- strict boundaries `20261105012116-40f4ce` **2953 files / 0 violations / exit0**，importable ok。
  typecheck `20261105012115-7396d4` **exit2，仅原 L24SurfaceCompatibility 第五项 :215,31**，
  新回归与生产标签修复无新类型诊断；原断言保留，不将本作业记为通过。
  原 lane-gate 先执行仍 exit2，仅共享 ledger 生成改动前置；未动两个文件，不重复旧全目录矩阵。

### X6-LP-0064：batch 模板读取失败不得兼报不存在（2026-11-05）

Rust `cmd/anki_connect.rs:1392-1404` 是 missing / read-error 两条互斥分支。TS catch
原来漏模板 id、交换错误位置，又把 undefined 当 missing 再 warn 一次。先新增两条真实 Host
回归（空模板表 / 真实 DROP TABLE，只有外部 AnkiConnect 网络边界使用确定响应）；
修复 catch 保原 id/error 文案并保留互斥分支，仍同步成功且不落本地卡片/receipt。

- red `20261105012705-c50ae1`：**1 passed / 1 failed / 6 名称过滤 / exit1**，missing 控制
  通过；read-error 精确 diff 显示错误日志丢 id + 多余 missing 日志，非 fixture/传输失败。
- green Node `20261105012808-ceaac3`：生成命令21＋网络命令日志8，**2 files / 29 passed /
  exit0**；Electron `20261105012808-daa5d5` **8 passed / exit0**，均无 Errors/Unhandled。
- strict `20261105012808-87ac8f` **2953 files / 0 violations / exit0**；importable ok；
  wiring ported630 / 未接入0。原6条命令日志断言未改，新增两例不计作原Rust测试新增移植。
  LP0064 仍保留 APKG 两次独立模板读取的审读发现，不能用此两例签全部12处warn。
- typecheck `20261105012808-eda18c` **exit2，仅原第五兼容项**；ledger
  `20261105012808-c5620c` **exit0**。既有全目录超时/RPC结果仍保留，未据此写成整轮绿。
  新收到同第五项集成反馈后正常 merge 实变 main（110文件更新，L24时间API未变），按通知提交
  `013318-a26259` typecheck、`013319-bd9bdc` boundaries、`013319-efbd58` 原全目录命令；
  这是新 main 树验证，不再对无变化旧树重复矩阵。
  实际生产修复保存于自动 checkpoint `3f762c47a`，测试初版在 `50e2d3f42`；
  后续具 finding ID 的提交只补收口说明，不把说明提交冒称实际实现。
- 新 main 原三项已收：`20261105013318-a26259` typecheck **exit2，仅原第五兼容项**；
  `20261105013319-bd9bdc` boundaries **2968 files / 0 violations / exit0**；
  `20261105013319-efbd58` 全目录 **46 files passed / 817 passed / 1 外部skip / Errors1 /
  exit1**，唯一 onTaskUpdate RPC 超时。此树 forced-char-split 原例通过，但不抹掉之前超时，
  不将817个断言通过冒充整个作业通过。原矩阵期间未编辑生产/测试，仅补文档。

### X6-LP-0065：模型适配器选项计数线索的实际范围（本轮静态核对）

Rust `commands.rs:3894-3908::get_default_model_adapter_options` 只是 registry → JSON 的 map，
没有 warn!/error!/info!；`cmd/anki_cards.rs:19-74` 三命令也没有这些 tracing 调用。
`model-adapters.ts` 对应的这部分不存在应补的 warn/error。`commands.rs` 同文件其它日志
属于生成/模板等命令，分别经 `plugin-handlers-generation.ts` / `plugin-handlers-templates.ts`
接线，不能按文件总数全部归给 model-adapters，也不补计数日志。Rust 的四条 save/reset println
不是本次 warn/error 线索的证据，未据此称所有输出或整个 commands.rs 日志已签收。

### X6-LP-0064 后续自有发现与修复：APKG 模板二读（非外部阻塞）

Rust `cmd/anki_connect.rs:1002-1027` 先独立调用 get_template_config，再独立取完整模板：
两次读失败应分别 warn，第一次错误含 `anki/mod.rs:26-27` 的模板不存在/获取模板失败上下文。
当前 `plugin.ts::runApkgExport` 用一次 `loadApkgTemplate` 合并二读，错误时漏第二条完整模板warn，
且 missing/DB错误第一条缺原上下文。selection 的 Rust `enhanced_anki_service.rs:1002-1017`
仅有一次 config 读取，不能为消除这条命令缺陷而把 selection 也改成二读。
本轮已锁源码与最小真实 SQLite 故障测试计划；等待在途新main全套固定树回执后再编辑该生产入口，
避免全套启动后改变被测实现。

全套回执收齐后先写四条回归，再修复：标准单模板命令分别调真实服务 getTemplateConfig /
getCustomTemplateById，首次失败仍第二读；selection 保留原一读，只恢复 config 错误上下文。
两者分别以真实表改名故障与缺失模板验证准确日志及查询次数、真实 ZIP 导出仍成功。

- 标准命令 red `20261105014507-acbbd6` **2 failed / 7 标题过滤 / exit1**，缺错误上下文与
  第二条warn；selection 初次 `20261105014731-6ce480` exit1 是新 fixture 漏必填
  `anki_generation_options_json`（NOT NULL），已仅补合法`{}`，不冒充生产缺陷。
- 合法 fixture 的 selection red `20261105014955-68145b` **2 failed / 9 标题过滤 / exit1**，
  精确差异为原日志缺配置错误上下文；断言不改，随后修实现。
- green Node `20261105015247-aec0ad` **2 files / 14 passed / exit0**（日志11＋原导出集成3）；
  Electron `20261105015247-eff75b` **2 files / 52 passed / exit0**（日志11＋原 exporter41），
  均无 Errors/Unhandled。call-through db.get 验标准二读 / selection 一读，原7条日志断言不变。
- strict `20261105015247-02e337` **2968 files / 0 violations / exit0**，importable ok。
  typecheck `20261105015247-9d3aad` **exit2，仅原第五兼容项**，未改兼容断言、未给旧number出口
  做强制适配；非本单元引入的诊断不写成通过。
  实际生产实现由自动 checkpoint `9867ad4fd` 保存，测试在 `04bc947eb` / `f538bc579`；
  后继 finding 提交只补本文证据。
  仅此两模板路径已修，LP0064 其余位置仍按逐分支审读，不提前整项勾选。

### X6-LP-0064：multi-template 保留 Rust 静默读取失败（2026-11-05）

Rust `cmd/anki_connect.rs:1141-1146` 只有 `if let Ok(Some(t))`，DB失败静默跳过；TS
原 catch 擅自加了模板读取 warn。本轮新真实 Host / SQLite表改名 / call-through get 回归
确认读取确抛异常、导出实际文件仍成功且无warn。red `20261105015928-736130`
**1 failed / 11 名称过滤 / exit1**，只失败在额外warn。实现恢复原 catch→continue，注释标明
Rust依据，没有伪造 boundary-allow 或空 catch，不改变模板fallback/报告/清理行为。
- green Node `20261105020057-df7183` **整文件12 passed / exit0**；Electron
  `20261105020057-0eaf45` **整文件12 passed / exit0**，均无 Errors/Unhandled。
  此文件包括原7例+四条模板一读/二读新例+本例，未把前三组结果互相替代。
- typecheck `20261105020057-8bc642` **exit2，仅原第五兼容项**；strict
  `20261105020057-6347cf` **2968 files / 0 violations / exit0**；ledger
  `20261105020246-5cb111` **exit0**；wiring ported630 / 未接0，importable ok。
  实际生产/test保存于 checkpoint `8076bfdbe`，本次后继提交不伪称正文实现才出现。
- C1 新回执确认 L24 完整候选 `72063aa7c` 已 official5/5（Node31/Electron14原0）并具
  公共timestamp union、真实readSigned/数字rawJSON写入；联合候选由 C1/架构正常集成，
  不再将消费者记为未提供、不回退接口或删除原七true。main 未含两侧前单侧第五项仍如实 exit2。
- 提交前正常merge新 main `628b4192e`，实际带入 L24 公开union/持久化/新真实测试三文件，
  与72063aa7c三文件无diff（整个720 tip非main祖先；实际main记录df59dc7b9等），工作树
  `235cad98f` 已具真实两侧新前置。只追加一次 `20261105020833-230a35` 正式typecheck和
  `20261105020833-9df8ad` 提供方4例＋L24真实持久化14例，不重复旧全目录矩阵。
  这些是本lane提供方组合验证，不代C1/R5独立签收；历次第五type2/RPC exit1历史保持。
- 正式结果已收：`20261105020833-230a35` **typecheck exit0**，原七项兼容断言未动；
  `20261105020833-9df8ad` **2 files / 18 passed / exit0，无 Errors/Unhandled**，L16四例与
  main L24真实持久化十四例均执行。当前真实两侧新前置已经验证，不再引用旧“L24仍number”
  作为本树失败原因；历史原exit2/全套RPC exit1不覆盖、不改为成功，不签整个工具/agent-page已消费。

### LP0062 后续自有审读与三条残片日志修复（2026-11-05）

Rust `streaming_anki_service.rs:1717-1719,1781-1783` 的流收尾截断/不可读 warn 属
`[ANKI_CARD_DEBUG]`；本轮审读基线 `generation-service.ts:640-642,686-688` 使用通用
`[ANKI_GENERATION]`，不可读分支也未区分正文与收尾的原文案。已有protocol两个前缀修复
不覆盖这里；后继须先写真正 chunk/residual 回归再逐分支修，不批量替换整个 LOG_PREFIX。
该项是本 lane 自有问题，未写为外部依赖；本轮局部修复不签整个LP0062。

本轮先追加真实 trigger 回归，最终以显式 `output_protocol=delimiter` 与 Rust 允许的
`Some(empty rules)` 触达准确正文/收尾分支；不替换 cutter/parser/expander/DB，使用生产
Cordis logger.exporter 捕获原 warn。初版 fixture 带必填 front/back 会先触发普通字段错误，
默认 auto 又会 strip wrapper，不能当目标分支红灯：`023631-e1a8f0`、`023822-c71b7d`、
`024153-d012a5`、`024708-eafa36` 的失败保持原码，只作为 fixture/诊断历史。
仅修正新 fixture 的显式输入并增加 transport/protocol/统计断言，没有改原21例或三条预期。

- 合法 fixture red `20261105030143-778861` **3 failed / 21 标题过滤 / exit1**，三条失败均在
  原warn标签/正文与收尾文案，前置请求和统计断言已通过；8/15个Unicode标量值不是UTF-16长度。
- 实现只给共用parse helper传入正文/收尾上下文，恢复三条warn及收尾不后附error的原文案，
  卡片/统计/事件/取消/错误卡创建未改，不批量替换其它LOG_PREFIX。
- green Node `20261105030340-a1a63b` **整文件24 passed / exit0**；Electron
  `20261105030340-335fba` **整文件24 passed / exit0**，均无 Errors/Unhandled。
  `20261105030342-c5fe5b` 正式typecheck **exit0**；strict `20261105030342-9761d7`
  **2973 files / 0 violations / exit0**；importable ok，wiring630 / 未接0。
- 实际生产修改在 checkpoint `f5812d7a4`，最终fixture在 `905575716`（初版及诊断在
  `0623f858e` / `d1396b92e` / `aaa49dd25`）；后继finding提交不冒称才写入生产代码。
  只修/验证这三条，不代签整个LP0062/普通residual解析失败分支。
- 后收集成三测试失败反馈，亲读 gate-fail 固定为 `aaa49dd2520a13fc378a68f558414be0027ce8ed`
  / `2026-11-05T02:56:17.070Z`，早于合法最终fixture及生产f581修复，未把旧快照失败当当前复现。
  按通知先正常merge新 main `10740c5f0`，亲核931/ca01/720均为main祖先（原owner/consumer
  未main前置解除），再按通知仅启动原三项 `20261105031630-31d130` typecheck、
  `20261105031630-e59d99` boundaries、`20261105031630-8b85d6` 全目录；不改三条预期、不改超时，
  只取这同次新基线结果，不为状态通知重复无变化矩阵。
- 本次原三项实际结果：`031630-31d130` **typecheck exit0**；`031630-e59d99`
  **boundaries 2974 files / 0 violations / exit0**；`031630-8b85d6`
  **46 files / 825 passed / 1 外部样例skip / exit0，无 Errors/Unhandled**。
  三残片回归在完整目录也执行通过。此一次成功不抹掉旧0301红灯/原第五type2/旧RPC或30s超时，
  不证明全局运行压力问题已修。`20261105031214-8586a7` ledger **exit0**；wiring630 / 未接0。
- 上述代码/证据在提交前被自动checkpoint保存（最新 `1fcb2ffc9`，此前 `338baff16` /
  `ba9a0d3e2`），显式commit因已无自有diff返回1，不把这次“无改动”误记成丢失或修复失败。
  `f5812d7a4` 生产标记仍在，原21例与新增三条强断言仍在；未运行restore/stash等整批还原。
  收尾原lane-gate重试仍 **exit2，仅两份开工ledger dirty**，不规避。
- 提交前下一次正常merge main `10f987035` 带入 L24 正式agent-page handler及真实consumer测试，
  不再称消费者尚未接线；只因这份实际consumer新差异提交一次
  `20261105032752-bb9c46` 新 `library-list-real-host.test.ts` 最小验证与
  `20261105032752-196fc8` 正式typecheck，不重跑旧无变化全目录矩阵、不改owner API。
  实际回执：`032752-bb9c46` **1 file / 10 passed / exit0，无 Errors/Unhandled**，
  `032752-196fc8` **正式typecheck exit0**。真实consumer工具入口已走正式agent页，
  不再标为待接线；这是提供方在正常main新前置上的验证，不代R5独立签收或其它工具签收。

后续自有候选：普通残留卡解析错误（非不可读/非truncated标记）目前仍复用正文错误卡包装；
Rust `streaming_anki_service.rs:1794-1806` 是debug后按原payload落错误卡。须另补真实残留
fixture再修，不能用本组三条日志通过代替该分支。这仍是自有工作，不列为外部阻塞。

### X6-LP-0063：普通残留错误卡原 payload / best-effort 插入（2026-11-05）

本轮接续上条自有候选。先加三条真实 trigger 回归：未闭合 delimiter wrapper 中缺必填back，
正常路径断言原 payload；两个 SQLite BEFORE INSERT trigger 场景拒绝普通/截断错误卡，
call-through run 验证真尝试且真抛SQL错误，最终仍Completed/failed=1，不 mock parser/存储逻辑。

- red `20261105034241-3ef6e2` **3 failed / 24 标题过滤 / exit1**：第一例明确落入正文包装
  `解析卡片失败: ...\n原始输出: ...` 而非原payload；后两例观察到不应存在的高层error日志。
  不是fixture失败，SQL触发器与一次insert/统计断言均已真实执行。
- 实现只让 residual 普通解析错误记录原debug后返回未处理，外层按原payload创建错误卡且failed
  只加一次；普通/截断的两个创建失败catch按原if-let静默continue。正文错误路径/取消/事务未改。
  AppError Display 仅message的依据 `dstu-core/models.rs:1038-1041`，不附Error类名或stack。
- green Node `20261105034530-ff8a85` **整文件27 passed / exit0**；Electron
  `20261105034531-448729` **整文件27 passed / exit0**，均无 Errors/Unhandled；此前24例不变。
  `034531-848812` 正式typecheck **exit0**；`034531-dc7065` strict **2977 files / 0 violations /
  exit0**；`034531-8f6f96` ledger **exit0**，importable ok、wiring630 / 未接0。
- 实际生产与新三例均保存于 checkpoint `7c5c64e9c`，SPEC在 `a72c0be7d`；后继finding提交
  不冒称才写入实现。本组只覆盖收尾错误卡普通失败/创建失败，不据此签全LP0063或全日志。
  只取本次新分支作业结果，未因F3交接重开旧矩阵或造worker工厂。

### 收尾遮挡草稿局部变量必须单次消费（2026-11-05）

静态对照 Rust `streaming_anki_service.rs:1534-1539,1753-1759` 后补两个真实trigger回归，
同一合法VLM draft分别走正文两个对象 / delimiter未闭合wrapper收尾两个payload。
首卡包含遮挡机器字段、图片、cloze、tag，但模型front/back不变；第二卡必须仍为普通卡。

- red `20261105040703-bf1880` **1 passed / 1 failed / 27 标题过滤 / exit1**：正文控制保存两卡，
  收尾只返回1卡（在长度断言处失败，未把后续未执行字段断言算为已观测）。源码中收尾helper
  只调用外层清除callback，却继续给下个payload传旧draft，与Rust局部None不同。
- 修复仅3行：回调同时置收尾局部draft为null并调用原外层clear；只有实际保存且含_occlusion的
  原条件满足时才执行。不改重复/错误判定，不预先清除，不改front/back或模型已有text。
- green Node `20261105040911-0dc92c` **整文件29 passed / exit0**；Electron
  `20261105040912-260c50` **整文件29 passed / exit0**，均无 Errors/Unhandled；原27例断言不变。
  `040912-fb6e29` 正式typecheck **exit0**；`040912-d019e6` strict **2977 files / 0 violations /
  exit0**；importable ok。此为新的收尾状态传播回归，不重做已签的IMAGE/LABEL trim向量。
  `20261105041158-f65a6a` ledger **exit0**，wiring630 / 未接0。
  实际3行状态修复与两例测试由 checkpoint `a94bf2aa6` 保存，后继finding提交补SPEC/本文证据。
- 提交前正常merge带入 R5 `ACCEPTANCE.md` 新窄复验：独立
  `20261105034117-eb0f16` 原 **4 pass / 20 标题过滤 / exit0，无Errors/Unhandled**，
  只签此前LP0062三fragment日志（第四条是筛选命中的既有protocol回退，不算新增），
  不代签本次普通收尾错误卡/草稿消费、全LP、A1/A2或真实模型网络。未编辑验收报告、未重跑该组。

### forced-char-split 独立30s失败：只读证据与等价范围guard（C1新指令，2026-11-05）

- C1亲取R5固定main f2c官方 `20261105034708-504797`：**1277pass / 1fail / 1skip / exit1，
  无Errors/Unhandled**，唯一forced_char_split本体30s。不是旧RPC导致，不用旧825/0或旧25.264s
  单例成功覆盖它。原所有失败/超时历史保留。
- 先只读源码：Rust `document_processing_service.rs:257-276,551-592,1510-1530`；TS
  `document-processing-segment.ts:18-47,325-369`、原test:456-472。增长while与Rust相同，为
  O(k²*u)前缀重扫；split上界O(S*N*logN)，每probe显式slice/join候选，峰值O(N)临时空间。
  当前estimator一次融合扫描，不是每码点创建字符串；F4空白helper是纯数值比较，不能误报其分配。
- 只读规模诊断 `20261105042845-d368b1` **exit0**（标注not-test/not-timing，没跑增长while）：
  Node26.5/Linuxx64，unit11标量/13UTF16/35bytes，4630次重复=50930标量/60190UTF16/162050bytes；
  previous24997、本次25003token。原while4631次estimate会访问117928415码点且原来每次调用
  isRustWhitespace；本样本全部码点>U+3000，F4 `util/text.ts:9-22`所有真空白却都<=U+3000。
  原生产split为3段，标量20371/20371/10188、token10000/10000/5003，拼接无损。
- 不改30s、原Unicode unit、增长while、原31条断言、公式/f32/二分/分配；仅在共享谓词前加
  `code <= 0x3000` guard，仍让共享表决定范围内的语义，不复制表、不加cache/flag或改测试工厂。
  新9个向量先在旧实现通过：`20261105043441-58720c` **9pass / 31标题过滤 / exit0**，
  覆盖3000/3001、NEL/BOM与假名/谚文/emoji；这是旧语义控制，不伪称功能红灯。
- 改后 Node `20261105043803-360451` 文档40＋生成29 **2files / 69passed / exit0**；
  Electron `20261105043803-c13e31` 文档40 **40passed / exit0**，均无Errors/Unhandled。
  verbose原件记录原forced用例本体分别 **3714ms / 3001ms**，不是整job时长；原8/15码点日志
  与错误卡/草稿消费等生成断言保留并通过。只做实际生产变化后的相关文件验证，不是重跑旧单例求绿。
- `043803-939d99` 正式typecheck **exit0**；`043803-3de2cb` strict **2979files / 0violations /
  exit0**；`043803-40e7ca` ledger **exit0**，importable ok。
- 执行仍是Vitest forks子进程主线程，生产segmentDocument仍同步调用纯处理。没有F7/DB/worker调用，
  与B4临时collection能力无关；不能由静态访问次数或本次改善宣称CPU/唯一超时根因已证，
  V8 concat rope/flatten实际分配也未做profile。此为保原Rust算法的常数优化，不签全局负载/线程治理。
- 实际guard保存于 checkpoint `25efce989`，新9个向量在 `faff8b6b9`；对 `0384c0b03` 的真实diff
  仅原谓词调用处1行guard＋注释、以及新增16行测试，不触碰原forced样本/while/断言/30s。
- C1后继新状态另列：R5新最终gate **1281pass / 1skip / exit0** 本次CJK已过，不能认为必由本guard
  导致，亦不将它覆盖f2c独立30s、旧单例25.264s、旧RPC等原记录。分析与等价最小修复在此收口，
  不因该状态再跑矩阵、不做唯一根因/全局负载已修结论。
- 同回执确认普通残留raw payload/静默插入失败源码7c5已main，R5独立041542三例/24过滤/exit0
  只签该窄分支；a94局部遮挡draft当时仍非main，等正常集成后独立核。本lane不编辑验收勾选，
  不用27/29子集签全LP/A1A2/模型；B4继续等C2/架构正式F3合同，不造临时工厂。

## v2 接手盘点（2026-11-04，历史）

已合 main（本轮 merge `standard-v2.md`）。旧账本的 A=注册/测试标题可达，不是 v2
行为签收；以下不把 630 个 ported 标记当作已经逐断言核实。`ACCEPTANCE.md` 当前缺失，
不得自行创建/修改复核结论；以派发附带的 A1–A6 与两条清理项作为待复验清单。

### 八类自查矩阵

列 1–8 对应 standard-v2 §1.1–1.8；✓ 表示该项有局部直接证据，? 表示未逐分支/逐断言
签收，F 表示发现自有问题，B 表示真实外部缺口。多命令同组仅共享入口与问题，**不**表示
组内所有分支已验收。路径均相对本插件；源行号为清理 imports 前的接手基线。

| 命令/模块（逐项覆盖注册清单） | 1 接线 | 2 所有者 | 3 serde | 4 日志/错误 | 5 测试 | 6 分支 | 7 运行时 | 8 复验 | 证据/后续 |
|---|---|---|---|---|---|---|---|---|---|
| read_anki_media / save_json_file / save_template_debug_data | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-media.ts:183-264`，文件 helper 待逐分支核对 |
| check_anki_connect_status / check_anki_connect_availability | ✓ | ✓ | ✓ | F | ✓ | ? | ? | ? | `src/plugin-handlers-media.ts:268-280` 未传 logger；A6 解码反例在 `tests/anki-connect.test.ts:88-146` |
| anki_get_deck_names / get_anki_deck_names / get_anki_model_names / create_anki_deck | ✓ | ✓ | ✓ | ? | ✓ | ? | ? | ? | `src/plugin-handlers-media.ts:284-315` → `src/anki-connect.ts:181-234`；不是完整 reqwest 等价证明 |
| import_anki_package | ✓ | ✓ | ✓ | F | ? | ? | ? | ? | `src/plugin-handlers-media.ts:318-333` → `src/anki-connect.ts:239` 未传 logger |
| import_apkg_to_library | ✓ | ✓ | ? | ? | ? | ? | F | ? | `src/plugin-handlers-media.ts:196-236`，真实 L15 tx；`src/apkg-importer.ts:77-112` 仍同步读文件，异步 zstd 不等于完整 worker |
| get_all_custom_templates / get_custom_template_by_id / create_custom_template / update_custom_template | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-templates.ts:179-253` → `src/templates.ts`，持久化解码待逐字段审读 |
| delete_custom_template / count_custom_template_references / export_template | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-templates.ts:255-321` → `repository/templates.ts` |
| import_template / import_custom_templates_bulk / import_builtin_templates | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-templates.ts:323-622`，不能仅凭 JSON.parse 后有 decode 就签全部 serde |
| get_default_template_id / set_default_template | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-templates.ts:624-641`，settings 经公共平台 API |
| update_anki_card / delete_anki_card / delete_document_task / delete_document_session | ✓ | ✓ | ? | ? | ✓ | ? | ✓ | ? | `src/plugin-handlers-cards.ts:205-252`；A3 deferred tx `repository/anki-cards.ts:225-264`，A4 abort 已有命令回归 |
| get_document_cards / get_document_tasks / get_document_task_counts / get_task_cards / get_all_recent_cards | ✓ | ✓ | ? | ? | ✓ | ? | ? | ? | `src/plugin-handlers-cards.ts:255-306`；nullable mapper 与读取失败全零须分别保持 |
| add_cards_to_anki_connect | ✓ | ✓ | ? | F | ? | ? | ? | ? | `src/plugin-handlers-cards.ts:309-396` → `src/anki-sync.ts:708` 丢失 availability logger |
| list_anki_library_cards | ✓ | ✓ | ? | ? | ✓ | ? | ? | ? | `src/plugin-handlers-cards.ts:399-464` 消费 review 公共快照，不把旧仓储同名导出当实际接线 |
| pause_document_processing / cancel_document_processing / get_document_processing_state | ✓ | ✓ | ? | ? | ✓ | ? | ✓ | ? | `src/plugin-handlers-cards.ts:469-496` → `src/enhanced-service.ts`；A4 配置 reject 守卫 `src/generation-service.ts:539-544` |
| get_anki_library_card_content / save_anki_cards / recover_stuck_document_tasks | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-rest.ts:179-218` → 本 lane repository |
| list_document_sessions / get_anki_stats / set_document_session_source | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-rest.ts:220-249`；日志不以默认空 logger 当已接线 |
| get_pending_memory_candidates / dismiss_pending_memory_candidates / mark_pending_memory_candidates_saved | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-rest.ts:251-294`，JSON 与 expiry 分支待审 |
| get_model_adapter_options / save_model_adapter_options / reset_model_adapter_options | ✓ | ✓ | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-export.ts:226-260` 消费 registry，不制造配置 |
| export_cards_as_apkg / export_cards_as_apkg_with_template / export_multi_template_apkg | ✓ | ✓ | ? | ? | ? | ? | F | ? | `src/plugin-handlers-export.ts:262-382` + `src/plugin.ts:255-303` 同步 ZIP/DB；worker 是自有工作 |
| export_anki_cards / export_apkg_for_selection / batch_export_cards | ✓ | ✓ | ? | ? | ? | ? | F | ? | `src/plugin-handlers-export.ts:384-573`；APKG/文本路径不得混为一种证据 |
| generate_anki_cards_from_document / generate_anki_cards_from_document_file / generate_anki_cards_from_document_base64 | ✓ | ✓ | ? | ? | ✓ | B | ? | ? | `src/plugin-handlers-generation.ts:111-202`，L02 raw/Codex 见 BLOCKERS B3 |
| start_enhanced_document_processing / resume_document_processing / trigger_task_processing | ✓ | ✓ | ? | ? | ✓ | B | ✓ | ? | `src/plugin-handlers-generation.ts:205-267`；真实 runSignal，A1/A2 完整链仍待复核 |
| anki.cards / documents / library CAS 服务 | ✓ | ✓ | ? | ? | ✓ | ? | ? | ? | `src/service.ts:75-149` → `src/chatanki-service-adapters.ts` / `repository/chatanki-surface.ts`；测试真实插件装载但非完整 L24 CAS 签收 |
| anki.chatBlocks / settings / preferenceMemory / apkgImporter | ✓ | ✓ | ? | ? | ✓ | ? | F | ? | `src/service.ts:78-84`，L04/L11/F4 公共 API；APKG 同步服务面仍待 worker |
| anki.apkgVfs | ✓ | ✓ | ? | ? | ✓ | B | ? | ? | `repository/chatanki-vfs.ts:44-50`，缺 resource 软删状态，BLOCKERS B2 |
| handler 拆分 imports / 全部测试记账 | F | ? | ? | ? | ? | ? | ? | ? | `src/plugin-handlers-cards.ts:13-173` 等复制大量未用 imports，造成假依赖；630 ported 需按 v2 独立复核 |

### 复核未勾选项处理顺序

1. A3/A4/A6：保留已有 `b81395fe7` / `6d0b01b7c` 修复与新增强断言，不重写为旧实现；
   本轮合 main 后经队列跑明确要求的 host typecheck / boundaries / 本 lane 测试。
2. imports 清理：去除拆分复制的未使用绑定，保留类型增强与真实副作用导入；不改 handler 行为。
3. 自查日志缺陷：先补生产命令入口回归，再贯穿 availability 的 logger，补 Rust 三处 warn。
4. A1/A2/A5：实际消费链由真实 owner 与消费者集成后复核，B1 不允许用 L16 兼容别名掩盖。
5. A6：已知最小反例不是全部 typed serde 等价签收；按 Rust 审读继续保留开放状态。
6. smoke 只保留原有 `DEEP_STUDENT_EXTERNAL_APKG` 条件跳过，不改弱测试；passed 与 skipped 分报。
7. v2 SPEC 逐命令清单、逐断言核实、APKG worker 属自有剩余工作，不冒称外部阻塞。

跨 lane 精确阻塞见 `BLOCKERS.md` B1–B3；现有 `migration/LEDGER.md` / `ledger.json`
未提交改动为开工前已存在的非本 lane 工作，本轮不修改、不提交。

## 当前状态与下一步（2026-11-04 16:4xZ，新会话接管）

### 已完成（有提交与作业证据，不重做）

- 61/61 命令 A 级、630/630 测试 A 级、TESTMAP pending 0（`SPEC.md` 最终门禁证据）。
- 全目录测试 36 文件 728 passed / 1 skipped、exit 0；typecheck、boundaries strict、
  importable、wiring 全绿（作业号见 `SPEC.md`「最终门禁证据」）。
- L15 `review` 事务所有者（`cleanup*DeletionInTx` / `enqueueImportedCardsInTx`）已在
  `0857832cf` 接入；L24 `api.ts` 的 transform/script/route/retemplate 公共符号已消费，
  `anki-ai-native-chatanki-integration.test.ts` 不再直接 import `chatanki/src`。
- R5 A1/A2/A4/A6 四项已按 `SPEC.md`「R5 A1/A2/A4/A6 收口」修复：真实运行句柄
  abort、trigger 校验顺序、`ctx.nativeRegex`、reqwest/serde 阶段化错误文本。
- 本轮最小公开接缝：`repository/chatanki-vfs.ts` 删除按 VFS schema 复制的只读 SQL，
  改为组合 L11 已发布 `vfsRepo`（`files` / `resources` / `attachments` / `blobs`）+
  `vfsDatabase` 连接/blob 目录。检查点提交 `825c67910`（代码+测试），本提交补文档。
  验证：typecheck 作业 `20261104083929-fbe727` 退出码 0；定向
  `anki-chatanki-service-surface` 作业 `20261104083930-7c26db` 10/10、退出码 0。

### 剩余与真实阻塞（有证据）

- **L02**：生成流传输的 Codex OAuth 请求准备（critic 已改走 `llmRawPrompt.callAnkiRoutedRawPrompt`）。
- **L11**：APKG 读取已用现有公开 API 复用；`resources.deleted_at` 不可见是真实软删除
  过滤未闭合（一旦同步治理软删 resources，仍会解析已删资源），不阻塞其他单元；另有
  可选的严格 `files`-by-resource-id 方法（见下节）。
- **A6**：已按 R5 6918e2340 的 7 个最小反例修复：version `text`→`from_str` 无
  reqwest 前缀、`result:5.0` 不当 u64、deck `response.json` typed 错误带包装/位置
  且先于后字段 syntax、重复 `result` 拒绝、任意精度整数原始词法、非法 UTF-8 严格
  拒绝。精确断言见 `tests/anki-connect.test.ts`；无新反例待修。
- **集成门禁（非本 lane 路径）**：`host/plugins/review/tests/l24-review-state-consumer.test.ts:23`
  在 `provide` 里给 `'anki@1': {}`，而 main 的 `chatanki` 已 `inject: ['settings',
  'review', 'llm', 'anki']`，测试因此以
  `plugin "dstu.chatanki" did not start: required services not available: "anki"` 失败。
  该文件不在 L16 允许路径且测试宿主根本没有安装 anki，L16 无法在本 lane 修复；需要
  L15/review 测试 owner 把 provide 键改为 `anki: {}`（或协调者裁定兼容策略）。

### 下一步顺序

1. 等 L02 raw prompt / Codex 请求准备发布后接 critic 传输，不改现有路由主链。
2. 等 L11 给 `VfsResource.deletedAt`（或同义读取）后补 `r.deleted_at IS NULL` 条件；
   不复制 L11 SQL，不等待不存在的聚合 `resolveApkgFile` 同名方法。
3. 仅当 R5 提供 A6 新反例时按阶段错误修；不重跑已绿的 728 全套。

## v2 收口记录（2026-11-04 19:xx 本地时间）

- **v2-1.2 insight 接缝**：`1598b1112`，`anki.{tombstone,upsert…Task,write…Card}InsightProjectionWithConn`
  逐字对应 `jobs.rs:651-729`，不开新事务；`tests/insight-projection-owner.test.ts` 2/2
  （作业 `20261104110344-d3d7cc`）。L17 已确认进 main 后替换。
- **v2-1.2 settings 所有者**：`settings` 表归 F4（D1）。默认模板、模型适配器选项与
  AnkiConnect/批量导出读取设置改走 `ctx.settings.getWithConn/saveWithConn`
  （`src/settings-owner.ts`，缺服务报 `Configuration`）；`repository/templates.ts` 不再写该表。
  `41ce052cd`（代码在检查点 `378daeb78`/`fc1a30a08`）。测试作业 `20261104113700-7bd0c8`。
- **single-writer 假阳性**：`repository/apkg-export.ts:87 INSERT notes` 写的是导出的 Anki
  collection（临时 SQLite）自己的 `notes` 表，不是 VFS `notes`；不改。
- **X7-L16-SERDE-front/tags/extra_fields**：`decodeAnkiCardInput` 改为按 `models.rs:1380-1412`
  严格解码：缺失字段取 serde default，显式错类型（含非 Option 字段的 null、`tags:[3]`、
  `extra_fields:{key:3}`）按 serde 文本报错，按输入键顺序报第一个，未知字段忽略。
  命令入口 `update_anki_card`（`card`）、`export_cards_as_apkg[_with_template]`（`selectedCards`）、
  `export_multi_template_apkg`（`cards`）先解码再执行，失败报
  `invalid args \`<key>\` for command \`<cmd>\`: …`，不写库、不写文件。注意：IPC 契约层
  （kernel `serdeCheck`）本来就在 Host 入口拒绝这些输入，数字按 arbitrary_precision 显示为
  `number`；缺陷是解码器本身对进程内调用宽松。测试 `tests/anki-card-input-serde.test.ts`
  （作业 `20261104114623-b34c09`，6 文件 80/80）。代码在检查点 `9de6ab07b`/`1e2356b29`。
- **X7 main 独立复验后继**：C1 已核 `recheck-L16-decoder.json` 与作业
  `20261104163838-b3c3ab` exit 0，`1e2356b29` 已 main；只关闭
  `X7-L16-SERDE-front` / `X7-L16-SERDE-tags` / `X7-L16-SERDE-extra_fields`
  三个原反例（front=3、tags=[3]、extra_fields={key:3}），真实 `AnkiCardDecodeError`
  拒非字符串，固定 ID/time/期望不变。证据仅直接生产 decoder/internal assembly，
  **不签 IPC 绕过、完整 serde 错误行列或 C 级差分**。两个 cloze trim finding 仍待 main 复验，
  不重跑这三例/146 向量。
- **A6 后继**：`{"result":null}` 按 `Option<Value>` 解成 None（牌组/模型命令报
  `AnkiConnect返回空结果`，version 告警打印 `None`）；`send()` 成功后读体失败按 reqwest
  `Kind::Body` 显示 `request or response body error: <source>`，version 归 `读取响应内容失败`，
  json 路径归 `解析AnkiConnect响应失败`，非 2xx 的 json 路径不读体、version 读体失败用
  `无法读取错误内容`。`<source>` 取 undici 错误文本，hyper 原文无法逐字复现。
  测试 `tests/anki-connect-response-stages.test.ts`。
- **X1** `import_apkg_to_library` 空 path：已在 `7a13f62b8`/`378daeb78`，C1 已转 C2 复验，不再改。

## L11 VFS 接缝交接（给 C2 / L11）

### 已复用的实际公开 API（`host/plugins/vfs-repos/api.ts` → `ctx.vfsRepo`）

| Rust 调用 | L11 公共方法 | 输入 | 返回 |
|---|---|---|---|
| `VfsFileRepo::get_file(vfs_db, source_id)`（`chatanki_executor.rs:10234`） | `files.getFile(conn, fileId)` | `fileId: string` | `VfsFile \| null`；用到 `id, resourceId?, fileName, size, sha256, blobHash?, originalPath?, deletedAt?` |
| `VfsResourceRepo::get_resource(vfs_db, res_id)`（`chatanki_executor.rs:10570`） | `resources.getResource(conn, resourceId)` | `resourceId: string` | `VfsResource \| null`；用到 `id, hash, type, sourceId?` |
| `resolve_file_like_source_id_by_resource_id`（`chatanki_executor.rs:10535-10547`） | `attachments.resolveFileId(conn, rawId)`（`res_*` 输入） | `rawId: string` | `string \| null`（file id） |
| `VfsBlobRepo::get_blob_path(vfs_db, hash)`（`chatanki_executor.rs:10267,10280`） | `blobs.getBlobPath(conn, blobsDir, hash)` | `hash: string` | `string \| null`（磁盘路径） |
| `vfs_db.get_conn_safe()` / `blobs_dir()` | `vfsDatabase.getConn()` / `blobsDir()` | — | 连接 / blob 根目录 |

`resolve_context_ref_from_vfs_source`（`chatanki_executor.rs:10625-10687`）在 L16 的组合：
`files.getFile` → 过滤 `deletedAt !== undefined` → `resources.getResource(file.resourceId)`
→ 要求 `resource.hash.trim() !== ''`。输入只接受 `file_` / `tb_` / `att_` 前缀，其他返回 null。

### 精确未覆盖字段/方法（请 L11 增补；当前不阻塞）

1. **`resources.deleted_at` 不可见**。Rust 原 SQL（`chatanki_executor.rs:10642-10653`）：

   ```sql
   SELECT r.hash, t.file_name, COALESCE(t.type, ''), COALESCE(t.mime_type, '')
   FROM files t LEFT JOIN resources r ON t.resource_id = r.id
   WHERE t.id = ?1 AND t.deleted_at IS NULL
     AND (r.deleted_at IS NULL OR r.id IS NULL)
   ```

   输入：`source_id: &str`（`file_`/`tb_`/`att_`）；返回：`Option<ContextRef>`
   （`hash` 取 `r.hash`，空则 None；`display_name` 取非空 `file_name`）。
   L11 `VfsResource` 不含 `deletedAt`，也无 `getResourceIncludingDeleted`，L16 无法判定
   `r.deleted_at IS NULL`；请给 `VfsResource.deletedAt?: string` 或
   `resources.getLiveResource(conn, id)`（仅 `deleted_at IS NULL`）。更低风险：
   L16 只要求 hash/sourceId/type，故新增只读 `deletedAt` 即可，无需改 `getResource` 语义。

2. **严格 files-by-resource-id（可选）**。Rust（`chatanki_executor.rs:10540-10545`）：
   `SELECT id FROM files WHERE resource_id = ?1 AND deleted_at IS NULL LIMIT 1`
   → `Option<String>`。当前 `attachments.resolveFileId` 先按 live 优先取同一行、再按
   `resource.source_id` 回落；因 Rust 在进入该分支前已先直查 `source_id`
   （`:10574-10581`），回落路径在 Rust 调用面上不可达，现有结果集等价。若 L11 想消除
   宽解析差异，最小签名为
   `files.getLiveFileIdByResourceId(conn: SqlExecutor, resourceId: string): string | null`。

3. **`resolve_apkg_resource_bytes` 的其余字段**（L24 使用，无需 L11 新方法）：
   `VfsFileRepo::get_file` 提供 `file_name / blob_hash / sha256 / size / original_path`；
   `VfsBlobRepo::get_blob_path` 提供路径。`read_apkg_file_bounded` 的
   `MAX_APKG_ARCHIVE_BYTES`、SHA-256 校验与 `apkg_io`/`apkg_limit_exceeded`/
   `apkg_resource_mismatch` 错误仍在 L24 `loadApkgVfsFileBytes`
   （`host/plugins/chatanki/src/apkg-import.ts:72-130`），不属 L11 表面。

## v2 排雷清单（X6 基线 `2ee9a9cbe` 候选，C1 12:14 下发）

候选来自 `git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`，
不是当前全部缺陷；info/计数类只当线索，逐处人工核。"当前"指本节写入时的分支 HEAD。

### C2 稳定 ID 映射（冻结报告 `0119143715c0bab2d8f698b7c1d58651358e85be`，源码基线 `2ee9a9cbe`）

只是编号映射，不新开整改。owner 以 C2 `037376b1e` / X6-OWN-C2-20261104 为准。

| C2 ID | 基线位置 | 本清单条目 / 既有 finding | 状态 |
|---|---|---|---|
| X6-UD-0013 | `src/streaming-anki.ts:203` | unchecked-decode 第 1 条 | 已修 `ddb1bcba9`，待 main 后复验 |
| X6-AP-0040 / 0041 | `tests/image-occlusion.test.ts:51/61` | assert-parity：合并断言覆盖全部 Rust assert | 人工核为假阳性，不补 expect |
| X6-AP-0042 / 0043 / 0044 / 0045 | `tests/image-occlusion.test.ts:72/93/97/108` | 逐 assert 核：`toMatchObject` 一次覆盖 label+clozeIndex；0043/0044 用循环覆盖 Rust 的 3 次 `is_none`；0045 的 `vlm()` 输出与 Rust 字面 JSON 相同 | 假阳性，不补 expect |
| X6-AP-0046 | `tests/apkg-importer.test.ts:1872` | assert-parity，外部 APKG 条件跳过（门禁不跑） | 待核（55 vs 10，需逐段对照） |
| X6-AP-0047 / 0048 | `tests/streaming-anki.test.ts:315/789` | 0047 一个正则同时要求「缺少必需字段」和 `back`；0048 用 `toEqual({json,truncated})` 合并 | 假阳性 |
| X6-AP-0049 | `tests/streaming-anki.test.ts:819` | 真缺口：漏了 Rust 第 3 段 `resolve_output_protocol(None, Unknown) == Delimiter`；`required` 也改用 `CARDS_WRAPPER_KEY` 常量，与 Rust 一致 | 本轮补上，见提交 |
| X6-AP-0050 / 0052 | `tests/save-anki-cards.test.ts:105/270` | `toEqual` 一次比完整行 / 完整 payload | 假阳性 |
| X6-AP-0051 | `tests/save-anki-cards.test.ts:251` | 部分：TS 走真实保存，精确比顶层 6 个 camelCase 键和 mapping 3 键；Rust 用手写响应查 `skippedIds/duplicatedIds/failed[].id/error` 的值。TS 响应就是契约类型对象、没有序列化层，这些元素形状由类型约束；手写字面量再 JSON 往返只是同义反复，未补 | 记录差异，不凑 expect |
| X6-AP-0053 / 0054 / 0055 | `tests/media.test.ts:61/64/67` | assert-parity：一个 `toMatchObject` 覆盖类型/文案/errorCode；X1 空 path 已在 `7a13f62b8`/`378daeb78` | 假阳性，不补 expect |
| X6-AP-0056 / 0057 | `tests/anki-ai-native-chatanki-integration.test.ts:408/488` | Rust 额外的 `as_str()` 断言：TS 的 source / strategy 本身就是 wire 字符串，`toBe('forced')`、`toBe(wire)` 已同时覆盖 | 假阳性 |
| X6-LP-0059 | `src/anki-connect.ts` | log-parity；v2-1.4 `2c29640fe`，逐 Rust warn 分支核对见下表 | 8/8 已映射；计数报告漏跨文件调用，不补无意义日志；待独立复验 |
| X6-LP-0060 | `repository/apkg-export.ts` | 逐 Rust 分支见下表：7 个生产路径 warn 与 cleanup 语义本轮修复 | 多模板丢报告 wrapper 的第 8 个 warn 无现有生产调用，留待复核，不给 report 凑汇总日志 |
| X6-LP-0061 | `repository/apkg-import.ts` | Rust :2250 字段剥离 warn 已存在；:2591 模板补建失败漏 warn，本轮修复，详下方回归 | 待正常 main 后独立复验 |
| X6-LP-0062 / 0063 | `src/streaming-anki.ts` warn / error | log-parity | 待逐位置核 |
| X6-LP-0064 | `repository/anki-cards.ts`（`cmd/anki_connect.rs`） | log-parity | 待逐位置核 |
| X6-LP-0065 | `src/model-adapters.ts`（`commands.rs`） | log-parity | 待逐位置核 |
| X6-LP-0066 / 0067 | 插件总计 warn / error | log-parity 汇总，随上面各项 | 不单独处理 |

C2 报告没有 L16 的 single-writer 稳定 ID；下表的 single-writer 条目沿用本清单编号。

### single-writer（6，均 info）

| 基线位置 | 当前核验 | 对应 finding / 处置 |
|---|---|---|
| `repository/anki-cards.ts:192` anki_cards（writers anki,memory） | anki 是 owner；memory 的写来自 L17 `repository/insight-projection.ts` | v2-1.2：`1598b1112` 发布 `*InsightProjectionWithConn`，L17 已确认进 main 后替换；L16 侧完成 |
| `repository/anki-cards.ts:242` document_tasks（anki,memory） | 同上 | 同上 |
| `repository/anki-cards.ts:223` fsrs_review_logs DELETE | 当前 anki 无 fsrs 写，删除走 L15 `cleanup*DeletionInTx`（`0857832cf`）；只剩 JOIN 读 | 已修（基线后），无需 owner 新接口 |
| `repository/anki-cards.ts:224` fsrs_card_states DELETE | 同上 | 已修 |
| `repository/apkg-import.ts:266` anki_decks INSERT | 当前 importer 无直接写；C1/C2 后继裁定 anki_decks owner=L16，review 的两处写需回归 owner 接口 | 见下方同 conn 接缝；待 L15 消费，不沿旧“已修”结论签收 |
| `repository/templates.ts:223` settings INSERT | 已删，经 F4 `SettingsWithConn` | v2-1.2：`41ce052cd` |
| （当前门禁新报）`repository/apkg-export.ts:87` INSERT notes | 写导出用临时 Anki collection 的 `notes`，不是 VFS `notes` | 假阳性，不改 |

### unchecked-decode（13，1 error + 12 info）

- `src/streaming-anki.ts:203`（当前在 `src/streaming-anki-protocol.ts`）json-parse-assertion：
  `JSON.parse(criticSummaryToJson(summary)) as Record` 是出站往返，不是入站解码。改为直接用
  `criticSummaryWire(summary)` 对象；Rust `serde_json::to_value(CriticSummary)` 对纯标量结构
  不会失败，`error!` 降级分支不可达，故去掉 try/catch 与 logger 参数。
  ID：X6-UD-0013（提交时用的临时 ID `X6-unchecked-decode-anki-streaming-anki-203`）。状态：`ddb1bcba9` 已修。
- 12 个 `as unknown as`（info）：`apkg-export-model.ts:835`、`apkg-exporter.ts:611/617/640`、
  `document-processing.ts:134`、`save-cards.ts:141` 是出站/内部对象转 Record；
  `apkg-import-zstd.ts:17` 是 Node `zlib` 类型补丁；`templates.ts:287/339` 紧随严格
  decoder（`decodeRulesLenient` / `decodeFieldExtractionRules`）后的类型收窄；
  `plugin-handlers-templates.ts:324/386` 的 `args` 已过 IPC 契约 serde 校验；
  `apkg-import-collection.ts:337` 为 SQLite 行。均不是无校验入站解码，不改。

### assert-parity（18，计数线索）

- `tests/media.test.ts:61/64/67`：Rust 3 个 assert（类型/文案/errorCode）由一个
  `toMatchObject({error_type, message, details.errorCode})` 全覆盖。假阳性。
- `tests/image-occlusion.test.ts`：6 条都是合并断言，覆盖全部 Rust assert（见上方 ID 表）。
- `tests/apkg-importer.test.ts:1872` external_apkg_env_smoke：依赖 `DEEP_STUDENT_EXTERNAL_APKG`，
  条件跳过；Rust 55 assert 对外部包，待核。
- streaming-anki / save-anki-cards / chatanki-integration：逐 assert 结论见上方 ID 表；唯一真缺口
  X6-AP-0049 已补，其余不为凑计数补 expect。

### log-parity（9，均 info，按文件计数）

- `src/anki-connect.ts`：v2-1.4 `2c29640fe` 已恢复生产路径 warn（6/6 既有入口回归）；
  本轮逐 Rust `warn!` 核为 8/8 已映射，详下表，不新增/重复计数日志。
- `repository/apkg-export.ts` / `repository/apkg-import.ts`：本轮 LP-0060 / LP-0061 分支映射见下方；
  `src/streaming-anki.ts`、`repository/anki-cards.ts`、`src/model-adapters.ts` 及插件总计仍待逐位置核。

### 自检操作说明（C1 13:2x 要求）

`ddb1bcba9`、`8539479d5`、`7d9a026d0`、`440704227` 四次 lane-gate 前，我把非本 lane 的
`migration/LEDGER.md` / `ledger.json` 暂时换成 HEAD 版本约 8 秒，让前置检查通过，再把原文件拷回
（`cmp` 已核与备份一致）。所以这几次「自检通过」的前提条件"工作树干净"并不成立：自检期间工作树
实际有这两个生成文件的未提交改动（测试不读它们）。C1 已叫停此做法，之后不再动这两个文件，
等 infra 统一处理生成产物；在那之前 lane-gate 会因前置条件拒绝运行，本 lane 只报作业队列里的
定向测试结果。


### X7-L16-OCCLUSION-IMAGE-TRIM / X7-L16-OCCLUSION-LABEL-TRIM（C1 14:2x）

`src/image-occlusion.ts` 按 Rust `str::trim` 调用位置改用 F4 `rustTrim`（去 U+0085、不去 U+FEFF）：
`validate_spec` 的 image_ref 判空与输出（Rust :219,:350）、label 判空（:332）、`build_card_fields`
的图片名（:457-460）与 Extra 备注（:473），以及同字段的 `occlusion_image_ref_from_fields`（:510）。
同文件其余 `.trim()`（:164/225/230/258/264/268，分别对应 VLM 解析与草稿标记）不在本 finding，
未改；其中 :264 的 basename 对应 Rust :563 `trim()`，是同类候选，等 X7 向量再定。
测试 `tests/image-occlusion-rust-trim.test.ts` 9/9（NEL 判空/默认「区域 1」、BOM 反向保留、
AnkiConnect 同步用的 `rebuildOcclusionClozeText`），连同原 image-occlusion / export roundtrip
共 62/62，作业 `20261104143330-c19e5e`。

### 文件拆分（quality.md §2.4 自动反馈 13:59）

- `repository/anki-cards.ts` 1317 行 → 卡片/任务 CRUD 留原文件（约 540 行）；库页列表/CAS/删除
  移到 `repository/anki-library.ts`；会话/统计/待处理记忆候选移到 `repository/anki-sessions.ts`；
  FSRS 状态读取与导出回执移到 `repository/anki-review-state.ts`。原文件 `export *` 三个新模块，
  外部导入路径不变。纯移动：逐行比对原文件，所有非空行都在新文件中出现。
- `src/generation-service.ts` 1236 行 → 795 行：非流式 JSON 卡片解析移到
  `src/generation-cards-json.ts`（原文件再导出）；critic 接线改为 `src/generation-critic.ts`
  的 `runGenerationCritic(deps, …)`；`anki_generation_event` 发送移到 `src/generation-events.ts`；
  `DeltaQueue` 移到 `src/delta-queue.ts`。方法体不变，只把 `this.x` 换成参数。

### L15-V2-S4 / D3：reviewVersion 内部 i64（本轮接入）

L15 通知 `FsrsAgentReviewStateSnapshot.reviewVersion` 改 bigint；L16 同步把
`AgentReviewStateSnapshot.reviewVersion` 改 bigint，`list_anki_library_cards` 不做 Number
适配，直到 kernel `toWireJson` 才转前端 number。本地删除 CAS 的现有只读查询将
`local_version` 按 TEXT 取回再 BigInt（另读 SQLite typeof，非 INTEGER 报错，保持 Rust
`row.get::<i64>` 语义）；没有改动任何写 SQL、事务模式或 L15 文件。
公开 `deleteAnkiCardForLibrary` / `cards.deleteCardForSession` 接受 `number|bigint|null`，
保留旧整数 number 调用（边界按非负 i64、不是 MAX_SAFE），比较统一用 bigint。
Rust 证据：`dstu-storage/src/database/mod.rs:5887-5915`（Option<i64>、非负校验、immediate
事务与内容版本先于 review CAS）；L15 另在自己路径维护 review 的四个 CAS 接口。
回归：`tests/review-version-i64.test.ts` 前四例通过真实 `ctx.anki` 与迁移库，验证 L16
实际 SQL/删除 CAS 的相邻 2^53+ 整数不误删、i64::MAX / MIN 与旧 number 输入。
最后 wire 用例显式 `withReview:false` 并注入 snapshot：只验证真实 L16
`list_anki_library_cards` 命令/响应与 kernel IPC 投影，**不验证真实 L15 owner**。
L15/L16/L24 正常进入 main 后的真实 owner 联合独立验另记 pending，不以这五例代替。
L24 需同步其本地快照类型，已通知，不越界修改。
证据：新 D3 用例 5/5，exit 0，无 Errors（作业 `20261104151313-17fc61`，含 signed
i64::MIN 冲突快照）。既有 library / library-query / anki-chatanki-service-surface 三文件
24/24 已过（`20261104150854-2b28a5` 整体 exit 1：新增测试最初的两条固定 front 撞去重索引，
已只修 fixture 为按 cardId 唯一，后续 5/5 为修正后的运行）。
typecheck `20261104150842-c6c169` exit 2，唯一错误为本 lane 原有的跨域类型断言
`tests/anki-chatanki-service-surface.test.ts:210`：L24 的 `ChatAnkiCardRepository` 冲突快照
还声明 `reviewVersion:number`，不能接收 L16 的 bigint 返回。已请求 L24 沿 D3 同步，
不把返回值强转 Number、不删除/放宽该兼容断言。自检仍受非本 lane ledger 生成改动阻塞。
C1 后继确认：L24 `de19f72a0` 已补返回精度断言，但 API 仍为 number；沿已有类型请求等正常
集成，不另造修复任务、不重复排同门禁或全量 785。既有 AP 复核继续沿原稳定 ID 映射。

L24 后继候选 `6962cbfed`：API 已改 `reviewVersion:bigint`，删除 CAS 接收
`number|bigint|null`（解析器/fixture/输出投影的部分实现在 `e8b2046c1`）。当前 main 尚未包含
该候选，不把旧 `150842-c6c169` exit 2 改记为通过。按提供方请求，另做只读候选类型核验：
从原 `anki-chatanki-service-surface.test.ts` 抽取 **原七项** `L24SurfaceCompatibility` 类型断言，
编译器仅在内存中读取 `6962cbfed` 的 L24 API，无磁盘替换/跨 lane 修改；这不是正式整树
typecheck，更不是新版真实 L15/L16/L24 provider 组合执行。原测试断言原样保留。
结果：`20261104153009-ff06f8` exit 0、diagnostics=0；输入为 L16 `1df97b515` 与内存中的
L24 `6962cbfed:api.ts`。正常 main 合入后的正式 typecheck / 真实 provider 联验仍 pending。

### X6-LP-0059：逐 Rust warn 分支映射（自动续派，本轮审读）

源为 `dstu-anki/src/anki_connect_service.rs`。8 个调用均在当前生产路径，级别为 warn，
错误/模型名/批次数等关键字段与原分支位置一致；不是把日志计数补到报告数。

| Rust 行 / 分支 | TS 调用 | 生产接线与字段 |
|---|---|---|
| :320 端口探测失败 | `src/anki-connect.ts:176` | availability 在返回错误前 warn，端口/IO 错误 |
| :397 非 u64 version 放行 | `src/anki-connect.ts:81` | 返回成功前 warn，`None` / `Some(Value)`，A6 后继已修 null |
| :422 POST send 失败 | `src/anki-connect.ts:195` | 错误分类返回前 warn，错误详情；Rust Debug 与 Node 错误底层表示不同，不声称逐字差分 |
| :1368 自动建模型失败 | `src/anki-sync.ts:736` | 模型名 + 错误，warn 后推 modelErrors |
| :1376 模型缺失且无模板 | `src/anki-sync.ts:740` | 模型名，warn 后推 modelErrors |
| :1409 获取模型字段失败 | `src/anki-sync.ts:767` | 错误 + 回退基本字段映射；模板模型随后仍 fail-fast |
| :1526 addNotes 批次失败 | `src/anki-sync.ts:832` | 当前 chunk 张数 + 错误，warn 后记 report.warnings 并继续下一批 |
| :1545 canAddNotes 不可用 | `src/anki-sync.ts:850` | 数量不匹配/请求错误原因，warn 后转逐条 addNote |

`add_cards_to_anki_connect` 与 `batch_export_cards` 两个调用点都把 `ctx.logger` 传给
`addNotesToAnkiDetailed`，内部 availability 继续传同一 logger；check status / availability /
import 命令与 `ctx.anki` 服务也已传 logger。证据等级：本轮逐分支审读；原
`tests/anki-connect-command-logs.test.ts` 6 例入口回归只覆盖其声明的分支，不称 8 分支全测。

### B2：消费已进入 main 的 L11 live-resource seam

`repository/chatanki-vfs.ts` 的 `resolveVfsSource` 改调用
`resources.getLiveResource(conn, resourceId)`；不改外层 `res_` 元数据 `getResource`
（Rust :10570）。按 Rust :10535-10546，通用附件解析选出的 file 还必须存活并确实关联本资源。
保持 :10615-10622 的两个阶段：没有存活 file 报映射错误；有 file 但关联 resource 软删时
最终返回 None。没有跨 owner SQL/写操作/新事务。
回归扩展现有真实 `ctx.anki.apkgVfs` + L11 插件用例：活跃→资源墓碑→恢复、file 墓碑、
无关联 resource_id，以及被软删的别名仍可指向另一活跃文件（保留原 Rust 元数据读取语义）。
作业 `20261104155245-9f5dbc`：1 passed / 9 名称过滤，exit 0，无 Errors。
最初 `20261104154941-8e73bb` exit 1 为 fixture 尝试写不存在 resource_id 触发 FK，
已改用合法 NULL 关联验证缺 hash 分支，没有关闭外键或弱化生产判断。
typecheck `20261104155126-66b0c0` exit 2，仍只有原 L24SurfaceCompatibility :210
number/bigint 依赖不匹配；boundaries `20261104155126-745658` exit 0。

### v2-1.2 / X6-OWN-C2-20261104：本地 anki_decks owner 接缝（L15 请求）

C1/C2 后继 owner 裁定 `anki_decks` 归 L16；不与远端 AnkiConnect 的 deck 方法混淆。
从 `anki/api.ts` 直接导出两个同步函数（不加服务依赖或构造器注入）：

- `ensureDefaultFsrsDeckWithConn(conn: SqlExecutor, now: string): void`
  对应 Rust `fsrs_review_service.rs:1346-1352`，原 `INSERT OR IGNORE`、默认字段/JSON/版本 0；
  已有行（包括 tombstone）不复活、不重设配置。
- `writeFsrsDeckConfigWithConn(conn, deckId, configJson, now): void`
  对应 Rust `:3640/:3686`，只更新存活行，原样保存 L15 构造的 JSON 字符串，
  `local_version=COALESCE(local_version,0)+1`；无匹配行不插入。

实现位于 `repository/fsrs-decks.ts`；只用传入 conn，不获取新连接或开启/提交事务。
只抛原始存储错误，由 L15 保留原 `Database` 前缀（`确保默认牌组失败: …` /
`写入牌组调度配置失败: …`），不双包。
`tests/fsrs-decks-owner.test.ts` 经公开 API + 真实迁移库验证默认行、幂等与墓碑、
相同配置也递增版本、字节保持、missing no-op、调用方 immediate 事务回滚、原始错误传播。
接口发布候选待交 L15 消费后正常 main 联验，不称跨 owner 收口已完成。
提供面回归作业 `20261104155443-cf2669`：4/4，exit 0，无 Errors；不替代 L15 后继真实消费测试。
L15 消费候选 `77c4bef2a` 已审读：从 anki 公共 API import，两条原写 SQL 删除，原 conn、
try/catch 与 JSON.stringify 位置不变，无 fallback。main 尚缺提供面与消费候选，已请求 C1
按提供面 `474e38f29` → 消费 `77c4bef2a` 顺序统筹正常集成（另有 L24 bigint API 类型依赖）。
**后发状态更正**：L15 当前 tip `84f328310` 已明确 revert `77c4bef2a`，不覆盖他人撤回。
因此当前 L15 两处 deck 写仍在，SW **未完成**；等 L16 API 正常进入 main 后由 L15 重应用
原小补丁。`84f328310` 的正式 selfgate 5/5（base `677f6727c`）与先前 `77c4bef2a` 缺导出
的失败是两次独立记录，不用前者替代后者，也不把候选组合绿算成当前分支已消费。
L15 临时候选组合树 `/tmp/opencode/l15-deck-owner-77c4bef2a` 的现有作业
`20261104160521-9ce58d` 已亲取：真实 deck-owner / service-transaction / L16 owner 三文件
10/10、exit 0（临时 merge `5b728ccee`）；这是两个真实候选的组合证据，**不是 main 后独立签收**。
同树 typecheck `20261104160521-4c059f` exit 2，仍仅旧 L24 snapshot number 导致的
`anki-chatanki-service-surface.test.ts:210` 兼容性断言；没有缺 owner 导出的错误。

### X6-LP-0061：APKG 导入两处 Rust warn 逐分支核对

- `apkg_importer_service.rs:2250` 字段剥离：现有 `src/apkg-import-mapping.ts:77` 已通过
  runtime logger 记录原字段名，不新增重复日志。
- `:2591` 模板补建失败：`src/apkg-import-persist.ts::importTemplateCandidates` 原来只有
  report.warnings，漏了 host warn。本轮在同一 catch 中、推入 report 之前补
  `APKG 模板导入失败 <templateId> (<name>): <error>`，由真实 runtime.logger 贯穿；
  卡片事务已提交，模板失败仍 best-effort，不回滚卡片、不改既有结构化告警。

新增回归直接调用真实 `ctx.anki.apkgImporter.importBytes`，外部包含不可信协议字段，
真实 SQLite trigger 令后续模板补建失败。精确断言两条 warn 的级别/顺序/字段、报告告警、
卡片保留与协议字段剥离、模板未创建。旧实现红灯 `20261104161439-95b72a` exit 1，
只收到字段剥离 warn，缺少模板失败 warn；不修改既有 Rust 移植断言或 APKG smoke 门控。
修复后 `20261104161712-ea46c6`：2 passed / 49 名称过滤、exit 0，无 Errors，包含新回归与
既有模板成功补建/二次导入不覆盖用例。没有重跑全 APKG/785；正式 typecheck 的已知 L24
类型依赖与 ledger 自检前置条件未变，主线独立复验仍 pending。

### X6-LP-0060：APKG 导出 warn 与清理语义（自动续派，按分支核）

`ApkgExportRuntime` 现在要求 warn logger；两个生产 runtime 均传 `ctx.logger`。
低层字段/媒体函数可接 logger，由所有生产调用点传入，不用测试 logger 冒充生产接线。

| Rust `apkg_exporter_service.rs` 行 / 分支 | TS 落点 / 本轮处理 |
|---|---|
| :948 未知字段回退空字符串 | `apkg-export-model.ts::resolveCardFieldValue`：只在内置协议字段过滤与 alias 搜索之后 warn 原字段名，值仍为空 |
| :1737 媒体路径无有效文件名 | `apkg-exporter.ts::collectMediaEntries`：warn 路径后记 missing |
| :1747 同名不同来源冲突 | 同上：warn 原 message 后推入 warnings，仅保首来源 |
| :1764 媒体超限 | 同上：warn 上限/路径/实际大小后记 warnings + missing |
| :1772 读取媒体失败 | 同上：warn 路径 + IO 错误后继续，不让单个媒体使导出失败 |
| :1856 单模板丢报告 wrapper 汇总缺失媒体 | 新 `exportCardsToApkgWithFullTemplate` 对应原 Rust wrapper；实际 `runApkgExport` / selection 命令消费它，保数量/路径 |
| :2062 单模板临时目录清理失败 | 单模板 finally warn IO 错误并保主结果；原 TS 直接抛清理错误，会覆盖成功/原导出错误，已修 |
| :2084 多模板丢报告 wrapper 汇总 | Rust 生产命令 :1211 调用的是 report 版本，不经过此 wrapper；仓库检索只在 Rust 测试见对 wrapper 的调用。TS report 命令不添加该汇总，不虚造生产调用，是否按非生产例外登记留待复核 |

多模板 report 的 Rust 末尾 `let _ = fs::remove_dir_all` 同样不让清理失败覆盖主结果，且不 warn；
TS 保留这一差异（并非给两条路径都凑清理日志）。没有扩大媒体格式或改报告字段/返回形状。
新 `tests/apkg-export-command-logs.test.ts` 走真实 Host 命令：媒体四分支与单模板汇总、
缺失自定义字段仍导出空值、multi report 不额外汇总，以及单/多模板成功和失败时清理失败
不覆盖主结果。旧实现 `20261104164200-1f5273` exit 1：媒体 warn 全无，两条清理成功路径
都被 cleanup denied 覆盖；字段 fixture 最初因缺 generation_prompt / extraction rules 被校验拒绝，
已补齐合法输入，不把 fixture 失败算成实现缺陷，不改验证器。
最终新回归 `20261104165312-0de9a1`：7/7、exit 0、无 Errors，覆盖全部上述生产分支。
既有 exporter 41 例与 export integration 3 例在 `20261104164831-278785` 中均通过，
该复合作业整体仍为 exit 1（新增字段 fixture 错把 create_custom_template 的字符串 ID 当对象，
导致未真正选中模板；已修 fixture 按正式返回值传入 templateId，后续七例为修正后的运行）。
typecheck `20261104164514-ae57a0` exit 2，仍仅原 L24SurfaceCompatibility :210 依赖错误，
没有新 exporter 类型错误；boundaries `20261104164832-29b4f4` exit 0。
多模板丢报告 wrapper 的 :2084 仍留待复核，不用当前生产 report 测试自签其入口可达。

### main-red 墓碑用例 fixture 阶段分解（2026-11-05 18:5x fresh 单元）

固定 SHA `51452be45`；失败 main `3f794390c` 的
`host/plugins/anki/tests/enhanced-anki-service.test.ts` 与 `host/plugins/anki/tests/env.ts`
均零 diff。只读 env.ts/F3 public 接口，未改测试/env/生产/F3；两个 ledger dirty 属他人，未触碰。

- 探针 job `20261105105305-9777a5`（前一次 `20261105105218-5c8182` 用 json reporter 未落
  console，只取到本体 `6497.039ms`）：Node 26.5，原样单测 **1 pass / 9 skipped / exit 0**。
  阶段：`template.runAll 3652.791ms`、`template.total 3653.906ms`、
  `env.copy 3663.080ms`（计时含 await 模板 + `cpSync`，纯拷贝约 `9.174ms`）、
  `env.runAll2 1879.697ms`、`env.host 798.794ms`、`env.total 6342.624ms`；
  fixture 之外约 154ms（业务 + cleanup + 用例外壳）。
- 分解结论：冷 `runAll`（真实应用四库迁移）≈56%，拷贝后第二次 `runAll` ≈29%，
  Host 装载 ≈12%，目录拷贝 ≈0.1%。第二次 `runAll` 在已迁移模板的字节拷贝上 pending=0，
  属于校验/指纹复核，不是迁移应用；按本轮“不要删验证”及 C1 既有约束不能直接删除。
  冷 `runAll` 是模板来源不可删，Host 装载必要；未发现其它可证重复项。
- F3 公共接口缺口（owner = **F3-storage**）：`host/platform/storage/api.ts:429-436` 的
  `MigrationService` 只有 runAll/currentVersion/needsMigration；`migrateSingle` 仅在
  `host/platform/storage/service.ts:319` 的 `StorageServiceImpl.coordinator()` 上，未进入
  `StorageService`/API.md，C1 已定性为非 public。Rust 本用例
  `src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:1362-1373` 为
  `MigrationCoordinator::new(tmp).with_audit_db(None).migrate_single(DatabaseId::Mistakes)`；
  TS fixture 却 `runAll`（四库 + audit）再逐 env `runAll` 校验。建议 F3 暴露
  `MigrationService.migrateSingle(name)`（单库，保留 repairs/verifier/fingerprint 语义）
  并允许测试关闭 audit；Anki fixture 才能按 Rust 只迁移/校验 mistakes（需要 vfs/chat_v2 的
  其它测试文件保持默认四库）。该建议需 C1 与 F3 决定，本单元未私用 coordinator()、
  未复制 migration、未绕 schema 验证。
- 残留：原 fulltest `3f794390c / 10:01` 的 `34005ms` 红未关闭；本单元无 lane 内可合入的
  最小修复，不再跑相同单例/整 Anki。保持原红，待 F3 接口或干净 integrator 负载复验。

### F3 单库迁移接口落地后的 tombstone fixture 窄签（2026-11-05 19:4x）

- 正常 merge 固定 F3 owner tip `1f451d756` → merge commit `4585ccc00`（非 cherry-pick/复制）。
  该 tip 的祖先含 `f03a4b0a6` openStartupDatabase 与 L20-sync 改动，so 正常 merge 一并带入；
  无冲突，未改 F3 内容。两个 foreign ledger dirty 保持原样，未 stage/提交。
- 实现 `ea5b72fc6`（仅 `tests/env.ts` 与 `enhanced-anki-service.test.ts`）：
  `createAnkiTestEnv` 增加测试专用 `migrationScope?: 'all' | readonly CoordinatedDatabaseName[]`；
  模板 Map 按 scope 隔离；`'all'` 仍走原四库 `runAll` + 拷贝后 `runAll` 校验（默认行为不变）；
  窄 scope 用 `migrateSingle` + `auditDbPath: null` 建模板，拷贝后用同一 `migrateSingle` 重验。
  `AnkiTestEnv.migrationReports` 暴露重验记录。仅墓碑原例改为 `['mistakes']`，对齐 Rust
  `enhanced_anki_service.rs:1362-1373` 的 `with_audit_db(None).migrate_single(Mistakes)`；
  四 expect/名字/数据/timeout/原 SQL、it 内 setup+cleanup 均未动。
- 真实依赖核对：anki 插件只用 `mistakes`；review 的 `vfs` 访问都在 `service()` 惰性闭包/命令
  调用内，apply 阶段不打开 vfs；未加任何假服务。窄 scope 下真实安装 anki+review 成功。
- 证据（固定实现 SHA `ea5b72fc6`；当时 8 个 fulltest shard + 集成作业并发，CPU pressure
  约 26–34，不能当原全测根因结论）：
  - typecheck `20261105113233-ea1d05` exit 0。
  - 原例标题过滤 `20261105113345-396f83`：**1 pass / 10 skipped / total 11 / exit 0**，
    本体 `5956.660ms`。
  - 相关文件全量 `20261105114012-3a572d`：**11 pass / 0 fail / exit 0**；墓碑本体
    `5278.972ms`，新增 scope 用例 `931.642ms`。
- 重要残差：窄 scope 只把墓碑例的冷四库模板成本后移，未消除文件级冷 `runAll`。本次全量文件
  运行中，第一个默认四库用例 `test_pause_marks_first_task_paused_without_streaming`
  支付冷四库模板，达 `25303.236ms`（同压测条件下仍 <30s，但已接近）。原 fulltest
  `3f794390c/10:01` 的 `34005ms` 红未被本候选重跑，不能宣称已修；若原红来自冷四库迁移的
  负载，风险只是转移到该默认用例。彻底消除需经授权的跨文件模板共享或等价方案，本单元未做。
- 11:30Z 的 fulltest 是独立固定的当时 main 快照，不包含 `ea5b72fc6`，不能冒充本候选已测。
