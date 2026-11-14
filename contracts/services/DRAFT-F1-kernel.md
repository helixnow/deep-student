# 跨 lane 服务草稿：F1-kernel

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（39 个条目，其中 36 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | `crates/dstu-agent-api/src/executor.rs:25` | L04-chat-session 378/35<br>L07-agent-skills-ptc 52/30<br>L06-agent-orchestration 43/32<br>L05-agent-workspace 37/21<br>L18-media-docs 31/26<br>L03-chat-pipeline 24/39<br>L17-memory-research 16/13<br>L13-vfs-api 14/12<br>L24-chatanki 14/21<br>L14-qbank 12/18<br>L10-notes 10/16<br>L19-mcp-browser 9/13<br>L02-llm-manager 7/6<br>L21-backup-governance 3/2 | `pub enum ToolSensitivity` |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | `crates/dstu-agent-api/src/executor.rs:43` | L18-media-docs 18/0<br>L07-agent-skills-ptc 12/0<br>L05-agent-workspace 10/6<br>L06-agent-orchestration 10/1<br>L13-vfs-api 10/4<br>L17-memory-research 7/8<br>L02-llm-manager 6/5<br>L19-mcp-browser 5/2<br>L04-chat-session 4/5<br>L21-backup-governance 3/1<br>L24-chatanki 3/2<br>L14-qbank 3/0<br>L03-chat-pipeline 2/0 | `pub enum ToolConcurrency` |
| `deep_student_lib::extensions::qbank_state` | fn | `src/extensions.rs:114` | L14-qbank 18/0 | `pub(crate) fn qbank_state(state: &crate::commands::AppState) -> dstu_qbank::runtime::QbankState` |
| `dstu_kernel::disposer::Disposer` | struct | `crates/dstu-kernel/src/disposer.rs:13` | L13-vfs-api 4/0<br>L19-mcp-browser 3/0<br>L04-chat-session 2/0<br>L21-backup-governance 2/0<br>L03-chat-pipeline 1/0<br>L15-review-analytics 1/0<br>L02-llm-manager 1/0<br>L18-media-docs 1/0<br>L14-qbank 1/0<br>F3-storage 1/0 | `pub struct Disposer` |
| `dstu_kernel::slot::SlotOccupied` | struct | `crates/dstu-kernel/src/slot.rs:10` | L19-mcp-browser 2/0<br>L21-backup-governance 2/0<br>L13-vfs-api 2/0<br>L04-chat-session 1/0<br>L03-chat-pipeline 1/0<br>L15-review-analytics 1/0<br>L02-llm-manager 1/0<br>L18-media-docs 1/0<br>L14-qbank 1/0<br>F3-storage 1/0 | `pub struct SlotOccupied` |
| `dstu_kernel::slot::Slot` | struct | `crates/dstu-kernel/src/slot.rs:34` | L21-backup-governance 2/0<br>L13-vfs-api 2/0<br>L04-chat-session 1/0<br>L03-chat-pipeline 1/0<br>L19-mcp-browser 1/0<br>L15-review-analytics 1/0<br>L02-llm-manager 1/0<br>L18-media-docs 1/0<br>L14-qbank 1/0<br>F3-storage 1/0 | `pub struct Slot<T: ?Sized>` |
| `dstu_kernel::slot::Slot::new` | method | `crates/dstu-kernel/src/slot.rs:40` | L21-backup-governance 2/0<br>L13-vfs-api 2/0<br>L04-chat-session 1/0<br>L03-chat-pipeline 1/0<br>L19-mcp-browser 1/0<br>L15-review-analytics 1/0<br>L02-llm-manager 1/0<br>L18-media-docs 1/0<br>L14-qbank 1/0<br>F3-storage 1/0 | `pub const fn new() -> Self` |
| `dstu_kernel::plugin::Scope` | struct | `crates/dstu-kernel/src/plugin.rs:13` | L18-media-docs 2/0<br>L17-memory-research 2/0<br>L14-qbank 1/0<br>L10-notes 1/0<br>L24-chatanki 1/0 | `pub struct Scope` |
| `dstu_agent_api::executor::ToolExecutor` | trait | `crates/dstu-agent-api/src/executor.rs:59` | L07-agent-skills-ptc 6/0 | `pub trait ToolExecutor: Send + Sync` |
| `dstu_agent_api::services::Services` | struct | `crates/dstu-agent-api/src/services.rs:25` | L03-chat-pipeline 2/0<br>L04-chat-session 2/0<br>L07-agent-skills-ptc 1/0 | `pub struct Services` |
| `dstu_agent_api::budget::DEFAULT_TOOL_RESULT_CHAR_BUDGET` ? | const | `crates/dstu-agent-api/src/budget.rs:15` | L05-agent-workspace 2/3<br>L04-chat-session 1/0<br>L13-vfs-api 1/0 | `pub const DEFAULT_TOOL_RESULT_CHAR_BUDGET: usize = 30_000` |
| `dstu_agent_api::descriptor::ToolTimeout` | enum | `crates/dstu-agent-api/src/descriptor.rs:12` | L07-agent-skills-ptc 4/0 | `pub enum ToolTimeout` |
| `dstu_agent_api::descriptor::HeadlessPolicy` | enum | `crates/dstu-agent-api/src/descriptor.rs:22` | L07-agent-skills-ptc 3/0 | `pub enum HeadlessPolicy` |
| `dstu_agent_api::descriptor::PtcPolicy` | enum | `crates/dstu-agent-api/src/descriptor.rs:34` | L07-agent-skills-ptc 3/0 | `pub enum PtcPolicy` |
| `dstu_agent_api::descriptor::ToolDescriptor` | struct | `crates/dstu-agent-api/src/descriptor.rs:72` | L07-agent-skills-ptc 3/0 | `pub struct ToolDescriptor` |
| `dstu_kernel::hookset::HookSet` | struct | `crates/dstu-kernel/src/hookset.rs:25` | L13-vfs-api 2/0<br>L04-chat-session 1/0 | `pub struct HookSet<T: ?Sized>` |
| `dstu_kernel::hookset::HookSet::new` | method | `crates/dstu-kernel/src/hookset.rs:31` | L13-vfs-api 2/0<br>L04-chat-session 1/0 | `pub const fn new() -> Self` |
| `deep_student_lib::plugins::manager::PluginManager` | struct | `src/plugins/manager.rs:27` | F2-shell 2/0 | `pub struct PluginManager` |
| `dstu_agent_api::provider::ProviderId` | struct | `crates/dstu-agent-api/src/provider.rs:16` | L07-agent-skills-ptc 2/0 | `pub struct ProviderId` |
| `dstu_agent_api::services::Services::new` | method | `crates/dstu-agent-api/src/services.rs:31` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0 | `pub fn new() -> Self` |
| `deep_student_lib::extensions::register_extensions` | fn | `src/extensions.rs:304` | F2-shell 1/0<br>L24-chatanki 0/1<br>L15-review-analytics 0/2<br>L10-notes 0/1<br>L14-qbank 0/1<br>L20-sync 0/1 | `pub fn register_extensions()` |
| `dstu_agent_api::budget::apply_tool_result_budget` | fn | `crates/dstu-agent-api/src/budget.rs:71` | L04-chat-session 1/4<br>L05-agent-workspace 0/1 | `pub fn apply_tool_result_budget(output: Value, budget: usize) -> Value` |
| `deep_student_lib::agent_wiring::plugins::NotesCanvasSource` | struct | `src/agent_wiring/plugins.rs:20` | F2-shell 1/0 | `pub struct NotesCanvasSource` |
| `deep_student_lib::agent_wiring::roster::AppExecutorRoster` | struct | `src/agent_wiring/roster.rs:31` | F2-shell 1/0 | `pub struct AppExecutorRoster` |
| `deep_student_lib::agent_wiring::roster::verify_roster_coverage` | fn | `src/agent_wiring/roster.rs:167` | F2-shell 1/0 | `pub fn verify_roster_coverage(registry: &ToolExecutorRegistry)` |
| `deep_student_lib::agent_wiring::services::build_pipeline_services_from_managed` | fn | `src/agent_wiring/services.rs:40` | F2-shell 1/0 | `pub fn build_pipeline_services_from_managed<R: tauri::Runtime>( manager: &impl tauri::Manager<R>, ) -> Arc<Services>` |
| `deep_student_lib::plugins::manager::PluginManager::new` | method | `src/plugins/manager.rs:38` | F2-shell 1/0 | `pub fn new(app: AppHandle) -> Self` |
| `dstu_agent_api::context::ExecutionContext` | struct | `crates/dstu-agent-api/src/context.rs:58` | L07-agent-skills-ptc 1/0 | `pub struct ExecutionContext` |
| `dstu_agent_api::descriptor::ToolDescriptor::new` | method | `crates/dstu-agent-api/src/descriptor.rs:93` | L07-agent-skills-ptc 1/0 | `pub const fn new(name: &'static str) -> Self` |
| `dstu_agent_api::executor::ToolFuture` | type | `crates/dstu-agent-api/src/executor.rs:18` | L07-agent-skills-ptc 1/0 | `pub type ToolFuture<'a> = Pin<Box<dyn Future<Output = Result<ToolResultInfo, String>> + Send + 'a>>` |
| `dstu_agent_api::provider::ProviderId::new` | method | `crates/dstu-agent-api/src/provider.rs:20` | L07-agent-skills-ptc 1/0 | `pub const fn new(id: &'static str) -> Self` |
| `dstu_agent_api::provider::ToolProvider` | trait | `crates/dstu-agent-api/src/provider.rs:46` | L07-agent-skills-ptc 1/0 | `pub trait ToolProvider: Send + Sync` |
| `dstu_agent_api::registry::ToolRegistry` | struct | `crates/dstu-agent-api/src/registry.rs:135` | L07-agent-skills-ptc 1/0 | `pub struct ToolRegistry` |
| `dstu_agent_api::registry::ToolRegistryBuilder` | struct | `crates/dstu-agent-api/src/registry.rs:208` | L07-agent-skills-ptc 1/0 | `pub struct ToolRegistryBuilder` |
| `dstu_agent_api::registry::ToolRegistryBuilder::new` | method | `crates/dstu-agent-api/src/registry.rs:214` | L07-agent-skills-ptc 1/0 | `pub fn new() -> Self` |
| `dstu_agent_api::registry::ToolRegistryError` | enum | `crates/dstu-agent-api/src/registry.rs:25` | L07-agent-skills-ptc 1/0 | `pub enum ToolRegistryError` |
| `dstu_agent_api::budget::serialized_char_len` | fn | `crates/dstu-agent-api/src/budget.rs:24` | L04-chat-session 0/3 | `pub fn serialized_char_len(value: &Value) -> usize` |
| `deep_student_lib::agent_wiring::services::build_pipeline_services` | fn | `src/agent_wiring/services.rs:20` | L14-qbank 0/1 | `pub fn build_pipeline_services( notes_manager: Option<Arc<NotesManager>>, question_bank_service: Option<Arc<QuestionBankService>>, ) -> Arc<Services>` |
| `dstu_agent_api::budget::TRUNCATION_MARKER` | const | `crates/dstu-agent-api/src/budget.rs:21` | L04-chat-session 0/1 | `pub const TRUNCATION_MARKER: &str = "…[truncated]"` |

### 引用点样例

- `dstu_agent_api::executor::ToolSensitivity` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/approval_manager.rs:1274`, `crates/dstu-agent/src/chat_v2/approval_manager.rs:247`, `crates/dstu-agent/src/chat_v2/approval_manager.rs:250`, `crates/dstu-agent/src/chat_v2/approval_manager.rs:1985`；L04-chat-session: `crates/dstu-agent/src/chat_v2/environment_manifest.rs:614`, `crates/dstu-agent/src/chat_v2/environment_manifest.rs:616`, `crates/dstu-agent/src/chat_v2/environment_manifest.rs:617`, `crates/dstu-agent/src/chat_v2/environment_manifest.rs:618`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:39`, `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:53`, `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:99`, `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:100`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1629`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1630`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1813`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1815`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:289`, `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:291`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:321`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:323`；L17-memory-research: `src/chat_v2/tools/academic_search_executor.rs:997`, `src/chat_v2/tools/academic_search_executor.rs:1035`, `src/chat_v2/tools/academic_search_executor.rs:1039`, `src/chat_v2/tools/academic_search_executor.rs:998`；L13-vfs-api: `src/chat_v2/tools/attachment_executor.rs:533`, `src/chat_v2/tools/attachment_executor.rs:635`, `src/chat_v2/tools/attachment_executor.rs:639`, `src/chat_v2/tools/attachment_executor.rs:535`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:1205`, `src/chat_v2/tools/browser_executor.rs:1254`, `src/chat_v2/tools/browser_executor.rs:1258`, `src/chat_v2/tools/browser_executor.rs:1262`；L10-notes: `src/chat_v2/tools/canvas_executor.rs:1992`, `src/chat_v2/tools/canvas_executor.rs:2122`, `src/chat_v2/tools/canvas_executor.rs:2126`, `src/chat_v2/tools/canvas_executor.rs:2130`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:1946`, `src/chat_v2/tools/chatanki_executor.rs:1976`, `src/chat_v2/tools/chatanki_executor.rs:18623`, `src/chat_v2/tools/chatanki_executor.rs:18627`；L21-backup-governance: `src/chat_v2/tools/data_governance_executor.rs:443`, `src/chat_v2/tools/data_governance_executor.rs:881`, `src/chat_v2/tools/data_governance_executor.rs:885`, `src/chat_v2/tools/data_governance_executor.rs:445`；L18-media-docs: `src/chat_v2/tools/document_processing_executor.rs:365`, `src/chat_v2/tools/document_processing_executor.rs:406`, `src/chat_v2/tools/document_processing_executor.rs:410`, `src/chat_v2/tools/document_processing_executor.rs:414`；L14-qbank: `src/chat_v2/tools/essay_grading_executor.rs:896`, `src/chat_v2/tools/essay_grading_executor.rs:954`, `src/chat_v2/tools/essay_grading_executor.rs:958`, `src/chat_v2/tools/essay_grading_executor.rs:962`；L02-llm-manager: `src/chat_v2/tools/settings_models_executor.rs:750`, `src/chat_v2/tools/settings_models_executor.rs:1628`, `src/chat_v2/tools/settings_models_executor.rs:1633`, `src/chat_v2/tools/settings_models_executor.rs:1641`
- `dstu_agent_api::executor::ToolConcurrency` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:2894`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:3082`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1636`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1637`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1847`, `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1849`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:2055`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:867`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:912`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:868`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs:582`, `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs:689`, `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs:583`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs:925`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs:211`, `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs:237`, `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs:212`, `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:589`；L17-memory-research: `src/chat_v2/tools/academic_search_executor.rs:1001`, `src/chat_v2/tools/academic_search_executor.rs:1003`, `src/chat_v2/tools/learning_overview_executor.rs:501`, `src/chat_v2/tools/learning_overview_executor.rs:1259`；L13-vfs-api: `src/chat_v2/tools/attachment_executor.rs:538`, `src/chat_v2/tools/attachment_executor.rs:643`, `src/chat_v2/tools/attachment_executor.rs:647`, `src/chat_v2/tools/attachment_executor.rs:540`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:1217`, `src/chat_v2/tools/browser_executor.rs:1298`, `src/chat_v2/tools/browser_executor.rs:1219`, `src/chat_v2/tools/index_webpage_executor.rs:568`；L21-backup-governance: `src/chat_v2/tools/data_governance_executor.rs:450`, `src/chat_v2/tools/data_governance_executor.rs:889`, `src/chat_v2/tools/data_governance_executor.rs:453`, `src/chat_v2/tools/data_governance_executor.rs:455`；L18-media-docs: `src/chat_v2/tools/docx_executor.rs:482`, `src/chat_v2/tools/docx_executor.rs:487`, `src/chat_v2/tools/docx_executor.rs:490`, `src/chat_v2/tools/media_executor.rs:558`；L24-chatanki: `src/chat_v2/tools/fsrs_settings_executor.rs:200`, `src/chat_v2/tools/fsrs_settings_executor.rs:374`, `src/chat_v2/tools/fsrs_settings_executor.rs:378`, `src/chat_v2/tools/fsrs_settings_executor.rs:202`；L14-qbank: `src/chat_v2/tools/qbank_executor.rs:5607`, `src/chat_v2/tools/qbank_executor.rs:5626`, `src/chat_v2/tools/qbank_executor.rs:5628`；L02-llm-manager: `src/chat_v2/tools/settings_models_executor.rs:760`, `src/chat_v2/tools/settings_models_executor.rs:1629`, `src/chat_v2/tools/settings_models_executor.rs:1634`, `src/chat_v2/tools/settings_models_executor.rs:1645`
- `deep_student_lib::extensions::qbank_state` — L14-qbank: `src/qbank_generation.rs:22`, `src/qbank_generation.rs:32`, `src/qbank_generation.rs:43`, `src/qbank_generation.rs:53`
- `dstu_kernel::disposer::Disposer` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:259`, `crates/dstu-agent/src/chat_v2/kill_switch.rs:45`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:38`；L19-mcp-browser: `crates/dstu-browser/src/browser/hooks.rs:28`, `crates/dstu-mcp/src/tools/mod.rs:634`, `crates/dstu-mcp/src/tools/mod.rs:645`；L15-review-analytics: `crates/dstu-learning/src/mastery/profile_sink.rs:53`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:54`；L18-media-docs: `crates/dstu-media/src/host.rs:34`；L14-qbank: `crates/dstu-qbank/src/runtime.rs:34`；F3-storage: `crates/dstu-storage/src/file_deletion_queue.rs:37`；L21-backup-governance: `crates/dstu-sync/src/cloud_credentials.rs:37`, `crates/dstu-sync/src/hooks.rs:30`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:41`, `crates/dstu-vfs/src/vfs/hooks.rs:112`, `crates/dstu-vfs/src/vfs/hooks.rs:126`, `crates/dstu-vfs/src/vfs/hooks.rs:151`
- `dstu_kernel::slot::SlotOccupied` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:259`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:38`；L19-mcp-browser: `crates/dstu-browser/src/browser/hooks.rs:28`, `crates/dstu-mcp/src/tools/mod.rs:645`；L15-review-analytics: `crates/dstu-learning/src/mastery/profile_sink.rs:53`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:54`；L18-media-docs: `crates/dstu-media/src/host.rs:34`；L14-qbank: `crates/dstu-qbank/src/runtime.rs:34`；F3-storage: `crates/dstu-storage/src/file_deletion_queue.rs:37`；L21-backup-governance: `crates/dstu-sync/src/cloud_credentials.rs:37`, `crates/dstu-sync/src/hooks.rs:30`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:112`, `crates/dstu-vfs/src/vfs/hooks.rs:151`
- `dstu_kernel::slot::Slot` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:253`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:33`；L19-mcp-browser: `crates/dstu-browser/src/browser/hooks.rs:23`；L15-review-analytics: `crates/dstu-learning/src/mastery/profile_sink.rs:48`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:46`；L18-media-docs: `crates/dstu-media/src/host.rs:31`；L14-qbank: `crates/dstu-qbank/src/runtime.rs:29`；F3-storage: `crates/dstu-storage/src/file_deletion_queue.rs:29`；L21-backup-governance: `crates/dstu-sync/src/cloud_credentials.rs:32`, `crates/dstu-sync/src/hooks.rs:25`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:107`, `crates/dstu-vfs/src/vfs/hooks.rs:146`
- `dstu_kernel::slot::Slot::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:254`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:33`；L19-mcp-browser: `crates/dstu-browser/src/browser/hooks.rs:23`；L15-review-analytics: `crates/dstu-learning/src/mastery/profile_sink.rs:48`；L02-llm-manager: `crates/dstu-llm/src/llm_manager/web_search_fallback.rs:46`；L18-media-docs: `crates/dstu-media/src/host.rs:31`；L14-qbank: `crates/dstu-qbank/src/runtime.rs:29`；F3-storage: `crates/dstu-storage/src/file_deletion_queue.rs:29`；L21-backup-governance: `crates/dstu-sync/src/cloud_credentials.rs:32`, `crates/dstu-sync/src/hooks.rs:25`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:107`, `crates/dstu-vfs/src/vfs/hooks.rs:146`
- `dstu_kernel::plugin::Scope` — L18-media-docs: `crates/dstu-media/src/media/transcriber_hook.rs:167`, `src/media/mod.rs:42`；L17-memory-research: `crates/dstu-memory/src/memory/delete_hook.rs:108`, `crates/dstu-memory/src/memory/mastery_hook.rs:38`；L14-qbank: `crates/dstu-qbank/src/question_export_service/vfs_hook.rs:24`；L10-notes: `crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs:523`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:370`
- `dstu_agent_api::executor::ToolExecutor` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:50`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:55`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:145`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:162`
- `dstu_agent_api::services::Services` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:227`, `crates/dstu-agent/src/chat_v2/pipeline.rs:379`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:106`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:398`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:147`
- `dstu_agent_api::budget::DEFAULT_TOOL_RESULT_CHAR_BUDGET` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:890`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:225`, `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:299`, `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:309`, `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:313`；L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:5664`
- `dstu_agent_api::descriptor::ToolTimeout` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:21`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:117`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:118`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:119`
- `dstu_agent_api::descriptor::HeadlessPolicy` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:21`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:126`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:128`
- `dstu_agent_api::descriptor::PtcPolicy` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:21`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:131`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:133`
- `dstu_agent_api::descriptor::ToolDescriptor` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:109`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:112`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:176`
- `dstu_kernel::hookset::HookSet` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:42`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:39`, `crates/dstu-vfs/src/vfs/hooks.rs:124`
- `dstu_kernel::hookset::HookSet::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:42`；L13-vfs-api: `crates/dstu-vfs/src/vfs/hooks.rs:39`, `crates/dstu-vfs/src/vfs/hooks.rs:124`
- `deep_student_lib::plugins::manager::PluginManager` — F2-shell: `src/lib.rs:1365`, `src/lib.rs:3258`
- `dstu_agent_api::provider::ProviderId` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:37`, `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:172`
- `dstu_agent_api::services::Services::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:316`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:190`
- `deep_student_lib::extensions::register_extensions` — L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:20856`；F2-shell: `src/lib.rs:460`；L15-review-analytics: `src/mastery/service/tests.rs:117`, `src/mastery/service/tests.rs:661`；L10-notes: `src/notes_app_tests.rs:48`；L14-qbank: `src/question_bank_service/tests.rs:62`；L20-sync: `src/sync_app_tests.rs:14`
- `dstu_agent_api::budget::apply_tool_result_budget` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:918`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:930`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:964`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:981`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:311`
- `deep_student_lib::agent_wiring::plugins::NotesCanvasSource` — F2-shell: `src/lib.rs:1541`
- `deep_student_lib::agent_wiring::roster::AppExecutorRoster` — F2-shell: `src/lib.rs:1546`
- `deep_student_lib::agent_wiring::roster::verify_roster_coverage` — F2-shell: `src/lib.rs:1559`
- `deep_student_lib::agent_wiring::services::build_pipeline_services_from_managed` — F2-shell: `src/lib.rs:1551`
- `deep_student_lib::plugins::manager::PluginManager::new` — F2-shell: `src/lib.rs:1359`
- `dstu_agent_api::context::ExecutionContext` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:60`
- `dstu_agent_api::descriptor::ToolDescriptor::new` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:121`
- `dstu_agent_api::executor::ToolFuture` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:60`
- `dstu_agent_api::provider::ProviderId::new` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:37`
- `dstu_agent_api::provider::ToolProvider` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:171`
- `dstu_agent_api::registry::ToolRegistry` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:198`
- `dstu_agent_api::registry::ToolRegistryBuilder` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:21`
- `dstu_agent_api::registry::ToolRegistryBuilder::new` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:199`
- `dstu_agent_api::registry::ToolRegistryError` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs:198`
- `dstu_agent_api::budget::serialized_char_len` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:953`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:963`, `crates/dstu-agent/src/chat_v2/tools/executor.rs:986`
- `deep_student_lib::agent_wiring::services::build_pipeline_services` — L14-qbank: `tests/qbank_executor_e2e.rs:224`
- `dstu_agent_api::budget::TRUNCATION_MARKER` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:952`

## 消费其他 lane

### F4-security（11 个条目，prod 97 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError` | struct | 48/0 | `src/plugins/commands.rs`, `src/plugins/ilink_bot/client.rs`, `src/plugins/ilink_bot/mod.rs` 等 5 个 |
| `dstu_core::models::AppError::validation` | method | 19/0 | `src/plugins/ilink_bot/client.rs`, `src/plugins/ilink_bot/mod.rs`, `src/plugins/manager.rs` 等 4 个 |
| `dstu_core::models::AppError::network` ? | method | 9/0 | `src/plugins/ilink_bot/client.rs` |
| `dstu_core::models::AppError::database` | method | 8/0 | `src/plugins/ilink_bot/mod.rs`, `src/plugins/manager.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 4/1 | `crates/dstu-agent-api/src/context.rs`, `crates/dstu-agent-api/src/executor.rs`, `crates/dstu-agent-api/src/host.rs` 等 4 个 |
| `dstu_core::agent::ToolResultInfo` ? | struct | 2/0 | `crates/dstu-agent-api/src/executor.rs`, `crates/dstu-agent-api/src/host.rs` |
| `dstu_core::models::AppError::configuration` ? | method | 2/0 | `src/plugins/ilink_bot/client.rs`, `src/plugins/ilink_bot/mod.rs` |
| `dstu_platform::background_tasks::BACKGROUND_TASKS` | static | 2/0 | `src/plugins/manager.rs` |
| `dstu_core::agent::block_types::MCP_TOOL` ? | const | 1/0 | `crates/dstu-agent-api/src/descriptor.rs` |
| `dstu_core::models::AppError::internal` | method | 1/0 | `src/plugins/ilink_bot/mod.rs` |
| `dstu_util::qr::qrcode_png_base64` | fn | 1/0 | `src/plugins/ilink_bot/mod.rs` |

### F3-storage（1 个条目，prod 18 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 18/0 | `src/extensions.rs`, `src/plugins/ilink_bot/mod.rs`, `src/plugins/manager.rs` 等 4 个 |

### L05-agent-workspace（24 个条目，prod 17 / test 20）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 2/3 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/legacy_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::file_manager_executor::FileManagerExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::local_shell_preflight_executor::LocalShellPreflightExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::workspace_executor::WorkspaceToolExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::workspace_fs_executor::WorkspaceFsExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::runtime_roots::artifact_root` ? | fn | 1/0 | `src/extensions.rs` |
| `dstu_agent::chat_v2::tools::code_navigation_executor::CodeNavigationExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::file_manager_executor::FileManagerExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::git_executor::GitToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::local_shell_preflight_executor::LocalShellPreflightExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::lsp_navigation_executor::LspNavigationExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::workspace_executor::WorkspaceToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::workspace_fs_executor::WorkspaceFsExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator::new` ? | method | 0/4 | `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/hooks_tests.rs`, `src/agent_wiring/tests/legacy_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::workspace::custom_agents::CHATANKI_READONLY_TOOLS` ? | const | 0/2 | `src/agent_wiring/tests/custom_agent_tests.rs` |
| `dstu_agent::chat_v2::tools::code_navigation_executor::CodeNavigationExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::git_executor::GitToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::lsp_navigation_executor::LspNavigationExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::workspace::custom_agents::find_custom_profile` ? | fn | 0/1 | `src/agent_wiring/tests/custom_agent_tests.rs` |
| `dstu_agent::chat_v2::workspace::custom_agents::safe_tool_set` ? | fn | 0/1 | `src/agent_wiring/tests/custom_agent_tests.rs` |

### L07-agent-skills-ptc（35 个条目，prod 16 / test 33）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor` ? | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor` ? | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::fetch_executor::FetchExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::llm_usage_executor::LlmUsageToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::mcp_propose_executor::McpProposeExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::skill_install_executor::SkillInstallExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::workbench_executor::WorkbenchToolExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::build_tool_registry` ? | fn | 0/5 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LEGACY_PROVIDER_ID` ? | const | 0/3 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyToolProvider::new` ? | method | 0/3 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::connector_executor::ConnectorToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor::new` ? | method | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyExecutorAdapter` ? | struct | 0/1 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyExecutorAdapter::wrap` ? | method | 0/1 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::LegacyToolProvider` ? | struct | 0/1 | `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::mcp_manage_executor::McpManageExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor::new` ? | method | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::ptc_runtime::PTC_ALLOWED_TOOLS` ? | const | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::skill_install_executor::SkillInstallExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::skill_lifecycle_executor::SkillLifecycleExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::workbench_executor::WorkbenchToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L06-agent-orchestration（33 个条目，prod 16 / test 23）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor` ? | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor` ? | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor::new` ? | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor::new` ? | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `dstu_agent::chat_v2::headless::run_headless_agent_turn` ? | fn | 1/0 | `src/plugins/ilink_bot/mod.rs` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::goal_executor::GoalExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::role_pack_executor::RolePackExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::self_inspect_executor::SelfInspectExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::sleep_executor::CoordinatorSleepExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::super_session_executor::SuperSessionExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::task_audit_executor::TaskAuditExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::TodoListExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::TodoListExecutor` ? | struct | 0/2 | `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::automations::trusted_profile_supported_extra_tools` ? | fn | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::headless::headless_allowed_tools` ? | fn | 0/1 | `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::headless::HEADLESS_BLOCKED_TOOLS` ? | const | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::headless::LEGACY_HEADLESS_ALLOWED_TOOLS` ? | const | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::goal_executor::GoalExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::role_pack_executor::RolePackExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::self_inspect_executor::SelfInspectExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::sleep_executor::CoordinatorSleepExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::super_session_executor::SuperSessionExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::task_audit_executor::TaskAuditExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor::new` ? | method | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L22-app-commands（1 个条目，prod 15 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::commands::AppState` | struct | 15/0 | `src/extensions.rs`, `src/plugins/manager.rs`, `src/plugins/types.rs` |

### L17-memory-research（16 个条目，prod 14 / test 10）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::learning_overview_executor::LearningOverviewExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `deep_student_lib::chat_v2::tools::memory_executor::MemoryToolExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `deep_student_lib::chat_v2::tools::academic_search_executor::AcademicSearchExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::knowledge_executor::KnowledgeExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_memory::memory::delete_hook::install_vfs_hooks` | fn | 1/0 | `src/extensions.rs` |
| `dstu_memory::memory::learner_profile::merge_profile_json_for_sync` | fn | 1/0 | `src/extensions.rs` |
| `dstu_memory::memory::mastery_hook::install_mastery_hooks` | fn | 1/0 | `src/extensions.rs` |
| `dstu_research::insight::repo::bump_stat` ? | fn | 1/0 | `src/agent_wiring/plugins.rs` |
| `deep_student_lib::chat_v2::tools::insight_recall_executor::InsightRecallExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::paper_save_executor::PaperSaveExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L18-media-docs（18 个条目，prod 14 / test 8）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::image_generation_executor::ImageGenerationExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::media_executor::MediaToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::office_fidelity_executor::OfficeFidelityExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::textbook_pdf_executor::TextbookPdfToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::media::install_media_host` | fn | 1/0 | `src/extensions.rs` |
| `dstu_media::media::transcriber_hook::install_vfs_hooks` ? | fn | 1/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::document_processing_executor::DocumentProcessingExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::docx_executor::DocxToolExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::pptx_executor::PptxToolExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::xlsx_executor::XlsxToolExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L14-qbank（11 个条目，prod 11 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_qbank::runtime::QbankState` | struct | 3/0 | `src/extensions.rs` |
| `dstu_qbank::question_bank_service::QuestionBankService` ? | struct | 2/0 | `src/agent_wiring/services.rs` |
| `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_qbank::question_export_service::vfs_hook::install_vfs_hooks` | fn | 1/0 | `src/extensions.rs` |
| `dstu_qbank::runtime::provide_state_resolver` | fn | 1/0 | `src/extensions.rs` |
| `dstu_qbank::runtime::QbankStateResolver` | trait | 1/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::review_executor::ReviewToolExecutor` | struct | 0/2 | `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::essay_grading_executor::EssayGradingExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::qbank_executor::QBankExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L04-chat-session（8 个条目，prod 9 / test 18）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::task_command::RemoteTaskManager` ? | struct | 3/0 | `src/plugins/ilink_bot/mod.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 2/7 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` 等 5 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 2/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS` ? | static | 1/5 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/legacy_tests.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::AttachmentStageExecutor::new` ? | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry::from_vec` ? | method | 0/2 | `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `dstu_agent::chat_v2::tool_descriptors::lookup` ? | fn | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::AttachmentStageExecutor` ? | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L10-notes（8 个条目，prod 9 / test 7）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_notes::notes_manager::NotesManager` | struct | 3/0 | `src/agent_wiring/plugins.rs`, `src/agent_wiring/services.rs` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/legacy_tests.rs` |
| `deep_student_lib::chat_v2::tools::canvas_executor::CanvasToolExecutor::new` | method | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs`, `src/agent_wiring/tests/legacy_tests.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::notes_import_executor::NotesImportExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::user_todo_executor::UserTodoExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_vfs::vfs::repos::note_revision_repo::install_storage_hooks` | fn | 1/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::notes_import_executor::NotesImportExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L13-vfs-api（10 个条目，prod 8 / test 9）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::builtin_resource_executor::BuiltinResourceExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::BuiltinRetrievalExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::dstu_executor::DstuToolExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `deep_student_lib::chat_v2::tools::attachment_executor::AttachmentToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::builtin_resource_executor::BuiltinResourceExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::builtin_retrieval_executor::BuiltinRetrievalExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::attachment_executor::AttachmentToolExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::generative_ui_executor::GenerativeUiExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L21-backup-governance（6 个条目，prod 8 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_sync::cloud_credentials::SettingsDatabaseProvider` | trait | 2/0 | `src/extensions.rs` |
| `dstu_sync::hooks::SyncFieldMerger` | trait | 2/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::data_governance_executor::DataGovernanceToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_sync::cloud_credentials::register_settings_database_provider` | fn | 1/0 | `src/extensions.rs` |
| `dstu_sync::hooks::register_sync_field_merger` | fn | 1/0 | `src/extensions.rs` |

### L19-mcp-browser（7 个条目，prod 7 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_browser::browser::hooks::DownloadArtifactRoot` | trait | 2/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::index_webpage_executor::IndexWebpageToolExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/hooks_tests.rs` |
| `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_browser::browser::hooks::register_download_artifact_root` | fn | 1/0 | `src/extensions.rs` |
| `dstu_mcp::tools::provide_web_search_fallback` | fn | 1/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::browser_executor::BrowserToolExecutor` | struct | 0/1 | `src/agent_wiring/tests/descriptor_tests.rs` |

### L24-chatanki（7 个条目，prod 7 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::ChatAnkiToolExecutor::new` | method | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/custom_agent_tests.rs` |
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::chatanki_executor::install_agent_hooks` | fn | 1/0 | `src/extensions.rs` |
| `deep_student_lib::chat_v2::tools::fsrs_settings_executor::FsrsSettingsExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::template_executor::TemplateDesignerExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |

### L02-llm-manager（5 个条目，prod 5 / test 3）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor` | struct | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs`, `src/agent_wiring/tests/headless_tests.rs` |
| `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor` | struct | 1/1 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/descriptor_tests.rs` |
| `deep_student_lib::chat_v2::tools::settings_models_executor::SettingsModelsToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `deep_student_lib::chat_v2::tools::translation_executor::TranslationToolExecutor::new` | method | 1/0 | `src/agent_wiring/roster.rs` |
| `dstu_llm::llm_manager::LLMManager` | struct | 1/0 | `src/plugins/types.rs` |

### L03-chat-pipeline（10 个条目，prod 5 / test 15）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::pipeline::roster::ExecutorRoster` ? | trait | 1/2 | `src/agent_wiring/roster.rs`, `src/agent_wiring/tests/legacy_tests.rs`, `src/agent_wiring/tests/roster_tests.rs` |
| `dstu_agent::chat_v2::pipeline::prompt::CanvasNoteSource` ? | trait | 1/0 | `src/agent_wiring/plugins.rs` |
| `dstu_agent::chat_v2::pipeline::prompt::InsightHintProvider` ? | trait | 1/0 | `src/agent_wiring/plugins.rs` |
| `dstu_agent::chat_v2::pipeline::prompt::InsightHintRequest` ? | struct | 1/0 | `src/agent_wiring/plugins.rs` |
| `dstu_agent::chat_v2::pipeline::prompt::register_insight_hint_provider` ? | fn | 1/0 | `src/agent_wiring/plugins.rs` |
| `dstu_agent::chat_v2::pipeline::assemble_registry` ? | fn | 0/5 | `src/agent_wiring/tests/legacy_tests.rs`, `src/agent_wiring/tests/roster_tests.rs` |
| `dstu_agent::chat_v2::pipeline::hooks::approval_manager_required` ? | fn | 0/4 | `src/agent_wiring/tests/hooks_tests.rs` |
| `dstu_agent::chat_v2::pipeline::roster::CoreExecutorRoster` ? | struct | 0/2 | `src/agent_wiring/tests/roster_tests.rs` |
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline` ? | struct | 0/1 | `src/agent_wiring/tests/roster_tests.rs` |
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline::new` ? | method | 0/1 | `src/agent_wiring/tests/roster_tests.rs` |
