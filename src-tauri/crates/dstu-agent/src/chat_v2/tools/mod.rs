//! Chat V2 工具模块
//!
//! 本模块包含 Chat V2 Pipeline 使用的内置工具，与 MCP 工具分开管理。
//!
//! ## 架构说明（文档 26 + 文档 29）
//!
//! ### 模块结构
//! - `types`: 工具类型定义（ToolDefinition, ToolCategory, ToolExecutionResult）
//! - `registry`: Schema 工具注册表（SchemaToolRegistry）
//! - `canvas_tools`: Canvas 智能笔记工具实现
//! - `executor`: ToolExecutor trait 定义（文档 29 P0-1）
//! - `executor_registry`: 工具执行器注册表（文档 29 P0-1）
//! - `general_executor`: 通用工具执行器（文档 29 P0-1）
//! - `canvas_executor`: Canvas 工具执行器（文档 29 P0-1）
//!
//! ### 工具列表
//! - Canvas 工具：`builtin:note_read`, `builtin:note_append`, `builtin:note_replace`, `builtin:note_set`
//! - Anki 工具：由 ChatAnki 工具集统一提供；旧 `builtin-anki_*` 路径不再暴露给 LLM
//!
//! ## 约束
//! - Canvas 工具必须从参数中获取 `note_id` 和 `subject`（由 Pipeline 通过 SendOptions 传递）
//! - 旧 Anki CardAgent 执行器不得加入生产执行器注册表或 Schema 注入表
//! - 操作后必须发送事件通知前端
//!
//! ## ⚠️ 事件发射要求（2026-01-16 强制）
//!
//! **所有 ToolExecutor 实现必须发射以下事件，否则前端无法实时显示工具调用状态：**
//!
//! | 时机 | 方法 | 说明 |
//! |------|------|------|
//! | 执行开始 | `ctx.emitter.emit_tool_call_start()` | 让前端立即显示工具调用 UI |
//! | 执行成功 | `ctx.emitter.emit_end(event_types::TOOL_CALL, ...)` | 通知前端工具执行完成 |
//! | 执行失败 | `ctx.emitter.emit_error(event_types::TOOL_CALL, ...)` | 通知前端工具执行失败 |
//!
//! 详见 `executor.rs` 中 `ToolExecutor` trait 文档。

// ★ 2026-08 死链路清理：anki_executor（旧 CardForge AnkiToolExecutor，
// 经 anki_tool_call 事件桥接前端 CardAgent）已删除——pipeline 从不注册它，
// 前端 CardAgent 也已不再监听 anki_tool_call。Anki 制卡统一走 chatanki_executor。
// 工具参数/错误载荷辅助已下沉 dstu-core（旧路径 `tools::arg_utils` 保留）
pub use dstu_core::tool_args as arg_utils;
pub mod ask_user_executor; // 🆕 用户提问工具执行器（轻量级问答交互）
pub mod attachment_stage_executor; // 🆕 附件物化工具执行器（附件原始字节 → temp root 路径）
pub mod attempt_completion; // 🆕 任务完成工具（文档 29 P1-4）
pub mod automation_executor; // 🆕 周期自动化提案/列表/启停执行器
pub mod canvas_tools;
pub mod code_navigation_executor; // 跨平台代码搜索与符号提纲
pub mod connector_executor; // First-class connector registry and draft/confirm/commit bridge
pub mod custom_agent_executor; // 🆕 custom_agent_* 自定义子代理 persona 管理（提案+审批两段式）
pub mod executor;
pub mod executor_registry;
pub mod fetch_executor; // 🆕 内置 Web Fetch 工具执行器（参考 @anthropic/mcp-fetch）
pub mod file_manager_executor;
pub mod general_executor;
pub mod git_executor; // 语义 Git 工具组（status/diff/log/branch/commit）
pub mod goal_executor; // 🆕 Goal 模式工具执行器（P0：会话级持久目标）
pub mod injector;
pub mod legacy_tool_provider; // A2：旧 executor 花名册 → dstu-agent-api ToolRegistryBuilder（LegacyToolProvider）
pub mod llm_usage_executor; // Agent-safe local LLM usage reporting
pub mod local_shell_execute_executor;
pub mod local_shell_preflight_executor;
pub mod lsp_navigation_executor; // LSP 语义定义/引用/悬停/文档符号
pub mod mcp_content_materializer; // External MCP image/blob content -> session task files
pub mod mcp_manage_executor; // 🆕 MCP server 修改/启停/删除执行器（update/remove High，set_enabled Medium）
pub mod mcp_propose_executor; // 🆕 MCP server 提案执行器（High 敏感度，secure store 写入）
pub mod mcp_settings_store; // MCP tools.list secure 读写 helper
pub mod ptc_executor; // 🆕 PTC 程序化工具组合执行器（builtin-ptc_run，G05-P1）
pub mod ptc_runtime; // 🆕 PTC Starlark 脚本运行时（白名单 + 预算 + trace）
pub mod registry;
pub mod role_pack_executor; // Versioned professional role pack registry (read-only)
pub mod runtime_root_request_executor; // 🆕 runtime_root_request 授权请求执行器（High，never-remember）
pub mod self_inspect_executor; // 🆕 self_inspect 只读自查工具执行器（脱敏状态概览）
pub mod session_executor; // 🆕 会话管理工具执行器（AI 自主管理会话/分组/标签）
pub mod shell_sandbox;
pub mod skill_install_executor; // 🆕 skill_scan / skill_install 技能包自装执行器
pub mod skill_lifecycle_executor; // 🆕 skill_set_enabled / skill_remove / skill_trust_request 技能生命周期管理
pub mod skill_workshop_executor; // 🆕 skill_workshop_propose / skill_workshop_apply 提案式技能 workshop
pub mod skills_executor; // 🆕 Skills 工具执行器（渐进披露架构）
pub mod sleep_executor;
pub mod subagent_executor;
pub mod super_session_executor; // Super 会话 Router 专用 Worker 编排工具（super_dispatch/message/close/list_worker[s]）
pub mod task_audit_executor; // Audit manifest export and lineage forget governance
pub mod todo_executor;
pub mod tool_pack_executor; // ToolPack parallel executor
pub mod types;
pub mod utf8_paged_read;
pub mod workbench_bridge; // ACR R1-01：工作台桥 RPC（acr_bridge_call）
/// ACR R1-02 提供实现文件 `workbench_executor.rs`；本处仅预留 mod/pub use，避免 R1-01 悬空引用。
pub mod workbench_executor;
pub mod workspace_executor;
pub mod workspace_fs_executor;
// step 10 L5：38 个域执行器（canvas / chatanki / qbank / memory / office 等）留在 app 的
// `src/chat_v2/tools/`，由 app 门面 `pub use dstu_agent::chat_v2::tools::*;` 后逐个声明。

// 重导出工具
pub use canvas_tools::{
    NoteAppendTool, NoteCreateTool, NoteListTool, NoteReadTool, NoteReplaceTool, NoteSearchTool,
    NoteSetTool,
};

/// Office 文档（DOCX/XLSX/PPTX）结构化读取的单文件解析安全上限（50MB）。
///
/// ★ #62/ATT-09：这是"整份文件读入内存解析"的安全阈值，不是附件上传上限
/// （上传上限见 `vfs::repos::attachment_repo`：图片 50MB / 文件 200MB）。
/// 各执行器的超限错误提示必须由本常量派生，禁止再各自硬编码 "50MB" 文案。
pub const OFFICE_DOC_PARSE_MAX_BYTES: usize = 50 * 1024 * 1024;

// 重导出注册表
pub use registry::{get_registry, SchemaToolRegistry};

// 重导出注入器
pub use injector::inject_tool_schemas;

// 重导出类型
pub use types::{
    strip_tool_namespace, ToolCategory, ToolDefinition, ToolExecutionContext, ToolExecutionResult,
};

// 重导出执行器（文档 29 P0-1）
pub use ask_user_executor::AskUserExecutor; // 🆕 用户提问工具执行器
pub use attachment_stage_executor::AttachmentStageExecutor; // 🆕 附件物化工具执行器
pub use attempt_completion::AttemptCompletionExecutor;
pub use automation_executor::AutomationExecutor; // 🆕 周期自动化执行器
pub use code_navigation_executor::CodeNavigationExecutor;
pub use connector_executor::ConnectorToolExecutor;
pub use custom_agent_executor::CustomAgentExecutor; // 🆕 自定义子代理 persona 管理执行器
pub use executor::{AdmittedToolDispatcher, ExecutionContext, ToolExecutor, ToolSensitivity};
pub use executor_registry::{ToolExecutorRegistry, ToolRiskSnapshot};
pub use fetch_executor::FetchExecutor; // 🆕 内置 Web Fetch 工具执行器
pub use file_manager_executor::FileManagerExecutor;
pub use general_executor::GeneralToolExecutor;
pub use git_executor::GitToolExecutor; // 语义 Git 工具组执行器
pub use goal_executor::GoalExecutor; // 🆕 Goal 模式工具执行器（P0）
pub use llm_usage_executor::LlmUsageToolExecutor;
pub use local_shell_execute_executor::LocalShellExecuteExecutor;
pub use local_shell_preflight_executor::LocalShellPreflightExecutor;
pub use lsp_navigation_executor::LspNavigationExecutor;
pub use mcp_manage_executor::McpManageExecutor; // 🆕 MCP server 修改/启停/删除执行器
pub use mcp_propose_executor::McpProposeExecutor; // 🆕 MCP server 提案执行器
pub use ptc_executor::PtcExecutor; // 🆕 PTC 程序化工具组合执行器（G05-P1）
pub use ptc_runtime::{is_ptc_allowed_tool, PTC_ALLOWED_TOOLS}; // PTC 只读工具面白名单
pub use session_executor::SessionToolExecutor; // 🆕 会话管理工具执行器
pub use skill_lifecycle_executor::SkillLifecycleExecutor; // 🆕 技能生命周期管理执行器
pub use skills_executor::SkillsExecutor; // 🆕 Skills 工具执行器
pub use sleep_executor::CoordinatorSleepExecutor;
pub use subagent_executor::{SubagentExecutor, SUBAGENT_TOOL_NAME};
pub use super_session_executor::SuperSessionExecutor;
pub use task_audit_executor::TaskAuditExecutor;
pub use todo_executor::TodoListExecutor;
pub use tool_pack_executor::ToolPackExecutor; // ToolPack parallel executor
pub use workbench_bridge::{acr_bridge_call, AcrBridgeRequest, AcrBridgeResponse, AcrProgress}; // ACR R1-01
pub use workbench_executor::WorkbenchToolExecutor;
pub use workspace_executor::{get_workspace_tool_schemas, WorkspaceToolExecutor};
pub use workspace_fs_executor::WorkspaceFsExecutor;

/// Canvas 工具名称常量
pub mod canvas_tool_names {
    pub const NOTE_READ: &str = "note_read";
    pub const NOTE_APPEND: &str = "note_append";
    pub const NOTE_REPLACE: &str = "note_replace";
    pub const NOTE_SET: &str = "note_set";
    pub const NOTE_LIST: &str = "note_list";
    pub const NOTE_SEARCH: &str = "note_search";
    pub const NOTE_CREATE: &str = "note_create";
    pub const NOTE_DELETE: &str = "note_delete";
    pub const NOTE_UPDATE_TAGS: &str = "note_update_tags";

    /// 带 builtin- 前缀的工具名称
    pub const BUILTIN_NOTE_READ: &str = "builtin-note_read";
    pub const BUILTIN_NOTE_APPEND: &str = "builtin-note_append";
    pub const BUILTIN_NOTE_REPLACE: &str = "builtin-note_replace";
    pub const BUILTIN_NOTE_SET: &str = "builtin-note_set";
    pub const BUILTIN_NOTE_LIST: &str = "builtin-note_list";
    pub const BUILTIN_NOTE_SEARCH: &str = "builtin-note_search";
    pub const BUILTIN_NOTE_CREATE: &str = "builtin-note_create";
    pub const BUILTIN_NOTE_DELETE: &str = "builtin-note_delete";
    pub const BUILTIN_NOTE_UPDATE_TAGS: &str = "builtin-note_update_tags";
}

/// 检查工具名是否为 Canvas 工具
///
/// 支持多种前缀格式：
/// - note_*（无前缀）
/// - builtin-note_*
/// - mcp_note_*
pub fn is_canvas_tool(tool_name: &str) -> bool {
    let stripped = strip_canvas_builtin_prefix(tool_name);
    matches!(
        stripped,
        canvas_tool_names::NOTE_READ
            | canvas_tool_names::NOTE_APPEND
            | canvas_tool_names::NOTE_REPLACE
            | canvas_tool_names::NOTE_SET
            | canvas_tool_names::NOTE_LIST
            | canvas_tool_names::NOTE_SEARCH
            | canvas_tool_names::NOTE_CREATE
            | canvas_tool_names::NOTE_DELETE
            | canvas_tool_names::NOTE_UPDATE_TAGS
    )
}

/// 从 Canvas 工具名中去除前缀（`strip_tool_namespace` 的别名，保持向后兼容）
pub fn strip_canvas_builtin_prefix(tool_name: &str) -> &str {
    strip_tool_namespace(tool_name)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_canvas_tool() {
        // 原始格式
        assert!(is_canvas_tool("note_read"));
        assert!(is_canvas_tool("note_append"));
        assert!(is_canvas_tool("note_replace"));
        assert!(is_canvas_tool("note_set"));
        assert!(is_canvas_tool("note_list"));
        assert!(is_canvas_tool("note_search"));
        assert!(is_canvas_tool("note_create"));
        assert!(is_canvas_tool("note_delete"));
        assert!(is_canvas_tool("note_update_tags"));

        // builtin- 前缀格式
        assert!(is_canvas_tool("builtin-note_read"));
        assert!(is_canvas_tool("builtin-note_append"));
        assert!(is_canvas_tool("builtin-note_replace"));
        assert!(is_canvas_tool("builtin-note_set"));
        assert!(is_canvas_tool("builtin-note_list"));
        assert!(is_canvas_tool("builtin-note_search"));
        assert!(is_canvas_tool("builtin-note_create"));
        assert!(is_canvas_tool("builtin-note_delete"));
        assert!(is_canvas_tool("builtin-note_update_tags"));

        // 非 Canvas 工具
        assert!(!is_canvas_tool("web_search"));
        assert!(!is_canvas_tool("builtin-rag_search"));
        assert!(!is_canvas_tool("mcp_brave_search"));
    }

    #[test]
    fn test_strip_canvas_builtin_prefix() {
        // 有前缀
        assert_eq!(
            strip_canvas_builtin_prefix("builtin-note_read"),
            "note_read"
        );
        assert_eq!(strip_canvas_builtin_prefix("builtin-note_set"), "note_set");

        // 无前缀（原样返回）
        assert_eq!(strip_canvas_builtin_prefix("note_read"), "note_read");
        assert_eq!(strip_canvas_builtin_prefix("web_search"), "web_search");
    }
}
