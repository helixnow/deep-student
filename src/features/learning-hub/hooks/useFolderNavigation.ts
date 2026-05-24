/**
 * 文件夹导航 Hook
 *
 * 数据契约来源：28-DSTU真实路径架构重构任务分配.md Prompt 8
 *
 * 功能：
 * 1. 支持从任意文件夹开始浏览
 * 2. 支持向上导航到父文件夹
 * 3. 集成路径面包屑
 */

import { useCallback, useState } from 'react';
import { pathApi, folderApi } from '@/dstu';
import { getErrorMessage } from '@/utils/errorUtils';
import { isErr } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 面包屑项（真实路径版）
 */
export interface RealPathBreadcrumbItem {
  /** 文件夹 ID，null 表示根目录 */
  folderId: string | null;
  /** 文件夹名称 */
  name: string;
  /** 完整路径 */
  fullPath: string;
}

/**
 * 文件夹导航状态
 */
export interface FolderNavigationState {
  /** 当前文件夹 ID，null 表示根目录 */
  currentFolderId: string | null;
  /** 当前文件夹路径 */
  currentFolderPath: string;
  /** 面包屑列表 */
  breadcrumbs: RealPathBreadcrumbItem[];
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
}

/**
 * useFolderNavigation 返回类型
 */
export interface UseFolderNavigationReturn {
  /** 导航状态 */
  navigation: FolderNavigationState;
  
  /** 导航到指定文件夹 */
  navigateTo: (folderId: string | null, folderPath?: string) => Promise<void>;
  /** 导航到父文件夹 */
  navigateUp: () => Promise<void>;
  /** 导航到面包屑位置 */
  navigateToBreadcrumb: (index: number) => void;
  /** 刷新当前位置 */
  refresh: () => Promise<void>;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * 文件夹导航 Hook
 *
 * 提供真实路径导航能力
 *
 * @example
 * ```tsx
 * const { navigation, navigateTo, navigateUp } = useFolderNavigation();
 *
 * // 导航到指定文件夹
 * await navigateTo('fld_abc123');
 *
 * // 返回上一级
 * await navigateUp();
 * ```
 */
export function useFolderNavigation(): UseFolderNavigationReturn {
  // 导航状态
  const [navigation, setNavigation] = useState<FolderNavigationState>({
    currentFolderId: null,
    currentFolderPath: '/',
    breadcrumbs: [],
    isLoading: false,
    error: null,
  });

  // ========== 导航方法 ==========

  /**
   * 从文件夹路径构建面包屑
   */
  const buildBreadcrumbsFromPath = useCallback(
    async (folderPath: string, folderId: string | null): Promise<RealPathBreadcrumbItem[]> => {
      if (!folderPath || folderPath === '/') {
        return [];
      }

      const segments = folderPath.split('/').filter(Boolean);
      const breadcrumbs: RealPathBreadcrumbItem[] = [];
      let accumulatedPath = '';

      for (let i = 0; i < segments.length; i++) {
        const name = segments[i];
        accumulatedPath = accumulatedPath ? `${accumulatedPath}/${name}` : name;

        breadcrumbs.push({
          // 只有最后一层有真实的 folderId
          folderId: i === segments.length - 1 ? folderId : null,
          name,
          fullPath: `/${accumulatedPath}`,
        });
      }

      return breadcrumbs;
    },
    []
  );

  /**
   * 导航到指定文件夹
   */
  const navigateTo = useCallback(
    async (folderId: string | null, folderPath?: string) => {
      setNavigation((prev) => ({ ...prev, isLoading: true, error: null }));

      try {
        let path = folderPath || '/';

        // 如果没有提供路径，从后端获取
        if (!folderPath && folderId) {
          try {
            path = await pathApi.getPathById(folderId);
          } catch {
            // 回退到根目录
            path = '/';
          }
        }

        // 构建面包屑
        const breadcrumbs = await buildBreadcrumbsFromPath(path, folderId);

        setNavigation({
          currentFolderId: folderId,
          currentFolderPath: path,
          breadcrumbs,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        const msg = getErrorMessage(error);
        setNavigation((prev) => ({
          ...prev,
          isLoading: false,
          error: msg,
        }));
        console.error('[useFolderNavigation] navigateTo failed:', msg);
      }
    },
    [buildBreadcrumbsFromPath]
  );

  /**
   * 导航到父文件夹
   */
  const navigateUp = useCallback(async () => {
    const { breadcrumbs, currentFolderId } = navigation;

    if (breadcrumbs.length === 0) {
      // 已经在根目录
      return;
    }

    if (breadcrumbs.length === 1) {
      // 返回根目录
      await navigateTo(null, '/');
      return;
    }

    // 获取父文件夹信息
    const parentBreadcrumb = breadcrumbs[breadcrumbs.length - 2];

    // 如果父面包屑没有 folderId，需要从后端查询
    if (!parentBreadcrumb.folderId && currentFolderId) {
      const folderResult = await folderApi.getFolder(currentFolderId);
      if (!isErr(folderResult)) {
        const currentFolder = folderResult.value;
        if (currentFolder?.parentId) {
          await navigateTo(currentFolder.parentId);
          return;
        }
      } else {
        console.error('[useFolderNavigation] Failed to get parent folder:', folderResult.error.toUserMessage());
      }
    }

    await navigateTo(parentBreadcrumb.folderId, parentBreadcrumb.fullPath);
  }, [navigation, navigateTo]);

  /**
   * 导航到面包屑位置
   */
  const navigateToBreadcrumb = useCallback(
    (index: number) => {
      const { breadcrumbs } = navigation;

      if (index < 0) {
        // 点击"根目录"
        navigateTo(null, '/');
        return;
      }

      if (index >= breadcrumbs.length) {
        return;
      }

      const target = breadcrumbs[index];
      navigateTo(target.folderId, target.fullPath);
    },
    [navigation, navigateTo]
  );

  /**
   * 刷新当前位置
   */
  const refresh = useCallback(async () => {
    const { currentFolderId, currentFolderPath } = navigation;
    await navigateTo(currentFolderId, currentFolderPath);
  }, [navigation, navigateTo]);

  return {
    navigation,
    navigateTo,
    navigateUp,
    navigateToBreadcrumb,
    refresh,
  };
}

export default useFolderNavigation;
