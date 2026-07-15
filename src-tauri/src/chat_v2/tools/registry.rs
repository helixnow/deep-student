//! Schema 工具注册表
//!
//! 管理所有 Schema 注入型工具的定义。
//! 遵循文档 26：统一工具注入系统架构设计。

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;

use super::attempt_completion::{
    self, TOOL_DESCRIPTION as ATTEMPT_COMPLETION_DESCRIPTION, TOOL_NAME as ATTEMPT_COMPLETION_NAME,
};
use super::todo_executor;
use super::types::{ToolCategory, ToolDefinition};

// ============================================================================
// 全局注册表实例
// ============================================================================

/// 全局 Schema 工具注册表实例
static REGISTRY: OnceLock<SchemaToolRegistry> = OnceLock::new();

/// 获取全局注册表引用
pub fn get_registry() -> &'static SchemaToolRegistry {
    REGISTRY.get_or_init(SchemaToolRegistry::new_with_builtin_tools)
}

// ============================================================================
// Schema 工具注册表
// ============================================================================

/// Schema 工具注册表
///
/// 管理所有 Schema 注入型工具的定义和 Schema。
/// 使用 HashMap 实现 O(1) 查找。
#[derive(Debug)]
pub struct SchemaToolRegistry {
    /// 工具定义存储
    definitions: HashMap<&'static str, ToolDefinition>,
}

impl SchemaToolRegistry {
    /// 创建空注册表
    pub fn new() -> Self {
        Self {
            definitions: HashMap::new(),
        }
    }

    /// 创建并注册内置工具
    ///
    pub fn new_with_builtin_tools() -> Self {
        let mut registry = Self::new();
        registry.register_todo_tools();
        registry.register_attempt_completion_tool();
        registry
    }

    /// 注册工具定义
    pub fn register(&mut self, definition: ToolDefinition) {
        log::debug!(
            "[SchemaToolRegistry] Registering tool: {} (category: {:?})",
            definition.id,
            definition.category
        );
        self.definitions.insert(definition.id, definition);
    }

    /// 检查工具是否存在
    pub fn has_tool(&self, tool_id: &str) -> bool {
        self.definitions.contains_key(tool_id)
    }

    /// 获取工具定义
    pub fn get_definition(&self, tool_id: &str) -> Option<&ToolDefinition> {
        self.definitions.get(tool_id)
    }

    /// 获取多个工具的 Schema
    ///
    /// 返回指定工具 ID 列表对应的 Schema 数组（用于注入到 LLM）。
    /// 如果某个工具 ID 不存在，会记录警告日志并跳过。
    pub fn get_schemas(&self, tool_ids: &[String]) -> Vec<Value> {
        let mut schemas = Vec::with_capacity(tool_ids.len());

        for id in tool_ids {
            if let Some(def) = self.definitions.get(id.as_str()) {
                schemas.push(def.schema.clone());
            } else {
                log::warn!("[SchemaToolRegistry] Tool not found: '{}', skipping", id);
            }
        }

        schemas
    }

    /// 获取所有工具 ID
    pub fn get_all_tool_ids(&self) -> Vec<&'static str> {
        self.definitions.keys().copied().collect()
    }

    /// 获取指定分类的工具 ID
    pub fn get_tools_by_category(&self, category: ToolCategory) -> Vec<&'static str> {
        self.definitions
            .iter()
            .filter(|(_, def)| def.category == category)
            .map(|(id, _)| *id)
            .collect()
    }

    /// 获取关联指定上下文类型的工具 ID
    pub fn get_tools_for_context_type(&self, context_type: &str) -> Vec<&'static str> {
        self.definitions
            .iter()
            .filter(|(_, def)| def.associated_context_types.contains(&context_type))
            .map(|(id, _)| *id)
            .collect()
    }

    /// 获取注册的工具数量
    pub fn len(&self) -> usize {
        self.definitions.len()
    }

    /// 检查注册表是否为空
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty()
    }

    // ========================================================================
    // 内置工具注册
    // ========================================================================

    /// 注册 attempt_completion 工具（文档 29 P1-4）
    fn register_attempt_completion_tool(&mut self) {
        self.register(ToolDefinition::new(
            ATTEMPT_COMPLETION_NAME,
            ATTEMPT_COMPLETION_NAME,
            ATTEMPT_COMPLETION_DESCRIPTION,
            attempt_completion::get_schema(),
            ToolCategory::Agent,
        ));

        log::info!("[SchemaToolRegistry] Registered attempt_completion tool (Agent category)");
    }

    /// 🆕 注册 TodoList 工具（永续执行）
    fn register_todo_tools(&mut self) {
        // todo_init
        self.register(ToolDefinition::new(
            todo_executor::tool_names::TODO_INIT,
            "todo_init",
            "开始任务时调用，将复杂任务分解为可执行的子步骤列表",
            todo_executor::get_todo_init_schema(),
            ToolCategory::Agent,
        ));

        // todo_update
        self.register(ToolDefinition::new(
            todo_executor::tool_names::TODO_UPDATE,
            "todo_update",
            "更新任务步骤的状态，每完成一个步骤都应调用此工具",
            todo_executor::get_todo_update_schema(),
            ToolCategory::Agent,
        ));

        // todo_add
        self.register(ToolDefinition::new(
            todo_executor::tool_names::TODO_ADD,
            "todo_add",
            "在执行过程中发现需要额外步骤时，动态添加新任务",
            todo_executor::get_todo_add_schema(),
            ToolCategory::Agent,
        ));

        // todo_get
        self.register(ToolDefinition::new(
            todo_executor::tool_names::TODO_GET,
            "todo_get",
            "获取当前任务列表及所有步骤的状态",
            todo_executor::get_todo_get_schema(),
            ToolCategory::Agent,
        ));

        log::info!("[SchemaToolRegistry] Registered 4 TodoList tools (Agent category)");
    }
}

impl Default for SchemaToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_creation() {
        let registry = SchemaToolRegistry::new();
        assert!(registry.is_empty());
    }

    #[test]
    fn test_registry_with_builtin_tools() {
        let registry = SchemaToolRegistry::new_with_builtin_tools();
        // 1 attempt_completion + 4 TodoList tools = 5
        assert!(registry.len() >= 5);
        // Agent tool
        assert!(registry.has_tool("attempt_completion"));
        assert!(!registry.has_tool("builtin-anki_generate_cards"));
        assert!(!registry.has_tool("builtin-anki_control_task"));
        // TodoList tools（注册 ID 为无前缀的 tool_names 常量）
        assert!(registry.has_tool(todo_executor::tool_names::TODO_INIT));
        assert!(registry.has_tool(todo_executor::tool_names::TODO_UPDATE));
        assert!(registry.has_tool(todo_executor::tool_names::TODO_ADD));
        assert!(registry.has_tool(todo_executor::tool_names::TODO_GET));
    }

    #[test]
    fn test_get_schemas() {
        let registry = SchemaToolRegistry::new_with_builtin_tools();
        // 使用 TodoList 工具测试
        let schemas = registry.get_schemas(&[
            todo_executor::tool_names::TODO_INIT.to_string(),
            todo_executor::tool_names::TODO_UPDATE.to_string(),
        ]);
        assert_eq!(schemas.len(), 2);
    }

    #[test]
    fn test_get_schemas_with_invalid_id() {
        let registry = SchemaToolRegistry::new_with_builtin_tools();
        let schemas = registry.get_schemas(&[
            todo_executor::tool_names::TODO_INIT.to_string(),
            "invalid_tool".to_string(),
        ]);
        // 应该只返回有效的 1 个
        assert_eq!(schemas.len(), 1);
    }

    #[test]
    fn test_get_tools_for_context_type() {
        let registry = SchemaToolRegistry::new_with_builtin_tools();
        let tools = registry.get_tools_for_context_type("note");
        assert_eq!(tools.len(), 0);
    }

    #[test]
    fn test_get_tools_by_category() {
        let registry = SchemaToolRegistry::new_with_builtin_tools();
        let tools = registry.get_tools_by_category(ToolCategory::ContextBound);
        assert_eq!(tools.len(), 0);

        let mcp_tools = registry.get_tools_by_category(ToolCategory::Mcp);
        assert!(mcp_tools.is_empty());
    }
}
