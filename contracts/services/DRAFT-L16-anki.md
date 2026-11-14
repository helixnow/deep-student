# 跨 lane 服务草稿：L16-anki

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（35 个条目，其中 31 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_anki::anki_preference_memory::SessionObservation` | struct | `crates/dstu-anki/src/anki_preference_memory.rs:78` | L24-chatanki 7/7 | `pub struct SessionObservation` |
| `dstu_anki::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES` | const | `crates/dstu-anki/src/apkg_importer_service.rs:76` | L24-chatanki 4/1 | `pub const MAX_APKG_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024` |
| `dstu_anki::anki_connect_service::check_anki_connect_availability` | fn | `crates/dstu-anki/src/anki_connect_service.rs:309` | L24-chatanki 3/0 | `pub async fn check_anki_connect_availability() -> Result<bool, String>` |
| `dstu_anki::document_processing_service::DocumentProcessingService::new` | method | `crates/dstu-anki/src/document_processing_service.rs:51` | L24-chatanki 3/0 | `pub fn new(db: Arc<Database>) -> Self` |
| `dstu_anki::enhanced_anki_service::EnhancedAnkiService::new` | method | `crates/dstu-anki/src/enhanced_anki_service.rs:54` | L24-chatanki 3/0 | `pub fn new(db: Arc<Database>, llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_anki::streaming_anki_service::StreamingAnkiService::new` | method | `crates/dstu-anki/src/streaming_anki_service.rs:643` | L24-chatanki 3/0 | `pub fn new(db: Arc<Database>, llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_anki::anki_preference_memory::PreferenceStore` | struct | `crates/dstu-anki/src/anki_preference_memory.rs:140` | L24-chatanki 2/4 | `pub struct PreferenceStore` |
| `dstu_anki::anki_preference_memory::CardEditObservation` | struct | `crates/dstu-anki/src/anki_preference_memory.rs:60` | L24-chatanki 2/0 | `pub struct CardEditObservation` |
| `dstu_anki::apkg_importer_service::ApkgImporterService::new` | method | `crates/dstu-anki/src/apkg_importer_service.rs:220` | L24-chatanki 2/0 | `pub fn new(db: Arc<Database>) -> Self` |
| `deep_student_lib::cmd::anki_connect::sanitize_filename_with_extension` | fn | `src/cmd/anki_connect.rs:150` | L24-chatanki 1/0 | `pub(crate) fn sanitize_filename_with_extension( raw: &str, fallback_name: &str, extension: &str, ) -> String` |
| `deep_student_lib::cmd::anki_connect::save_json_file` | fn | `src/cmd/anki_connect.rs:2146` | L24-chatanki 1/0 | `pub async fn save_json_file(content: String, suggested_name: String) -> Result<String>` |
| `dstu_anki::anki_connect_service::add_notes_to_anki_detailed` | fn | `crates/dstu-anki/src/anki_connect_service.rs:1324` | L24-chatanki 1/0 | `pub async fn add_notes_to_anki_detailed( cards: Vec<AnkiCard>, deck_name: String, note_type: String, card_models: HashMap<String, String>, templates_by_model: HashMap<String, crate::models::CustomAnkiTemplate>, options: AnkiConnectSyncOptions, ) -> Result<AnkiSyncReport, String>` |
| `dstu_anki::anki_connect_service::AnkiConnectSyncOptions::from_setting_strings` | method | `crates/dstu-anki/src/anki_connect_service.rs:77` | L24-chatanki 1/0 | `pub fn from_setting_strings( batch_size: Option<&str>, retry_times: Option<&str>, media_mode: Option<&str>, ) -> Self` |
| `dstu_anki::anki_connect_service::create_deck_if_not_exists` | fn | `crates/dstu-anki/src/anki_connect_service.rs:1591` | L24-chatanki 1/0 | `pub async fn create_deck_if_not_exists(deck_name: &str) -> Result<(), String>` |
| `dstu_anki::anki_connect_service::template_model_name` | fn | `crates/dstu-anki/src/anki_connect_service.rs:728` | L24-chatanki 1/0 | `pub fn template_model_name(template: &crate::models::CustomAnkiTemplate) -> String` |
| `dstu_anki::anki_gold_set::ContentProvenance::user` | method | `crates/dstu-anki/src/anki_gold_set.rs:375` | L24-chatanki 1/0 | `pub fn user(code: &str) -> Self` |
| `dstu_anki::anki_gold_set::insert_content_provenance` | fn | `crates/dstu-anki/src/anki_gold_set.rs:399` | L24-chatanki 1/0 | `pub fn insert_content_provenance( extras: &mut HashMap<String, String>, provenance: &ContentProvenance, )` |
| `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:759` | L24-chatanki 1/0 | `pub fn build_occlusion_draft_marker( image_ref: &str, image_desc: &str, cfg: &OcclusionConfig, ) -> Option<String>` |
| `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker_from_spec` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:781` | L24-chatanki 1/0 | `pub fn build_occlusion_draft_marker_from_spec( spec: &OcclusionSpec, cfg: &OcclusionConfig, ) -> Option<String>` |
| `dstu_anki::anki_image_occlusion::OcclusionConfig` | struct | `crates/dstu-anki/src/anki_image_occlusion.rs:70` | L24-chatanki 1/0 | `pub struct OcclusionConfig` |
| `dstu_anki::anki_image_occlusion::parse_occlusion_boxes_from_vlm` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:589` | L24-chatanki 1/0 | `pub fn parse_occlusion_boxes_from_vlm(text: &str) -> Option<OcclusionSpec>` |
| `dstu_anki::anki_image_occlusion::strip_occlusion_boxes_blocks` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:617` | L24-chatanki 1/0 | `pub fn strip_occlusion_boxes_blocks(text: &str) -> String` |
| `dstu_anki::anki_preference_memory::CardDeleteObservation` | struct | `crates/dstu-anki/src/anki_preference_memory.rs:69` | L24-chatanki 1/0 | `pub struct CardDeleteObservation` |
| `dstu_anki::anki_preference_memory::consolidate_observation` | fn | `crates/dstu-anki/src/anki_preference_memory.rs:572` | L24-chatanki 1/0 | `pub fn consolidate_observation( store: &mut PreferenceStore, observation: &SessionObservation, now_ms: i64, ) -> ConsolidateOutcome` |
| `dstu_anki::anki_preference_memory::ConsolidateOutcome` | struct | `crates/dstu-anki/src/anki_preference_memory.rs:146` | L24-chatanki 1/0 | `pub struct ConsolidateOutcome` |
| `dstu_anki::anki_preference_memory::DEFAULT_PROMPT_TOKEN_BUDGET` | const | `crates/dstu-anki/src/anki_preference_memory.rs:40` | L24-chatanki 1/0 | `pub const DEFAULT_PROMPT_TOKEN_BUDGET: usize = 120` |
| `dstu_anki::anki_preference_memory::retrieve_preference_prompt` | fn | `crates/dstu-anki/src/anki_preference_memory.rs:669` | L24-chatanki 1/0 | `pub fn retrieve_preference_prompt( store: &PreferenceStore, goal: &str, available_templates: &[String], max_tokens: usize, ) -> String` |
| `dstu_anki::anki::get_template_config` | fn | `crates/dstu-anki/src/anki/mod.rs:10` | L22-app-commands 1/0 | `pub fn get_template_config( template_id: &str, database: &std::sync::Arc<crate::database::Database>, ) -> std::result::Result<(String, Vec<String>, String, String, String), String>` |
| `dstu_anki::apkg_exporter_service::export_multi_template_apkg_report` | fn | `crates/dstu-anki/src/apkg_exporter_service.rs:2101` | L24-chatanki 1/0 | `pub async fn export_multi_template_apkg_report( cards: Vec<AnkiCard>, deck_name: String, output_path: PathBuf, template_map: HashMap<String, CustomAnkiTemplate>, ) -> Result<ApkgExportReport, String>` |
| `dstu_anki::apkg_importer_service::ApkgImporterService` | struct | `crates/dstu-anki/src/apkg_importer_service.rs:211` | L24-chatanki 1/0 | `pub struct ApkgImporterService` |
| `dstu_anki::enhanced_anki_service::EnhancedAnkiService` | struct | `crates/dstu-anki/src/enhanced_anki_service.rs:38` | L24-chatanki 1/0 | `pub struct EnhancedAnkiService` |
| `dstu_anki::anki_image_occlusion::extract_occlusion_draft_fields` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:797` | L24-chatanki 0/4 | `pub fn extract_occlusion_draft_fields(content: &str) -> Option<OcclusionCardFields>` |
| `dstu_anki::anki_image_occlusion::parse_occlusion_field` | fn | `crates/dstu-anki/src/anki_image_occlusion.rs:486` | L24-chatanki 0/4 | `pub fn parse_occlusion_field(extra_fields: &HashMap<String, String>) -> Option<OcclusionSpec>` |
| `dstu_anki::apkg_importer_service::ApkgImportResult` | struct | `crates/dstu-anki/src/apkg_importer_service.rs:102` | L24-chatanki 0/1 | `pub struct ApkgImportResult` |
| `dstu_anki::apkg_importer_service::ApkgMediaReport` | struct | `crates/dstu-anki/src/apkg_importer_service.rs:155` | L24-chatanki 0/1 | `pub struct ApkgMediaReport` |

### 引用点样例

- `dstu_anki::anki_preference_memory::SessionObservation` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:2559`, `src/chat_v2/tools/chatanki_executor.rs:2930`, `src/chat_v2/tools/chatanki_executor.rs:8198`, `src/chat_v2/tools/chatanki_executor.rs:11038`
- `dstu_anki::apkg_importer_service::MAX_APKG_ARCHIVE_BYTES` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:10292`, `src/chat_v2/tools/chatanki_executor.rs:10363`, `src/chat_v2/tools/chatanki_executor.rs:10373`, `src/chat_v2/tools/chatanki_executor.rs:10382`
- `dstu_anki::anki_connect_service::check_anki_connect_availability` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:2146`, `src/chat_v2/tools/chatanki_executor.rs:6232`, `src/chat_v2/tools/chatanki_executor.rs:7475`
- `dstu_anki::document_processing_service::DocumentProcessingService::new` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6623`, `src/chat_v2/tools/chatanki_executor.rs:8453`, `src/chat_v2/tools/chatanki_executor.rs:8666`
- `dstu_anki::enhanced_anki_service::EnhancedAnkiService::new` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6560`, `src/chat_v2/tools/chatanki_executor.rs:8296`, `src/chat_v2/tools/chatanki_executor.rs:8409`
- `dstu_anki::streaming_anki_service::StreamingAnkiService::new` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6649`, `src/chat_v2/tools/chatanki_executor.rs:8456`, `src/chat_v2/tools/chatanki_executor.rs:8669`
- `dstu_anki::anki_preference_memory::PreferenceStore` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11048`, `src/chat_v2/tools/chatanki_executor.rs:11194`, `src/chat_v2/tools/chatanki_executor.rs:20188`, `src/chat_v2/tools/chatanki_executor.rs:20210`
- `dstu_anki::anki_preference_memory::CardEditObservation` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11089`, `src/chat_v2/tools/chatanki_executor.rs:11099`
- `dstu_anki::apkg_importer_service::ApkgImporterService::new` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:2070`, `src/chat_v2/tools/chatanki_executor.rs:2071`
- `deep_student_lib::cmd::anki_connect::sanitize_filename_with_extension` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:5958`
- `deep_student_lib::cmd::anki_connect::save_json_file` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:5939`
- `dstu_anki::anki_connect_service::add_notes_to_anki_detailed` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6336`
- `dstu_anki::anki_connect_service::AnkiConnectSyncOptions::from_setting_strings` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6329`
- `dstu_anki::anki_connect_service::create_deck_if_not_exists` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6269`
- `dstu_anki::anki_connect_service::template_model_name` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6312`
- `dstu_anki::anki_gold_set::ContentProvenance::user` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:3730`
- `dstu_anki::anki_gold_set::insert_content_provenance` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:3728`
- `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9968`
- `dstu_anki::anki_image_occlusion::build_occlusion_draft_marker_from_spec` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9965`
- `dstu_anki::anki_image_occlusion::OcclusionConfig` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9962`
- `dstu_anki::anki_image_occlusion::parse_occlusion_boxes_from_vlm` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9951`
- `dstu_anki::anki_image_occlusion::strip_occlusion_boxes_blocks` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9952`
- `dstu_anki::anki_preference_memory::CardDeleteObservation` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11151`
- `dstu_anki::anki_preference_memory::consolidate_observation` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11051`
- `dstu_anki::anki_preference_memory::ConsolidateOutcome` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11040`
- `dstu_anki::anki_preference_memory::DEFAULT_PROMPT_TOKEN_BUDGET` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11200`
- `dstu_anki::anki_preference_memory::retrieve_preference_prompt` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:11196`
- `dstu_anki::anki::get_template_config` — L22-app-commands: `src/commands.rs:724`
- `dstu_anki::apkg_exporter_service::export_multi_template_apkg_report` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:6056`
- `dstu_anki::apkg_importer_service::ApkgImporterService` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:64`
- `dstu_anki::enhanced_anki_service::EnhancedAnkiService` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:77`
- `dstu_anki::anki_image_occlusion::extract_occlusion_draft_fields` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:19165`, `src/chat_v2/tools/chatanki_executor.rs:19191`, `src/chat_v2/tools/chatanki_executor.rs:19208`, `src/chat_v2/tools/chatanki_executor.rs:19245`
- `dstu_anki::anki_image_occlusion::parse_occlusion_field` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:19167`, `src/chat_v2/tools/chatanki_executor.rs:19194`, `src/chat_v2/tools/chatanki_executor.rs:19211`, `src/chat_v2/tools/chatanki_executor.rs:19248`
- `dstu_anki::apkg_importer_service::ApkgImportResult` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:20612`
- `dstu_anki::apkg_importer_service::ApkgMediaReport` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:20618`

## 消费其他 lane

### F4-security（34 个条目，prod 471 / test 167）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError` | struct | 82/4 | `crates/dstu-anki/src/apkg_importer_service.rs`, `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 8 个 |
| `dstu_core::models::AppError::validation` | method | 76/0 | `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` 等 6 个 |
| `dstu_core::models::AnkiCard` | struct | 70/39 | `crates/dstu-anki/src/anki/repository.rs`, `crates/dstu-anki/src/anki_connect_service.rs`, `crates/dstu-anki/src/anki_critic.rs` 等 15 个 |
| `dstu_core::models::TaskStatus` ? | enum | 47/14 | `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` 等 5 个 |
| `dstu_core::models::AppError::database` | method | 40/0 | `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` 等 6 个 |
| `dstu_core::models::AnkiGenerationOptions` | struct | 20/13 | `crates/dstu-anki/src/anki_protocol.rs`, `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 7 个 |
| `dstu_core::models::FieldType` ? | enum | 18/52 | `crates/dstu-anki/src/anki_protocol.rs`, `crates/dstu-anki/src/anki_qa_lint.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::DocumentTask` | struct | 16/4 | `crates/dstu-anki/src/anki_critic.rs`, `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 7 个 |
| `dstu_core::models::FieldExtractionRule` | struct | 14/22 | `crates/dstu-anki/src/anki_protocol.rs`, `crates/dstu-anki/src/anki_qa_lint.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` 等 4 个 |
| `dstu_core::models::AppErrorType` | enum | 14/6 | `crates/dstu-anki/src/apkg_importer_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs`, `src/cmd/apkg_import.rs` |
| `dstu_core::models::StreamedCardPayload` | enum | 14/0 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::CustomAnkiTemplate` | struct | 13/8 | `crates/dstu-anki/src/anki_connect_service.rs`, `crates/dstu-anki/src/apkg_exporter_service.rs`, `crates/dstu-anki/src/apkg_importer_service.rs` 等 5 个 |
| `dstu_core::models::AppError::internal` | method | 10/0 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `src/cmd/anki_connect.rs`, `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::AnkiDocumentGenerationRequest` | struct | 5/0 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 4/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 4/0 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `src/cmd/anki_connect.rs`, `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::ExportAnkiCardsResponse` | struct | 3/0 | `src/cmd/enhanced_anki.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 2/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::AppError::network` ? | method | 2/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::AppError::not_found` | method | 2/0 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 2/0 | `crates/dstu-anki/src/apkg_importer_service.rs`, `src/cmd/apkg_import.rs` |
| `dstu_core::models::MemoryCandidate` | struct | 2/0 | `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::AnkiLibraryCard` | struct | 1/2 | `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::TemplateDescription` | struct | 1/2 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::AppError::llm` ? | method | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_core::models::CreateTemplateRequest` | struct | 1/0 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_core::models::ExportAnkiCardsRequest` | struct | 1/0 | `src/cmd/enhanced_anki.rs` |
| `dstu_core::models::ListAnkiCardsRequest` | struct | 1/0 | `src/cmd/enhanced_anki.rs` |
| `dstu_core::prompt_contracts::LATEX_OUTPUT_BRIEF` | const | 1/0 | `crates/dstu-anki/src/anki_critic.rs` |
| `dstu_core::prompt_contracts::LATEX_RULES` | const | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_util::utils::model_special_tokens::MODEL_SPECIAL_TOKENS` | const | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::check_done_marker` | method | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::new` | method | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_util::utils::token_budget::estimate_tokens` | fn | 0/1 | `crates/dstu-anki/src/document_processing_service.rs` |

### F3-storage（16 个条目，prod 40 / test 53）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 29/17 | `crates/dstu-anki/src/anki/mod.rs`, `crates/dstu-anki/src/anki/repository.rs`, `crates/dstu-anki/src/anki_critic.rs` 等 12 个 |
| `dstu_storage::database::AnkiLibraryCardVersionUpdate` | enum | 4/0 | `crates/dstu-anki/src/anki_critic.rs` |
| `dstu_storage::database::AnkiLibraryScope::agent` ? | method | 3/0 | `crates/dstu-anki/src/anki_critic.rs`, `src/cmd/enhanced_anki.rs` |
| `dstu_storage::database::AnkiLibraryListFilter` | struct | 1/0 | `src/cmd/enhanced_anki.rs` |
| `dstu_storage::database::AnkiLibraryScope` | struct | 1/0 | `crates/dstu-anki/src/anki_critic.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 1/0 | `src/cmd/anki_connect.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 1/0 | `src/cmd/anki_connect.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/13 | `crates/dstu-anki/src/apkg_importer_service.rs`, `crates/dstu-anki/src/document_processing_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 8 个 |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/5 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_storage::database::AnkiRetemplateBatchResult` ? | enum | 0/4 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/4 | `tests/anki_fsrs_feedback.rs`, `tests/anki_new_wiring_tests.rs` |
| `dstu_storage::database::AnkiRetemplateSelector` ? | enum | 0/3 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_storage::database::AnkiRetemplateTarget` | struct | 0/2 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/2 | `tests/anki_fsrs_feedback.rs`, `tests/anki_new_wiring_tests.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/2 | `tests/anki_fsrs_feedback.rs`, `tests/anki_new_wiring_tests.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 0/1 | `crates/dstu-anki/src/enhanced_anki_service.rs` |

### L22-app-commands（2 个条目，prod 39 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 37/0 | `src/cmd/anki_cards.rs`, `src/cmd/anki_connect.rs`, `src/cmd/apkg_import.rs` 等 4 个 |
| `deep_student_lib::commands::get_default_model_adapter_options` | fn | 2/0 | `src/cmd/anki_cards.rs` |

### L15-review-analytics（16 个条目，prod 30 / test 27）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_anki::fsrs_review_service::FsrsState` | enum | 5/9 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService::new` ? | method | 5/7 | `crates/dstu-anki/src/anki_fsrs_feedback.rs`, `crates/dstu-anki/src/apkg_importer_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 7 个 |
| `dstu_anki::fsrs_review_service::FsrsFeedbackRow` ? | struct | 4/6 | `crates/dstu-anki/src/anki_fsrs_feedback.rs`, `tests/anki_ai_native_integration.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService` ? | struct | 3/3 | `crates/dstu-anki/src/anki_fsrs_feedback.rs`, `crates/dstu-anki/src/apkg_importer_service.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs` 等 5 个 |
| `dstu_anki::fsrs_review_service::FsrsImportedSchedule` | struct | 3/0 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_anki::fsrs_review_service::FsrsAgentReviewStateSnapshot` ? | struct | 1/1 | `src/cmd/enhanced_anki.rs` |
| `dstu_anki::fsrs_review_service::emit_fsrs_enqueue_changed` | fn | 1/0 | `crates/dstu-anki/src/enhanced_anki_service.rs` |
| `dstu_anki::fsrs_review_service::FsrsEnqueueResult` ? | struct | 1/0 | `crates/dstu-anki/src/enhanced_anki_service.rs` |
| `dstu_anki::fsrs_review_service::FsrsImportedSchedule::new_card` | method | 1/0 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_anki::fsrs_review_service::FsrsReviewService::enqueue_imported_cards_in_tx` | method | 1/0 | `crates/dstu-anki/src/apkg_importer_service.rs` |
| `dstu_learning::fsrs_scheduler::DEFAULT_DAY_ROLLOVER_HOUR` | const | 1/0 | `crates/dstu-anki/src/apkg_exporter_service.rs` |
| `dstu_learning::fsrs_scheduler::forgetting_curve_constants` | fn | 1/0 | `crates/dstu-anki/src/anki_fsrs_feedback.rs` |
| `dstu_learning::fsrs_scheduler::logical_day_bounds_ms` | fn | 1/0 | `crates/dstu-anki/src/apkg_exporter_service.rs` |
| `dstu_learning::fsrs_scheduler::logical_days_between` | fn | 1/0 | `crates/dstu-anki/src/apkg_exporter_service.rs` |
| `dstu_learning::fsrs_scheduler::retrievability` | fn | 1/0 | `crates/dstu-anki/src/anki_fsrs_feedback.rs` |
| `dstu_anki::fsrs_review_service::FsrsAgentLatestReviewSnapshot` ? | struct | 0/1 | `src/cmd/enhanced_anki.rs` |

### L02-llm-manager（9 个条目，prod 12 / test 9）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 4/0 | `crates/dstu-anki/src/anki_critic.rs`, `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::anki_model_routing::AnkiModelRole` | enum | 2/1 | `crates/dstu-anki/src/anki_critic.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::anki_model_routing::parse_routing_mode` | fn | 2/0 | `crates/dstu-anki/src/anki_critic.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::anki_model_routing::RoleDecision` | struct | 1/2 | `crates/dstu-anki/src/anki_critic.rs` |
| `dstu_llm::anki_model_routing::plan_routing` | fn | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::llm_manager::build_provider_adapter` | fn | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::llm_manager::effective_max_tokens` | fn | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 0/5 | `crates/dstu-anki/src/enhanced_anki_service.rs`, `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::anki_model_routing::SlotKind` | enum | 0/1 | `crates/dstu-anki/src/anki_critic.rs` |

### L01-llm-providers（2 个条目，prod 5 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::providers::StreamEvent` | enum | 4/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |
| `dstu_llm::providers::ProviderAdapter` | trait | 1/0 | `crates/dstu-anki/src/streaming_anki_service.rs` |

### L13-vfs-api（3 个条目，prod 0 / test 7）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 0/3 | `tests/anki_ai_native_integration.rs` |
| `dstu_vfs::vfs::types::VfsContextRefData` | struct | 0/2 | `tests/anki_ai_native_integration.rs` |
| `dstu_vfs::vfs::types::VfsResourceRef` | struct | 0/2 | `tests/anki_ai_native_integration.rs` |

### L24-chatanki（32 个条目，prod 0 / test 90）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRoute` | enum | 0/11 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::resolve_route_decision` | fn | 0/8 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::parse_route_plan_response` | fn | 0/6 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiRetemplateStrategy` | enum | 0/5 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RouteSource` | enum | 0/5 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::text_has_valid_cloze_markup` | fn | 0/5 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields` | struct | 0/5 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RoutePlan` | struct | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::evaluate_script_output` | fn | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::compile_transform_ops` | fn | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformOp` | enum | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::select_transform_cards` | fn | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::transform_fields_are_valid` | fn | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformCardPlan` | enum | 0/3 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::build_analyze_output` | fn | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::changed_field_names` | fn | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::check_expected_versions` | fn | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformKind` | enum | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformSelection` | enum | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformMode` | enum | 0/2 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::RouteDecision` | struct | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::build_script_input` | fn | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::resolve_interpreter_in_dirs` | fn | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::ScriptOutputError` | enum | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform_script::transform_sandbox_policy` | fn | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::apply_transform_ops` | fn | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs` | struct | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::ChatAnkiTransformArgs::normalize` | method | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::NormalizedTransformRequest` | struct | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::plan_transform_ops` | fn | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformFields::from_card` | method | 0/1 | `tests/anki_ai_native_integration.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_transform::TransformSelectionError` | enum | 0/1 | `tests/anki_ai_native_integration.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::anki_cards::*` @ `src/commands.rs:46`
- 被 L22-app-commands 导入：`use deep_student_lib::cmd::anki_connect::*` @ `src/commands.rs:47`
- 被 L22-app-commands 导入：`use deep_student_lib::cmd::enhanced_anki::*` @ `src/commands.rs:48`
