import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import '../styles/textbook-pdf-viewer.css';
import { EnhancedPdfViewer, type Bookmark } from './EnhancedPdfViewer';
import type { PdfSelectionPayload } from '../pdfSelectionActions';
import { usePdfRenderTracker } from '@/utils/pdfDebug';
import useTheme from '@/hooks/useTheme';
import { getErrorMessage } from '@/utils/errorUtils';
import { BookOpen } from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';


/**
 * 阅读进度类型
 */
export interface ReadingProgress {
  /** 当前页码 (1-based) */
  page: number;
  /** 最后阅读时间 (Unix 毫秒) */
  lastReadAt?: number;
}

interface TextbookPdfViewerProps {
  file: File | null;
  filePath: string; // 教材的绝对路径
  fileName: string; // 教材文件名
  selectedPages: Set<number>; // 已选中的页码集合
  onPageSelectionChange: (pages: Set<number>) => void;
  /** @deprecated 导出功能已移除，保留接口兼容性 */
  onExportSelectedPages?: () => void;
  maxSelections?: number; // 最大选择页数限制
  focusRequest?: {
    path?: string;
    name?: string;
    pageNumber: number;
    requestId: number;
    /** ACR 4.0（A7）：派发方超时/卸载后为 true；stale 请求不得再兑现 */
    isStale?: () => boolean;
  } | null;
  onFocusHandled?: (requestId: number) => void;
  readingProgress?: ReadingProgress;
  onProgressChange?: (progress: ReadingProgress) => void;
  resourcePath?: string;
  bookmarks?: Bookmark[];
  onBookmarksChange?: (bookmarks: Bookmark[]) => void;
  /** 划词「引用到对话」（selectedText + 页码），透传给 EnhancedPdfViewer */
  onQuoteToChat?: (payload: PdfSelectionPayload) => void;
  /** @deprecated 自动导出已移除，此参数无效 */
  enableAutoPrepare?: boolean;
}

// 重新导出 Bookmark 类型供外部使用
export type { Bookmark };

export const TextbookPdfViewer: React.FC<TextbookPdfViewerProps> = ({
  file,
  filePath,
  fileName,
  selectedPages,
  onPageSelectionChange,
  maxSelections = 10,
  focusRequest,
  onFocusHandled,
  readingProgress,
  onProgressChange,
  resourcePath,
  bookmarks,
  onBookmarksChange,
  onQuoteToChat,
}) => {
  const { t } = useTranslation(['pdf', 'common', 'textbook']);
  const { isDarkMode } = useTheme();

  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);

  const viewerCommandsRef = useRef<{ jumpToPage: (pageIndex: number) => void } | null>(null);
  const pendingFocusRef = useRef<{
    path?: string;
    name?: string;
    pageNumber: number;
    requestId: number;
    isStale?: () => boolean;
  } | null>(null);
  const lastReportedPageRef = useRef<number | null>(null);

  // 同一组件实例可切换资源；页码去重基线不能跨文档沿用，否则新文档
  // 第一次跳到“恰好等于旧文档末页”的页码时会被误判为重复而不落进度。
  useEffect(() => {
    lastReportedPageRef.current = null;
  }, [resourcePath, filePath]);

  // ★ Blob URL 生命周期由 effect 管理（而非 useMemo 副作用）：
  // StrictMode / 并发渲染下 useMemo 可能重复执行或结果被丢弃，
  // 在其中 create/revoke 会误 revoke 仍在使用的 URL。
  // state 同时记录 URL 所属的 File：file prop 变化到新 URL 就绪之间有一次
  // 中间渲染，若只存 URL 会把上一个（已 revoke 的）blob URL 交给 viewer。
  const [fileBlob, setFileBlob] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) {
      setFileBlob(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileBlob({ file, url });
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // 生成 viewer URL（纯计算，无副作用）
  const viewerUrl = useMemo(() => {
    if (file) {
      // blob URL 尚未就绪（或还挂着旧 file 的 URL）时返回空串，渲染层会等待
      return fileBlob && fileBlob.file === file ? fileBlob.url : '';
    }
    // 如果有 filePath，转换为 pdfstream:// 协议 URL
    // Windows WebView2: http://pdfstream.localhost/<encoded_path>
    // macOS/Linux:      pdfstream://localhost/<encoded_path>
    if (filePath) {
      return convertFileSrc(filePath, 'pdfstream');
    }
    return '';
  }, [file, fileBlob, filePath]);


  // 渲染追踪
  usePdfRenderTracker('TextbookPdfViewer', {
    hasFile: !!file,
    fileName,
    numPages,
    pageNumber,
    selectedPagesCount: selectedPages.size,
    maxSelections,
  });

  const clearPendingFocus = useCallback((requestId?: number) => {
    const current = pendingFocusRef.current;
    if (!current) return;
    if (typeof requestId === 'number' && current.requestId !== requestId) return;
    pendingFocusRef.current = null;
    try { onFocusHandled?.(current.requestId); } catch { /* 非关键：焦点回调通知失败不影响核心功能 */ }
  }, [onFocusHandled]);

  // 注：文档加载失败的分类文案与重试 UI 由 EnhancedPdfViewer 内部
  // （classifyPdfLoadError + 内联错误面板）负责，本包装层不再重复维护错误态。

  const tryHandlePendingFocus = useCallback(() => {
    const request = pendingFocusRef.current;
    if (!request) return;
    // ACR 4.0（A7）：派发方已按超时/卸载回执失败的请求不得再兑现——
    // 「回执说失败就真的不会发生」，避免 LLM 重试导致双跳。
    // clearPendingFocus 内的 ack 此时已 settled，是无害 no-op（纯清理）。
    if (request.isStale?.()) {
      clearPendingFocus(request.requestId);
      return;
    }
    const matchesPath = request.path ? (request.path === resourcePath || request.path === filePath) : true;
    const matchesName = request.name ? request.name === fileName : true;
    if (!matchesPath && !matchesName) {
      return;
    }
    if (!viewerCommandsRef.current) {
      return;
    }
    if (!numPages || numPages <= 0) {
      return;
    }
    const targetPage = Math.min(Math.max(request.pageNumber, 1), numPages);
    try {
      viewerCommandsRef.current.jumpToPage(targetPage - 1);
      setPageNumber(targetPage);
      clearPendingFocus(request.requestId);
    } catch (err: unknown) {
      console.error('[TextbookPdfViewer] jumpToPage 失败:', err);
      clearPendingFocus(request.requestId);
    }
  }, [filePath, fileName, resourcePath, numPages, clearPendingFocus]);

  useEffect(() => {
    if (focusRequest) {
      pendingFocusRef.current = focusRequest;
      tryHandlePendingFocus();
    }
  }, [focusRequest, tryHandlePendingFocus]);

  useEffect(() => {
    tryHandlePendingFocus();
  }, [filePath, fileName, resourcePath, numPages, tryHandlePendingFocus]);

  // 切换页面勾选状态
  const togglePageSelection = useCallback((page: number) => {
    const newSelection = new Set(selectedPages);
    if (newSelection.has(page)) {
      newSelection.delete(page);
    } else {
      if (newSelection.size >= maxSelections) {
        // 超出最大选择数，提示用户
        showGlobalNotification(
          'warning',
          t('textbook:max_pages_reached', { max: maxSelections })
        );
        return;
      }
      newSelection.add(page);
    }
    onPageSelectionChange(newSelection);
  }, [selectedPages, onPageSelectionChange, maxSelections, t]);

  // ★ 阅读进度直通上报（同页去重）：
  // 防抖统一收敛到 previewPersistence（1s + dispose flush），
  // 避免 Viewer 层 + persistence 层双重防抖叠加导致最坏 3s 才落盘。
  const handleViewerPageChange = useCallback((idx: number) => {
    const newPage = idx + 1;
    setPageNumber(newPage);
    if (onProgressChange && newPage !== lastReportedPageRef.current) {
      lastReportedPageRef.current = newPage;
      onProgressChange({
        page: newPage,
        lastReadAt: Date.now(),
      });
    }
  }, [onProgressChange]);

  const handleViewerDocumentLoad = useCallback((pages: number) => {
    setNumPages(pages);
    setTimeout(() => {
      tryHandlePendingFocus();
    }, 0);
  }, [tryHandlePendingFocus]);

  const handleRegisterViewerCommands = useCallback((commands: { jumpToPage: (pageIndex: number) => void }) => {
    viewerCommandsRef.current = commands;
    tryHandlePendingFocus();
  }, [tryHandlePendingFocus]);

  return (
    <div className="textbook-pdf-viewer">
      {!file && !filePath && (
        <div className="textbook-empty-state ui-rise-in">
          <BookOpen size={48} className="textbook-empty-icon" />
          <p className="textbook-empty-title">{t('textbook:no_textbook_loaded')}</p>
          <p className="textbook-empty-hint">{t('textbook:select_textbook_hint')}</p>
          <DsButton variant="primary" size="sm" className="textbook-library-btn [@media(pointer:coarse)]:!min-h-11" onClick={() => { try { window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'learning-hub' } })); } catch (err: unknown) { console.error('导航到教材库失败:', getErrorMessage(err)); } }}>
            <BookOpen size={18} />
            <span>{t('textbook:go_to_library')}</span>
          </DsButton>
        </div>
      )}

      {viewerUrl && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <EnhancedPdfViewer
            url={viewerUrl}
            fileName={fileName}
            enableStudyControls
            selectedPages={selectedPages}
            maxSelections={maxSelections}
            onToggleSelectPage={togglePageSelection}
            onPageChange={handleViewerPageChange}
            onDocumentLoad={handleViewerDocumentLoad}
            isDarkMode={isDarkMode}
            onRegisterCommands={handleRegisterViewerCommands}
            initialPage={readingProgress?.page ? readingProgress.page - 1 : 0}
            resourcePath={resourcePath}
            bookmarks={bookmarks}
            onBookmarksChange={onBookmarksChange}
            onQuoteToChat={onQuoteToChat}
          />

        </div>
      )}
    </div>
  );
};

export default TextbookPdfViewer;
