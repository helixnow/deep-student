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

export interface SelectedPdfPagesContextSnapshot {
  sourceId: string;
  sourceName: string;
  locator: string;
  text: string;
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
  /** 构建所选页面的正文快照（供发送时自动作为 <selection> 上下文喂给模型） */
  getSelectedPagesContext?: () => SelectedPdfPagesContextSnapshot | null;
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
  // 缓存 PDF 阅读器实时抽取的所选页文本（page -> cleaned text）
  const pageTextsMapRef = useRef<Map<number, string>>(new Map());
  const numPagesRef = useRef<number>(0);

  // 监听 PDF Viewer 广播的选择变化与所选页正文内容
  useEffect(() => {
    const handler = (event: Event) => {
      const { sourceId, sourceName, pages } = (event as CustomEvent<{
        sourceId: string;
        sourceName: string;
        pages: number[];
      }>).detail;

      const current = pageRefsRef.current;

      if (!pages || pages.length === 0) {
        // ★ 多 tab 修复：仅当清空事件来自当前源时才清除 chips，
        // 避免后台 tab 的空选择覆盖活跃源状态
        if (!current || current.sourceId === sourceId) {
          pageTextsMapRef.current.clear();
          setPageRefs(null);
        }
        return;
      }

      // ★ 多 tab 修复：切换到新源时，通知旧 PDF tab 清除其页选高亮，
      // 保证「PDF 内高亮」与「聊天 chips」状态一致（单一活跃源模型）
      if (current && current.sourceId !== sourceId) {
        pageTextsMapRef.current.clear();
        numPagesRef.current = 0;
        document.dispatchEvent(new CustomEvent('pdf-page-refs:clear', {
          detail: { sourceId: current.sourceId },
        }));
      }
      setPageRefs({ sourceId, sourceName, pages });
    };

    const contentHandler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sourceId?: string;
          numPages?: number;
          pageTexts?: Array<{ page: number; text: string }>;
        }>
      ).detail;
      const current = pageRefsRef.current;
      if (!detail?.pageTexts || (current && detail.sourceId && detail.sourceId !== current.sourceId)) {
        return;
      }
      if (typeof detail.numPages === 'number' && detail.numPages > 0) {
        numPagesRef.current = detail.numPages;
      }
      for (const item of detail.pageTexts) {
        if (Number.isInteger(item.page) && item.page >= 1 && item.text.trim()) {
          pageTextsMapRef.current.set(item.page, item.text.trim());
        }
      }
    };

    document.addEventListener('pdf-page-refs:update', handler);
    document.addEventListener('pdf-page-refs:content', contentHandler);
    return () => {
      document.removeEventListener('pdf-page-refs:update', handler);
      document.removeEventListener('pdf-page-refs:content', contentHandler);
    };
  }, []);

  // 清除所有页码引用
  const clearPageRefs = useCallback(() => {
    const current = pageRefsRef.current;
    pageTextsMapRef.current.clear();
    setPageRefs(null);
    // ★ 携带 sourceId，避免误清其他 PDF tab 的选择
    document.dispatchEvent(new CustomEvent('pdf-page-refs:clear', {
      detail: current ? { sourceId: current.sourceId } : undefined,
    }));
  }, []);

  // 移除单个页码
  const removePageRef = useCallback((page: number) => {
    const current = pageRefsRef.current;
    if (!current) return;

    pageTextsMapRef.current.delete(page);
    const newPages = current.pages.filter((p) => p !== page);
    if (newPages.length === 0) {
      clearPageRefs();
    } else {
      setPageRefs({ ...current, pages: newPages });
      // 通知 PDF Viewer 移除单页选择（★ 携带 sourceId 防跨 tab 误删）
      document.dispatchEvent(new CustomEvent('pdf-page-refs:remove', {
        detail: { page, sourceId: current.sourceId },
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

  // 构建所选页面的结构化正文快照（发送时自动注入 <selection> 上下文）
  const getSelectedPagesContext = useCallback((): SelectedPdfPagesContextSnapshot | null => {
    const current = pageRefsRef.current;
    if (!current || current.pages.length === 0) return null;
    const sorted = [...current.pages].sort((a, b) => a - b);
    const locator =
      sorted.length === 1 ? `page:${sorted[0]}` : `page:${sorted[0]}-${sorted[sorted.length - 1]}`;
    const blocks: string[] = [];
    for (const p of sorted) {
      const pageText = pageTextsMapRef.current.get(p);
      if (pageText) {
        const citeTag = current.sourceId ? `[PDF@${current.sourceId}:${p}] ` : '';
        blocks.push(`### ${citeTag}第 ${p} 页正文\n${pageText}`);
      }
    }
    if (blocks.length === 0 && !current.sourceId) return null;
    const header = [
      `文档：《${current.sourceName || 'PDF'}》`,
      numPagesRef.current > 0 ? `总页数：${numPagesRef.current} 页` : '',
      `用户指定精读页码：第 ${sorted.join(', ')} 页`,
      current.sourceId ? `resource_id：${current.sourceId}` : '',
    ]
      .filter(Boolean)
      .join(' ｜ ');
    const toolHint = current.sourceId
      ? `引用这些页面请使用 [PDF@${current.sourceId}:页码]。如需读取该 PDF 的其他页，请调用 builtin-resource_read(resource_id="${current.sourceId}", page_start=${sorted[0]}, page_end=${sorted[sorted.length - 1]})。`
      : '';
    return {
      sourceId: current.sourceId,
      sourceName: current.sourceName || 'PDF',
      locator,
      text: [header, ...blocks, toolHint].filter(Boolean).join('\n\n'),
    };
  }, []);

  return {
    pageRefs,
    clearPageRefs,
    removePageRef,
    buildRefTags,
    getSelectedPagesContext,
    hasPageRefs: pageRefs !== null && pageRefs.pages.length > 0,
  };
}
