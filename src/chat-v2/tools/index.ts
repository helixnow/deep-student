/**
 * Chat V2 - 工具模块统一导出
 *
 * 遵循文档 26：统一工具注入系统架构设计
 *
 * ★ 2026-01 改造：
 * - Canvas 工具已迁移到内置 MCP 服务器
 * - Anki 工具已迁移到内置 MCP 服务器
 * - 见 src/mcp/builtinMcpServer.ts
 */

// ============================================================================
// 核心类型
// ============================================================================

export type {
  ToolCategory,
  ToolDefinition,
  ToolSchema,
  ToolParameterSchema,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types';

// ============================================================================
// 工具注册表
// ============================================================================

export {
  schemaToolRegistry,
  initializeToolRegistry,
  SchemaToolRegistry,
} from './registry';

// ============================================================================
// 工具定义（遗留空数组，保持类型兼容）
// ============================================================================

export const canvasToolDefinitions: never[] = [];
export const canvasToolIds: string[] = [];

// ============================================================================
// Schema 工具收集器
// ============================================================================

export {
  collectSchemaToolIds,
  hasSchemaTools,
  CANVAS_TOOL_IDS,
  type CollectToolsResult,
  type CollectToolsOptions,
} from './collector';

// ============================================================================
// 旧 API（保留以避免编译错误）
// ============================================================================

export {
  collectToolsFromContextRefs,
  getEnabledToolIds,
  hasContextTools,
  mergeToolIds,
} from './getEnabledToolIds';
