/**
 * Chat V2 - 资源库 API 封装
 *
 * 封装 Tauri invoke 调用，提供前端与后端资源库的接口。
 * 
 * ⚠️ 统一架构修复（2025-12-06）：
 * 所有命令已改为使用 resources.db（独立资源库），命令前缀 resources_
 *
 * 约束：
 * 1. 使用 invoke 调用后端命令
 * 2. 所有命令前缀 resources_（指向 resources.db）
 * 3. 大文件限制：图片 < 10MB，文件 < 50MB
 * 4. 错误处理使用 getErrorMessage
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  type ResourceStoreApi,
  type Resource,
  type CreateResourceParams,
  type CreateResourceResult,
  IMAGE_SIZE_LIMIT,
  FILE_SIZE_LIMIT,
} from './types';
import {
  calculateHash,
  arrayBufferToBase64,
  validateFileSize,
  getFileSizeLimitText,
} from './utils';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:ResourceStore]';

// ============================================================================
// 错误类
// ============================================================================

/**
 * 资源大小超限错误
 */
export class ResourceSizeLimitError extends Error {
  constructor(
    public readonly actualSize: number,
    public readonly limitSize: number,
    public readonly resourceType: string
  ) {
    super(
      `Resource size ${actualSize} bytes exceeds limit ${limitSize} bytes for type '${resourceType}'`
    );
    this.name = 'ResourceSizeLimitError';
  }
}

// ============================================================================
// Tauri 后端调用参数类型
// ============================================================================

/**
 * 后端 createOrReuse 参数（与后端 CreateResourceParams 对齐）
 *
 * 后端字段使用 camelCase 序列化
 */
interface BackendCreateResourceParams {
  type: string;
  data: string; // Base64 编码或纯文本
  sourceId?: string;
  metadata?: Record<string, unknown>; // JSON 对象（后端是 Option<serde_json::Value>）
}

/**
 * 后端返回的创建结果
 */
interface BackendCreateResourceResult {
  resourceId: string;
  hash: string;
  isNew: boolean;
}

/**
 * 后端返回的资源结构（与 VFS VfsResource 对齐）
 *
 * 已迁移至 VFS，字段与 VfsResource 保持一致
 */
interface BackendResource {
  id: string;
  hash: string;
  /** VFS 序列化为 "type" (通过 #[serde(rename = "type")]) */
  type: string;
  sourceId?: string;
  sourceTable?: string;
  storageMode: 'inline' | 'external';
  /** 内嵌内容（inline 模式） */
  data?: string;
  /** 外部文件哈希（external 模式） */
  externalHash?: string;
  metadata?: Record<string, unknown>;
  refCount: number;
  createdAt: number;
}

// ============================================================================
// 真实 API 实现
// ============================================================================

/**
 * 真实的资源库 API 实现（调用 VFS 后端）
 *
 * 🆕 已迁移至 VFS 统一存储，不再使用独立的 resources.db
 */
class TauriResourceStoreApi implements ResourceStoreApi {
  /**
   * 创建或复用资源（基于哈希去重）
   */
  async createOrReuse(params: CreateResourceParams): Promise<CreateResourceResult> {
    try {
      // 1. 验证文件大小
      const dataSize =
        typeof params.data === 'string'
          ? new TextEncoder().encode(params.data).length
          : params.data.byteLength;

      if (!validateFileSize(dataSize, params.type)) {
        const limit = params.type === 'image' ? IMAGE_SIZE_LIMIT : FILE_SIZE_LIMIT;
        throw new ResourceSizeLimitError(dataSize, limit, params.type);
      }

      // 2. 将数据转换为字符串（二进制数据使用 Base64）
      let dataString: string;
      if (typeof params.data === 'string') {
        dataString = params.data;
      } else {
        dataString = arrayBufferToBase64(params.data);
      }

      // 3. 准备元数据（后端接受 JSON 对象，无需序列化为字符串）
      const metadata = params.metadata
        ? (params.metadata as Record<string, unknown>)
        : undefined;

      // 4. 调用 VFS 后端（已统一存储到 vfs.db）
      // 注意：后端命令需要 params 结构体包装
      const result = await invoke<BackendCreateResourceResult>(
        'vfs_create_or_reuse',
        {
          params: {
            type: params.type,
            data: dataString,
            sourceId: params.sourceId,
            metadata,
            // VFS 支持科目隔离，附件暂不分科目
            subject: null,
          },
        }
      );

      console.log(LOG_PREFIX, 'createOrReuse result:', result);

      return {
        resourceId: result.resourceId,
        hash: result.hash,
        isNew: result.isNew,
      };
    } catch (error: unknown) {
      if (error instanceof ResourceSizeLimitError) {
        throw error;
      }
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'createOrReuse failed:', errorMsg);
      throw new Error(`Failed to create resource: ${errorMsg}`);
    }
  }

  /**
   * 通过 ID 获取资源
   *
   * VFS 模式下按 ID 获取，不需要 hash（VFS 不支持按版本查询）。
   */
  async get(resourceId: string): Promise<Resource | null> {
    try {
      const backendResource = await invoke<BackendResource | null>('vfs_get_resource', {
        resourceId,
      });

      if (!backendResource) {
        return null;
      }

      return this.convertBackendResource(backendResource);
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'get failed:', errorMsg);
      throw new Error(`Failed to get resource: ${errorMsg}`);
    }
  }

  /**
   * 获取资源的最新版本
   */
  async getLatest(resourceId: string): Promise<Resource | null> {
    try {
      // VFS 直接获取资源（总是最新版本）
      const backendResource = await invoke<BackendResource | null>(
        'vfs_get_resource',
        { resourceId }
      );

      if (!backendResource) {
        return null;
      }

      return this.convertBackendResource(backendResource);
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'getLatest failed:', errorMsg);
      throw new Error(`Failed to get latest resource: ${errorMsg}`);
    }
  }

  /**
   * 检查资源是否存在
   */
  async exists(resourceId: string): Promise<boolean> {
    try {
      return await invoke<boolean>('vfs_resource_exists', { resourceId });
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'exists failed:', errorMsg);
      throw new Error(`Failed to check resource existence: ${errorMsg}`);
    }
  }

  /**
   * 增加引用计数
   */
  async incrementRef(resourceId: string): Promise<void> {
    try {
      await invoke('vfs_increment_ref', { resourceId });
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'incrementRef failed:', errorMsg);
      throw new Error(`Failed to increment ref: ${errorMsg}`);
    }
  }

  /**
   * 减少引用计数
   */
  async decrementRef(resourceId: string): Promise<void> {
    try {
      await invoke('vfs_decrement_ref', { resourceId });
    } catch (error: unknown) {
      const errorMsg = getErrorMessage(error);
      console.error(LOG_PREFIX, 'decrementRef failed:', errorMsg);
      throw new Error(`Failed to decrement ref: ${errorMsg}`);
    }
  }

  /**
   * 获取某原始数据的所有版本
   *
   * 注意：VFS 目前不支持版本历史查询，返回空数组
   * TODO: 如需版本管理，可后续扩展 VFS
   */
  async getVersionsBySource(_sourceId: string): Promise<Resource[]> {
    // VFS 暂不支持版本历史查询
    console.warn(LOG_PREFIX, 'getVersionsBySource not supported in VFS, returning empty array');
    return [];
  }

  /**
   * 转换后端资源结构为前端类型
   */
  private convertBackendResource(backend: BackendResource): Resource {
    return {
      id: backend.id,
      hash: backend.hash,
      type: backend.type as Resource['type'],
      sourceId: backend.sourceId,
      // VFS 使用 storageMode='inline' 时 data 在 data 字段，external 时在 externalHash
      data: backend.data || '',
      metadata: backend.metadata as Resource['metadata'],
      refCount: backend.refCount,
      createdAt: backend.createdAt,
    };
  }
}

// ============================================================================
// 导出单例
// ============================================================================

/**
 * 真实的 Tauri 资源库 API（调用后端）
 *
 * 注意：后端命令尚未实现时，调用会失败。
 * 开发阶段请使用 mockResourceStoreApi。
 */
export const tauriResourceStoreApi: ResourceStoreApi = new TauriResourceStoreApi();

/**
 * 默认导出的资源库 API
 *
 * 在集成测试前使用 Mock 实现，集成后切换为真实实现。
 * 具体切换逻辑在 index.ts 中根据环境变量或配置决定。
 */
export { tauriResourceStoreApi as resourceStoreApi };
