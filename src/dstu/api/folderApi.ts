/**
 * DSTU 文件夹 API 封装
 *
 * 封装 Tauri invoke 调用，提供统一的文件夹访问接口。
 * 所有方法返回 Result<T, VfsError> 类型，提供类型安全的错误处理。
 *
 * 数据契约来源：23-VFS文件夹架构与上下文注入改造任务分配.md 契约 D
 *
 * 约束：
 * 1. 所有方法使用 invoke 调用后端 dstu_folder_* 命令
 * 2. 错误处理使用 Result 模式，不使用 try-catch
 * 3. 直接使用真实后端 API
 */

import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { ok, err, toVfsError, type Result } from '@/shared/result';
import type {
  VfsFolder,
  VfsFolderItem,
  FolderTreeNode,
  FolderResourcesResult,
  FolderItemType,
} from '../types/folder';
import { updatePathCacheV2 } from '@/chat-v2/context/vfsRefApi';
import { invalidateResourceCache } from '@/chat-v2/context/vfsRefApiEnhancements';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[DSTU:FolderAPI]';

// ============================================================================
// 缓存失效辅助函数
// ============================================================================

/**
 * 缓存失效包装器
 * [CACHE-005] 在写操作成功后调用，确保缓存与后端数据一致
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

// ============================================================================
// D1: 文件夹管理
// ============================================================================

/**
 * 创建文件夹
 */
export async function createFolder(
  title: string,
  parentId?: string,
  icon?: string,
  color?: string
): Promise<Result<VfsFolder>> {
  try {
    const result = await invoke<VfsFolder>('dstu_folder_create', {
      title,
      parentId: parentId ?? null,
      icon: icon ?? null,
      color: color ?? null,
    });
    // [CACHE-005] 添加缓存失效
    invalidateCacheWithLogging(result.id, 'createFolder[post]');
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.createFailed'), { title, parentId, icon, color });
    console.error(LOG_PREFIX, 'createFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 获取文件夹
 */
export async function getFolder(folderId: string): Promise<Result<VfsFolder>> {
  try {
    const result = await invoke<VfsFolder | null>('dstu_folder_get', {
      folderId,
    });
    if (result === null) {
      return err(toVfsError(new Error('NOT_FOUND'), i18next.t('dstu:api.folder.notFound'), { folderId }));
    }
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.getFailed'), { folderId });
    console.error(LOG_PREFIX, 'getFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 重命名文件夹
 */
export async function renameFolder(folderId: string, title: string): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_rename', {
      folderId,
      title,
    });
    // [CACHE-005] 添加缓存失效
    invalidateCacheWithLogging(folderId, 'renameFolder[post]');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.renameFailed'), { folderId, title });
    console.error(LOG_PREFIX, 'renameFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 删除文件夹
 */
export async function deleteFolder(folderId: string): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_delete', {
      folderId,
    });
    // [CACHE-005] 添加缓存失效
    invalidateCacheWithLogging(folderId, 'deleteFolder[post]');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.deleteFailed'), { folderId });
    console.error(LOG_PREFIX, 'deleteFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 移动文件夹选项
 */
export interface MoveFolderOptions {
  /** 跳过缓存刷新（批量操作时使用） */
  skipCacheRefresh?: boolean;
}

/**
 * 移动文件夹
 */
export async function moveFolder(folderId: string, newParentId?: string, options?: MoveFolderOptions): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_move', {
      folderId,
      newParentId: newParentId ?? null,
    });

    // [CACHE-005] 添加资源缓存失效
    invalidateCacheWithLogging(folderId, 'moveFolder[post]');

    // ★ 批量操作时跳过单次缓存刷新，由调用方统一刷新
    if (!options?.skipCacheRefresh) {
      const cacheResult = await updatePathCacheV2(folderId);
      if (cacheResult.ok) {
        console.log(`[PathCache] Updated ${cacheResult.value} cache entries (folder ${folderId})`);
      } else {
        console.warn('[PathCache] Cache refresh failed:', cacheResult.error.message);
      }
    }

    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.moveFailed'), { folderId, newParentId });
    console.error(LOG_PREFIX, 'moveFolder() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 设置文件夹展开状态
 */
export async function setFolderExpanded(folderId: string, isExpanded: boolean): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_set_expanded', {
      folderId,
      isExpanded,
    });
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.setExpandedFailed'), { folderId, isExpanded });
    console.error(LOG_PREFIX, 'setFolderExpanded() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// D2: 内容管理
// ============================================================================

/**
 * 添加内容到文件夹
 */
export async function addItem(
  folderId: string | null,
  itemType: FolderItemType,
  itemId: string
): Promise<Result<VfsFolderItem>> {
  try {
    const result = await invoke<VfsFolderItem>('dstu_folder_add_item', {
      folderId,
      itemType,
      itemId,
    });
    // [CACHE-005-EXT] 添加缓存失效
    invalidateCacheWithLogging(itemId, 'addItem[post]');
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.addItemFailed'), { folderId, itemType, itemId });
    console.error(LOG_PREFIX, 'addItem() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 从文件夹移除内容
 */
export async function removeItem(itemType: FolderItemType, itemId: string): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_remove_item', {
      itemType,
      itemId,
    });
    // [CACHE-005-EXT] 添加缓存失效
    invalidateCacheWithLogging(itemId, 'removeItem[post]');
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.removeItemFailed'), { itemType, itemId });
    console.error(LOG_PREFIX, 'removeItem() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 移动内容项选项
 */
export interface MoveItemOptions {
  /** 跳过缓存刷新（批量操作时使用） */
  skipCacheRefresh?: boolean;
}

/**
 * 移动内容到另一文件夹
 */
export async function moveItem(
  itemType: FolderItemType,
  itemId: string,
  newFolderId?: string,
  options?: MoveItemOptions
): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_move_item', {
      itemType,
      itemId,
      newFolderId: newFolderId ?? null,
    });

    // [CACHE-005] 添加资源缓存失效（对移动的 item 本身）
    invalidateCacheWithLogging(itemId, 'moveItem[post]');

    // ★ 批量操作时跳过单次缓存刷新，由调用方统一刷新
    if (newFolderId && !options?.skipCacheRefresh) {
      const cacheResult = await updatePathCacheV2(newFolderId);
      if (cacheResult.ok) {
        console.log(`[PathCache] Updated ${cacheResult.value} cache entries (folder ${newFolderId})`);
      } else {
        console.warn('[PathCache] Cache refresh failed:', cacheResult.error.message);
      }
    }

    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.moveItemFailed'), { itemType, itemId, newFolderId });
    console.error(LOG_PREFIX, 'moveItem() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// D3: 查询
// ============================================================================

/**
 * 列出所有文件夹
 */
export async function listFolders(): Promise<Result<VfsFolder[]>> {
  try {
    const result = await invoke<VfsFolder[]>('dstu_folder_list', {});
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.listFailed'));
    console.error(LOG_PREFIX, 'listFolders() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 获取文件夹树
 */
export async function getFolderTree(): Promise<Result<FolderTreeNode[]>> {
  try {
    const result = await invoke<FolderTreeNode[]>('dstu_folder_get_tree', {});
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.getTreeFailed'));
    console.error(LOG_PREFIX, 'getFolderTree() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 获取文件夹内容项
 */
export async function getFolderItems(folderId?: string): Promise<Result<VfsFolderItem[]>> {
  try {
    const result = await invoke<VfsFolderItem[]>('dstu_folder_get_items', {
      folderId: folderId ?? null,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.getItemsFailed'), { folderId });
    console.error(LOG_PREFIX, 'getFolderItems() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// D4: 上下文注入专用
// ============================================================================

/**
 * 获取文件夹下所有资源
 */
export async function getFolderAllResources(
  folderId: string,
  includeSubfolders: boolean,
  includeContent: boolean
): Promise<Result<FolderResourcesResult>> {
  try {
    const result = await invoke<FolderResourcesResult>('dstu_folder_get_all_resources', {
      folderId,
      includeSubfolders,
      includeContent,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.getResourcesFailed'), { folderId, includeSubfolders, includeContent });
    console.error(LOG_PREFIX, 'getFolderAllResources() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// D5: 排序
// ============================================================================

/**
 * 重新排序文件夹
 */
export async function reorderFolders(folderIds: string[]): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_reorder', {
      folderIds,
    });
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.reorderFailed'), { folderIds });
    console.error(LOG_PREFIX, 'reorderFolders() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// D6: 面包屑导航
// ============================================================================

/**
 * 面包屑项类型（与后端 BreadcrumbItem 对应）
 */
export interface BreadcrumbItem {
  /** 文件夹 ID */
  id: string;
  /** 文件夹名称 */
  name: string;
}

/**
 * 获取文件夹面包屑（从根到当前文件夹的完整路径）
 *
 * @param folderId 文件夹 ID
 * @returns 从根到当前文件夹的面包屑列表
 */
export async function getBreadcrumbs(folderId: string): Promise<Result<BreadcrumbItem[]>> {
  try {
    const result = await invoke<BreadcrumbItem[]>('dstu_folder_get_breadcrumbs', {
      folderId,
    });
    return ok(result);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.getBreadcrumbsFailed'), { folderId });
    console.error(LOG_PREFIX, 'getBreadcrumbs() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

/**
 * 重新排序文件夹内容项
 */
export async function reorderItems(folderId: string | null, itemIds: string[]): Promise<Result<void>> {
  try {
    await invoke<void>('dstu_folder_reorder_items', {
      folderId,
      itemIds,
    });
    return ok(undefined);
  } catch (error: unknown) {
    const vfsError = toVfsError(error, i18next.t('dstu:api.folder.reorderItemsFailed'), { folderId, itemIds });
    console.error(LOG_PREFIX, 'reorderItems() failed:', vfsError.toDetailedMessage());
    return err(vfsError);
  }
}

// ============================================================================
// 导出统一 API 对象
// ============================================================================

export const folderApi = {
  createFolder,
  getFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  setFolderExpanded,
  addItem,
  removeItem,
  moveItem,
  listFolders,
  getFolderTree,
  getFolderItems,
  getFolderAllResources,
  reorderFolders,
  reorderItems,
  getBreadcrumbs,
};

export type FolderApiType = typeof folderApi;
