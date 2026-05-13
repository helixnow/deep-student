/**
 * Chat V2 - 文件夹上下文引用管理 Hook
 *
 * 实现选择文件夹后，使用引用模式创建 ContextRef。
 *
 * 遵循文档 24 - LRFS统一入口模型与访达式资源管理器 Prompt 6
 *
 * 引用契约：
 * - B: VfsContextRefData, VfsResourceRef
 * - C: vfs_get_resource_refs 命令
 *
 * ★ 核心改造：引用模式 vs 快照模式
 * - 只存储 sourceId + resourceHash，不存储 path/content
 * - 发送时实时获取当前路径和内容（支持文件移动后引用仍有效）
 *
 * 约束：
 * 1. 使用 vfsRefApi.getResourceRefs 获取引用（不获取内容）
 * 2. 使用 resourceStoreApi.createOrReuse 创建资源（只存引用数据）
 * 3. 调用 store.addContextRef 添加到上下文
 * 4. 使用 getErrorMessage 统一错误处理
 * 5. 检查重复注入（同一文件夹不能重复添加）
 * 6. 检查资源数量限制（契约 D 最多 50 个）
 * 7. 空文件夹给予友好提示
 * 8. 所有操作结果通过 Toast 反馈
 */

import { useCallback, useRef } from 'react';
import type { StoreApi } from 'zustand';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { ChatStore } from '../core/types';
import { resourceStoreApi, type ContextRef } from '../resources';
import { FOLDER_TYPE_ID } from '../context/definitions/folder';
import type { VfsContextRefData } from '../context/types';
import { getErrorMessage } from '@/utils/errorUtils';
import { vfsRefApi } from '@/dstu/api/vfsRefApi';
import { folderApi } from '@/dstu/api/folderApi';
import { VfsErrorCode, isErr } from '@/shared/result';
import {
  FOLDER_CONSTRAINTS,
  type FolderResourcesResult,
  type FolderResourceInfo,
} from '@/dstu/types/folder';

// ============================================================================
// 日志前缀
// ============================================================================

const LOG_PREFIX = '[ChatV2:FolderContextRef]';

// ============================================================================
// 契约 F: 全局约束（从 @/dstu/types/folder 导入）
// ============================================================================

/** 批量注入最大资源数（契约 F） */
const MAX_FOLDER_RESOURCES = FOLDER_CONSTRAINTS.MAX_INJECT_RESOURCES;

// 类型从 @/dstu/types/folder 重导出
export type { FolderResourcesResult, FolderResourceInfo };
export type { VfsContextRefData };

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 注入结果
 */
export interface InjectFolderResult {
  success: boolean;
  contextRef?: ContextRef;
  resourceCount?: number;
  error?: string;
}

/**
 * 文件夹与资源的映射关系
 */
interface FolderResourceMapping {
  folderId: string;
  resourceId: string;
  hash: string;
}

/**
 * Hook 返回值
 */
export interface UseFolderContextRefReturn {
  /**
   * 注入文件夹到上下文
   * @param folderId 文件夹 ID
   * @returns 注入结果
   */
  injectFolder: (folderId: string) => Promise<InjectFolderResult>;

  /**
   * 移除文件夹的上下文引用
   * @param folderId 文件夹 ID
   */
  removeFolderRef: (folderId: string) => void;

  /**
   * 检查文件夹是否已注入
   * @param folderId 文件夹 ID
   */
  isFolderInjected: (folderId: string) => boolean;

  /**
   * 清空所有文件夹引用
   */
  clearAllFolderRefs: () => void;
}

/**
 * Hook 配置选项
 */
export interface UseFolderContextRefOptions {
  /** ChatStore 实例 */
  store: StoreApi<ChatStore> | null;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

// ============================================================================
// API 调用（已接线 Prompt 6 的 folderApi）
// ============================================================================

/**
 * 获取文件夹资源引用（引用模式）
 *
 * ★ 只返回 sourceId + resourceHash，不返回 path/content
 *
 * 调用后端 vfs_get_resource_refs 命令（或 Mock）
 */
async function getFolderResourceRefs(
  folderId: string,
  includeFolderContents: boolean,
  maxItems: number
): Promise<VfsContextRefData> {
  console.log(LOG_PREFIX, 'getFolderResourceRefs:', {
    folderId,
    includeFolderContents,
    maxItems,
  });

  // 调用 VFS 引用 API (V2 版本)
  const result = await vfsRefApi.getResourceRefsV2(
    [folderId],
    includeFolderContents,
    maxItems
  );

  if (isErr(result)) {
    throw new Error(result.error.toUserMessage());
  }

  return result.value;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 文件夹上下文引用管理 Hook
 *
 * 使用方式：
 * ```tsx
 * const { injectFolder, removeFolderRef, isFolderInjected } = useFolderContextRef({
 *   store: chatStore._store,
 * });
 *
 * // 注入文件夹
 * const result = await injectFolder('fld_abc123');
 *
 * // 检查是否已注入
 * const injected = isFolderInjected('fld_abc123');
 *
 * // 移除文件夹引用
 * removeFolderRef('fld_abc123');
 * ```
 */
export function useFolderContextRef(
  options: UseFolderContextRefOptions
): UseFolderContextRefReturn {
  const { store, enabled = true } = options;
  const { t } = useTranslation('chatV2');

  // 文件夹 ID -> 资源映射
  const folderMappingsRef = useRef<Map<string, FolderResourceMapping>>(new Map());

  /**
   * 检查文件夹是否已注入
   */
  const isFolderInjected = useCallback((folderId: string): boolean => {
    return folderMappingsRef.current.has(folderId);
  }, []);

  /**
   * 注入文件夹
   */
  const injectFolder = useCallback(
    async (folderId: string): Promise<InjectFolderResult> => {
      if (!enabled || !store) {
        console.warn(LOG_PREFIX, 'Hook disabled or store not available');
        return { success: false, error: 'Hook disabled or store not available' };
      }

      try {
        // 1. 检查是否已注入同一文件夹（避免重复）
        if (isFolderInjected(folderId)) {
          console.log(LOG_PREFIX, 'Folder already injected:', folderId);
          showGlobalNotification('info', t('context.folderAlreadyAdded'));
          return { success: false, error: 'already_injected' };
        }

        // 2. 调用后端获取引用（★ 只获取 sourceId + resourceHash，不获取内容）
        console.log(LOG_PREFIX, 'Getting folder resource refs:', folderId);
        const refData = await getFolderResourceRefs(
          folderId,
          true, // includeFolderContents
          MAX_FOLDER_RESOURCES
        );

        // 3. 检查数量限制（契约 D 最多 50 个）
        if (refData.truncated) {
          console.warn(
            LOG_PREFIX,
            'Folder has too many resources, truncated:',
            refData.totalCount,
            'max:',
            MAX_FOLDER_RESOURCES
          );
          showGlobalNotification('error', t('context.folderTooLarge', {
            count: refData.totalCount,
            max: MAX_FOLDER_RESOURCES,
          }));
          return { success: false, error: 'too_many_resources' };
        }

        // 4. 空文件夹给予友好提示
        if (refData.refs.length === 0) {
          console.log(LOG_PREFIX, 'Folder is empty:', folderId);
          showGlobalNotification('info', t('context.folderEmpty'));
          return { success: false, error: 'empty_folder' };
        }

        // 5. 获取文件夹信息（用于元数据）
        let folderTitle = folderId;
        let folderPath = '/';
        const folderInfoResult = await folderApi.getFolder(folderId);
        if (!isErr(folderInfoResult)) {
          const folderInfo = folderInfoResult.value;
          if (folderInfo) {
            folderTitle = folderInfo.title;
            const pathResult = await vfsRefApi.getResourcePathV2(folderId);
            if (!isErr(pathResult)) {
              folderPath = pathResult.value;
            } else {
              console.warn(LOG_PREFIX, 'Failed to get folder path:', pathResult.error.toUserMessage());
            }
          }
        } else {
          console.warn(LOG_PREFIX, 'Failed to get folder info:', folderInfoResult.error.toUserMessage());
        }

        // 6. ★ 只存储引用，不存储内容
        // resource.data 使用 VfsContextRefData 格式
        const serializedRefData = JSON.stringify(refData);

        // 7. 调用 resourceStoreApi.createOrReuse() 创建资源
        const resourceResult = await resourceStoreApi.createOrReuse({
          type: 'folder', // 使用 folder 类型存储文件夹引用数据
          data: serializedRefData, // ★ 只存引用，不存内容
          sourceId: folderId,
          metadata: {
            name: folderTitle,
            title: folderTitle,
            path: folderPath,
            refCount: refData.refs.length,
            truncated: refData.truncated,
          },
        });

        console.log(
          LOG_PREFIX,
          resourceResult.isNew ? 'Created new resource:' : 'Reused existing resource:',
          resourceResult.resourceId
        );

        // 8. 构建上下文引用
        const contextRef: ContextRef = {
          resourceId: resourceResult.resourceId,
          hash: resourceResult.hash,
          typeId: FOLDER_TYPE_ID,
        };

        // 9. 调用 store.addContextRef() 添加到上下文
        const storeState = store.getState();
        storeState.addContextRef(contextRef);
        console.log(LOG_PREFIX, 'Added folder context ref:', resourceResult.resourceId);

        // 10. 保存映射关系
        folderMappingsRef.current.set(folderId, {
          folderId,
          resourceId: resourceResult.resourceId,
          hash: resourceResult.hash,
        });

        // 11. 显示通知反馈
        showGlobalNotification('success', t('context.folderAdded', { count: refData.refs.length }));

        return {
          success: true,
          contextRef,
          resourceCount: refData.refs.length,
        };
      } catch (error: unknown) {
        const errorMessage = getErrorMessage(error);
        console.error(LOG_PREFIX, 'Failed to inject folder:', errorMessage);
        showGlobalNotification('error', t('context.folderAddFailed'));
        return { success: false, error: errorMessage };
      }
    },
    [enabled, store, isFolderInjected, t]
  );

  /**
   * 移除文件夹的上下文引用
   */
  const removeFolderRef = useCallback(
    (folderId: string) => {
      if (!enabled || !store) {
        return;
      }

      const mapping = folderMappingsRef.current.get(folderId);
      if (mapping) {
        const storeState = store.getState();
        storeState.removeContextRef(mapping.resourceId);
        folderMappingsRef.current.delete(folderId);
        console.log(LOG_PREFIX, 'Removed folder context ref:', mapping.resourceId);
      }
    },
    [enabled, store]
  );

  /**
   * 清空所有文件夹引用
   */
  const clearAllFolderRefs = useCallback(() => {
    if (!enabled || !store) {
      return;
    }

    const storeState = store.getState();
    for (const mapping of folderMappingsRef.current.values()) {
      storeState.removeContextRef(mapping.resourceId);
    }
    folderMappingsRef.current.clear();
    console.log(LOG_PREFIX, 'Cleared all folder refs');
  }, [enabled, store]);

  return {
    injectFolder,
    removeFolderRef,
    isFolderInjected,
    clearAllFolderRefs,
  };
}

// ============================================================================
// 类型重导出已在上方通过 export interface 完成
// ============================================================================
