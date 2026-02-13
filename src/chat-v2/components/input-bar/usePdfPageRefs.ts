/**
 * usePdfPageRefs - PDF 页码引用 Hook
 *
 * 监听 PDF Viewer 广播的 `pdf-page-refs:update` 事件，
 * 维护当前选中的页码引用状态，供 InputBar 展示 Chips 及发送时附加引用标签。
 *
 * 事件协议：
 * - pdf-page-refs:update  ← PDF Viewer 广播选中页码变化
 * - pdf-page-refs:clear   → 通知 PDF Viewer 清除选择（发送后）
 * - pdf-page-refs:remove  → 通知 PDF Viewer 移除单页（用户在 Chips 中移除）
 */

import { useState, useCallback, useEffect, useRef } from 'react';

// ============================================================================
// 类型定义
// ============================================================================

export interface PdfPageRefsState {
  /** 资源 sourceId（用于构建 [PDF@sourceId:page] 标签） */
  sourceId: string;
  /** 资源显示名称 */
  sourceName: string;
  /** 选中的页码列表（已排序，1-indexed） */
  pages: number[];
}

export interface UsePdfPageRefsReturn {
  /** 当前页码引用状态（无选择时为 null） */
  pageRefs: PdfPageRefsState | null;
  /** 清除所有页码引用（同步通知 PDF Viewer） */
  clearPageRefs: () => void;
  /** 移除单个页码引用（同步通知 PDF Viewer） */
  removePageRef: (page: number) => void;
  /** 构建引用标签字符串，如 [PDF@sourceId:1][PDF@sourceId:3] */
  buildRefTags: () => string;
  /** 是否有选中的页码 */
  hasPageRefs: boolean;
}

// ============================================================================
// Hook 实现
// ============================================================================

export function usePdfPageRefs(): UsePdfPageRefsReturn {
  const [pageRefs, setPageRefs] = useState<PdfPageRefsState | null>(null);
  // 用 ref 保持最新值，避免在事件回调中闭包过期
  const pageRefsRef = useRef<PdfPageRefsState | null>(null);
  pageRefsRef.current = pageRefs;

  // 监听 PDF Viewer 广播的选择变化
  useEffect(() => {
    const handler = (event: Event) => {
      const { sourceId, sourceName, pages } = (event as CustomEvent<{
        sourceId: string;
        sourceName: string;
        pages: number[];
      }>).detail;

      if (!pages || pages.length === 0) {
        setPageRefs(null);
      } else {
        setPageRefs({ sourceId, sourceName, pages });
      }
    };

    document.addEventListener('pdf-page-refs:update', handler);
    return () => document.removeEventListener('pdf-page-refs:update', handler);
  }, []);

  // 清除所有页码引用
  const clearPageRefs = useCallback(() => {
    setPageRefs(null);
    document.dispatchEvent(new CustomEvent('pdf-page-refs:clear'));
  }, []);

  // 移除单个页码
  const removePageRef = useCallback((page: number) => {
    const current = pageRefsRef.current;
    if (!current) return;

    const newPages = current.pages.filter((p) => p !== page);
    if (newPages.length === 0) {
      clearPageRefs();
    } else {
      setPageRefs({ ...current, pages: newPages });
      // 通知 PDF Viewer 移除单页选择
      document.dispatchEvent(new CustomEvent('pdf-page-refs:remove', {
        detail: { page },
      }));
    }
  }, [clearPageRefs]);

  // 构建引用标签
  const buildRefTags = useCallback((): string => {
    const current = pageRefsRef.current;
    if (!current || current.pages.length === 0) return '';
    return current.pages
      .map((p) => `[PDF@${current.sourceId}:${p}]`)
      .join('');
  }, []);

  return {
    pageRefs,
    clearPageRefs,
    removePageRef,
    buildRefTags,
    hasPageRefs: pageRefs !== null && pageRefs.pages.length > 0,
  };
}
