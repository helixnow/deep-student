# 跨 lane 服务草稿：L01-llm-providers

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（54 个条目，其中 49 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_llm::providers::StreamEvent` | enum | `crates/dstu-llm/src/providers/mod.rs:39` | L02-llm-manager 21/10<br>L14-qbank 7/0<br>L16-anki 4/0<br>L18-media-docs 3/0 | `pub enum StreamEvent` |
| `dstu_llm::providers::ProviderAdapter` | trait | `crates/dstu-llm/src/providers/mod.rs:59` | L02-llm-manager 20/2<br>L14-qbank 3/0<br>L16-anki 1/0<br>L18-media-docs 1/0 | `pub trait ProviderAdapter: Send + Sync` |
| `dstu_llm::ocr_adapters::types::OcrEngineType` ? | enum | `crates/dstu-llm/src/ocr_adapters/types.rs:10` | L02-llm-manager 9/0<br>L12-vfs-index 2/0<br>L18-media-docs 2/0<br>L03-chat-pipeline 0/1 | `pub enum OcrEngineType` |
| `dstu_llm::multimodal::types::MultimodalInput` | struct | `crates/dstu-llm/src/multimodal/types.rs:32` | L02-llm-manager 5/0<br>L12-vfs-index 4/0<br>L13-vfs-api 1/0 | `pub struct MultimodalInput` |
| `dstu_llm::ocr_adapters::types::OcrTaskType` ? | enum | `crates/dstu-llm/src/ocr_adapters/types.rs:105` | L02-llm-manager 3/4<br>L12-vfs-index 3/0<br>L18-media-docs 1/0 | `pub enum OcrTaskType` |
| `dstu_llm::multimodal::types::IndexProgressEvent::new` | method | `crates/dstu-llm/src/multimodal/types.rs:330` | L12-vfs-index 6/0 | `pub fn new(source_type: &str, source_id: &str, total_pages: i32) -> Self` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` | method | `crates/dstu-llm/src/ocr_adapters/factory.rs:146` | L02-llm-manager 2/0<br>L18-media-docs 2/0<br>L03-chat-pipeline 1/0<br>L12-vfs-index 1/0 | `pub fn infer_engine_from_model(model: &str) -> OcrEngineType` |
| `dstu_llm::ocr_adapters::system_ocr::is_platform_supported` | fn | `crates/dstu-llm/src/ocr_adapters/system_ocr/mod.rs:72` | L02-llm-manager 3/0<br>L18-media-docs 2/0 | `pub fn is_platform_supported() -> bool` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::create` | method | `crates/dstu-llm/src/ocr_adapters/factory.rs:23` | L02-llm-manager 2/0<br>L18-media-docs 2/0 | `pub fn create(engine_type: OcrEngineType) -> Arc<dyn OcrAdapter>` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::engine_info_list` | method | `crates/dstu-llm/src/ocr_adapters/factory.rs:58` | L18-media-docs 4/0 | `pub fn engine_info_list() -> Vec<OcrEngineInfo>` |
| `dstu_llm::ocr_adapters::system_ocr::perform_system_ocr` | fn | `crates/dstu-llm/src/ocr_adapters/system_ocr/mod.rs:38` | L02-llm-manager 2/0<br>L04-chat-session 1/0<br>L18-media-docs 1/0 | `pub async fn perform_system_ocr(image_data: &[u8]) -> Result<String, OcrError>` |
| `dstu_llm::ocr_adapters::types::OcrEngineType::from_str` ? | method | `crates/dstu-llm/src/ocr_adapters/types.rs:28` | L18-media-docs 4/0 | `pub fn from_str(s: &str) -> Self` |
| `dstu_llm::multimodal::types::IndexProgressEvent` | struct | `crates/dstu-llm/src/multimodal/types.rs:308` | L12-vfs-index 3/0 | `pub struct IndexProgressEvent` |
| `dstu_llm::multimodal::types::MultimodalImage` | enum | `crates/dstu-llm/src/multimodal/types.rs:128` | L12-vfs-index 3/0 | `pub enum MultimodalImage` |
| `dstu_llm::ocr_adapters::types::OcrMode` ? | enum | `crates/dstu-llm/src/ocr_adapters/types.rs:117` | L02-llm-manager 2/0<br>L04-chat-session 1/0 | `pub enum OcrMode` |
| `dstu_llm::providers::OpenAIAdapter::new` | method | `crates/dstu-llm/src/providers/mod.rs:98` | L02-llm-manager 2/4<br>L14-qbank 0/1 | `pub fn new() -> Self` |
| `dstu_llm::providers::AnthropicAdapter::new` | method | `crates/dstu-llm/src/providers/mod.rs:2332` | L02-llm-manager 2/3<br>L14-qbank 0/1 | `pub fn new() -> Self` |
| `dstu_llm::providers::GeminiAdapter::new` | method | `crates/dstu-llm/src/providers/mod.rs:3820` | L02-llm-manager 2/3<br>L14-qbank 0/1 | `pub fn new() -> Self` |
| `dstu_llm::multimodal::types::MultimodalInput::image_base64` ? | method | `crates/dstu-llm/src/multimodal/types.rs:64` | L12-vfs-index 2/1 | `pub fn image_base64(base64: impl Into<String>, media_type: impl Into<String>) -> Self` |
| `dstu_llm::multimodal::types::MultimodalInput::text` ? | method | `crates/dstu-llm/src/multimodal/types.rs:54` | L12-vfs-index 2/1 | `pub fn text(text: impl Into<String>) -> Self` |
| `dstu_llm::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai` | fn | `crates/dstu-llm/src/adapters/gemini-openai-converter.rs:1230` | L02-llm-manager 2/0 | `pub fn convert_gemini_nonstream_response_to_openai( gemini_json: &Value, model: &str, ) -> Result<Value, AdapterError>` |
| `dstu_llm::multimodal::embedding_service::EmbeddingProgress` | struct | `crates/dstu-llm/src/multimodal/embedding_service.rs:31` | L12-vfs-index 2/0 | `pub struct EmbeddingProgress` |
| `dstu_llm::ocr_adapters::types::OcrRegion` ? | struct | `crates/dstu-llm/src/ocr_adapters/types.rs:147` | L02-llm-manager 2/0 | `pub struct OcrRegion` |
| `dstu_llm::openai_codex::manager::CodexAuthManager` | struct | `crates/dstu-llm/src/openai_codex/manager.rs:44` | L02-llm-manager 2/0 | `pub struct CodexAuthManager` |
| `dstu_llm::openai_codex::protocol::codex_sse_to_responses_json` | fn | `crates/dstu-llm/src/openai_codex/protocol.rs:414` | L02-llm-manager 2/0 | `pub fn codex_sse_to_responses_json(body: &str) -> Result<Value, CodexAuthError>` |
| `dstu_llm::openai_codex::types::CodexRequestAuth` | struct | `crates/dstu-llm/src/openai_codex/types.rs:56` | L02-llm-manager 2/0 | `pub struct CodexRequestAuth` |
| `dstu_llm::providers::OpenAIResponsesAdapter::new` | method | `crates/dstu-llm/src/providers/mod.rs:828` | L02-llm-manager 1/0<br>L14-qbank 0/1 | `pub fn new() -> Self` |
| `dstu_llm::providers::ProviderRequest` | struct | `crates/dstu-llm/src/providers/mod.rs:17` | L02-llm-manager 1/1 | `pub struct ProviderRequest` |
| `dstu_llm::multimodal::embedding_chunker::batch_chunk_texts` | fn | `crates/dstu-llm/src/multimodal/embedding_chunker.rs:584` | L02-llm-manager 1/0 | `pub fn batch_chunk_texts(texts: &[String], chunker: &EmbeddingChunker) -> Vec<ChunkResult>` |
| `dstu_llm::multimodal::embedding_chunker::ChunkAggregation` | enum | `crates/dstu-llm/src/multimodal/embedding_chunker.rs:115` | L02-llm-manager 1/0 | `pub enum ChunkAggregation` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings` | method | `crates/dstu-llm/src/multimodal/embedding_chunker.rs:515` | L02-llm-manager 1/0 | `pub fn aggregate_embeddings(embeddings: &[Vec<f32>], method: ChunkAggregation) -> Vec<f32>` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::new` | method | `crates/dstu-llm/src/multimodal/embedding_chunker.rs:144` | L02-llm-manager 1/0 | `pub fn new(max_tokens: usize) -> Self` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingTokenLimits` | struct | `crates/dstu-llm/src/multimodal/embedding_chunker.rs:33` | L02-llm-manager 1/0 | `pub struct EmbeddingTokenLimits` |
| `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService` | struct | `crates/dstu-llm/src/multimodal/embedding_service.rs:149` | L12-vfs-index 1/0 | `pub struct MultimodalEmbeddingService` |
| `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService::new` | method | `crates/dstu-llm/src/multimodal/embedding_service.rs:156` | L12-vfs-index 1/0 | `pub fn new(llm_manager: Arc<LLMManager>) -> Self` |
| `dstu_llm::multimodal::page_indexer::AttachmentPreview` | struct | `crates/dstu-llm/src/multimodal/page_indexer.rs:18` | L12-vfs-index 1/0 | `pub struct AttachmentPreview` |
| `dstu_llm::multimodal::types::VLRerankerResult` | struct | `crates/dstu-llm/src/multimodal/types.rs:213` | L02-llm-manager 1/0 | `pub struct VLRerankerResult` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory` | struct | `crates/dstu-llm/src/ocr_adapters/factory.rs:19` | L18-media-docs 1/0 | `pub struct OcrAdapterFactory` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::validate_model_for_engine` | method | `crates/dstu-llm/src/ocr_adapters/factory.rs:125` | L18-media-docs 1/0 | `pub fn validate_model_for_engine(model: &str, engine_type: OcrEngineType) -> bool` |
| `dstu_llm::ocr_adapters::OcrAdapter` | trait | `crates/dstu-llm/src/ocr_adapters/mod.rs:65` | L02-llm-manager 1/0 | `pub trait OcrAdapter: Send + Sync` |
| `dstu_llm::ocr_adapters::types::OcrEngineType::try_from_str` ? | method | `crates/dstu-llm/src/ocr_adapters/types.rs:33` | L18-media-docs 1/0 | `pub fn try_from_str(s: &str) -> Option<Self>` |
| `dstu_llm::ocr_adapters::types::OcrPageResult` ? | struct | `crates/dstu-llm/src/ocr_adapters/types.rs:168` | L02-llm-manager 1/0 | `pub struct OcrPageResult` |
| `dstu_llm::openai_codex::manager::CodexAuthManager::new` | method | `crates/dstu-llm/src/openai_codex/manager.rs:125` | L02-llm-manager 1/0 | `pub fn new(database: Arc<Database>) -> Self` |
| `dstu_llm::openai_codex::protocol::build_codex_request_headers` | fn | `crates/dstu-llm/src/openai_codex/protocol.rs:84` | L02-llm-manager 1/0 | `pub fn build_codex_request_headers( auth: &CodexRequestAuth, session_id: &str, ) -> Result<HeaderMap, CodexAuthError>` |
| `dstu_llm::openai_codex::protocol::prepare_codex_responses_body` | fn | `crates/dstu-llm/src/openai_codex/protocol.rs:131` | L02-llm-manager 1/0 | `pub fn prepare_codex_responses_body(body: &Value) -> Result<Value, CodexAuthError>` |
| `dstu_llm::providers::convert_anthropic_response_to_openai` | fn | `crates/dstu-llm/src/providers/mod.rs:3667` | L02-llm-manager 1/0 | `pub fn convert_anthropic_response_to_openai(response: &Value, model: &str) -> Option<Value>` |
| `dstu_llm::providers::normalize_ollama_root_base_url` | fn | `crates/dstu-llm/src/providers/mod.rs:111` | L22-app-commands 1/0 | `pub fn normalize_ollama_root_base_url(base_url: &str) -> std::borrow::Cow<'_, str>` |
| `dstu_llm::providers::normalize_openai_nonstream_response` | fn | `crates/dstu-llm/src/providers/mod.rs:462` | L02-llm-manager 1/0 | `pub(crate) fn normalize_openai_nonstream_response(response: &Value) -> Value` |
| `dstu_llm::providers::ProviderError` | enum | `crates/dstu-llm/src/providers/mod.rs:24` | L02-llm-manager 1/0 | `pub enum ProviderError` |
| `dstu_llm::providers::OpenAIAdapter` | struct | `crates/dstu-llm/src/providers/mod.rs:82` | L02-llm-manager 0/2<br>L14-qbank 0/1 | `pub struct OpenAIAdapter` |
| `dstu_llm::multimodal::types::MultimodalInput::image_url` ? | method | `crates/dstu-llm/src/multimodal/types.rs:77` | L12-vfs-index 0/1 | `pub fn image_url(url: impl Into<String>) -> Self` |
| `dstu_llm::multimodal::types::MultimodalInput::text_and_image` ? | method | `crates/dstu-llm/src/multimodal/types.rs:87` | L12-vfs-index 0/1 | `pub fn text_and_image( text: impl Into<String>, base64: impl Into<String>, media_type: impl Into<String>, ) -> Self` |
| `dstu_llm::providers::AnthropicAdapter` | struct | `crates/dstu-llm/src/providers/mod.rs:2306` | L02-llm-manager 0/1 | `pub struct AnthropicAdapter` |
| `dstu_llm::providers::GeminiAdapter` | struct | `crates/dstu-llm/src/providers/mod.rs:3809` | L02-llm-manager 0/1 | `pub struct GeminiAdapter` |

### 引用点样例

- `dstu_llm::providers::StreamEvent` — L16-anki: `crates/dstu-anki/src/streaming_anki_service.rs:1484`, `crates/dstu-anki/src/streaming_anki_service.rs:1632`, `crates/dstu-anki/src/streaming_anki_service.rs:1649`, `crates/dstu-anki/src/streaming_anki_service.rs:1675`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:62`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:73`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:84`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:658`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:91`, `crates/dstu-qbank/src/qbank_grading/stream.rs:94`, `crates/dstu-qbank/src/qbank_grading/stream.rs:98`, `crates/dstu-qbank/src/qbank_grading/stream.rs:103`；L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:895`, `crates/dstu-vision/src/vlm_grounding_service.rs:929`, `crates/dstu-vision/src/vlm_grounding_service.rs:999`
- `dstu_llm::providers::ProviderAdapter` — L16-anki: `crates/dstu-anki/src/streaming_anki_service.rs:1332`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:49`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:62`, `crates/dstu-llm/src/llm_manager/mod.rs:4166`, `crates/dstu-llm/src/llm_manager/mod.rs:7476`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:1145`, `crates/dstu-qbank/src/qbank_grading/stream.rs:44`, `crates/dstu-qbank/src/qbank_grading/stream.rs:76`；L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:757`
- `dstu_llm::ocr_adapters::types::OcrEngineType` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:229`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:1238`, `crates/dstu-llm/src/llm_manager/mod.rs:3277`, `crates/dstu-llm/src/llm_manager/mod.rs:3283`, `crates/dstu-llm/src/llm_manager/mod.rs:3286`；L12-vfs-index: `crates/dstu-vfs/src/vfs/unified_retriever.rs:1520`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1545`；L18-media-docs: `src/cmd/ocr.rs:8`, `src/cmd/ocr.rs:64`
- `dstu_llm::multimodal::types::MultimodalInput` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:550`, `crates/dstu-llm/src/llm_manager/rag_extension.rs:564`, `crates/dstu-llm/src/llm_manager/rag_extension.rs:584`, `crates/dstu-llm/src/llm_manager/rag_extension.rs:746`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:6181`；L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:97`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:481`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:993`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:16`
- `dstu_llm::ocr_adapters::types::OcrTaskType` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:689`, `crates/dstu-llm/src/llm_manager/mod.rs:3421`, `crates/dstu-llm/src/llm_manager/mod.rs:3308`, `crates/dstu-llm/src/llm_manager/mod.rs:3459`；L12-vfs-index: `crates/dstu-vfs/src/vfs/indexing.rs:3633`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3932`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:482`；L18-media-docs: `crates/dstu-vision/src/pdf_ocr_service.rs:673`
- `dstu_llm::multimodal::types::IndexProgressEvent::new` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:464`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:837`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:1451`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:1475`
- `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:35`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:474`, `crates/dstu-llm/src/llm_manager/exam_engine.rs:1219`；L12-vfs-index: `crates/dstu-vfs/src/vfs/unified_retriever.rs:1560`；L18-media-docs: `src/cmd/ocr.rs:108`, `src/cmd/ocr.rs:481`
- `dstu_llm::ocr_adapters::system_ocr::is_platform_supported` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:7135`, `crates/dstu-llm/src/llm_manager/mod.rs:7200`, `crates/dstu-llm/src/llm_manager/mod.rs:7259`；L18-media-docs: `src/cmd/ocr.rs:247`, `src/cmd/ocr.rs:302`
- `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::create` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:475`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:9357`；L18-media-docs: `src/cmd/ocr.rs:144`, `src/cmd/ocr.rs:621`
- `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::engine_info_list` — L18-media-docs: `src/cmd/ocr.rs:40`, `src/cmd/ocr.rs:272`, `src/cmd/ocr.rs:502`, `src/cmd/ocr.rs:635`
- `dstu_llm::ocr_adapters::system_ocr::perform_system_ocr` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ocr.rs:76`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:203`, `crates/dstu-llm/src/llm_manager/exam_engine.rs:234`；L18-media-docs: `src/cmd/ocr.rs:674`
- `dstu_llm::ocr_adapters::types::OcrEngineType::from_str` — L18-media-docs: `src/cmd/ocr.rs:118`, `src/cmd/ocr.rs:141`, `src/cmd/ocr.rs:504`, `src/cmd/ocr.rs:620`
- `dstu_llm::multimodal::types::IndexProgressEvent` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:242`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:268`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:1310`
- `dstu_llm::multimodal::types::MultimodalImage` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:25`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:104`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:107`
- `dstu_llm::ocr_adapters::types::OcrMode` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ocr.rs:91`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:492`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:9358`
- `dstu_llm::providers::OpenAIAdapter::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:53`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:655`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:717`, `crates/dstu-llm/src/llm_manager/mod.rs:4190`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:238`
- `dstu_llm::providers::AnthropicAdapter::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:51`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:675`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:726`, `crates/dstu-llm/src/llm_manager/mod.rs:4188`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:312`
- `dstu_llm::providers::GeminiAdapter::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:52`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:695`, `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:730`, `crates/dstu-llm/src/llm_manager/mod.rs:4189`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:370`
- `dstu_llm::multimodal::types::MultimodalInput::image_base64` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:504`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:1766`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:860`
- `dstu_llm::multimodal::types::MultimodalInput::text` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:979`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:1746`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:822`
- `dstu_llm::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4203`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:8473`
- `dstu_llm::multimodal::embedding_service::EmbeddingProgress` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:448`, `crates/dstu-vfs/src/vfs/multimodal_service.rs:526`
- `dstu_llm::ocr_adapters::types::OcrRegion` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:1273`, `crates/dstu-llm/src/llm_manager/mod.rs:7399`
- `dstu_llm::openai_codex::manager::CodexAuthManager` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4316`, `crates/dstu-llm/src/llm_manager/mod.rs:4784`
- `dstu_llm::openai_codex::protocol::codex_sse_to_responses_json` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4748`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs:624`
- `dstu_llm::openai_codex::types::CodexRequestAuth` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4036`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4811`
- `dstu_llm::providers::OpenAIResponsesAdapter::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4187`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:331`
- `dstu_llm::providers::ProviderRequest` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:2384`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4050`
- `dstu_llm::multimodal::embedding_chunker::batch_chunk_texts` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:1067`
- `dstu_llm::multimodal::embedding_chunker::ChunkAggregation` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:1100`
- `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:1098`
- `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:1049`
- `dstu_llm::multimodal::embedding_chunker::EmbeddingTokenLimits` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:1047`
- `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:160`
- `dstu_llm::multimodal::embedding_service::MultimodalEmbeddingService::new` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:170`
- `dstu_llm::multimodal::page_indexer::AttachmentPreview` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:1378`
- `dstu_llm::multimodal::types::VLRerankerResult` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/rag_extension.rs:748`
- `dstu_llm::ocr_adapters::factory::OcrAdapterFactory` — L18-media-docs: `src/cmd/ocr.rs:8`
- `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::validate_model_for_engine` — L18-media-docs: `src/cmd/ocr.rs:119`
- `dstu_llm::ocr_adapters::OcrAdapter` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:7667`
- `dstu_llm::ocr_adapters::types::OcrEngineType::try_from_str` — L18-media-docs: `src/cmd/ocr.rs:91`
- `dstu_llm::ocr_adapters::types::OcrPageResult` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/exam_engine.rs:1361`
- `dstu_llm::openai_codex::manager::CodexAuthManager::new` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4754`
- `dstu_llm::openai_codex::protocol::build_codex_request_headers` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4815`
- `dstu_llm::openai_codex::protocol::prepare_codex_responses_body` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5007`
- `dstu_llm::providers::convert_anthropic_response_to_openai` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4224`
- `dstu_llm::providers::normalize_ollama_root_base_url` — L22-app-commands: `src/commands.rs:2958`
- `dstu_llm::providers::normalize_openai_nonstream_response` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4232`
- `dstu_llm::providers::ProviderError` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/mod.rs:4851`
- `dstu_llm::providers::OpenAIAdapter` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:34`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs:1045`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:229`
- `dstu_llm::multimodal::types::MultimodalInput::image_url` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:1786`
- `dstu_llm::multimodal::types::MultimodalInput::text_and_image` — L12-vfs-index: `crates/dstu-vfs/src/vfs/multimodal_service.rs:1775`
- `dstu_llm::providers::AnthropicAdapter` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:34`
- `dstu_llm::providers::GeminiAdapter` — L02-llm-manager: `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs:34`

## 消费其他 lane

### F4-security（11 个条目，prod 27 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::internal` | method | 7/0 | `crates/dstu-llm/src/multimodal/embedding_service.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 5/0 | `crates/dstu-llm/src/multimodal/embedding_service.rs`, `crates/dstu-llm/src/ocr_adapters/types.rs` |
| `dstu_core::models::AppError` | struct | 3/5 | `crates/dstu-llm/src/multimodal/embedding_service.rs`, `crates/dstu-llm/src/ocr_adapters/types.rs` |
| `dstu_core::models::AppError::llm` ? | method | 3/0 | `crates/dstu-llm/src/ocr_adapters/types.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 2/8 | `crates/dstu-llm/src/multimodal/embedding_service.rs`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs` |
| `dstu_util::utils::fetch::fetch_binary_with_cache` | fn | 2/0 | `crates/dstu-llm/src/adapters/gemini-openai-converter.rs`, `crates/dstu-llm/src/providers/mod.rs` |
| `dstu_util::utils::sse_buffer::extract_stream_data_payload` | fn | 2/0 | `crates/dstu-llm/src/adapters/gemini-openai-converter.rs`, `crates/dstu-llm/src/providers/mod.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 1/0 | `crates/dstu-llm/src/ocr_adapters/types.rs` |
| `dstu_core::models::AppError::network` ? | method | 1/0 | `crates/dstu-llm/src/ocr_adapters/types.rs` |
| `dstu_core::models::AppErrorType` | enum | 1/0 | `crates/dstu-llm/src/multimodal/embedding_service.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::new` | method | 0/2 | `crates/dstu-llm/src/providers/deepseek_harness_tests.rs`, `crates/dstu-llm/src/providers/mod.rs` |

### L02-llm-manager（8 个条目，prod 16 / test 11）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 8/1 | `crates/dstu-llm/src/multimodal/embedding_service.rs`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs`, `src/cmd/openai_codex.rs` |
| `dstu_llm::llm_manager::adapters::anthropic::ClaudeGeneration` | enum | 4/0 | `crates/dstu-llm/src/providers/mod.rs` |
| `dstu_llm::llm_manager::adapters::anthropic::claude_generation` | fn | 2/0 | `crates/dstu-llm/src/providers/mod.rs` |
| `dstu_llm::llm_manager::adapters::anthropic::map_budget_tokens_to_effort` | fn | 1/0 | `crates/dstu-llm/src/providers/mod.rs` |
| `dstu_llm::llm_manager::ImagePayload` | struct | 1/0 | `crates/dstu-llm/src/multimodal/embedding_service.rs` |
| `dstu_llm::llm_manager::LLMManager::apply_reasoning_config` | method | 0/8 | `crates/dstu-llm/src/providers/deepseek_harness_tests.rs` |
| `dstu_llm::llm_manager::model2_pipeline::apply_generation_params` | fn | 0/1 | `crates/dstu-llm/src/providers/deepseek_harness_tests.rs` |
| `dstu_llm::llm_manager::provider_quirks::resolve_quirks` | fn | 0/1 | `crates/dstu-llm/src/providers/deepseek_harness_tests.rs` |

### F3-storage（1 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 3/0 | `crates/dstu-llm/src/openai_codex/manager.rs`, `crates/dstu-llm/src/openai_codex/store.rs` |
