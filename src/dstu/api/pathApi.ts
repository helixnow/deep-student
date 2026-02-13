/**
 * DSTU 路径 API
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md 契约 E
 *
 * 约束：
 * 1. 所有 API 返回 Promise
 * 2. 使用 getErrorMessage 统一错误处理
 * 3. 调用后端 dstu_* 命令
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { invalidateResourceCache } from '@/chat-v2/context/vfsRefApiEnhancements';
import type {
  ParsedPath,
  ResourceLocation,
  BatchMoveRequest,
  BatchMoveResult,
} from '../types/path';
import type { DstuNode } from '../types';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[DSTU:PathAPI]';

// ============================================================================
// 路径解析 API
// ============================================================================

/**
 * 解析路径（调用后端）
 *
 * 后端会进行数据库查询以验证路径有效性
 *
 * @param path 路径字符串
 * @returns 解析结果
 */
async function parsePath(path: string): Promise<ParsedPath> {
  try {
    const result = await invoke<ParsedPath>('dstu_parse_path', { path });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'parsePath() failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 构建路径（调用后端）
 *
 * 后端会根据 folderId 查询文件夹路径
 *
 * @param folderId 文件夹 ID，null 表示根目录
 * @param resourceId 资源 ID
 * @returns 完整路径字符串
 */
async function buildPath(
  folderId: string | null,
  resourceId: string
): Promise<string> {
  try {
    const result = await invoke<string>('dstu_build_path', {
      folderId,
      resourceId,
    });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'buildPath() failed:', getErrorMessage(error));
    throw error;
  }
}

// ============================================================================
// 资源定位 API
// ============================================================================

/**
 * 获取资源定位信息
 *
 * @param resourceId 资源 ID
 * @returns 资源位置信息
 */
async function getResourceLocation(
  resourceId: string
): Promise<ResourceLocation> {
  try {
    const result = await invoke<ResourceLocation>('dstu_get_resource_location', {
      resourceId,
    });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getResourceLocation() failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 根据路径获取资源
 *
 * @param path 完整路径
 * @returns 资源节点，不存在返回 null
 */
async function getResourceByPath(path: string): Promise<DstuNode | null> {
  try {
    const result = await invoke<DstuNode | null>('dstu_get_resource_by_path', {
      path,
    });
    return result;
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    // NOT_FOUND 是正常情况
    if (msg.includes('not found') || msg.includes('NOT_FOUND')) {
      return null;
    }
    console.error(LOG_PREFIX, 'getResourceByPath() failed:', msg);
    throw error;
  }
}

// ============================================================================
// 移动操作 API
// ============================================================================

/**
 * 移动资源到文件夹
 *
 * 核心变更：只更新 folder_items.folder_id，不更新资源表的 subject
 *
 * @param resourceId 资源 ID
 * @param targetFolderId 目标文件夹 ID，null 表示根目录
 * @returns 新的资源位置信息
 */
async function moveToFolder(
  resourceId: string,
  targetFolderId: string | null
): Promise<ResourceLocation> {
  try {
    const result = await invoke<ResourceLocation>('dstu_move_to_folder', {
      resourceId,
      targetFolderId,
    });
    // [CACHE-006] 添加缓存失效
    try {
      invalidateResourceCache(resourceId);
    } catch (e: unknown) {
      console.warn(LOG_PREFIX, 'moveToFolder cache invalidation failed:', e);
    }
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'moveToFolder() failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 批量移动资源（逐项处理，结构化结果）
 *
 * 逐项处理移动操作，返回成功和失败的详细信息：
 * - 成功项正常移动并触发缓存失效
 * - 失败项记录在 failedItems 中，不影响其他项
 *
 * @param request 批量移动请求
 * @returns 移动结果，包含成功列表和失败列表
 * @throws 仅在通信/系统级错误时抛出
 */
async function batchMove(request: BatchMoveRequest): Promise<BatchMoveResult> {
  try {
    const result = await invoke<BatchMoveResult>('dstu_batch_move', {
      request,
    });
    // [CACHE-006] 批量缓存失效
    for (const success of result.successes) {
      try {
        invalidateResourceCache(success.id);
      } catch (e: unknown) {
        console.warn(LOG_PREFIX, 'batchMove cache invalidation failed:', e);
      }
    }
    // [L-036] 记录失败项以便定位问题
    if (result.failedItems && result.failedItems.length > 0) {
      console.warn(
        LOG_PREFIX,
        `batchMove partial failure: ${result.failedItems.length} item(s) failed`,
        result.failedItems
      );
    }
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'batchMove() failed:', getErrorMessage(error));
    throw error;
  }
}

// ============================================================================
// 路径缓存 API
// ============================================================================

/**
 * 刷新路径缓存
 *
 * @param resourceId 资源 ID，不传则全量刷新
 * @returns 刷新的条目数
 */
async function refreshPathCache(resourceId?: string): Promise<number> {
  try {
    const result = await invoke<number>('dstu_refresh_path_cache', {
      resourceId: resourceId || null,
    });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'refreshPathCache() failed:', getErrorMessage(error));
    throw error;
  }
}

/**
 * 根据资源 ID 获取路径
 *
 * 优先从缓存获取，缓存未命中则实时计算
 *
 * @param resourceId 资源 ID
 * @returns 完整路径
 */
async function getPathById(resourceId: string): Promise<string> {
  try {
    const result = await invoke<string>('dstu_get_path_by_id', {
      resourceId,
    });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getPathById() failed:', getErrorMessage(error));
    throw error;
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查资源是否存在
 *
 * @param resourceId 资源 ID
 * @returns 是否存在
 */
async function resourceExists(resourceId: string): Promise<boolean> {
  try {
    await getResourceLocation(resourceId);
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查路径是否存在
 *
 * @param path 路径字符串
 * @returns 是否存在
 */
async function pathExists(path: string): Promise<boolean> {
  const resource = await getResourceByPath(path);
  return resource !== null;
}

/**
 * 批量移动资源（简化版，仅返回成功项）
 *
 * 注意：失败项信息会丢失，如需失败详情请使用 batchMove()
 *
 * @param itemIds 资源 ID 列表
 * @param targetFolderId 目标文件夹 ID
 * @returns 成功移动的资源定位信息列表
 */
async function batchMoveSimple(
  itemIds: string[],
  targetFolderId: string | null
): Promise<ResourceLocation[]> {
  const result = await batchMove({ itemIds, targetFolderId });
  return result.successes;
}

// ============================================================================
// 导出
// ============================================================================

/**
 * DSTU 路径 API
 *
 * 所有方法调用后端，返回 Promise
 *
 * @example
 * ```typescript
 * import { pathApi } from '@/dstu/api/pathApi';
 *
 * // 获取资源位置
 * const location = await pathApi.getResourceLocation('note_abc123');
 *
 * // 移动资源到文件夹
 * const newLocation = await pathApi.moveToFolder('note_abc123', 'fld_xyz');
 *
 * // 批量移动
 * const results = await pathApi.batchMove({
 *   itemIds: ['note_1', 'note_2'],
 *   targetFolderId: 'fld_target',
 * });
 *
 * ```
 */
export const pathApi = {
  // 路径解析
  parse: parsePath,
  build: buildPath,

  // 资源定位
  getResourceLocation,
  getResourceByPath,

  // 移动
  moveToFolder,
  batchMove,
  batchMoveSimple,

  // 缓存
  refreshPathCache,
  getPathById,

  // 辅助函数
  resourceExists,
  pathExists,
};

export type PathApiType = typeof pathApi;
