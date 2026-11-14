# 跨 lane 服务草稿：L07-agent-skills-ptc

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（72 个条目，其中 62 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_agent::chat_v2::tools::workbench_bridge::uncertain_apply_receipt` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:76` | L13-vfs-api 4/0<br>L10-notes 4/0 | `pub fn uncertain_apply_receipt( entity_ids: Vec<String>, op_labels: Vec<String>, error: &str, ) -> Value` |
| `dstu_agent::chat_v2::tools::workbench_bridge::acr_bridge_call` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:295` | L13-vfs-api 2/0<br>L10-notes 2/0<br>L04-chat-session 1/0 | `pub async fn acr_bridge_call( ctx: &ExecutionContext, command: &str, args: Value, timeout_ms: u64, ) -> Result<AcrBridgeResponse, String>` |
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs:127` | L04-chat-session 2/0<br>F1-kernel 1/1 | `pub struct SkillsExecutor` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_tools_list` ? | fn | `crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:39` | L19-mcp-browser 2/0<br>L06-agent-orchestration 1/0 | `pub fn read_mcp_tools_list(db: &Database) -> Result<Vec<Value>, String>` |
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::is_load_skills_tool` | method | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs:345` | L03-chat-pipeline 2/0<br>L04-chat-session 1/0 | `pub fn is_load_skills_tool(tool_name: &str) -> bool` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs:40` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0<br>F1-kernel 0/1<br>L02-llm-manager 0/1<br>L22-app-commands 0/4 | `pub struct GeneralToolExecutor` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs:85` | L04-chat-session 1/0<br>F1-kernel 1/2<br>L22-app-commands 0/1 | `pub struct LlmUsageToolExecutor` |
| `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs:564` | L04-chat-session 1/0<br>F1-kernel 1/2 | `pub struct FetchExecutor` |
| `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:220` | L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct McpProposeExecutor` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1654` | L03-chat-pipeline 1/0<br>F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1504` | L03-chat-pipeline 1/0<br>F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::skills::command_mentions_skills_directory` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:171` | L05-agent-workspace 2/0 | `pub(crate) fn command_mentions_skills_directory(command: &str) -> bool` |
| `dstu_agent::chat_v2::tools::injector::inject_tool_schemas` | fn | `crates/dstu-agent/src/chat_v2/tools/injector.rs:23` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0 | `pub fn inject_tool_schemas( schema_tool_ids: Option<&Vec<String>>, llm_context: &mut HashMap<String, Value>, ) -> usize` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_allow_unapproved` ? | fn | `crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:66` | L19-mcp-browser 2/0 | `pub fn read_mcp_allow_unapproved(db: &Database) -> Result<bool, String>` |
| `dstu_agent::chat_v2::tools::workbench_bridge::apply_ops_timeout_ms` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:65` | L13-vfs-api 1/0<br>L10-notes 1/0 | `pub fn apply_ops_timeout_ms(ops_len: usize, pacing: Option<&str>) -> u64` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_bridge_cancelled` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:523` | L13-vfs-api 1/0<br>L10-notes 1/0 | `pub fn is_bridge_cancelled(err: &str) -> bool` |
| `dstu_agent::chat_v2::tools::workbench_bridge::is_valid_apply_receipt` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:102` | L13-vfs-api 1/0<br>L10-notes 1/0 | `pub fn is_valid_apply_receipt(value: &Value) -> bool` |
| `dstu_agent::chat_v2::tools::workbench_bridge::PROBE_TIMEOUT_MS` ? | const | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:48` | L13-vfs-api 1/0<br>L10-notes 1/0 | `pub const PROBE_TIMEOUT_MS: u64 = 3_000` |
| `dstu_agent::chat_v2::tools::workbench_executor::is_workbench_agent_delegation_enabled` ? | fn | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs:125` | L13-vfs-api 1/0<br>L10-notes 1/0 | `pub async fn is_workbench_agent_delegation_enabled(ctx: &ExecutionContext) -> Result<bool, String>` |
| `dstu_agent::chat_v2::tools::ptc_runtime::PTC_ALLOWED_TOOLS` ? | const | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs:115` | L04-chat-session 1/1<br>F1-kernel 0/1 | `pub const PTC_ALLOWED_TOOLS: &[&str] = &[ // —— 检索（BuiltinRetrievalExecutor / FetchExecutor，Low）—— "builtin-unified_search", "builtin-rag_search", "builtin-web_search", "builtin-web_fetch", // —— 检索类补充（AcademicSearchExecutor，Low + ReadOnly，headless 集外）—— "builtin-arxiv_search", "builtin-scholar_search", // —— 系统观测（只...` |
| `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:505` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct ConnectorToolExecutor` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs:44` | L03-chat-pipeline 1/0<br>F1-kernel 0/1 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs:88` | F1-kernel 1/0<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:105` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct McpManageExecutor` |
| `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:58` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct PtcExecutor` |
| `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:61` | L03-chat-pipeline 1/0<br>F1-kernel 0/1 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs:95` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct SkillLifecycleExecutor` |
| `dstu_agent::chat_v2::tools::workbench_executor::WorkbenchToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs:502` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct WorkbenchToolExecutor` |
| `dstu_agent::chat_v2::skill_usage::on_task_finalized` | fn | `crates/dstu-agent/src/chat_v2/skill_usage.rs:1047` | L03-chat-pipeline 1/0 | `pub(crate) fn on_task_finalized(db: &Arc<ChatV2Database>, ctx: &PipelineContext)` |
| `dstu_agent::chat_v2::skill_usage::on_turn_committed` | fn | `crates/dstu-agent/src/chat_v2/skill_usage.rs:772` | L03-chat-pipeline 1/0 | `pub(crate) fn on_turn_committed(db: &Arc<ChatV2Database>, ctx: &PipelineContext)` |
| `dstu_agent::chat_v2::skills::canonicalize_skill_package_root` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:531` | L05-agent-workspace 1/0 | `pub(crate) fn canonicalize_skill_package_root(raw_path: &str) -> ChatV2Result<PathBuf>` |
| `dstu_agent::chat_v2::skills::get_allowed_skills_bases` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:139` | L05-agent-workspace 1/0 | `pub(crate) fn get_allowed_skills_bases() -> Vec<PathBuf>` |
| `dstu_agent::chat_v2::skills::is_portable_skill_path_component` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:893` | L06-agent-orchestration 1/0 | `pub(crate) fn is_portable_skill_path_component(component: &str) -> bool` |
| `dstu_agent::chat_v2::skills::skill_list_directories` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:371` | L04-chat-session 1/0 | `pub async fn skill_list_directories(path: String) -> Result<Vec<SkillDirectoryEntry>, String>` |
| `dstu_agent::chat_v2::skills::skill_list_package_files` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:566` | L04-chat-session 1/0 | `pub async fn skill_list_package_files(path: String) -> Result<Vec<SkillPackageFileEntry>, String>` |
| `dstu_agent::chat_v2::skills::skill_read_file` | fn | `crates/dstu-agent/src/chat_v2/skills.rs:596` | L04-chat-session 1/0 | `pub async fn skill_read_file(path: String) -> Result<SkillFileContent, String>` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteAppendTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:203` | L04-chat-session 1/0 | `pub struct NoteAppendTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteCreateTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:357` | L04-chat-session 1/0 | `pub struct NoteCreateTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteListTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:452` | L04-chat-session 1/0 | `pub struct NoteListTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteReadTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:163` | L04-chat-session 1/0 | `pub struct NoteReadTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteReplaceTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:253` | L04-chat-session 1/0 | `pub struct NoteReplaceTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteSearchTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:534` | L04-chat-session 1/0 | `pub struct NoteSearchTool` |
| `dstu_agent::chat_v2::tools::canvas_tools::NoteSetTool` | struct | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs:307` | L04-chat-session 1/0 | `pub struct NoteSetTool` |
| `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs:508` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs:579` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::validate_legacy_registry` | fn | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:205` | L03-chat-pipeline 1/0 | `pub fn validate_legacy_registry(legacy: &Arc<ToolExecutorRegistry>)` |
| `dstu_agent::chat_v2::tools::mcp_content_materializer::materialize_mcp_tool_output` | fn | `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs:71` | L05-agent-workspace 1/0 | `pub async fn materialize_mcp_tool_output( output: Value, artifact_root: PathBuf, provenance: McpOutputProvenance, ) -> Result<Value, String>` |
| `dstu_agent::chat_v2::tools::mcp_content_materializer::McpOutputProvenance` | struct | `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs:26` | L05-agent-workspace 1/0 | `pub struct McpOutputProvenance` |
| `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:114` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs:223` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::write_mcp_allow_unapproved` ? | fn | `crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:74` | L19-mcp-browser 1/0 | `pub fn write_mcp_allow_unapproved(db: &Database, enabled: bool) -> Result<(), String>` |
| `dstu_agent::chat_v2::tools::ptc_runtime::is_ptc_allowed_tool` | fn | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs:194` | L04-chat-session 1/0 | `pub fn is_ptc_allowed_tool(tool_name: &str) -> bool` |
| `dstu_agent::chat_v2::tools::skill_install_executor::SkillInstallExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs:77` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs:104` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs:135` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::package_sha256` | method | `crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs:249` | L05-agent-workspace 1/0 | `pub(crate) fn package_sha256(files: &[(String, Vec<u8>)]) -> String` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::read_package_directory` | method | `crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs:363` | L05-agent-workspace 1/0 | `pub(crate) fn read_package_directory(root: &Path) -> Result<Vec<(String, Vec<u8>)>, String>` |
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs:334` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeRequest` | struct | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:183` | L04-chat-session 1/0 | `pub struct AcrBridgeRequest` |
| `dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeResponse` | struct | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:200` | L04-chat-session 1/0 | `pub struct AcrBridgeResponse` |
| `dstu_agent::chat_v2::tools::workbench_bridge::AcrProgress` | struct | `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:214` | L04-chat-session 1/0 | `pub struct AcrProgress` |
| `dstu_agent::chat_v2::tools::workbench_executor::WorkbenchToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs:505` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::build_tool_registry` ? | fn | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:196` | F1-kernel 0/5 | `pub fn build_tool_registry( legacy: &Arc<ToolExecutorRegistry>, ) -> Result<ToolRegistry, ToolRegistryError>` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LEGACY_PROVIDER_ID` ? | const | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:37` | F1-kernel 0/3 | `pub const LEGACY_PROVIDER_ID: ProviderId = ProviderId::new("chat_v2.legacy")` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyToolProvider::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:150` | F1-kernel 0/3 | `pub fn new(legacy: Arc<ToolExecutorRegistry>) -> Self` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1651` | F1-kernel 0/1 | `pub struct SkillMarketInstallToolExecutor` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1501` | F1-kernel 0/1 | `pub struct SkillMarketReadToolExecutor` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyExecutorAdapter` ? | struct | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:44` | F1-kernel 0/1 | `pub struct LegacyExecutorAdapter` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyExecutorAdapter::wrap` ? | method | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:50` | F1-kernel 0/1 | `pub fn wrap(inner: Arc<dyn LegacyToolExecutor>) -> Arc<dyn ApiToolExecutor>` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyToolProvider` ? | struct | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:142` | F1-kernel 0/1 | `pub struct LegacyToolProvider` |
| `dstu_agent::chat_v2::tools::skill_install_executor::SkillInstallExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs:66` | F1-kernel 0/1 | `pub struct SkillInstallExecutor` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs:126` | F1-kernel 0/1 | `pub struct SkillWorkshopExecutor` |

### 引用点样例

- `dstu_agent::chat_v2::tools::workbench_bridge::uncertain_apply_receipt` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4652`, `src/chat_v2/tools/builtin_resource_executor.rs:4684`, `src/chat_v2/tools/builtin_resource_executor.rs:4702`, `src/chat_v2/tools/builtin_resource_executor.rs:4709`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1555`, `src/chat_v2/tools/canvas_executor.rs:1578`, `src/chat_v2/tools/canvas_executor.rs:1587`, `src/chat_v2/tools/canvas_executor.rs:1594`
- `dstu_agent::chat_v2::tools::workbench_bridge::acr_bridge_call` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:151`；L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4517`, `src/chat_v2/tools/builtin_resource_executor.rs:4634`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1404`, `src/chat_v2/tools/canvas_executor.rs:1530`
- `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tool_policy.rs:3`, `crates/dstu-agent/src/chat_v2/tools/mod.rs:144`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:87`
- `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_tools_list` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:279`；L19-mcp-browser: `src/cmd/mcp.rs:79`, `src/cmd/mcp.rs:610`
- `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::is_load_skills_tool` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs:1713`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:2008`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tool_policy.rs:23`
- `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:39`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:131`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:26`；L02-llm-manager: `src/chat_v2/tools/translation_executor.rs:1614`；L22-app-commands: `tests/tool_pack_integration_tests.rs:51`, `tests/tool_pack_integration_tests.rs:252`, `tests/tool_pack_integration_tests.rs:269`, `tests/tool_pack_integration_tests.rs:286`
- `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:134`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:81`, `src/agent_wiring/tests/headless_tests.rs:27`；L22-app-commands: `tests/phase7_system_executor_e2e.rs:8`
- `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:129`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:66`, `src/agent_wiring/tests/headless_tests.rs:25`
- `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:139`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:70`
- `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:69`；F1-kernel: `src/agent_wiring/roster.rs:103`
- `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:66`；F1-kernel: `src/agent_wiring/roster.rs:100`
- `dstu_agent::chat_v2::skills::command_mentions_skills_directory` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:1783`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:379`
- `dstu_agent::chat_v2::tools::injector::inject_tool_schemas` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:950`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:112`
- `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_allow_unapproved` — L19-mcp-browser: `src/cmd/mcp.rs:570`, `src/cmd/mcp.rs:794`
- `dstu_agent::chat_v2::tools::workbench_bridge::apply_ops_timeout_ms` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4633`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1527`
- `dstu_agent::chat_v2::tools::workbench_bridge::is_bridge_cancelled` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4519`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1413`
- `dstu_agent::chat_v2::tools::workbench_bridge::is_valid_apply_receipt` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4708`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1593`
- `dstu_agent::chat_v2::tools::workbench_bridge::PROBE_TIMEOUT_MS` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4517`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:43`
- `dstu_agent::chat_v2::tools::workbench_executor::is_workbench_agent_delegation_enabled` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:4493`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1373`
- `dstu_agent::chat_v2::tools::ptc_runtime::PTC_ALLOWED_TOOLS` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tool_descriptors.rs:817`, `crates/dstu-agent/src/chat_v2/tools/mod.rs:141`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:227`
- `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:125`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:62`
- `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:180`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:131`
- `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:69`；L22-app-commands: `tests/phase7_system_executor_e2e.rs:209`
- `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:138`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:71`
- `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:140`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:26`
- `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:178`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:129`
- `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:143`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:108`
- `dstu_agent::chat_v2::tools::workbench_executor::WorkbenchToolExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:152`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:118`
- `dstu_agent::chat_v2::skill_usage::on_task_finalized` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:2446`
- `dstu_agent::chat_v2::skill_usage::on_turn_committed` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs:1549`
- `dstu_agent::chat_v2::skills::canonicalize_skill_package_root` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1233`
- `dstu_agent::chat_v2::skills::get_allowed_skills_bases` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:840`
- `dstu_agent::chat_v2::skills::is_portable_skill_path_component` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:155`
- `dstu_agent::chat_v2::skills::skill_list_directories` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:175`
- `dstu_agent::chat_v2::skills::skill_list_package_files` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:175`
- `dstu_agent::chat_v2::skills::skill_read_file` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:175`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteAppendTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteCreateTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteListTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteReadTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteReplaceTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteSearchTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::canvas_tools::NoteSetTool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:96`
- `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:50`
- `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:54`
- `dstu_agent::chat_v2::tools::legacy_tool_provider::validate_legacy_registry` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:193`
- `dstu_agent::chat_v2::tools::mcp_content_materializer::materialize_mcp_tool_output` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:311`
- `dstu_agent::chat_v2::tools::mcp_content_materializer::McpOutputProvenance` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs:314`
- `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:59`
- `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:58`
- `dstu_agent::chat_v2::tools::mcp_settings_store::write_mcp_allow_unapproved` — L19-mcp-browser: `src/cmd/mcp.rs:806`
- `dstu_agent::chat_v2::tools::ptc_runtime::is_ptc_allowed_tool` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:141`
- `dstu_agent::chat_v2::tools::skill_install_executor::SkillInstallExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:97`
- `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:109`
- `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:106`
- `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::package_sha256` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1255`
- `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::read_package_directory` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1253`
- `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:75`
- `dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeRequest` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:151`
- `dstu_agent::chat_v2::tools::workbench_bridge::AcrBridgeResponse` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:151`
- 其余 12 个条目的引用点见 `draft.json`。

## 消费其他 lane

### L04-chat-session（55 个条目，prod 319 / test 69）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::error::ChatV2Error` ? | enum | 110/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/skill_taps.rs`, `crates/dstu-agent/src/chat_v2/skill_updates.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 62/4 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 14 个 |
| `dstu_agent::chat_v2::error::ChatV2Result` | type | 27/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/skill_taps.rs`, `crates/dstu-agent/src/chat_v2/skill_updates.rs` 等 4 个 |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 25/21 | `crates/dstu-agent/src/chat_v2/skill_replay.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 17/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 14 个 |
| `dstu_agent::chat_v2::connector_ledger::ConnectorOperationState` ? | enum | 14/7 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::ProviderErrorKind` | enum | 5/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::WEBHOOK_PROVIDER_KIND` | const | 4/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 4/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent::chat_v2::connector_ledger::ConnectorOperation` | struct | 3/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::ProviderOperation` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_ledger::ConnectorLedger::new` ? | method | 2/7 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_ledger::ConnectorLedger` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::AdmittedToolDispatcher` ? | trait | 2/1 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::ProviderError` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::webhook::WebhookProvider` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::webhook::WebhookProvider::from_settings` | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::load_session_state_v2` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::connector_ledger::system_idempotency_key` | fn | 1/5 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::types::SendOptions` ? | struct | 1/5 | `crates/dstu-agent/src/chat_v2/skill_usage.rs` |
| `dstu_agent::chat_v2::connector_ledger::NewConnectorOperation` | struct | 1/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 1/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::ConnectorProvider` | trait | 1/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::extract_external_operation_id` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::ProviderReceipt` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::connector_providers::webhook::WebhookConfig` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_message_v2` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_session_skill_state_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS` ? | static | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent::chat_v2::tool_descriptors::DEFAULT_TIMEOUT_SECS` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent::chat_v2::tool_descriptors::is_ptc_allowed` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_agent::chat_v2::tool_descriptors::NO_TIMEOUT_SECS` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent::chat_v2::tool_descriptors::ToolDescriptor` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_APPEND` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_CREATE` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_LIST` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_READ` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_REPLACE` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_SEARCH` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::canvas_tool_names::NOTE_SET` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` |
| `dstu_agent::chat_v2::tools::is_canvas_tool` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs` |
| `dstu_agent::chat_v2::tools::registry::get_registry` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/injector.rs` |
| `dstu_agent::chat_v2::tools::types::SETTINGS_CHANGED_EVENT` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs` |
| `dstu_agent::chat_v2::types::McpToolSchema` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::types::ReplaySkillPayloadSnapshot` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::chat_v2::types::SessionState` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` |
| `dstu_agent::get_global_app_handle` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/skills.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/skill_replay.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_windowless_for_test` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::connector_ledger::reconcile_on_startup` | fn | 0/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_agent::chat_v2::types::SendMessageRequest` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/skill_usage.rs` |
| `dstu_agent::chat_v2::types::TokenUsage` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/skill_usage.rs` |

### F4-security（34 个条目，prod 162 / test 52）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::agent::ToolResultInfo` ? | struct | 19/8 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` 等 15 个 |
| `dstu_core::agent::ToolCall` ? | struct | 16/2 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 14 个 |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 15/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 13 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 14/2 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 13 个 |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 14/2 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 8 个 |
| `dstu_core::task_objects::TaskObjectKind` ? | enum | 12/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` 等 5 个 |
| `dstu_core::task_objects::OperationState` ? | enum | 6/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_core::agent::ToolResultInfo::failure_with_output` | method | 5/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs` 等 4 个 |
| `dstu_core::task_objects::ManagedLocator::new` ? | method | 5/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` 等 4 个 |
| `dstu_core::task_objects::ObjectCapabilities` ? | struct | 5/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` 等 5 个 |
| `dstu_core::task_objects::TaskObjectHandle` ? | struct | 5/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_core::net_policy::is_blocked_internal_ip` | fn | 4/9 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` |
| `dstu_core::task_objects::DerivedEdge` ? | struct | 4/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` 等 4 个 |
| `dstu_core::task_objects::DerivedEdge::new` ? | method | 4/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` 等 4 个 |
| `dstu_core::task_objects::ManagedLocator` ? | struct | 4/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` 等 4 个 |
| `dstu_core::task_objects::ConnectorOperationReceipt` | struct | 3/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_core::task_objects::ProviderObjectRef` ? | struct | 3/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder` ? | struct | 3/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder::new` ? | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/tools/skills_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs` |
| `dstu_core::task_objects::hash_transform_params` ? | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` |
| `dstu_core::task_objects::ObjectProvenance` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandle::new` | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_core::tool_names::is_external_mcp_tool_name` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs` |
| `dstu_core::task_objects::OBJECT_READ_PAGE_MAX_BYTES` | const | 1/3 | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_core::APP_VERSION` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_core::net_policy::is_loopback_host` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_core::task_objects::read_task_object_page` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_core::task_objects::write_task_object_page` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` |
| `dstu_util::utils::text::safe_truncate` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs` |
| `dstu_core::net_policy::is_internal_ip` | fn | 0/19 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` |
| `dstu_core::models::RagSourceInfo` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |

### F1-kernel（18 个条目，prod 95 / test 30）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 52/30 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` 等 14 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 12/0 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` 等 5 个 |
| `dstu_agent_api::executor::ToolExecutor` | trait | 6/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::descriptor::ToolTimeout` | enum | 4/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::descriptor::HeadlessPolicy` | enum | 3/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::descriptor::PtcPolicy` | enum | 3/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::descriptor::ToolDescriptor` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::provider::ProviderId` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::context::ExecutionContext` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::descriptor::ToolDescriptor::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::executor::ToolFuture` | type | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::provider::ProviderId::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::provider::ToolProvider` | trait | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::registry::ToolRegistry` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::registry::ToolRegistryBuilder` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::registry::ToolRegistryBuilder::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::registry::ToolRegistryError` | enum | 1/0 | `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` |
| `dstu_agent_api::services::Services` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |

### F3-storage（28 个条目，prod 72 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 26/2 | `crates/dstu-agent/src/chat_v2/skill_market_client.rs`, `crates/dstu-agent/src/chat_v2/skill_taps.rs`, `crates/dstu-agent/src/chat_v2/skill_updates.rs` 等 10 个 |
| `dstu_storage::llm_usage::repo::PriceCoverageStat` | struct | 10/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::database::LlmUsageResult` | type | 6/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::PriceCoverageDimension` | enum | 4/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_price_coverage` | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::types::TimeGranularity` | enum | 3/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::types::UsageTrendPoint` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::unified_file_manager::is_virtual_uri` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/skill_taps.rs`, `crates/dstu-agent/src/chat_v2/skills.rs` |
| `dstu_storage::feature_flags::FeatureFlagManager` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs` |
| `dstu_storage::feature_flags::FeatureFlagManager::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs` |
| `dstu_storage::llm_usage::database::LlmUsageDatabase` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_recent_price_coverage` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_recent_usage_page` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_usage_by_caller` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_usage_by_model` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_usage_summary` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::repo::LlmUsageRepo::get_usage_trends` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::types::CallerTypeSummary` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::types::ModelSummary` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::llm_usage::types::UsageRecord` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` |
| `dstu_storage::unified_file_manager::copy_file` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/skill_taps.rs` |
| `dstu_storage::unified_file_manager::read_all_bytes_bounded` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/skills.rs` |
| `dstu_storage::unified_file_manager::reject_double_encoded_virtual_uri` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/skill_taps.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/6 | `crates/dstu-agent/src/chat_v2/skill_replay.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/3 | `crates/dstu-agent/src/chat_v2/skill_replay.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/3 | `crates/dstu-agent/src/chat_v2/skill_replay.rs`, `crates/dstu-agent/src/chat_v2/skill_usage.rs`, `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |

### L05-agent-workspace（6 个条目，prod 9 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::runtime_roots::artifact_root` ? | fn | 3/0 | `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/general_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs`, `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs` |
| `dstu_agent::chat_v2::approval_scope::is_high_risk_external_mcp_tool` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs` |
| `dstu_agent::chat_v2::approval_scope::redact_tool_arguments_for_display` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/general_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::SKILL_TRUST_KEY_PREFIX` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs` |

### L06-agent-orchestration（1 个条目，prod 9 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::self_inspect_executor::redact_sensitive_json` | fn | 9/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |

### L19-mcp-browser（10 个条目，prod 8 / test 8）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::ToolContext` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/general_executor.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 1/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_mcp::mcp::test_helpers::test_http` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_mcp::mcp::test_helpers::test_sse` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_mcp::mcp::test_helpers::test_stdio` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_mcp::mcp::test_helpers::test_streamable_http_rmcp` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_mcp::mcp::test_helpers::test_websocket` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` |
| `dstu_mcp::tools::Tool` | trait | 0/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_mcp::tools::ToolRegistry::new_with` | method | 0/2 | `crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |

### L03-chat-pipeline（2 个条目，prod 3 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::context::PipelineContext` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/skill_usage.rs` |
| `dstu_agent::chat_v2::context::PipelineContext::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/skill_usage.rs` |

### L12-vfs-index（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |

### L02-llm-manager（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |

### L13-vfs-api（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` |

### L22-app-commands（1 个条目，prod 1 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 1/0 | `src/chat_v2/skill_taps.rs` |
