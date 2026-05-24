/**
 * Chat V2 - 前端 Schema 工具注册表
 *
 * 管理所有 Schema 注入型工具的元数据定义。
 * 遵循文档 26：统一工具注入系统架构设计。
 *
 * ★ 2026-01 改造：Canvas 和 Anki 工具已迁移到内置 MCP 服务器
 * 见 src/mcp/builtinMcpServer.ts
 *
 * 注意：前端注册表只存储元数据，不执行工具。
 * 工具执行由后端 Pipeline 负责。
 */

import type { ToolDefinition, ToolCategory } from './types';

// ============================================================================
// Schema 工具注册表
// ============================================================================

/**
 * Schema 工具注册表
 *
 * 管理所有 Schema 注入型工具的元数据。
 */
class SchemaToolRegistry {
  private definitions: Map<string, ToolDefinition> = new Map();

  /**
   * 注册工具定义
   */
  register(definition: ToolDefinition): void {
    this.definitions.set(definition.id, definition);
  }

  /**
   * 批量注册工具定义
   */
  registerAll(definitions: ToolDefinition[]): void {
    definitions.forEach((def) => this.register(def));
  }

  /**
   * 检查工具是否存在
   */
  hasTool(toolId: string): boolean {
    return this.definitions.has(toolId);
  }

  /**
   * 获取工具定义
   */
  getDefinition(toolId: string): ToolDefinition | undefined {
    return this.definitions.get(toolId);
  }

  /**
   * 获取多个工具的定义
   */
  getDefinitions(toolIds: string[]): ToolDefinition[] {
    return toolIds
      .map((id) => this.definitions.get(id))
      .filter((def): def is ToolDefinition => def !== undefined);
  }

  /**
   * 获取所有工具 ID
   */
  getAllToolIds(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * 获取指定分类的工具 ID
   */
  getToolsByCategory(category: ToolCategory): string[] {
    return Array.from(this.definitions.entries())
      .filter(([, def]) => def.category === category)
      .map(([id]) => id);
  }

  /**
   * 获取关联指定上下文类型的工具 ID
   */
  getToolsForContextType(contextType: string): string[] {
    return Array.from(this.definitions.entries())
      .filter(([, def]) => def.associatedContextTypes?.includes(contextType))
      .map(([id]) => id);
  }

  /**
   * 获取注册的工具数量
   */
  get size(): number {
    return this.definitions.size;
  }
}

// ============================================================================
// 全局注册表实例
// ============================================================================

/** 全局 Schema 工具注册表实例 */
export const schemaToolRegistry = new SchemaToolRegistry();

/**
 * 初始化工具注册表
 *
 * 注册所有内置工具定义。
 * 应在应用启动时调用一次。
 *
 * ★ 2026-01 改造：所有工具已迁移到内置 MCP 服务器，
 * 此注册表目前为空，保留供未来扩展使用。
 */
export function initializeToolRegistry(): void {
  console.log(
    `[SchemaToolRegistry] Initialized with ${schemaToolRegistry.size} tools:`,
    schemaToolRegistry.getAllToolIds()
  );
}

// 导出类型供外部使用
export { SchemaToolRegistry };
