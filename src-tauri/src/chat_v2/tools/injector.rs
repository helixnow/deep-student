//! Schema 工具注入器
//!
//! 负责从 schema_tool_ids 获取工具 Schema 并注入到 LLM Context。
//! 遵循文档 26：统一工具注入系统架构设计。

use serde_json::Value;
use std::collections::HashMap;

use super::registry::get_registry;

// ============================================================================
// 工具注入器
// ============================================================================

/// 从 schema_tool_ids 获取工具 Schema 并注入到 llm_context
///
/// # 参数
/// - `schema_tool_ids`: 前端传递的工具 ID 列表（可选）
/// - `llm_context`: 要注入的 LLM 上下文
///
/// # 返回
/// - 注入的工具数量
pub fn inject_tool_schemas(
    schema_tool_ids: Option<&Vec<String>>,
    llm_context: &mut HashMap<String, Value>,
) -> usize {
    let tool_ids = match schema_tool_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            log::debug!("[ToolInjector] No schema_tool_ids provided, skipping injection");
            return 0;
        }
    };

    let registry = get_registry();
    let schemas = registry.get_schemas(tool_ids);
    let count = schemas.len();

    if count > 0 {
        llm_context.insert(
            "custom_tools".into(),
            serde_json::to_value(schemas).unwrap_or(Value::Null),
        );
        log::info!(
            "[ToolInjector] Injected {} tool schemas: {:?}",
            count,
            tool_ids
        );
    } else {
        log::warn!(
            "[ToolInjector] No valid schemas found for tool_ids: {:?}",
            tool_ids
        );
    }

    count
}

// ★ 2026-01 改造：has_canvas_tools 已移除
// Canvas 笔记工具现在通过内置 MCP 服务器注入，不再通过 schema_tool_ids

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_tool_schemas_none() {
        let mut context = HashMap::new();
        let count = inject_tool_schemas(None, &mut context);
        assert_eq!(count, 0);
        assert!(!context.contains_key("custom_tools"));
    }

    #[test]
    fn test_inject_tool_schemas_empty() {
        let mut context = HashMap::new();
        let tool_ids = vec![];
        let count = inject_tool_schemas(Some(&tool_ids), &mut context);
        assert_eq!(count, 0);
        assert!(!context.contains_key("custom_tools"));
    }

    #[test]
    fn test_inject_tool_schemas_anki() {
        let mut context = HashMap::new();
        // Anki 工具现在通过内置 MCP 服务器注入，不再通过 registry
        let tool_ids = vec![
            "builtin-anki_generate_cards".to_string(),
            "builtin-anki_control_task".to_string(),
        ];
        let count = inject_tool_schemas(Some(&tool_ids), &mut context);
        // 这些工具不在 registry 中，所以 count 应为 0
        assert_eq!(count, 0);
    }

    #[test]
    fn test_inject_tool_schemas_invalid() {
        let mut context = HashMap::new();
        let tool_ids = vec!["invalid_tool".to_string()];
        let count = inject_tool_schemas(Some(&tool_ids), &mut context);
        assert_eq!(count, 0);
    }
}
