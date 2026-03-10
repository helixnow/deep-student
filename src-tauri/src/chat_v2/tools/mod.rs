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
//! - `anki_executor`: Anki 工具执行器（桥接到前端 CardAgent）
//! - `executor`: ToolExecutor trait 定义（文档 29 P0-1）
//! - `executor_registry`: 工具执行器注册表（文档 29 P0-1）
//! - `general_executor`: 通用工具执行器（文档 29 P0-1）
//! - `canvas_executor`: Canvas 工具执行器（文档 29 P0-1）
//!
//! ### 工具列表
//! - Canvas 工具：`builtin:note_read`, `builtin:note_append`, `builtin:note_replace`, `builtin:note_set`
//! - Anki 工具：`builtin:anki_generate_cards`, `builtin:anki_control_task`, 等（定义在前端 builtinMcpServer.ts）
//!
//! ## 约束
//! - Canvas 工具必须从参数中获取 `note_id` 和 `subject`（由 Pipeline 通过 SendOptions 传递）
//! - Anki 工具由前端 CardAgent 执行（通过事件通信）
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

pub mod academic_search_executor; // 🆕 学术论文搜索执行器（arXiv + OpenAlex）
pub mod anki_executor;
pub mod ask_user_executor; // 🆕 用户提问工具执行器（轻量级问答交互） // Anki 工具执行器（桥接到前端 CardAgent）
pub mod attachment_executor; // 🆕 附件工具执行器（解决 P0 断裂点）
pub mod attempt_completion; // 🆕 任务完成工具（文档 29 P1-4）
pub mod builtin_resource_executor; // 🆕 内置学习资源工具执行器
pub mod builtin_retrieval_executor; // 🆕 内置检索工具执行器（MCP 工具化）
pub mod canvas_executor;
pub mod canvas_tools;
pub mod chatanki_executor; // 🆕 ChatAnki 工具执行器（文件→卡片闭环）
pub mod docx_executor; // 🆕 DOCX 文档读写工具执行器（docx-rs 完整能力）
pub mod executor;
pub mod executor_registry;
pub mod fetch_executor; // 🆕 内置 Web Fetch 工具执行器（参考 @anthropic/mcp-fetch）
pub mod general_executor;
pub mod injector;
pub mod knowledge_executor; // 🆕 知识工具执行器（内化/提取）
pub mod memory_executor;
pub mod paper_save_executor; // 🆕 论文保存+引用格式化工具执行器
pub mod pptx_executor; // 🆕 PPTX 演示文稿读写工具执行器（ppt-rs）
pub mod qbank_executor; // 🆕 智能题目集工具执行器
pub mod registry;
pub mod session_executor; // 🆕 会话管理工具执行器（AI 自主管理会话/分组/标签）
pub mod skills_executor; // 🆕 Skills 工具执行器（渐进披露架构）
pub mod sleep_executor;
pub mod subagent_executor;
pub mod template_executor; // 🆕 模板设计师工具执行器
pub mod todo_executor;
pub mod types;
pub mod user_todo_executor;
pub mod workspace_executor;
pub mod xlsx_executor; // 🆕 XLSX 电子表格读写工具执行器（umya-spreadsheet） // 🆕 Coordinator 睡眠工具执行器（睡眠/唤醒机制）

// 重导出工具
pub use canvas_tools::{
    NoteAppendTool, NoteCreateTool, NoteListTool, NoteReadTool, NoteReplaceTool, NoteSearchTool,
    NoteSetTool,
};

// 重导出注册表
pub use registry::{get_registry, SchemaToolRegistry};

// 重导出注入器
pub use injector::inject_tool_schemas;

// 重导出类型
pub use types::{
    strip_tool_namespace, ToolCategory, ToolDefinition, ToolExecutionContext, ToolExecutionResult,
};

// 重导出执行器（文档 29 P0-1）
pub use academic_search_executor::AcademicSearchExecutor; // 🆕 学术论文搜索执行器
pub use anki_executor::AnkiToolExecutor; // 🆕 Anki 工具执行器
pub use ask_user_executor::AskUserExecutor; // 🆕 用户提问工具执行器
pub use attachment_executor::AttachmentToolExecutor; // 🆕 附件工具执行器
pub use attempt_completion::AttemptCompletionExecutor;
pub use builtin_resource_executor::BuiltinResourceExecutor; // 🆕 内置学习资源工具执行器
pub use builtin_retrieval_executor::BuiltinRetrievalExecutor; // 🆕 内置检索工具执行器
pub use canvas_executor::CanvasToolExecutor;
pub use chatanki_executor::ChatAnkiToolExecutor; // 🆕 ChatAnki 工具执行器
pub use docx_executor::DocxToolExecutor; // 🆕 DOCX 文档读写工具执行器
pub use executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
pub use executor_registry::ToolExecutorRegistry;
pub use fetch_executor::FetchExecutor; // 🆕 内置 Web Fetch 工具执行器
pub use general_executor::GeneralToolExecutor;
pub use knowledge_executor::KnowledgeExecutor; // 🆕 知识工具执行器
pub use memory_executor::MemoryToolExecutor;
pub use paper_save_executor::PaperSaveExecutor; // 🆕 论文保存+引用格式化工具执行器
pub use pptx_executor::PptxToolExecutor; // 🆕 PPTX 演示文稿读写工具执行器
pub use session_executor::SessionToolExecutor; // 🆕 会话管理工具执行器
pub use skills_executor::SkillsExecutor; // 🆕 Skills 工具执行器
pub use sleep_executor::{get_coordinator_sleep_tool_schema, CoordinatorSleepExecutor};
pub use subagent_executor::{get_subagent_tool_schema, SubagentExecutor, SUBAGENT_TOOL_NAME};
pub use template_executor::TemplateDesignerExecutor; // 🆕 模板设计师工具执行器
pub use todo_executor::TodoListExecutor;
pub use user_todo_executor::UserTodoExecutor;
pub use workspace_executor::{get_workspace_tool_schemas, WorkspaceToolExecutor};
pub use xlsx_executor::XlsxToolExecutor; // 🆕 XLSX 电子表格读写工具执行器 // 🆕 Coordinator 睡眠执行器

/// Canvas 工具名称常量
pub mod canvas_tool_names {
    pub const NOTE_READ: &str = "note_read";
    pub const NOTE_APPEND: &str = "note_append";
    pub const NOTE_REPLACE: &str = "note_replace";
    pub const NOTE_SET: &str = "note_set";
    pub const NOTE_LIST: &str = "note_list";
    pub const NOTE_SEARCH: &str = "note_search";
    pub const NOTE_CREATE: &str = "note_create";

    /// 带 builtin- 前缀的工具名称
    pub const BUILTIN_NOTE_READ: &str = "builtin-note_read";
    pub const BUILTIN_NOTE_APPEND: &str = "builtin-note_append";
    pub const BUILTIN_NOTE_REPLACE: &str = "builtin-note_replace";
    pub const BUILTIN_NOTE_SET: &str = "builtin-note_set";
    pub const BUILTIN_NOTE_LIST: &str = "builtin-note_list";
    pub const BUILTIN_NOTE_SEARCH: &str = "builtin-note_search";
    pub const BUILTIN_NOTE_CREATE: &str = "builtin-note_create";
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

        // builtin- 前缀格式
        assert!(is_canvas_tool("builtin-note_read"));
        assert!(is_canvas_tool("builtin-note_append"));
        assert!(is_canvas_tool("builtin-note_replace"));
        assert!(is_canvas_tool("builtin-note_set"));
        assert!(is_canvas_tool("builtin-note_list"));
        assert!(is_canvas_tool("builtin-note_search"));
        assert!(is_canvas_tool("builtin-note_create"));

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
