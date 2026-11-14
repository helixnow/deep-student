# 跨 lane 服务草稿：L06-agent-orchestration

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（95 个条目，其中 81 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_agent::chat_v2::tools::self_inspect_executor::redact_sensitive_json` | fn | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:505` | L07-agent-skills-ptc 9/0 | `pub fn redact_sensitive_json(value: Value) -> Value` |
| `dstu_agent::chat_v2::tools::todo_executor::TodoStatus` | enum | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:52` | L03-chat-pipeline 4/6 | `pub enum TodoStatus` |
| `dstu_agent::chat_v2::tools::attempt_completion::TOOL_NAME` | const | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:23` | L03-chat-pipeline 2/0<br>L04-chat-session 2/0 | `pub const TOOL_NAME: &str = "attempt_completion"` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_INIT` ? | const | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:38` | L03-chat-pipeline 2/0<br>L04-chat-session 1/2 | `pub const TODO_INIT: &str = "todo_init"` |
| `dstu_agent::chat_v2::headless::HeadlessSessionTurn` | struct | `crates/dstu-agent/src/chat_v2/headless.rs:1237` | L04-chat-session 3/0 | `pub struct HeadlessSessionTurn` |
| `dstu_agent::chat_v2::super_session::state::on_session_removed` | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:800` | L04-chat-session 3/0 | `pub fn on_session_removed(app: &AppHandle, session_id: &str, hard: bool)` |
| `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:213` | L04-chat-session 1/0<br>F1-kernel 1/2 | `pub struct AttemptCompletionExecutor` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:260` | L04-chat-session 1/0<br>F1-kernel 1/1<br>L22-app-commands 0/1 | `pub struct AutomationExecutor` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_UPDATE` ? | const | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:39` | L03-chat-pipeline 1/0<br>L04-chat-session 1/1 | `pub const TODO_UPDATE: &str = "todo_update"` |
| `dstu_agent::chat_v2::automations::automation_app_is_exiting` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:70` | F2-shell 2/0 | `pub fn automation_app_is_exiting() -> bool` |
| `dstu_agent::chat_v2::automations::mark_automation_app_exiting` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:64` | F2-shell 2/0 | `pub fn mark_automation_app_exiting()` |
| `dstu_agent::chat_v2::headless::run_headless_agent_turn` ? | fn | `crates/dstu-agent/src/chat_v2/headless.rs:1381` | L04-chat-session 1/0<br>F1-kernel 1/0 | `pub async fn run_headless_agent_turn( app: &AppHandle, req: HeadlessSessionTurn, ) -> Result<HeadlessTurnOutcome, String>` |
| `dstu_agent::chat_v2::super_session::state::cancel_workers_dispatched_in` | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:853` | L04-chat-session 2/0 | `pub fn cancel_workers_dispatched_in(app: &AppHandle, session_id: &str, message_ids: &[String])` |
| `dstu_agent::chat_v2::tools::attempt_completion::is_attempt_completion` | fn | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:192` | L04-chat-session 2/0 | `pub fn is_attempt_completion(tool_name: &str) -> bool` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_ADD` | const | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:40` | L03-chat-pipeline 1/0<br>L04-chat-session 1/0 | `pub const TODO_ADD: &str = "todo_add"` |
| `dstu_agent::chat_v2::automations::resume_automation_scheduler` | fn | `crates/dstu-agent/src/chat_v2/automations.rs:81` | L04-chat-session 1/5 | `pub fn resume_automation_scheduler()` |
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs:54` | L04-chat-session 1/0<br>F1-kernel 0/1<br>L22-app-commands 0/4 | `pub struct ToolPackExecutor` |
| `dstu_agent::chat_v2::automations::is_automation_scheduler_paused` | fn | `crates/dstu-agent/src/chat_v2/automations.rs:86` | L04-chat-session 1/3 | `pub fn is_automation_scheduler_paused() -> bool` |
| `dstu_agent::chat_v2::automations::pause_automation_scheduler` | fn | `crates/dstu-agent/src/chat_v2/automations.rs:75` | L04-chat-session 1/3 | `pub fn pause_automation_scheduler()` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:130` | L04-chat-session 1/0<br>F1-kernel 0/1<br>L22-app-commands 0/2 | `pub struct SessionToolExecutor` |
| `dstu_agent::chat_v2::headless::headless_allowed_tools` ? | fn | `crates/dstu-agent/src/chat_v2/headless.rs:545` | L05-agent-workspace 1/0<br>F1-kernel 0/1<br>L19-mcp-browser 0/1 | `pub fn headless_allowed_tools() -> Vec<String>` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:144` | L04-chat-session 1/0<br>F1-kernel 0/1<br>L22-app-commands 0/1 | `pub struct AskUserExecutor` |
| `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs:139` | F1-kernel 1/1<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::todo_executor::TodoListExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:476` | L04-chat-session 1/0<br>F1-kernel 0/2 | `pub struct TodoListExecutor` |
| `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:263` | F1-kernel 1/0<br>L22-app-commands 0/1 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:83` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct CustomAgentExecutor` |
| `dstu_agent::chat_v2::tools::goal_executor::GoalExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:124` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct GoalExecutor` |
| `dstu_agent::chat_v2::tools::sleep_executor::CoordinatorSleepExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:27` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct CoordinatorSleepExecutor` |
| `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:167` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct SubagentExecutor` |
| `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:172` | F1-kernel 1/1 | `pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self` |
| `dstu_agent::chat_v2::tools::super_session_executor::SuperSessionExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs:313` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct SuperSessionExecutor` |
| `dstu_agent::chat_v2::tools::task_audit_executor::TaskAuditExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:398` | L04-chat-session 1/0<br>F1-kernel 0/1 | `pub struct TaskAuditExecutor` |
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs:61` | L03-chat-pipeline 1/0<br>F1-kernel 0/1 | `pub fn new(registry_ref: Weak<ToolExecutorRegistry>) -> Self` |
| `dstu_agent::chat_v2::automations::cancel_active_automation_runs_for_emergency_stop` | fn | `crates/dstu-agent/src/chat_v2/automations.rs:3646` | L04-chat-session 1/0 | `pub fn cancel_active_automation_runs_for_emergency_stop()` |
| `dstu_agent::chat_v2::automations::should_keep_automation_background` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:4787` | F2-shell 1/0 | `pub fn should_keep_automation_background(db: &Database) -> bool` |
| `dstu_agent::chat_v2::automations::start_automation_scheduler` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:5568` | F2-shell 1/0 | `pub async fn start_automation_scheduler( database: Arc<Database>, vfs_db: Option<Arc<VfsDatabase>>, app_handle: AppHandle, )` |
| `dstu_agent::chat_v2::headless::create_headless_session` | fn | `crates/dstu-agent/src/chat_v2/headless.rs:1437` | L04-chat-session 1/0 | `pub fn create_headless_session( db: &ChatV2Database, mode: &str, title: &str, metadata: Value, ) -> Result<String, String>` |
| `dstu_agent::chat_v2::headless::DEFAULT_HARD_TIMEOUT_SECS` | const | `crates/dstu-agent/src/chat_v2/headless.rs:416` | L04-chat-session 1/0 | `pub const DEFAULT_HARD_TIMEOUT_SECS: u64 = 600` |
| `dstu_agent::chat_v2::headless::headless_tool_schemas` | fn | `crates/dstu-agent/src/chat_v2/headless.rs:664` | L04-chat-session 1/0 | `pub fn headless_tool_schemas() -> Vec<McpToolSchema>` |
| `dstu_agent::chat_v2::headless::HeadlessSessionMode` | enum | `crates/dstu-agent/src/chat_v2/headless.rs:1169` | L04-chat-session 1/0 | `pub enum HeadlessSessionMode` |
| `dstu_agent::chat_v2::headless::HeadlessTurnRequest` | struct | `crates/dstu-agent/src/chat_v2/headless.rs:1192` | L04-chat-session 1/0 | `pub struct HeadlessTurnRequest` |
| `dstu_agent::chat_v2::headless::HeadlessTurnResult` | struct | `crates/dstu-agent/src/chat_v2/headless.rs:1219` | L04-chat-session 1/0 | `pub struct HeadlessTurnResult` |
| `dstu_agent::chat_v2::headless::is_trusted_automation_preauthorized` | fn | `crates/dstu-agent/src/chat_v2/headless.rs:351` | L03-chat-pipeline 1/0 | `pub fn is_trusted_automation_preauthorized( session_id: &str, tool_name: &str, arguments: &Value, ) -> bool` |
| `dstu_agent::chat_v2::headless::run_headless_turn` | fn | `crates/dstu-agent/src/chat_v2/headless.rs:1275` | L04-chat-session 1/0 | `pub async fn run_headless_turn( app: AppHandle, req: HeadlessTurnRequest, ) -> ChatV2Result<HeadlessTurnResult>` |
| `dstu_agent::chat_v2::headless::validate_trusted_automation_tool_call` | fn | `crates/dstu-agent/src/chat_v2/headless.rs:173` | L03-chat-pipeline 1/0 | `pub fn validate_trusted_automation_tool_call( session_id: &str, tool_name: &str, arguments: &Value, ) -> Result<(), String>` |
| `dstu_agent::chat_v2::super_session::prompt::roster_volatile_section` | fn | `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:210` | L03-chat-pipeline 1/0 | `pub fn roster_volatile_section( _db: &ChatV2Database, _main_db: Option<&Database>, _session_id: &str, workspace_id: &str, ) -> Option<String>` |
| `dstu_agent::chat_v2::super_session::prompt::router_stable_section` | fn | `crates/dstu-agent/src/chat_v2/super_session/prompt.rs:74` | L03-chat-pipeline 1/0 | `pub fn router_stable_section( _db: &ChatV2Database, main_db: Option<&Database>, _session_id: &str, _workspace_id: &str, ) -> Option<String>` |
| `dstu_agent::chat_v2::super_session::state::apply_turn_overrides` | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:897` | L03-chat-pipeline 1/0 | `pub fn apply_turn_overrides( db: &ChatV2Database, main_db: Option<&Database>, request: &mut SendMessageRequest, has_window: bool, )` |
| `dstu_agent::chat_v2::super_session::state::init` ? | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:1026` | F2-shell 1/0 | `pub fn init(app: &AppHandle)` |
| `dstu_agent::chat_v2::super_session::state::is_enabled` ? | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:267` | F2-shell 1/0 | `pub fn is_enabled(app: &AppHandle) -> bool` |
| `dstu_agent::chat_v2::super_session::state::retire_metadata` | fn | `crates/dstu-agent/src/chat_v2/super_session/state.rs:141` | L04-chat-session 1/0 | `pub fn retire_metadata(meta: &mut Value)` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:153` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::ask_user_executor::AskUserResponse` | struct | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:84` | L04-chat-session 1/0 | `pub struct AskUserResponse` |
| `dstu_agent::chat_v2::tools::ask_user_executor::handle_ask_user_response` | fn | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs:121` | L04-chat-session 1/0 | `pub fn handle_ask_user_response(response: AskUserResponse)` |
| `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:216` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::attempt_completion::TOOL_DESCRIPTION` | const | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:26` | L04-chat-session 1/0 | `pub const TOOL_DESCRIPTION: &str = r#"当任务完成时，使用此工具向用户展示最终结果。 这将终止当前的 Agent 循环，不再执行后续工具调用。 只有在确认任务已完成时才应该调用此工具。 如果任务产生了文件产物，result 中应包含产物清单（相对路径 + 一句话用途）， 并同时在 artifacts 参数中显式申报产物（相对路径 + 可选 sha256）； 后端验收器（TaskFinalizer）会核对申报产物真实存在，验收结论写入完成块。"#` |
| `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs:88` | F1-kernel 1/0 | `pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self` |
| `dstu_agent::chat_v2::tools::goal_executor::get_goal_create_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:48` | L04-chat-session 1/0 | `pub fn get_goal_create_schema() -> Value` |
| `dstu_agent::chat_v2::tools::goal_executor::get_goal_get_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:95` | L04-chat-session 1/0 | `pub fn get_goal_get_schema() -> Value` |
| `dstu_agent::chat_v2::tools::goal_executor::get_goal_update_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:73` | L04-chat-session 1/0 | `pub fn get_goal_update_schema() -> Value` |
| `dstu_agent::chat_v2::tools::goal_executor::GoalExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:127` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::goal_executor::tool_names::GOAL_CREATE` | const | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:35` | L04-chat-session 1/0 | `pub const GOAL_CREATE: &str = "goal_create"` |
| `dstu_agent::chat_v2::tools::goal_executor::tool_names::GOAL_GET` | const | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:37` | L04-chat-session 1/0 | `pub const GOAL_GET: &str = "goal_get"` |
| `dstu_agent::chat_v2::tools::goal_executor::tool_names::GOAL_UPDATE` | const | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs:36` | L04-chat-session 1/0 | `pub const GOAL_UPDATE: &str = "goal_update"` |
| `dstu_agent::chat_v2::tools::role_pack_executor::RolePackExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs:26` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::self_inspect_executor::SelfInspectExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:79` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::sleep_executor::CoordinatorSleepExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs:32` | F1-kernel 1/0 | `pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self` |
| `dstu_agent::chat_v2::tools::subagent_executor::build_profile_skill_snapshot` | fn | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:117` | L05-agent-workspace 1/0 | `pub(super) fn build_profile_skill_snapshot( skill_ids: &[String], available: Option<&std::collections::HashMap<String, String>>, ) -> Result<std::collections::HashMap<String, String>, String>` |
| `dstu_agent::chat_v2::tools::subagent_executor::SUBAGENT_TOOL_NAME` | const | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:21` | L04-chat-session 1/0 | `pub const SUBAGENT_TOOL_NAME: &str = "subagent_call"` |
| `dstu_agent::chat_v2::tools::super_session_executor::SuperSessionExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs:319` | F1-kernel 1/0 | `pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self` |
| `dstu_agent::chat_v2::tools::task_audit_executor::TaskAuditExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs:401` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_add_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:421` | L04-chat-session 1/0 | `pub fn get_todo_add_schema() -> Value` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_get_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:446` | L04-chat-session 1/0 | `pub fn get_todo_get_schema() -> Value` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_init_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:356` | L04-chat-session 1/0 | `pub fn get_todo_init_schema() -> Value` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_list` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:187` | L03-chat-pipeline 1/0 | `pub fn get_todo_list(session_id: &str) -> Option<TodoList>` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_update_schema` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:391` | L04-chat-session 1/0 | `pub fn get_todo_update_schema() -> Value` |
| `dstu_agent::chat_v2::tools::todo_executor::load_persisted_todo_list` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:265` | L04-chat-session 1/0 | `pub fn load_persisted_todo_list( db: &ChatV2Database, session_id: &str, ) -> Result<Option<(TodoList, String, Option<String>)>, String>` |
| `dstu_agent::chat_v2::tools::todo_executor::persist_todo_list` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:213` | L03-chat-pipeline 1/0 | `pub fn persist_todo_list( db: &ChatV2Database, session_id: &str, message_id: &str, variant_id: Option<&str>, list: &TodoList, ) -> Result<(), String>` |
| `dstu_agent::chat_v2::tools::todo_executor::restore_todo_list_from_db` | fn | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:339` | L04-chat-session 1/0 | `pub fn restore_todo_list_from_db( db: &ChatV2Database, session_id: &str, ) -> Result<Option<TodoList>, String>` |
| `dstu_agent::chat_v2::tools::todo_executor::TodoListExecutor::new` ? | method | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:479` | F1-kernel 1/0 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_GET` | const | `crates/dstu-agent/src/chat_v2/tools/todo_executor.rs:41` | L04-chat-session 1/0 | `pub const TODO_GET: &str = "todo_get"` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_DELETE` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:32` | L22-app-commands 0/3 | `pub const AUTOMATION_DELETE: &str = "automation_delete"` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_RUN_NOW` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:33` | L22-app-commands 0/3 | `pub const AUTOMATION_RUN_NOW: &str = "automation_run_now"` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_SET_ENABLED` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:30` | L22-app-commands 0/3 | `pub const AUTOMATION_SET_ENABLED: &str = "automation_set_enabled"` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_UPDATE` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:31` | L22-app-commands 0/3 | `pub const AUTOMATION_UPDATE: &str = "automation_update"` |
| `dstu_agent::chat_v2::automations::list_automation_runs` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:2020` | L22-app-commands 0/2 | `pub fn list_automation_runs( db: &Database, automation_id: Option<&str>, limit: usize, ) -> Result<Vec<AutomationRunRecord>>` |
| `dstu_agent::chat_v2::automations::load_automations` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:1270` | L22-app-commands 0/2 | `pub fn load_automations(db: &Database) -> Result<Vec<AutomationDefinition>>` |
| `dstu_agent::chat_v2::headless::LEGACY_HEADLESS_ALLOWED_TOOLS` ? | const | `crates/dstu-agent/src/chat_v2/headless.rs:584` | L04-chat-session 0/1<br>F1-kernel 0/1 | `pub const LEGACY_HEADLESS_ALLOWED_TOOLS: &[&str] = &[ // Agent 元工具（todo_* 经 schema_tool_ids 注入；attempt_completion 是 // control tool 本就绕过白名单，列入仅为语义完整） "attempt_completion", "todo_init", "todo_update", "todo_add", "todo_get", // 检索（BuiltinRetrievalExecutor / FetchExecutor，Low） "builtin-unified_search", "builtin-rag_se...` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_PROPOSE` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:28` | L22-app-commands 0/2 | `pub const AUTOMATION_PROPOSE: &str = "automation_propose"` |
| `dstu_agent::chat_v2::automations::AUTOMATIONS_CHANGED_EVENT` ? | const | `crates/dstu-agent/src/chat_v2/automations.rs:36` | L22-app-commands 0/1 | `pub const AUTOMATIONS_CHANGED_EVENT: &str = "chat_v2://automations_changed"` |
| `dstu_agent::chat_v2::automations::trusted_profile_supported_extra_tools` ? | fn | `crates/dstu-agent/src/chat_v2/automations.rs:490` | F1-kernel 0/1 | `pub fn trusted_profile_supported_extra_tools() -> HashSet<&'static str>` |
| `dstu_agent::chat_v2::headless::HEADLESS_BLOCKED_TOOLS` ? | const | `crates/dstu-agent/src/chat_v2/headless.rs:449` | F1-kernel 0/1 | `pub const HEADLESS_BLOCKED_TOOLS: &[(&str, &str)] = &[ // —— frontend-bridge：GeneralToolExecutor → ToolRegistry::call_frontend_mcp_tool // 经 `mcp-bridge-request` window 事件回前端执行，无 WebView 必死 ("mcp_*", "frontend-bridge"), // —— frontend-bridge：旧 CardForge 前端 CardAgent 桥。执行器 // （anki_executor.rs）与前端监听均已删除（2026-08 死链路清理...` |
| `dstu_agent::chat_v2::tools::automation_executor::tool_names::AUTOMATION_LIST` ? | const | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs:29` | L22-app-commands 0/1 | `pub const AUTOMATION_LIST: &str = "automation_list"` |
| `dstu_agent::chat_v2::tools::role_pack_executor::RolePackExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs:23` | F1-kernel 0/1 | `pub struct RolePackExecutor` |
| `dstu_agent::chat_v2::tools::self_inspect_executor::SelfInspectExecutor` ? | struct | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs:76` | F1-kernel 0/1 | `pub struct SelfInspectExecutor` |

### 引用点样例

- `dstu_agent::chat_v2::tools::self_inspect_executor::redact_sensitive_json` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:298`, `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:735`, `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:751`, `crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs:764`
- `dstu_agent::chat_v2::tools::todo_executor::TodoStatus` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:248`, `crates/dstu-agent/src/chat_v2/finalizer.rs:810`, `crates/dstu-agent/src/chat_v2/finalizer.rs:1363`, `crates/dstu-agent/src/chat_v2/finalizer.rs:1382`
- `dstu_agent::chat_v2::tools::attempt_completion::TOOL_NAME` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:936`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:939`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:140`, `crates/dstu-agent/src/chat_v2/tools/registry.rs:141`
- `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_INIT` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:798`, `crates/dstu-agent/src/chat_v2/finalizer.rs:839`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:154`, `crates/dstu-agent/src/chat_v2/tools/registry.rs:265`, `crates/dstu-agent/src/chat_v2/tools/registry.rs:275`
- `dstu_agent::chat_v2::headless::HeadlessSessionTurn` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:233`, `crates/dstu-agent/src/chat_v2/task_command.rs:920`, `crates/dstu-agent/src/chat_v2/task_command.rs:921`
- `dstu_agent::chat_v2::super_session::state::on_session_removed` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:828`, `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:958`, `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1060`
- `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:122`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:56`, `src/agent_wiring/tests/headless_tests.rs:21`
- `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:123`；F1-kernel: `src/agent_wiring/roster.rs:16`, `src/agent_wiring/tests/descriptor_tests.rs:72`；L22-app-commands: `tests/phase5_tool_execution_e2e.rs:13`
- `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_UPDATE` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:799`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:163`, `crates/dstu-agent/src/chat_v2/tools/registry.rs:266`
- `dstu_agent::chat_v2::automations::automation_app_is_exiting` — F2-shell: `src/lib.rs:1739`, `src/lib.rs:1770`
- `dstu_agent::chat_v2::automations::mark_automation_app_exiting` — F2-shell: `src/lib.rs:1777`, `src/lib.rs:3251`
- `dstu_agent::chat_v2::headless::run_headless_agent_turn` — L04-chat-session: `crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:231`；F1-kernel: `src/plugins/ilink_bot/mod.rs:647`
- `dstu_agent::chat_v2::super_session::state::cancel_workers_dispatched_in` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1055`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1511`
- `dstu_agent::chat_v2::tools::attempt_completion::is_attempt_completion` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:250`, `crates/dstu-agent/src/chat_v2/tool_policy.rs:24`
- `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_ADD` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/finalizer.rs:800`；L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:172`
- `dstu_agent::chat_v2::automations::resume_automation_scheduler` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:283`, `crates/dstu-agent/src/chat_v2/kill_switch.rs:370`, `crates/dstu-agent/src/chat_v2/kill_switch.rs:394`
- `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:150`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:26`；L22-app-commands: `tests/tool_pack_integration_tests.rs:50`, `tests/tool_pack_integration_tests.rs:251`, `tests/tool_pack_integration_tests.rs:268`, `tests/tool_pack_integration_tests.rs:285`
- `dstu_agent::chat_v2::automations::is_automation_scheduler_paused` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:119`, `crates/dstu-agent/src/chat_v2/kill_switch.rs:384`
- `dstu_agent::chat_v2::automations::pause_automation_scheduler` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:206`, `crates/dstu-agent/src/chat_v2/kill_switch.rs:378`
- `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:142`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:92`；L22-app-commands: `tests/session_executor_e2e.rs:7`, `tests/tool_pack_integration_tests.rs:47`
- `dstu_agent::chat_v2::headless::headless_allowed_tools` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs:182`；F1-kernel: `src/agent_wiring/tests/headless_tests.rs:49`；L19-mcp-browser: `src/chat_v2/tools/browser_executor.rs:1427`
- `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:120`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:91`；L22-app-commands: `tests/tool_pack_integration_tests.rs:49`
- `dstu_agent::chat_v2::tools::session_executor::SessionToolExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:80`, `src/agent_wiring/tests/hooks_tests.rs:71`；L22-app-commands: `tests/session_executor_e2e.rs:174`
- `dstu_agent::chat_v2::tools::todo_executor::TodoListExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:149`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:76`, `src/agent_wiring/tests/headless_tests.rs:32`
- `dstu_agent::chat_v2::tools::automation_executor::AutomationExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:60`；L22-app-commands: `tests/phase5_tool_execution_e2e.rs:545`
- `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:126`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:123`
- `dstu_agent::chat_v2::tools::goal_executor::GoalExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:133`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:77`
- `dstu_agent::chat_v2::tools::sleep_executor::CoordinatorSleepExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:145`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:124`
- `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:146`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:121`
- `dstu_agent::chat_v2::tools::subagent_executor::SubagentExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:131`, `src/agent_wiring/tests/hooks_tests.rs:19`
- `dstu_agent::chat_v2::tools::super_session_executor::SuperSessionExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:147`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:122`
- `dstu_agent::chat_v2::tools::task_audit_executor::TaskAuditExecutor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/mod.rs:148`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:63`
- `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor::new` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:176`；F1-kernel: `src/agent_wiring/tests/descriptor_tests.rs:128`
- `dstu_agent::chat_v2::automations::cancel_active_automation_runs_for_emergency_stop` — L04-chat-session: `crates/dstu-agent/src/chat_v2/kill_switch.rs:208`
- `dstu_agent::chat_v2::automations::should_keep_automation_background` — F2-shell: `src/lib.rs:1732`
- `dstu_agent::chat_v2::automations::start_automation_scheduler` — F2-shell: `src/lib.rs:1702`
- `dstu_agent::chat_v2::headless::create_headless_session` — L04-chat-session: `crates/dstu-agent/src/chat_v2/task_command.rs:908`
- `dstu_agent::chat_v2::headless::DEFAULT_HARD_TIMEOUT_SECS` — L04-chat-session: `crates/dstu-agent/src/chat_v2/task_command.rs:926`
- `dstu_agent::chat_v2::headless::headless_tool_schemas` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1206`
- `dstu_agent::chat_v2::headless::HeadlessSessionMode` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:96`
- `dstu_agent::chat_v2::headless::HeadlessTurnRequest` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:96`
- `dstu_agent::chat_v2::headless::HeadlessTurnResult` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:96`
- `dstu_agent::chat_v2::headless::is_trusted_automation_preauthorized` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:719`
- `dstu_agent::chat_v2::headless::run_headless_turn` — L04-chat-session: `crates/dstu-agent/src/chat_v2/mod.rs:96`
- `dstu_agent::chat_v2::headless::validate_trusted_automation_tool_call` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:393`
- `dstu_agent::chat_v2::super_session::prompt::roster_volatile_section` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:164`
- `dstu_agent::chat_v2::super_session::prompt::router_stable_section` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:158`
- `dstu_agent::chat_v2::super_session::state::apply_turn_overrides` — L03-chat-pipeline: `crates/dstu-agent/src/chat_v2/pipeline.rs:573`
- `dstu_agent::chat_v2::super_session::state::init` — F2-shell: `src/lib.rs:1713`
- `dstu_agent::chat_v2::super_session::state::is_enabled` — F2-shell: `src/lib.rs:1738`
- `dstu_agent::chat_v2::super_session::state::retire_metadata` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1455`
- `dstu_agent::chat_v2::tools::ask_user_executor::AskUserExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:79`
- `dstu_agent::chat_v2::tools::ask_user_executor::AskUserResponse` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs:72`
- `dstu_agent::chat_v2::tools::ask_user_executor::handle_ask_user_response` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs:80`
- `dstu_agent::chat_v2::tools::attempt_completion::AttemptCompletionExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:43`
- `dstu_agent::chat_v2::tools::attempt_completion::TOOL_DESCRIPTION` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:142`
- `dstu_agent::chat_v2::tools::custom_agent_executor::CustomAgentExecutor::new` — F1-kernel: `src/agent_wiring/roster.rs:141`
- `dstu_agent::chat_v2::tools::goal_executor::get_goal_create_schema` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:200`
- `dstu_agent::chat_v2::tools::goal_executor::get_goal_get_schema` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:216`
- `dstu_agent::chat_v2::tools::goal_executor::get_goal_update_schema` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/registry.rs:208`
- 其余 35 个条目的引用点见 `draft.json`。

## 消费其他 lane

### L04-chat-session（98 个条目，prod 399 / test 98）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 86/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` 等 14 个 |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 37/6 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/commands.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs` 等 10 个 |
| `dstu_agent::chat_v2::types::PersistStatus` ? | enum | 25/1 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 5 个 |
| `dstu_agent::chat_v2::state::ChatV2State` ? | struct | 17/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/commands.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` 等 6 个 |
| `dstu_agent::chat_v2::types::ChatSession` ? | struct | 16/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::error::ChatV2Error` ? | enum | 15/2 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_v2` ? | method | 14/5 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 4 个 |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 14/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` 等 14 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_session_v2` ? | method | 9/1 | `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage` ? | struct | 9/1 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::McpToolSchema` | struct | 8/6 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/super_session/tools_schema.rs` |
| `dstu_agent::chat_v2::types::SendOptions` ? | struct | 8/2 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 4 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_with_conn` ? | method | 8/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 7/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 7 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_group_with_conn` | method | 7/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::count_sessions_with_conn` | method | 6/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::SuperTurn` | struct | 5/3 | `crates/dstu-agent/src/chat_v2/super_session/mod.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_agent::chat_v2::types::SendMessageRequest` | struct | 5/2 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::MessageRole` ? | enum | 5/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::kill_switch::admit_or_block_from_app` | fn | 4/0 | `crates/dstu-agent/src/chat_v2/automations.rs`, `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::types::ChatSession::generate_id` ? | method | 3/3 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::error::ChatV2Result` | type | 3/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::kill_switch::admit_or_block` | fn | 3/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::add_manual_tag` | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::goal_get_with_conn` ? | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::list_groups_with_conn` | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_session_group_with_conn` | method | 3/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::role_packs::ROLE_PACK_REGISTRY_REVISION` | const | 3/0 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::generate_id` ? | method | 3/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_v2` ? | method | 2/5 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::goal::runtime::settle_active_goal_on_turn_end` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::cancel_workspace_agent_backend` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::list_all_tags` | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::remove_tag` | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::GoalRecord` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::role_packs::RolePack` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_agent::chat_v2::types::SessionGroup` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::get_global_app_handle` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/super_session/prompt.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_agent::chat_v2::types::ChatSession::new` ? | method | 1/5 | `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 1/2 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::delete_session_v2` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::task_audit::AuditApproval` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::task_audit::AuditOutput` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::task_audit::AuditToolCall` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::task_audit::ChangeCoverage` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::task_audit::ConnectorAuditTarget` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::tool_descriptors::BUILTIN_DESCRIPTORS` ? | static | 1/1 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::events::build_goal_updated_payload` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_headless` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::goal::runtime::spawn_goal_continuation_if_idle` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::handlers::ensure_session_writable` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::handlers::send_message::run_send_message_pipeline_owned` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::run_workspace_agent_backend` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::RunAgentRequest` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::RunAgentResponse` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::handlers::workspace_handlers::worker_message_usage` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::kill_switch::KILL_SWITCH_BLOCKED_MESSAGE` | const | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_blocks_batch_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_group_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_with_conn` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_blocks_v2` | method | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_blocks_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_with_conn` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_tags` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_tags_for_sessions` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::goal_insert_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::goal_update_status_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::list_sessions_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::load_session_messages_page_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::load_session_state_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::search_content_with_date_range` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_group_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::role_packs::find_role_pack` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` |
| `dstu_agent::chat_v2::role_packs::role_pack_registry` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` |
| `dstu_agent::chat_v2::role_packs::validate_role_pack_input` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs` |
| `dstu_agent::chat_v2::state::StreamGuard` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::state::StreamGuard::from_registered_token` | method | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::task_audit::TaskAuditManifestBuilder` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::task_audit::TaskAuditManifestBuilder::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::tool_descriptors::is_headless_readonly` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::tools::attachment_stage_executor::resolve_staged_file_in_temp_root` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::SessionGroup::generate_id` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::system_notification::notifications_disabled` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_agent::chat_v2::tool_policy::is_tool_allowed_by_execution_policy` | fn | 0/15 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::state::ChatV2State::new` ? | method | 0/4 | `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_windowless_for_test` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_block_v2` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_v2` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_v2` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_assistant` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_user` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/super_session/mod.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_blocks_v2` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::types::MessageMeta` ? | struct | 0/2 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry::from_vec` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |

### F4-security（29 个条目，prod 262 / test 25）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::AppError::validation` | method | 93/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 29/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` 等 14 个 |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 25/1 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` 等 11 个 |
| `dstu_core::models::AppError::internal` | method | 17/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 15/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` 等 14 个 |
| `dstu_core::models::AppErrorType` | enum | 14/2 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::agent::MessageBlock` ? | struct | 14/1 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_core::agent::ToolResultInfo::failure` ? | method | 12/0 | `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/goal_executor.rs` 等 11 个 |
| `dstu_core::agent::ToolResultInfo::success` ? | method | 12/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` 等 12 个 |
| `dstu_core::models::AppError` | struct | 7/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 6/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_core::tool_args::get_string_array_arg` ? | fn | 4/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_core::task_objects::TaskObjectHandle` ? | struct | 2/2 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_core::models::AppError::with_details` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::tool_args::get_json_array_arg` ? | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_platform::background_tasks::spawn` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 1/2 | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_core::agent::block_status::SUCCESS` ? | const | 1/1 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_core::agent::MessageBlock::generate_id` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_core::agent::ToolResultInfo::cancelled` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_core::models::AppError::database` | method | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::models::AppError::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_core::agent::MessageBlock::new_content` ? | method | 0/5 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_core::agent::MessageBlock::new_tool` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_core::agent::MessageBlock::new_thinking` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_core::task_objects::ObjectCapabilities` ? | struct | 0/2 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_core::task_objects::TaskObjectKind` ? | enum | 0/2 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_core::agent::block_status::ERROR` ? | const | 0/1 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_core::task_objects::ObjectProvenance` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |

### L05-agent-workspace（45 个条目，prod 155 / test 61）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 34/4 | `crates/dstu-agent/src/chat_v2/super_session/commands.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbound.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` 等 10 个 |
| `dstu_agent::chat_v2::workspace::types::AgentStatus` ? | enum | 26/14 | `crates/dstu-agent/src/chat_v2/super_session/inbound.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs` 等 6 个 |
| `dstu_agent::chat_v2::workspace::types::WorkspaceAgent` | struct | 14/1 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 4 个 |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskStatus` ? | enum | 12/5 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` 等 4 个 |
| `dstu_agent::chat_v2::workspace::types::AgentRole` ? | enum | 9/15 | `crates/dstu-agent/src/chat_v2/super_session/inbound.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs` 等 6 个 |
| `dstu_agent::chat_v2::workspace::types::MessageType` ? | enum | 9/2 | `crates/dstu-agent/src/chat_v2/super_session/inbound.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData` | struct | 4/2 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 5 个 |
| `dstu_agent::chat_v2::workspace::sleep_manager::WakeCondition` | enum | 4/0 | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_agent::chat_v2::workspace::subagent_task::SubagentTaskData::new` ? | method | 2/5 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs`, `crates/dstu-agent/src/chat_v2/super_session/prompt.rs`, `crates/dstu-agent/src/chat_v2/super_session/state.rs` 等 5 个 |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRoot` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::RuntimeRootKind` ? | enum | 2/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::built_in` | method | 2/0 | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::validate_persona_model_config` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::config::MAX_SUBAGENT_DEPTH` | const | 2/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::custom_agents::lock_custom_agent_files` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceStatus` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/super_session/state.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileSelection` | struct | 1/2 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileOverride` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::approval_scope::analyze_shell_command` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/headless.rs` |
| `dstu_agent::chat_v2::runtime_roots::artifact_root` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::ensure_session_runtime_roots` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/state.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::redact_path_for_display` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::remove_session_file_irreversible` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::resolve_group_preferred_runtime_root` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::revalidate_runtime_root` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/task_audit_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_roots_for_session` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::skill_package_runtime_root` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |
| `dstu_agent::chat_v2::runtime_roots::temp_root` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_agent::chat_v2::tools::workspace_executor::WORKSPACE_WORKER_READY_EVENT` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::persist_into_metadata` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve_for_agent` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve_with_custom` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::config::SUBAGENT_WAIT_BUDGET_SECS` | const | 1/0 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |
| `dstu_agent::chat_v2::workspace::emitter::WorkspaceWarningEvent` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepBlockData` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepManager` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepManager::wait_for_wake` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_agent::chat_v2::workspace::sleep_manager::SleepStatus` | enum | 1/0 | `crates/dstu-agent/src/chat_v2/tools/sleep_executor.rs` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceMessage` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator::new` ? | method | 0/5 | `crates/dstu-agent/src/chat_v2/super_session/inbound.rs`, `crates/dstu-agent/src/chat_v2/super_session/mod.rs`, `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` 等 5 个 |
| `dstu_agent::chat_v2::workspace::types::WorkspaceAgent::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/super_session/prompt.rs` |
| `dstu_agent::chat_v2::workspace::agent_profile::AgentProfileResolver::resolve` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs` |

### F3-storage（2 个条目，prod 82 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 82/2 | `crates/dstu-agent/src/chat_v2/automations.rs`, `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` 等 8 个 |
| `dstu_storage::database::Database::new` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/automations.rs`, `crates/dstu-agent/src/chat_v2/super_session/mod.rs` |

### F1-kernel（2 个条目，prod 53 / test 33）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 43/32 | `crates/dstu-agent/src/chat_v2/tools/ask_user_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs`, `crates/dstu-agent/src/chat_v2/tools/automation_executor.rs` 等 14 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 10/1 | `crates/dstu-agent/src/chat_v2/tools/role_pack_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` 等 4 个 |

### L13-vfs-api（7 个条目，prod 13 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 7/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::emit_watch_event` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::dstu::handler_utils::node_converters::note_to_dstu_node` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::dstu::types::DstuWatchEvent::created` | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::vfs::types::VfsCreateNoteParams` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::vfs::types::VfsCreateTodoItemParams` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |

### L03-chat-pipeline（2 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline` ? | struct | 4/0 | `crates/dstu-agent/src/chat_v2/headless.rs`, `crates/dstu-agent/src/chat_v2/super_session/commands.rs`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs` 等 4 个 |
| `dstu_agent::chat_v2::finalizer::DeclaredArtifact` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs` |

### L11-vfs-repos（3 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::create_todo_item_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |
| `dstu_vfs::vfs::repos::todo_repo::VfsTodoRepo::ensure_default_inbox` | method | 1/0 | `crates/dstu-agent/src/chat_v2/automations.rs` |

### L07-agent-skills-ptc（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::skills::is_portable_skill_path_component` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/custom_agent_executor.rs` |
| `dstu_agent::chat_v2::tools::mcp_settings_store::read_mcp_tools_list` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/tools/self_inspect_executor.rs` |

### L10-notes（2 个条目，prod 2 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |
| `dstu_vfs::vfs::repos::note_repo::VfsNoteRepo::create_note_in_folder` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/tools/session_executor.rs` |

### L19-mcp-browser（2 个条目，prod 0 / test 5）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
| `dstu_mcp::tools::ToolRegistry` | struct | 0/2 | `crates/dstu-agent/src/chat_v2/tools/super_session_executor.rs`, `crates/dstu-agent/src/chat_v2/tools/tool_pack_executor.rs` |
