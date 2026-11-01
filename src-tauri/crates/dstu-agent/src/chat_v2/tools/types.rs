//! Schema 工具类型定义
//!
//! 定义统一工具注入系统的核心类型。
//! 遵循文档 26：统一工具注入系统架构设计。

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ============================================================================
// 跨执行器共享常量（step 10：从域执行器下沉，agent 框架代码不再引用域执行器）
// ============================================================================

/// 内置工具命名空间前缀
/// 🔧 使用 'builtin-' 而非 'builtin:' 以兼容 DeepSeek/OpenAI API 的工具名称限制
/// API 要求工具名称符合正则 ^[a-zA-Z0-9_-]+$，不允许冒号
///
/// 原定义在 `builtin_retrieval_executor`（该处保留 `pub use` 旧路径）。
pub const BUILTIN_NAMESPACE: &str = "builtin-";

/// 设置变更事件名（原定义在 `settings_models_executor`，该处保留 `pub use` 旧路径）。
pub const SETTINGS_CHANGED_EVENT: &str = "chat_v2://settings_changed";

// ============================================================================
// 工具分类
// ============================================================================

/// 工具分类枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolCategory {
    /// 上下文绑定工具（如 Canvas note_*, Card card_*）
    ContextBound,
    /// MCP 外部工具
    Mcp,
    /// Agent 控制工具（如 attempt_completion，文档 29 P1-4）
    Agent,
    /// 自定义工具（未来扩展）
    Custom,
}

// ============================================================================
// 工具定义
// ============================================================================

/// Schema 工具定义
///
/// 用于注册工具的元数据，包含工具 ID、名称、描述、Schema 等。
#[derive(Debug, Clone)]
pub struct ToolDefinition {
    /// 工具唯一 ID（全局唯一，前后端一致）
    /// 例如: "note_read", "note_append", "mcp_brave_search"
    pub id: &'static str,

    /// 工具名称（OpenAI Function Calling 中的 name）
    /// 通常与 id 相同
    pub name: &'static str,

    /// 工具描述
    pub description: &'static str,

    /// OpenAI Function Calling Schema (JSON)
    /// 包含 type: "function", function: { name, description, parameters }
    pub schema: Value,

    /// 工具分类
    pub category: ToolCategory,

    /// 关联的上下文类型（可选）
    /// 例如: ["note"] 表示该工具与 note 类型上下文关联
    pub associated_context_types: &'static [&'static str],
}

impl ToolDefinition {
    /// 创建新的工具定义
    pub fn new(
        id: &'static str,
        name: &'static str,
        description: &'static str,
        schema: Value,
        category: ToolCategory,
    ) -> Self {
        Self {
            id,
            name,
            description,
            schema,
            category,
            associated_context_types: &[],
        }
    }

    /// 设置关联的上下文类型
    pub fn with_context_types(mut self, types: &'static [&'static str]) -> Self {
        self.associated_context_types = types;
        self
    }
}

// ============================================================================
// 工具执行上下文
// ============================================================================

/// 工具执行上下文
///
/// 在执行工具时提供必要的上下文信息。
#[derive(Debug, Clone)]
pub struct ToolExecutionContext {
    /// 会话 ID
    pub session_id: String,
    /// 消息 ID
    pub message_id: String,
    /// Canvas 笔记 ID（Canvas 工具需要）
    pub canvas_note_id: Option<String>,
}

impl ToolExecutionContext {
    /// 创建新的执行上下文
    pub fn new(session_id: String, message_id: String) -> Self {
        Self {
            session_id,
            message_id,
            canvas_note_id: None,
        }
    }

    /// 设置 Canvas 上下文
    pub fn with_canvas(mut self, note_id: Option<String>) -> Self {
        self.canvas_note_id = note_id;
        self
    }
}

// ============================================================================
// 工具执行结果
// ============================================================================

/// 工具执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolExecutionResult {
    /// 是否执行成功
    pub success: bool,
    /// 执行结果数据
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    /// 错误信息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 使用统计（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
}

impl ToolExecutionResult {
    /// 创建成功结果
    pub fn success(data: Value) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
            usage: None,
        }
    }

    /// 创建失败结果
    pub fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
            usage: None,
        }
    }
}

// ============================================================================
// 公共工具命名空间剥离
// ============================================================================

// 命名空间解析已下沉 dstu-core；旧路径 `tools::types::*` 保持不变。
pub use dstu_core::tool_names::{
    is_external_mcp_tool_name, strip_tool_namespace, EXTERNAL_MCP_DOTTED_TOOL_PREFIX,
    EXTERNAL_MCP_TOOL_PREFIX,
};

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_definition_creation() {
        let schema = json!({
            "type": "function",
            "function": {
                "name": "test_tool",
                "description": "A test tool",
                "parameters": {
                    "type": "object",
                    "properties": {}
                }
            }
        });

        let def = ToolDefinition::new(
            "test_tool",
            "test_tool",
            "A test tool",
            schema,
            ToolCategory::Custom,
        );

        assert_eq!(def.id, "test_tool");
        assert_eq!(def.name, "test_tool");
        assert_eq!(def.category, ToolCategory::Custom);
        assert!(def.associated_context_types.is_empty());
    }

    #[test]
    fn test_tool_definition_with_context_types() {
        let schema = json!({});
        let def = ToolDefinition::new(
            "note_read",
            "note_read",
            "Read note",
            schema,
            ToolCategory::ContextBound,
        )
        .with_context_types(&["note"]);

        assert_eq!(def.associated_context_types, &["note"]);
    }

    #[test]
    fn test_execution_result_success() {
        let result = ToolExecutionResult::success(json!({"content": "test"}));
        assert!(result.success);
        assert!(result.data.is_some());
        assert!(result.error.is_none());
    }

    #[test]
    fn test_execution_result_failure() {
        let result = ToolExecutionResult::failure("Something went wrong");
        assert!(!result.success);
        assert!(result.data.is_none());
        assert_eq!(result.error, Some("Something went wrong".to_string()));
    }

    #[test]
    fn test_external_mcp_namespace_detection_preserves_source() {
        assert!(is_external_mcp_tool_name("mcp_workspace_file_read"));
        assert!(is_external_mcp_tool_name("mcp.tools.workspace_file_read"));
        assert!(!is_external_mcp_tool_name("builtin-workspace_file_read"));
        assert!(!is_external_mcp_tool_name("workspace_file_read"));
    }
}
