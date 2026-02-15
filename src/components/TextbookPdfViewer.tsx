import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import './TextbookPdfViewer.css';
import { EnhancedPdfViewer, type Bookmark } from './pdf/EnhancedPdfViewer';
import { usePdfRenderTracker } from '../utils/pdfDebug';
import useTheme from '../hooks/useTheme';
import { getErrorMessage } from '../utils/errorUtils';
import { BookOpen } from 'lucide-react';
import { showGlobalNotification } from './UnifiedNotification';


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
  focusRequest?: { path?: string; name?: string; pageNumber: number; requestId: number } | null;
  onFocusHandled?: (requestId: number) => void;
  readingProgress?: ReadingProgress;
  onProgressChange?: (progress: ReadingProgress) => void;
  resourcePath?: string;
  bookmarks?: Bookmark[];
  onBookmarksChange?: (bookmarks: Bookmark[]) => void;
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
}) => {
  const { t } = useTranslation(['pdf', 'common', 'textbook']);
  const { isDarkMode } = useTheme();
  
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerCommandsRef = useRef<{ jumpToPage: (pageIndex: number) => void } | null>(null);
  const pendingFocusRef = useRef<{ path?: string; name?: string; pageNumber: number; requestId: number } | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const lastSavedPageRef = useRef<number | null>(null);
  
  // 缓存 blob URL，避免每次渲染都重新创建
  const fileBlobUrlRef = useRef<string | null>(null);
  // 追踪当前 file 对象，用于检测变化
  const lastFileRef = useRef<File | null>(null);

  // ★ 生成 viewer URL（纯计算，无副作用）
  const viewerUrl = useMemo(() => {
    // 检测 file 是否真的变化了（对象引用不同）
    if (file !== lastFileRef.current) {
      // 释放旧的 Blob URL（只有当旧的 file 存在时才释放）
      if (lastFileRef.current && fileBlobUrlRef.current) {
        URL.revokeObjectURL(fileBlobUrlRef.current);
        fileBlobUrlRef.current = null;
      }
      lastFileRef.current = file;
    }
    
    if (file) {
      if (!fileBlobUrlRef.current) {
        fileBlobUrlRef.current = URL.createObjectURL(file);
      }
      return fileBlobUrlRef.current as string;
    }
    // 如果有 filePath，转换为 pdfstream:// 协议 URL
    if (filePath) {
      // 使用 Tauri 官方 API 构建跨平台协议 URL
      // Windows WebView2: http://pdfstream.localhost/<encoded_path>
      // macOS/Linux:      pdfstream://localhost/<encoded_path>
      return convertFileSrc(filePath, 'pdfstream');
    }
    return '';
  }, [file, filePath]);


  // 渲染追踪
  usePdfRenderTracker('TextbookPdfViewer', {
    hasFile: !!file,
    fileName,
    numPages,
    pageNumber,
    scale,
    isLoading,
    hasError: !!error,
    selectedPagesCount: selectedPages.size,
    maxSelections,
  });

  useEffect(() => {
    return () => {
      if (fileBlobUrlRef.current) {
        URL.revokeObjectURL(fileBlobUrlRef.current);
        fileBlobUrlRef.current = null;
      }
      // 清理进度保存定时器
      if (progressSaveTimerRef.current) {
        window.clearTimeout(progressSaveTimerRef.current);
        progressSaveTimerRef.current = null;
      }
    };
  }, []);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setIsLoading(false);
    setError(null);
  }, []);

  const clearPendingFocus = useCallback((requestId?: number) => {
    const current = pendingFocusRef.current;
    if (!current) return;
    if (typeof requestId === 'number' && current.requestId !== requestId) return;
    pendingFocusRef.current = null;
    try { onFocusHandled?.(current.requestId); } catch { /* 非关键：焦点回调通知失败不影响核心功能 */ }
  }, [onFocusHandled]);

  const onDocumentLoadError = useCallback((error: Error) => {
    console.error('PDF 加载失败:', getErrorMessage(error));
    setError(t('pdf:errors.load_failed'));
    setIsLoading(false);
    clearPendingFocus();
  }, [t, clearPendingFocus]);

  const changePage = useCallback((offset: number) => {
    setPageNumber((prevPageNumber) => {
      const newPage = prevPageNumber + offset;
      if (numPages && newPage >= 1 && newPage <= numPages) {
        return newPage;
      }
      return prevPageNumber;
    });
  }, [numPages]);

  const previousPage = useCallback(() => changePage(-1), [changePage]);
  const nextPage = useCallback(() => changePage(1), [changePage]);

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 3.0));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.5));
  }, []);

  const tryHandlePendingFocus = useCallback(() => {
    const request = pendingFocusRef.current;
    if (!request) return;
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


  // 清空选择
  const handleClearSelection = useCallback(() => {
    onPageSelectionChange(new Set());
  }, [onPageSelectionChange]);

  const isPageSelected = selectedPages.has(pageNumber);

  // 稳定传入 EnhancedPdfViewer 的回调，避免每次渲染创建新函数
  const handleViewerPageChange = useCallback((idx: number) => {
    const newPage = idx + 1;
    setPageNumber(newPage);
    
    // 防抖保存阅读进度
    if (onProgressChange && newPage !== lastSavedPageRef.current) {
      if (progressSaveTimerRef.current) {
        window.clearTimeout(progressSaveTimerRef.current);
      }
      progressSaveTimerRef.current = window.setTimeout(() => {
        progressSaveTimerRef.current = null;
        lastSavedPageRef.current = newPage;
        onProgressChange({
          page: newPage,
          lastReadAt: Date.now(),
        });
      }, 1000); // 1秒防抖
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
      {error && (
        <div className="textbook-error-message">
          <span>{error}</span>
        </div>
      )}

      {!file && !filePath && !error && (
        <div className="textbook-empty-state">
          <BookOpen size={48} className="textbook-empty-icon" />
          <p className="textbook-empty-title">{t('textbook:no_textbook_loaded')}</p>
          <p className="textbook-empty-hint">{t('textbook:select_textbook_hint')}</p>
          <NotionButton variant="primary" size="sm" className="textbook-library-btn" onClick={() => { try { window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'learning-hub' } })); } catch (err: unknown) { console.error('导航到教材库失败:', getErrorMessage(err)); } }}>
            <BookOpen size={18} />
            <span>{t('textbook:go_to_library')}</span>
          </NotionButton>
        </div>
      )}

      {(file || (filePath && filePath.trim())) && (
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
          />
        </div>
      )}
    </div>
  );
};

export default TextbookPdfViewer;
