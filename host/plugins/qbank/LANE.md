# L14-qbank：题库

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L14-qbank（题库） |
| 目录 | `host/plugins/qbank/` |
| Rust 范围（lanes.md） | dstu-qbank、src/qbank_*、question_bank_service、commands.rs 的 qbank 命令，以及 qbank、essay、review 工具和测试 |
| 主要提供 | `qbank` |
| 主要消费 | F3、L02、L15 |
| 特别注意 | 判分、掌握度、同步标记的同库原子性 |
| 规模（本目录） | 39369 行 · 47 个文件 · 88 个命令（前端调用 73） · 241 个测试 |
| 规模（整条 lane，inventory） | 39369 行 · 47 个文件 · 88 个命令（前端 73） · 241 个测试 |
| 契约 | [`contracts/ipc/L14-qbank.json`](../../../contracts/ipc/L14-qbank.json) |
| 服务草稿 | [`contracts/services/DRAFT-L14-qbank.md`](../../../contracts/services/DRAFT-L14-qbank.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-qbank/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/lib.rs` | 52 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_authoring_service.rs` | 724 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_authoring_service/tests.rs` | 380 | 10 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_document.rs` | 396 | 3 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/events.rs` | 25 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/mod.rs` | 302 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/pipeline.rs` | 443 | 2 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/reference.rs` | 285 | 2 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs` | 422 | 2 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_generation/types.rs` | 1012 | 17 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/context.rs` | 510 | 7 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/events.rs` | 108 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/image_answer.rs` | 259 | 5 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/mod.rs` | 78 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/pipeline.rs` | 2325 | 28 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/stream.rs` | 381 | 8 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_grading/types.rs` | 266 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_legacy_reconcile.rs` | 2765 | 15 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_management.rs` | 949 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_management/tests.rs` | 536 | 5 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_practice.rs` | 1538 | 10 |  |
| `src-tauri/crates/dstu-qbank/src/qbank_practice/export.rs` | 264 | 1 | 1 |
| `src-tauri/crates/dstu-qbank/src/qbank_practice/export_bridge.rs` | 117 | 0 | 1 |
| `src-tauri/crates/dstu-qbank/src/qbank_source_view.rs` | 661 | 10 | 1 |
| `src-tauri/crates/dstu-qbank/src/question_authoring_runner.rs` | 1110 | 3 |  |
| `src-tauri/crates/dstu-qbank/src/question_authoring_runner/plan.rs` | 860 | 4 |  |
| `src-tauri/crates/dstu-qbank/src/question_authoring_runner/tests.rs` | 547 | 9 |  |
| `src-tauri/crates/dstu-qbank/src/question_bank_service.rs` | 4614 | 25 |  |
| `src-tauri/crates/dstu-qbank/src/question_export_service.rs` | 533 | 3 |  |
| `src-tauri/crates/dstu-qbank/src/question_export_service/authoring.rs` | 409 | 1 |  |
| `src-tauri/crates/dstu-qbank/src/question_export_service/vfs_hook.rs` | 31 | 0 |  |
| `src-tauri/crates/dstu-qbank/src/question_import_service.rs` | 5054 | 4 |  |
| `src-tauri/crates/dstu-qbank/src/runtime.rs` | 45 | 0 |  |
| `src-tauri/src/chat_v2/tools/essay_grading_executor.rs` | 1166 | 12 |  |
| `src-tauri/src/chat_v2/tools/qbank_executor.rs` | 6368 | 21 |  |
| `src-tauri/src/chat_v2/tools/qbank_import_source.rs` | 574 | 6 |  |
| `src-tauri/src/chat_v2/tools/review_executor.rs` | 1037 | 9 |  |
| `src-tauri/src/qbank_generation.rs` | 56 | 0 | 4 |
| `src-tauri/src/qbank_grading.rs` | 41 | 0 | 2 |
| `src-tauri/src/qbank_grading/image_answer/tests.rs` | 120 | 1 |  |
| `src-tauri/src/qbank_practice.rs` | 122 | 0 | 12 |
| `src-tauri/src/qbank_read/tests.rs` | 48 | 1 |  |
| `src-tauri/src/question_bank_service/tests.rs` | 103 | 1 |  |
| `src-tauri/tests/mastery_qbank_correction.rs` | 359 | 3 |  |
| `src-tauri/tests/qbank_executor_e2e.rs` | 510 | 0 |  |
| `src-tauri/tests/qbank_verdict_three_paths.rs` | 846 | 13 |  |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（88）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `cancel_question_bank_import` | `src/commands.rs:1264` | sync | app | src/components/ExamSheetUploader.tsx:388<br>src/components/ExamSheetUploader.tsx:970<br>src/components/ExamSheetUploader.tsx:1007 | (importId: string) → boolean ! AppError |
| `cancel_questions_csv_import` | `src/commands.rs:1859` | sync | app | src/components/CsvImportDialog.tsx:245<br>src/components/CsvImportDialog.tsx:505 | (importId: string) → boolean ! AppError |
| `export_questions_csv` | `src/commands.rs:1875` | async | app | src/components/QuestionBankExportDialog.tsx:599<br>src/stores/questionBankStore.ts:2050 | (request: CsvExportCommandRequest) → CsvExportResult ! AppError |
| `get_csv_exportable_fields` | `src/commands.rs:2005` | sync | none | — | (（无）) → ?[][] |
| `get_csv_preview` | `src/commands.rs:1967` | async | app | src/components/CsvImportDialog.tsx:268<br>src/stores/questionBankStore.ts:2004 | (filePath: string, rows?: integer(usize) \| null) → CsvPreviewResult ! AppError |
| `get_enhanced_statistics` | `src/commands.rs:2109` | async | app | src/utils/settingsApi.ts:267 | (（无）) → Value ! AppError |
| `get_exam_sheet_session_detail` | `src/commands.rs:945` | async | none | — | (request: ExamSheetSessionDetailRequest) → ExamSheetSessionDetailResponse ! AppError |
| `get_learning_heatmap` | `src/commands.rs:8244` | async | app | src/hooks/useLearningHeatmap.ts:96 | (startDate: string, endDate: string) → LearningActivity[] ! AppError |
| `import_question_bank` | `src/commands.rs:1087` | async | none | — | (request: ImportQuestionBankRequest) → QuestionImportDraftResponse ! AppError |
| `import_question_bank_stream` | `src/commands.rs:1122` | async | app | src/components/ExamSheetUploader.tsx:687 | (request: ImportQuestionBankRequest) → QuestionImportDraftResponse ! AppError |
| `import_questions_csv` | `src/commands.rs:1709` | async | app | src/components/CsvImportDialog.tsx:402<br>src/stores/questionBankStore.ts:2019 | (request: CsvImportCommandRequest) → CsvImportResult ! AppError |
| `inspect_pdf_text_for_qbank` | `src/commands.rs:1042` | async | none | — | (request: InspectPdfTextRequest) → PdfTextInspection ! AppError |
| `list_exam_sheet_sessions` | `src/commands.rs:932` | async | none | — | (request: ExamSheetSessionListRequest) → ExamSheetSessionListResponse ! AppError |
| `list_importing_sessions` | `src/commands.rs:1646` | async | none | — | (（无）) → ImportingSession[] ! AppError |
| `qbank_ai_generate_questions` | `src/qbank_generation.rs:16` | async | app | src/hooks/useQbankAiGeneration.ts:94 | (request: QbankGenerationRequest) → GenerationTaskView ! AppError |
| `qbank_ai_grade` | `src/qbank_grading.rs:22` | async | app | src/hooks/useQbankAiGrading.ts:327 | (request: QbankGradingRequest) → QbankGradingResponse \| null ! AppError |
| `qbank_batch_create_questions` | `src/commands.rs:7718` | async | app | src/essay-grading/essayMistakes.ts:63 | (paramsList: CreateQuestionParams[]) → Question[] ! AppError |
| `qbank_batch_delete_questions` | `src/commands.rs:7789` | async | app | src/components/ExamSheetUploader.tsx:818<br>src/features/learning-hub/apps/views/ExamContentView.tsx:1843 | (questionIds: string[]) → BatchResult ! AppError |
| `qbank_batch_update_questions` | `src/commands.rs:7764` | async | app | src/stores/questionBankStore.ts:1620<br>src/stores/questionBankStore.ts:1683<br>src/stores/questionBankStore.ts:1758 | (request: BatchUpdateQuestionsRequest) → BatchResult ! AppError |
| `qbank_cancel_generation_task` | `src/qbank_generation.rs:48` | async | app | src/hooks/useQbankAiGeneration.ts:119 | (taskId: string) → GenerationTaskView \| null ! AppError |
| `qbank_cancel_grading` | `src/qbank_grading.rs:33` | async | app | src/hooks/useQbankAiGrading.ts:159<br>src/hooks/useQbankAiGrading.ts:381<br>src/hooks/useQbankAiGrading.ts:402<br>…共 4 处 | (streamEventName: string) → null ! AppError |
| `qbank_commit_authoring_draft` | `src/commands.rs:1361` | sync | app | src/components/AiQuestionGenerationPanel.tsx:415<br>src/components/ExamSheetUploader.tsx:802<br>src/features/chat/plugins/blocks/qbankQuestionsBlock.tsx:133 | (jobId: string, selectedLocalIds: string[], expectedVersion: integer(i64)) → AuthoringCommitReceipt ! AppError |
| `qbank_complete_paper_export` | `crates/dstu-qbank/src/qbank_practice/export_bridge.rs:66` | async | app | src/components/practice/PracticeRuntimeBridge.tsx:33<br>src/components/practice/PracticeRuntimeBridge.tsx:39 | (requestId: string, data?: string \| null, error?: string \| null) → null ! AppError |
| `qbank_count_by_type` | `src/commands.rs:7882` | async | none | — | (examId: string) → object ! AppError |
| `qbank_create_practice` | `src/qbank_practice.rs:16` | sync | app | src/api/practiceApi.ts:95 | (request: CreatePracticeRequest) → PracticeDraft ! AppError |
| `qbank_create_question` | `src/commands.rs:7704` | async | app | src/quick-assistant/service.ts:256 | (params: CreateQuestionParams) → Question ! AppError |
| `qbank_crop_source_image` | `src/commands.rs:8609` | async | app | src/components/ImageCropDialog.tsx:189 | (request: CropSourceImageRequest) → QuestionImage ! AppError |
| `qbank_delete_group` | `src/commands.rs:1612` | sync | app | src/api/questionBankApi.ts:332 | (groupId: string, mode: DeleteGroupMode__De, expectedVersion: integer(i64)) → GroupDeleteResult ! AppError |
| `qbank_delete_material` | `src/commands.rs:1453` | sync | app | src/api/questionBankApi.ts:340 | (materialId: string, expectedVersion: integer(i64)) → null ! AppError |
| `qbank_delete_practice` | `src/qbank_practice.rs:63` | sync | app | src/api/practiceApi.ts:122 | (id: string, submitted: boolean) → null ! AppError |
| `qbank_delete_question` | `src/commands.rs:7778` | async | app | src/features/learning-hub/apps/views/ExamContentView.tsx:1944<br>src/stores/questionBankStore.ts:1574 | (questionId: string) → null ! AppError |
| `qbank_export_document` | `src/commands.rs:1489` | sync | app | src/api/questionBankApi.ts:401 | (examId: string) → Value ! AppError |
| `qbank_export_paper_docx` | `crates/dstu-qbank/src/qbank_practice/export.rs:228` | sync | app | src/components/practice/paperExport.ts:398 | (title: string, blocks: PaperBlock[]) → string ! AppError |
| `qbank_export_portable` | `src/commands.rs:1633` | sync | app | src/api/questionBankApi.ts:412 | (examId: string) → PortableExport ! AppError |
| `qbank_generate_mock_exam` | `src/commands.rs:8106` | async | app | src/stores/questionBankStore.ts:2276 | (request: GenerateMockExamRequest) → MockExamSession ! AppError |
| `qbank_generate_paper` | `src/commands.rs:8168` | async | app | src/stores/questionBankStore.ts:2359 | (request: GeneratePaperRequest) → GeneratedPaper ! AppError |
| `qbank_get_activity_heatmap` | `src/commands.rs:8018` | async | app | src/stores/questionBankStore.ts:1963 | (request: GetActivityHeatmapRequest) → ActivityHeatmapPoint[] ! AppError |
| `qbank_get_authoring_draft` | `src/commands.rs:1386` | sync | none | — | (jobId: string) → QuestionAuthoringDraft ! AppError |
| `qbank_get_check_in_calendar` | `src/commands.rs:8193` | async | app | src/stores/questionBankStore.ts:2381 | (request: GetCheckInCalendarRequest) → CheckInCalendar ! AppError |
| `qbank_get_daily_practice` | `src/commands.rs:8147` | async | app | src/stores/questionBankStore.ts:2337 | (request: GetDailyPracticeRequest) → DailyPracticeResult ! AppError |
| `qbank_get_generation_task` | `src/qbank_generation.rs:27` | async | app | src/features/chat/plugins/blocks/qbankQuestionsBlock.tsx:81<br>src/hooks/useQbankGenerationTasks.ts:106 | (taskId: string) → GenerationTaskView \| null ! AppError |
| `qbank_get_history` | `src/commands.rs:7910` | async | app | src/components/QuestionHistoryView.tsx:202 | (questionId: string, limit?: integer(u32) \| null) → QuestionHistory[] ! AppError |
| `qbank_get_knowledge_stats` | `src/commands.rs:8041` | async | none | — | (request: GetKnowledgeStatsRequest) → KnowledgePoint[] ! AppError |
| `qbank_get_knowledge_stats_with_comparison` | `src/commands.rs:8055` | async | app | src/stores/questionBankStore.ts:1983 | (request: GetKnowledgeStatsRequest) → KnowledgeStatsComparison ! AppError |
| `qbank_get_learning_trend` | `src/commands.rs:7989` | async | app | src/stores/questionBankStore.ts:1940 | (request: GetLearningTrendRequest) → LearningTrendPoint[] ! AppError |
| `qbank_get_paper` | `src/qbank_practice.rs:80` | sync | app | src/api/practiceApi.ts:129 | (id: string) → GeneratedPaper ! AppError |
| `qbank_get_practice` | `src/qbank_practice.rs:33` | sync | app | src/api/practiceApi.ts:96<br>src/api/practiceApi.ts:98 | (id: string, submitted: boolean) → Value ! AppError |
| `qbank_get_question` | `src/commands.rs:7675` | async | app | src/components/practice/BatchPracticeWorkspace.tsx:385<br>src/components/practice/BatchPracticeWorkspace.tsx:401<br>src/features/learning-hub/mistakeBook/useMistakeRedoSession.ts:99<br>…共 7 处 | (questionId: string) → Question \| null ! AppError |
| `qbank_get_question_by_card_id` | `src/commands.rs:7689` | async | none | — | (examId: string, cardId: string) → Question \| null ! AppError |
| `qbank_get_source_images` | `src/commands.rs:8515` | async | app | src/components/ImageCropDialog.tsx:86 | (examId: string) → SourceImageInfo[] ! AppError |
| `qbank_get_source_page` | `crates/dstu-qbank/src/qbank_source_view.rs:339` | async | none | — | (examId: string, sourceId: string, page?: integer(u32) \| null) → SourcePageView ! AppError |
| `qbank_get_stats` | `src/commands.rs:7868` | async | app | src/hooks/useQuestionBankSession.ts:357<br>src/stores/questionBankStore.ts:1860 | (examId: string) → dstu_vfs__vfs__repos__question_repo__QuestionBankStats \| null ! AppError |
| `qbank_get_submissions` | `src/commands.rs:7925` | async | none | — | (questionId: string, limit?: integer(u32) \| null) → AnswerSubmission[] ! AppError |
| `qbank_grade_practice_manually` | `src/qbank_practice.rs:112` | sync | app | src/api/practiceApi.ts:126 | (id: string, questionId: string, correct: boolean) → PracticeAttempt ! AppError |
| `qbank_legacy_audit` | `src/commands.rs:1542` | sync | app | src/components/QuestionImportAuditPanel.tsx:158 | (examId: string) → LegacyMigrationAudit ! AppError |
| `qbank_legacy_migrate_selected` | `src/commands.rs:1555` | sync | app | src/components/QuestionImportAuditPanel.tsx:166 | (examId: string, cardIds: string[], expectedVersion: string) → LegacyMigrationReceipt ! AppError |
| `qbank_list_authoring_drafts` | `src/commands.rs:1398` | sync | app | src/features/learning-hub/apps/views/ExamContentView.tsx:1976 | (examId: string) → QuestionDraftSummary[] ! AppError |
| `qbank_list_generation_tasks` | `src/qbank_generation.rs:37` | async | app | src/hooks/useQbankAiGeneration.ts:70 | (examId: string, limit?: integer(usize) \| null) → GenerationTaskView[] ! AppError |
| `qbank_list_mistakes` | `src/commands.rs:7600` | async | app | src/features/learning-hub/mistakeBook/mistakeBookApi.ts:102 | (request: ListMistakesRequest) → MistakeListResult ! AppError |
| `qbank_list_papers` | `src/qbank_practice.rs:72` | sync | app | src/api/practiceApi.ts:128 | (examId: string) → GeneratedPaper[] ! AppError |
| `qbank_list_practices` | `src/qbank_practice.rs:42` | sync | app | src/api/practiceApi.ts:116 | (scopeId: string, submitted: boolean, offset?: integer(u32) \| null) → PracticeSummary[] ! AppError |
| `qbank_list_questions` | `src/commands.rs:7572` | async | app | src/components/QuestionFavoritesView.tsx:130<br>src/hooks/useQuestionBankSession.ts:285<br>src/hooks/useQuestionBankSession.ts:303<br>…共 7 处 | (request: ListQuestionsRequest) → QuestionListResult ! AppError |
| `qbank_list_structure` | `src/commands.rs:1530` | sync | app | src/api/questionBankApi.ts:309 | (examId: string) → QuestionBankStructure ! AppError |
| `qbank_rebuild_fts_index` | `src/commands.rs:7664` | async | app | src/stores/questionBankStore.ts:1520 | (（无）) → integer(u64) ! AppError |
| `qbank_refresh_stats` | `src/commands.rs:7896` | async | app | src/hooks/useQuestionBankSession.ts:490<br>src/hooks/useQuestionBankSession.ts:640<br>src/stores/questionBankStore.ts:1872 | (examId: string) → dstu_vfs__vfs__repos__question_repo__QuestionBankStats ! AppError |
| `qbank_remove_question_image` | `src/commands.rs:8727` | async | none | — | (questionId: string, imageId: string) → null ! AppError |
| `qbank_reparse_report` | `src/commands.rs:1576` | sync | app | src/components/QuestionImportAuditPanel.tsx:177 | (examId: string, jobId?: string \| null) → ReparseReport ! AppError |
| `qbank_reparse_resolve` | `src/commands.rs:1590` | sync | app | src/components/QuestionImportAuditPanel.tsx:189 | (examId: string, jobId: string, decisions: ReparseDecision[], expectedReportVersion: string) → ReparseResolveReceipt ! AppError |
| `qbank_reset_progress` | `src/commands.rs:7940` | async | app | src/stores/questionBankStore.ts:1882 | (examId: string) → dstu_vfs__vfs__repos__question_repo__QuestionBankStats ! AppError |
| `qbank_reset_questions_progress` | `src/commands.rs:7954` | async | app | src/features/learning-hub/apps/views/ExamContentView.tsx:1818 | (questionIds: string[]) → BatchResult ! AppError |
| `qbank_resolve_authoring_route` | `src/commands.rs:1467` | async | app | src/components/ExamSheetUploader.tsx:431 | (modelConfigId?: string \| null, requiresVision: boolean) → Value ! AppError |
| `qbank_resume_practice_grading` | `src/qbank_practice.rs:96` | sync | app | src/api/practiceApi.ts:127 | (（无）) → null |
| `qbank_retry_practice_grading` | `src/qbank_practice.rs:101` | sync | app | src/api/practiceApi.ts:124 | (id: string, questionId: string) → PracticeAttempt ! AppError |
| `qbank_review_authoring_draft` | `src/commands.rs:1410` | sync | none | — | (jobId: string, expectedVersion: integer(i64), coverage?: Value[] \| null, issues?: Value[] \| null, unmatchedAnswers?: Value[] \| null) → QuestionAuthoringDraft ! AppError |
| `qbank_save_practice` | `src/qbank_practice.rs:25` | sync | app | src/api/practiceApi.ts:100 | (request: SavePracticeRequest) → PracticeDraft ! AppError |
| `qbank_search_questions` | `src/commands.rs:7641` | async | app | src/stores/questionBankStore.ts:1497 | (request: SearchQuestionsRequest) → QuestionSearchListResult ! AppError |
| `qbank_start_timed_practice` | `src/commands.rs:8081` | async | app | src/stores/questionBankStore.ts:2253 | (request: StartTimedPracticeRequest) → TimedPracticeSession ! AppError |
| `qbank_submit_answer` | `src/commands.rs:7817` | async | app | src/features/learning-hub/apps/views/media/mediaCheckpoints.ts:110<br>src/features/learning-hub/mistakeBook/useMistakeRedoSession.ts:156<br>src/hooks/useQuestionBankSession.ts:542<br>…共 4 处 | (request: SubmitAnswerRequest) → SubmitAnswerResult ! AppError |
| `qbank_submit_mock_exam` | `src/commands.rs:8126` | async | app | src/stores/questionBankStore.ts:2311 | (request: SubmitMockExamRequest) → MockExamScoreCard ! AppError |
| `qbank_submit_practice` | `src/qbank_practice.rs:53` | sync | app | src/api/practiceApi.ts:111 | (id: string, revision: integer(i64)) → PracticeAttempt ! AppError |
| `qbank_toggle_favorite` | `src/commands.rs:7854` | async | app | src/components/practice/BatchPracticeWorkspace.tsx:534<br>src/features/learning-hub/apps/views/ExamContentView.tsx:1868<br>src/features/learning-hub/mistakeBook/useMistakeRedoSession.ts:206<br>…共 5 处 | (questionId: string) → Question ! AppError |
| `qbank_update_group` | `src/commands.rs:1501` | sync | app | src/api/questionBankApi.ts:317 | (groupId: string, label: string, questionIds: string[], materialIds: string[], expectedVersion: integer(i64)) → Value ! AppError |
| `qbank_update_material` | `src/commands.rs:1432` | sync | app | src/api/questionBankApi.ts:239 | (materialId: string, content: string, expectedVersion: integer(i64)) → QuestionMaterial ! AppError |
| `qbank_update_paper` | `src/qbank_practice.rs:85` | sync | app | src/api/practiceApi.ts:131 | (id: string, title?: string \| null, deleted: boolean) → null ! AppError |
| `qbank_update_question` | `src/commands.rs:7740` | async | app | src/components/QuestionInlineEditor.tsx:700<br>src/components/practice/AiExplanationWriteButton.tsx:70<br>src/features/learning-hub/apps/views/ExamContentView.tsx:1919<br>…共 4 处 | (request: UpdateQuestionRequest) → Question ! AppError |
| `rename_exam_sheet_session` | `src/commands.rs:980` | async | none | — | (request: RenameExamSheetSessionRequest) → RenameExamSheetSessionResponse ! AppError |
| `resume_question_import` | `src/commands.rs:1285` | async | app | src/components/ExamSheetUploader.tsx:1054 | (sessionId: string, importId?: string \| null) → QuestionImportDraftResponse ! AppError |
| `update_exam_sheet_cards` | `src/commands.rs:957` | async | app | src/api/questionBankApi.ts:607 | (request: UpdateExamSheetCardsRequest) → UpdateExamSheetCardsResponse ! AppError |

### 发出的事件（7）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `qbank_generation_task_event` | 常量 `QBANK_GENERATION_TASK_EVENT` | crates/dstu-qbank/src/qbank_generation/events.rs:16 (emit) |
| `qbank-export-paper` | 字面量 | crates/dstu-qbank/src/qbank_practice/export_bridge.rs:46 (emit) |
| `qbank-practice-updated` | 字面量 | crates/dstu-qbank/src/qbank_practice.rs:671 (emit)<br>crates/dstu-qbank/src/qbank_practice.rs:788 (emit)<br>crates/dstu-qbank/src/qbank_practice.rs:955 (emit) |
| `qbank://changed` | 字面量 | src/chat_v2/tools/qbank_executor.rs:1436 (emit) |
| `review://changed` | 字面量 | src/chat_v2/tools/review_executor.rs:224 (emit) |
| `event_name` | 动态（表达式） | crates/dstu-qbank/src/qbank_grading/events.rs:28 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:55 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:70 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:103 (emit) |
| `qbank_grading_stream_{stream_session_id}` | 动态（format!） | crates/dstu-qbank/src/qbank_grading/events.rs:88 (emit) |

### 契约中的事件（10，`contracts/ipc/L14-qbank.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `csv_import_progress` | 否 | CsvImportProgress | src/commands.rs:1757 (emit) |
| `mistake_status_update` | 否 | object | src/commands.rs:969 (emit)<br>src/commands.rs:999 (emit) |
| `qbank-export-paper` | 否 | ExportRequest | crates/dstu-qbank/src/qbank_practice/export_bridge.rs:46 (emit) |
| `qbank-practice-updated` | 否 | string | crates/dstu-qbank/src/qbank_practice.rs:671 (emit)<br>crates/dstu-qbank/src/qbank_practice.rs:788 (emit)<br>crates/dstu-qbank/src/qbank_practice.rs:955 (emit) |
| `qbank://changed` | 否 | object \| object \| object | src/chat_v2/tools/qbank_executor.rs:1436 (emit)<br>src/commands.rs:1378 (emit)<br>src/commands.rs:1446 (emit)<br>src/commands.rs:1523 (emit)<br>src/commands.rs:1569 (emit)<br>src/commands.rs:1605 (emit)<br>src/commands.rs:1626 (emit) |
| `qbank_generation_task_event` | 否 | GenerationTaskView | crates/dstu-qbank/src/qbank_generation/events.rs:16 (emit) |
| `qbank_grading_stream_{stream_session_id}` | 是 | QbankGradingStreamError | crates/dstu-qbank/src/qbank_grading/events.rs:88 (emit) |
| `qbank_grading_stream_{}` | 是 | QbankGradingStreamCancelled \| QbankGradingStreamComplete \| QbankGradingStreamData \| QbankGradingStreamError | crates/dstu-qbank/src/qbank_grading/events.rs:28 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:55 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:70 (emit)<br>crates/dstu-qbank/src/qbank_grading/events.rs:103 (emit) |
| `question_import_progress` | 否 | QuestionImportProgress | src/commands.rs:1186 (emit)<br>src/commands.rs:1324 (emit) |
| `review://changed` | 否 | Value | src/chat_v2/tools/review_executor.rs:224 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

### 待办（lane 负责人：H1 接任，2026-11-04）

- [x] L02 `llmQuestionAuthoring@1` 已进 main：三处调用方改用 `src/question-authoring-llm.ts`，`src/question-json.ts` 已删除。
- [x] `resume_question_import`：旧路径编排 `src/question-import-legacy-vision.ts`（DocxVlmDirect / DOCX 原生 / Visual-First，
  按页 3 并发 + 逐页/逐批 checkpoint）接 L18 `questionImportVision`，已注册；测试 `tests/question-import-resume.test.ts`（host.invoke）。
- [ ] L11 发布 `files.ensureFileForBlobWithConn` 后核对 DocxVlmDirect 图片 file 行（BLOCKERS）。
- [x] `qbank_ai_generate_questions`：L13b `vfsRefText` 已进 main，按 H2 的 wire.py 接线并注册；生产入口测试 `tests/generation-invoke.test.ts`（2 条）。

### 题目集导入（2026-11-04 H1）

- 已注册：`cancel_question_bank_import`、`import_question_bank`、`import_question_bank_stream`
  （`src/question-import-{cancellation,service,runner,commands,wiring}.ts`、`source-bundle-{identity,scope}.ts`）。
  生产入口测试 `tests/question-import-invoke.test.ts`、`tests/question-import-cancellation.test.ts`；
  `resume_question_import` 命令层测试 `tests/question-import.test.ts`（未注册，直接驱动命令层函数）。

### CSV 四条命令（2026-11-04 接管会话）

- `get_csv_preview` / `import_questions_csv` / `cancel_questions_csv_import` / `export_questions_csv`
  已注册：`src/csv-codec.ts`（编码探测/csv-core 读取/GBK 编码）、`src/csv-import.ts`、
  `src/csv-export.ts::exportCsv`、`src/csv-commands.ts`；写入只经 L11 vfsRepo。
  测试 `tests/csv-commands.test.ts` 13 条（含 2 条 Rust 移植）。
- paper-docx 真实图片用例：F7 encode worker 缺 pngjs 时按 F7 同判据跳过（BLOCKERS），
  架构师已批准 pngjs/jpeg-js（D10），装好后该用例自动执行。

### 当前状态与下一步（2026-11-04 新会话续作）

已完成（提交在 `ds-mig/L14-qbank`，ACCEPTANCE 中的 Q1/Q3/Q4/Q5/Q6 定向项已处理）：

- Q4/Q5：`src/question-service.ts` 的逐项 catch、Database 包装、结构相等（数组/对象
  类型不同不再相等）及真实命令历史回归；`tests/questions.test.ts` 覆盖键序等价、
  `[]` vs `{}`、`[1]` vs `{"0":1}`。
- Q6：`tests/mastery-correction-contract.test.ts` 按 Rust 原名重放两条
  `mastery_qbank_correction.rs` 用例（首判返回值/链长/同向重放/tombstone）。
- Q1：同事务 `mastery.recordQbankAnswerWithConn`，提交后 reviewPlan/learner profile
  best-effort；`tests/submit-learning-loop.test.ts`。
- Q3：命令层取消链路与日志；生成 runner 的 token 登记仍未迁移（BLOCKERS）。
- Q8/D1：题目/历史/作答/统计写入改用 L11 `vfsRepo.questions` conn-bound 方法；
  WP-165 已核实 main `33d1323a9` 的 `updateAiFeedback`/`updateAiAnalysis`/
  `markAsModified`/`updateContentHash`，批改消费四原语并删除本地五个 writer/hash 副本。
- 原生接缝：`src/paper-docx.ts`、`src/crop-source-image.ts` 删除 sharp，经
  `src/native-image.ts` 只消费 F7 `nativeImage` 正式能力；main 未合入 F7 时图片路径
  显式失败/按 capability 跳过，缺口与 Rust 调用参数见 BLOCKERS。
- L18：`get_exam_sheet_session_detail`/`update_exam_sheet_cards`/
  `rename_exam_sheet_session` 已注册并走 `examSheetSession` 服务。

剩余与顺序：

1. Q2：`src/llm-completion.ts` 已传播取消失败、maxRetries=0、拒绝 nonStream 回退、
   对齐 120s header/idle；`reasoning_chars` 因 L02 只给 `reasoningBytes` 暂置 0，
   等 L02 发布字符数（BLOCKERS）。
2. Q7 旧会话已有通过证据，仍待复核签收：测试 fixture 复用真实迁移模板（`tests/support/storage.ts`），
   全量 `host/plugins/qbank` 37 files / 241 passed / 2 skipped / Errors 0 /
   退出码 0（作业 `20261104091956-250d70`）。
3. Q8：WP-165 接入四个已发布原语，详见文末；不再等待旧 BLOCKERS 接口。
4. 生成 runner、导入/CSV、qbank/essay/review/import_source executor：依赖
    L02 补全/L18/L13b/CSV 依赖与 runner 迁移，TESTMAP 对应行保持 pending。

### v2 接手盘点（2026-11-04，GPT-6.1 Sol）

恢复基线 `566923a3e`，已合并 main（`a39917ac7`）。既有声明不视为 v2 验收；
下面逐模块覆盖现有注册命令与公开服务，数字对应 standard-v2 §1 的八类规则。
“待核”不是通过，也不是跨 lane 阻塞。`ACCEPTANCE.md` 在当前工作树缺失，
不创建/修改复核人文件；本轮以协调者注入 Q1–Q8 为复核来源，并上报缺失。

| 命令/模块（注册入口） | 问题类型与自查结论 | 证据（当前 TS 文件:行）/处理 |
|---|---|---|
| `qbank` 服务及题目列表/搜索/CRUD/收藏/历史/统计/作答/重置 | 1 接线存在；2 WP-165 清除 AI 四原语本地写；3 大整数全局“小整数”声明无证明；4/5/6 Q4/Q5 已有修复待签；7 同 conn 事务存在；8 未签收 | `src/question-service.ts:393-517`；`src/grading-service.ts::persistGradingResult`；版本边界待独立审读 |
| practice/paper 16 条命令及启动恢复 | 1 生产接线存在；2 题目写走 L11；3 冻结 JSON 解码待逐字段核；4/6 resume 的失败传播疑与 Rust 不同；5 既有测试待逐断言核；7 await 创建 scheduler/queue 有双实例竞态；8 未签 | `index.ts:470-584`；`src/practice-grading-queue.ts:255-289`；Rust `qbank_practice.rs:733-757` 静态锁；优先移出入口并消除重复初始化 |
| learning trend/activity/knowledge/calendar/daily/timed/mock exam | 1 已注册；2 调 L11 题目写 API；3 请求默认值/版本待核；4/5/6 各排序/错误/测试待逐条核；7 墙钟用途逐处核；8 未签 | `index.ts:586-608`；`src/statistics-service.ts:195` |
| structure/group/material/authoring draft/commit/legacy/reparse/export document/portable | 1 已注册；2 qbank 自有表及 L11 conn API；3 发现未验证持久化 JSON；4/6 索引失效事务位置待核；5 测试不可据名称签收；7 OCC 精度待核；8 未签 | `index.ts:610-658,673-676,742-769`；`repository/authoring.ts:50-60,85-86,89-111`；`src/authoring-service.ts:175`；后续按 Rust struct 补解码器 |
| generation task get/list/cancel、grading cancel | 1 命令存在但生成 token 无生产登记者；2 task 表自有；3 task JSON 待核；4 命令取消日志已存在；5/6 生成全链缺失；7 cancel 顺序已修；8 Q3 未签 | `index.ts:402-416,699-726`；`src/generation-session.ts`；runner 自有工作，不列外部阻塞 |
| `qbank_ai_grade` 与 practice LLM grader | 1 真实 L02 补全已接；2 WP-165 消费 L11 四原语；3 WP-207 保留结构化错误；4/6 取消错误已传，不流式回退仍实际发送第二请求；5 已有 verdict 后取消回归需核；7 24h 不等于无限时；8 Q2 未签 | `index.ts:769-781`；`src/llm-completion.ts:111-169`；其余旧审读项不因本包四原语接入而签收 |
| CSV fields、importing sessions、exam session list/detail/update/rename | 1 注册存在；2 L18/L11 API 接线；3 元数据有无校验断言待修；4/5/6 L18 事件链已有测试待核；7 IO/时钟待核；8 未签 | `index.ts:364-401`；`src/exam-sheet-sessions.ts:130` |
| route/inspect PDF/source page/source images/crop/remove image/DOCX | 1 已注册；2 nativeImage 走 F7，不直引 sharp；3 文件/块入参待核；4/6 错误顺序待逐条核；5 图片正向因能力缺失跳过，不可签；7 DOCX 打包/图片 worker 语义待核；8 未签 | `index.ts:660-698,751-755,816-828`；`src/native-image.ts`；F7 main 仅 dimensions/decodeRgba |
| heatmap/enhanced statistics/paper export completion | 1 已注册；2 只读跨库/本插件导出文件；3/4/5/6 持久化/文件/错误与测试待核；7 同步目录遍历/桥接清理待核；8 未签 | `index.ts:771-814`；`src/enhanced-statistics.ts`、`src/paper-export-bridge.ts` |
| 未注册的 8 条 import/CSV 命令及 AI generation；四类 executor | 1/5/6 尚未迁移，不计完成；2/3/4/7 随迁移按 Rust 补齐；8 未签 | `SPEC.md:34-86,106-122,178-230`；`TESTMAP.md:147-162,192-243`；自身 runner/executor 不是阻塞，CSV 成熟库审批单列 |

复核未勾项计划：Q1 先消除缺服务静默跳过，待真实 L15 main API 后补组合；Q2
核实现有取消回归并请求 L02 正式 SSE-only/无总时限/字符数；Q3 随生成 runner
登记 token；Q4/Q5/Q6 不重写已修分支，保留证据交复核；Q7 本机队列重跑保留
Errors/exit，不自签；Q8 四方法已在 WP-165 替换并删 SQL；
入口编排先移至 src 并用生产入口回归并发初始化。所有移植测试仍需逐 Rust 断言复核，
167 ported/74 pending 只是现有 TESTMAP 状态，不代表 v2 通过。

历史跨 lane 缺口（非本包全域重验）：L11 四方法已由 WP-165 解除；FTS 已见上文接线；L15 reviewPlan 尚未合 main；
L02 SSE-only/无总时限策略和 reasoningChars；F7 图片裁剪/缩放/编码尚未合 main；
CSV 库精确版本/encoding_rs 等价性审批。详见 BLOCKERS，需通过 coord escalate。

### v2 排雷清单（X6 基线 `2ee9a9cbe`，当前核验 `07c8e5287`）

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。
当前核验用 `node scripts/electron-migration/gate-checks/<gate>.mjs --json` 按 `host/plugins/qbank/`
过滤。info / assert 计数 / log 计数只作人工线索，不直接判失败。行号为当前 SHA。
无既有 ID 的按 `X6-<门禁>-qbank-<文件短名>-<基线行>` 登记。

#### single-writer（基线 65 候选）

| 条目 | 当前核验 | Rust 证据 / 对应 finding | 状态 |
|---|---|---|---|
| `qbank_sources/materials/groups/group_materials/practice_attempts` 全部 foreign-table-write（authoring.ts 85…314、management.ts 162…353、practice.ts 48/66/95；当前另含 exam-cascade.ts 50…100） | 仍报：`table-owners.json` 仍写 owner=vfs-repos | 协调者已裁定归 L14。Rust 主写入在 `dstu-qbank`（authoring/management/practice）；exam-cascade 对应 `exam_repo.rs:902-911,1246-1254,2115-2175` | 误报，待 X6 订正 registry；不搬给 L11 |
| export.ts 340/349 `blobs`/`files` INSERT（X6-single-writer-qbank-export-340/349） | 已消失 | `question_export_service/authoring.rs:265-285` 调 `VfsBlobRepo::store_blob` + `VfsFileRepo::create_file` | 已修 `07c8e5287`（实现）+ `ee47fc4fc`（测试/宿主）。改用 `vfsRepo.blobs.storeBlob` / `vfsRepo.files.createFile`。旧 SQL 写 ref_count 0、id `file_<hash10>`、无 resources 行 |
| questions.ts 452/453/456 `questions_fts` | 已消失 | 生产走 L11 `questions.rebuildFtsIndex`（`src/question-service.ts:94`） | 已修 `fc4125be5`（删除无调用者副本） |
| questions.ts 499 `question_bank_stats`、544 `question_history`、846/855/858/953 `answer_submissions`，以及 questions.ts / legacy.ts / management.ts 的其余 `questions` 写（170…961） | 已消失 | D1 改走 L11 `QuestionRepository` | 基线后已修（main 前序提交），不重开 |
| questions.ts 原 500/505/512/519 `questions`（基线 529/536/556/580 一带） | WP-165 删除四个 writer 与私有 hash | Q8：`pipeline.rs:596–636` → `host.questions`；L11 `questions.ts:598–620` | 依赖已解除：main `33d1323a9` 公开四方法；同 conn/now，mark/hash 分别包装错误。证据见 WP-165 |
| duplicate-repository [info] | 仍报（随上面 registry 与 Q8） | — | 线索，随上两项一起消除 |

#### unchecked-decode（基线 22 候选）

| 条目（当前行） | Rust 结构 | 状态 |
|---|---|---|
| practice.ts:8 `parse<T>`（练习草稿/试卷/作答 document_json） | `qbank_practice.rs` `PracticeDraft` / `PracticeAttempt` / paper serde | 待修：按 struct 写 unknown→字段解码器 |
| authoring.ts:51 / 241 / 279；src/authoring-service.ts:175 `CommitReceipt` | `qbank_document.rs` / `qbank_authoring_service.rs:280,344,392,649-659` | 已修 `c3ee01079`（UD-0054/0055/0056/0066）。provenance 解析失败按 Rust `.ok()` 读作 Null |
| export.ts:29 `parse<T>`（images_json / source_refs_json）、315 manifest、317 document | `authoring.rs:221-233` 以 `Value` 读取，随后按字段判断 | 待修。manifest/document 在 Rust 是 `Value`，只需去掉断言、改为 unknown 收窄，不补不存在的算法 |
| legacy.ts:701；src/legacy-service.ts:241（reparse receipt/decisions） | `qbank_legacy_reconcile.rs:508-516,1042-1047` | 已修 `c3ee01079`（UD-0062；legacy-service 的 decisions 行同批） |
| management.ts:46；legacy.ts:142 / 896；src/legacy-service.ts:334 | `qbank_helpers` / legacy 预览、元数据、导入状态 | 待修（UD-0061/0063/0064/0067） |
| exam-cascade.ts:62（当前新增） | `exam_repo.rs:2160` `serde_json::from_str::<Value>` | 只需去断言（`Value` 等价 `JsonValue` 收窄），待改 |
| double-assertion [info]：index.ts:97/113/148、export.ts:386、legacy.ts:79/363/414、management.ts:381/426、src/exam-sheet-sessions.ts:130 | — | 线索，逐处核：服务查找类断言随宿主类型处理；数据类随上面解码器一起改 |

#### prod-reachable（基线 3 候选）

| 条目 | 状态 |
|---|---|
| tests/generation-validation.test.ts → `buildGenerationInstructions` | 真实不可达：生成 runner 与 `qbank_ai_generate_questions` 尚未迁移（BLOCKERS「L14 自身：生成 runner」）。TESTMAP 不按已完成计 |
| tests/qbank-read.test.ts → `contextText` / `contextWithConn` | 待核：Rust 消费方为 L04/L07 工具 executor（BLOCKERS「工具执行器注册与消费」）。未接入前不算生产可达 |
| 当前 SHA 新增的 vfsRepos / review / notes / memory / QuestionRepo / ExamRepo 条目 | 测试宿主装载的兄弟插件真实实现，不是 qbank 被测符号；工具误报，交 X6 |

#### assert-parity（基线 24 候选）与 log-parity（基线 8 候选，均 info）

assert-deficit 所列 tests（authoring 207、generation-validation 86、grading-prompts 180/189/196、
grading-pipeline 257/284/309/334、legacy 80/149、management 74/225、practice 343、statistics 87、
questions 255/359/422、grading-images 71、verdict-three-paths 233/328/353/385）：
状态为「待逐 Rust assert 核」。不用数量补 expect；核出缺项时按原 assert 补，并在提交里标对应 ID。
本轮已核 practice.test.ts `snapshots_retain_*`，补了 Rust 的 3 条 `retains_asset` 断言（`243864e4a`）。
log-parity（statistics.ts、csv-export.ts、pdf-inspection.ts、heatmap.ts）：待逐 Rust 日志位置核。

#### C2 稳定 ID 映射（冻结报告 `0119143715c0`，基线 `2ee9a9cbe`）

只映射，不重编号；状态以上表为准。

| C2 ID | 对应上表条目 | 状态 |
|---|---|---|
| X6-SW-0021…0027、0036、0037、0040、0042、0043、0046…0051 | `qbank_sources/materials/groups/group_materials/practice_attempts` | C2 `037376b1e` 已裁定归 L14；registry 订正后消失，不搬 SQL |
| X6-SW-0030 / 0031 | export.ts `blobs` / `files` | 已修 `07c8e5287` + `ee47fc4fc` |
| X6-SW-0052…0054 | `questions_fts` | 已修 `fc4125be5` |
| X6-SW-0028、0029、0032…0035、0038、0039、0041、0044、0045、0055、0058…0063、0066…0073 | `questions` / `question_history` / `question_bank_stats` / `answer_submissions` 已改走 L11 | 基线后已修，当前门禁无此类 |
| X6-SW-0056 updateAiFeedback、0057 updateAiAnalysis、0064 markAsModified、0065 updateContentHash | Q8 四方法 | WP-165 改为消费已 main L11 原语，旧本地副本删除；交协调者复核 |
| X6-UD-0065 | practice.ts:8 | 已修 `8626ab1cb`（逐字段解码 + 生产入口回归） |
| X6-UD-0054、0055、0056、0062、0066 | authoring / reparse | 已修 `c3ee01079` |
| X6-UD-0057…0061、0063、0064、0067 | 上表 unchecked-decode 其余行 | 待修 |
| X6-PR-0114 / 0115 / 0116 | 上表 prod-reachable | 同上表结论 |
| X6-AP-0365 | authoring.test.ts:207 缺 Rust `assert_eq!(count, 1)` | 已补 `c3ee01079` |
| X6-AP-0366…0383、0385…0389 | 上表 assert-parity | 人工候选，逐 Rust assert 核；AP-0384 在 review/tests，归 L15 |
| X6-LP-0236…0243 | 上表 log-parity | 人工候选 |

### F4 Value 数字投影 + exam 级联服务接线（2026-11-05）

- 历史：`34402a1ff`/`1eb1fef75` 先关闭 F4 类型诊断；C1 复核后由 `78f1dd8cf` 把有限高精度
  小数纳入同一 Value 持久化合同。
- 数字合同：`src/raw-json-number.ts::jsonNumberValue` 对 Value 数字统一投影：安全整数保持
  number；小数/指数/超安全整数走 F4 公开 `jsonNumberToRawJSON` 原生 atom，
  `JSON.stringify` 原样保留 `1.234567890123456789`、`0.1000000000000000001`、`1e-400`、`1e+2`。
  typed f64 只在 `repository/serde-decode.ts` 边界从 atom 读取数值；
  `generation-figures.ts` 的 bbox 同样在业务边界读取；generic Value 不舍入、不转字符串/Infinity。
  `schema_version` 仍按 `as_i64` 只认 u64/i64 的整数 2，F64 `2.0`/`2e0` 与 arbitrary 不算；
  重复键 last-wins、首键位置保持。
- 测试：`question-import-value.test.ts` 5 条无条件断言（无 catch/能力分支）：大整数、
  arbitrary、高精度小数/underflow/指数、typed f64 边界、重复键 last-wins；
  `question-import-resume.test.ts` 补 `2e0` 旧 checkpoint 负例。`tests/f4-value-strict.mjs`
  无 catch，与 F4 公开 `jsonNumberToRawJSON` 逐字节对拍，异常即 exit 1。
- 联合集成：正常 merge F4 provider 树 `30747990c`（含 `71f7a3d10`、L22 `bb851c94e`、
  L18 `64ffea98c`）、L18 后续 `5e37aeae1` 与 `65a801993`/`f9d949d43` owner 树，非 cherry-pick。
- 验证：`tsc -p tsconfig.host.json` exit 0（作业 `20261105101902-ff4508`）；
  `host/plugins/qbank` 52 files / 337 passed / 0 failed / 0 skipped / Errors 0 / exit 0
  （作业 `20261105102133-575af5`）；严格脚本 `f4 value strict: ok` exit 0
  （作业 `20261105101902-29f778`）。最终 tip gate 在提交后执行。
- 两个 exam 级联测试仍用真实服务：`practice.test.ts` 使用插件 `ctx.vfsRepo.exams`；
  `authoring-copy.test.ts` 装载真实 qbank 插件；原 soft-delete/copy/restore 断言未改。

### WP-207（2026-11-05）：qbank_ai_grade 结构化错误边界

- 起点工作树干净、旧 writer 159496 已退出；正常 merge main `b17264b88`，保留
  WP-156/080/052 历史。只处理 `index.ts` 本命令 catch 的二次 Database 包装。
- 原反证：`/tmp/opencode/x1-b-v0-9Dp52W/provider-check.json` 两 HTTP500 take 均
  `Database !== LLM`；`5/take-0/step-4.json` message 为完整 LLM AppError JSON。
- 当前 TESTMAP 实际行数为 241：183 ported / 58 pending / 0 merged / 0 obsolete
  （计数 job `20261105213747-473bd3`）。旧生成表头 167/74 是历史缓存；本包保持全部
  去向与原断言，新增命令边界回归不领取 Rust 测试迁移条目。
- 本包验收、原红/修后回归与官方 lane-gate 分别记录在 WP-207 交付报告；main 集成与
   X1 原两 take 复验由协调者安排，不恢复旧资格。

### WP-165：批改消费真实 L11 四原语

- 基线正常 fast-forward 到 `33d1323a9`（含 WP-021/178/207）；四方法公开签名及实现已核。
- `persistGradingResult` 只将原 conn/now/参数交给 `host.questions`；Grade 写 ai_score，
  Analyze 保分数、保回填与先 mark 后 hash。错误依次为“保存 AI 反馈失败: …”、
  “标记同步状态失败: …”、“更新内容哈希失败: …”。没有增加连接/事务或复制 hash。
- 全本域调用点检查：四个 writer 只有 `src/grading-service.ts` 消费，私有 `contentHash`
  只由旧 `updateContentHash` 调用；删除这五个副本及其 createHash import，其它仓储保留。
- 新增 `tests/grading-owner-writes.test.ts`：真实注册命令/L02/L01 HTTP sidecar/L11/F3，
  Grade/Analyze、空/空白/已有解析、缺失/软删、同 conn 隔离回滚、真实 SQL trigger 的
  AI/mark/hash 失败、精确错误与顺序及失败草稿；继续跑 WP-207 三回归及原 pipeline 用例。
- TESTMAP 去向保持 183 ported / 58 pending（241）；新增消费证据不认领 Rust ID。
- 范围残差：供方 options/tags/images typed 解码、既存回填通用 updateQuestion 的额外
  mark/hash 见 BLOCKERS/SPEC；未签全域等价。X1/210 固定 main 独验由协调者另行安排。

### G1（2026-11-06）：启动时 “Practice grading queue: VFS 仓库服务未提供”

- 根因：`host/profiles/desktop.json` 安装顺序为 dstu.llm(:98) → dstu.qbank(:121) →
  dstu.vfs-repos(:157)；qbank 顶层 `inject` 只有 storage/paths，旧代码在 `apply` 里直接
  `runtime.start()`，此时 `ctx.get('vfsRepo')` 为空，`startGrading` 的 catch 记 error。
  Rust `AppState` 构建时 vfs_db/llm_manager 总在 qbank 恢复之前就绪。
- 修复已在 WP-080 `7a822332b`（index.ts:571，在 `vfsRepo/llm/llmStreaming` 的
  `ctx.inject` 子作用域里启动恢复；不吞错误，服务缺失时仍按原路径报错）。回归
  `tests/practice-runtime.test.ts` 按官方 profile 真实相对顺序装载。X1 红证据
  `/tmp/opencode/x1-real-dist-PvK4l4/stderr.log:1` 的 tip `53437fb6c` 早于该提交。
- 真实 Electron 复验（production `electron/main.ts` start() + desktop profile，tip
  `b1ff1c68e`）：job `20261106013902-bfae30` exit 0，`[qbank]` stderr 行 0 条，
  `qbank_resume_practice_grading` 返回 null；证据 `/tmp/opencode/l14-g1/fixed-YI7qUF/`。
  typecheck job `20261106014948-ec59bf` exit 0；qbank 全量 357/357 job
  `20261106015346-729d05` exit 0。
