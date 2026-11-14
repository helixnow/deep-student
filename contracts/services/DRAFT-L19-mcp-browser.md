# 跨 lane 服务草稿：L19-mcp-browser

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（38 个条目，其中 32 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_mcp::mcp::config::McpTransportConfig` | enum | `crates/dstu-mcp/src/mcp/config.rs:43` | F2-shell 6/0 | `pub enum McpTransportConfig` |
| `dstu_mcp::tools::ToolRegistry` | struct | `crates/dstu-mcp/src/tools/mod.rs:68` | L03-chat-pipeline 2/1<br>L04-chat-session 2/0<br>L07-agent-skills-ptc 1/2<br>L06-agent-orchestration 0/2<br>L13-vfs-api 0/2<br>L24-chatanki 0/1<br>L22-app-commands 0/8<br>L14-qbank 0/1<br>L02-llm-manager 0/1 | `pub struct ToolRegistry` |
| `dstu_mcp::mcp::config::McpConfig` | struct | `crates/dstu-mcp/src/mcp/config.rs:19` | L22-app-commands 3/0<br>F2-shell 2/0 | `pub struct McpConfig` |
| `dstu_mcp::mcp::client::Content` | enum | `crates/dstu-mcp/src/mcp/client.rs:266` | L05-agent-workspace 4/0 | `pub enum Content` |
| `dstu_mcp::mcp::config::McpFraming` | enum | `crates/dstu-mcp/src/mcp/config.rs:8` | F2-shell 4/0 | `pub enum McpFraming` |
| `dstu_mcp::tools::web_search::do_search` | fn | `crates/dstu-mcp/src/tools/web_search.rs:3165` | L13-vfs-api 2/0<br>L05-agent-workspace 1/0<br>L03-chat-pipeline 1/0 | `pub async fn do_search(cfg: &ToolConfig, mut input: SearchInput) -> ToolResult` |
| `dstu_mcp::tools::web_search::ToolConfig` ? | struct | `crates/dstu-mcp/src/tools/web_search.rs:878` | L03-chat-pipeline 2/0<br>L05-agent-workspace 1/0<br>L13-vfs-api 1/0 | `pub struct ToolConfig` |
| `dstu_mcp::tools::web_search::SearchInput` | struct | `crates/dstu-mcp/src/tools/web_search.rs:67` | L05-agent-workspace 1/0<br>L03-chat-pipeline 1/0<br>L13-vfs-api 1/0 | `pub struct SearchInput` |
| `dstu_mcp::tools::web_search::ToolConfig::from_env_and_file` ? | method | `crates/dstu-mcp/src/tools/web_search.rs:1283` | L05-agent-workspace 1/0<br>L03-chat-pipeline 1/0<br>L13-vfs-api 1/0 | `pub fn from_env_and_file() -> anyhow::Result<Self>` |
| `dstu_mcp::tools::ToolContext` | struct | `crates/dstu-mcp/src/tools/mod.rs:34` | L07-agent-skills-ptc 2/1<br>L22-app-commands 0/2 | `pub struct ToolContext<'a>` |
| `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor` | struct | `src/chat_v2/tools/index_webpage_executor.rs:54` | F1-kernel 1/2<br>L13-vfs-api 1/0 | `pub struct IndexWebpageToolExecutor` |
| `dstu_browser::browser::hooks::DownloadArtifactRoot` | trait | `crates/dstu-browser/src/browser/hooks.rs:17` | F1-kernel 2/0 | `pub trait DownloadArtifactRoot: Send + Sync` |
| `dstu_mcp::mcp::global::get_global_mcp_client` | fn | `crates/dstu-mcp/src/mcp/global.rs:27` | L05-agent-workspace 1/0<br>F2-shell 1/0 | `pub async fn get_global_mcp_client() -> Option<Arc<McpClient>>` |
| `dstu_mcp::tools::ToolRegistry::new_with` | method | `crates/dstu-mcp/src/tools/mod.rs:82` | F2-shell 1/0<br>L07-agent-skills-ptc 0/2<br>L24-chatanki 0/1<br>L22-app-commands 0/3 | `pub fn new_with(tools: Vec<Arc<dyn Tool>>) -> Self` |
| `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor` | struct | `src/chat_v2/tools/browser_executor.rs:76` | L13-vfs-api 1/0<br>F1-kernel 0/1 | `pub struct BrowserToolExecutor` |
| `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor::new` | method | `src/chat_v2/tools/index_webpage_executor.rs:64` | F1-kernel 1/1 | `pub fn new() -> Self` |
| `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor::new` | method | `src/chat_v2/tools/browser_executor.rs:79` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_browser::browser::database::BrowserDatabase::new` | method | `crates/dstu-browser/src/browser/database.rs:44` | F2-shell 1/0 | `pub fn new(active_dir: impl Into<PathBuf>) -> Self` |
| `dstu_browser::browser::hooks::register_download_artifact_root` | fn | `crates/dstu-browser/src/browser/hooks.rs:26` | F1-kernel 1/0 | `pub fn register_download_artifact_root( resolver: Arc<dyn DownloadArtifactRoot>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_browser::browser::service::BrowserService::boot_cleanup` | method | `crates/dstu-browser/src/browser/service.rs:237` | F2-shell 1/0 | `pub fn boot_cleanup(app: &AppHandle)` |
| `dstu_browser::browser::service::BrowserService::new` | method | `crates/dstu-browser/src/browser/service.rs:209` | F2-shell 1/0 | `pub fn new(app: AppHandle, db: Arc<BrowserDatabase>) -> Arc<Self>` |
| `dstu_mcp::mcp::client::McpEvent` ? | enum | `crates/dstu-mcp/src/mcp/client.rs:836` | F2-shell 1/0 | `pub enum McpEvent` |
| `dstu_mcp::mcp::client::ToolResult` | struct | `crates/dstu-mcp/src/mcp/client.rs:204` | L05-agent-workspace 1/0 | `pub struct ToolResult` |
| `dstu_mcp::mcp::global::initialize_global_mcp_client` | fn | `crates/dstu-mcp/src/mcp/global.rs:47` | F2-shell 1/0 | `pub async fn initialize_global_mcp_client(config: McpConfig) -> McpResult<()>` |
| `dstu_mcp::mcp::test_helpers::test_http` | fn | `crates/dstu-mcp/src/mcp/test_helpers.rs:115` | L07-agent-skills-ptc 1/0 | `pub async fn test_http( endpoint: String, api_key: Option<String>, headers: Option<HashMap<String, String>>, ) -> serde_json::Value` |
| `dstu_mcp::mcp::test_helpers::test_sse` | fn | `crates/dstu-mcp/src/mcp/test_helpers.rs:93` | L07-agent-skills-ptc 1/0 | `pub async fn test_sse( endpoint: String, api_key: Option<String>, headers: Option<HashMap<String, String>>, ) -> serde_json::Value` |
| `dstu_mcp::mcp::test_helpers::test_stdio` | fn | `crates/dstu-mcp/src/mcp/test_helpers.rs:38` | L07-agent-skills-ptc 1/0 | `pub async fn test_stdio( command: String, args: Vec<String>, env: Option<HashMap<String, String>>, cwd: Option<String>, framing: Option<String>, on_progress: &(dyn Fn(&str) + Send + Sync), ) -> serde_json::Value` |
| `dstu_mcp::mcp::test_helpers::test_streamable_http_rmcp` | fn | `crates/dstu-mcp/src/mcp/test_helpers.rs:137` | L07-agent-skills-ptc 1/0 | `pub async fn test_streamable_http_rmcp(url: String, api_key: Option<String>) -> serde_json::Value` |
| `dstu_mcp::mcp::test_helpers::test_websocket` | fn | `crates/dstu-mcp/src/mcp/test_helpers.rs:80` | L07-agent-skills-ptc 1/0 | `pub async fn test_websocket(url: String) -> serde_json::Value` |
| `dstu_mcp::tools::install_web_search_fallback` | fn | `crates/dstu-mcp/src/tools/mod.rs:630` | L03-chat-pipeline 1/0 | `pub fn install_web_search_fallback()` |
| `dstu_mcp::tools::provide_web_search_fallback` | fn | `crates/dstu-mcp/src/tools/mod.rs:645` | F1-kernel 1/0 | `pub fn provide_web_search_fallback() -> Result<dstu_kernel::Disposer, dstu_kernel::SlotOccupied>` |
| `dstu_mcp::tools::web_search::RagSourceInfo` | struct | `crates/dstu-mcp/src/tools/web_search.rs:88` | L05-agent-workspace 1/0 | `pub struct RagSourceInfo` |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | `crates/dstu-mcp/src/tools/mod.rs:98` | L03-chat-pipeline 0/5<br>L07-agent-skills-ptc 0/1<br>L06-agent-orchestration 0/3<br>L13-vfs-api 0/3<br>L24-chatanki 0/2<br>L14-qbank 0/4<br>L22-app-commands 0/8<br>L02-llm-manager 0/1 | `pub fn new() -> Self` |
| `dstu_browser::browser::service::assert_settings_gates_open` | fn | `crates/dstu-browser/src/browser/service.rs:2314` | L02-llm-manager 0/7 | `pub fn assert_settings_gates_open( workbench_raw: Option<&str>, browser_raw: Option<&str>, ) -> Result<(), &'static str>` |
| `dstu_mcp::tools::Tool` | trait | `crates/dstu-mcp/src/tools/mod.rs:48` | L07-agent-skills-ptc 0/2<br>L22-app-commands 0/3 | `pub trait Tool: Send + Sync` |
| `dstu_mcp::tools::WebSearchTool` | struct | `crates/dstu-mcp/src/tools/mod.rs:700` | L22-app-commands 0/4 | `pub struct WebSearchTool` |
| `dstu_mcp::tools::web_search::ProviderStrategies` | struct | `crates/dstu-mcp/src/tools/web_search.rs:427` | L22-app-commands 0/2 | `pub struct ProviderStrategies` |
| `dstu_mcp::tools::web_search::ProviderStrategy` | struct | `crates/dstu-mcp/src/tools/web_search.rs:380` | L22-app-commands 0/2 | `pub struct ProviderStrategy` |

### 引用点样例

- `dstu_mcp::mcp::config::McpTransportConfig` — F2-shell: `src/lib.rs:3937`, `src/lib.rs:3965`, `src/lib.rs:4010`, `src/lib.rs:4062`
- `dstu_mcp::tools::ToolRegistry` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:222`, `crates/dstu-agent/src/chat_v2/pipeline.rs:298`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:1608`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:1308`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:761`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:148`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:108`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:177`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs:550`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs:702`；L13-vfs-api: `src/chat_v2/tools/attachment_executor.rs:560`, `src/chat_v2/tools/generative_ui_executor.rs:502`；L24-chatanki: `tests/chatanki_apkg_executor_e2e.rs:10`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:13`, `tests/generative_ui_executor_e2e.rs:9`, `tests/phase5_tool_execution_e2e.rs:20`, `tests/phase7_system_executor_e2e.rs:20`；L14-qbank: `tests/qbank_executor_e2e.rs:15`；L02-llm-manager: `tests/translation_executor_e2e.rs:13`
- `dstu_mcp::mcp::config::McpConfig` — L22-app-commands: `src/commands.rs:7004`, `src/commands.rs:7017`, `src/commands.rs:7027`；F2-shell: `src/lib.rs:3870`, `src/lib.rs:3871`
- `dstu_mcp::mcp::client::Content` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:32`, `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:290`, `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:293`, `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:294`
- `dstu_mcp::mcp::config::McpFraming` — F2-shell: `src/lib.rs:3926`, `src/lib.rs:3928`, `src/lib.rs:4107`, `src/lib.rs:4108`
- `dstu_mcp::tools::web_search::do_search` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:421`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:47`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:729`, `src/chat_v2/tools/builtin_retrieval_executor.rs:736`
- `dstu_mcp::tools::web_search::ToolConfig` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:35`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:47`, `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs:401`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:33`
- `dstu_mcp::tools::web_search::SearchInput` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:404`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:47`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:711`
- `dstu_mcp::tools::web_search::ToolConfig::from_env_and_file` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:417`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs:396`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:666`
- `dstu_mcp::tools::ToolContext` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:787`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:1432`, `crates/dstu-agent/src/chat_v2/tools/general_executor.rs:86`；L22-app-commands: `tests/tools_integration_tests.rs:29`, `tests/tools_integration_tests.rs:30`
- `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor` — F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:90`, `src/agent_wiring/tests/headless_tests.rs:31`；L13-vfs-api: `src/chat_v2/tools/mod.rs:68`
- `dstu_browser::browser::hooks::DownloadArtifactRoot` — F1-kernel: `src/extensions.rs:174`, `src/extensions.rs:189`
- `dstu_mcp::mcp::global::get_global_mcp_client` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:149`；F2-shell: `src/lib.rs:3845`
- `dstu_mcp::tools::ToolRegistry::new_with` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:1369`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:2009`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:19401`；F2-shell: `src/lib.rs:1538`；L22-app-commands: `tests/tools_integration_tests.rs:48`, `tests/tools_integration_tests.rs:80`, `tests/tools_integration_tests.rs:200`
- `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor` — F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:67`；L13-vfs-api: `src/chat_v2/tools/mod.rs:55`
- `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:78`, `src/agent_wiring/tests/hooks_tests.rs:72`
- `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:55`
- `dstu_browser::browser::database::BrowserDatabase::new` — F2-shell: `src/lib.rs:1615`
- `dstu_browser::browser::hooks::register_download_artifact_root` — F1-kernel: `src/extensions.rs:176`
- `dstu_browser::browser::service::BrowserService::boot_cleanup` — F2-shell: `src/lib.rs:1620`
- `dstu_browser::browser::service::BrowserService::new` — F2-shell: `src/lib.rs:1619`
- `dstu_mcp::mcp::client::McpEvent` — F2-shell: `src/lib.rs:3848`
- `dstu_mcp::mcp::client::ToolResult` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:284`
- `dstu_mcp::mcp::global::initialize_global_mcp_client` — F2-shell: `src/lib.rs:3841`
- `dstu_mcp::mcp::test_helpers::test_http` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:182`
- `dstu_mcp::mcp::test_helpers::test_sse` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:174`
- `dstu_mcp::mcp::test_helpers::test_stdio` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:150`
- `dstu_mcp::mcp::test_helpers::test_streamable_http_rmcp` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:190`
- `dstu_mcp::mcp::test_helpers::test_websocket` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:166`
- `dstu_mcp::tools::install_web_search_fallback` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:302`
- `dstu_mcp::tools::provide_web_search_fallback` — F1-kernel: `src/extensions.rs:32`
- `dstu_mcp::tools::web_search::RagSourceInfo` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:491`
- `dstu_mcp::tools::ToolRegistry::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:1303`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:2394`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs:1304`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:4727`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:817`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs:816`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs:738`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs:767`；L13-vfs-api: `src/chat_v2/tools/attachment_executor.rs:601`, `src/chat_v2/tools/attachment_executor.rs:853`, `src/chat_v2/tools/generative_ui_executor.rs:514`；L24-chatanki: `src/chat_v2/tools/fsrs_settings_executor.rs:336`, `tests/chatanki_apkg_executor_e2e.rs:247`；L14-qbank: `src/chat_v2/tools/qbank_executor.rs:6158`, `src/chat_v2/tools/qbank_executor.rs:6277`, `src/chat_v2/tools/qbank_executor.rs:6300`, `tests/qbank_executor_e2e.rs:218`；L22-app-commands: `tests/dstu_canvas_executor_e2e.rs:117`, `tests/generative_ui_executor_e2e.rs:75`, `tests/phase5_tool_execution_e2e.rs:89`, `tests/phase7_system_executor_e2e.rs:123`；L02-llm-manager: `tests/translation_executor_e2e.rs:252`
- `dstu_browser::browser::service::assert_settings_gates_open` — L02-llm-manager: `tests/c1_cross_lang_consistency.rs:15`, `tests/c1_cross_lang_consistency.rs:16`, `tests/c1_cross_lang_consistency.rs:17`, `tests/c1_cross_lang_consistency.rs:22`
- `dstu_mcp::tools::Tool` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:1359`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:1420`；L22-app-commands: `tests/tools_integration_tests.rs:48`, `tests/tools_integration_tests.rs:80`, `tests/tools_integration_tests.rs:200`
- `dstu_mcp::tools::WebSearchTool` — L22-app-commands: `tests/tools_integration_tests.rs:48`, `tests/tools_integration_tests.rs:80`, `tests/tools_integration_tests.rs:124`, `tests/tools_integration_tests.rs:200`
- `dstu_mcp::tools::web_search::ProviderStrategies` — L22-app-commands: `tests/tools_integration_tests.rs:5`, `tests/tools_integration_tests.rs:150`
- `dstu_mcp::tools::web_search::ProviderStrategy` — L22-app-commands: `tests/tools_integration_tests.rs:5`, `tests/tools_integration_tests.rs:170`

## 消费其他 lane

### F4-security（47 个条目，prod 114 / test 29）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::internal` | method | 15/0 | `src/cmd/mcp.rs`, `src/cmd/web_search.rs` |
| `dstu_core::models::RagSourceInfo` | struct | 7/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::models::AppError::database` | method | 5/0 | `src/cmd/web_search.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 5/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::net_policy::is_internal_ip` | fn | 4/18 | `crates/dstu-browser/src/browser/mod.rs`, `crates/dstu-browser/src/browser/policy.rs`, `crates/dstu-browser/src/browser/window.rs` |
| `dstu_core::error_details::ErrorCode` | enum | 4/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::tool_not_found` | method | 4/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::models::AppError` | struct | 4/0 | `src/cmd/mcp.rs`, `src/cmd/web_search.rs` |
| `dstu_core::task_objects::TaskObjectKind` ? | enum | 4/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::net_policy::is_loopback_host` | fn | 3/9 | `crates/dstu-browser/src/browser/mod.rs`, `crates/dstu-browser/src/browser/policy.rs`, `crates/dstu-mcp/src/mcp/mod.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 3/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 2/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 2/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 2/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::APP_VERSION` | const | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `crates/dstu-mcp/src/mcp/test_helpers.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::network_error` | method | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::rate_limit_error` | method | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::tool_timeout` | method | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 2/0 | `src/cmd/web_search.rs` |
| `dstu_core::models::RetrievedChunk` | struct | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::net_policy::is_blocked_internal_ip` | fn | 2/0 | `crates/dstu-browser/src/browser/policy.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_core::task_objects::DerivedEdge` ? | struct | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::DerivedEdge::new` ? | method | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::hash_transform_params` ? | fn | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::ManagedLocator` ? | struct | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::ManagedLocator::new` ? | method | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::ObjectCapabilities` ? | struct | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder` ? | struct | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder::new` ? | method | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_core::tool_args::with_localized_message` ? | fn | 2/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_security::secure_store::SecureStore` ? | struct | 2/0 | `crates/dstu-mcp/src/mcp/auth.rs` |
| `dstu_security::secure_store::SecureStoreConfig` ? | struct | 2/0 | `crates/dstu-mcp/src/mcp/auth.rs` |
| `dstu_core::canonical_tools::decode_tool_name_from_api` | fn | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ActionSuggestion` | struct | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetails` | struct | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetails::new` | method | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::api_key_invalid` | method | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::api_key_missing` | method | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::ErrorDetailsBuilder::service_unavailable` | method | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::error_details::infer_error_code_from_message` | fn | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::models::DocumentChunk` | struct | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_core::net_policy::is_loopback_ip` | fn | 1/0 | `crates/dstu-browser/src/browser/policy.rs` |
| `dstu_core::task_objects::TaskObjectHandle` ? | struct | 1/0 | `crates/dstu-browser/src/browser/service.rs` |
| `dstu_security::secure_store::SecureStore::new_with_dir` ? | method | 1/0 | `crates/dstu-mcp/src/mcp/auth.rs` |
| `dstu_util::utils::sse_buffer::SseLineBuffer` | struct | 1/0 | `crates/dstu-mcp/src/mcp/sse_transport.rs` |
| `dstu_util::utils::sse_buffer::SseLineBuffer::new` | method | 1/0 | `crates/dstu-mcp/src/mcp/sse_transport.rs` |
| `dstu_core::canonical_tools::encode_tool_name_for_api` | fn | 0/2 | `crates/dstu-mcp/src/tools/mod.rs` |

### L22-app-commands（1 个条目，prod 35 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 35/0 | `src/chat_v2/tools/browser_executor.rs`, `src/cmd/mcp.rs`, `src/cmd/web_search.rs` |

### L04-chat-session（2 个条目，prod 24 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 22/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 2/0 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |

### L13-vfs-api（18 个条目，prod 24 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 5/1 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::types::VfsFile` ? | struct | 3/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService::new` ? | method | 2/1 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` | fn | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::file_to_dstu_node` | fn | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::restored` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::updated` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::index_service::VfsIndexService` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::types::VfsFolderItem` ? | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::types::VfsFolderItem::new` ? | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::types::VfsResource` ? | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::types::VfsResourceMetadata` ? | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::unit_builder::trait_def::UnitBuildInput` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::VECTOR_INDEX_AVAILABLE` | const | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::VECTOR_INDEX_UNAVAILABLE_MESSAGE` | const | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::database::VfsDatabase::new` | method | 0/1 | `src/chat_v2/tools/index_webpage_executor.rs` |

### F1-kernel（6 个条目，prod 21 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 9/13 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 5/2 | `src/chat_v2/tools/browser_executor.rs`, `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 3/0 | `crates/dstu-browser/src/browser/hooks.rs`, `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 2/0 | `crates/dstu-browser/src/browser/hooks.rs`, `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-browser/src/browser/hooks.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-browser/src/browser/hooks.rs` |

### L11-vfs-repos（18 个条目，prod 18 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file_with_conn` | method | 2/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo::get_index_state` ? | method | 1/1 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource` ? | method | 1/1 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::cleanup_blob_with_conn` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::decrement_ref_with_conn` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::blob_repo::VfsBlobRepo::store_blob_with_conn` ? | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::VfsIndexStateRepo` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::create_file_with_doc_data_in_folder` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_by_sha256_with_conn` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::add_item_to_folder_with_conn` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::folder_repo::VfsFolderRepo::folder_exists_with_conn` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::index_unit_repo::get_by_resource` | fn | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::exists` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file` ? | method | 0/1 | `src/chat_v2/tools/index_webpage_executor.rs` |

### F3-storage（5 个条目，prod 9 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 3/0 | `crates/dstu-browser/src/browser/service.rs`, `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_storage::feature_flags::FeatureFlagManager` | struct | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_storage::feature_flags::FeatureFlagManager::new` | method | 2/0 | `crates/dstu-browser/src/browser/service.rs`, `src/chat_v2/tools/browser_executor.rs` |
| `dstu_storage::data_space::get_data_space_manager` | fn | 1/0 | `crates/dstu-browser/src/browser/database.rs` |
| `dstu_storage::feature_flags::FeatureFlag` | struct | 1/0 | `src/cmd/web_search.rs` |

### L05-agent-workspace（4 个条目，prod 8 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootKind` ? | enum | 5/5 | `src/chat_v2/tools/browser_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 1/0 | `src/chat_v2/tools/browser_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` ? | fn | 1/0 | `src/chat_v2/tools/browser_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 1/0 | `src/chat_v2/tools/browser_executor.rs` |

### L02-llm-manager（5 个条目，prod 7 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::web_search_fallback::WebSearchFallbackRequest` | struct | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_llm::llm_manager::web_search_fallback::WebSearchToolResult` | type | 2/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_llm::llm_manager::LLMManager` | struct | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_llm::llm_manager::web_search_fallback::register_web_search_fallback` | fn | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |
| `dstu_llm::llm_manager::web_search_fallback::WebSearchFallback` | trait | 1/0 | `crates/dstu-mcp/src/tools/mod.rs` |

### L07-agent-skills-ptc（3 个条目，prod 5 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_allow_unapproved` ? | fn | 2/0 | `src/cmd/mcp.rs` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_tools_list` ? | fn | 2/0 | `src/cmd/mcp.rs` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::write_mcp_allow_unapproved` ? | fn | 1/0 | `src/cmd/mcp.rs` |

### L12-vfs-index（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::embedding_service::EmbeddingProgressCallback` | type | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService` | struct | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |
| `dstu_vfs::vfs::indexing::VfsFullIndexingService::new` | method | 1/0 | `src/chat_v2/tools/index_webpage_executor.rs` |

### L06-agent-orchestration（1 个条目，prod 0 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::headless::headless_allowed_tools` ? | fn | 0/1 | `src/chat_v2/tools/browser_executor.rs` |

## glob 导入（模块级，不确定具体条目）

- 被 L22-app-commands 导入：`use deep_student_lib::cmd::mcp::*` @ `src/commands.rs:49`
- 被 L22-app-commands 导入：`use deep_student_lib::cmd::web_search::*` @ `src/commands.rs:54`
