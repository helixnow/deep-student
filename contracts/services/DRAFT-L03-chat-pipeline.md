# 跨 lane 服务草稿：L03-chat-pipeline

> 生成文件（`node scripts/electron-migration/services-draft.mjs`），不要手改。这是 `contracts/services/`
> 正式契约的**输入**：提供方 lane 据此设计 `<service>@1` 接口，消费方 lane 据此确认依赖。
>
> 方法：tree-sitter-rust 解析全部 Rust 文件，建立模块树（`mod` 声明 + `#[path]`）与 `use` / `pub use`
> 重导出链；把 (1) `use` 导入、(2) 代码中的限定路径（含 `Type::method`）解析到定义处，定义与引用分属
> 不同 lane 即记一条。值上的方法调用（`x.method()`）需要类型推断，**不统计**——"提供"清单偏少不偏多。
> `?` = 不确定（经 glob 重导出，或定义文件不在模块树内）。计数 = 引用点（导入名在文件中的出现次数）；
> prod / test 按是否位于 `#[cfg(test)]` / `mod tests` / `tests/` 区分。

## 提供给其他 lane（29 个条目，其中 23 个有生产代码引用）

| 条目 | 种类 | 定义 | 消费方（prod/test 引用点） | 签名 |
|---|---|---|---|---|
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline` ? | struct | `crates/dstu-agent/src/chat_v2/pipeline.rs:212` | L04-chat-session 17/0<br>L06-agent-orchestration 4/0<br>L05-agent-workspace 1/0<br>F1-kernel 0/1 | `pub struct ChatV2Pipeline` |
| `dstu_agent::chat_v2::pipeline::helpers::MicrocompactAnchor` | struct | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs:1380` | L04-chat-session 7/2 | `pub(crate) struct MicrocompactAnchor` |
| `dstu_agent::chat_v2::context::citation_ledger_for_reply` ? | fn | `crates/dstu-agent/src/chat_v2/context.rs:180` | L17-memory-research 3/0<br>L13-vfs-api 1/0 | `pub fn citation_ledger_for_reply( session_id: &str, message_id: &str, variant_id: Option<&str>, ) -> Arc<Mutex<CitationLedger>>` |
| `dstu_agent::chat_v2::context::PipelineContext` | struct | `crates/dstu-agent/src/chat_v2/context.rs:279` | L07-agent-skills-ptc 3/0 | `pub struct PipelineContext` |
| `dstu_agent::chat_v2::finalizer::DeclaredArtifact` | struct | `crates/dstu-agent/src/chat_v2/finalizer.rs:133` | L06-agent-orchestration 2/0 | `pub struct DeclaredArtifact` |
| `dstu_agent::chat_v2::pipeline::constants::VariantRetrySpec` ? | struct | `crates/dstu-agent/src/chat_v2/pipeline/constants.rs:109` | L04-chat-session 2/0 | `pub(crate) struct VariantRetrySpec` |
| `dstu_agent::chat_v2::pipeline::tool_loop::merge_frozen_tool_schema_order_baseline` | fn | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs:186` | L04-chat-session 2/0 | `pub(crate) fn merge_frozen_tool_schema_order_baseline( entry: &mut Vec<String>, baseline: &[String], )` |
| `dstu_agent::chat_v2::context::local_shell_contract_for_platform` | fn | `crates/dstu-agent/src/chat_v2/context.rs:45` | L05-agent-workspace 1/4 | `pub(crate) fn local_shell_contract_for_platform(platform: &str) -> LocalShellRuntimeContract` |
| `dstu_agent::chat_v2::pipeline::roster::ExecutorRoster` ? | trait | `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:15` | F1-kernel 1/2 | `pub trait ExecutorRoster: Send + Sync` |
| `dstu_agent::chat_v2::pipeline::ChatV2Pipeline::new` ? | method | `crates/dstu-agent/src/chat_v2/pipeline.rs:292` | F2-shell 1/0<br>F1-kernel 0/1 | `pub fn new( db: Arc<ChatV2Database>, main_db: Option<Arc<MainDatabase>>, anki_db: Option<Arc<MainDatabase>>, vfs_db: Option<Arc<VfsDatabase>>, llm_manager: Arc<LLMManager>, tool_registry: Arc<ToolRegistry>, canvas_note_source: Option<Arc<dyn CanvasNoteSource>>, ) -> Self` |
| `dstu_agent::chat_v2::budget::attach_child_to_tree` | fn | `crates/dstu-agent/src/chat_v2/budget.rs:912` | L04-chat-session 1/0 | `pub fn attach_child_to_tree( parent_session_id: &str, child_session_id: &str, declared: Option<&BudgetSpec>, ) -> ChildBudgetAttachment` |
| `dstu_agent::chat_v2::budget::configure_persistence` | fn | `crates/dstu-agent/src/chat_v2/budget.rs:557` | L04-chat-session 1/0 | `pub fn configure_persistence(chat_v2_pool: ChatV2Pool, main_db_path: PathBuf)` |
| `dstu_agent::chat_v2::budget::restore_budget_ledgers_from_db` | fn | `crates/dstu-agent/src/chat_v2/budget.rs:714` | L04-chat-session 1/0 | `pub fn restore_budget_ledgers_from_db(db: &ChatV2Database)` |
| `dstu_agent::chat_v2::context::CitationLedger` ? | struct | `crates/dstu-agent/src/chat_v2/context.rs:118` | L13-vfs-api 1/0 | `pub struct CitationLedger` |
| `dstu_agent::chat_v2::context::PipelineContext::get_block_type_for_tool_static` | method | `crates/dstu-agent/src/chat_v2/context.rs:899` | L04-chat-session 1/0 | `pub fn get_block_type_for_tool_static(tool_name: &str) -> String` |
| `dstu_agent::chat_v2::pipeline::authority_mode::global_plan_gate_manager` | fn | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:353` | L04-chat-session 1/0 | `pub fn global_plan_gate_manager() -> &'static PlanGateManager` |
| `dstu_agent::chat_v2::pipeline::authority_mode::PlanGateResponse` | struct | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:271` | L04-chat-session 1/0 | `pub struct PlanGateResponse` |
| `dstu_agent::chat_v2::pipeline::authority_mode::requires_tool_approval` | fn | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs:97` | L05-agent-workspace 1/0 | `pub fn requires_tool_approval( state: &SessionAuthorityState, base_sensitivity: Option<ToolSensitivity>, effective_sensitivity: Option<ToolSensitivity>, immutable_command_guard_asks: bool, external_mcp: bool, privilege_escalation: bool, ) -> bool` |
| `dstu_agent::chat_v2::pipeline::managed_vfs_lance_store_for` ? | fn | `crates/dstu-agent/src/chat_v2/pipeline.rs:137` | L17-memory-research 1/0 | `pub fn managed_vfs_lance_store_for(vfs_db: &Arc<VfsDatabase>) -> Option<Arc<VfsLanceStore>>` |
| `dstu_agent::chat_v2::pipeline::prompt::CanvasNoteSource` ? | trait | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:13` | F1-kernel 1/0 | `pub trait CanvasNoteSource: Send + Sync` |
| `dstu_agent::chat_v2::pipeline::prompt::InsightHintProvider` ? | trait | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:28` | F1-kernel 1/0 | `pub trait InsightHintProvider: Send + Sync` |
| `dstu_agent::chat_v2::pipeline::prompt::InsightHintRequest` ? | struct | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:19` | F1-kernel 1/0 | `pub struct InsightHintRequest<'a>` |
| `dstu_agent::chat_v2::pipeline::prompt::register_insight_hint_provider` ? | fn | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs:36` | F1-kernel 1/0 | `pub fn register_insight_hint_provider( provider: Arc<dyn InsightHintProvider>, ) -> Result<Disposer, SlotOccupied>` |
| `dstu_agent::chat_v2::pipeline::assemble_registry` ? | fn | `crates/dstu-agent/src/chat_v2/pipeline.rs:158` | F1-kernel 0/5 | `pub fn assemble_registry( head: Vec<Arc<dyn super::tools::ToolExecutor>>, ) -> Arc<ToolExecutorRegistry>` |
| `dstu_agent::chat_v2::context::CitationLedger::new` ? | method | `crates/dstu-agent/src/chat_v2/context.rs:126` | L17-memory-research 0/1<br>L13-vfs-api 0/3 | `pub fn new() -> Self` |
| `dstu_agent::chat_v2::pipeline::hooks::approval_manager_required` ? | fn | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs:1118` | F1-kernel 0/4 | `pub fn approval_manager_required(sensitivity: Option<ToolSensitivity>) -> bool` |
| `dstu_agent::chat_v2::pipeline::roster::CoreExecutorRoster` ? | struct | `crates/dstu-agent/src/chat_v2/pipeline/roster.rs:31` | F1-kernel 0/2 | `pub struct CoreExecutorRoster` |
| `dstu_agent::chat_v2::context::PipelineContext::new` ? | method | `crates/dstu-agent/src/chat_v2/context.rs:409` | L07-agent-skills-ptc 0/1 | `pub(crate) fn new(request: SendMessageRequest) -> Self` |
| `dstu_agent::chat_v2::pipeline::compaction::apply_compaction_view` | fn | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs:1480` | L04-chat-session 0/1 | `pub fn apply_compaction_view( conn: &rusqlite::Connection, session_id: &str, messages: Vec<ChatMessage>, ) -> (Option<LegacyChatMessage>, Vec<ChatMessage>)` |

### 引用点样例

- `dstu_agent::chat_v2::pipeline::ChatV2Pipeline` — L04-chat-session: `crates/dstu-agent/src/chat_v2/goal/runtime.rs:154`, `crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:61`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:302`, `crates/dstu-agent/src/chat_v2/handlers/send_message.rs:325`；L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/headless.rs:1586`, `crates/dstu-agent/src/chat_v2/super_session/commands.rs:64`, `crates/dstu-agent/src/chat_v2/super_session/inbox.rs:821`, `crates/dstu-agent/src/chat_v2/tools/subagent_executor.rs:254`；L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:342`；F1-kernel: `src/agent_wiring/tests/roster_tests.rs:31`
- `dstu_agent::chat_v2::pipeline::helpers::MicrocompactAnchor` — L04-chat-session: `crates/dstu-agent/src/chat_v2/repo.rs:105`, `crates/dstu-agent/src/chat_v2/repo.rs:114`, `crates/dstu-agent/src/chat_v2/repo.rs:121`, `crates/dstu-agent/src/chat_v2/repo.rs:3201`
- `dstu_agent::chat_v2::context::citation_ledger_for_reply` — L17-memory-research: `src/chat_v2/tools/academic_search_executor.rs:929`, `src/chat_v2/tools/insight_recall_executor.rs:165`, `src/chat_v2/tools/insight_recall_executor.rs:263`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:547`
- `dstu_agent::chat_v2::context::PipelineContext` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/skill_usage.rs:683`, `crates/dstu-agent/src/chat_v2/skill_usage.rs:772`, `crates/dstu-agent/src/chat_v2/skill_usage.rs:1047`
- `dstu_agent::chat_v2::finalizer::DeclaredArtifact` — L06-agent-orchestration: `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:50`, `crates/dstu-agent/src/chat_v2/tools/attempt_completion.rs:138`
- `dstu_agent::chat_v2::pipeline::constants::VariantRetrySpec` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:827`, `crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:856`
- `dstu_agent::chat_v2::pipeline::tool_loop::merge_frozen_tool_schema_order_baseline` — L04-chat-session: `crates/dstu-agent/src/chat_v2/repo.rs:2998`, `crates/dstu-agent/src/chat_v2/repo.rs:3335`
- `dstu_agent::chat_v2::context::local_shell_contract_for_platform` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:265`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:860`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:865`, `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:876`
- `dstu_agent::chat_v2::pipeline::roster::ExecutorRoster` — F1-kernel: `src/agent_wiring/roster.rs:33`, `src/agent_wiring/tests/legacy_tests.rs:16`, `src/agent_wiring/tests/roster_tests.rs:11`
- `dstu_agent::chat_v2::pipeline::ChatV2Pipeline::new` — F1-kernel: `src/agent_wiring/tests/roster_tests.rs:60`；F2-shell: `src/lib.rs:1532`
- `dstu_agent::chat_v2::budget::attach_child_to_tree` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1713`
- `dstu_agent::chat_v2::budget::configure_persistence` — L04-chat-session: `crates/dstu-agent/src/chat_v2/database.rs:95`
- `dstu_agent::chat_v2::budget::restore_budget_ledgers_from_db` — L04-chat-session: `crates/dstu-agent/src/chat_v2/database.rs:96`
- `dstu_agent::chat_v2::context::CitationLedger` — L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:1052`
- `dstu_agent::chat_v2::context::PipelineContext::get_block_type_for_tool_static` — L04-chat-session: `crates/dstu-agent/src/chat_v2/tools/executor.rs:523`
- `dstu_agent::chat_v2::pipeline::authority_mode::global_plan_gate_manager` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2200`
- `dstu_agent::chat_v2::pipeline::authority_mode::PlanGateResponse` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2200`
- `dstu_agent::chat_v2::pipeline::authority_mode::requires_tool_approval` — L05-agent-workspace: `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs:147`
- `dstu_agent::chat_v2::pipeline::managed_vfs_lance_store_for` — L17-memory-research: `src/chat_v2/tools/memory_executor.rs:460`
- `dstu_agent::chat_v2::pipeline::prompt::CanvasNoteSource` — F1-kernel: `src/agent_wiring/plugins.rs:22`
- `dstu_agent::chat_v2::pipeline::prompt::InsightHintProvider` — F1-kernel: `src/agent_wiring/plugins.rs:34`
- `dstu_agent::chat_v2::pipeline::prompt::InsightHintRequest` — F1-kernel: `src/agent_wiring/plugins.rs:43`
- `dstu_agent::chat_v2::pipeline::prompt::register_insight_hint_provider` — F1-kernel: `src/agent_wiring/plugins.rs:168`
- `dstu_agent::chat_v2::pipeline::assemble_registry` — F1-kernel: `src/agent_wiring/tests/legacy_tests.rs:32`, `src/agent_wiring/tests/roster_tests.rs:21`, `src/agent_wiring/tests/roster_tests.rs:76`, `src/agent_wiring/tests/roster_tests.rs:129`
- `dstu_agent::chat_v2::context::CitationLedger::new` — L17-memory-research: `src/chat_v2/tools/academic_search_executor.rs:1057`；L13-vfs-api: `src/chat_v2/tools/builtin_retrieval_executor.rs:1860`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1876`, `src/chat_v2/tools/builtin_retrieval_executor.rs:1885`
- `dstu_agent::chat_v2::pipeline::hooks::approval_manager_required` — F1-kernel: `src/agent_wiring/tests/hooks_tests.rs:55`, `src/agent_wiring/tests/hooks_tests.rs:60`, `src/agent_wiring/tests/hooks_tests.rs:163`, `src/agent_wiring/tests/hooks_tests.rs:179`
- `dstu_agent::chat_v2::pipeline::roster::CoreExecutorRoster` — F1-kernel: `src/agent_wiring/tests/roster_tests.rs:109`, `src/agent_wiring/tests/roster_tests.rs:132`
- `dstu_agent::chat_v2::context::PipelineContext::new` — L07-agent-skills-ptc: `crates/dstu-agent/src/chat_v2/skill_usage.rs:1777`
- `dstu_agent::chat_v2::pipeline::compaction::apply_compaction_view` — L04-chat-session: `crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2278`

## 消费其他 lane

### L04-chat-session（148 个条目，prod 458 / test 557）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::error::ChatV2Error` ? | enum | 53/3 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` 等 9 个 |
| `dstu_agent::chat_v2::types::CanonicalContentPart` | enum | 39/15 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/prompts.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` 等 8 个 |
| `dstu_agent::chat_v2::types::MessageRole` ? | enum | 27/62 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs` 等 10 个 |
| `dstu_agent::chat_v2::error::ChatV2Result` | type | 16/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |
| `dstu_agent::chat_v2::types::ChatMessage` ? | struct | 14/9 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs` 等 7 个 |
| `dstu_agent::chat_v2::types::AuthorityMode` ? | enum | 12/20 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::SendOptions` ? | struct | 12/11 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` 等 6 个 |
| `dstu_agent::chat_v2::types::SessionSkillState` | struct | 12/2 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_block_with_conn` ? | method | 11/20 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 5 个 |
| `dstu_agent::chat_v2::types::ToolFacePrefixSnapshot` | struct | 9/27 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_with_conn` ? | method | 9/15 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::PermissionPreset` ? | enum | 9/12 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::MessageSources` | struct | 8/3 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::database::ChatV2Database` ? | struct | 7/3 | `crates/dstu-agent/src/chat_v2/budget.rs`, `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` 等 4 个 |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter` ? | struct | 7/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::types::SourceInfo` ? | struct | 6/23 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prefix_snapshot_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::McpToolSchema` | struct | 6/9 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::set_session_plan_state` ? | method | 6/5 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::variant_context::VariantExecutionContext` | struct | 6/1 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_agent::chat_v2::resource_types::SendContextRef` | struct | 5/11 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_blocks_with_conn` ? | method | 5/5 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::grants::BudgetSpec` | struct | 5/2 | `crates/dstu-agent/src/chat_v2/budget.rs` |
| `dstu_agent::chat_v2::tools::executor::ToolExecutor` ? | trait | 5/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/roster.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry` ? | struct | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::types::BUILTIN_NAMESPACE` ? | const | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::SendMessageRequest` | struct | 4/25 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` 等 7 个 |
| `dstu_agent::chat_v2::types::SharedContext` ? | struct | 4/3 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` 等 4 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_messages_with_conn` ? | method | 4/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::state::ChatV2State` ? | struct | 4/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::ReplaySkillPayloadSnapshot` | struct | 4/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::types::variant_status::SUCCESS` ? | const | 4/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::database::ChatV2Pool` | type | 4/0 | `crates/dstu-agent/src/chat_v2/budget.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new` ? | method | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::goal_get_with_conn` ? | method | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_agent::chat_v2::types::VariantMeta` | struct | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline/constants.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::user_message_builder::UserMessageParams::new` ? | method | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_authority_state` ? | method | 3/9 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::SessionAuthorityState` | struct | 3/9 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_block_replay_with_conn` ? | method | 3/6 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::types::skill_body_digest` | fn | 3/4 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_digest_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_edit_delete_tests.rs` 等 4 个 |
| `dstu_agent::chat_v2::resource_types::ContextRef` ? | struct | 3/2 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::ModelExecutionSnapshot` | struct | 3/2 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::types::TokenUsage` | struct | 3/2 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::AttachmentInput` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::get_global_app_handle` | fn | 3/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |
| `dstu_agent::chat_v2::types::MessageMeta` ? | struct | 2/16 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` 等 7 个 |
| `dstu_agent::chat_v2::types::SkillInjectionAnchors` | struct | 2/11 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_digest_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_edit_delete_tests.rs` |
| `dstu_agent::chat_v2::repo::BlockReplayData` | struct | 2/6 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_active_compaction_with_conn` ? | method | 2/6 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo` ? | struct | 2/4 | `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::resource_types::ContextSnapshot::new` ? | method | 2/2 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::generate_id` ? | method | 2/2 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::resource_types::ContextSnapshot` ? | struct | 2/1 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::CompactionRecord` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::types::ToolAnchoredSkills` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_edit_delete_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::database::ChatV2PooledConnection` | type | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::goal::format_active_goal_summary` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_agent::chat_v2::kill_switch::AgentKillSwitch` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::advance_session_tool_face_prefix` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_history_blocks_with_replay_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/summary.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::mark_session_available_skills_snapshot_stale_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_message_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::tool_approval_policy::resolve_effective_sensitivity` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::types::ReplayMode` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::types::RESPONSES_FINAL_REASONING_KEY` | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::variant_status::ERROR` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_message_ids_with_conn` ? | method | 1/8 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_message_with_conn` ? | method | 1/5 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::types::TokenUsage::from_estimate` ? | method | 1/3 | `crates/dstu-agent/src/chat_v2/pipeline/token_resources.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::tools::executor_registry::ToolExecutorRegistry::from_vec` ? | method | 1/2 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::TokenUsage::from_api_with_cache` ? | method | 1/2 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::consume_session_plan_binding` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_compaction_with_conn` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_messages_by_ids_with_conn` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::set_session_last_compaction_with_conn` ? | method | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext` ? | struct | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::ChatGenerationPlan` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` |
| `dstu_agent::chat_v2::types::Variant` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::agents_md::load_agents_instructions` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_agent::chat_v2::connector_ledger::session_side_effect_summary` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::goal::emit_goal_updated` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::grants::lookup_grant_for_session` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_microcompact_anchor` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_tool_face_prefix` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::goal_add_usage_with_conn` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::load_session_state_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::set_session_microcompact_anchor` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_block_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_session_skill_state_v2` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::upsert_auto_tags` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/summary.rs` |
| `dstu_agent::chat_v2::shell_command_policy::apply_to_sensitivity` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::shell_command_policy::enforce_for_call` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::shell_command_policy::SETTING_KEY` | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::shell_command_policy::ShellRuleEffect` | enum | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::state::StreamGuard::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::tool_approval_policy::is_external_mcp_call` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::tool_policy::is_tool_allowed_by_execution_policy` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::tools::executor::AdmittedToolDispatcher` ? | trait | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::executor::ExecutionContext::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::CompactionRecord::generate_id` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::types::feature_flags::is_multi_variant_enabled` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::types::SkillStateSnapshot` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::types::TokenUsage::has_tokens` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::TokenUsage::zero` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::types::variant_status::CANCELLED` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::types::Variant::generate_id` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::types::Variant::new_with_id_and_config` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::user_message_builder::build_user_message` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::user_message_builder::UserMessageParams` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::variant_context::ParallelExecutionManager::with_cancel_token` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_with_conn` ? | method | 0/16 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::ChatSession::new` ? | method | 0/16 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_agent::chat_v2::types::ChatMessage::new_assistant` ? | method | 0/13 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_agent::chat_v2::database::ChatV2Database::new` ? | method | 0/10 | `crates/dstu-agent/src/chat_v2/budget.rs`, `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` 等 6 个 |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_block_v2` ? | method | 0/10 | `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_message_v2` ? | method | 0/8 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_windowless_for_test` ? | method | 0/7 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_agent::chat_v2::types::FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY` | const | 0/7 | `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_restore_tests.rs` |
| `dstu_agent::chat_v2::types::ChatMessage::new_user` ? | method | 0/6 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::TokenUsage::from_api` ? | method | 0/6 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::resource_types::ContextRef::new` ? | method | 0/5 | `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::TOOL_FACE_PREFIX_GENERATION_METADATA_KEY` | const | 0/5 | `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_restore_tests.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::create_session_v2` ? | method | 0/4 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::TOOL_SCHEMA_DIGEST_METADATA_KEY` | const | 0/4 | `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_restore_tests.rs` |
| `dstu_agent::chat_v2::events::BackendEvent` | struct | 0/3 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::new_headless` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::types::ChatSession` ? | struct | 0/3 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_block_v2` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_session_v2` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::set_session_permission_preset` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_block_with_conn` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::types::AttachmentMeta` ? | struct | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_agent::chat_v2::types::PlanAuthorityState::new_pending` | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs` |
| `dstu_agent::chat_v2::types::SessionAuthorityState::craft_default` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs` |
| `dstu_agent::chat_v2::types::SessionAuthorityState::from_metadata` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs` |
| `dstu_agent::chat_v2::variant_context::VariantExecutionContext::new` | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_agent::chat_v2::events::ChatV2EventEmitter::with_sink_and_batching` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` |
| `dstu_agent::chat_v2::events::ExecutionEventSink` | trait | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` |
| `dstu_agent::chat_v2::events::SessionEvent` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::clear_block_llm_content_with_conn` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::clear_session_last_compaction_with_conn` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::get_block_with_conn` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::set_session_authority_mode` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::repo::ChatV2Repo::update_session_v2` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::state::ChatV2State::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::types::PlanAuthorityState` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs` |
| `dstu_agent::chat_v2::types::Variant::new` | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |

### F4-security（76 个条目，prod 375 / test 212）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_core::models::ChatMessage` | struct | 28/11 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` 等 8 个 |
| `dstu_core::llm_config::ApiConfig` ? | struct | 23/8 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/test_fixtures.rs` 等 7 个 |
| `dstu_core::agent::MessageBlock` ? | struct | 17/19 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` 等 9 个 |
| `dstu_core::resource_types::ContentBlock` ? | enum | 17/13 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` 等 6 个 |
| `dstu_core::text_escape::escape_xml_content` | fn | 17/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |
| `dstu_core::agent::block_status::SUCCESS` ? | const | 16/20 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/test_fixtures.rs` 等 9 个 |
| `dstu_core::events::event_types::THINKING` ? | const | 14/0 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_core::agent::block_types::CONTENT` ? | const | 13/11 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/prompts.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/test_fixtures.rs` 等 9 个 |
| `dstu_core::events::event_types::CONTENT` ? | const | 13/0 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_core::models::MultimodalContentPart` | enum | 12/8 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs` |
| `dstu_core::agent::MessageBlock::generate_id` ? | method | 11/2 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` 等 5 个 |
| `dstu_util::utils::token_budget::estimate_tokens_with_model` ? | fn | 11/2 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/prompts.rs` |
| `dstu_core::agent::block_types::THINKING` ? | const | 11/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/prompts.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` 等 7 个 |
| `dstu_core::events::event_types::TOOL_CALL` ? | const | 11/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_core::agent::ToolResultInfo` ? | struct | 10/19 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` 等 7 个 |
| `dstu_core::models::DocumentAttachment` | struct | 7/0 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::models::MultimodalContentPart::image` ? | method | 7/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_core::resource_types::ContentBlock::text` ? | method | 7/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenPolicy` ? | enum | 6/6 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/stream_filter_core.rs` 等 5 个 |
| `dstu_core::events::event_types::WEB_SEARCH` ? | const | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenStreamFilter` | struct | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/stream_filter_core.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenStreamFilter::new` ? | method | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs`, `crates/dstu-agent/src/chat_v2/pipeline/stream_filter_core.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_core::models::ToolResult` | struct | 5/8 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` 等 6 个 |
| `dstu_core::events::event_types::MULTIMODAL_RAG` ? | const | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_core::events::event_types::PLAN_GATE` ? | const | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_core::events::event_types::TOOL_APPROVAL_REQUEST` ? | const | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_core::models::MultimodalContentPart::text` ? | method | 5/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` 等 4 个 |
| `dstu_core::models::ToolCall` | struct | 4/7 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` 等 6 个 |
| `dstu_core::agent::block_types::COMPACTION_SUMMARY` ? | const | 4/5 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_core::agent::block_status::ERROR` ? | const | 4/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_core::events::event_types::RAG` ? | const | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_core::agent::block_types::MCP_TOOL` ? | const | 3/4 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` 等 6 个 |
| `dstu_core::task_objects::BatchManifest` | struct | 3/3 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_core::agent::block_types::MEMORY` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::agent::block_types::RAG` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::agent::block_types::WEB_SEARCH` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::events::event_types::WORKSPACE_INJECTION` ? | const | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_util::utils::model_special_tokens::ModelWrapTokenPolicy::for_provider_model` | method | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_core::agent::block_types::WORKSPACE_INJECTION` ? | const | 2/2 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_core::events::event_types::TOOL_CALL_PREPARING` ? | const | 2/2 | `crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` |
| `dstu_core::agent::block_status::RUNNING` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::agent::block_types::ASK_USER` | const | 2/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::agent::block_types::GENERATIVE_UI` | const | 2/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::agent::block_types::IMAGE_GEN` | const | 2/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::agent::block_types::INSIGHT_RECALL` | const | 2/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::agent::block_types::WORKBENCH_OPS` | const | 2/0 | `crates/dstu-agent/src/chat_v2/context.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::canonical_tools::ApiNameSource` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::events::event_types::MEMORY` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_core::events::event_types::TOOL_LIMIT` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_core::tool_names::EXTERNAL_MCP_TOOL_PREFIX` | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::tool_names::strip_tool_namespace` ? | fn | 2/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_core::task_objects::BatchItemStatus` ? | enum | 1/14 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_core::agent::ToolCall` ? | struct | 1/7 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_core::prompt_contracts::LATEX_RULES` | const | 1/4 | `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |
| `dstu_core::agent::block_types::ANKI_CARDS` ? | const | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_core::models::RagSourceInfo` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_core::agent::block_types::ACADEMIC_SEARCH` | const | 1/0 | `crates/dstu-agent/src/chat_v2/context.rs` |
| `dstu_core::agent::block_types::GRAPH` | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_core::agent::block_types::QBANK_QUESTIONS` | const | 1/0 | `crates/dstu-agent/src/chat_v2/context.rs` |
| `dstu_core::agent::block_types::SLEEP` | const | 1/0 | `crates/dstu-agent/src/chat_v2/context.rs` |
| `dstu_core::agent::block_types::SUBAGENT_EMBED` | const | 1/0 | `crates/dstu-agent/src/chat_v2/context.rs` |
| `dstu_core::agent::block_types::TOOL_LIMIT` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_core::agent::block_types::WORKSPACE_SEND` | const | 1/0 | `crates/dstu-agent/src/chat_v2/context.rs` |
| `dstu_core::canonical_tools::CanonicalExternalToolConfig` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::canonical_tools::encode_tool_name_for_api` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::canonical_tools::prepare_external_tool` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::models::AppError` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_core::models::AppError::llm` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_util::utils::token_budget::estimate_tokens` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_core::token_source::TokenSource` ? | enum | 0/11 | `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_core::agent::MessageBlock::new` ? | method | 0/7 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_core::agent::MessageBlock::new_content` ? | method | 0/7 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::agent::MessageBlock::new_tool` ? | method | 0/4 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |
| `dstu_core::agent::ToolCall::new` ? | method | 0/3 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs`, `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |
| `dstu_core::agent::MessageBlock::new_thinking` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_core::task_objects::BatchManifestItem` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |

### L02-llm-manager（20 个条目，prod 49 / test 24）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::llm_manager::routing::llm_error_code` | fn | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_COMPACTION_REQUIRED` | const | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::routing::ParamOverrides` | struct | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::transient_messages::is_transient_skill_message` | fn | 3/13 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs`, `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs`, `crates/dstu-agent/src/chat_v2/pipeline/skill_replay_digest_tests.rs` 等 4 个 |
| `dstu_llm::llm_manager::compaction_budget::TRIGGER_RATIO` | const | 3/2 | `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs` |
| `dstu_llm::llm_manager::OcrRuntimeCandidate` | enum | 3/1 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_llm::llm_manager::model2_pipeline::COMPACTION_CHECKED_CONTEXT_KEY` | const | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::NoopStreamSink` | struct | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::StreamEventSink` | trait | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::WindowStreamSink::new` | method | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::LLMManager` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_llm::llm_manager::effective_api_protocol_for_config` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::LLMStreamHooks` | trait | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` |
| `dstu_llm::llm_manager::routing::LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED` | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::WindowStreamSink` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_llm::llm_manager::transient_messages::is_transient_llm_only_message` | fn | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_llm::llm_manager::ImagePayload` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` |
| `dstu_llm::llm_manager::transient_messages::TRANSIENT_REQUEST_ANCHOR_METADATA_KIND` | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_llm::llm_manager::transient_messages::TRANSIENT_SKILL_METADATA_KIND` | const | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` |
| `dstu_llm::llm_manager::LLMManager::new` ? | method | 0/6 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` 等 4 个 |

### L12-vfs-index（14 个条目，prod 43 / test 37）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::retrieval_planner::ActiveGenerationModel` ? | enum | 11/7 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::retrieval_planner::GenerationRoute` ? | enum | 6/5 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore::new` ? | method | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs`, `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` 等 4 个 |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState::unavailable` | method | 5/3 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState::available` ? | method | 3/7 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::retrieval_planner::QueryModality` | enum | 3/5 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::lance_store::VfsLanceStore` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_vfs::vfs::pdf_processing_service::PdfProcessingService` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilitySnapshot` | struct | 1/4 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::retrieval_planner::plan_generation` | fn | 1/4 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::retrieval_planner::CapabilityState` | struct | 1/1 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_vfs::vfs::multimodal_service::VfsMultimodalService::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_vfs::vfs::retrieval_planner::GenerationPlan` | struct | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` |

### L05-agent-workspace（31 个条目，prod 43 / test 4）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::approval_scope::redact_tool_arguments_for_display` | fn | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::workspace::coordinator::WorkspaceCoordinator` ? | struct | 4/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/roster.rs` |
| `dstu_agent::chat_v2::approval_scope::is_local_shell_execute_tool` | fn | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::approval_scope::make_runtime_scope_key` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::normalized_shell_runtime_location` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::runtime_root_binding_from_args` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::ShellCommandGuardEffect` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager::generate_description` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_manager::ApprovalRequest` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::approval_scope::attach_runtime_root_approval_binding` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::attach_shell_env_policy_facts` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::immutable_shell_command_guard` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::is_privilege_escalation_tool_for_args` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::is_shell_runtime_tool_for_args` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::make_runtime_approval_scope` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::never_remember_approval_for_args` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::approval_scope::ShellCommandGuardDecision` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::runtime_roots::explicit_runtime_root_id_from_args` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::runtime_roots::normalize_runtime_relative_path` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::runtime_roots::resolve_effective_runtime_root_id_for_session` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::runtime_roots::runtime_root_by_id` ? | fn | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::runtime_roots::shell_runtime_approval_binding` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::env_policy_facts` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::tools::local_shell_execute_executor::LocalShellExecuteExecutor::runtime_support_read_roots` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::workspace::injector::InjectionThrottle::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::workspace::types::WorkspaceMessage` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::approval_manager::ApprovalManager::new` ? | method | 0/2 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::approval_manager::ApprovalResponse::approved` | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::shell_sandbox::platform_sandbox_contract` ? | fn | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline_tests.rs` |

### F1-kernel（8 个条目，prod 33 / test 39）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent_api::executor::ToolSensitivity` ? | enum | 24/39 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` 等 4 个 |
| `dstu_agent_api::executor::ToolConcurrency` ? | enum | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent_api::services::Services` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent_api::services::Services::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_kernel::disposer::Disposer` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_kernel::slot::Slot` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_kernel::slot::Slot::new` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_kernel::slot::SlotOccupied` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |

### L06-agent-orchestration（13 个条目，prod 18 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::todo_executor::TodoStatus` | enum | 4/6 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::tools::attempt_completion::TOOL_NAME` | const | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_INIT` ? | const | 2/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::headless::is_trusted_automation_preauthorized` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::headless::validate_trusted_automation_tool_call` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_agent::chat_v2::super_session::prompt::roster_volatile_section` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_agent::chat_v2::super_session::prompt::router_stable_section` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` |
| `dstu_agent::chat_v2::super_session::state::apply_turn_overrides` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::get_todo_list` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::persist_todo_list` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_ADD` | const | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::tools::todo_executor::tool_names::TODO_UPDATE` ? | const | 1/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs` |
| `dstu_agent::chat_v2::tools::tool_pack_executor::ToolPackExecutor::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |

### F3-storage（5 个条目，prod 13 / test 2）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_storage::database::Database` | struct | 8/0 | `crates/dstu-agent/src/chat_v2/finalizer.rs`, `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` |
| `dstu_storage::llm_usage::types::CallerType` ? | enum | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_storage::llm_usage::record_llm_usage_cache_ext` | fn | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_storage::database::Database::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_storage::file_manager::FileManager::new` ? | method | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |

### L07-agent-skills-ptc（10 个条目，prod 11 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_agent::chat_v2::tools::skills_executor::SkillsExecutor::is_load_skills_tool` | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketInstallToolExecutor::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/roster.rs` |
| `dstu_agent::chat_v2::skill_market_client::SkillMarketReadToolExecutor::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/roster.rs` |
| `dstu_agent::chat_v2::skill_usage::on_task_finalized` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::skill_usage::on_turn_committed` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor` ? | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::general_executor::GeneralToolExecutor::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::injector::inject_tool_schemas` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` |
| `dstu_agent::chat_v2::tools::legacy_tool_provider::validate_legacy_registry` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_agent::chat_v2::tools::ptc_executor::PtcExecutor::new` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |

### L17-memory-research（8 个条目，prod 10 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_memory::memory::compaction_flush::FlushExtraction` | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |
| `dstu_memory::memory::config::AutoExtractFrequency` | enum | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` |
| `dstu_memory::memory::config::MemoryConfig::new` | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/persistence.rs`, `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |
| `dstu_memory::memory::compaction_flush::CompactionMemoryFlush` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |
| `dstu_memory::memory::compaction_flush::parse_flush_response` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |
| `dstu_memory::memory::learner_profile::load_profile_from_db` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |
| `dstu_memory::memory::service::MemoryService` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |
| `dstu_memory::memory::test_support::setup_memory_service` | fn | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` |

### L19-mcp-browser（7 个条目，prod 8 / test 6）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_mcp::tools::ToolRegistry` | struct | 2/1 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` |
| `dstu_mcp::tools::web_search::ToolConfig` ? | struct | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_mcp::tools::install_web_search_fallback` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_mcp::tools::web_search::do_search` | fn | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_mcp::tools::web_search::SearchInput` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |
| `dstu_mcp::tools::web_search::ToolConfig::from_env_and_file` ? | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` |
| `dstu_mcp::tools::ToolRegistry::new` ? | method | 0/5 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` 等 4 个 |

### L13-vfs-api（1 个条目，prod 6 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::database::VfsDatabase` | struct | 6/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs`, `crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs`, `crates/dstu-agent/src/chat_v2/prompt_builder.rs` |

### L11-vfs-repos（3 个条目，prod 5 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::get_resource_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs`, `crates/dstu-agent/src/chat_v2/pipeline/history.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo::increment_ref_with_conn` ? | method | 2/0 | `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs`, `crates/dstu-agent/src/chat_v2/pipeline/token_resources.rs` |
| `dstu_vfs::vfs::repos::resource_repo::VfsResourceRepo` | struct | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline.rs` |

### L18-media-docs（1 个条目，prod 3 / test 0）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_docs::document_parser::DocumentParser::new` | method | 3/0 | `crates/dstu-agent/src/chat_v2/pipeline/history.rs`, `crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` |

### L01-llm-providers（2 个条目，prod 1 / test 1）

| 条目 | 种类 | prod/test | 本 lane 引用文件 |
|---|---|---|---|
| `dstu_llm::ocr_adapters::factory::OcrAdapterFactory::infer_engine_from_model` | method | 1/0 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
| `dstu_llm::ocr_adapters::types::OcrEngineType` ? | enum | 0/1 | `crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` |
