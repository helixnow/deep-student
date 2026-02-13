/**
 * DSTU 回收站 API
 *
 * 提供软删除、恢复、列表和永久删除的前端接口。
 * 所有方法返回 Result<T, VfsError> 类型，提供类型安全的错误处理。
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { ok, err, toVfsError, type Result, type VfsError } from '@/shared/result';
import type { DstuNode } from '../types';
import {
  invalidateResourceCache,
  clearAllCaches,
} from '@/chat-v2/context/vfsRefApiEnhancements';

const LOG_PREFIX = '[DSTU:TrashAPI]';

// ============================================================================
// 缓存失效辅助函数
// ============================================================================

/**
 * 缓存失效包装器
 * 在写操作成功后调用，确保缓存与后端数据一致
 *
 * @param nodeId 节点ID
 * @param operation 操作名称（用于日志）
 */
function invalidateCacheWithLogging(nodeId: string, operation: string): void {
  try {
    invalidateResourceCache(nodeId);
    console.log(LOG_PREFIX, `${operation}() cache invalidated:`, nodeId);
  } catch (cacheError: unknown) {
    if (import.meta.env.DEV) {
      console.error(
        LOG_PREFIX,
        `${operation}() cache invalidation failed (dev mode):`,
        cacheError
      );
    } else {
      console.warn(LOG_PREFIX, `${operation}() cache invalidation failed:`, cacheError);
    }
  }
}

/**
 * 软删除资源或文件夹
 */
export async function softDelete(id: string, itemType: string): Promise<Result<void, VfsError>> {
  try {
    await invoke('dstu_soft_delete', { id, itemType });
    // [CACHE-001] 添加缓存失效
    invalidateCacheWithLogging(id, 'softDelete');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.trash.softDeleteFailed'), { id, itemType });
    console.error(LOG_PREFIX, 'softDelete() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 恢复软删除的资源或文件夹
 */
export async function restoreItem(id: string, itemType: string): Promise<Result<void, VfsError>> {
  try {
    await invoke('dstu_trash_restore', { id, itemType });
    // [CACHE-002] 添加缓存失效
    invalidateCacheWithLogging(id, 'restoreItem');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.trash.restoreFailed'), { id, itemType });
    console.error(LOG_PREFIX, 'restoreItem() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 列出回收站内容
 */
export async function listTrash(
  limit?: number,
  offset?: number
): Promise<Result<DstuNode[], VfsError>> {
  try {
    const result = await invoke<DstuNode[]>('dstu_list_trash', { limit, offset });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.trash.listFailed'), { limit, offset });
    console.error(LOG_PREFIX, 'listTrash() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 清空回收站
 */
export async function emptyTrash(): Promise<Result<number, VfsError>> {
  try {
    const count = await invoke<number>('dstu_empty_trash', {});
    // [CACHE-003] 清空回收站需要清除所有缓存，因为无法获知被删除的具体项目ID
    clearAllCaches();
    console.log(LOG_PREFIX, `emptyTrash() cleared all caches, deleted ${count} items`);
    return ok(count);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.trash.emptyFailed'), {});
    console.error(LOG_PREFIX, 'emptyTrash() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 永久删除单个资源
 */
export async function permanentlyDelete(id: string, itemType: string): Promise<Result<void, VfsError>> {
  try {
    await invoke('dstu_permanently_delete', { id, itemType });
    // [CACHE-004] 添加缓存失效
    invalidateCacheWithLogging(id, 'permanentlyDelete');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.trash.permanentlyDeleteFailed'), { id, itemType });
    console.error(LOG_PREFIX, 'permanentlyDelete() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

export const trashApi = {
  softDelete,
  restoreItem,
  listTrash,
  emptyTrash,
  permanentlyDelete,
};

export default trashApi;
