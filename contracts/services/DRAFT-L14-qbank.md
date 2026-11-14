# 跨 lane 服务草稿：L14-qbank

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（55 个条目，其中 54 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_qbank::qbank_authoring_service::QuestionAuthoringService::new` | method | `crates/dstu-qbank/src/qbank_authoring_service.rs:67` | L22-app-commands 6/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyReconcileService::new` | method | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:260` | L22-app-commands 4/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_qbank::question_bank_service::QuestionBankService` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:30` | F1-kernel 2/0<br>L22-app-commands 1/0<br>L15-review-analytics 0/1 | `pub struct QuestionBankService` |
| `dstu_qbank::qbank_management::QuestionBankManagementService::new` | method | `crates/dstu-qbank/src/qbank_management.rs:150` | L22-app-commands 3/0 | `pub fn new(db: Arc<VfsDatabase>) -> Self` |
| `dstu_qbank::question_bank_service::BatchResult` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:98` | L22-app-commands 3/0 | `pub struct BatchResult` |
| `dstu_qbank::runtime::QbankState` | struct | `crates/dstu-qbank/src/runtime.rs:19` | F1-kernel 3/0 | `pub struct QbankState` |
| `dstu_qbank::qbank_authoring_service::QuestionAuthoringDraft` | struct | `crates/dstu-qbank/src/qbank_authoring_service.rs:19` | L22-app-commands 2/0 | `pub struct QuestionAuthoringDraft` |
| `dstu_qbank::question_bank_service::MockExamSession` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3356` | L22-app-commands 2/0 | `pub struct MockExamSession` |
| `dstu_qbank::question_import_service::CsvImportResult` | struct | `crates/dstu-qbank/src/question_import_service.rs:3938` | L22-app-commands 2/0 | `pub struct CsvImportResult` |
| `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor` | struct | `src/chat_v2/tools/review_executor.rs:53` | L13-vfs-api 1/0<br>F1-kernel 0/2 | `pub struct ReviewToolExecutor` |
| `dstu_qbank::question_bank_service::QuestionBankService::new` ? | method | `crates/dstu-qbank/src/question_bank_service.rs:106` | F2-shell 1/0<br>L15-review-analytics 0/2 | `pub fn new(vfs_db: Arc<VfsDatabase>) -> Self` |
| `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor` | struct | `src/chat_v2/tools/essay_grading_executor.rs:101` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct EssayGradingExecutor` |
| `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor::new` | method | `src/chat_v2/tools/essay_grading_executor.rs:104` | F1-kernel 1/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor::new` | method | `src/chat_v2/tools/qbank_executor.rs:1480` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor::new` | method | `src/chat_v2/tools/review_executor.rs:56` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_qbank::qbank_authoring_service::AuthoringCommitReceipt` | struct | `crates/dstu-qbank/src/qbank_authoring_service.rs:37` | L22-app-commands 1/0 | `pub struct AuthoringCommitReceipt` |
| `dstu_qbank::qbank_authoring_service::QuestionDraftSummary` | struct | `crates/dstu-qbank/src/qbank_authoring_service.rs:28` | L22-app-commands 1/0 | `pub struct QuestionDraftSummary` |
| `dstu_qbank::qbank_generation::recover_interrupted_tasks` ? | fn | `crates/dstu-qbank/src/qbank_generation/mod.rs:35` | F2-shell 1/0 | `pub fn recover_interrupted_tasks(vfs_db: &VfsDatabase)` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationAudit` | struct | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:93` | L22-app-commands 1/0 | `pub struct LegacyMigrationAudit` |
| `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationReceipt` | struct | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:116` | L22-app-commands 1/0 | `pub struct LegacyMigrationReceipt` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseDecision` | struct | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:178` | L22-app-commands 1/0 | `pub struct ReparseDecision` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseReport` | struct | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:158` | L22-app-commands 1/0 | `pub struct ReparseReport` |
| `dstu_qbank::qbank_legacy_reconcile::ReparseResolveReceipt` | struct | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs:195` | L22-app-commands 1/0 | `pub struct ReparseResolveReceipt` |
| `dstu_qbank::qbank_management::DeleteGroupMode` | enum | `crates/dstu-qbank/src/qbank_management.rs:104` | L22-app-commands 1/0 | `pub enum DeleteGroupMode` |
| `dstu_qbank::qbank_management::GroupDeleteResult` | struct | `crates/dstu-qbank/src/qbank_management.rs:114` | L22-app-commands 1/0 | `pub struct GroupDeleteResult` |
| `dstu_qbank::qbank_management::QuestionBankStructure` | struct | `crates/dstu-qbank/src/qbank_management.rs:64` | L22-app-commands 1/0 | `pub struct QuestionBankStructure` |
| `dstu_qbank::question_authoring_runner::resolve_visual_fallback` | fn | `crates/dstu-qbank/src/question_authoring_runner.rs:770` | L22-app-commands 1/0 | `pub async fn resolve_visual_fallback(llm: &LLMManager) -> Result<ApiConfig, AppError>` |
| `dstu_qbank::question_authoring_runner::SourceRange` | struct | `crates/dstu-qbank/src/question_authoring_runner.rs:57` | L22-app-commands 1/0 | `pub struct SourceRange` |
| `dstu_qbank::question_bank_service::ActivityHeatmapPoint` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3221` | L22-app-commands 1/0 | `pub struct ActivityHeatmapPoint` |
| `dstu_qbank::question_bank_service::CheckInCalendar` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3554` | L22-app-commands 1/0 | `pub struct CheckInCalendar` |
| `dstu_qbank::question_bank_service::DailyPracticeResult` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3432` | L22-app-commands 1/0 | `pub struct DailyPracticeResult` |
| `dstu_qbank::question_bank_service::GeneratedPaper` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3516` | L22-app-commands 1/0 | `pub struct GeneratedPaper` |
| `dstu_qbank::question_bank_service::KnowledgePoint` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3234` | L22-app-commands 1/0 | `pub struct KnowledgePoint` |
| `dstu_qbank::question_bank_service::KnowledgeStatsComparison` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3255` | L22-app-commands 1/0 | `pub struct KnowledgeStatsComparison` |
| `dstu_qbank::question_bank_service::LearningTrendPoint` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3208` | L22-app-commands 1/0 | `pub struct LearningTrendPoint` |
| `dstu_qbank::question_bank_service::MockExamConfig` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3323` | L22-app-commands 1/0 | `pub struct MockExamConfig` |
| `dstu_qbank::question_bank_service::MockExamScoreCard` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3383` | L22-app-commands 1/0 | `pub struct MockExamScoreCard` |
| `dstu_qbank::question_bank_service::PaperConfig` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3464` | L22-app-commands 1/0 | `pub struct PaperConfig` |
| `dstu_qbank::question_bank_service::SubmitAnswerResult` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:36` | L22-app-commands 1/0 | `pub struct SubmitAnswerResult` |
| `dstu_qbank::question_bank_service::TimedPracticeSession` ? | struct | `crates/dstu-qbank/src/question_bank_service.rs:3292` | L22-app-commands 1/0 | `pub struct TimedPracticeSession` |
| `dstu_qbank::question_export_service::authoring::export_document` | fn | `crates/dstu-qbank/src/question_export_service/authoring.rs:17` | L22-app-commands 1/0 | `pub fn export_document(db: &VfsDatabase, exam_id: &str) -> Result<Value, AppError>` |
| `dstu_qbank::question_export_service::authoring::export_portable` | fn | `crates/dstu-qbank/src/question_export_service/authoring.rs:146` | L22-app-commands 1/0 | `pub fn export_portable(db: &VfsDatabase, exam_id: &str) -> Result<PortableExport, AppError>` |
| `dstu_qbank::question_export_service::authoring::PortableExport` | struct | `crates/dstu-qbank/src/question_export_service/authoring.rs:119` | L22-app-commands 1/0 | `pub struct PortableExport` |
| `dstu_qbank::question_export_service::CsvExportResult` | struct | `crates/dstu-qbank/src/question_export_service.rs:56` | L22-app-commands 1/0 | `pub struct CsvExportResult` |
| `dstu_qbank::question_export_service::vfs_hook::install_vfs_hooks` | fn | `crates/dstu-qbank/src/question_export_service/vfs_hook.rs:24` | F1-kernel 1/0 | `pub fn install_vfs_hooks(scope: &mut dstu_kernel::Scope)` |
| `dstu_qbank::question_import_service::CsvImportCancellation` | struct | `crates/dstu-qbank/src/question_import_service.rs:3961` | L22-app-commands 1/0 | `pub struct CsvImportCancellation` |
| `dstu_qbank::question_import_service::CsvPreviewResult` | struct | `crates/dstu-qbank/src/question_import_service.rs:4065` | L22-app-commands 1/0 | `pub struct CsvPreviewResult` |
| `dstu_qbank::question_import_service::ImportResult` | struct | `crates/dstu-qbank/src/question_import_service.rs:207` | L22-app-commands 1/0 | `pub struct ImportResult` |
| `dstu_qbank::question_import_service::PdfTextInspection` | struct | `crates/dstu-qbank/src/question_import_service.rs:221` | L22-app-commands 1/0 | `pub struct PdfTextInspection` |
| `dstu_qbank::question_import_service::QuestionImportCancellation` | struct | `crates/dstu-qbank/src/question_import_service.rs:141` | L22-app-commands 1/0 | `pub struct QuestionImportCancellation` |
| `dstu_qbank::question_import_service::QuestionImportCancellation::new` | method | `crates/dstu-qbank/src/question_import_service.rs:154` | L22-app-commands 1/0 | `pub fn new() -> Self` |
| `dstu_qbank::question_import_service::QuestionImportService::new` | method | `crates/dstu-qbank/src/question_import_service.rs:331` | F2-shell 1/0 | `pub fn new(llm_manager: Arc<LLMManager>, file_manager: Arc<FileManager>) -> Self` |
| `dstu_qbank::runtime::provide_state_resolver` | fn | `crates/dstu-qbank/src/runtime.rs:32` | F1-kernel 1/0 | `pub fn provide_state_resolver( resolver: Arc<dyn QbankStateResolver>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_qbank::runtime::QbankStateResolver` | trait | `crates/dstu-qbank/src/runtime.rs:25` | F1-kernel 1/0 | `pub trait QbankStateResolver: Send + Sync` |
| `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor` | struct | `src/chat_v2/tools/qbank_executor.rs:1477` | F1-kernel 0/1 | `pub struct QBankExecutor` |

### 引用点样例

- `dstu_qbank::qbank_authoring_service::QuestionAuthoringService::new` — L22-app-commands: `src/commands.rs:1373`, `src/commands.rs:1395`, `src/commands.rs:1407`, `src/commands.rs:1423`
- `dstu_qbank::qbank_legacy_reconcile::LegacyReconcileService::new` — L22-app-commands: `src/commands.rs:1551`, `src/commands.rs:1567`, `src/commands.rs:1586`, `src/commands.rs:1603`
- `dstu_qbank::question_bank_service::QuestionBankService` — F1-kernel: `src/agent_wiring/services.rs:22`, `src/agent_wiring/services.rs:48`；L22-app-commands: `src/commands.rs:692`；L15-review-analytics: `src/mastery/service/tests.rs:18`
- `dstu_qbank::qbank_management::QuestionBankManagementService::new` — L22-app-commands: `src/commands.rs:1515`, `src/commands.rs:1539`, `src/commands.rs:1624`
- `dstu_qbank::question_bank_service::BatchResult` — L22-app-commands: `src/commands.rs:7768`, `src/commands.rs:7793`, `src/commands.rs:7958`
- `dstu_qbank::runtime::QbankState` — F1-kernel: `src/extensions.rs:114`, `src/extensions.rs:115`, `src/extensions.rs:126`
- `dstu_qbank::qbank_authoring_service::QuestionAuthoringDraft` — L22-app-commands: `src/commands.rs:1390`, `src/commands.rs:1418`
- `dstu_qbank::question_bank_service::MockExamSession` — L22-app-commands: `src/commands.rs:8110`, `src/commands.rs:8122`
- `dstu_qbank::question_import_service::CsvImportResult` — L22-app-commands: `src/commands.rs:1715`, `src/commands.rs:1825`
- `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:116`, `src/agent_wiring/tests/headless_tests.rs:36`；L13-vfs-api: `src/chat_v2/tools/mod.rs:77`
- `dstu_qbank::question_bank_service::QuestionBankService::new` — F2-shell: `src/lib.rs:3596`；L15-review-analytics: `src/mastery/service/tests.rs:122`, `src/mastery/service/tests.rs:336`
- `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:115`；L13-vfs-api: `src/chat_v2/tools/mod.rs:64`
- `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:123`, `src/agent_wiring/tests/hooks_tests.rs:17`
- `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:66`
- `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:124`
- `dstu_qbank::qbank_authoring_service::AuthoringCommitReceipt` — L22-app-commands: `src/commands.rs:1368`
- `dstu_qbank::qbank_authoring_service::QuestionDraftSummary` — L22-app-commands: `src/commands.rs:1402`
- `dstu_qbank::qbank_generation::recover_interrupted_tasks` — F2-shell: `src/lib.rs:3514`
- `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationAudit` — L22-app-commands: `src/commands.rs:1546`
- `dstu_qbank::qbank_legacy_reconcile::LegacyMigrationReceipt` — L22-app-commands: `src/commands.rs:1562`
- `dstu_qbank::qbank_legacy_reconcile::ReparseDecision` — L22-app-commands: `src/commands.rs:1594`
- `dstu_qbank::qbank_legacy_reconcile::ReparseReport` — L22-app-commands: `src/commands.rs:1581`
- `dstu_qbank::qbank_legacy_reconcile::ReparseResolveReceipt` — L22-app-commands: `src/commands.rs:1598`
- `dstu_qbank::qbank_management::DeleteGroupMode` — L22-app-commands: `src/commands.rs:1615`
- `dstu_qbank::qbank_management::GroupDeleteResult` — L22-app-commands: `src/commands.rs:1619`
- `dstu_qbank::qbank_management::QuestionBankStructure` — L22-app-commands: `src/commands.rs:1534`
- `dstu_qbank::question_authoring_runner::resolve_visual_fallback` — L22-app-commands: `src/commands.rs:1479`
- `dstu_qbank::question_authoring_runner::SourceRange` — L22-app-commands: `src/commands.rs:1034`
- `dstu_qbank::question_bank_service::ActivityHeatmapPoint` — L22-app-commands: `src/commands.rs:8022`
- `dstu_qbank::question_bank_service::CheckInCalendar` — L22-app-commands: `src/commands.rs:8197`
- `dstu_qbank::question_bank_service::DailyPracticeResult` — L22-app-commands: `src/commands.rs:8151`
- `dstu_qbank::question_bank_service::GeneratedPaper` — L22-app-commands: `src/commands.rs:8172`
- `dstu_qbank::question_bank_service::KnowledgePoint` — L22-app-commands: `src/commands.rs:8045`
- `dstu_qbank::question_bank_service::KnowledgeStatsComparison` — L22-app-commands: `src/commands.rs:8059`
- `dstu_qbank::question_bank_service::LearningTrendPoint` — L22-app-commands: `src/commands.rs:7993`
- `dstu_qbank::question_bank_service::MockExamConfig` — L22-app-commands: `src/commands.rs:8102`
- `dstu_qbank::question_bank_service::MockExamScoreCard` — L22-app-commands: `src/commands.rs:8130`
- `dstu_qbank::question_bank_service::PaperConfig` — L22-app-commands: `src/commands.rs:8164`
- `dstu_qbank::question_bank_service::SubmitAnswerResult` — L22-app-commands: `src/commands.rs:7821`
- `dstu_qbank::question_bank_service::TimedPracticeSession` — L22-app-commands: `src/commands.rs:8085`
- `dstu_qbank::question_export_service::authoring::export_document` — L22-app-commands: `src/commands.rs:1498`
- `dstu_qbank::question_export_service::authoring::export_portable` — L22-app-commands: `src/commands.rs:1642`
- `dstu_qbank::question_export_service::authoring::PortableExport` — L22-app-commands: `src/commands.rs:1637`
- `dstu_qbank::question_export_service::CsvExportResult` — L22-app-commands: `src/commands.rs:1880`
- `dstu_qbank::question_export_service::vfs_hook::install_vfs_hooks` — F1-kernel: `src/extensions.rs:108`
- `dstu_qbank::question_import_service::CsvImportCancellation` — L22-app-commands: `src/commands.rs:712`
- `dstu_qbank::question_import_service::CsvPreviewResult` — L22-app-commands: `src/commands.rs:1972`
- `dstu_qbank::question_import_service::ImportResult` — L22-app-commands: `src/commands.rs:1071`
- `dstu_qbank::question_import_service::PdfTextInspection` — L22-app-commands: `src/commands.rs:1046`
- `dstu_qbank::question_import_service::QuestionImportCancellation` — L22-app-commands: `src/commands.rs:715`
- `dstu_qbank::question_import_service::QuestionImportCancellation::new` — L22-app-commands: `src/commands.rs:1299`
- `dstu_qbank::question_import_service::QuestionImportService::new` — F2-shell: `src/lib.rs:1666`
- `dstu_qbank::runtime::provide_state_resolver` — F1-kernel: `src/extensions.rs:143`
- `dstu_qbank::runtime::QbankStateResolver` — F1-kernel: `src/extensions.rs:125`
- `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:78`

## 消费其他 lane

### F4-security（34 个条目，prod 982 / test 35）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError` | struct | 267/2 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_generation/mod.rs` 等 26 个 |
| `dstu_core::models::AppError::validation` | method | 253/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_generation/mod.rs` 等 19 个 |
| `dstu_core::models::AppError::database` | method | 194/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_generation/mod.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs` 等 16 个 |
| `dstu_core::agent::ToolCall` ? | struct | 53/1 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` 等 4 个 |
| `dstu_core::models::AppError::not_found` | method | 42/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/image_answer.rs` 等 11 个 |
| `dstu_core::models::QuestionStatus` | enum | 20/0 | `crates/dstu-qbank/src/question_import_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 18/10 | `crates/dstu-qbank/src/qbank_generation/mod.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 8 个 |
| `dstu_core::models::AppError::llm` ? | method | 18/1 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/stream.rs`, `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_core::tool_args::with_localized_message` ? | fn | 18/0 | `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` |
| `dstu_core::models::ExamSheetPreviewResult` | struct | 17/0 | `crates/dstu-qbank/src/question_import_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 14/0 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` |
| `dstu_core::models::AppError::internal` | method | 13/0 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_practice/export.rs`, `crates/dstu-qbank/src/question_authoring_runner.rs` 等 5 个 |
| `dstu_core::models::ExamSheetPreviewPage` | struct | 10/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_core::models::ExamCardPreview` | struct | 8/0 | `crates/dstu-qbank/src/question_import_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_core::models::QuestionType` | enum | 8/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 3/1 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` 等 4 个 |
| `dstu_core::models::AppError::configuration` ? | method | 3/1 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/stream.rs`, `crates/dstu-qbank/src/question_authoring_runner.rs` 等 4 个 |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 3/0 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 3/0 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` |
| `dstu_core::tool_args::get_string_array_arg` ? | fn | 3/0 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_core::models::SourceType` | enum | 2/4 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 2/3 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/question_authoring_runner/plan.rs` |
| `dstu_core::models::QuestionBankStats` | struct | 2/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_core::models::AppErrorType` | enum | 1/4 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/question_authoring_runner/plan.rs` |
| `dstu_core::models::AppError::conflict` | method | 1/0 | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 1/0 | `crates/dstu-qbank/src/question_authoring_runner.rs` |
| `dstu_core::tool_args::ensure_localized_error` ? | fn | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_platform::background_tasks::spawn` | fn | 1/0 | `crates/dstu-qbank/src/qbank_generation/mod.rs` |
| `dstu_platform::debug_log_service::write_debug_response_entry` | fn | 1/0 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs` |
| `dstu_util::utils::sse_buffer::extract_stream_data_payload` | fn | 1/0 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::new` | method | 1/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 0/5 | `src/chat_v2/tools/qbank_executor.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_core::models::ModelAssignments` | struct | 0/2 | `tests/qbank_executor_e2e.rs` |
| `dstu_core::models::AppError::network` ? | method | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |

### L11-vfs-repos（110 个条目，prod 519 / test 313）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::question_repo::QuestionType` ? | enum | 83/113 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 13 个 |
| `dstu_vfs::vfs::repos::question_repo::Question` | struct | 36/14 | `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_practice.rs` 等 10 个 |
| `dstu_vfs::vfs::repos::question_repo::QuestionFilters` | struct | 29/0 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs`, `crates/dstu-qbank/src/question_export_service.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::question_repo::QuestionImage` | struct | 27/1 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs` 等 7 个 |
| `dstu_vfs::vfs::repos::question_repo::QuestionStatus` ? | enum | 19/19 | `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` 等 7 个 |
| `dstu_vfs::vfs::repos::question_repo::Difficulty` ? | enum | 18/2 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/question_bank_service.rs`, `crates/dstu-qbank/src/question_export_service.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_exam_sheet` ? | method | 15/4 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::question_repo::UpdateQuestionParams` | struct | 14/5 | `crates/dstu-qbank/src/question_bank_service.rs`, `crates/dstu-qbank/src/question_import_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionOption` | struct | 14/2 | `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::refresh_stats_with_conn` | method | 14/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_management.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_question_with_conn` ? | method | 11/2 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_practice.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_status` | method | 11/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::refresh_stats` | method | 11/0 | `crates/dstu-qbank/src/question_bank_service.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::list_questions` ? | method | 10/1 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` 等 6 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo` | struct | 9/28 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 17 个 |
| `dstu_vfs::vfs::repos::question_repo::CreateQuestionParams` | struct | 9/13 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` 等 11 个 |
| `dstu_vfs::vfs::repos::question_repo::AnswerSubmission` | struct | 9/4 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::clear_import_state` | method | 9/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::random_question_ids` | method | 9/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::SourceType` ? | enum | 7/12 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 9 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::create_exam_sheet` ? | method | 7/11 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_management/tests.rs` 等 12 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::create_question` ? | method | 6/13 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_practice.rs` 等 10 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob` ? | method | 6/3 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs`, `crates/dstu-qbank/src/question_export_service/authoring.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::record_history` | method | 5/1 | `crates/dstu-qbank/src/qbank_management/tests.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_import_state` | method | 5/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionBankStats` | struct | 5/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_question` ? | method | 4/12 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_management/tests.rs`, `crates/dstu-qbank/src/qbank_practice.rs` 等 10 个 |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo` | struct | 4/8 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` 等 12 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 4/1 | `crates/dstu-qbank/src/qbank_generation/reference.rs`, `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_export_service/authoring.rs` 等 5 个 |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_round` | method | 4/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 4/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs`, `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_export_service/authoring.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::record_history_with_conn` | method | 4/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_management.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::update_question` | method | 4/0 | `crates/dstu-qbank/src/question_bank_service.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo` | struct | 3/4 | `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/image_answer.rs`, `src/chat_v2/tools/qbank_executor.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path` | method | 3/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs`, `crates/dstu-qbank/src/question_export_service/authoring.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_latest_round_number` | method | 3/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_exam_sheet_with_conn` | method | 3/0 | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_preview_json_with_conn` | method | 3/0 | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::create_question_with_conn` | method | 3/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_submissions` | method | 2/10 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs`, `tests/qbank_executor_e2e.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file` ? | method | 2/3 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_export_service/authoring.rs`, `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_submissions_with_conn` ? | method | 2/1 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_content_bounded` | method | 2/0 | `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/image_answer.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_essay_content` | method | 2/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_preview_json_if_unchanged` | method | 2/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::Difficulty::from_str` | method | 2/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionSearchFilters` | struct | 2/0 | `crates/dstu-qbank/src/question_bank_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_question_by_card_id` | method | 2/0 | `crates/dstu-qbank/src/question_bank_service.rs`, `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::invalidate_exam_content_index_with_conn` | method | 2/0 | `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_management.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::random_questions` | method | 2/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::submit_answer_with_conn` | method | 2/0 | `crates/dstu-qbank/src/qbank_practice.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewPlan` | struct | 2/0 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewPlanStatus` | enum | 1/5 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::delete_question` ? | method | 1/3 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_history` | method | 1/3 | `crates/dstu-qbank/src/qbank_management/tests.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_stats` | method | 1/3 | `crates/dstu-qbank/src/qbank_management/tests.rs`, `crates/dstu-qbank/src/question_bank_service.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::insert_submission_with_conn` ? | method | 1/1 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::get_by_id_with_conn` | method | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::resolve_file_id_with_conn` | method | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo` | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::count_rounds_by_session` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::count_sessions` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::create_session` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_session` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_rounds_by_session` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_sessions` | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::ImportingSession` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::count_exam_sheets` | method | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_import_state` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_exam_sheets` | method | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_importing_sessions` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::purge_exam_sheet` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_preview_json` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::update_status_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content` | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file_with_conn` | method | 1/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs` |
| `dstu_vfs::vfs::repos::pomodoro_repo::VfsPomodoroRepo::focus_seconds_by_local_date` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::MistakeListFilters` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::MistakeListResult` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionHistory` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionListResult` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionSearchListResult` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionType::from_str` | method | 1/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::SearchSortBy` | enum | 1/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::batch_create_questions` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::count_by_type` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::count_questions` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::delete_question_if_version_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::delete_question_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::delete_submissions_by_exam_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::delete_submissions_by_question_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_questions_by_ids` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_submission_by_client_request_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::insert_submission_with_snapshot_with_conn` | method | 1/0 | `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::list_mistakes` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::rebuild_fts_index` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::search_questions` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::update_question_with_conn` | method | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::DueReviewsFilter` | struct | 1/0 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_vfs::vfs::repos::review_plan_repo::ReviewPlanStatus::from_str` | method | 1/0 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::get_submissions_with_snapshots_with_conn` | method | 0/3 | `crates/dstu-qbank/src/qbank_management/tests.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_with_conn` | method | 0/1 | `src/qbank_grading/image_answer/tests.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::copy_exam_sheet` | method | 0/1 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::delete_exam_sheet` | method | 0/1 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::delete_exam_sheet_with_conn` | method | 0/1 | `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::restore_exam` | method | 0/1 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::restore_exam_with_conn` | method | 0/1 | `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::canonical_questions_with_conn` ? | method | 0/1 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::insert_submission` | method | 0/1 | `crates/dstu-qbank/src/qbank_management/tests.rs` |

### L13-vfs-api（17 个条目，prod 157 / test 86）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 97/36 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_generation/mod.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs` 等 26 个 |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 19/0 | `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_generation/task_repo.rs` |
| `dstu_vfs::vfs::qbank_types::QuestionMaterial` | struct | 9/2 | `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_grading/context.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 4 个 |
| `dstu_vfs::vfs::types::VfsCreateExamSheetParams` | struct | 7/11 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_management/tests.rs` 等 12 个 |
| `dstu_vfs::vfs::qbank_helpers::refresh_canonical_preview_with_conn` | fn | 5/0 | `crates/dstu-qbank/src/qbank_authoring_service.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs`, `crates/dstu-qbank/src/qbank_management.rs` |
| `dstu_vfs::vfs::qbank_types::SourceRef` | struct | 5/0 | `crates/dstu-qbank/src/qbank_document.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` |
| `dstu_vfs::vfs::question_sync_service::QuestionSyncService::mark_as_modified_with_conn` | method | 4/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::question_sync_service::QuestionSyncService::update_content_hash_with_conn` | method | 4/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_vfs::vfs::types::VfsFile` ? | struct | 2/1 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::ref_handlers::extract_file_text_with_strategy` | fn | 2/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs`, `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::hooks::ExamDocumentExporter` | trait | 1/0 | `crates/dstu-qbank/src/question_export_service/vfs_hook.rs` |
| `dstu_vfs::vfs::hooks::register_exam_document_exporter` | fn | 1/0 | `crates/dstu-qbank/src/question_export_service/vfs_hook.rs` |
| `dstu_vfs::vfs::types::VfsCreateEssaySessionParams` | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/29 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_legacy_reconcile.rs` 等 17 个 |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/3 | `tests/mastery_qbank_correction.rs`, `tests/qbank_executor_e2e.rs`, `tests/qbank_verdict_three_paths.rs` |
| `dstu_vfs::vfs::qbank_helpers::retains_asset` | fn | 0/3 | `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 0/1 | `src/chat_v2/tools/qbank_import_source.rs` |

### L04-chat-session（6 个条目，prod 65 / test 11）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 62/1 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 3/1 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/4 | `src/chat_v2/tools/qbank_executor.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_headless` ? | method | 0/3 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 0/1 | `tests/qbank_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new` ? | method | 0/1 | `tests/qbank_executor_e2e.rs` |

### L18-media-docs（24 个条目，prod 42 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vision::page_rasterizer::PageSlice` | struct | 8/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_docs::document_parser::DocumentParser::new` | method | 6/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::load_page_image_bytes` | fn | 3/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::vlm_grounding_service::VlmGroundingService::new` | method | 3/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_docs::document_parser::DocumentParser` | struct | 2/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::PageRasterizer` | struct | 2/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_images` | method | 2/0 | `crates/dstu-qbank/src/question_authoring_runner.rs`, `crates/dstu-qbank/src/question_import_service.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor` | struct | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::resolve_file` | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::sanitize_id` | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_docs::docx_handout::decode_image_data` | fn | 1/0 | `crates/dstu-qbank/src/qbank_practice/export.rs` |
| `dstu_docs::docx_handout::prepare_png` | fn | 1/0 | `crates/dstu-qbank/src/qbank_practice/export.rs` |
| `dstu_vision::cross_page_merger::merge_pages` | fn | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::figure_extractor::extract_figures` | fn | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::llm_structurer::LlmStructurer` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::llm_structurer::LlmStructurer::new` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::llm_structurer::StructuredQuestion` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_docx` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf` | method | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf_cancellable` | method | 1/0 | `crates/dstu-qbank/src/question_authoring_runner.rs` |
| `dstu_vision::page_rasterizer::RasterizerResult` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::vlm_grounding_service::VlmGroundingService` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::vlm_grounding_service::VlmPageAnalysis` | struct | 1/0 | `crates/dstu-qbank/src/question_import_service.rs` |
| `dstu_vision::exam_sheet_service::ExamSheetService::new` | method | 0/2 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs` |

### F1-kernel（10 个条目，prod 38 / test 20）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::extensions::qbank_state` | fn | 18/0 | `src/qbank_generation.rs`, `src/qbank_grading.rs`, `src/qbank_practice.rs` |
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 12/18 | `src/chat_v2/tools/essay_grading_executor.rs`, `src/chat_v2/tools/qbank_executor.rs`, `src/chat_v2/tools/review_executor.rs` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 3/0 | `src/chat_v2/tools/qbank_executor.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 1/0 | `crates/dstu-qbank/src/runtime.rs` |
| `dstu_kernel::plugin::Scope` | struct | 1/0 | `crates/dstu-qbank/src/question_export_service/vfs_hook.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-qbank/src/runtime.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-qbank/src/runtime.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 1/0 | `crates/dstu-qbank/src/runtime.rs` |
| `deep_student_lib::agent_wiring::services::build_pipeline_services` | fn | 0/1 | `tests/qbank_executor_e2e.rs` |
| `deep_student_lib::extensions::register_extensions` | fn | 0/1 | `src/question_bank_service/tests.rs` |

### L02-llm-manager（21 个条目，prod 36 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 16/1 | `crates/dstu-qbank/src/qbank_generation/mod.rs`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs` 等 7 个 |
| `dstu_tutor::essay_grading::types::GradingMode` ? | struct | 5/2 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager::new` ? | method | 1/1 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::types::get_builtin_grading_modes` ? | fn | 1/1 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_llm::llm_manager::build_provider_adapter` | fn | 1/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs` |
| `dstu_llm::llm_manager::effective_max_tokens` | fn | 1/0 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::llm_manager::LLMManager::apply_reasoning_config` | method | 1/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs` |
| `dstu_llm::llm_manager::routing::llm_error_code` | fn | 1/0 | `crates/dstu-qbank/src/question_authoring_runner/plan.rs` |
| `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED` | const | 1/0 | `crates/dstu-qbank/src/question_authoring_runner/plan.rs` |
| `dstu_llm::llm_manager::routing::provider_body_indicates_context_window` | fn | 1/0 | `crates/dstu-qbank/src/question_authoring_runner/plan.rs` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager` ? | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::events::GradingEventEmitter` ? | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::events::GradingEventEmitter::new` ? | method | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::pipeline::GradingDeps` ? | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::pipeline::resolve_grading_mode` ? | fn | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::pipeline::run_grading` ? | fn | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_tutor::essay_grading::types::GradingRequest` ? | struct | 1/0 | `src/chat_v2/tools/essay_grading_executor.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 0/5 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_llm::llm_manager::ModelProfile` | struct | 0/2 | `tests/qbank_executor_e2e.rs` |
| `dstu_llm::llm_manager::VendorConfig` | struct | 0/2 | `tests/qbank_executor_e2e.rs` |
| `dstu_tutor::essay_grading::custom_modes::CreateModeInput` ? | struct | 0/1 | `src/chat_v2/tools/essay_grading_executor.rs` |

### L15-review-analytics（11 个条目，prod 26 / test 16）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_learning::mastery::service::MasteryService::new` ? | method | 9/4 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_practice.rs`, `crates/dstu-qbank/src/question_bank_service.rs` 等 4 个 |
| `dstu_qbank::review_plan_service::ReviewPlanService::new` ? | method | 8/1 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_practice.rs`, `crates/dstu-qbank/src/question_bank_service.rs` 等 4 个 |
| `dstu_qbank::review_plan_service::ReviewPlanService` ? | struct | 5/0 | `src/chat_v2/tools/review_executor.rs` |
| `dstu_learning::mastery::types::MasteryState` | struct | 1/0 | `crates/dstu-qbank/src/question_bank_service.rs` |
| `dstu_learning::study_loop::media_source::contains_media_anchor` | fn | 1/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs` |
| `dstu_learning::study_loop::media_source::MEDIA_QUESTION_REQUIREMENTS` | const | 1/0 | `crates/dstu-qbank/src/qbank_generation/types.rs` |
| `dstu_learning::study_loop::media_source::prepare_media_text_for_generation` | fn | 1/0 | `crates/dstu-qbank/src/qbank_generation/reference.rs` |
| `dstu_learning::mastery::service::set_now_override_ms` ? | fn | 0/7 | `crates/dstu-qbank/src/question_bank_service.rs`, `src/question_bank_service/tests.rs` |
| `dstu_learning::mastery::service::MasteryService` ? | struct | 0/2 | `crates/dstu-qbank/src/question_bank_service.rs`, `tests/mastery_qbank_correction.rs` |
| `dstu_learning::mastery::service::MIN_TOTAL_FOR_WEAK` ? | const | 0/1 | `src/question_bank_service/tests.rs` |
| `dstu_learning::mastery::service::WEAK_SCORE_THRESHOLD` ? | const | 0/1 | `src/question_bank_service/tests.rs` |

### L22-app-commands（1 个条目，prod 18 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 18/0 | `src/qbank_generation.rs`, `src/qbank_grading.rs`, `src/qbank_practice.rs` |

### L01-llm-providers（7 个条目，prod 10 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::providers::StreamEvent` | enum | 7/0 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::ProviderAdapter` | trait | 3/0 | `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::AnthropicAdapter::new` | method | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::GeminiAdapter::new` | method | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::OpenAIAdapter` | struct | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::OpenAIAdapter::new` | method | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |
| `dstu_llm::providers::OpenAIResponsesAdapter::new` | method | 0/1 | `crates/dstu-qbank/src/qbank_grading/stream.rs` |

### F3-storage（8 个条目，prod 6 / test 31）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::data_space::device_id::get_device_id` | fn | 3/0 | `crates/dstu-qbank/src/qbank_practice.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 2/1 | `crates/dstu-qbank/src/question_import_service.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_storage::database::Database` | struct | 1/1 | `src/chat_v2/tools/essay_grading_executor.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/8 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs` 等 5 个 |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/7 | `crates/dstu-qbank/src/qbank_authoring_service/tests.rs`, `crates/dstu-qbank/src/qbank_grading/pipeline.rs`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs` 等 4 个 |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/7 | `tests/mastery_qbank_correction.rs`, `tests/qbank_executor_e2e.rs`, `tests/qbank_verdict_three_paths.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/4 | `tests/mastery_qbank_correction.rs`, `tests/qbank_executor_e2e.rs`, `tests/qbank_verdict_three_paths.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/3 | `tests/mastery_qbank_correction.rs`, `tests/qbank_executor_e2e.rs`, `tests/qbank_verdict_three_paths.rs` |

### L10-notes（4 个条目，prod 3 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note` | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content` | method | 1/0 | `src/chat_v2/tools/qbank_import_source.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | 0/1 | `src/chat_v2/tools/qbank_import_source.rs` |

### L19-mcp-browser（2 个条目，prod 0 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/4 | `src/chat_v2/tools/qbank_executor.rs`, `tests/qbank_executor_e2e.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/1 | `tests/qbank_executor_e2e.rs` |

### L17-memory-research（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_memory::memory::learner_profile::load_profile_from_db` | fn | 0/1 | `src/question_bank_service/tests.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 F2-shell 导入：`use dstu_qbank::question_bank_service::*` @ `src/lib.rs:170`
- 导入 F2-shell：`use deep_student_lib::qbank_read::*` @ `src/qbank_read/tests.rs:7`（test）
- 导入 F2-shell：`use deep_student_lib::question_bank_service::*` @ `src/question_bank_service/tests.rs:7`（test）
