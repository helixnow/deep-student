/**
 * Chat V2 - 获取启用的工具 ID
 *
 * 根据 Store 中的 pendingContextRefs 收集关联的工具 ID。
 * 遵循文档 16：上下文类型关联工具自动启用。
 *
 * 约束：
 * 1. 从 contextTypeRegistry 获取类型关联的工具
 * 2. 去重后返回
 * 3. 与模式插件的 getEnabledTools 结果合并
 */

import { contextTypeRegistry } from '../context/registry';
import type { ContextRef } from '../context/types';
import type { ChatStore } from '../core/types/store';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:getEnabledToolIds]';

// ============================================================================
// 工具 ID 收集
// ============================================================================

/**
 * 从上下文引用收集启用的工具 ID
 *
 * @param contextRefs 上下文引用数组
 * @returns 去重后的工具 ID 数组
 */
export function collectToolsFromContextRefs(contextRefs: ContextRef[]): string[] {
  // 收集所有类型 ID
  const typeIds = contextRefs.map((ref) => ref.typeId);

  // 从注册表收集工具
  const tools = contextTypeRegistry.collectToolsForTypes(typeIds);

  return tools;
}

/**
 * 从 Store 获取启用的工具 ID
 *
 * 合并：
 * 1. 上下文引用关联的工具
 * 2. 模式插件配置的工具
 *
 * @param store ChatStore 实例
 * @returns 去重后的工具 ID 数组
 */
export function getEnabledToolIds(store: ChatStore): string[] {
  const toolSet = new Set<string>();

  // 1. 从 pendingContextRefs 收集工具
  const pendingContextRefs = store.pendingContextRefs;
  if (pendingContextRefs && pendingContextRefs.length > 0) {
    const contextTools = collectToolsFromContextRefs(pendingContextRefs);
    contextTools.forEach((tool) => toolSet.add(tool));
    console.log(LOG_PREFIX, 'Tools from context refs:', contextTools);
  }

  // 2. 模式插件的工具由 TauriAdapter.buildSendOptions 处理
  // 这里只负责上下文引用关联的工具

  return Array.from(toolSet);
}

/**
 * 检查是否有上下文关联的工具
 *
 * @param store ChatStore 实例
 * @returns 是否有工具需要启用
 */
export function hasContextTools(store: ChatStore): boolean {
  const pendingContextRefs = store.pendingContextRefs;
  if (!pendingContextRefs || pendingContextRefs.length === 0) {
    return false;
  }

  for (const ref of pendingContextRefs) {
    const tools = contextTypeRegistry.getToolsForType(ref.typeId);
    if (tools.length > 0) {
      return true;
    }
  }

  return false;
}

/**
 * 合并工具 ID 数组（去重）
 *
 * @param toolIdArrays 多个工具 ID 数组
 * @returns 合并并去重后的数组
 */
export function mergeToolIds(...toolIdArrays: (string[] | undefined)[]): string[] {
  const toolSet = new Set<string>();

  for (const arr of toolIdArrays) {
    if (arr) {
      arr.forEach((tool) => toolSet.add(tool));
    }
  }

  return Array.from(toolSet);
}
