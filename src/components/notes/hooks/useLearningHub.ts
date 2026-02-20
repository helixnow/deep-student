/**
 * Learning Hub Hook
 *
 * 将 Learning Hub 与 DSTU 访达协议层集成的核心 Hook。
 * 提供统一的资源管理接口，封装 DSTU API 调用。
 *
 * 数据契约来源：21-VFS虚拟文件系统架构设计.md 第四章 4.5
 *
 * @see 22-VFS与DSTU访达协议层改造任务分配.md Prompt 8
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { dstu } from '@/dstu/api';
import { pathUtils } from '@/dstu/utils/pathUtils';
import { openResource as dstuOpenResource } from '@/dstu/openResource';
import { getErrorMessage } from '@/utils/errorUtils';
import { buildContextMenu, registerContextMenuActionHandler } from '@/dstu/contextMenu';
import type { DstuNode, DstuListOptions, DstuCreateOptions } from '@/dstu/types';
import type { ContextMenuItem } from '@/dstu/editorTypes';
import { type VfsError, reportError } from '@/shared/result';
import { updatePathCacheV2 } from '@/chat-v2/context/vfsRefApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18next from 'i18next';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Learning Hub 状态
 */
export interface LearningHubState {
  /** 是否正在加载 */
  isLoading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 当前路径下的资源列表 */
  items: DstuNode[];
  /** 当前选中的资源路径 */
  selectedPath: string | null;
  /** 当前预览的资源 */
  previewNode: DstuNode | null;
  /** 搜索结果 */
  searchResults: DstuNode[];
  /** 是否正在搜索 */
  isSearching: boolean;
}

/**
 * Learning Hub 操作
 */
export interface LearningHubActions {
  /** 刷新当前目录 */
  refresh: () => Promise<void>;
  /** 列出目录内容 */
  list: (path: string, options?: DstuListOptions) => Promise<DstuNode[]>;
  /** 获取资源详情 */
  get: (path: string) => Promise<DstuNode | null>;
  /** 创建资源 */
  create: (path: string, options: DstuCreateOptions) => Promise<DstuNode>;
  /** 更新资源内容 */
  update: (path: string, content: string, resourceType: string) => Promise<DstuNode>;
  /** 删除资源 */
  delete: (path: string) => Promise<void>;
  /** 移动资源 */
  move: (srcPath: string, dstPath: string) => Promise<DstuNode>;
  /** 复制资源 */
  copy: (srcPath: string, dstPath: string) => Promise<DstuNode>;
  /** 搜索资源 */
  search: (query: string, options?: DstuListOptions) => Promise<DstuNode[]>;
  /** 获取资源内容 */
  getContent: (path: string) => Promise<string | Blob>;
  /** 设置元数据 */
  setMetadata: (path: string, metadata: Record<string, unknown>) => Promise<void>;
  /** 打开资源 */
  openResource: (pathOrNode: string | DstuNode) => Promise<void>;
  /** 构建右键菜单 */
  buildContextMenu: (node: DstuNode) => ContextMenuItem[];
  /** 设置选中路径 */
  setSelectedPath: (path: string | null) => void;
  /** 设置预览节点 */
  setPreviewNode: (node: DstuNode | null) => void;
}

/**
 * useLearningHub 返回值
 */
export interface UseLearningHubReturn extends LearningHubState, LearningHubActions {
  /** 当前路径 */
  currentPath: string;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * Learning Hub Hook
 *
 * 使用示例：
 * ```tsx
 * const {
 *   items,
 *   isLoading,
 *   refresh,
 *   openResource,
 *   buildContextMenu,
 * } = useLearningHub();
 *
 * // 列出笔记
 * useEffect(() => {
 *   refresh();
 * }, []);
 *
 * // 打开笔记
 * const handleOpen = (node: DstuNode) => {
 *   openResource(node);
 * };
 *
 * // 右键菜单
 * const menuItems = buildContextMenu(selectedNode);
 * ```
 */
export function useLearningHub(options?: {
  /** 初始路径（默认为根目录） */
  initialPath?: string;
  /** 资源类型过滤 */
  typeFilter?: DstuListOptions['typeFilter'];
  /** 是否自动加载 */
  autoLoad?: boolean;
}): UseLearningHubReturn {
  const { initialPath, typeFilter, autoLoad = true } = options ?? {};

  const currentPath = useMemo(() => {
    if (initialPath) return initialPath;
    return '/';
  }, [initialPath]);

  // 状态
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<DstuNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<DstuNode | null>(null);
  const [searchResults, setSearchResults] = useState<DstuNode[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // 请求序列号（防止竞态）
  const requestSeqRef = useRef(0);

  // ========== 核心 API 方法 ==========

  /**
   * 列出目录内容
   */
  const list = useCallback(async (
    path: string,
    listOptions?: DstuListOptions
  ): Promise<DstuNode[]> => {
    const result = await dstu.list(path, {
      ...listOptions,
      typeFilter: listOptions?.typeFilter ?? typeFilter,
    });

    if (result.ok) {
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.list_directory'));
      throw result.error;
    }
  }, [typeFilter]);

  /**
   * 刷新当前目录
   */
  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await list('/', { typeFilter: 'note' });

      // 防止竞态
      if (seq !== requestSeqRef.current) return;

      setItems(result);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setError(getErrorMessage(err));
      setItems([]);
    } finally {
      if (seq === requestSeqRef.current) {
        setIsLoading(false);
      }
    }
  }, [list]);

  /**
   * 获取资源详情
   */
  const get = useCallback(async (path: string): Promise<DstuNode | null> => {
    const result = await dstu.get(path);
    if (result.ok) {
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.get_resource'));
      return null;
    }
  }, []);

  /**
   * 创建资源
   */
  const create = useCallback(async (
    path: string,
    createOptions: DstuCreateOptions
  ): Promise<DstuNode> => {
    const result = await dstu.create(path, createOptions);
    if (result.ok) {
      // 刷新列表
      await refresh();
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.create_resource'));
      throw result.error;
    }
  }, [refresh]);

  /**
   * 更新资源内容
   */
  const update = useCallback(async (
    path: string,
    content: string,
    resourceType: string
  ): Promise<DstuNode> => {
    const result = await dstu.update(path, content, resourceType);
    if (result.ok) {
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.update_resource'));
      throw result.error;
    }
  }, []);

  /**
   * 删除资源
   */
  const deleteResource = useCallback(async (path: string): Promise<void> => {
    const result = await dstu.delete(path);
    if (result.ok) {
      // 刷新列表
      await refresh();
    } else {
      reportError(result.error, i18next.t('notes:errors.delete_resource'));
      throw result.error;
    }
  }, [refresh]);

  /**
   * 移动资源
   */
  const move = useCallback(async (
    srcPath: string,
    dstPath: string
  ): Promise<DstuNode> => {
    const result = await dstu.move(srcPath, dstPath);

    if (result.ok) {
      // 刷新路径缓存（如果移动后的资源有 folderId）
      const folderId = result.value.metadata?.folderId as string | undefined;
      if (folderId) {
        const cacheResult = await updatePathCacheV2(folderId);
        if (cacheResult.ok) {
          console.log(`[PathCache] 更新了 ${cacheResult.value} 项缓存 (资源 ${result.value.id} 移动到文件夹 ${folderId})`);
        } else {
          console.warn('[PathCache] 缓存刷新失败:', cacheResult.error.message);
          // 不阻塞主流程，仅警告
        }
      }

      // 刷新列表
      await refresh();
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.move_resource'));
      throw result.error;
    }
  }, [refresh]);

  /**
   * 复制资源
   */
  const copy = useCallback(async (
    srcPath: string,
    dstPath: string
  ): Promise<DstuNode> => {
    const result = await dstu.copy(srcPath, dstPath);
    if (result.ok) {
      // 刷新列表
      await refresh();
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.copy_resource'));
      throw result.error;
    }
  }, [refresh]);

  /**
   * 搜索资源
   */
  const search = useCallback(async (
    query: string,
    searchOptions?: DstuListOptions
  ): Promise<DstuNode[]> => {
    if (!query.trim()) {
      setSearchResults([]);
      return [];
    }

    const seq = ++requestSeqRef.current;
    setIsSearching(true);

    const result = await dstu.search(query, {
      ...searchOptions,
      typeFilter: searchOptions?.typeFilter ?? typeFilter,
    });

    if (seq !== requestSeqRef.current) {
      return result.ok ? result.value : [];
    }

    if (result.ok) {
      setSearchResults(result.value);
      setIsSearching(false);
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.search_resource'));
      setSearchResults([]);
      setIsSearching(false);
      return [];
    }
  }, [typeFilter]);

  /**
   * 获取资源内容
   */
  const getContent = useCallback(async (path: string): Promise<string | Blob> => {
    const result = await dstu.getContent(path);
    if (result.ok) {
      return result.value;
    } else {
      reportError(result.error, i18next.t('notes:errors.get_content'));
      throw result.error;
    }
  }, []);

  /**
   * 设置元数据
   */
  const setMetadata = useCallback(async (
    path: string,
    metadata: Record<string, unknown>
  ): Promise<void> => {
    const result = await dstu.setMetadata(path, metadata);
    if (result.ok) {
      return;
    } else {
      reportError(result.error, i18next.t('notes:errors.set_metadata'));
      throw result.error;
    }
  }, []);

  /**
   * 打开资源
   */
  const openResource = useCallback(async (pathOrNode: string | DstuNode): Promise<void> => {
    try {
      await dstuOpenResource(pathOrNode);
    } catch (err) {
      console.error('[LearningHub] openResource failed:', getErrorMessage(err));
      // 如果 handler 未注册，静默失败
    }
  }, []);

  /**
   * 构建右键菜单
   */
  const buildContextMenuForNode = useCallback((node: DstuNode): ContextMenuItem[] => {
    return buildContextMenu(node);
  }, []);

  // ========== 副作用 ==========

  // 自动加载
  useEffect(() => {
    if (autoLoad) {
      void refresh();
    }
  }, [autoLoad, refresh]);

  // 注册菜单动作处理器
  useEffect(() => {
    const unregister = registerContextMenuActionHandler({
      confirmDelete: async (path) => {
        // TODO: 显示确认对话框
        await deleteResource(path);
      },
      copyResource: async (path) => {
        await copy(path, `${path}_copy`);
      },
      shareResource: async (path) => {
        try {
          await copyTextToClipboard(path);
          showGlobalNotification('success', i18next.t('notes:learningHub.share_success_message'), i18next.t('notes:learningHub.share_success_title'));
        } catch (error) {
          console.error('[LearningHub] shareResource failed:', getErrorMessage(error));
          showGlobalNotification('error', i18next.t('notes:learningHub.share_failed_message'), i18next.t('notes:learningHub.share_failed_title'));
        }
      },
      // 其他处理器可以由宿主组件注册
    });

    return unregister;
  }, [deleteResource, copy]);

  // ========== 返回值 ==========

  return {
    // 状态
    isLoading,
    error,
    items,
    selectedPath,
    previewNode,
    searchResults,
    isSearching,
    currentPath,

    // 操作
    refresh,
    list,
    get,
    create,
    update,
    delete: deleteResource,
    move,
    copy,
    search,
    getContent,
    setMetadata,
    openResource,
    buildContextMenu: buildContextMenuForNode,
    setSelectedPath,
    setPreviewNode,
  };
}

// ============================================================================
// 辅助 Hooks
// ============================================================================

/**
 * 构建 DSTU 路径的便捷 Hook
 */
export function useDstuPathBuilder() {
  return useCallback((
    _type: 'note' | 'textbook' | 'exam' | 'translation' | 'essay',
    id?: string
  ): string => {
    return id ? `/${id}` : '/';
  }, []);
}

/**
 * 解析 DSTU 路径的便捷 Hook
 */
export function useDstuPathParser() {
  return useCallback((path: string) => {
    return pathUtils.parse(path);
  }, []);
}

export default useLearningHub;
