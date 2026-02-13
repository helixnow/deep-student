/**
 * DSTU 列表 Hook
 *
 * 提供资源列表的加载、搜索、排序和分页功能。
 * 可用于 Learning Hub、笔记模块、教材模块等。
 *
 * @example
 * ```typescript
 * const { nodes, loading, error, refresh } = useDstuList('/', {
 *   typeFilter: 'note',
 *   sortBy: 'updatedAt',
 *   sortOrder: 'desc',
 * });
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { dstu } from '../api';
import type { DstuNode, DstuListOptions } from '../types';
import { type VfsError, reportError } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseDstuListOptions extends DstuListOptions {
  /** 是否自动加载 */
  autoLoad?: boolean;
  /** 依赖数组，变化时重新加载 */
  deps?: unknown[];
}

export interface UseDstuListReturn {
  /** 资源节点列表 */
  nodes: DstuNode[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误对象 */
  error: VfsError | null;
  /** 总数（如果后端支持） */
  total: number | null;
  /** 刷新列表 */
  refresh: () => Promise<void>;
  /** 加载更多（分页） */
  loadMore: () => Promise<void>;
  /** 是否有更多数据 */
  hasMore: boolean;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * DSTU 列表 Hook
 */
export function useDstuList(
  path: string,
  options: UseDstuListOptions = {}
): UseDstuListReturn {
  const {
    autoLoad = true,
    deps = [],
    limit = 50,
    offset: initialOffset = 0,
    ...listOptions
  } = options;

  const [nodes, setNodes] = useState<DstuNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<VfsError | null>(null);
  const [offset, setOffset] = useState(initialOffset);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState<number | null>(null);

  // 保存最新的选项引用
  const optionsRef = useRef(listOptions);
  optionsRef.current = listOptions;

  // 加载数据
  const load = useCallback(async (reset = false) => {
    if (!path) return;

    setLoading(true);
    setError(null);

    const currentOffset = reset ? 0 : offset;
    const result = await dstu.list(path, {
      ...optionsRef.current,
      limit,
      offset: currentOffset,
    });

    if (result.ok) {
      if (reset) {
        setNodes(result.value);
        setOffset(limit);
      } else {
        setNodes((prev) => [...prev, ...result.value]);
        setOffset(currentOffset + limit);
      }

      // 判断是否有更多数据
      setHasMore(result.value.length >= limit);

      // 如果结果少于 limit，可以估算 total
      if (result.value.length < limit) {
        setTotal(reset ? result.value.length : offset + result.value.length);
      }
    } else {
      reportError(result.error, '加载列表');
      setError(result.error);
    }

    setLoading(false);
  }, [path, offset, limit]);

  // 刷新
  const refresh = useCallback(async () => {
    setOffset(0);
    await load(true);
  }, [load]);

  // 加载更多
  const loadMore = useCallback(async () => {
    if (!hasMore || loading) return;
    await load(false);
  }, [hasMore, loading, load]);

  // 自动加载
  useEffect(() => {
    if (autoLoad && path) {
      setNodes([]);
      setOffset(0);
      setHasMore(true);
      load(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, autoLoad, ...deps]);

  return {
    nodes,
    loading,
    error,
    total,
    refresh,
    loadMore,
    hasMore,
  };
}

// ============================================================================
// 简化版 Hooks
// ============================================================================

/**
 * 获取笔记列表
 */
export function useDstuNotes(options?: Omit<UseDstuListOptions, 'typeFilter'>) {
  return useDstuList('/', {
    ...options,
    typeFilter: 'note',
  });
}

/**
 * 获取教材列表
 */
export function useDstuTextbooks(options?: Omit<UseDstuListOptions, 'typeFilter'>) {
  return useDstuList('/', {
    ...options,
    typeFilter: 'textbook',
  });
}

/**
 * 获取题目集列表
 */
export function useDstuExams(options?: Omit<UseDstuListOptions, 'typeFilter'>) {
  return useDstuList('/', {
    ...options,
    typeFilter: 'exam',
  });
}

/**
 * 获取翻译列表
 */
export function useDstuTranslations(options?: Omit<UseDstuListOptions, 'typeFilter'>) {
  return useDstuList('/', {
    ...options,
    typeFilter: 'translation',
  });
}

/**
 * 获取作文列表
 */
export function useDstuEssays(options?: Omit<UseDstuListOptions, 'typeFilter'>) {
  return useDstuList('/', {
    ...options,
    typeFilter: 'essay',
  });
}

// ============================================================================
// 文件夹优先模式 Hooks
// ============================================================================

/**
 * 文件夹导航模式 Hook
 *
 * 列出指定文件夹下的所有资源（混合类型：笔记+翻译+图片等）
 *
 * @param folderId 文件夹 ID（null 表示根目录）
 * @param options 其他选项
 */
export function useDstuFolder(
  folderId: string | null,
  options?: Omit<UseDstuListOptions, 'folderId'>
) {
  // 统一使用根路径，通过 folderId 参数筛选
  const path = '/';

  return useDstuList(path, {
    ...options,
    folderId: folderId ?? undefined,
  });
}

/**
 * 智能文件夹模式 Hook
 *
 * 按类型筛选资源，但返回的 path 仍是文件夹路径
 * 
 * @param typeFilter 类型筛选
 * @param options 其他选项
 */
export function useDstuSmartFolder(
  typeFilter: DstuListOptions['typeFilter'],
  options?: Omit<UseDstuListOptions, 'typeFilter'>
) {
  // 统一使用根路径，通过 typeFilter 参数筛选
  const path = '/';

  return useDstuList(path, {
    ...options,
    typeFilter,
  });
}

/**
 * 通用文件夹优先模式 Hook
 *
 * 根据 finderStore 的当前状态加载资源列表
 * 支持文件夹导航和智能文件夹两种模式
 *
 * @param dstuListOptions 从 finderStore.getDstuListOptions() 获取的选项
 * @param extraOptions 额外选项
 */
export function useDstuListWithOptions(
  dstuListOptions: DstuListOptions,
  extraOptions?: Omit<UseDstuListOptions, keyof DstuListOptions>
) {
  // 统一使用根路径，通过 folderId/typeFilter 参数筛选
  const path = '/';

  return useDstuList(path, {
    ...extraOptions,
    ...dstuListOptions,
  });
}
