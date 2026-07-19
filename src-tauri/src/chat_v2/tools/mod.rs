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
//! - `anki_executor`: 仅保留的 CardForge 兼容实现（未注册且不注入 Schema）
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

pub mod academic_search_executor; // 🆕 学术论文搜索执行器（arXiv + OpenAlex）
pub mod anki_executor; // 旧 CardForge 兼容代码；生产管线不注册
mod arg_utils;
pub mod ask_user_executor; // 🆕 用户提问工具执行器（轻量级问答交互） // Anki 工具执行器（桥接到前端 CardAgent）
pub mod attachment_executor; // 🆕 附件工具执行器（解决 P0 断裂点）
pub mod attachment_stage_executor; // 🆕 附件物化工具执行器（附件原始字节 → temp root 路径）
pub mod attempt_completion; // 🆕 任务完成工具（文档 29 P1-4）
pub mod automation_executor; // 🆕 周期自动化提案/列表/启停执行器
pub mod browser_executor; // 🆕 内置浏览器 Agent 工具（BrowserService + 注入桥；非 Playwright）
pub mod builtin_resource_executor; // 🆕 内置学习资源工具执行器
pub mod builtin_retrieval_executor; // 🆕 内置检索工具执行器（MCP 工具化）
pub mod canvas_executor;
pub mod canvas_tools;
pub mod chatanki_executor; // 🆕 ChatAnki 工具执行器（文件→卡片闭环）
pub mod connector_executor; // First-class connector registry and draft/confirm/commit bridge
pub mod data_governance_executor; // Agent-safe backup and sync tools
pub mod document_processing_executor; // 🆕 文档解析/OCR 主动触发执行器（document_parse/status）
pub mod docx_executor; // 🆕 DOCX 文档读写工具执行器（docx-rs 完整能力）
pub mod dstu_executor; // DSTU/VFS Finder mutation and trash tools
pub mod essay_grading_executor; // 🆕 作文批改工具执行器（essay_grade 异步任务 + 历史查询）
pub mod executor;
pub mod executor_registry;
pub mod fetch_executor; // 🆕 内置 Web Fetch 工具执行器（参考 @anthropic/mcp-fetch）
pub mod file_manager_executor;
pub mod general_executor;
pub mod image_generation_executor; // 🆕 内置图片生成工具执行器
pub mod index_webpage_executor; // VFS index inspection/rebuild and webpage archive tools
pub mod injector;
pub mod knowledge_executor; // 🆕 知识工具执行器（内化/提取）
pub mod learning_overview_executor; // Read-only learning overview and Pomodoro statistics
pub mod llm_usage_executor; // Agent-safe local LLM usage reporting
pub mod local_shell_execute_executor;
pub mod local_shell_preflight_executor;
pub mod mcp_content_materializer; // External MCP image/blob content -> session task files
pub mod mcp_propose_executor; // 🆕 MCP server 提案执行器（High 敏感度，secure store 写入）
pub mod mcp_settings_store; // MCP tools.list secure 读写 helper
pub mod media_executor; // Managed attachment audio transcription
pub mod memory_executor;
pub mod office_fidelity_executor; // Read-only OOXML/PDF fidelity inventory and completion gate
pub mod office_output; // Shared VFS/workspace delivery for generated OOXML files
pub mod paper_save_executor; // 🆕 论文保存+引用格式化工具执行器
pub mod pptx_executor; // 🆕 PPTX 演示文稿读写工具执行器（ppt-rs）
pub mod qbank_executor; // 🆕 智能题目集工具执行器
pub mod registry;
pub mod review_executor; // 🆕 间隔重复复习计划工具执行器（review_* 工具组，SM-2）
pub mod role_pack_executor; // Versioned professional role pack registry (read-only)
pub mod runtime_root_request_executor; // 🆕 runtime_root_request 授权请求执行器（High，never-remember）
pub mod self_inspect_executor; // 🆕 self_inspect 只读自查工具执行器（脱敏状态概览）
pub mod session_executor; // 🆕 会话管理工具执行器（AI 自主管理会话/分组/标签）
pub mod settings_models_executor; // Agent-safe settings and model assignment tools
pub mod shell_sandbox;
pub mod skill_install_executor; // 🆕 skill_scan / skill_install 技能包自装执行器
pub mod skill_workshop_executor; // 🆕 skill_workshop_propose / skill_workshop_apply 提案式技能 workshop
pub mod skills_executor; // 🆕 Skills 工具执行器（渐进披露架构）
pub mod sleep_executor;
pub mod subagent_executor;
pub mod task_audit_executor; // Audit manifest export and lineage forget governance
pub mod template_executor; // 🆕 模板设计师工具执行器
pub mod textbook_pdf_executor; // Agent-safe textbook annotations and PDF page images
pub mod todo_executor;
pub mod tool_pack_executor; // ToolPack parallel executor
pub mod translation_executor; // Translation pipeline + explicit VFS save tools
pub mod types;
pub mod user_todo_executor;
pub mod workbench_bridge; // ACR R1-01：工作台桥 RPC（acr_bridge_call）
/// ACR R1-02 提供实现文件 `workbench_executor.rs`；本处仅预留 mod/pub use，避免 R1-01 悬空引用。
pub mod workbench_executor;
pub mod workspace_executor;
pub mod workspace_fs_executor;
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
pub use anki_executor::AnkiToolExecutor; // 旧 CardForge 兼容执行器；仅保留类型
pub use ask_user_executor::AskUserExecutor; // 🆕 用户提问工具执行器
pub use attachment_executor::AttachmentToolExecutor; // 🆕 附件工具执行器
pub use attachment_stage_executor::AttachmentStageExecutor; // 🆕 附件物化工具执行器
pub use attempt_completion::AttemptCompletionExecutor;
pub use automation_executor::AutomationExecutor; // 🆕 周期自动化执行器
pub use browser_executor::BrowserToolExecutor; // 🆕 内置浏览器 Agent 工具执行器
pub use builtin_resource_executor::BuiltinResourceExecutor; // 🆕 内置学习资源工具执行器
pub use builtin_retrieval_executor::BuiltinRetrievalExecutor; // 🆕 内置检索工具执行器
pub use canvas_executor::CanvasToolExecutor;
pub use chatanki_executor::ChatAnkiToolExecutor; // 🆕 ChatAnki 工具执行器
pub use connector_executor::ConnectorToolExecutor;
pub use data_governance_executor::DataGovernanceToolExecutor;
pub use document_processing_executor::DocumentProcessingExecutor; // 🆕 文档解析/OCR 主动触发执行器
pub use docx_executor::DocxToolExecutor; // 🆕 DOCX 文档读写工具执行器
pub use dstu_executor::DstuToolExecutor;
pub use essay_grading_executor::EssayGradingExecutor; // 🆕 作文批改工具执行器
pub use executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
pub use executor_registry::ToolExecutorRegistry;
pub use fetch_executor::FetchExecutor; // 🆕 内置 Web Fetch 工具执行器
pub use file_manager_executor::FileManagerExecutor;
pub use general_executor::GeneralToolExecutor;
pub use image_generation_executor::ImageGenerationExecutor; // 🆕 内置图片生成工具执行器
pub use index_webpage_executor::IndexWebpageToolExecutor;
pub use knowledge_executor::KnowledgeExecutor; // 🆕 知识工具执行器
pub use learning_overview_executor::LearningOverviewExecutor;
pub use llm_usage_executor::LlmUsageToolExecutor;
pub use local_shell_execute_executor::LocalShellExecuteExecutor;
pub use local_shell_preflight_executor::LocalShellPreflightExecutor;
pub use mcp_propose_executor::McpProposeExecutor; // 🆕 MCP server 提案执行器
pub use media_executor::MediaToolExecutor;
pub use memory_executor::MemoryToolExecutor;
pub use office_fidelity_executor::OfficeFidelityExecutor;
pub use paper_save_executor::PaperSaveExecutor; // 🆕 论文保存+引用格式化工具执行器
pub use pptx_executor::PptxToolExecutor; // 🆕 PPTX 演示文稿读写工具执行器
pub use review_executor::ReviewToolExecutor; // 🆕 间隔重复复习计划工具执行器
pub use session_executor::SessionToolExecutor; // 🆕 会话管理工具执行器
pub use settings_models_executor::SettingsModelsToolExecutor;
pub use skills_executor::SkillsExecutor; // 🆕 Skills 工具执行器
pub use sleep_executor::CoordinatorSleepExecutor;
pub use subagent_executor::{SubagentExecutor, SUBAGENT_TOOL_NAME};
pub use task_audit_executor::TaskAuditExecutor;
pub use template_executor::TemplateDesignerExecutor; // 🆕 模板设计师工具执行器
pub use textbook_pdf_executor::TextbookPdfToolExecutor;
pub use todo_executor::TodoListExecutor;
pub use tool_pack_executor::ToolPackExecutor; // ToolPack parallel executor
pub use translation_executor::TranslationToolExecutor;
pub use user_todo_executor::UserTodoExecutor;
pub use workbench_bridge::{acr_bridge_call, AcrBridgeRequest, AcrBridgeResponse, AcrProgress}; // ACR R1-01
pub use workbench_executor::WorkbenchToolExecutor;
pub use workspace_executor::{get_workspace_tool_schemas, WorkspaceToolExecutor};
pub use workspace_fs_executor::WorkspaceFsExecutor;
pub use xlsx_executor::XlsxToolExecutor; // 🆕 XLSX 电子表格读写工具执行器 // 🆕 Coordinator 睡眠执行器 // ACR R1-02 提供（见上方 mod 注释）

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
