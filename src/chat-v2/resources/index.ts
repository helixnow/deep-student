/**
 * Chat V2 - 资源库模块统一导出
 *
 * 根据配置决定使用真实 API 还是 Mock API。
 *
 * 使用方式：
 * ```typescript
 * import { resourceStoreApi, type Resource, type ContextRef } from '@/chat-v2/resources';
 *
 * // 创建资源
 * const { resourceId, hash, isNew } = await resourceStoreApi.createOrReuse({
 *   type: 'note',
 *   data: noteContent,
 *   sourceId: noteId,
 * });
 *
 * // 获取资源（VFS 模式按 ID 获取，不需要 hash）
 * const resource = await resourceStoreApi.get(resourceId);
 * ```
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  // 资源类型
  ResourceType,
  Resource,
  ResourceMetadata,
  // 内容块类型
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
  // 上下文引用
  ContextRef,
  SendContextRef,
  ContextSnapshot,
  // API 参数和返回类型
  CreateResourceParams,
  CreateResourceResult,
  ResourceStoreApi,
} from './types';

// 常量导出
export { IMAGE_SIZE_LIMIT, FILE_SIZE_LIMIT } from './types';

// ============================================================================
// 工具函数导出
// ============================================================================

export {
  // Hash 计算
  calculateHash,
  calculateStringHash,
  calculateBufferHash,
  // ID 生成
  generateResourceId,
  // 数据转换
  arrayBufferToBase64,
  base64ToArrayBuffer,
  fileToBase64,
  fileToArrayBuffer,
  // 验证函数
  validateFileSize,
  getFileSizeLimitText,
  formatFileSize,
  // 类型判断
  getResourceTypeFromMime,
  isImageMimeType,
  isTextMimeType,
} from './utils';

// ============================================================================
// 错误类导出
// ============================================================================

export { ResourceSizeLimitError } from './api';

// ============================================================================
// API 导出
// ============================================================================

// 真实 API（调用 Tauri 后端）
export { tauriResourceStoreApi } from './api';

// Mock API（用于 Web/测试环境）
export { mockResourceStoreApi, MockResourceStoreApi } from './mockApi';

import { tauriResourceStoreApi } from './api';
import { mockResourceStoreApi } from './mockApi';

/**
 * 资源库 API 单例
 *
 * 运行时选择：
 * - Tauri：使用真实 API（调用后端 VFS）
 * - Web/单元测试：使用 Mock API（内存实现）
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export const resourceStoreApi = isTauriRuntime() ? tauriResourceStoreApi : mockResourceStoreApi;

// ============================================================================
// 便捷方法导出
// ============================================================================

/**
 * 快速创建资源并返回引用
 *
 * @param type 资源类型
 * @param data 资源数据
 * @param sourceId 原始数据 ID（可选）
 * @param metadata 元数据（可选）
 * @returns ContextRef
 */
export async function createResourceRef(
  type: import('./types').ResourceType,
  data: string | ArrayBuffer,
  sourceId?: string,
  metadata?: import('./types').ResourceMetadata
): Promise<import('./types').ContextRef> {
  const { resourceId, hash } = await resourceStoreApi.createOrReuse({
    type,
    data,
    sourceId,
    metadata,
  });

  return {
    resourceId,
    hash,
    typeId: type,
  };
}

/**
 * 验证并获取资源
 *
 * VFS 模式下按 ID 直接获取（不区分版本）。
 *
 * @param ref 上下文引用
 * @returns 资源实体和是否为最新版本的标志
 */
export async function getResourceWithFallback(
  ref: import('./types').ContextRef
): Promise<{ resource: import('./types').Resource | null; isLatestVersion: boolean }> {
  const resource = await resourceStoreApi.get(ref.resourceId);
  return { resource, isLatestVersion: resource !== null };
}
