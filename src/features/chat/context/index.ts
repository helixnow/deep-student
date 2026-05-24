/**
 * Chat V2 - 统一上下文注入系统
 *
 * 导出所有上下文相关类型和工具
 *
 * 核心概念：
 * - Resource: 资源实体，存储实际内容，基于 hash 去重
 * - ContextRef: 上下文引用，只包含 resourceId + hash + typeId
 * - SendContextRef: 发送时的引用，包含 formattedBlocks
 * - ContextTypeDefinition: 类型定义，包含 formatToBlocks 方法
 * - ContextTypeRegistry: 类型注册表，管理所有类型定义
 */

// ============================================================================
// 类型导出
// ============================================================================

export type {
  ResourceType,
  Resource,
  ResourceMetadata,
  CreateResourceParams,
  CreateResourceResult,
  ContextRef,
  ContextSnapshot,
  ContentBlock,
  TextContentBlock,
  ImageContentBlock,
  SendContextRef,
  ContextTypeDefinition,
  FormatOptions,
} from './types';

// VFS 引用模式类型（文档 24）
export type {
  VfsResourceType,
  VfsContextRefData,
  VfsResourceRef,
  ResolvedResource,
  FolderItemWithPath,
  DstuNodeExtended,
  MultimodalContentBlock,
} from './vfsRefTypes';

// ============================================================================
// 工具函数导出
// ============================================================================

export {
  isTextContentBlock,
  isImageContentBlock,
  isValidResourceType,
  createTextBlock,
  createImageBlock,
  createXmlTextBlock,
  createEmptyContextSnapshot,
  mergeContextSnapshots,
} from './types';

// VFS 引用模式工具函数和常量（文档 24）
export {
  // ★★★ 统一类型映射（SSOT）★★★
  VFS_REF_TYPES,
  isVfsRefType,
  // 旧版兼容（已 deprecated）
  isVfsResourceType,
  // 类型守卫
  isVfsContextRefData,
  isVfsResourceRef,
  // 常量
  VFS_REF_ERRORS,
  VFS_MAX_INJECTION_ITEMS,
  VFS_MAX_PATH_LENGTH,
  VFS_MAX_PATH_DEPTH,
} from './vfsRefTypes';

export type { VfsRefType } from './vfsRefTypes';

// VFS 引用 API
export {
  getResourceRefsV2,
  resolveResourceRefsV2,
  getResourcePathV2,
  updatePathCacheV2,
  createSingleResourceRefData,
  uploadAttachment,
  vfsRefApi,
} from './vfsRefApi';
export type { VfsRefApiType } from './vfsRefApi';

// VFS Blob API（文档 25）
export {
  getBlobBase64,
  getBlobAsDataUrl,
  getBlobsAsDataUrls,
  preloadBlobs,
  clearBlobCache,
  getBlobCacheStats,
  blobApi,
} from './blobApi';
export type { VfsBlobBase64Result, GetBlobOptions, BlobApiType } from './blobApi';

// ============================================================================
// 注册表导出
// ============================================================================

export { contextTypeRegistry, ContextTypeRegistry } from './registry';

// ============================================================================
// 预定义类型定义导出
// ============================================================================

// Note 类型
export { noteDefinition, NOTE_TYPE_ID } from './definitions/note';
export type { NoteMetadata } from './definitions/note';

// ★ 2025-12-26: Card 类型已删除，不再使用

// Image 类型
export {
  imageDefinition,
  IMAGE_TYPE_ID,
  SUPPORTED_IMAGE_TYPES,
  isSupportedImageType,
} from './definitions/image';
export type { ImageMetadata } from './definitions/image';

// File 类型
export {
  fileDefinition,
  FILE_TYPE_ID,
  SUPPORTED_TEXT_FILE_TYPES,
  isSupportedTextFileType,
} from './definitions/file';
export type { FileMetadata } from './definitions/file';

// Retrieval 类型
export {
  retrievalDefinition,
  RETRIEVAL_TYPE_ID,
  RETRIEVAL_SOURCES,
  isValidRetrievalSource,
} from './definitions/retrieval';
export type { RetrievalMetadata, RetrievalSource } from './definitions/retrieval';

// ============================================================================
// 批量导出
// ============================================================================

export {
  builtInDefinitions,
  definitionMap,
  builtInTypeIds,
  isBuiltInType,
  getAllBuiltInToolIds,
} from './definitions';
export type { BuiltInTypeId } from './definitions';

// ============================================================================
// 初始化函数
// ============================================================================

import { contextTypeRegistry } from './registry';
import { builtInDefinitions } from './definitions';

/**
 * 是否已初始化标记
 */
let _initialized = false;

/**
 * 初始化上下文类型系统
 * 注册所有预定义类型到全局注册表
 *
 * 此函数应在应用启动时调用一次
 * 重复调用不会有副作用（幂等）
 */
export function initializeContextSystem(): void {
  if (_initialized) {
    return;
  }

  // 注册所有预定义类型
  contextTypeRegistry.registerAll(builtInDefinitions);

  _initialized = true;
  console.log('[ContextSystem] Initialized with', contextTypeRegistry.size, 'built-in types');
}

/**
 * 重置上下文类型系统（仅用于测试）
 */
export function resetContextSystem(): void {
  contextTypeRegistry.clear();
  _initialized = false;
}

/**
 * 检查上下文类型系统是否已初始化
 */
export function isContextSystemInitialized(): boolean {
  return _initialized;
}
