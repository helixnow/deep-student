//! 工具名命名空间解析。
//!
//! 62 个 tools 文件都要判断/剥离工具名前缀，因此放在 core；旧路径
//! `chat_v2::tools::types::{strip_tool_namespace, is_external_mcp_tool_name}`
//! 继续可用。

/// External MCP tools are always routed through the frontend MCP bridge.
pub const EXTERNAL_MCP_TOOL_PREFIX: &str = "mcp_";
pub const EXTERNAL_MCP_DOTTED_TOOL_PREFIX: &str = "mcp.tools.";

/// Returns whether a tool name carries an external MCP source namespace.
///
/// This check is intentionally source-preserving. Callers that select an
/// executor must use it before stripping namespaces, otherwise an external
/// tool such as `mcp_workspace_file_read` can collide with a builtin executor.
pub fn is_external_mcp_tool_name(tool_name: &str) -> bool {
    tool_name.starts_with(EXTERNAL_MCP_TOOL_PREFIX)
        || tool_name.starts_with(EXTERNAL_MCP_DOTTED_TOOL_PREFIX)
}

/// 移除工具名的命名空间前缀（builtin-、mcp_）
///
/// 多数执行器使用 `builtin-` 前缀注册工具名，部分 MCP 桥接使用 `mcp_` 前缀。
/// 本函数统一剥离这些前缀，返回裸工具名。
/// 仅用于执行器内部兼容匹配；来源路由必须先调用 `is_external_mcp_tool_name`。
pub fn strip_tool_namespace(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("builtin-")
        .or_else(|| tool_name.strip_prefix("mcp_"))
        .unwrap_or(tool_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_external_mcp_namespace_detection_preserves_source() {
        assert!(is_external_mcp_tool_name("mcp_workspace_file_read"));
        assert!(is_external_mcp_tool_name("mcp.tools.workspace_file_read"));
        assert!(!is_external_mcp_tool_name("builtin-workspace_file_read"));
        assert!(!is_external_mcp_tool_name("workspace_file_read"));
    }

    #[test]
    fn strip_tool_namespace_removes_builtin_and_mcp_prefixes() {
        assert_eq!(strip_tool_namespace("builtin-note_read"), "note_read");
        assert_eq!(strip_tool_namespace("mcp_note_read"), "note_read");
        assert_eq!(strip_tool_namespace("note_read"), "note_read");
    }
}
