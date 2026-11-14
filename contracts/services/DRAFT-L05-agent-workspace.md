# 跨 lane 服务草稿：L05-agent-workspace

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（154 个条目，其中 139 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:30` | L04-chat-session 34/0<br>L06-agent-orchestration 34/4<br>L20-sync 8/0<br>L21-backup-governance 6/0<br>L03-chat-pipeline 4/0<br>F1-kernel 2/3<br>F2-shell 1/0 | `pub struct WorkspaceCoordinator` |
| `dstu_agent::chat_v2::workspace::types::AgentStatus` ? | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:74` | L06-agent-orchestration 26/14<br>L04-chat-session 19/0 | `pub enum AgentStatus` |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskStatus` ? | enum | `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs:15` | L06-agent-orchestration 12/5<br>L04-chat-session 11/1 | `pub enum SubagentTaskStatus` |
| `dstu_agent::chat_v2::workspace::types::MessageType` ? | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:118` | L04-chat-session 12/0<br>L06-agent-orchestration 9/2 | `pub enum MessageType` |
| `dstu_agent::chat_v2::workspace::types::AgentRole` ? | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:65` | L04-chat-session 11/0<br>L06-agent-orchestration 9/15 | `pub enum AgentRole` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceAgent` | struct | `crates/dstu-agent/src/chat_v2/workspace/types.rs:88` | L06-agent-orchestration 14/1<br>L04-chat-session 2/0 | `pub struct WorkspaceAgent` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:523` | L04-chat-session 4/0<br>L07-agent-skills-ptc 2/0<br>L18-media-docs 2/0<br>L03-chat-pipeline 1/0<br>L06-agent-orchestration 1/0<br>L19-mcp-browser 1/0<br>L13-vfs-api 1/2 | `pub fn normalize_runtime_relative_path(raw: Option<&str>) -> Result<PathBuf, String>` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootKind` ? | enum | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:77` | L19-mcp-browser 5/5<br>L06-agent-orchestration 2/0<br>L18-media-docs 2/0 | `pub enum RuntimeRootKind` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1350` | L18-media-docs 3/0<br>L03-chat-pipeline 1/0<br>L04-chat-session 1/0<br>L07-agent-skills-ptc 1/0<br>L06-agent-orchestration 1/0<br>L19-mcp-browser 1/0<br>L13-vfs-api 1/0 | `pub fn runtime_root_by_id( app: &AppHandle, database: &crate::database::Database, session_id: &str, skill_package_roots: Option<&HashMap<String, String>>, root_id: Option<&str>, create_session_roots: bool, ) -> Result<RuntimeRoot, String>` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager` | struct | `crates/dstu-agent/src/chat_v2/approval_manager.rs:135` | L04-chat-session 5/0<br>L03-chat-pipeline 2/0 | `pub struct ApprovalManager` |
| `dstu_agent::chat_v2::approval_scope::redact_tool_arguments_for_display` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:363` | L03-chat-pipeline 6/0<br>L07-agent-skills-ptc 1/0 | `pub fn redact_tool_arguments_for_display(tool_name: &str, args: &Value) -> Value` |
| `dstu_agent::chat_v2::runtime_roots::artifact_root` ? | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:740` | L07-agent-skills-ptc 3/0<br>L04-chat-session 1/0<br>L06-agent-orchestration 1/0<br>L18-media-docs 1/0<br>F1-kernel 1/0 | `pub fn artifact_root( app: &AppHandle, session_id: &str, create: bool, ) -> Result<RuntimeRoot, String>` |
| `dstu_agent::chat_v2::runtime_roots::temp_root` ? | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:763` | L04-chat-session 3/0<br>L06-agent-orchestration 1/0<br>L24-chatanki 1/0<br>L10-notes 1/0<br>L18-media-docs 1/0 | `pub fn temp_root(app: &AppHandle, session_id: &str, create: bool) -> Result<RuntimeRoot, String>` |
| `dstu_agent::chat_v2::completion_outbox::CompletionDelivery` | struct | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:69` | L04-chat-session 6/4 | `pub struct CompletionDelivery` |
| `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` ? | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1030` | L18-media-docs 3/0<br>L06-agent-orchestration 1/0<br>L19-mcp-browser 1/0<br>L13-vfs-api 1/0 | `pub fn revalidate_runtime_root( database: &crate::database::Database, root: &RuntimeRoot, ) -> Result<PathBuf, String>` |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData` | struct | `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs:31` | L06-agent-orchestration 4/2<br>L04-chat-session 1/0 | `pub struct SubagentTaskData` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::fit_paged_read_to_default_budget` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:219` | L13-vfs-api 4/0 | `pub fn fit_paged_read_to_default_budget( output: &mut Value, content_key: &str, offset: usize, total_bytes: usize, ) -> bool` |
| `dstu_agent::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT` | const | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:18` | L04-chat-session 3/0<br>L06-agent-orchestration 1/0 | `pub const WORKSPACE_WORKER_READY_EVENT: &str = "workspace_worker_ready"` |
| `dstu_agent::chat_v2::workspace::config::MAX_SUBAGENT_DEPTH` | const | `crates/dstu-agent/src/chat_v2/workspace/config.rs:18` | L04-chat-session 2/0<br>L06-agent-orchestration 2/0 | `pub const MAX_SUBAGENT_DEPTH: u32 = 3` |
| `dstu_agent::chat_v2::workspace::custom_agents::lock_custom_agent_files` | fn | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:62` | L04-chat-session 2/0<br>L06-agent-orchestration 2/0 | `pub(crate) fn lock_custom_agent_files() -> Result<MutexGuard<'static, ()>, String>` |
| `dstu_agent::chat_v2::workspace::sleep_manager::WakeCondition` | enum | `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:25` | L06-agent-orchestration 4/0 | `pub enum WakeCondition` |
| `dstu_agent::chat_v2::completion_outbox::CompletionOutbox::new` ? | method | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:152` | L04-chat-session 3/5 | `pub fn new(db: Arc<ChatV2Database>) -> Self` |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData::new` ? | method | `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs:45` | L06-agent-orchestration 2/5<br>L04-chat-session 1/0 | `pub fn new( workspace_id: String, agent_session_id: String, skill_id: Option<String>, initial_task: Option<String>, ) -> Self` |
| `dstu_agent::chat_v2::completion_outbox::CompletionOutbox` | struct | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:147` | L04-chat-session 3/2 | `pub struct CompletionOutbox` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver` | struct | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:187` | L06-agent-orchestration 2/1<br>L04-chat-session 1/1 | `pub struct AgentProfileResolver` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:51` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct LocalShellExecuteExecutor` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::built_in` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:190` | L06-agent-orchestration 2/0<br>L04-chat-session 1/1 | `pub fn built_in(id: &str) -> Option<AgentProfile>` |
| `dstu_agent::chat_v2::approval_scope::is_local_shell_execute_tool` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:141` | L03-chat-pipeline 3/0 | `pub(crate) fn is_local_shell_execute_tool(tool_name: &str, args: &Value) -> bool` |
| `dstu_agent::chat_v2::approval_scope::ShellCommandAnalysis` | struct | `crates/dstu-agent/src/chat_v2/approval_scope.rs:1924` | L04-chat-session 3/0 | `pub struct ShellCommandAnalysis` |
| `dstu_agent::chat_v2::workspace_change_set::MutationKind` ? | enum | `crates/dstu-agent/src/chat_v2/workspace_change_set.rs:20` | L18-media-docs 3/0 | `pub enum MutationKind` |
| `dstu_agent::chat_v2::workspace::config::WORKER_PIPELINE_TIMEOUT_SECS` | const | `crates/dstu-agent/src/chat_v2/workspace/config.rs:11` | L04-chat-session 3/0 | `pub const WORKER_PIPELINE_TIMEOUT_SECS: u64 = 600` |
| `dstu_agent::chat_v2::workspace::emitter::WorkspaceWarningEvent` | struct | `crates/dstu-agent/src/chat_v2/workspace/emitter.rs:143` | L04-chat-session 2/0<br>L06-agent-orchestration 1/0 | `pub struct WorkspaceWarningEvent` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceMessage` | struct | `crates/dstu-agent/src/chat_v2/workspace/types.rs:139` | L04-chat-session 1/0<br>L03-chat-pipeline 1/0<br>L06-agent-orchestration 1/0 | `pub struct WorkspaceMessage` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceStatus` | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:23` | L06-agent-orchestration 2/0<br>L04-chat-session 1/0 | `pub enum WorkspaceStatus` |
| `dstu_agent::chat_v2::tools::file_manager_executor::FileManagerExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs:127` | L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct FileManagerExecutor` |
| `dstu_agent::chat_v2::tools::local_shell_preflight_executor::LocalShellPreflightExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:37` | L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct LocalShellPreflightExecutor` |
| `dstu_agent::chat_v2::tools::workspace_executor::WorkspaceToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:33` | L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct WorkspaceToolExecutor` |
| `dstu_agent::chat_v2::tools::workspace_fs_executor::WorkspaceFsExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs:63` | L04-chat-session 1/0<br>F1-kernel 1/1 | `pub struct WorkspaceFsExecutor` |
| `dstu_agent::chat_v2::approval_scope::analyze_shell_command` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:1955` | L06-agent-orchestration 1/0<br>L04-chat-session 1/0 | `pub fn analyze_shell_command(cmd: &str) -> ShellCommandAnalysis` |
| `dstu_agent::chat_v2::approval_scope::ignores_broad_approval_bypass_for_args` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:348` | L04-chat-session 2/0 | `pub fn ignores_broad_approval_bypass_for_args(tool_name: &str, args: &Value) -> bool` |
| `dstu_agent::chat_v2::approval_scope::make_runtime_scope_key` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:3422` | L03-chat-pipeline 2/0 | `pub fn make_runtime_scope_key(tool_name: &str, args: &Value) -> String` |
| `dstu_agent::chat_v2::approval_scope::never_remember_approval_for_args` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:303` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0 | `pub fn never_remember_approval_for_args(tool_name: &str, args: &Value) -> bool` |
| `dstu_agent::chat_v2::approval_scope::normalized_shell_runtime_location` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:732` | L03-chat-pipeline 2/0 | `pub(crate) fn normalized_shell_runtime_location(args: &Value) -> (String, String)` |
| `dstu_agent::chat_v2::approval_scope::runtime_root_binding_from_args` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:550` | L03-chat-pipeline 2/0 | `pub(crate) fn runtime_root_binding_from_args(args: &Value) -> Option<&str>` |
| `dstu_agent::chat_v2::approval_scope::ShellCommandGuardEffect` | enum | `crates/dstu-agent/src/chat_v2/approval_scope.rs:1943` | L03-chat-pipeline 2/0 | `pub enum ShellCommandGuardEffect` |
| `dstu_agent::chat_v2::runtime_roots::cleanup_session_runtime_roots` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:515` | L04-chat-session 2/0 | `pub fn cleanup_session_runtime_roots(app: &AppHandle, session_id: &str) -> Result<(), String>` |
| `dstu_agent::chat_v2::runtime_roots::ensure_session_runtime_roots` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:805` | L04-chat-session 1/0<br>L06-agent-orchestration 1/0 | `pub fn ensure_session_runtime_roots(app: &AppHandle, session_id: &str) -> Result<(), String>` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRoot` | struct | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:105` | L06-agent-orchestration 2/0 | `pub struct RuntimeRoot` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootAccess` ? | enum | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:89` | L18-media-docs 2/0 | `pub enum RuntimeRootAccess` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxPolicy` ? | struct | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:14` | L24-chatanki 2/0 | `pub struct SandboxPolicy` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve_for_agent` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:336` | L04-chat-session 1/0<br>L06-agent-orchestration 1/0 | `pub fn resolve_for_agent(agent: &WorkspaceAgent) -> Result<AgentProfile, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::validate_persona_model_config` | fn | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:425` | L06-agent-orchestration 2/0 | `pub fn validate_persona_model_config( model_id: &str, configs: &[crate::llm_manager::ApiConfig], ) -> Result<(), String>` |
| `dstu_agent::chat_v2::workspace::card_read_scope::WorkspaceCardReadScopeGuard` ? | struct | `crates/dstu-agent/src/chat_v2/workspace/card_read_scope.rs:51` | L04-chat-session 1/0<br>L24-chatanki 1/0 | `pub struct WorkspaceCardReadScopeGuard` |
| `dstu_agent::chat_v2::workspace::card_read_scope::install_workspace_card_read_scope` ? | fn | `crates/dstu-agent/src/chat_v2/workspace/card_read_scope.rs:66` | L04-chat-session 1/0<br>L24-chatanki 0/10 | `pub fn install_workspace_card_read_scope( worker_session_id: &str, workspace_id: &str, coordinator_session_id: &str, ) -> Result<WorkspaceCardReadScopeGuard, String>` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator::new` ? | method | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:43` | F2-shell 1/0<br>L04-chat-session 0/1<br>L06-agent-orchestration 0/5<br>F1-kernel 0/4 | `pub fn new(workspaces_dir: PathBuf) -> Self` |
| `dstu_agent::chat_v2::completion_outbox::NewCompletionDelivery::now_timestamp` | method | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:133` | L04-chat-session 1/3 | `pub fn now_timestamp() -> String` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager::new` ? | method | `crates/dstu-agent/src/chat_v2/approval_manager.rs:160` | F2-shell 1/0<br>L03-chat-pipeline 0/2 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::completion_outbox::NewCompletionDelivery` | struct | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:118` | L04-chat-session 1/2 | `pub struct NewCompletionDelivery` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxEffectReport` ? | struct | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:56` | L24-chatanki 1/2 | `pub struct SandboxEffectReport` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::page_utf8_text` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:75` | L13-vfs-api 1/2 | `pub fn page_utf8_text(text: &str, offset: usize, max_bytes: usize) -> Result<Utf8Page, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileSelection` | struct | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:178` | L06-agent-orchestration 1/2 | `pub struct AgentProfileSelection` |
| `dstu_agent::chat_v2::completion_outbox::completion_message_exists` | fn | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:349` | L04-chat-session 1/1 | `pub fn completion_message_exists( ws_conn: &rusqlite::Connection, workspace_id: &str, run_id: &str, ) -> Result<bool, String>` |
| `dstu_agent::chat_v2::tools::code_navigation_executor::CodeNavigationExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs:39` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct CodeNavigationExecutor` |
| `dstu_agent::chat_v2::tools::git_executor::GitToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/git_executor.rs:54` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct GitToolExecutor` |
| `dstu_agent::chat_v2::tools::lsp_navigation_executor::LspNavigationExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs:350` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct LspNavigationExecutor` |
| `dstu_agent::chat_v2::tools::shell_sandbox::platform_sandbox_contract` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:79` | L24-chatanki 1/0<br>L03-chat-pipeline 0/1 | `pub const fn platform_sandbox_contract() -> SandboxRuntimeContract` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxCapability` ? | enum | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:50` | L24-chatanki 1/1 | `pub enum SandboxCapability` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::check_expected_hash` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:65` | L13-vfs-api 1/1 | `pub fn check_expected_hash(expected: &str, actual: &str) -> Result<(), String>` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::sha256_hex` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:20` | L13-vfs-api 1/1 | `pub fn sha256_hex(bytes: &[u8]) -> String` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileOverride` | struct | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:166` | L06-agent-orchestration 1/1 | `pub struct AgentProfileOverride` |
| `dstu_agent::chat_v2::workspace::database::WorkspaceDatabase` ? | struct | `crates/dstu-agent/src/chat_v2/workspace/database.rs:222` | L04-chat-session 1/0<br>F3-storage 0/1 | `pub struct WorkspaceDatabase` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager::generate_description` ? | method | `crates/dstu-agent/src/chat_v2/approval_manager.rs:928` | L03-chat-pipeline 1/0 | `pub fn generate_description(tool_name: &str, arguments: &Value) -> String` |
| `dstu_agent::chat_v2::approval_manager::ApprovalRequest` | struct | `crates/dstu-agent/src/chat_v2/approval_manager.rs:31` | L03-chat-pipeline 1/0 | `pub struct ApprovalRequest` |
| `dstu_agent::chat_v2::approval_manager::ApprovalResponse` | struct | `crates/dstu-agent/src/chat_v2/approval_manager.rs:58` | L04-chat-session 1/0 | `pub struct ApprovalResponse` |
| `dstu_agent::chat_v2::approval_scope::attach_runtime_root_approval_binding` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:471` | L03-chat-pipeline 1/0 | `pub(crate) fn attach_runtime_root_approval_binding( args: &Value, binding: &RuntimeRootApprovalBinding, ) -> Result<Value, String>` |
| `dstu_agent::chat_v2::approval_scope::attach_shell_env_policy_facts` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:509` | L03-chat-pipeline 1/0 | `pub(crate) fn attach_shell_env_policy_facts( args: &Value, facts: &crate::chat_v2::tools::local_shell_execute_executor::ShellEnvPolicyFacts, ) -> Result<Value, String>` |
| `dstu_agent::chat_v2::approval_scope::immutable_shell_command_guard` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:2671` | L03-chat-pipeline 1/0 | `pub fn immutable_shell_command_guard( command: &str, cwd: Option<&Path>, protected_roots: &[PathBuf], ) -> ShellCommandGuardDecision` |
| `dstu_agent::chat_v2::approval_scope::is_high_risk_external_mcp_tool` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:147` | L07-agent-skills-ptc 1/0 | `pub(crate) fn is_high_risk_external_mcp_tool(tool_name: &str) -> bool` |
| `dstu_agent::chat_v2::approval_scope::is_privilege_escalation_tool_for_args` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:277` | L03-chat-pipeline 1/0 | `pub fn is_privilege_escalation_tool_for_args(tool_name: &str, args: &Value) -> bool` |
| `dstu_agent::chat_v2::approval_scope::is_shell_runtime_tool_for_args` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:133` | L03-chat-pipeline 1/0 | `pub(crate) fn is_shell_runtime_tool_for_args(tool_name: &str, args: &Value) -> bool` |
| `dstu_agent::chat_v2::approval_scope::make_runtime_approval_scope` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:1373` | L03-chat-pipeline 1/0 | `pub fn make_runtime_approval_scope( tool_name: &str, args: &Value, risk_level: &str, ) -> Option<RuntimeApprovalScope>` |
| `dstu_agent::chat_v2::approval_scope::never_remember_approval` | fn | `crates/dstu-agent/src/chat_v2/approval_scope.rs:289` | L04-chat-session 1/0 | `pub fn never_remember_approval(tool_name: &str) -> bool` |
| `dstu_agent::chat_v2::approval_scope::ShellCommandGuardDecision` | struct | `crates/dstu-agent/src/chat_v2/approval_scope.rs:1950` | L03-chat-pipeline 1/0 | `pub struct ShellCommandGuardDecision` |
| `dstu_agent::chat_v2::runtime_roots::explicit_runtime_root_id_from_args` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1401` | L03-chat-pipeline 1/0 | `pub fn explicit_runtime_root_id_from_args(args: &serde_json::Value) -> Option<String>` |
| `dstu_agent::chat_v2::runtime_roots::redact_path_for_display` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1575` | L06-agent-orchestration 1/0 | `pub fn redact_path_for_display(path: &str) -> String` |
| `dstu_agent::chat_v2::runtime_roots::remove_session_file_irreversible` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:2437` | L06-agent-orchestration 1/0 | `pub(crate) fn remove_session_file_irreversible( root_path: &Path, relative_path: &str, expected_sha256: &str, ) -> Result<(), String>` |
| `dstu_agent::chat_v2::runtime_roots::resolve_effective_runtime_root_id_for_session` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1540` | L03-chat-pipeline 1/0 | `pub fn resolve_effective_runtime_root_id_for_session( app: &AppHandle, main_db: &crate::database::Database, chat_v2_db: Option<&crate::chat_v2::database::ChatV2Database>, session_id: &str, skill_package_roots: Option<&HashMap<String, String>>, explicit: Option<&str>, ) -> String` |
| `dstu_agent::chat_v2::runtime_roots::resolve_group_preferred_runtime_root` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1429` | L06-agent-orchestration 1/0 | `pub fn resolve_group_preferred_runtime_root( db: &crate::chat_v2::database::ChatV2Database, session_id: &str, ) -> Option<GroupPreferredRuntimeRoot>` |
| `dstu_agent::chat_v2::runtime_roots::runtime_roots_for_session` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1660` | L06-agent-orchestration 1/0 | `pub fn runtime_roots_for_session( app: &AppHandle, database: &crate::database::Database, session_id: &str, create_artifact_root: bool, ) -> Result<Vec<RuntimeRoot>, String>` |
| `dstu_agent::chat_v2::runtime_roots::shell_runtime_approval_binding` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1132` | L03-chat-pipeline 1/0 | `pub(crate) fn shell_runtime_approval_binding( app: &AppHandle, database: &crate::database::Database, session_id: &str, skill_package_roots: Option<&HashMap<String, String>>, root_id: Option<&str>, cwd: Option<&str>, support_readable_roots: &[PathBuf], allow_absolute_cwd: bool, ) -> Result<RuntimeRootApprovalBinding,...` |
| `dstu_agent::chat_v2::runtime_roots::skill_package_runtime_root` | fn | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1232` | L06-agent-orchestration 1/0 | `pub fn skill_package_runtime_root(skill_id: &str, raw_path: &str) -> Result<RuntimeRoot, String>` |
| `dstu_agent::chat_v2::runtime_roots::SKILL_TRUST_KEY_PREFIX` | const | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:29` | L07-agent-skills-ptc 1/0 | `pub(crate) const SKILL_TRUST_KEY_PREFIX: &str = "chat_v2.skill_trust."` |
| `dstu_agent::chat_v2::tools::code_navigation_executor::CodeNavigationExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs:48` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::file_manager_executor::FileManagerExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs:136` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::git_executor::GitToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/git_executor.rs:386` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::env_policy_facts` ? | method | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:1196` | L03-chat-pipeline 1/0 | `pub(crate) fn env_policy_facts(args: &Value) -> Result<ShellEnvPolicyFacts, String>` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:160` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::runtime_support_read_roots` ? | method | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs:779` | L03-chat-pipeline 1/0 | `pub(crate) fn runtime_support_read_roots(args: &Value) -> Result<Vec<PathBuf>, String>` |
| `dstu_agent::chat_v2::tools::local_shell_preflight_executor::LocalShellPreflightExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:46` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::lsp_navigation_executor::LspNavigationExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs:361` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs:47` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::shell_sandbox::cleanup_finished_process_group` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:815` | L24-chatanki 1/0 | `pub fn cleanup_finished_process_group(process_id: u32) -> Result<(), String>` |
| `dstu_agent::chat_v2::tools::shell_sandbox::PlatformSandboxBackend::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:169` | L24-chatanki 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::shell_sandbox::SandboxBackend` ? | trait | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:120` | L24-chatanki 1/0 | `pub trait SandboxBackend: Send + Sync` |
| `dstu_agent::chat_v2::tools::shell_sandbox::terminate_process_group` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:779` | L24-chatanki 1/0 | `pub fn terminate_process_group(child: &mut Child) -> Result<(), String>` |
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::maybe_run_helper` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs:2026` | F2-shell 1/0 | `pub fn maybe_run_helper() -> Option<i32>` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::optional_expected_hash` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:57` | L13-vfs-api 1/0 | `pub fn optional_expected_hash(args: &Value) -> Option<String>` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::parse_max_bytes` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:42` | L13-vfs-api 1/0 | `pub fn parse_max_bytes(args: &Value) -> Result<usize, String>` |
| `dstu_agent::chat_v2::tools::utf8_paged_read::parse_offset` ? | fn | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs:30` | L13-vfs-api 1/0 | `pub fn parse_offset(args: &Value) -> Result<usize, String>` |
| `dstu_agent::chat_v2::tools::workspace_executor::get_workspace_tool_schemas` | fn | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:832` | L04-chat-session 1/0 | `pub fn get_workspace_tool_schemas() -> Vec<Value>` |
| `dstu_agent::chat_v2::tools::workspace_executor::WorkspaceToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:38` | F1-kernel 1/0 | `pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self` |
| `dstu_agent::chat_v2::tools::workspace_fs_executor::WorkspaceFsExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs:72` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::vfs_resolver::resolve_context_ref_data_to_content` | fn | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:220` | L04-chat-session 1/0 | `pub fn resolve_context_ref_data_to_content( conn: &Connection, blobs_dir: &Path, ref_data: &VfsContextRefData, is_multimodal: bool, ) -> ResolvedContent` |
| `dstu_agent::chat_v2::vfs_resolver::ResolvedContent` | struct | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:42` | L04-chat-session 1/0 | `pub struct ResolvedContent` |
| `dstu_agent::chat_v2::vfs_resolver::ResolvedContent::new` | method | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs:50` | L04-chat-session 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::workspace_change_set::ChangeSet` ? | struct | `crates/dstu-agent/src/chat_v2/workspace_change_set.rs:45` | L18-media-docs 1/0 | `pub struct ChangeSet` |
| `dstu_agent::chat_v2::workspace_change_set::ChangeSet::single` ? | method | `crates/dstu-agent/src/chat_v2/workspace_change_set.rs:69` | L18-media-docs 1/0 | `pub fn single(receipt: MutationReceipt) -> Self` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::from_metadata` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:323` | L04-chat-session 1/0 | `pub fn from_metadata(metadata: Option<&Value>) -> Result<Option<AgentProfile>, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::persist_into_metadata` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:350` | L06-agent-orchestration 1/0 | `pub fn persist_into_metadata(metadata: Option<Value>, profile: &AgentProfile) -> Value` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve_with_custom` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:275` | L06-agent-orchestration 1/0 | `pub fn resolve_with_custom( selection: AgentProfileSelection, custom_agents_dir: Option<&std::path::Path>, ) -> Result<AgentProfile, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::runtime_config_for_agent` | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:346` | L04-chat-session 1/0 | `pub fn runtime_config_for_agent(agent: &WorkspaceAgent) -> Result<AgentRuntimeConfig, String>` |
| `dstu_agent::chat_v2::workspace::card_read_scope::workspace_card_read_scope` ? | fn | `crates/dstu-agent/src/chat_v2/workspace/card_read_scope.rs:103` | L24-chatanki 1/0 | `pub fn workspace_card_read_scope(session_id: &str) -> Option<WorkspaceCardReadScope>` |
| `dstu_agent::chat_v2::workspace::config::MAX_CONCURRENT_WORKERS` | const | `crates/dstu-agent/src/chat_v2/workspace/config.rs:16` | L04-chat-session 1/0 | `pub const MAX_CONCURRENT_WORKERS: usize = 4` |
| `dstu_agent::chat_v2::workspace::config::SUBAGENT_WAIT_BUDGET_SECS` | const | `crates/dstu-agent/src/chat_v2/workspace/config.rs:21` | L06-agent-orchestration 1/0 | `pub const SUBAGENT_WAIT_BUDGET_SECS: u64 = 750` |
| `dstu_agent::chat_v2::workspace::config::WORKER_PIPELINE_CANCEL_GRACE_SECS` | const | `crates/dstu-agent/src/chat_v2/workspace/config.rs:13` | L04-chat-session 1/0 | `pub const WORKER_PIPELINE_CANCEL_GRACE_SECS: u64 = 30` |
| `dstu_agent::chat_v2::workspace::custom_agents::list_custom_agent_files` | fn | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:405` | L04-chat-session 1/0 | `pub fn list_custom_agent_files(dir: &Path) -> Vec<CustomAgentFileInfo>` |
| `dstu_agent::chat_v2::workspace::injector::InjectionResult` | struct | `crates/dstu-agent/src/chat_v2/workspace/injector.rs:12` | L04-chat-session 1/0 | `pub struct InjectionResult` |
| `dstu_agent::chat_v2::workspace::injector::InjectionThrottle::new` | method | `crates/dstu-agent/src/chat_v2/workspace/injector.rs:32` | L03-chat-pipeline 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::workspace::injector::WorkspaceInjector` | struct | `crates/dstu-agent/src/chat_v2/workspace/injector.rs:46` | L04-chat-session 1/0 | `pub struct WorkspaceInjector` |
| `dstu_agent::chat_v2::workspace::repo::WorkspaceRepo` | struct | `crates/dstu-agent/src/chat_v2/workspace/repo.rs:37` | L04-chat-session 1/0 | `pub struct WorkspaceRepo` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepBlockData` | struct | `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:52` | L06-agent-orchestration 1/0 | `pub struct SleepBlockData` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepManager` | struct | `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:160` | L06-agent-orchestration 1/0 | `pub struct SleepManager` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepManager::wait_for_wake` | method | `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:251` | L06-agent-orchestration 1/0 | `pub async fn wait_for_wake( rx: oneshot::Receiver<WakeUpPayload>, sleep_id: &str, ) -> Result<WakeUpPayload, SleepError>` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepStatus` | enum | `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs:41` | L06-agent-orchestration 1/0 | `pub enum SleepStatus` |
| `dstu_agent::chat_v2::workspace::types::DocumentType` | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:205` | L04-chat-session 1/0 | `pub enum DocumentType` |
| `dstu_agent::chat_v2::workspace::types::MessageStatus` | enum | `crates/dstu-agent/src/chat_v2/workspace/types.rs:130` | L04-chat-session 1/0 | `pub enum MessageStatus` |
| `dstu_agent::chat_v2::workspace::types::Workspace` | struct | `crates/dstu-agent/src/chat_v2/workspace/types.rs:32` | L04-chat-session 1/0 | `pub struct Workspace` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceContext` | struct | `crates/dstu-agent/src/chat_v2/workspace/types.rs:252` | L04-chat-session 1/0 | `pub struct WorkspaceContext` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceDocument` | struct | `crates/dstu-agent/src/chat_v2/workspace/types.rs:214` | L04-chat-session 1/0 | `pub struct WorkspaceDocument` |
| `dstu_agent::chat_v2::completion_outbox::CompletionDeliveryState` | enum | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs:43` | L04-chat-session 0/3 | `pub enum CompletionDeliveryState` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceAgent::new` ? | method | `crates/dstu-agent/src/chat_v2/workspace/types.rs:101` | L06-agent-orchestration 0/3 | `pub fn new(session_id: AgentId, workspace_id: WorkspaceId, role: AgentRole) -> Self` |
| `dstu_agent::chat_v2::workspace::custom_agents::CHATANKI_READONLY_TOOLS` ? | const | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:51` | F1-kernel 0/2 | `pub const CHATANKI_READONLY_TOOLS: [&str; 4] = [ "builtin-chatanki_get_cards", "builtin-chatanki_status", "builtin-chatanki_analyze", "builtin-chatanki_list_templates", ]` |
| `dstu_agent::chat_v2::approval_manager::ApprovalResponse::approved` | method | `crates/dstu-agent/src/chat_v2/approval_manager.rs:84` | L03-chat-pipeline 0/1 | `pub fn approved(session_id: String, tool_call_id: String, tool_name: String) -> Self` |
| `dstu_agent::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs:44` | F1-kernel 0/1 | `pub struct RuntimeRootRequestExecutor` |
| `dstu_agent::chat_v2::tools::shell_sandbox::PlatformSandboxBackend` ? | struct | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs:155` | L24-chatanki 0/1 | `pub struct PlatformSandboxBackend` |
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::helper_arg` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs:76` | L22-app-commands 0/1 | `pub fn helper_arg() -> &'static str` |
| `dstu_agent::chat_v2::tools::shell_sandbox::windows::payload_root` ? | fn | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs:337` | L22-app-commands 0/1 | `pub fn payload_root() -> Result<PathBuf, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve` ? | method | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:258` | L06-agent-orchestration 0/1 | `pub fn resolve(selection: AgentProfileSelection) -> Result<AgentProfile, String>` |
| `dstu_agent::chat_v2::workspace::agent_profile::DEFAULT_PROFILE_ID` | const | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:19` | L04-chat-session 0/1 | `pub const DEFAULT_PROFILE_ID: &str = "default"` |
| `dstu_agent::chat_v2::workspace::agent_profile::EXPLORER_PROFILE_ID` | const | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:21` | L04-chat-session 0/1 | `pub const EXPLORER_PROFILE_ID: &str = "explorer"` |
| `dstu_agent::chat_v2::workspace::agent_profile::WORKER_PROFILE_ID` | const | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs:20` | L04-chat-session 0/1 | `pub const WORKER_PROFILE_ID: &str = "worker"` |
| `dstu_agent::chat_v2::workspace::custom_agents::find_custom_profile` ? | fn | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:373` | F1-kernel 0/1 | `pub fn find_custom_profile(dir: &Path, id: &str) -> Option<AgentProfile>` |
| `dstu_agent::chat_v2::workspace::custom_agents::safe_tool_set` ? | fn | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:181` | F1-kernel 0/1 | `pub fn safe_tool_set() -> HashSet<String>` |
| `dstu_agent::chat_v2::workspace::database::WorkspaceDatabase::new` ? | method | `crates/dstu-agent/src/chat_v2/workspace/database.rs:230` | F3-storage 0/1 | `pub fn new(workspaces_dir: &Path, workspace_id: &str) -> Result<Self, String>` |

### 引用点样例

- `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:252`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:276`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:146`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:307`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:236`, `crates/dstu-agent/src/chat_v2/pipeline.rs:361`, `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:23`, `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:36`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/commands.rs:65`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:414`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:434`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:487`；F1-kernel: `src/agent_wiring/roster.rs:36`, `src/agent_wiring/roster.rs:39`, `src/agent_wiring/tests/descriptor_tests.rs:44`, `src/agent_wiring/tests/legacy_tests.rs:30`；L21-backup-governance: `src/data_governance/commands.rs:469`, `src/data_governance/commands_backup.rs:1071`, `src/data_governance/commands_backup.rs:1137`, `src/data_governance/commands_restore.rs:310`；L20-sync: `src/data_governance/commands_sync.rs:794`, `src/data_governance/commands_sync.rs:799`, `src/data_governance/commands_sync.rs:837`, `src/data_governance/commands_sync.rs:839`；F2-shell: `src/lib.rs:1402`
- `dstu_agent::chat_v2::workspace::types::AgentStatus` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:319`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:402`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1307`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1332`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:789`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:428`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1001`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1043`
- `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskStatus` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:559`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:624`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:1172`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:627`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1001`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1251`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1253`, `crates/dstu-agent/src/chat_v2/super_session/state.rs:26`
- `dstu_agent::chat_v2::workspace::types::MessageType` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:916`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:778`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:909`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:910`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:25`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:447`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:37`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:272`
- `dstu_agent::chat_v2::workspace::types::AgentRole` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:316`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:396`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:698`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1242`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:788`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:424`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:771`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1001`
- `dstu_agent::chat_v2::workspace::types::WorkspaceAgent` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1228`, `crates/dstu-agent/src/chat_v2/mod.rs:145`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:232`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:714`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:112`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:122`
- `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:404`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:527`, `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:572`, `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:992`, `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1116`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs:480`, `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs:207`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:177`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:735`；L13-vfs-api: `src/chat_v2/tools/dstu_executor.rs:288`, `src/chat_v2/tools/dstu_executor.rs:959`, `src/chat_v2/tools/dstu_executor.rs:960`；L18-media-docs: `src/chat_v2/tools/media_executor.rs:341`, `src/chat_v2/tools/office_fidelity_executor.rs:99`
- `dstu_agent::chat_v2::runtime_roots::RuntimeRootKind` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:170`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:786`, `src/chat_v2/tools/browser_executor.rs:1054`, `src/chat_v2/tools/browser_executor.rs:1057`, `src/chat_v2/tools/browser_executor.rs:1304`；L18-media-docs: `src/chat_v2/tools/office_output.rs:8`, `src/chat_v2/tools/office_output.rs:241`
- `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:215`；L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:130`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs:209`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:161`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:744`；L13-vfs-api: `src/chat_v2/tools/dstu_executor.rs:302`；L18-media-docs: `src/chat_v2/tools/media_executor.rs:345`, `src/chat_v2/tools/office_fidelity_executor.rs:104`, `src/chat_v2/tools/office_output.rs:233`
- `dstu_agent::chat_v2::approval_manager::ApprovalManager` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:41`, `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:155`, `crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:180`, `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2159`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:233`, `crates/dstu-agent/src/chat_v2/pipeline.rs:345`
- `dstu_agent::chat_v2::approval_scope::redact_tool_arguments_for_display` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:205`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:286`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:573`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:1300`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/general_executor.rs:71`
- `dstu_agent::chat_v2::runtime_roots::artifact_root` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1775`；L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs:726`, `crates/dstu-agent/src/chat_v2/tools/general_executor.rs:111`, `crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs:345`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:246`；L18-media-docs: `src/chat_v2/tools/media_executor.rs:412`；F1-kernel: `src/extensions.rs:195`
- `dstu_agent::chat_v2::runtime_roots::temp_root` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1399`, `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1620`, `crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1744`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:490`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:4767`；L10-notes: `src/chat_v2/tools/notes_import_executor.rs:98`；L18-media-docs: `src/chat_v2/tools/office_output.rs:266`
- `dstu_agent::chat_v2::completion_outbox::CompletionDelivery` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:185`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:376`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:513`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:535`
- `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:176`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:759`；L13-vfs-api: `src/chat_v2/tools/dstu_executor.rs:311`；L18-media-docs: `src/chat_v2/tools/media_executor.rs:353`, `src/chat_v2/tools/office_fidelity_executor.rs:112`, `src/chat_v2/tools/office_output.rs:247`
- `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:19`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1001`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:123`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:194`, `crates/dstu-agent/src/chat_v2/super_session/state.rs:1072`
- `dstu_agent::chat_v2::tools::utf8_paged_read::fit_paged_read_to_default_budget` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:1376`, `src/chat_v2/tools/builtin_resource_executor.rs:1387`, `src/chat_v2/tools/builtin_resource_executor.rs:1406`, `src/chat_v2/tools/builtin_resource_executor.rs:1418`
- `dstu_agent::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:841`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2002`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2546`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:696`
- `dstu_agent::chat_v2::workspace::config::MAX_SUBAGENT_DEPTH` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:109`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:114`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:489`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:493`
- `dstu_agent::chat_v2::workspace::custom_agents::lock_custom_agent_files` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2770`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2798`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:866`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:973`
- `dstu_agent::chat_v2::workspace::sleep_manager::WakeCondition` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:81`, `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:83`, `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:84`, `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:85`
- `dstu_agent::chat_v2::completion_outbox::CompletionOutbox::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:298`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:900`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:922`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:983`
- `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:786`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:1249`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:275`, `crates/dstu-agent/src/chat_v2/super_session/state.rs:1478`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:354`
- `dstu_agent::chat_v2::completion_outbox::CompletionOutbox` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:262`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:274`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:788`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:853`
- `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver` — L04-chat-session: `crates/dstu-agent/src/chat_v2/grants.rs:681`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1487`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:40`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:1224`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs:283`
- `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:39`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:135`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:114`
- `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::built_in` — L04-chat-session: `crates/dstu-agent/src/chat_v2/grants.rs:729`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2658`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:282`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:302`
- `dstu_agent::chat_v2::approval_scope::is_local_shell_execute_tool` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:174`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:431`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:1176`
- `dstu_agent::chat_v2::approval_scope::ShellCommandAnalysis` — L04-chat-session: `crates/dstu-agent/src/chat_v2/shell_command_policy.rs:152`, `crates/dstu-agent/src/chat_v2/shell_command_policy.rs:168`, `crates/dstu-agent/src/chat_v2/shell_command_policy.rs:234`
- `dstu_agent::chat_v2::workspace_change_set::MutationKind` — L18-media-docs: `src/chat_v2/tools/office_output.rs:15`, `src/chat_v2/tools/office_output.rs:277`, `src/chat_v2/tools/office_output.rs:278`
- `dstu_agent::chat_v2::workspace::config::WORKER_PIPELINE_TIMEOUT_SECS` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1797`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1806`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1817`
- `dstu_agent::chat_v2::workspace::emitter::WorkspaceWarningEvent` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:167`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2235`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:654`
- `dstu_agent::chat_v2::workspace::types::WorkspaceMessage` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:145`；L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:2588`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:232`
- `dstu_agent::chat_v2::workspace::types::WorkspaceStatus` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:145`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/state.rs:26`, `crates/dstu-agent/src/chat_v2/super_session/state.rs:394`
- `dstu_agent::chat_v2::tools::file_manager_executor::FileManagerExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:130`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:101`
- `dstu_agent::chat_v2::tools::local_shell_preflight_executor::LocalShellPreflightExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:136`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:109`
- `dstu_agent::chat_v2::tools::workspace_executor::WorkspaceToolExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:153`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:120`
- `dstu_agent::chat_v2::tools::workspace_fs_executor::WorkspaceFsExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:154`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:98`
- `dstu_agent::chat_v2::approval_scope::analyze_shell_command` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/headless.rs:252`；L04-chat-session: `crates/dstu-agent/src/chat_v2/shell_command_policy.rs:288`
- `dstu_agent::chat_v2::approval_scope::ignores_broad_approval_bypass_for_args` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tool_approval_policy.rs:135`, `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs:458`
- `dstu_agent::chat_v2::approval_scope::make_runtime_scope_key` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:507`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:886`
- `dstu_agent::chat_v2::approval_scope::never_remember_approval_for_args` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:757`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor_registry.rs:461`
- `dstu_agent::chat_v2::approval_scope::normalized_shell_runtime_location` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:1209`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:1236`
- `dstu_agent::chat_v2::approval_scope::runtime_root_binding_from_args` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:504`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:884`
- `dstu_agent::chat_v2::approval_scope::ShellCommandGuardEffect` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:445`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:664`
- `dstu_agent::chat_v2::runtime_roots::cleanup_session_runtime_roots` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:936`, `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:998`
- `dstu_agent::chat_v2::runtime_roots::ensure_session_runtime_roots` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:388`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/state.rs:718`
- `dstu_agent::chat_v2::runtime_roots::RuntimeRoot` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:107`, `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:79`
- `dstu_agent::chat_v2::runtime_roots::RuntimeRootAccess` — L18-media-docs: `src/chat_v2/tools/office_output.rs:8`, `src/chat_v2/tools/office_output.rs:242`
- `dstu_agent::chat_v2::tools::shell_sandbox::SandboxPolicy` — L24-chatanki: `src/chat_v2/tools/chatanki_transform_script.rs:704`, `src/chat_v2/tools/chatanki_transform_script.rs:707`
- `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve_for_agent` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1699`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:348`
- `dstu_agent::chat_v2::workspace::agent_profile::validate_persona_model_config` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:335`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:546`
- `dstu_agent::chat_v2::workspace::card_read_scope::WorkspaceCardReadScopeGuard` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1231`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:1804`
- `dstu_agent::chat_v2::workspace::card_read_scope::install_workspace_card_read_scope` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1244`；L24-chatanki: `src/chat_v2/tools/chatanki_executor.rs:16247`, `src/chat_v2/tools/chatanki_executor.rs:16283`, `src/chat_v2/tools/chatanki_executor.rs:16286`, `src/chat_v2/tools/chatanki_executor.rs:16327`
- `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator::new` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:1066`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/super_session/inbound.rs:768`, `crates/dstu-agent/src/chat_v2/super_session/mod.rs:64`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:1107`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:1086`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:53`, `src/agent_wiring/tests/hooks_tests.rs:20`, `src/agent_wiring/tests/legacy_tests.rs:38`, `src/agent_wiring/tests/roster_tests.rs:26`；F2-shell: `src/lib.rs:1512`
- `dstu_agent::chat_v2::completion_outbox::NewCompletionDelivery::now_timestamp` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:873`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:969`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:1103`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1861`
- `dstu_agent::chat_v2::approval_manager::ApprovalManager::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:4730`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:5099`；F2-shell: `src/lib.rs:1504`
- `dstu_agent::chat_v2::completion_outbox::NewCompletionDelivery` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:859`, `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:1089`, `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1851`
- `dstu_agent::chat_v2::tools::shell_sandbox::SandboxEffectReport` — L24-chatanki: `src/chat_v2/tools/chatanki_transform_script.rs:879`, `src/chat_v2/tools/chatanki_transform_script.rs:1857`, `src/chat_v2/tools/chatanki_transform_script.rs:1858`
- `dstu_agent::chat_v2::tools::utf8_paged_read::page_utf8_text` — L13-vfs-api: `src/chat_v2/tools/builtin_resource_executor.rs:1213`, `src/chat_v2/tools/builtin_resource_executor.rs:5902`, `src/chat_v2/tools/builtin_resource_executor.rs:5907`
- 其余 94 个条目的引用点见 `draft.json`。

## 消费其他 lane

### F4-security（32 个条目，prod 213 / test 17）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::resource_types::ContentBlock` ? | enum | 74/6 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_core::text_escape::escape_xml_content` | fn | 27/3 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 20/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_core::agent::ToolResultInfo` ? | struct | 10/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 10/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 9/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 9/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 8/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 8 个 |
| `dstu_core::agent::MessageBlock::generate_id` ? | method | 4/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_core::events::event_types::WEB_SEARCH` ? | const | 4/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_core::task_objects::BatchItemStatus` ? | enum | 3/2 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::BatchManifestItem` | struct | 3/2 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::events::event_types::CONTENT` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs` |
| `dstu_core::events::event_types::RAG` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_core::task_objects::BatchManifest` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::agent::ToolScope` ? | enum | 2/0 | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs` |
| `dstu_core::events::event_types::IMAGE_GEN` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_core::events::event_types::THINKING` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs` |
| `dstu_core::models::ChatMessage` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs` |
| `dstu_core::task_objects::ObjectCapabilities` ? | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandle` ? | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::TaskObjectKind` ? | enum | 2/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::llm_config::ApiConfig` ? | struct | 1/3 | `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs` |
| `dstu_core::agent::MessageBlock` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_core::agent::ToolResultInfo::failure_with_output` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` |
| `dstu_core::task_objects::DerivedEdge` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::DerivedEdge::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::hash_transform_params` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::ManagedLocator` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::ManagedLocator::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandleBuilder::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` |

### L04-chat-session（28 个条目，prod 148 / test 45）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 50/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_agent::chat_v2::types::SourceInfo` ? | struct | 13/6 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_agent::chat_v2::error::ChatV2Error` ? | enum | 11/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 9/0 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 9 个 |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 8/1 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs`, `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs`, `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` 等 4 个 |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 8/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs`, `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_agent::chat_v2::shell_command_policy::ShellRuleEffect` | enum | 7/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::types::PermissionPreset` ? | enum | 6/12 | `crates/dstu-agent/src/chat_v2/approval_manager.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::error::ChatV2Result` | type | 6/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_agent::chat_v2::types::HostShellExecutionMode` | enum | 4/9 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::types::SessionAuthorityState` | struct | 4/3 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::types::AuthorityMode` ? | enum | 3/8 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::shell_command_policy::enforce_for_call` | fn | 3/2 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::shell_command_policy::SETTING_KEY` | const | 3/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::types::HostShellExecutionMode::from_authority` | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::run_workspace_agent_backend` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::RunAgentRequest` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::delete_session_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_authority_state` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_with_conn` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |
| `dstu_agent::chat_v2::shell_command_policy::apply_to_sensitivity` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::shell_command_policy::ShellPolicyDecision` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::state::ChatV2State` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` |
| `dstu_agent::chat_v2::grants::DELEGATED_GRANT_SCHEMA_VERSION` | const | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs` |
| `dstu_agent::chat_v2::grants::DelegatedGrant` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs` |
| `dstu_agent::chat_v2::grants::ToolScopeExt` | trait | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs` |

### L13-vfs-api（13 个条目，prod 64 / test 11）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::types::VfsResourceRef` | struct | 32/2 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::VfsResourceType` ? | enum | 11/1 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::PdfPreviewJson` | struct | 4/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::types::resolve_pdf_inject_modes` | fn | 2/3 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::ImageInjectMode` | enum | 2/1 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::PdfInjectMode` | enum | 2/1 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::pdf_protocol::windows_comparable_path_text` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs` |
| `dstu_vfs::vfs::ocr_utils::parse_ocr_pages_json` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::VfsContextRefData` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::types::resolve_image_inject_modes` | fn | 1/2 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::error::VfsError` ? | enum | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::types::ResourceInjectModes` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |

### F3-storage（12 个条目，prod 50 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 41/1 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs`, `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` 等 7 个 |
| `dstu_storage::backup_common::DataGovernanceOperationKind` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` |
| `dstu_storage::file_deletion_queue::recover_workspace_deletions` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/workspace/database.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` |
| `dstu_storage::backup_common::DataGovernanceOperationGuard::try_acquire` | method | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` |
| `dstu_storage::file_deletion_queue::cancel_ready_workspace_deletion` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/database.rs` |
| `dstu_storage::file_deletion_queue::finish_workspace_deletion` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/database.rs` |
| `dstu_storage::file_deletion_queue::prepare_workspace_deletion` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/database.rs` |
| `dstu_storage::schema_registry::DatabaseId` ? | enum | 0/2 | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` |
| `dstu_storage::migration::coordinator::MigrationCoordinator::new` | method | 0/1 | `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` |

### F1-kernel（4 个条目，prod 49 / test 31）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 37/21 | `crates/dstu-agent/src/chat_v2/approval_manager.rs`, `crates/dstu-agent/src/chat_v2/approval_scope.rs`, `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs` 等 11 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 10/6 | `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/git_executor.rs` 等 4 个 |
| `dstu_agent_api::budget::DEFAULT_TOOL_RESULT_CHAR_BUDGET` ? | const | 2/3 | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs`, `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs` |
| `dstu_agent_api::budget::apply_tool_result_budget` | fn | 0/1 | `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs` |

### L19-mcp-browser（8 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::mcp::client::Content` | enum | 4/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::mcp::client::ToolResult` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::mcp::global::get_global_mcp_client` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::tools::web_search::do_search` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::tools::web_search::RagSourceInfo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::tools::web_search::SearchInput` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::tools::web_search::ToolConfig` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_mcp::tools::web_search::ToolConfig::from_env_and_file` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |

### L12-vfs-index（6 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::indexing::VfsFullSearchService` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::indexing::VfsFullSearchService::new` | method | 2/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchParams` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::indexing::VfsSearchResult` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |

### L07-agent-skills-ptc（7 个条目，prod 8 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::skills::command_mentions_skills_directory` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::skills::canonicalize_skill_package_root` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs` |
| `dstu_agent::chat_v2::skills::get_allowed_skills_bases` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs` |
| `dstu_agent::chat_v2::tools::mcp_content_materializer::materialize_mcp_tool_output` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_agent::chat_v2::tools::mcp_content_materializer::McpOutputProvenance` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::package_sha256` | method | 1/0 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs` |
| `dstu_agent::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor::read_package_directory` | method | 1/0 | `crates/dstu-agent/src/chat_v2/runtime_roots.rs` |

### L11-vfs-repos（4 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_content_with_conn` | method | 3/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::repos::embedding_repo::MODALITY_TEXT` | const | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_vfs::vfs::repos::file_repo::VfsFileRepo::get_file_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |

### L02-llm-manager（2 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::LLMManager` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` |
| `dstu_llm::llm_manager::LLMStreamHooks` | trait | 1/0 | `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs` |

### L03-chat-pipeline（3 个条目，prod 3 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::context::local_shell_contract_for_platform` | fn | 1/4 | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::pipeline::authority_mode::requires_tool_approval` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` |
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |

### L18-media-docs（2 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | 2/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |
| `dstu_docs::document_parser::DocumentParser` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/vfs_resolver.rs` |

### L06-agent-orchestration（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::headless::headless_allowed_tools` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs` |
| `dstu_agent::chat_v2::tools::subagent_executor::build_profile_skill_snapshot` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` |
