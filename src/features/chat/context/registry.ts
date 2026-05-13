/**
 * Chat V2 - 统一上下文注入系统 - 类型注册表
 *
 * ContextTypeRegistry 管理所有上下文类型定义，
 * 提供类型查询、工具收集和优先级排序功能。
 */

import type { ContextTypeDefinition, Resource, ContentBlock, FormatOptions } from './types';
import { createTextBlock } from './types';

// ============================================================================
// 注册表实现
// ============================================================================

/**
 * 上下文类型注册表
 * 使用 Map 存储，支持动态注册和查询
 */
class ContextTypeRegistry {
  private definitions: Map<string, ContextTypeDefinition> = new Map();

  /**
   * 注册类型定义
   * @param definition 类型定义
   * @throws 如果类型已存在且 overwrite 为 false
   */
  register(definition: ContextTypeDefinition, overwrite = false): void {
    if (this.definitions.has(definition.typeId) && !overwrite) {
      throw new Error(`Context type '${definition.typeId}' already registered`);
    }
    this.definitions.set(definition.typeId, definition);
  }

  /**
   * 批量注册类型定义
   */
  registerAll(definitions: ContextTypeDefinition[], overwrite = false): void {
    for (const def of definitions) {
      this.register(def, overwrite);
    }
  }

  /**
   * 注销类型定义
   */
  unregister(typeId: string): boolean {
    return this.definitions.delete(typeId);
  }

  /**
   * 获取类型定义
   * @param typeId 类型 ID
   * @returns 类型定义，不存在返回 undefined
   */
  get(typeId: string): ContextTypeDefinition | undefined {
    return this.definitions.get(typeId);
  }

  /**
   * 检查类型是否已注册
   */
  has(typeId: string): boolean {
    return this.definitions.has(typeId);
  }

  /**
   * 获取所有已注册的类型定义
   * @returns 按优先级排序的类型定义数组
   */
  getAll(): ContextTypeDefinition[] {
    return Array.from(this.definitions.values()).sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    );
  }

  /**
   * 获取所有类型 ID
   */
  getAllTypeIds(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * 获取类型关联的工具 ID 列表
   * @param typeId 类型 ID
   * @returns 工具 ID 数组
   */
  getToolsForType(typeId: string): string[] {
    return this.definitions.get(typeId)?.tools ?? [];
  }

  /**
   * 收集多个类型关联的所有工具 ID（去重）
   * @param typeIds 类型 ID 数组
   * @returns 去重后的工具 ID 数组
   */
  collectToolsForTypes(typeIds: string[]): string[] {
    const toolSet = new Set<string>();
    for (const typeId of typeIds) {
      const tools = this.getToolsForType(typeId);
      tools.forEach((tool) => toolSet.add(tool));
    }
    return Array.from(toolSet);
  }

  /**
   * 获取类型的优先级
   * @param typeId 类型 ID
   * @returns 优先级，默认 100
   */
  getPriority(typeId: string): number {
    return this.definitions.get(typeId)?.priority ?? 100;
  }

  /**
   * 格式化资源（安全调用）
   * 
   * ★ 文档25扩展：支持 options 参数传递模型能力
   * 
   * @param typeId 类型 ID
   * @param resource 资源实体
   * @param options 格式化选项（可选，包含 isMultimodal 等）
   * @returns 格式化后的内容块，类型不存在返回默认文本块
   */
  formatResource(typeId: string, resource: Resource, options?: FormatOptions): ContentBlock[] {
    const definition = this.definitions.get(typeId);
    if (!definition) {
      // 类型不存在，返回默认文本块
      console.warn(`[ContextTypeRegistry] Unknown type '${typeId}', using fallback format`);
      return [createTextBlock(`[Unknown type: ${typeId}]\n${resource.data}`)];
    }
    try {
      return definition.formatToBlocks(resource, options);
    } catch (error: unknown) {
      console.error(`[ContextTypeRegistry] Error formatting resource with type '${typeId}':`, error);
      return [createTextBlock(`[Format error: ${typeId}]\n${resource.data}`)];
    }
  }

  /**
   * 获取类型的标签
   * @param typeId 类型 ID
   * @param locale 语言，'zh' 或 'en'
   * @returns 标签文本
   */
  getLabel(typeId: string, locale: 'zh' | 'en' = 'zh'): string {
    const definition = this.definitions.get(typeId);
    if (!definition) {
      return typeId;
    }
    return locale === 'zh' ? definition.label : definition.labelEn;
  }

  /**
   * 获取类型的 XML 标签
   * @param typeId 类型 ID
   * @returns XML 标签名
   */
  getXmlTag(typeId: string): string | undefined {
    return this.definitions.get(typeId)?.xmlTag;
  }

  /**
   * 获取类型的 System Prompt Hint
   * @param typeId 类型 ID
   * @returns System Prompt 中的标签格式说明，不存在返回 undefined
   */
  getSystemPromptHint(typeId: string): string | undefined {
    return this.definitions.get(typeId)?.systemPromptHint;
  }

  /**
   * 收集多个类型的 System Prompt Hints（去重）
   * @param typeIds 类型 ID 数组
   * @returns 去重后的 hint 数组（已按优先级排序）
   */
  collectSystemPromptHints(typeIds: string[]): string[] {
    const hintSet = new Set<string>();
    const typeIdSet = new Set(typeIds);
    
    // 按优先级排序类型
    const sortedTypeIds = Array.from(typeIdSet).sort((a, b) => {
      return this.getPriority(a) - this.getPriority(b);
    });
    
    for (const typeId of sortedTypeIds) {
      const hint = this.getSystemPromptHint(typeId);
      if (hint) {
        hintSet.add(hint);
      }
    }
    
    return Array.from(hintSet);
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.definitions.clear();
  }

  /**
   * 获取注册的类型数量
   */
  get size(): number {
    return this.definitions.size;
  }
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * 全局上下文类型注册表单例
 */
export const contextTypeRegistry = new ContextTypeRegistry();

// 同时导出类以便测试
export { ContextTypeRegistry };
