# 跨 lane 服务草稿：L02-llm-manager

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（106 个条目，其中 103 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:4313` | L17-memory-research 59/0<br>L12-vfs-index 23/0<br>L13-vfs-api 22/0<br>L18-media-docs 16/0<br>L14-qbank 16/1<br>L04-chat-session 15/0<br>L01-llm-providers 8/1<br>L16-anki 4/0<br>L24-chatanki 3/0<br>L05-agent-workspace 2/0<br>L03-chat-pipeline 2/1<br>L07-agent-skills-ptc 1/0<br>L19-mcp-browser 1/0<br>L22-app-commands 1/3<br>F2-shell 1/0<br>F1-kernel 1/0 | `pub struct LLMManager` |
| `dstu_tutor::essay_grading::types::GradingMode` ? | struct | `crates/dstu-tutor/src/essay_grading/types.rs:21` | L15-review-analytics 7/0<br>L14-qbank 5/2 | `pub struct GradingMode` |
| `dstu_llm::llm_manager::OcrModelConfig` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:3252` | L18-media-docs 12/0 | `pub struct OcrModelConfig` |
| `dstu_llm::llm_manager::ImagePayload` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:4331` | L24-chatanki 4/0<br>L12-vfs-index 2/0<br>L04-chat-session 1/0<br>L03-chat-pipeline 1/0<br>L01-llm-providers 1/0<br>L18-media-docs 1/0 | `pub struct ImagePayload` |
| `dstu_llm::llm_manager::OcrRuntimeCandidate` | enum | `crates/dstu-llm/src/llm_manager/mod.rs:3274` | L12-vfs-index 4/0<br>L03-chat-pipeline 3/1 | `pub enum OcrRuntimeCandidate` |
| `dstu_llm::llm_manager::ocr_models::SYSTEM_OCR_CONFIG_ID` | const | `crates/dstu-llm/src/llm_manager/ocr_models.rs:6` | L18-media-docs 7/0 | `pub const SYSTEM_OCR_CONFIG_ID: &str = "__system_ocr__"` |
| `dstu_llm::llm_manager::routing::llm_error_code` | fn | `crates/dstu-llm/src/llm_manager/routing.rs:209` | L03-chat-pipeline 6/0<br>L14-qbank 1/0 | `pub fn llm_error_code(err: &AppError) -> Option<&str>` |
| `dstu_llm::llm_manager::VendorConfig` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:3554` | L22-app-commands 5/11<br>L14-qbank 0/2 | `pub struct VendorConfig` |
| `dstu_llm::llm_manager::build_provider_adapter` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:4166` | L22-app-commands 2/4<br>L16-anki 1/0<br>L14-qbank 1/0<br>L18-media-docs 1/0 | `pub fn build_provider_adapter(config: &ApiConfig) -> Box<dyn ProviderAdapter>` |
| `dstu_llm::llm_manager::parser::enhanced_clean_json_response` | fn | `crates/dstu-llm/src/llm_manager/parser.rs:353` | L17-memory-research 5/0 | `pub fn enhanced_clean_json_response(content: &str) -> String` |
| `dstu_llm::anki_model_routing::AnkiModelRole` | enum | `crates/dstu-llm/src/anki_model_routing.rs:38` | L16-anki 2/1<br>L24-chatanki 2/0 | `pub enum AnkiModelRole` |
| `dstu_llm::llm_manager::adapters::anthropic::ClaudeGeneration` | enum | `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs:45` | L01-llm-providers 4/0 | `pub enum ClaudeGeneration` |
| `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_COMPACTION_REQUIRED` | const | `crates/dstu-llm/src/llm_manager/routing.rs:196` | L03-chat-pipeline 4/0 | `pub const LLM_ERROR_CODE_COMPACTION_REQUIRED: &str = "COMPACTION_REQUIRED"` |
| `dstu_llm::llm_manager::routing::ParamOverrides` | struct | `crates/dstu-llm/src/llm_manager/routing.rs:464` | L03-chat-pipeline 4/0 | `pub struct ParamOverrides` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | `crates/dstu-llm/src/llm_manager/mod.rs:4752` | L17-memory-research 1/0<br>L18-media-docs 1/0<br>F2-shell 1/0<br>L03-chat-pipeline 0/6<br>L16-anki 0/5<br>L14-qbank 0/5<br>L22-app-commands 0/3 | `pub fn new(db: Arc<Database>, file_manager: Arc<FileManager>) -> Result<Self>` |
| `dstu_llm::llm_manager::transient_messages::is_transient_skill_message` | fn | `crates/dstu-llm/src/llm_manager/transient_messages.rs:9` | L03-chat-pipeline 3/13 | `pub fn is_transient_skill_message(msg: &LegacyChatMessage) -> bool` |
| `dstu_llm::llm_manager::compaction_budget::TRIGGER_RATIO` | const | `crates/dstu-llm/src/llm_manager/compaction_budget.rs:4` | L03-chat-pipeline 3/2 | `pub const TRIGGER_RATIO: f64 = 0.85` |
| `dstu_llm::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static` | method | `crates/dstu-llm/src/llm_manager/adapters/zhipu.rs:42` | L18-media-docs 3/0 | `pub fn supports_thinking_static(model: &str) -> bool` |
| `dstu_llm::llm_manager::is_discontinued_ocr_model` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:3299` | L18-media-docs 3/0 | `pub fn is_discontinued_ocr_model(config: &ApiConfig) -> bool` |
| `dstu_llm::llm_manager::LLMStreamHooks` | trait | `crates/dstu-llm/src/llm_manager/mod.rs:4358` | L03-chat-pipeline 2/0<br>L05-agent-workspace 1/0 | `pub trait LLMStreamHooks: Send + Sync` |
| `dstu_llm::llm_manager::model2_pipeline::COMPACTION_CHECKED_CONTEXT_KEY` | const | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:58` | L03-chat-pipeline 3/0 | `pub const COMPACTION_CHECKED_CONTEXT_KEY: &str = "chat_v2_compaction_checked"` |
| `dstu_llm::llm_manager::NoopStreamSink` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:137` | L03-chat-pipeline 3/0 | `pub struct NoopStreamSink` |
| `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED` | const | `crates/dstu-llm/src/llm_manager/routing.rs:193` | L03-chat-pipeline 2/0<br>L14-qbank 1/0 | `pub const LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED: &str = "CONTEXT_WINDOW_EXCEEDED"` |
| `dstu_llm::llm_manager::StreamEventSink` | trait | `crates/dstu-llm/src/llm_manager/mod.rs:103` | L03-chat-pipeline 3/0 | `pub trait StreamEventSink: Send + Sync` |
| `dstu_llm::llm_manager::WindowStreamSink::new` | method | `crates/dstu-llm/src/llm_manager/mod.rs:119` | L03-chat-pipeline 3/0 | `pub fn new(window: Window) -> Self` |
| `dstu_llm::llm_manager::LLMManager::apply_reasoning_config` | method | `crates/dstu-llm/src/llm_manager/mod.rs:4871` | L14-qbank 1/0<br>L22-app-commands 1/0<br>L01-llm-providers 0/8 | `pub fn apply_reasoning_config( body: &mut Value, config: &ApiConfig, enable_thinking: Option<bool>, )` |
| `dstu_llm::llm_manager::MAX_OCR_CONCURRENCY` | const | `crates/dstu-llm/src/llm_manager/mod.rs:87` | L12-vfs-index 2/4 | `pub const MAX_OCR_CONCURRENCY: usize = 4` |
| `dstu_llm::llm_manager::ModelProfile` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:3629` | L22-app-commands 2/2<br>L14-qbank 0/2 | `pub struct ModelProfile` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor` | struct | `src/chat_v2/tools/settings_models_executor.rs:118` | F1-kernel 1/2<br>L13-vfs-api 1/0<br>L22-app-commands 0/1 | `pub struct SettingsModelsToolExecutor` |
| `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor` | struct | `src/chat_v2/tools/translation_executor.rs:938` | F1-kernel 1/1<br>L13-vfs-api 1/0 | `pub struct TranslationToolExecutor` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager::new` ? | method | `crates/dstu-tutor/src/essay_grading/custom_modes.rs:43` | L14-qbank 1/1<br>F2-shell 1/0 | `pub fn new(data_dir: &Path) -> Self` |
| `dstu_llm::anki_model_routing::parse_routing_mode` | fn | `crates/dstu-llm/src/anki_model_routing.rs:93` | L16-anki 2/0 | `pub fn parse_routing_mode(options_json: &str) -> RoutingMode` |
| `dstu_llm::anki_model_routing::RoutingMode` | enum | `crates/dstu-llm/src/anki_model_routing.rs:70` | L24-chatanki 2/0 | `pub enum RoutingMode` |
| `dstu_llm::llm_manager::adapters::anthropic::claude_generation` | fn | `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs:109` | L01-llm-providers 2/0 | `pub fn claude_generation(model: &str) -> ClaudeGeneration` |
| `dstu_llm::llm_manager::AUTH_MODE_NONE` | const | `crates/dstu-llm/src/llm_manager/mod.rs:241` | L22-app-commands 2/0 | `pub const AUTH_MODE_NONE: &str = "none"` |
| `dstu_llm::llm_manager::effective_api_protocol_for_config` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:3989` | L03-chat-pipeline 2/0 | `pub fn effective_api_protocol_for_config(config: &ApiConfig) -> String` |
| `dstu_llm::llm_manager::effective_max_tokens` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:4082` | L16-anki 1/0<br>L14-qbank 1/0 | `pub fn effective_max_tokens(max_output_tokens: u32, max_tokens_limit: Option<u32>) -> u32` |
| `dstu_llm::llm_manager::opencode_go::VENDOR_ID` | const | `crates/dstu-llm/src/llm_manager/opencode_go.rs:25` | L22-app-commands 2/0 | `pub const VENDOR_ID: &str = "builtin-opencode-go"` |
| `dstu_llm::llm_manager::single_shot_stream::SingleShotOptions::new` | method | `crates/dstu-llm/src/llm_manager/single_shot_stream.rs:91` | L18-media-docs 2/0 | `pub fn new(label: impl Into<String>) -> Self` |
| `dstu_llm::llm_manager::web_search_fallback::WebSearchFallbackRequest` | struct | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:30` | L19-mcp-browser 2/0 | `pub struct WebSearchFallbackRequest<'a>` |
| `dstu_llm::llm_manager::web_search_fallback::WebSearchToolResult` | type | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:20` | L19-mcp-browser 2/0 | `pub type WebSearchToolResult = ( bool, Option<Value>, Option<String>, Option<Value>, Option<Vec<RagSourceInfo>>, Option<String>, )` |
| `dstu_llm::llm_manager::WindowStreamSink` | struct | `crates/dstu-llm/src/llm_manager/mod.rs:114` | L03-chat-pipeline 2/0 | `pub struct WindowStreamSink` |
| `dstu_tutor::essay_grading::custom_modes::CustomModeManager` ? | struct | `crates/dstu-tutor/src/essay_grading/custom_modes.rs:36` | L14-qbank 1/0<br>L22-app-commands 1/0 | `pub struct CustomModeManager` |
| `dstu_tutor::essay_grading::types::GradingRequest` ? | struct | `crates/dstu-tutor/src/essay_grading/types.rs:74` | L14-qbank 1/0<br>L15-review-analytics 1/0 | `pub struct GradingRequest` |
| `dstu_tutor::essay_grading::types::GradingRoundResponse` | struct | `crates/dstu-tutor/src/essay_grading/types.rs:155` | L15-review-analytics 2/0 | `pub struct GradingRoundResponse` |
| `dstu_llm::llm_manager::AUTH_MODE_OPENAI_CODEX_OAUTH` | const | `crates/dstu-llm/src/llm_manager/mod.rs:242` | L22-app-commands 1/7 | `pub const AUTH_MODE_OPENAI_CODEX_OAUTH: &str = "openai_codex_oauth"` |
| `dstu_llm::anki_model_routing::RoleDecision` | struct | `crates/dstu-llm/src/anki_model_routing.rs:209` | L16-anki 1/2 | `pub struct RoleDecision` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor::new` | method | `src/chat_v2/tools/settings_models_executor.rs:121` | F1-kernel 1/0<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_llm::llm_manager::model2_pipeline::apply_generation_params` | fn | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs:727` | L22-app-commands 1/0<br>L01-llm-providers 0/1 | `pub fn apply_generation_params(body: &mut Value, config: &ApiConfig, quirks: &ProviderQuirks)` |
| `dstu_llm::llm_manager::provider_quirks::resolve_quirks` | fn | `crates/dstu-llm/src/llm_manager/provider_quirks.rs:120` | L22-app-commands 1/0<br>L01-llm-providers 0/1 | `pub fn resolve_quirks(config: &ApiConfig) -> ProviderQuirks` |
| `dstu_llm::llm_manager::transient_messages::is_transient_llm_only_message` | fn | `crates/dstu-llm/src/llm_manager/transient_messages.rs:19` | L03-chat-pipeline 1/1 | `pub fn is_transient_llm_only_message(msg: &LegacyChatMessage) -> bool` |
| `dstu_tutor::essay_grading::custom_modes::CreateModeInput` ? | struct | `crates/dstu-tutor/src/essay_grading/custom_modes.rs:571` | L15-review-analytics 1/0<br>L14-qbank 0/1 | `pub struct CreateModeInput` |
| `dstu_tutor::essay_grading::types::get_builtin_grading_modes` ? | fn | `crates/dstu-tutor/src/essay_grading/types.rs:426` | L14-qbank 1/1 | `pub fn get_builtin_grading_modes() -> Vec<GradingMode>` |
| `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor::new` | method | `src/chat_v2/tools/translation_executor.rs:941` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_llm::anki_model_routing::plan_routing` | fn | `crates/dstu-llm/src/anki_model_routing.rs:308` | L16-anki 1/0 | `pub fn plan_routing(mode: RoutingMode, slots: &AnkiRoutingSlots) -> Option<AnkiRoutingPlan>` |
| `dstu_llm::llm_manager::adapters::anthropic::map_budget_tokens_to_effort` | fn | `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs:161` | L01-llm-providers 1/0 | `pub fn map_budget_tokens_to_effort(budget: i32) -> &'static str` |
| `dstu_llm::llm_manager::IncrementalJsonArrayParser::new` | method | `crates/dstu-llm/src/llm_manager/mod.rs:3018` | L18-media-docs 1/0 | `pub fn new() -> Self` |
| `dstu_llm::llm_manager::looks_like_image_generation_model_id` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:3768` | L22-app-commands 1/0 | `pub fn looks_like_image_generation_model_id(model: &str) -> bool` |
| `dstu_llm::llm_manager::ocr_models::migrate_glm_ocr_models` | fn | `crates/dstu-llm/src/llm_manager/ocr_models.rs:35` | L18-media-docs 1/0 | `pub fn migrate_glm_ocr_models( models: &mut [OcrModelConfig], is_siliconflow: impl Fn(&str) -> bool, is_zhipu_official: impl Fn(&str) -> bool, ) -> bool` |
| `dstu_llm::llm_manager::ocr_models::migrate_paddle_ocr_models` | fn | `crates/dstu-llm/src/llm_manager/ocr_models.rs:11` | L18-media-docs 1/0 | `pub fn migrate_paddle_ocr_models(models: &mut [OcrModelConfig]) -> bool` |
| `dstu_llm::llm_manager::opencode_go::BUILTIN_MODELS` | const | `crates/dstu-llm/src/llm_manager/opencode_go.rs:155` | L22-app-commands 1/0 | `pub const BUILTIN_MODELS: &[GoBuiltinModel] = &[ go_model( "builtin-opencode-go-deepseek-v4.1-flash", "DeepSeek V4.1 Flash (Go)", "deepseek-v4.1-flash", CHAT, true, false, ), go_model( "builtin-opencode-go-deepseek-v4-pro", "DeepSeek V4 Pro (Go)", "deepseek-v4-pro", CHAT, false, false, ), go_model( "builtin-opencode...` |
| `dstu_llm::llm_manager::opencode_go::fetch_usage` | fn | `crates/dstu-llm/src/llm_manager/opencode_go.rs:390` | L22-app-commands 1/0 | `pub async fn fetch_usage( client: &Client, api_key: &str, ) -> Result<OpenCodeGoUsage, OpenCodeGoUsageError>` |
| `dstu_llm::llm_manager::opencode_go::is_opencode_go_config` | fn | `crates/dstu-llm/src/llm_manager/opencode_go.rs:69` | L22-app-commands 1/0 | `pub fn is_opencode_go_config(config: &ApiConfig) -> bool` |
| `dstu_llm::llm_manager::opencode_go::OpenCodeGoUsage` | struct | `crates/dstu-llm/src/llm_manager/opencode_go.rs:287` | L22-app-commands 1/0 | `pub struct OpenCodeGoUsage` |
| `dstu_llm::llm_manager::opencode_go::PROVIDER_TYPE` | const | `crates/dstu-llm/src/llm_manager/opencode_go.rs:26` | L22-app-commands 1/0 | `pub const PROVIDER_TYPE: &str = "opencode_go"` |
| `dstu_llm::llm_manager::opencode_go::usage_client` | fn | `crates/dstu-llm/src/llm_manager/opencode_go.rs:423` | L22-app-commands 1/0 | `pub fn usage_client() -> Result<Client, OpenCodeGoUsageError>` |
| `dstu_llm::llm_manager::request_adapter_for_config` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:4054` | L22-app-commands 1/0 | `pub fn request_adapter_for_config(config: &ApiConfig) -> &'static dyn adapters::RequestAdapter` |
| `dstu_llm::llm_manager::routing::provider_body_indicates_context_window` | fn | `crates/dstu-llm/src/llm_manager/routing.rs:218` | L14-qbank 1/0 | `pub fn provider_body_indicates_context_window(body: &str) -> bool` |
| `dstu_llm::llm_manager::set_app_handle` | fn | `crates/dstu-llm/src/llm_manager/mod.rs:33` | F2-shell 1/0 | `pub fn set_app_handle(handle: tauri::AppHandle)` |
| `dstu_llm::llm_manager::single_shot_stream::is_retryable_http_status` | fn | `crates/dstu-llm/src/llm_manager/single_shot_stream.rs:204` | L18-media-docs 1/0 | `pub fn is_retryable_http_status(status: u16) -> bool` |
| `dstu_llm::llm_manager::single_shot_stream::SingleShotOptions` | struct | `crates/dstu-llm/src/llm_manager/single_shot_stream.rs:75` | L18-media-docs 1/0 | `pub struct SingleShotOptions` |
| `dstu_llm::llm_manager::transient_messages::TRANSIENT_REQUEST_ANCHOR_METADATA_KIND` | const | `crates/dstu-llm/src/llm_manager/transient_messages.rs:7` | L03-chat-pipeline 1/0 | `pub const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND: &str = "request_context_anchor"` |
| `dstu_llm::llm_manager::transient_messages::TRANSIENT_SKILL_METADATA_KIND` | const | `crates/dstu-llm/src/llm_manager/transient_messages.rs:6` | L03-chat-pipeline 1/0 | `pub const TRANSIENT_SKILL_METADATA_KIND: &str = "skill_instruction"` |
| `dstu_llm::llm_manager::web_search_fallback::register_web_search_fallback` | fn | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:52` | L19-mcp-browser 1/0 | `pub fn register_web_search_fallback( fallback: Arc<dyn WebSearchFallback>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_llm::llm_manager::web_search_fallback::WebSearchFallback` | trait | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:39` | L19-mcp-browser 1/0 | `pub trait WebSearchFallback: Send + Sync` |
| `dstu_tutor::essay_grading::custom_modes::SaveBuiltinOverrideInput` ? | struct | `crates/dstu-tutor/src/essay_grading/custom_modes.rs:592` | L15-review-analytics 1/0 | `pub struct SaveBuiltinOverrideInput` |
| `dstu_tutor::essay_grading::custom_modes::UpdateModeInput` ? | struct | `crates/dstu-tutor/src/essay_grading/custom_modes.rs:581` | L15-review-analytics 1/0 | `pub struct UpdateModeInput` |
| `dstu_tutor::essay_grading::essay_grading_create_custom_mode` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:459` | L15-review-analytics 1/0 | `pub async fn essay_grading_create_custom_mode( input: custom_modes::CreateModeInput, state: EssayGradingState<'_>, ) -> Result<types::GradingMode, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_create_session` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:185` | L15-review-analytics 1/0 | `pub async fn essay_grading_create_session( title: String, essay_type: String, grade_level: String, custom_prompt: Option<String>, state: EssayGradingState<'_>, ) -> Result<VfsEssaySession, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_delete_custom_mode` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:487` | L15-review-analytics 1/0 | `pub async fn essay_grading_delete_custom_mode( mode_id: String, state: EssayGradingState<'_>, ) -> Result<(), AppError>` |
| `dstu_tutor::essay_grading::essay_grading_delete_session` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:246` | L15-review-analytics 1/0 | `pub async fn essay_grading_delete_session( session_id: String, state: EssayGradingState<'_>, ) -> Result<usize, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_latest_round_number` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:367` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_latest_round_number( session_id: String, state: EssayGradingState<'_>, ) -> Result<i32, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_mode` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:420` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_mode( mode_id: String, state: EssayGradingState<'_>, ) -> Result<Option<types::GradingMode>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_models` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:577` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_models( state: EssayGradingState<'_>, ) -> Result<Vec<ModelInfo>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_modes` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:379` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_modes( state: EssayGradingState<'_>, ) -> Result<Vec<types::GradingMode>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_round` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:337` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_round( session_id: String, round_number: i32, state: EssayGradingState<'_>, ) -> Result<Option<GradingRoundResponse>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_rounds` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:316` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_rounds( session_id: String, state: EssayGradingState<'_>, ) -> Result<Vec<GradingRoundResponse>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_get_session` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:209` | L15-review-analytics 1/0 | `pub async fn essay_grading_get_session( session_id: String, state: EssayGradingState<'_>, ) -> Result<Option<VfsEssaySession>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_has_builtin_override` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:553` | L15-review-analytics 1/0 | `pub async fn essay_grading_has_builtin_override( builtin_id: String, state: EssayGradingState<'_>, ) -> Result<bool, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_list_custom_modes` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:502` | L15-review-analytics 1/0 | `pub async fn essay_grading_list_custom_modes( state: EssayGradingState<'_>, ) -> Result<Vec<types::GradingMode>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_list_sessions` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:268` | L15-review-analytics 1/0 | `pub async fn essay_grading_list_sessions( offset: Option<u32>, limit: Option<u32>, query: Option<String>, state: EssayGradingState<'_>, ) -> Result<Vec<VfsEssaySession>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_reset_builtin_mode` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:531` | L15-review-analytics 1/0 | `pub async fn essay_grading_reset_builtin_mode( builtin_id: String, state: EssayGradingState<'_>, ) -> Result<types::GradingMode, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_save_builtin_override` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:511` | L15-review-analytics 1/0 | `pub async fn essay_grading_save_builtin_override( input: custom_modes::SaveBuiltinOverrideInput, state: EssayGradingState<'_>, ) -> Result<types::GradingMode, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_stream` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:136` | L15-review-analytics 1/0 | `pub async fn essay_grading_stream( request: GradingRequest, window: Window, state: EssayGradingState<'_>, ) -> Result<Option<GradingResponse>, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_toggle_favorite` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:302` | L15-review-analytics 1/0 | `pub async fn essay_grading_toggle_favorite( session_id: String, state: EssayGradingState<'_>, ) -> Result<bool, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_update_custom_mode` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:471` | L15-review-analytics 1/0 | `pub async fn essay_grading_update_custom_mode( input: custom_modes::UpdateModeInput, state: EssayGradingState<'_>, ) -> Result<types::GradingMode, AppError>` |
| `dstu_tutor::essay_grading::essay_grading_update_session` | fn | `crates/dstu-tutor/src/essay_grading/mod.rs:224` | L15-review-analytics 1/0 | `pub async fn essay_grading_update_session( session: VfsUpdateEssaySessionParams, state: EssayGradingState<'_>, ) -> Result<(), AppError>` |
| `dstu_tutor::essay_grading::events::GradingEventEmitter` ? | struct | `crates/dstu-tutor/src/essay_grading/events.rs:14` | L14-qbank 1/0 | `pub struct GradingEventEmitter` |
| `dstu_tutor::essay_grading::events::GradingEventEmitter::new` ? | method | `crates/dstu-tutor/src/essay_grading/events.rs:20` | L14-qbank 1/0 | `pub fn new(window: Window) -> Self` |
| `dstu_tutor::essay_grading::pipeline::GradingDeps` ? | struct | `crates/dstu-tutor/src/essay_grading/pipeline.rs:105` | L14-qbank 1/0 | `pub struct GradingDeps` |
| `dstu_tutor::essay_grading::pipeline::resolve_grading_mode` ? | fn | `crates/dstu-tutor/src/essay_grading/pipeline.rs:574` | L14-qbank 1/0 | `pub fn resolve_grading_mode( mode_id: &Option<String>, custom_modes: &[GradingMode], ) -> Result<GradingMode, AppError>` |
| `dstu_tutor::essay_grading::pipeline::run_grading` ? | fn | `crates/dstu-tutor/src/essay_grading/pipeline.rs:272` | L14-qbank 1/0 | `pub async fn run_grading( request: GradingRequest, deps: GradingDeps, ) -> Result<Option<GradingResponse>, AppError>` |
| `dstu_tutor::essay_grading::types::GradingResponse` | struct | `crates/dstu-tutor/src/essay_grading/types.rs:128` | L15-review-analytics 1/0 | `pub struct GradingResponse` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::MODEL_ASSIGNMENTS_CHANGED_EVENT` | const | `src/chat_v2/tools/settings_models_executor.rs:32` | L22-app-commands 0/1 | `pub const MODEL_ASSIGNMENTS_CHANGED_EVENT: &str = "chat_v2://model_assignments_changed"` |
| `dstu_llm::anki_model_routing::SlotKind` | enum | `crates/dstu-llm/src/anki_model_routing.rs:198` | L16-anki 0/1 | `pub enum SlotKind` |
| `dstu_llm::llm_manager::adapters::moonshot::normalize_tool_schemas_for_mfjs` | fn | `crates/dstu-llm/src/llm_manager/adapters/moonshot.rs:106` | L10-notes 0/1 | `pub fn normalize_tool_schemas_for_mfjs(tools: &mut [Value]) -> usize` |

### 引用点样例

- `dstu_llm::llm_manager::LLMManager` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:81`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs:330`；L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ocr.rs:47`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:31`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:40`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:468`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:221`, `crates/dstu-agent/src/chat_v2/pipeline.rs:297`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:1607`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:154`；L16-anki: `crates/dstu-anki/src/anki_critic.rs:910`, `crates/dstu-anki/src/enhanced_anki_service.rs:54`, `crates/dstu-anki/src/streaming_anki_service.rs:208`, `crates/dstu-anki/src/streaming_anki_service.rs:643`；L01-llm-providers: `crates/dstu-llm/src/multimodal/embedding_service.rs:150`, `crates/dstu-llm/src/multimodal/embedding_service.rs:156`, `crates/dstu-llm/src/multimodal/embedding_service.rs:164`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:3`；L19-mcp-browser: `crates/dstu-mcp/src/tools/mod.rs:44`；L18-media-docs: `crates/dstu-media/src/host.rs:19`, `crates/dstu-media/src/media/commands.rs:299`, `crates/dstu-media/src/media/commands.rs:330`, `crates/dstu-media/src/media/transcriber_hook.rs:144`；L17-memory-research: `crates/dstu-memory/src/memory/auto_extractor.rs:38`, `crates/dstu-memory/src/memory/auto_extractor.rs:42`, `crates/dstu-memory/src/memory/category_manager.rs:45`, `crates/dstu-memory/src/memory/category_manager.rs:49`；L14-qbank: `crates/dstu-qbank/src/qbank_generation/mod.rs:102`, `crates/dstu-qbank/src/qbank_generation/mod.rs:113`, `crates/dstu-qbank/src/qbank_generation/mod.rs:128`, `crates/dstu-qbank/src/qbank_generation/pipeline.rs:32`；L12-vfs-index: `crates/dstu-vfs/src/lance_vector_store.rs:3639`, `crates/dstu-vfs/src/lance_vector_store.rs:3660`, `crates/dstu-vfs/src/lance_vector_store.rs:3665`, `crates/dstu-vfs/src/vfs/embedding_service.rs:90`；L13-vfs-api: `crates/dstu-vfs/src/vfs/handlers.rs:2112`, `crates/dstu-vfs/src/vfs/handlers.rs:3158`, `crates/dstu-vfs/src/vfs/handlers.rs:3405`, `crates/dstu-vfs/src/vfs/handlers.rs:3501`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:7236`, `src/chat_v2/tools/chatanki_executor.rs:9648`, `src/chat_v2/tools/chatanki_executor.rs:9720`；L22-app-commands: `src/commands.rs:696`, `tests/dstu_canvas_executor_e2e.rs:46`, `tests/phase7_system_executor_e2e.rs:33`, `tests/phase8_9_executor_e2e.rs:32`；F2-shell: `src/lib.rs:3295`；F1-kernel: `src/plugins/types.rs:106`
- `dstu_tutor::essay_grading::types::GradingMode` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:154`, `src/chat_v2/tools/essay_grading_executor.rs:168`, `src/chat_v2/tools/essay_grading_executor.rs:174`, `src/chat_v2/tools/essay_grading_executor.rs:203`；L15-review-analytics: `src/essay_grading/mod.rs:139`, `src/essay_grading/mod.rs:148`, `src/essay_grading/mod.rs:161`, `src/essay_grading/mod.rs:170`
- `dstu_llm::llm_manager::OcrModelConfig` — L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:1407`, `crates/dstu-vision/src/vlm_grounding_service.rs:1420`, `src/cmd/ocr.rs:166`, `src/cmd/ocr.rs:251`
- `dstu_llm::llm_manager::ImagePayload` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ocr.rs:104`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:716`；L01-llm-providers: `crates/dstu-llm/src/multimodal/embedding_service.rs:587`；L12-vfs-index: `crates/dstu-vfs/src/vfs/unified_retriever.rs:1633`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1678`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9723`, `src/chat_v2/tools/chatanki_executor.rs:9942`, `src/chat_v2/tools/chatanki_executor.rs:9985`, `src/chat_v2/tools/chatanki_executor.rs:9996`；L18-media-docs: `src/cmd/handout.rs:113`
- `dstu_llm::llm_manager::OcrRuntimeCandidate` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:77`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs:81`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:21`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:227`；L12-vfs-index: `crates/dstu-vfs/src/vfs/unified_retriever.rs:1528`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1533`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1537`, `crates/dstu-vfs/src/vfs/unified_retriever.rs:1538`
- `dstu_llm::llm_manager::ocr_models::SYSTEM_OCR_CONFIG_ID` — L18-media-docs: `src/cmd/ocr.rs:209`, `src/cmd/ocr.rs:232`, `src/cmd/ocr.rs:248`, `src/cmd/ocr.rs:252`
- `dstu_llm::llm_manager::routing::llm_error_code` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1017`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1565`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1307`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1450`；L14-qbank: `crates/dstu-qbank/src/question_authoring_runner/plan.rs:168`
- `dstu_llm::llm_manager::VendorConfig` — L22-app-commands: `src/commands.rs:2194`, `src/commands.rs:2200`, `src/commands.rs:2788`, `src/commands.rs:2870`；L14-qbank: `tests/qbank_executor_e2e.rs:153`, `tests/qbank_executor_e2e.rs:161`
- `dstu_llm::llm_manager::build_provider_adapter` — L16-anki: `crates/dstu-anki/src/streaming_anki_service.rs:1332`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:1145`；L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:757`；L22-app-commands: `src/commands.rs:3581`, `src/commands.rs:3658`, `src/commands.rs:5616`
- `dstu_llm::llm_manager::parser::enhanced_clean_json_response` — L17-memory-research: `crates/dstu-memory/src/memory/auto_extractor.rs:299`, `crates/dstu-memory/src/memory/compaction_flush.rs:217`, `crates/dstu-memory/src/memory/evolution.rs:1151`, `crates/dstu-memory/src/memory/llm_decision.rs:225`
- `dstu_llm::anki_model_routing::AnkiModelRole` — L16-anki: `crates/dstu-anki/src/anki_critic.rs:959`, `crates/dstu-anki/src/anki_critic.rs:2067`, `crates/dstu-anki/src/streaming_anki_service.rs:966`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9659`, `src/chat_v2/tools/chatanki_executor.rs:9727`
- `dstu_llm::llm_manager::adapters::anthropic::ClaudeGeneration` — L01-llm-providers: `crates/dstu-llm/src/providers/mod.rs:1`, `crates/dstu-llm/src/providers/mod.rs:2392`, `crates/dstu-llm/src/providers/mod.rs:2663`, `crates/dstu-llm/src/providers/mod.rs:2675`
- `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_COMPACTION_REQUIRED` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1018`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1566`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1308`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1451`
- `dstu_llm::llm_manager::routing::ParamOverrides` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs:126`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1640`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:3376`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:3385`
- `dstu_llm::llm_manager::LLMManager::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:1291`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:2348`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs:1296`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:3900`；L16-anki: `crates/dstu-anki/src/enhanced_anki_service.rs:1185`, `crates/dstu-anki/src/enhanced_anki_service.rs:1274`, `crates/dstu-anki/src/enhanced_anki_service.rs:1378`, `crates/dstu-anki/src/streaming_anki_service.rs:3958`；L17-memory-research: `crates/dstu-memory/src/memory/mod.rs:108`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:1309`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs:52`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs:165`, `crates/dstu-qbank/src/question_authoring_runner/tests.rs:295`；L18-media-docs: `crates/dstu-vision/src/exam_sheet_service.rs:83`；F2-shell: `src/lib.rs:3530`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:61`, `tests/phase7_system_executor_e2e.rs:52`, `tests/phase8_9_executor_e2e.rs:60`
- `dstu_llm::llm_manager::transient_messages::is_transient_skill_message` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs:279`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:846`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:925`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:1636`
- `dstu_llm::llm_manager::compaction_budget::TRIGGER_RATIO` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:38`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs:91`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs:128`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs:241`
- `dstu_llm::llm_manager::adapters::zhipu::ZhipuAdapter::supports_thinking_static` — L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:433`, `crates/dstu-vision/src/vlm_grounding_service.rs:558`, `crates/dstu-vision/src/vlm_grounding_service.rs:745`
- `dstu_llm::llm_manager::is_discontinued_ocr_model` — L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:1383`, `src/cmd/ocr.rs:228`, `src/cmd/ocr.rs:490`
- `dstu_llm::llm_manager::LLMStreamHooks` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs:361`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:32`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs:546`
- `dstu_llm::llm_manager::model2_pipeline::COMPACTION_CHECKED_CONTEXT_KEY` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:947`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1464`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:813`
- `dstu_llm::llm_manager::NoopStreamSink` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:938`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1458`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1204`
- `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1484`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1750`；L14-qbank: `crates/dstu-qbank/src/question_authoring_runner/plan.rs:169`
- `dstu_llm::llm_manager::StreamEventSink` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:939`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1459`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1205`
- `dstu_llm::llm_manager::WindowStreamSink::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:937`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1457`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1203`
- `dstu_llm::llm_manager::LLMManager::apply_reasoning_config` — L01-llm-providers: `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:118`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:310`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:345`, `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:375`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/pipeline.rs:1143`；L22-app-commands: `src/commands.rs:2422`
- `dstu_llm::llm_manager::MAX_OCR_CONCURRENCY` — L12-vfs-index: `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:618`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3817`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:4398`, `crates/dstu-vfs/src/vfs/pdf_processing_service.rs:4401`
- `dstu_llm::llm_manager::ModelProfile` — L22-app-commands: `src/commands.rs:2207`, `src/commands.rs:2213`, `tests/phase7_system_executor_e2e.rs:67`, `tests/phase7_system_executor_e2e.rs:76`；L14-qbank: `tests/qbank_executor_e2e.rs:163`, `tests/qbank_executor_e2e.rs:173`
- `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:80`, `src/agent_wiring/tests/headless_tests.rs:26`；L13-vfs-api: `src/chat_v2/tools/mod.rs:78`；L22-app-commands: `tests/phase7_system_executor_e2e.rs:8`
- `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:79`；L13-vfs-api: `src/chat_v2/tools/mod.rs:81`
- `dstu_tutor::essay_grading::custom_modes::CustomModeManager::new` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:165`, `src/chat_v2/tools/essay_grading_executor.rs:1041`；F2-shell: `src/lib.rs:3591`
- `dstu_llm::anki_model_routing::parse_routing_mode` — L16-anki: `crates/dstu-anki/src/anki_critic.rs:956`, `crates/dstu-anki/src/streaming_anki_service.rs:962`
- `dstu_llm::anki_model_routing::RoutingMode` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:9660`, `src/chat_v2/tools/chatanki_executor.rs:9728`
- `dstu_llm::llm_manager::adapters::anthropic::claude_generation` — L01-llm-providers: `crates/dstu-llm/src/providers/mod.rs:2391`, `crates/dstu-llm/src/providers/mod.rs:2655`
- `dstu_llm::llm_manager::AUTH_MODE_NONE` — L22-app-commands: `src/commands.rs:3135`, `src/commands.rs:3384`
- `dstu_llm::llm_manager::effective_api_protocol_for_config` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1636`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:1679`
- `dstu_llm::llm_manager::effective_max_tokens` — L16-anki: `crates/dstu-anki/src/streaming_anki_service.rs:783`；L14-qbank: `crates/dstu-qbank/src/qbank_grading/stream.rs:25`
- `dstu_llm::llm_manager::opencode_go::VENDOR_ID` — L22-app-commands: `src/commands.rs:3117`, `src/commands.rs:3317`
- `dstu_llm::llm_manager::single_shot_stream::SingleShotOptions::new` — L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:448`, `crates/dstu-vision/src/vlm_grounding_service.rs:571`
- `dstu_llm::llm_manager::web_search_fallback::WebSearchFallbackRequest` — L19-mcp-browser: `crates/dstu-mcp/src/tools/mod.rs:657`, `crates/dstu-mcp/src/tools/mod.rs:671`
- `dstu_llm::llm_manager::web_search_fallback::WebSearchToolResult` — L19-mcp-browser: `crates/dstu-mcp/src/tools/mod.rs:661`, `crates/dstu-mcp/src/tools/mod.rs:675`
- `dstu_llm::llm_manager::WindowStreamSink` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:2`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:58`
- `dstu_tutor::essay_grading::custom_modes::CustomModeManager` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:44`；L22-app-commands: `src/commands.rs:689`
- `dstu_tutor::essay_grading::types::GradingRequest` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:383`；L15-review-analytics: `src/essay_grading/mod.rs:29`
- `dstu_tutor::essay_grading::types::GradingRoundResponse` — L15-review-analytics: `src/essay_grading/mod.rs:112`, `src/essay_grading/mod.rs:122`
- `dstu_llm::llm_manager::AUTH_MODE_OPENAI_CODEX_OAUTH` — L22-app-commands: `src/commands.rs:2884`, `src/commands.rs:5908`, `src/commands.rs:5927`, `src/commands.rs:5936`
- `dstu_llm::anki_model_routing::RoleDecision` — L16-anki: `crates/dstu-anki/src/anki_critic.rs:314`, `crates/dstu-anki/src/anki_critic.rs:2065`, `crates/dstu-anki/src/anki_critic.rs:2066`
- `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:68`；L22-app-commands: `tests/phase7_system_executor_e2e.rs:208`
- `dstu_llm::llm_manager::model2_pipeline::apply_generation_params` — L01-llm-providers: `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:119`；L22-app-commands: `src/commands.rs:2423`
- `dstu_llm::llm_manager::provider_quirks::resolve_quirks` — L01-llm-providers: `crates/dstu-llm/src/providers/deepseek_harness_tests.rs:119`；L22-app-commands: `src/commands.rs:2416`
- `dstu_llm::llm_manager::transient_messages::is_transient_llm_only_message` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:58`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:1649`
- `dstu_tutor::essay_grading::custom_modes::CreateModeInput` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:1043`；L15-review-analytics: `src/essay_grading/mod.rs:159`
- `dstu_tutor::essay_grading::types::get_builtin_grading_modes` — L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:175`, `src/chat_v2/tools/essay_grading_executor.rs:1064`
- `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:67`
- `dstu_llm::anki_model_routing::plan_routing` — L16-anki: `crates/dstu-anki/src/streaming_anki_service.rs:964`
- `dstu_llm::llm_manager::adapters::anthropic::map_budget_tokens_to_effort` — L01-llm-providers: `crates/dstu-llm/src/providers/mod.rs:2403`
- `dstu_llm::llm_manager::IncrementalJsonArrayParser::new` — L18-media-docs: `crates/dstu-vision/src/vlm_grounding_service.rs:852`
- `dstu_llm::llm_manager::looks_like_image_generation_model_id` — L22-app-commands: `src/commands.rs:2306`
- `dstu_llm::llm_manager::ocr_models::migrate_glm_ocr_models` — L18-media-docs: `src/cmd/ocr.rs:197`
- `dstu_llm::llm_manager::ocr_models::migrate_paddle_ocr_models` — L18-media-docs: `src/cmd/ocr.rs:170`
- 其余 46 个条目的引用点见 `draft.json`。

## 消费其他 lane

### F4-security（66 个条目，prod 823 / test 482）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::llm_config::ApiConfig` ? | struct | 205/443 | `crates/dstu-llm/src/anki_model_routing.rs`, `crates/dstu-llm/src/config_recovery.rs`, `crates/dstu-llm/src/llm_manager/adapters/anthropic.rs` 等 32 个 |
| `dstu_core::models::AppError::llm` ? | method | 108/6 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 10 个 |
| `dstu_core::models::AppError::configuration` ? | method | 96/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 7 个 |
| `dstu_core::models::AppError` | struct | 88/6 | `crates/dstu-llm/src/llm_manager/adapters/deepseek.rs`, `crates/dstu-llm/src/llm_manager/adapters/mod.rs`, `crates/dstu-llm/src/llm_manager/exam_engine.rs` 等 22 个 |
| `dstu_core::models::AppError::validation` | method | 33/0 | `crates/dstu-llm/src/llm_manager/adapters/deepseek.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 9 个 |
| `dstu_core::models::AppError::network` ? | method | 27/1 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/rag_extension.rs` 等 4 个 |
| `dstu_core::models::StandardModel2Output` | struct | 26/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::models::AppError::database` | method | 24/0 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/routing.rs`, `crates/dstu-tutor/src/essay_grading/mod.rs` 等 5 个 |
| `dstu_core::models::ChatMessage` | struct | 15/4 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/transient_messages.rs` |
| `dstu_core::token_source::TokenSource` ? | enum | 13/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_core::models::AppErrorType` | enum | 12/3 | `crates/dstu-llm/src/llm_manager/question_authoring.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_core::models::ToolCall` | struct | 12/1 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::models::ModelAssignments` | struct | 11/10 | `crates/dstu-llm/src/anki_model_routing.rs`, `crates/dstu-llm/src/config_recovery.rs`, `crates/dstu-llm/src/llm_manager/mod.rs` 等 5 个 |
| `dstu_core::models::AppError::with_details` ? | method | 11/1 | `crates/dstu-llm/src/llm_manager/question_authoring.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 8/0 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_util::utils::token_budget::estimate_tokens` | fn | 8/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_platform::debug_log_service::redact_sensitive_text` | fn | 7/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` |
| `dstu_core::models::AppError::file_system` ? | method | 6/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs` |
| `dstu_core::models::AppError::internal` | method | 6/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::new` | method | 5/2 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` 等 4 个 |
| `dstu_core::agent::ToolCall` ? | struct | 5/1 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_core::llm_config::default_model_adapter` | fn | 5/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::models::ExamCardBBox` | struct | 5/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::models::StreamChunk` | struct | 5/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::prompt_contracts::LATEX_OUTPUT_BRIEF` | const | 5/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_core::json_validator::Stage` | enum | 4/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_core::models::AnkiCard` | struct | 4/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer::check_done_marker` | method | 4/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` 等 4 个 |
| `dstu_core::models::MultimodalContentPart` | enum | 3/1 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::json_validator::validate` | fn | 3/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_core::llm_config::default_gemini_api_version` | fn | 3/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::llm_config::default_max_output_tokens` | fn | 3/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::llm_config::default_temperature` | fn | 3/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::models::AppError::not_found` | method | 3/0 | `crates/dstu-tutor/src/essay_grading/mod.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenStreamFilter::new` ? | method | 3/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs`, `crates/dstu-tutor/src/translation/pipeline.rs` |
| `dstu_util::utils::text::safe_truncate_chars` ? | fn | 3/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 2/2 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 2/0 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 2/0 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_core::canonical_tools::ApiNameSource` | enum | 2/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::models::ChatMetadata` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::models::RetrievedChunk` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_platform::background_tasks::BACKGROUND_TASKS` | static | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs` |
| `dstu_platform::debug_log_service::write_debug_log_entry` | fn | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_platform::debug_logger::get_global_logger` | fn | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_security::crypto::CryptoService::is_encrypted_format` | method | 2/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenPolicy::for_provider_model` | method | 2/0 | `crates/dstu-tutor/src/essay_grading/pipeline.rs`, `crates/dstu-tutor/src/translation/pipeline.rs` |
| `dstu_util::utils::sse_buffer::SseEventBuffer` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` |
| `dstu_core::canonical_tools::build_openai_function_tool_schema` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::canonical_tools::CanonicalExternalTool` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::canonical_tools::CanonicalExternalToolConfig` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::canonical_tools::prepare_external_tool` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_core::models::AnkiGenerationOptions` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_core::models::RagSourceInfo` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` |
| `dstu_core::models::ToolResult` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_core::prompt_contracts::LATEX_OUTPUT_BRIEF_EN` | const | 1/0 | `crates/dstu-translation-core/src/prompts.rs` |
| `dstu_platform::debug_log_service::DebugFilterLevel` | enum | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_platform::debug_log_service::ensure_debug_log_dir` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_platform::debug_log_service::sanitize_for_level` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_security::crypto::CryptoService` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_security::crypto::CryptoService::new` | method | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_security::crypto::EncryptedData` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenPolicy` ? | enum | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_util::utils::sse_buffer::extract_stream_data_payload` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |

### L01-llm-providers（37 个条目，prod 101 / test 31）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::providers::StreamEvent` | enum | 21/10 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` 等 5 个 |
| `dstu_llm::providers::ProviderAdapter` | trait | 20/2 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 6 个 |
| `dstu_llm::ocr_adapters::types::OcrEngineType` ? | enum | 9/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::multimodal::types::MultimodalInput` | struct | 5/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::ocr_adapters::types::OcrTaskType` ? | enum | 3/4 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::ocr_adapters::system_ocr::is_platform_supported` | fn | 3/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::providers::OpenAIAdapter::new` | method | 2/4 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 4 个 |
| `dstu_llm::providers::AnthropicAdapter::new` | method | 2/3 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::providers::GeminiAdapter::new` | method | 2/3 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::adapters::gemini_openai_converter::convert_gemini_nonstream_response_to_openai` | fn | 2/0 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::create` | method | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` | method | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs` |
| `dstu_llm::ocr_adapters::system_ocr::perform_system_ocr` | fn | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs` |
| `dstu_llm::ocr_adapters::types::OcrMode` ? | enum | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::ocr_adapters::types::OcrRegion` ? | struct | 2/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::openai_codex::manager::CodexAuthManager` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::openai_codex::protocol::codex_sse_to_responses_json` | fn | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` |
| `dstu_llm::openai_codex::types::CodexRequestAuth` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::providers::ProviderRequest` | struct | 1/1 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::multimodal::embedding_chunker::batch_chunk_texts` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::multimodal::embedding_chunker::ChunkAggregation` | enum | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::aggregate_embeddings` | method | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingChunker::new` | method | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::multimodal::embedding_chunker::EmbeddingTokenLimits` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::multimodal::types::VLRerankerResult` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_llm::ocr_adapters::OcrAdapter` | trait | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::ocr_adapters::types::OcrPageResult` ? | struct | 1/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs` |
| `dstu_llm::openai_codex::manager::CodexAuthManager::new` | method | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::openai_codex::protocol::build_codex_request_headers` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::openai_codex::protocol::prepare_codex_responses_body` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_llm::providers::convert_anthropic_response_to_openai` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::providers::normalize_openai_nonstream_response` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::providers::OpenAIResponsesAdapter::new` | method | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::providers::ProviderError` | enum | 1/0 | `crates/dstu-llm/src/llm_manager/mod.rs` |
| `dstu_llm::providers::OpenAIAdapter` | struct | 0/2 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs`, `crates/dstu-llm/src/llm_manager/single_shot_stream.rs` |
| `dstu_llm::providers::AnthropicAdapter` | struct | 0/1 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs` |
| `dstu_llm::providers::GeminiAdapter` | struct | 0/1 | `crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs` |

### F3-storage（13 个条目，prod 38 / test 25）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 18/4 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_storage::database::Database` | struct | 7/2 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` 等 7 个 |
| `dstu_storage::llm_usage::record_llm_usage_ext` | fn | 5/0 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/rag_extension.rs` |
| `dstu_storage::file_manager::FileManager` | struct | 3/2 | `crates/dstu-llm/src/llm_manager/exam_engine.rs`, `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` 等 4 个 |
| `dstu_storage::llm_usage::UsageStreamIdentity` | struct | 2/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_storage::llm_usage::cache_debug_enabled` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_storage::llm_usage::record_llm_usage_cache_ext` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_storage::llm_usage::record_llm_usage_cache_ext_with_identity` | fn | 1/0 | `crates/dstu-llm/src/llm_manager/model2_pipeline.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/6 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/question_authoring.rs` 等 6 个 |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/5 | `crates/dstu-llm/src/llm_manager/mod.rs`, `crates/dstu-llm/src/llm_manager/model2_pipeline.rs`, `crates/dstu-llm/src/llm_manager/question_authoring.rs` 等 5 个 |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/3 | `tests/translation_executor_e2e.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/2 | `tests/translation_executor_e2e.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/1 | `tests/translation_executor_e2e.rs` |

### L13-vfs-api（17 个条目，prod 29 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 8/2 | `crates/dstu-tutor/src/essay_grading/mod.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs`, `crates/dstu-tutor/src/translation/mod.rs` 等 6 个 |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 7/0 | `crates/dstu-tutor/src/essay_grading/mod.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::types::VfsEssaySession` | struct | 4/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` | fn | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::translation_to_dstu_node` | fn | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent` | struct | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::types::VfsCreateEssayParams` | struct | 1/0 | `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_vfs::vfs::types::VfsCreateEssaySessionParams` | struct | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::types::VfsCreateTranslationParams` | struct | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::types::VfsEssay` | struct | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::types::VfsTranslation` | struct | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::types::VfsUpdateEssaySessionParams` | struct | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::database::setup_migrated_test_db` | fn | 0/1 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsFolder` ? | struct | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::types::VfsFolder::new` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |

### L11-vfs-repos（18 个条目，prod 17 / test 8）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo` | struct | 2/0 | `crates/dstu-tutor/src/essay_grading/mod.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_session` | method | 2/0 | `crates/dstu-tutor/src/essay_grading/mod.rs`, `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::list_sessions` | method | 2/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo` | struct | 1/1 | `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::create_essay` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/pipeline.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::create_session` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_essay_content` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_latest_round_number` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_round` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::get_rounds_by_session` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::purge_session` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::toggle_session_favorite` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::essay_repo::VfsEssayRepo::update_session` | method | 1/0 | `crates/dstu-tutor/src/essay_grading/mod.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::create_translation_in_folder` | method | 1/0 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_vfs::vfs::repos::translation_repo::VfsTranslationRepo::get_translation` ? | method | 0/3 | `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::get_folder_item_by_item_id` | method | 0/2 | `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::create_folder` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |

### F1-kernel（6 个条目，prod 17 / test 11）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 7/6 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 6/5 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 1/0 | `crates/dstu-llm/src/llm_manager/web_search_fallback.rs` |

### L04-chat-session（8 个条目，prod 16 / test 7）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 12/1 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 2/1 | `src/chat_v2/tools/settings_models_executor.rs`, `src/chat_v2/tools/translation_executor.rs`, `tests/translation_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::types::SETTINGS_CHANGED_EVENT` ? | const | 2/0 | `src/chat_v2/tools/settings_models_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 0/1 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry::from_vec` ? | method | 0/1 | `src/chat_v2/tools/translation_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |

### L22-app-commands（1 个条目，prod 7 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 7/0 | `src/cmd/translation.rs`, `src/translation/candidates.rs`, `src/translation/chat_popover.rs` 等 4 个 |

### L18-media-docs（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_media::voice_input::asr_provider_supported` ? | fn | 1/0 | `src/chat_v2/tools/settings_models_executor.rs` |
| `dstu_media::voice_input::is_asr_model` ? | fn | 1/0 | `src/chat_v2/tools/settings_models_executor.rs` |

### L07-agent-skills-ptc（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` ? | struct | 0/1 | `src/chat_v2/tools/translation_executor.rs` |

### L19-mcp-browser（3 个条目，prod 0 / test 9）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_browser::browser::service::assert_settings_gates_open` | fn | 0/7 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/1 | `tests/translation_executor_e2e.rs` |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/1 | `tests/translation_executor_e2e.rs` |

### L21-backup-governance（7 个条目，prod 0 / test 12）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::backup_job_manager::INCREMENTAL_BACKUP_DISABLED_MESSAGE` | const | 0/5 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobKind` | enum | 0/2 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobManager` | struct | 0/1 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobManager::new_for_tests` | method | 0/1 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobParams` | struct | 0/1 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobPhase` | enum | 0/1 | `tests/c1_cross_lang_consistency.rs` |
| `dstu_sync::backup_job_manager::BackupJobStatus` | enum | 0/1 | `tests/c1_cross_lang_consistency.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::translation::*` @ `src/commands.rs:53`
- 被 L15-review-analytics 导入：`use dstu_tutor::essay_grading::*` @ `src/essay_grading/mod.rs:8`
