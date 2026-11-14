# 跨 lane 服务草稿：L18-media-docs

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（57 个条目，其中 56 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | `crates/dstu-docs/src/document_parser.rs:306` | L14-qbank 6/0<br>L03-chat-pipeline 3/0<br>L13-vfs-api 3/0<br>L11-vfs-repos 3/0<br>L05-agent-workspace 2/0<br>L22-app-commands 2/0<br>L24-chatanki 1/0 | `pub fn new() -> Self` |
| `dstu_vision::page_rasterizer::PageSlice` | struct | `crates/dstu-vision/src/page_rasterizer.rs:26` | L14-qbank 8/0 | `pub struct PageSlice` |
| `dstu_docs::document_parser::DocumentParser` | struct | `crates/dstu-docs/src/document_parser.rs:289` | L14-qbank 2/0<br>L13-vfs-api 2/0<br>L05-agent-workspace 1/0<br>L11-vfs-repos 1/0 | `pub struct DocumentParser` |
| `dstu_docs::pdfium_utils::PDF_PAGE_SEPARATOR` | const | `crates/dstu-docs/src/pdfium_utils.rs:156` | L12-vfs-index 2/0<br>L11-vfs-repos 1/0<br>L13-vfs-api 1/0 | `pub const PDF_PAGE_SEPARATOR: char = '\u{000C}'` |
| `dstu_docs::document_parser::is_plain_text_code_extension` | fn | `crates/dstu-docs/src/document_parser.rs:122` | L11-vfs-repos 2/0<br>L13-vfs-api 1/0 | `pub fn is_plain_text_code_extension(ext: &str) -> bool` |
| `dstu_docs::pdfium_utils::load_pdfium` | fn | `crates/dstu-docs/src/pdfium_utils.rs:44` | L11-vfs-repos 2/0<br>L12-vfs-index 1/0 | `pub fn load_pdfium() -> Result<&'static Pdfium, String>` |
| `dstu_vision::page_rasterizer::load_page_image_bytes` | fn | `crates/dstu-vision/src/page_rasterizer.rs:443` | L14-qbank 3/0 | `pub fn load_page_image_bytes(vfs_db: &VfsDatabase, blob_hash: &str) -> Result<Vec<u8>, AppError>` |
| `dstu_vision::vlm_grounding_service::VlmGroundingService::new` | method | `crates/dstu-vision/src/vlm_grounding_service.rs:340` | L14-qbank 3/0 | `pub fn new(llm_manager: Arc<LLMManager>) -> Self` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor` | struct | `src/chat_v2/tools/textbook_pdf_executor.rs:74` | F1-kernel 1/1<br>L13-vfs-api 1/0<br>L22-app-commands 0/1 | `pub struct TextbookPdfToolExecutor` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor` | struct | `src/chat_v2/tools/document_processing_executor.rs:40` | L13-vfs-api 1/0<br>L14-qbank 1/0<br>F1-kernel 0/1 | `pub struct DocumentProcessingExecutor` |
| `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor` | struct | `src/chat_v2/tools/image_generation_executor.rs:54` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct ImageGenerationExecutor` |
| `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor` | struct | `src/chat_v2/tools/media_executor.rs:31` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct MediaToolExecutor` |
| `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor` | struct | `src/chat_v2/tools/office_fidelity_executor.rs:69` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct OfficeFidelityExecutor` |
| `dstu_docs::pdfium_utils::extract_text_from_pdf_bytes` | fn | `crates/dstu-docs/src/pdfium_utils.rs:147` | L12-vfs-index 1/0<br>L11-vfs-repos 1/0 | `pub fn extract_text_from_pdf_bytes(pdfium: &Pdfium, pdf_bytes: &[u8]) -> Result<String, String>` |
| `dstu_vision::page_rasterizer::PageRasterizer` | struct | `crates/dstu-vision/src/page_rasterizer.rs:47` | L14-qbank 2/0 | `pub struct PageRasterizer` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_images` | method | `crates/dstu-vision/src/page_rasterizer.rs:198` | L14-qbank 2/0 | `pub fn rasterize_images( content: &str, vfs_db: &VfsDatabase, ) -> Result<RasterizerResult, AppError>` |
| `dstu_vision::exam_sheet_service::ExamSheetService::new` | method | `crates/dstu-vision/src/exam_sheet_service.rs:78` | F2-shell 1/0<br>L14-qbank 0/2 | `pub fn new( database: Arc<crate::database::Database>, file_manager: Arc<FileManager>, vfs_db: Arc<VfsDatabase>, ) -> Result<Self, AppError>` |
| `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor` | struct | `src/chat_v2/tools/docx_executor.rs:45` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct DocxToolExecutor` |
| `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor` | struct | `src/chat_v2/tools/pptx_executor.rs:44` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct PptxToolExecutor` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor::new` | method | `src/chat_v2/tools/textbook_pdf_executor.rs:77` | F1-kernel 1/0<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor` | struct | `src/chat_v2/tools/xlsx_executor.rs:33` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct XlsxToolExecutor` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::new` | method | `src/chat_v2/tools/document_processing_executor.rs:43` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::resolve_file` | method | `src/chat_v2/tools/document_processing_executor.rs:71` | L14-qbank 1/0 | `pub(crate) fn resolve_file(vfs_db: &Arc<VfsDatabase>, raw_id: &str) -> Result<VfsFile, String>` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::sanitize_id` | method | `src/chat_v2/tools/document_processing_executor.rs:48` | L14-qbank 1/0 | `pub(crate) fn sanitize_id(raw: &str) -> Result<String, String>` |
| `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor::new` | method | `src/chat_v2/tools/docx_executor.rs:48` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor::new` | method | `src/chat_v2/tools/image_generation_executor.rs:57` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor::new` | method | `src/chat_v2/tools/media_executor.rs:34` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor::new` | method | `src/chat_v2/tools/office_fidelity_executor.rs:72` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor::new` | method | `src/chat_v2/tools/pptx_executor.rs:47` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor::new` | method | `src/chat_v2/tools/xlsx_executor.rs:36` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::heic_decoder::init` | fn | `src/heic_decoder.rs:37` | F2-shell 1/0 | `pub fn init() -> TauriPlugin<tauri::Wry>` |
| `deep_student_lib::media::install_media_host` | fn | `src/media/mod.rs:42` | F1-kernel 1/0 | `pub(crate) fn install_media_host(scope: &mut dstu_kernel::Scope)` |
| `dstu_docs::docx_handout::decode_image_data` | fn | `crates/dstu-docs/src/docx_handout.rs:92` | L14-qbank 1/0 | `pub fn decode_image_data(data: &str) -> Option<Vec<u8>>` |
| `dstu_docs::docx_handout::prepare_png` | fn | `crates/dstu-docs/src/docx_handout.rs:102` | L14-qbank 1/0 | `pub fn prepare_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)>` |
| `dstu_media::media::bilibili_lifecycle::init` ? | fn | `crates/dstu-media/src/media/bilibili_lifecycle.rs:5` | F2-shell 1/0 | `pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry>` |
| `dstu_media::media::bilibili_stream::handle` ? | fn | `crates/dstu-media/src/media/bilibili_stream.rs:797` | F2-shell 1/0 | `pub async fn handle(app: &AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>>` |
| `dstu_media::media::ledger::media_learning_summary` ? | fn | `crates/dstu-media/src/media/ledger.rs:265` | L17-memory-research 1/0 | `pub fn media_learning_summary( conn: &Connection, limit: usize, ) -> rusqlite::Result<serde_json::Value>` |
| `dstu_media::media::transcriber_hook::install_vfs_hooks` ? | fn | `crates/dstu-media/src/media/transcriber_hook.rs:167` | F1-kernel 1/0 | `pub fn install_vfs_hooks(scope: &mut dstu_kernel::Scope)` |
| `dstu_media::media::wav::encode_wav_mono_16k` ? | fn | `crates/dstu-media/src/media/wav.rs:15` | L22-app-commands 1/0 | `pub fn encode_wav_mono_16k(samples: &[i16]) -> Vec<u8>` |
| `dstu_media::voice_input::asr_provider_supported` ? | fn | `crates/dstu-media/src/voice_input.rs:208` | L02-llm-manager 1/0 | `pub fn asr_provider_supported(provider_id: Option<&str>, api_protocol: Option<&str>) -> bool` |
| `dstu_media::voice_input::is_asr_model` ? | fn | `crates/dstu-media/src/voice_input.rs:203` | L02-llm-manager 1/0 | `pub fn is_asr_model(model: &str, display_name: &str) -> bool` |
| `dstu_vision::cross_page_merger::merge_pages` | fn | `crates/dstu-vision/src/cross_page_merger.rs:26` | L14-qbank 1/0 | `pub fn merge_pages(page_analyses: &[Option<VlmPageAnalysis>]) -> Vec<MergedQuestion>` |
| `dstu_vision::exam_sheet_service::ExamSheetService` | struct | `crates/dstu-vision/src/exam_sheet_service.rs:36` | L22-app-commands 1/0 | `pub struct ExamSheetService` |
| `dstu_vision::figure_extractor::extract_figures` | fn | `crates/dstu-vision/src/figure_extractor.rs:29` | L14-qbank 1/0 | `pub fn extract_figures( merged_questions: Vec<MergedQuestion>, pages: &[PageSlice], vfs_db: &VfsDatabase, ) -> Vec<QuestionWithFigures>` |
| `dstu_vision::llm_structurer::LlmStructurer` | struct | `crates/dstu-vision/src/llm_structurer.rs:48` | L14-qbank 1/0 | `pub struct LlmStructurer` |
| `dstu_vision::llm_structurer::LlmStructurer::new` | method | `crates/dstu-vision/src/llm_structurer.rs:53` | L14-qbank 1/0 | `pub fn new(llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_vision::llm_structurer::StructuredQuestion` | struct | `crates/dstu-vision/src/llm_structurer.rs:21` | L14-qbank 1/0 | `pub struct StructuredQuestion` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_docx` | method | `crates/dstu-vision/src/page_rasterizer.rs:277` | L14-qbank 1/0 | `pub fn rasterize_docx( base64_content: &str, vfs_db: &VfsDatabase, ) -> Result<RasterizerResult, AppError>` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf` | method | `crates/dstu-vision/src/page_rasterizer.rs:53` | L14-qbank 1/0 | `pub fn rasterize_pdf( base64_content: &str, vfs_db: &VfsDatabase, ) -> Result<RasterizerResult, AppError>` |
| `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf_cancellable` | method | `crates/dstu-vision/src/page_rasterizer.rs:69` | L14-qbank 1/0 | `pub fn rasterize_pdf_cancellable( base64_content: &str, vfs_db: &VfsDatabase, cancel: Option<&tokio_util::sync::CancellationToken>, ) -> Result<RasterizerResult, AppError>` |
| `dstu_vision::page_rasterizer::RasterizerResult` | struct | `crates/dstu-vision/src/page_rasterizer.rs:36` | L14-qbank 1/0 | `pub struct RasterizerResult` |
| `dstu_vision::pdf_ocr_service::PdfOcrService` | struct | `crates/dstu-vision/src/pdf_ocr_service.rs:58` | L22-app-commands 1/0 | `pub struct PdfOcrService` |
| `dstu_vision::pdf_ocr_service::PdfOcrService::new` | method | `crates/dstu-vision/src/pdf_ocr_service.rs:64` | F2-shell 1/0 | `pub fn new(file_manager: Arc<FileManager>, llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_vision::pdf_ocr_service::PdfOcrSession` | struct | `crates/dstu-vision/src/pdf_ocr_service.rs:52` | L22-app-commands 1/0 | `pub struct PdfOcrSession` |
| `dstu_vision::vlm_grounding_service::VlmGroundingService` | struct | `crates/dstu-vision/src/vlm_grounding_service.rs:335` | L14-qbank 1/0 | `pub struct VlmGroundingService` |
| `dstu_vision::vlm_grounding_service::VlmPageAnalysis` | struct | `crates/dstu-vision/src/vlm_grounding_service.rs:31` | L14-qbank 1/0 | `pub struct VlmPageAnalysis` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::PDF_ANNOTATIONS_CHANGED_EVENT` | const | `src/chat_v2/tools/textbook_pdf_executor.rs:25` | L22-app-commands 0/1 | `pub const PDF_ANNOTATIONS_CHANGED_EVENT: &str = "pdf-annotations:changed"` |

### 引用点样例

- `dstu_docs::document_parser::DocumentParser::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/history.rs:419`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:2542`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:2761`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:554`, `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:1153`；L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:588`, `crates/dstu-qbank/src/question_import_service.rs:366`, `crates/dstu-qbank/src/question_import_service.rs:636`, `crates/dstu-qbank/src/question_import_service.rs:1469`；L13-vfs-api: `crates/dstu-vfs/src/vfs/ref_handlers.rs:1907`, `src/chat_v2/tools/attachment_executor.rs:260`, `src/chat_v2/tools/attachment_executor.rs:433`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:736`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:991`, `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:100`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:10069`；L22-app-commands: `src/commands.rs:4099`, `src/commands.rs:4129`
- `dstu_vision::page_rasterizer::PageSlice` — L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:137`, `crates/dstu-qbank/src/question_authoring_runner.rs:141`, `crates/dstu-qbank/src/question_import_service.rs:1204`, `crates/dstu-qbank/src/question_import_service.rs:1391`
- `dstu_docs::document_parser::DocumentParser` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:27`；L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:4`, `crates/dstu-qbank/src/question_import_service.rs:42`；L13-vfs-api: `crates/dstu-vfs/src/vfs/ref_handlers.rs:18`, `src/chat_v2/tools/attachment_executor.rs:28`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:33`
- `dstu_docs::pdfium_utils::PDF_PAGE_SEPARATOR` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:1851`, `crates/dstu-vfs/src/vfs/indexing.rs:2097`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:157`；L13-vfs-api: `crates/dstu-vfs/src/vfs/unit_builder/builders.rs:526`
- `dstu_docs::document_parser::is_plain_text_code_extension` — L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:2374`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:396`, `crates/dstu-vfs/src/vfs/repos/attachment_repo.rs:989`
- `dstu_docs::pdfium_utils::load_pdfium` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:1849`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:141`, `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:370`
- `dstu_vision::page_rasterizer::load_page_image_bytes` — L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:105`, `crates/dstu-qbank/src/question_authoring_runner.rs:957`, `crates/dstu-qbank/src/question_import_service.rs:2088`
- `dstu_vision::vlm_grounding_service::VlmGroundingService::new` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1213`, `crates/dstu-qbank/src/question_import_service.rs:1679`, `crates/dstu-qbank/src/question_import_service.rs:2074`
- `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:89`；L13-vfs-api: `src/chat_v2/tools/mod.rs:80`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:5`
- `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:117`；L13-vfs-api: `src/chat_v2/tools/mod.rs:61`；L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:19`
- `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:96`；L13-vfs-api: `src/chat_v2/tools/mod.rs:67`
- `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:68`；L13-vfs-api: `src/chat_v2/tools/mod.rs:72`
- `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:69`；L13-vfs-api: `src/chat_v2/tools/mod.rs:74`
- `dstu_docs::pdfium_utils::extract_text_from_pdf_bytes` — L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:1850`；L11-vfs-repos: `crates/dstu-vfs/src/vfs/repos/pdf_preview.rs:152`
- `dstu_vision::page_rasterizer::PageRasterizer` — L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:7`, `crates/dstu-qbank/src/question_import_service.rs:51`
- `dstu_vision::page_rasterizer::PageRasterizer::rasterize_images` — L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:582`, `crates/dstu-qbank/src/question_import_service.rs:1411`
- `dstu_vision::exam_sheet_service::ExamSheetService::new` — L14-qbank: `crates/dstu-qbank/src/qbank_authoring_service/tests.rs:302`, `crates/dstu-qbank/src/qbank_authoring_service/tests.rs:367`；F2-shell: `src/lib.rs:3538`
- `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:93`；L13-vfs-api: `src/chat_v2/tools/mod.rs:62`
- `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:94`；L13-vfs-api: `src/chat_v2/tools/mod.rs:76`
- `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:77`；L22-app-commands: `tests/phase8_9_executor_e2e.rs:214`
- `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:95`；L13-vfs-api: `src/chat_v2/tools/mod.rs:83`
- `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:125`
- `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::resolve_file` — L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:145`
- `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::sanitize_id` — L14-qbank: `src/chat_v2/tools/qbank_import_source.rs:137`
- `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:81`
- `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:84`
- `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:56`
- `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:57`
- `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:82`
- `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:83`
- `deep_student_lib::heic_decoder::init` — F2-shell: `src/lib.rs:748`
- `deep_student_lib::media::install_media_host` — F1-kernel: `src/extensions.rs:94`
- `dstu_docs::docx_handout::decode_image_data` — L14-qbank: `crates/dstu-qbank/src/qbank_practice/export.rs:43`
- `dstu_docs::docx_handout::prepare_png` — L14-qbank: `crates/dstu-qbank/src/qbank_practice/export.rs:48`
- `dstu_media::media::bilibili_lifecycle::init` — F2-shell: `src/lib.rs:751`
- `dstu_media::media::bilibili_stream::handle` — F2-shell: `src/lib.rs:3217`
- `dstu_media::media::ledger::media_learning_summary` — L17-memory-research: `src/chat_v2/tools/learning_overview_executor.rs:250`
- `dstu_media::media::transcriber_hook::install_vfs_hooks` — F1-kernel: `src/extensions.rs:79`
- `dstu_media::media::wav::encode_wav_mono_16k` — L22-app-commands: `src/commands.rs:2405`
- `dstu_media::voice_input::asr_provider_supported` — L02-llm-manager: `src/chat_v2/tools/settings_models_executor.rs:1407`
- `dstu_media::voice_input::is_asr_model` — L02-llm-manager: `src/chat_v2/tools/settings_models_executor.rs:1444`
- `dstu_vision::cross_page_merger::merge_pages` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1311`
- `dstu_vision::exam_sheet_service::ExamSheetService` — L22-app-commands: `src/commands.rs:691`
- `dstu_vision::figure_extractor::extract_figures` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1333`
- `dstu_vision::llm_structurer::LlmStructurer` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:46`
- `dstu_vision::llm_structurer::LlmStructurer::new` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1356`
- `dstu_vision::llm_structurer::StructuredQuestion` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:2798`
- `dstu_vision::page_rasterizer::PageRasterizer::rasterize_docx` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1409`
- `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1408`
- `dstu_vision::page_rasterizer::PageRasterizer::rasterize_pdf_cancellable` — L14-qbank: `crates/dstu-qbank/src/question_authoring_runner.rs:582`
- `dstu_vision::page_rasterizer::RasterizerResult` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1406`
- `dstu_vision::pdf_ocr_service::PdfOcrService` — L22-app-commands: `src/commands.rs:693`
- `dstu_vision::pdf_ocr_service::PdfOcrService::new` — F2-shell: `src/lib.rs:3545`
- `dstu_vision::pdf_ocr_service::PdfOcrSession` — L22-app-commands: `src/commands.rs:706`
- `dstu_vision::vlm_grounding_service::VlmGroundingService` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:57`
- `dstu_vision::vlm_grounding_service::VlmPageAnalysis` — L14-qbank: `crates/dstu-qbank/src/question_import_service.rs:1216`
- `deep_student_lib::chat_v2::tools::textbook_pdf_executor::PDF_ANNOTATIONS_CHANGED_EVENT` — L22-app-commands: `tests/phase8_9_executor_e2e.rs:215`

## 消费其他 lane

### F4-security（69 个条目，prod 527 / test 30）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::validation` | method | 63/0 | `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/page_rasterizer.rs`, `crates/dstu-vision/src/vlm_grounding_service.rs` 等 7 个 |
| `dstu_core::models::AppError` | struct | 62/0 | `crates/dstu-media/src/voice_input.rs`, `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/figure_extractor.rs` 等 13 个 |
| `dstu_core::models::AppError::database` | method | 46/0 | `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/figure_extractor.rs`, `crates/dstu-vision/src/page_rasterizer.rs` 等 5 个 |
| `dstu_core::models::AppError::file_system` ? | method | 31/0 | `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/page_rasterizer.rs`, `crates/dstu-vision/src/pdf_ocr_service.rs` 等 6 个 |
| `dstu_core::agent::ToolCall` ? | struct | 29/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 27/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_core::llm_config::ApiConfig` ? | struct | 18/13 | `crates/dstu-media/src/voice_input.rs`, `crates/dstu-vision/src/vlm_grounding_service.rs`, `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_core::models::ExamCardBBox` | struct | 18/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::AppError::internal` | method | 17/0 | `crates/dstu-vision/src/page_rasterizer.rs`, `crates/dstu-vision/src/vlm_grounding_service.rs`, `src/cmd/handout.rs` 等 4 个 |
| `dstu_core::models::AppErrorType` | enum | 13/1 | `crates/dstu-media/src/voice_input.rs`, `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::ExamSheetSessionDetail` | struct | 13/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 11/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_core::models::QuestionType` | enum | 10/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::SourceType` | enum | 10/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 9/0 | `crates/dstu-vision/src/vlm_grounding_service.rs`, `src/cmd/textbooks.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 8/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 8/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_core::models::AppError::not_found` | method | 8/0 | `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/page_rasterizer.rs`, `src/cmd/textbooks.rs` |
| `dstu_core::models::AppError::llm` ? | method | 7/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_core::models::PdfOcrTextBlock` | struct | 7/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::media_types::MediaKind` | enum | 6/5 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs` 等 4 个 |
| `dstu_core::models::Difficulty` | enum | 6/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::task_objects::TaskObjectHandle` ? | struct | 6/0 | `src/chat_v2/tools/office_fidelity_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::models::AppError::unknown` | method | 4/0 | `src/heic_decoder.rs` |
| `dstu_core::models::ExamCardPreview` | struct | 4/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::ExamSheetPreviewResult` | struct | 4/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::ExamSheetSessionSummary` | struct | 4/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::task_objects::TaskObjectKind` ? | enum | 4/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::media_types::BILIBILI_LINK_MIME` | const | 3/1 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/mod.rs` |
| `dstu_core::events::event_types::IMAGE_GEN` ? | const | 3/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_core::media_types::BILIBILI_LINK_EXTENSION` | const | 3/0 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs` |
| `dstu_core::models::AppError::network` ? | method | 3/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_core::models::AppError::new` | method | 3/0 | `crates/dstu-media/src/voice_input.rs`, `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::ExamSheetSessionMetadata` | struct | 3/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::task_objects::ObjectCapabilities` ? | struct | 3/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::media_types::media_kind` | fn | 2/6 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs`, `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_core::media_types::is_link_item` | fn | 2/3 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs`, `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_core::media_types::AUDIO_EXTENSIONS` | const | 2/0 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs` |
| `dstu_core::media_types::VIDEO_EXTENSIONS` | const | 2/0 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/mod.rs` |
| `dstu_core::models::AppError::not_implemented` | method | 2/0 | `src/tts.rs` |
| `dstu_core::models::ExamSheetPreviewPage` | struct | 2/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::PdfOcrPageInput` | struct | 2/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::PdfOcrPageResult` | struct | 2/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::PdfOcrResult` | struct | 2/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::UpdateExamSheetCardsRequest` | struct | 2/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::task_objects::DerivedEdge` ? | struct | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::DerivedEdge::new` ? | method | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::hash_transform_params` ? | fn | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::ManagedLocator` ? | struct | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::ManagedLocator::new` ? | method | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder` ? | struct | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder::new` ? | method | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_security::secure_store::SecureStoreConfig` ? | struct | 2/0 | `crates/dstu-media/src/media/bilibili_auth.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::check_done_marker` | method | 2/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_core::models::StandardModel2Output` | struct | 1/1 | `src/cmd/handout.rs` |
| `dstu_core::media_types::MAX_MEDIA_IMPORT_BYTES` | const | 1/0 | `crates/dstu-media/src/media/mod.rs` |
| `dstu_core::models::ExamSheetCardUpdate` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::ImportSource` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::models::PdfOcrRequest` | struct | 1/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_core::models::QuestionBankStats` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_core::net_policy::is_blocked_internal_ip` | fn | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_core::net_policy::is_internal_ip` | fn | 1/0 | `crates/dstu-media/src/media/bilibili_transport/native.rs` |
| `dstu_core::task_objects::ProviderObjectRef` ? | struct | 1/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_core::token_source::TokenSource` ? | enum | 1/0 | `crates/dstu-media/src/voice_input.rs` |
| `dstu_security::secure_store::SecureStore` ? | struct | 1/0 | `crates/dstu-media/src/media/bilibili_auth.rs` |
| `dstu_security::secure_store::SecureStore::new` ? | method | 1/0 | `crates/dstu-media/src/media/bilibili_auth.rs` |
| `dstu_security::secure_store::SecureStore::new_with_dir` ? | method | 1/0 | `crates/dstu-media/src/media/bilibili_auth.rs` |
| `dstu_util::qr::qrcode_png_base64` | fn | 1/0 | `crates/dstu-media/src/media/bilibili_auth.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::new` | method | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |

### L13-vfs-api（32 个条目，prod 115 / test 28）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 60/3 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/bilibili_stream.rs`, `crates/dstu-media/src/media/commands.rs` 等 16 个 |
| `dstu_vfs::vfs::types::VfsTextbook` ? | struct | 7/2 | `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::parse_timestamp` | fn | 4/1 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 4/1 | `crates/dstu-media/src/media/mod.rs`, `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionFailure` | struct | 4/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::textbooks_db::Textbook` | struct | 3/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionSummary` | struct | 3/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::types::VfsFile` ? | struct | 2/1 | `src/chat_v2/tools/document_processing_executor.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionProgress` | struct | 2/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriptionRequest` | struct | 2/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::types::VfsAttachment` | struct | 2/0 | `crates/dstu-media/src/media/bilibili.rs` |
| `dstu_vfs::vfs::types::VfsFolderItem::new` ? | method | 2/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 2/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::types::VfsUploadAttachmentParams` | struct | 2/0 | `crates/dstu-media/src/media/bilibili.rs`, `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::sanitize_textbook_display_name` | fn | 1/0 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | 1/0 | `crates/dstu-media/src/media/bilibili.rs` |
| `dstu_vfs::file_stream_protocol::cors_origin_for_request` | fn | 1/0 | `crates/dstu-media/src/media/bilibili_stream.rs` |
| `dstu_vfs::textbooks_db::TextbooksDb` | struct | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::textbooks_db::TextbooksDb::update_vfs` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::textbooks_db::VfsUpdateTextbookParams` | struct | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::handlers::read_pdf_page_image_bytes` | fn | 1/0 | `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::vfs::hooks::MediaTranscriber` | trait | 1/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::hooks::register_media_transcriber` | fn | 1/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::hooks::register_resource_created_hook` | fn | 1/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::hooks::ResourceCreatedHook` | trait | 1/0 | `crates/dstu-media/src/media/transcriber_hook.rs` |
| `dstu_vfs::vfs::media_index::refresh_transcript_index` | fn | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::types::VfsCreateExamSheetParams` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::types::VfsFolder` ? | struct | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::types::VfsResourceMetadata` ? | struct | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/19 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/ledger.rs` 等 7 个 |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 0/1 | `crates/dstu-media/src/media/library.rs` |

### L11-vfs-repos（62 个条目，prod 112 / test 26）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::media_transcript_repo::PlannedSpan` | struct | 7/6 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/pipeline.rs`, `crates/dstu-media/src/media/subtitle.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::counts_with_conn` | method | 6/0 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::list_segments_with_conn` | method | 5/0 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/pipeline.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::record_duration_with_conn` | method | 4/1 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob` ? | method | 4/0 | `crates/dstu-vision/src/figure_extractor.rs`, `crates/dstu-vision/src/page_rasterizer.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::get_progress_with_conn` | method | 4/0 | `crates/dstu-media/src/media/commands.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionImage` | struct | 4/0 | `crates/dstu-vision/src/figure_extractor.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::get_textbook` | method | 4/0 | `src/chat_v2/tools/textbook_pdf_executor.rs`, `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaSegmentRow` | struct | 3/5 | `crates/dstu-media/src/media/subtitle.rs`, `crates/dstu-media/src/media/transcript.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::set_imported_segments_with_conn` ? | method | 3/1 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::SEGMENT_STATUS_DONE` | const | 3/1 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/subtitle.rs`, `crates/dstu-media/src/media/transcript.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo` | struct | 3/0 | `crates/dstu-media/src/media/bilibili.rs`, `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 3/0 | `crates/dstu-vision/src/figure_extractor.rs`, `crates/dstu-vision/src/page_rasterizer.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 3/0 | `crates/dstu-vision/src/figure_extractor.rs`, `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 3/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo` | struct | 2/2 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` 等 4 个 |
| `dstu_vfs::vfs::repos::media_transcript_repo::SegmentCounts` | struct | 2/2 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path` | method | 2/0 | `crates/dstu-vision/src/page_rasterizer.rs`, `src/chat_v2/tools/office_fidelity_executor.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaProgressRow` | struct | 2/0 | `crates/dstu-media/src/media/commands.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::plan_info_with_conn` | method | 2/0 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::PlanOutcome` | enum | 2/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::pdf_preview::PdfPreviewConfig` | struct | 2/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::attach_blob_if_missing_with_conn` | method | 2/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::replace_highlights_if_version` ? | method | 1/2 | `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaProgressUpdate` | struct | 1/1 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::apply_plan_with_conn` | method | 1/1 | `crates/dstu-media/src/media/library.rs`, `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::set_progress_with_conn` | method | 1/1 | `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::resolve_file_id_with_conn` | method | 1/0 | `src/chat_v2/tools/document_processing_executor.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_media_stream_finalized` | method | 1/0 | `crates/dstu-media/src/media/bilibili.rs` |
| `dstu_vfs::vfs::repos::attachment_repo::VfsAttachmentRepo::upload_with_folder` | method | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::get_blob_path_with_conn` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob_with_conn` ? | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::get_exam_sheet` ? | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::list_exam_sheets` | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::exam_repo::VfsExamRepo::upsert_exam_sheet` | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file` ? | method | 1/0 | `crates/dstu-vision/src/figure_extractor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file_in_folder` | method | 1/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::add_item_to_folder` ? | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::add_item_to_folder_with_conn` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder_with_conn` | method | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::list_folders_by_parent_with_conn` | method | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::list_unfinished_with_conn` | method | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::mark_done_with_bounds_with_conn` | method | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::mark_failed_with_conn` | method | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::reset_failed_with_conn` | method | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::SEGMENT_SOURCE_IMPORT` | const | 1/0 | `crates/dstu-media/src/media/pipeline.rs` |
| `dstu_vfs::vfs::repos::pdf_preview::render_pdf_preview_with_progress` | fn | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::question_repo::QuestionFilters` | struct | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::count_questions` | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::question_repo::VfsQuestionRepo::list_questions` ? | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::create_or_reuse` ? | method | 1/0 | `src/chat_v2/tools/image_generation_executor.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo` | struct | 1/0 | `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::create_textbook_with_preview` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::get_by_sha256` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::rename_textbook_with_conn` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::replace_bookmarks_if_version` | method | 1/0 | `src/chat_v2/tools/textbook_pdf_executor.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::restore_textbook` | method | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_vfs::vfs::repos::media_transcript_repo::MediaTranscriptRepo::mark_done_with_conn` | method | 0/2 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::textbook_repo::VfsTextbookRepo::create_textbook` ? | method | 0/1 | `src/chat_v2/tools/textbook_pdf_executor.rs` |

### L04-chat-session（3 个条目，prod 63 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 49/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 9 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 8/0 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_agent::chat_v2::tools::OFFICE_DOC_PARSE_MAX_BYTES` ? | const | 6/0 | `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/pptx_executor.rs`, `src/chat_v2/tools/xlsx_executor.rs` |

### F1-kernel（7 个条目，prod 55 / test 26）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 31/26 | `src/chat_v2/tools/document_processing_executor.rs`, `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/image_generation_executor.rs` 等 8 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 18/0 | `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs` 等 6 个 |
| `dstu_kernel::plugin::Scope` | struct | 2/0 | `crates/dstu-media/src/media/transcriber_hook.rs`, `src/media/mod.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 1/0 | `crates/dstu-media/src/host.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-media/src/host.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-media/src/host.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 1/0 | `crates/dstu-media/src/host.rs` |

### L02-llm-manager（14 个条目，prod 51 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 16/0 | `crates/dstu-media/src/host.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/transcriber_hook.rs` 等 8 个 |
| `dstu_llm::llm_manager::OcrModelConfig` | struct | 12/0 | `crates/dstu-vision/src/vlm_grounding_service.rs`, `src/cmd/ocr.rs` |
| `dstu_llm::llm_manager::ocr_models::SYSTEM_OCR_CONFIG_ID` | const | 7/0 | `src/cmd/ocr.rs` |
| `dstu_llm::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static` | method | 3/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::llm_manager::is_discontinued_ocr_model` | fn | 3/0 | `crates/dstu-vision/src/vlm_grounding_service.rs`, `src/cmd/ocr.rs` |
| `dstu_llm::llm_manager::single_shot_stream::SingleShotOptions::new` | method | 2/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::llm_manager::build_provider_adapter` | fn | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::llm_manager::ImagePayload` | struct | 1/0 | `src/cmd/handout.rs` |
| `dstu_llm::llm_manager::IncrementalJsonArrayParser::new` | method | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 1/0 | `crates/dstu-vision/src/exam_sheet_service.rs` |
| `dstu_llm::llm_manager::ocr_models::migrate_glm_ocr_models` | fn | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::llm_manager::ocr_models::migrate_paddle_ocr_models` | fn | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::llm_manager::single_shot_stream::is_retryable_http_status` | fn | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::llm_manager::single_shot_stream::SingleShotOptions` | struct | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |

### F3-storage（15 个条目，prod 41 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 13/0 | `crates/dstu-media/src/host.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/ledger.rs` 等 6 个 |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 6/0 | `crates/dstu-media/src/media/asr.rs`, `crates/dstu-media/src/voice_input.rs`, `src/cmd/handout.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 4/0 | `crates/dstu-vision/src/exam_sheet_service.rs`, `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_storage::unified_file_manager::read_all_bytes_bounded` | fn | 4/0 | `crates/dstu-media/src/media/commands.rs`, `src/cmd/textbooks.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 3/0 | `src/chat_v2/tools/docx_executor.rs`, `src/chat_v2/tools/pptx_executor.rs`, `src/chat_v2/tools/xlsx_executor.rs` |
| `dstu_storage::unified_file_manager::extract_file_name` | fn | 2/0 | `crates/dstu-media/src/media/commands.rs`, `src/cmd/textbooks.rs` |
| `dstu_storage::unified_file_manager::hash_file_sha256` | fn | 2/0 | `src/cmd/textbooks.rs` |
| `dstu_storage::llm_usage::record_usage_record` | fn | 1/0 | `crates/dstu-media/src/voice_input.rs` |
| `dstu_storage::llm_usage::types::UsageRecord` ? | struct | 1/0 | `crates/dstu-media/src/voice_input.rs` |
| `dstu_storage::llm_usage::types::UsageRecord::new` ? | method | 1/0 | `crates/dstu-media/src/voice_input.rs` |
| `dstu_storage::unified_file_manager::get_file_size` | fn | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_storage::unified_file_manager::is_opaque_document_id` | fn | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_storage::unified_file_manager::resolve_file_info` | fn | 1/0 | `src/cmd/textbooks.rs` |
| `dstu_storage::unified_file_manager::write_text_file` | fn | 1/0 | `crates/dstu-media/src/media/commands.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-media/src/voice_input.rs` |

### L22-app-commands（1 个条目，prod 31 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 31/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs`, `src/chat_v2/tools/office_output.rs` 等 10 个 |

### L01-llm-providers（13 个条目，prod 25 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::engine_info_list` | method | 4/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::types::OcrEngineType::from_str` ? | method | 4/0 | `src/cmd/ocr.rs` |
| `dstu_llm::providers::StreamEvent` | enum | 3/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::create` | method | 2/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` | method | 2/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::system_ocr::is_platform_supported` | fn | 2/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::types::OcrEngineType` ? | enum | 2/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory` | struct | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::validate_model_for_engine` | method | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::system_ocr::perform_system_ocr` | fn | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::types::OcrEngineType::try_from_str` ? | method | 1/0 | `src/cmd/ocr.rs` |
| `dstu_llm::ocr_adapters::types::OcrTaskType` ? | enum | 1/0 | `crates/dstu-vision/src/pdf_ocr_service.rs` |
| `dstu_llm::providers::ProviderAdapter` | trait | 1/0 | `crates/dstu-vision/src/vlm_grounding_service.rs` |

### L05-agent-workspace（10 个条目，prod 19 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` ? | fn | 3/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 3/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs`, `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::workspace_change_set::MutationKind` ? | enum | 3/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 2/0 | `src/chat_v2/tools/media_executor.rs`, `src/chat_v2/tools/office_fidelity_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootAccess` ? | enum | 2/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootKind` ? | enum | 2/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::runtime_roots::artifact_root` ? | fn | 1/0 | `src/chat_v2/tools/media_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::temp_root` ? | fn | 1/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::workspace_change_set::ChangeSet` ? | struct | 1/0 | `src/chat_v2/tools/office_output.rs` |
| `dstu_agent::chat_v2::workspace_change_set::ChangeSet::single` ? | method | 1/0 | `src/chat_v2/tools/office_output.rs` |

### L12-vfs-index（2 个条目，prod 17 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | 12/0 | `crates/dstu-media/src/media/bilibili.rs`, `crates/dstu-media/src/media/commands.rs`, `crates/dstu-media/src/media/library.rs` 等 5 个 |
| `dstu_vfs::vfs::pdf_processing_service::ProcessingStage` | enum | 5/2 | `src/chat_v2/tools/document_processing_executor.rs`, `src/cmd/textbooks.rs` |

### L10-notes（6 个条目，prod 1 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::get_note_content_with_conn` | method | 1/0 | `crates/dstu-media/src/media/ledger.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteMetadataUpdate` | struct | 0/1 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 0/1 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note` ? | method | 0/1 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::delete_note` | method | 0/1 | `crates/dstu-media/src/media/library.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::update_note_metadata` | method | 0/1 | `crates/dstu-media/src/media/library.rs` |

### L15-review-analytics（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_learning::study_loop::media_source::media_citation_seconds_for` | fn | 1/0 | `crates/dstu-media/src/media/ledger.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::ocr::*` @ `src/commands.rs:51`
- 被 L22-app-commands 导入：`use deep_student_lib::cmd::textbooks::*` @ `src/commands.rs:52`
