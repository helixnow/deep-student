/**
 * DSTU 资源 Hook
 *
 * 提供单个资源的获取、内容加载、更新和删除功能。
 *
 * @example
 * ```typescript
 * const { node, content, loading, save, refresh } = useDstuResource('/note_123');
 * ```
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { dstu } from '../api';
import type { DstuNode, DstuCreateOptions } from '../types';
import { type VfsError, reportError } from '@/shared/result';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseDstuResourceOptions {
  /** 是否自动加载 */
  autoLoad?: boolean;
  /** 是否加载内容 */
  loadContent?: boolean;
  /** 内容变化回调 */
  onContentChange?: (content: string) => void;
}

export interface UseDstuResourceReturn {
  /** 资源节点 */
  node: DstuNode | null;
  /** 资源内容（仅文本类型） */
  content: string | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 错误对象 */
  error: VfsError | null;
  /** 内容是否已修改 */
  isDirty: boolean;
  /** 刷新资源 */
  refresh: () => Promise<void>;
  /** 更新内容（本地，不保存） */
  setContent: (content: string) => void;
  /** 保存内容到后端 */
  save: () => Promise<void>;
  /** 删除资源 */
  remove: () => Promise<void>;
}

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * DSTU 资源 Hook
 */
export function useDstuResource(
  path: string | null,
  options: UseDstuResourceOptions = {}
): UseDstuResourceReturn {
  const { autoLoad = true, loadContent = true, onContentChange } = options;

  const [node, setNode] = useState<DstuNode | null>(null);
  const [content, setContentState] = useState<string | null>(null);
  const [originalContent, setOriginalContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<VfsError | null>(null);

  // 计算是否已修改
  const isDirty = content !== null && originalContent !== null && content !== originalContent;

  // 保存回调引用
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  // 加载资源
  const load = useCallback(async () => {
    if (!path) {
      setNode(null);
      setContentState(null);
      setOriginalContent(null);
      return;
    }

    setLoading(true);
    setError(null);

    // 获取节点信息
    const nodeResult = await dstu.get(path);
    if (nodeResult.ok) {
      setNode(nodeResult.value);

      // 加载内容
      if (loadContent && nodeResult.value) {
        const contentResult = await dstu.getContent(path);
        if (contentResult.ok) {
          if (typeof contentResult.value === 'string') {
            setContentState(contentResult.value);
            setOriginalContent(contentResult.value);
          } else {
            // Blob 类型暂不支持
            setContentState(null);
            setOriginalContent(null);
          }
        } else {
          reportError(contentResult.error, 'Get content');
          setError(contentResult.error);
        }
      }
    } else {
      reportError(nodeResult.error, 'Get resource');
      setError(nodeResult.error);
    }

    setLoading(false);
  }, [path, loadContent]);

  // 刷新
  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  // 更新内容（本地）
  const setContent = useCallback((newContent: string) => {
    setContentState(newContent);
    onContentChangeRef.current?.(newContent);
  }, []);

  // 保存内容
  const save = useCallback(async () => {
    if (!path || content === null || !node) return;

    setSaving(true);
    setError(null);

    const result = await dstu.update(path, content, node.type);
    if (result.ok) {
      setNode(result.value);
      setOriginalContent(content);
    } else {
      reportError(result.error, 'Save resource');
      setError(result.error);
      throw result.error;
    }

    setSaving(false);
  }, [path, content, node]);

  // 删除资源
  const remove = useCallback(async () => {
    if (!path) return;

    setLoading(true);
    setError(null);

    const result = await dstu.delete(path);
    if (result.ok) {
      setNode(null);
      setContentState(null);
      setOriginalContent(null);
    } else {
      reportError(result.error, 'Delete resource');
      setError(result.error);
      throw result.error;
    }

    setLoading(false);
  }, [path]);

  // 自动加载
  useEffect(() => {
    if (autoLoad) {
      load();
    }
  }, [autoLoad, load]);

  return {
    node,
    content,
    loading,
    saving,
    error,
    isDirty,
    refresh,
    setContent,
    save,
    remove,
  };
}

// ============================================================================
// 创建资源 Hook
// ============================================================================

export interface UseDstuCreateReturn {
  /** 是否正在创建 */
  creating: boolean;
  /** 错误对象 */
  error: VfsError | null;
  /** 创建资源 */
  create: (path: string, options: DstuCreateOptions) => Promise<DstuNode>;
}

/**
 * DSTU 创建资源 Hook
 */
export function useDstuCreate(): UseDstuCreateReturn {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<VfsError | null>(null);

  const create = useCallback(async (path: string, options: DstuCreateOptions): Promise<DstuNode> => {
    setCreating(true);
    setError(null);

    const result = await dstu.create(path, options);
    if (result.ok) {
      setCreating(false);
      return result.value;
    } else {
      reportError(result.error, 'Create resource');
      setError(result.error);
      setCreating(false);
      throw result.error;
    }
  }, []);

  return {
    creating,
    error,
    create,
  };
}

// ============================================================================
// 搜索 Hook
// ============================================================================

export interface UseDstuSearchOptions {
  /** 搜索延迟（毫秒） */
  debounceMs?: number;
  /** 最小搜索长度 */
  minLength?: number;
  /** 限制结果数量 */
  limit?: number;
}

export interface UseDstuSearchReturn {
  /** 搜索结果 */
  results: DstuNode[];
  /** 是否正在搜索 */
  searching: boolean;
  /** 错误对象 */
  error: VfsError | null;
  /** 执行搜索 */
  search: (query: string) => void;
  /** 清除结果 */
  clear: () => void;
}

/**
 * DSTU 搜索 Hook
 */
export function useDstuSearch(options: UseDstuSearchOptions = {}): UseDstuSearchReturn {
  const { debounceMs = 300, minLength = 1, limit = 20 } = options;

  const [results, setResults] = useState<DstuNode[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<VfsError | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((query: string) => {
    // 清除之前的定时器
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // 检查最小长度
    if (query.length < minLength) {
      setResults([]);
      return;
    }

    // 防抖搜索
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      setError(null);

      const result = await dstu.search(query, { limit });
      if (result.ok) {
        setResults(result.value);
      } else {
        reportError(result.error, 'Search resource');
        setError(result.error);
      }

      setSearching(false);
    }, debounceMs);
  }, [debounceMs, minLength, limit]);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setResults([]);
    setError(null);
  }, []);

  // 清理
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return {
    results,
    searching,
    error,
    search,
    clear,
  };
}
