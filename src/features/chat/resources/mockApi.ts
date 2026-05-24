/**
 * Chat V2 - 资源库 Mock API
 *
 * 用于后端 Tauri commands 未实现时的独立开发和测试。
 *
 * 特性：
 * 1. 内存存储，模拟资源库行为
 * 2. 支持去重（基于 hash）
 * 3. 支持引用计数
 * 4. 文件大小验证
 */

import {
  type ResourceStoreApi,
  type Resource,
  type CreateResourceParams,
  type CreateResourceResult,
  type ResourceType,
  IMAGE_SIZE_LIMIT,
  FILE_SIZE_LIMIT,
} from './types';
import {
  calculateHash,
  generateResourceId,
  arrayBufferToBase64,
  validateFileSize,
} from './utils';
import { ResourceSizeLimitError } from './api';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:MockResourceStore]';
const IS_VITEST = typeof process !== 'undefined' && Boolean(process.env?.VITEST);

// ============================================================================
// 内存存储
// ============================================================================

/**
 * 内存资源存储
 *
 * Map 结构：
 * - resourceMap: Map<resourceId, Resource>
 * - hashIndex: Map<hash, resourceId> - 用于去重查询
 * - sourceIndex: Map<sourceId, resourceId[]> - 用于按原始数据查询版本
 */
class InMemoryResourceStore {
  private resourceMap = new Map<string, Resource>();
  private hashIndex = new Map<string, string>();
  private sourceIndex = new Map<string, string[]>();

  /**
   * 存储资源
   */
  set(resource: Resource): void {
    this.resourceMap.set(resource.id, resource);
    this.hashIndex.set(resource.hash, resource.id);

    if (resource.sourceId) {
      const ids = this.sourceIndex.get(resource.sourceId) || [];
      if (!ids.includes(resource.id)) {
        ids.push(resource.id);
        this.sourceIndex.set(resource.sourceId, ids);
      }
    }
  }

  /**
   * 获取资源
   */
  get(resourceId: string): Resource | undefined {
    return this.resourceMap.get(resourceId);
  }

  /**
   * 通过 hash 查找资源 ID
   */
  getIdByHash(hash: string): string | undefined {
    return this.hashIndex.get(hash);
  }

  /**
   * 通过 sourceId 获取所有版本的资源 ID
   */
  getIdsBySource(sourceId: string): string[] {
    return this.sourceIndex.get(sourceId) || [];
  }

  /**
   * 检查资源是否存在
   */
  has(resourceId: string): boolean {
    return this.resourceMap.has(resourceId);
  }

  /**
   * 删除资源
   */
  delete(resourceId: string): boolean {
    const resource = this.resourceMap.get(resourceId);
    if (!resource) {
      return false;
    }

    // 从 hashIndex 中移除
    this.hashIndex.delete(resource.hash);

    // 从 sourceIndex 中移除
    if (resource.sourceId) {
      const ids = this.sourceIndex.get(resource.sourceId);
      if (ids) {
        const newIds = ids.filter((id) => id !== resourceId);
        if (newIds.length > 0) {
          this.sourceIndex.set(resource.sourceId, newIds);
        } else {
          this.sourceIndex.delete(resource.sourceId);
        }
      }
    }

    return this.resourceMap.delete(resourceId);
  }

  /**
   * 清空存储
   */
  clear(): void {
    this.resourceMap.clear();
    this.hashIndex.clear();
    this.sourceIndex.clear();
  }

  /**
   * 获取存储统计信息
   */
  getStats(): { resourceCount: number; hashCount: number; sourceCount: number } {
    return {
      resourceCount: this.resourceMap.size,
      hashCount: this.hashIndex.size,
      sourceCount: this.sourceIndex.size,
    };
  }

  /**
   * 遍历所有资源
   */
  forEach(callback: (resource: Resource) => void): void {
    this.resourceMap.forEach(callback);
  }
}

// ============================================================================
// Mock API 实现
// ============================================================================

/**
 * Mock 资源库 API 实现
 *
 * 功能与真实 API 相同，但数据存储在内存中。
 * 适用于：
 * - 后端未实现时的前端开发
 * - 单元测试
 * - 功能演示
 */
class MockResourceStoreApi implements ResourceStoreApi {
  private store = new InMemoryResourceStore();

  /**
   * 创建或复用资源（基于哈希去重）
   */
  async createOrReuse(params: CreateResourceParams): Promise<CreateResourceResult> {
    // 1. 验证文件大小
    const dataSize =
      typeof params.data === 'string'
        ? new TextEncoder().encode(params.data).length
        : params.data.byteLength;

    if (!validateFileSize(dataSize, params.type)) {
      const limit = params.type === 'image' ? IMAGE_SIZE_LIMIT : FILE_SIZE_LIMIT;
      throw new ResourceSizeLimitError(dataSize, limit, params.type);
    }

    // 2. 计算 hash
    const hash = await calculateHash(params.data);

    // 3. 检查是否已存在（去重）
    const existingId = this.store.getIdByHash(hash);
    if (existingId) {
      const existing = this.store.get(existingId);
      if (existing) {
        if (!IS_VITEST) {
          console.log(LOG_PREFIX, 'Reusing existing resource:', existingId);
        }
        return {
          resourceId: existingId,
          hash,
          isNew: false,
        };
      }
    }

    // 4. 创建新资源
    const resourceId = generateResourceId();
    const dataString =
      typeof params.data === 'string'
        ? params.data
        : arrayBufferToBase64(params.data);

    const resource: Resource = {
      id: resourceId,
      hash,
      type: params.type,
      sourceId: params.sourceId,
      data: dataString,
      metadata: params.metadata,
      refCount: 0, // 新创建的资源 refCount = 0
      createdAt: Date.now(),
    };

    this.store.set(resource);
    if (!IS_VITEST) {
      console.log(LOG_PREFIX, 'Created new resource:', resourceId, 'hash:', hash);
    }

    return {
      resourceId,
      hash,
      isNew: true,
    };
  }

  /**
   * 通过 ID 获取资源
   *
   * VFS 模式下按 ID 获取，不需要 hash（VFS 不支持按版本查询）。
   */
  async get(resourceId: string): Promise<Resource | null> {
    const resource = this.store.get(resourceId);
    if (!resource) {
      return null;
    }

    return { ...resource };
  }

  /**
   * 获取资源的最新版本
   */
  async getLatest(resourceId: string): Promise<Resource | null> {
    const resource = this.store.get(resourceId);
    if (!resource) {
      return null;
    }
    return { ...resource }; // 返回副本
  }

  /**
   * 检查资源是否存在
   */
  async exists(resourceId: string): Promise<boolean> {
    return this.store.has(resourceId);
  }

  /**
   * 增加引用计数
   */
  async incrementRef(resourceId: string): Promise<void> {
    const resource = this.store.get(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }
    resource.refCount += 1;
    if (!IS_VITEST) {
      console.log(LOG_PREFIX, 'incrementRef:', resourceId, 'new refCount:', resource.refCount);
    }
  }

  /**
   * 减少引用计数
   */
  async decrementRef(resourceId: string): Promise<void> {
    const resource = this.store.get(resourceId);
    if (!resource) {
      throw new Error(`Resource not found: ${resourceId}`);
    }
    resource.refCount = Math.max(0, resource.refCount - 1);
    if (!IS_VITEST) {
      console.log(LOG_PREFIX, 'decrementRef:', resourceId, 'new refCount:', resource.refCount);
    }
  }

  /**
   * 获取某原始数据的所有版本
   */
  async getVersionsBySource(sourceId: string): Promise<Resource[]> {
    const ids = this.store.getIdsBySource(sourceId);
    const resources: Resource[] = [];

    for (const id of ids) {
      const resource = this.store.get(id);
      if (resource) {
        resources.push({ ...resource });
      }
    }

    // 按创建时间降序排列（最新版本在前）
    return resources.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ========================================================================
  // 测试辅助方法（不在接口中定义，仅供测试使用）
  // ========================================================================

  /**
   * 清空存储（测试用）
   */
  _clear(): void {
    this.store.clear();
    if (!IS_VITEST) {
      console.log(LOG_PREFIX, 'Store cleared');
    }
  }

  /**
   * 获取存储统计信息（测试用）
   */
  _getStats(): { resourceCount: number; hashCount: number; sourceCount: number } {
    return this.store.getStats();
  }

  /**
   * 直接设置资源（测试用，绕过正常流程）
   */
  _setResource(resource: Resource): void {
    this.store.set(resource);
  }

  /**
   * 直接获取资源（测试用，不验证 hash）
   */
  _getResource(resourceId: string): Resource | undefined {
    return this.store.get(resourceId);
  }
}

// ============================================================================
// 导出单例
// ============================================================================

/**
 * Mock 资源库 API 单例
 *
 * 用于后端未实现时的开发测试
 */
export const mockResourceStoreApi = new MockResourceStoreApi();

// 同时导出类，允许创建独立实例用于隔离测试
export { MockResourceStoreApi };
