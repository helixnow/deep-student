/**
 * Chat V2 - Schema 工具收集器
 *
 * 从多来源收集启用的 Schema 工具 ID。
 * 遵循文档 26：统一工具注入系统架构设计。
 *
 * 来源：
 * 1. 上下文引用关联工具（从 pendingContextRefs 收集）
 * 2. 模式插件启用的工具（未来扩展）
 *
 * 注意：Anki 制卡工具已迁移到内置 MCP 服务器（builtinMcpServer.ts），
 * 不再通过此收集器处理。
 */

import type { ContextRef } from '../context/types';
import { contextTypeRegistry } from '../context/registry';

// ============================================================================
// 遗留常量（保持向后兼容）
// ============================================================================

/** @deprecated 保留空数组以避免编译错误 */
export const CANVAS_TOOL_IDS: string[] = [];

// ============================================================================
// 工具收集器
// ============================================================================

/**
 * 收集结果
 */
export interface CollectToolsResult {
  /** 收集到的 Schema 工具 ID 列表（去重后） */
  schemaToolIds: string[];
  /** 收集来源记录（用于调试） */
  sources: {
    contextRefs: string[];
  };
}

/**
 * 收集选项
 */
export interface CollectToolsOptions {
  /** @deprecated 保留以避免编译错误 */
  canvasNoteId?: string;
  /** 上下文引用列表 */
  pendingContextRefs?: ContextRef[];
  /** @deprecated Anki 工具已迁移到内置 MCP 服务器，此选项不再生效 */
  enableAnkiTools?: boolean;
}

/**
 * 收集 Schema 工具 ID
 *
 * 从多个来源收集需要注入的 Schema 工具，返回去重后的 ID 列表。
 *
 * @param options - 收集选项
 * @returns 收集结果
 */
export function collectSchemaToolIds(options: CollectToolsOptions): CollectToolsResult {
  const toolSet = new Set<string>();
  const sources = {
    contextRefs: [] as string[],
  };

  // 1. 上下文引用关联工具
  if (options.pendingContextRefs && options.pendingContextRefs.length > 0) {
    const typeIds = [...new Set(options.pendingContextRefs.map((ref) => ref.typeId))];
    const contextTools = contextTypeRegistry.collectToolsForTypes(typeIds);
    contextTools.forEach((id) => {
      if (!toolSet.has(id)) {
        toolSet.add(id);
        sources.contextRefs.push(id);
      }
    });
  }

  // 注意：Anki 工具已迁移到内置 MCP 服务器，不再通过此收集器处理
  // enableAnkiTools 选项已废弃

  // 2. 未来可扩展：模式插件启用的工具

  return {
    schemaToolIds: Array.from(toolSet),
    sources,
  };
}

/**
 * 检查是否有 Schema 工具需要启用
 *
 * 注意：Anki 工具已迁移到内置 MCP 服务器，不再通过此函数检测。
 */
export function hasSchemaTools(options: CollectToolsOptions): boolean {
  if (options.pendingContextRefs && options.pendingContextRefs.length > 0) {
    for (const ref of options.pendingContextRefs) {
      const tools = contextTypeRegistry.getToolsForType(ref.typeId);
      if (tools.length > 0) {
        return true;
      }
    }
  }

  return false;
}
