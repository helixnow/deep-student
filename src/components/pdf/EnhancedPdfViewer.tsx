import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { Document, Page, Thumbnail, pdfjs } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePdfSettingsStore } from '../../stores/pdfSettingsStore';
import { dstu } from '@/dstu';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  CheckSquare,
  Square,
  ChevronDown,
  RotateCw,
  Maximize,
  Minimize,
  BookOpen,
  Book,
  List,
  Search,
  X,
  ChevronUp,
  LayoutGrid,
  Highlighter,
  Home,
  ChevronsLeft,
  ChevronsRight,
  Bookmark,
  BookmarkPlus,
  BookmarkCheck,
  Pencil,
  Trash2,
  MoreHorizontal
} from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './enhanced-pdf.css';
import { PDF_OPTIONS } from '../../utils/pdfConfig';
import { CustomScrollArea } from '../custom-scroll-area';

// 配置 PDF.js worker - 使用构建基路径，避免打包后绝对路径失效
pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

/** PDF 目录项 */
interface OutlineItem {
  title: string;
  dest: string | any[] | null;
  items?: OutlineItem[];
}

/** 搜索匹配结果 */
interface SearchMatch {
  pageIndex: number;
  matchIndex: number;
}

/** 视图模式 */
type ViewMode = 'single' | 'dual';

/** 侧边栏模式 */
type SidebarMode = 'none' | 'outline' | 'thumbnails';

/** 高亮批注 */
interface Highlight {
  id: string;
  pageIndex: number;
  text: string;
  color: string;
  rects: { x: number; y: number; width: number; height: number }[];
  createdAt: number;
}

/** PDF 书签 */
export interface Bookmark {
  id: string;
  page: number;
  title: string;
  createdAt: number;
}

export interface EnhancedPdfViewerProps {
  data?: Uint8Array;
  url?: string;
  fileName?: string;
  defaultScale?: 'PageFit' | 'PageWidth' | 'ActualSize' | number;
  initialPage?: number;
  style?: React.CSSProperties;
  className?: string;
  enableStudyControls?: boolean;
  selectedPages?: Set<number>;
  maxSelections?: number;
  onToggleSelectPage?: (pageNumber: number) => void;
  onPageChange?: (pageIndex: number) => void;
  onDocumentLoad?: (numPages: number) => void;
  onFileSelect?: () => void;
  onFileClear?: () => void;
  hasFile?: boolean;
  isDarkMode?: boolean;
  onRegisterCommands?: (commands: { jumpToPage: (pageIndex: number) => void }) => void;
  /** 是否启用文本选择（默认 true） */
  enableTextSelection?: boolean;
  /** 资源路径，用于持久化高亮批注（如 "/tb_xxx" 或 "/高考复习/tb_xxx"） */
  resourcePath?: string;
  /** 初始高亮数据（外部控制模式） */
  initialHighlights?: Highlight[];
  /** 高亮变化回调（外部控制模式） */
  onHighlightsChange?: (highlights: Highlight[]) => void;
  /** 书签列表（外部控制模式） */
  bookmarks?: Bookmark[];
  /** 书签变更回调 */
  onBookmarksChange?: (bookmarks: Bookmark[]) => void;
}

const ZOOM_LEVELS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];

/** Semantic highlight color constants for PDF annotations.
 *  These are intentional fixed colors for annotation UX, not theme-dependent. */
const HIGHLIGHT_COLORS = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  red: '#fecaca',
} as const;

const MemoPage = React.memo(Page);

const EnhancedPdfViewerImpl: React.FC<EnhancedPdfViewerProps> = ({
  data,
  url,
  defaultScale,
  initialPage = 0,
  style,
  className,
  enableStudyControls = false,
  selectedPages,
  maxSelections,
  onToggleSelectPage,
  onPageChange,
  onDocumentLoad,
  isDarkMode = false,
  onRegisterCommands,
  enableTextSelection,
  resourcePath,
  initialHighlights,
  onHighlightsChange,
  bookmarks: externalBookmarks,
  onBookmarksChange,
}) => {
  const { t } = useTranslation(['pdf', 'textbook']);

  // ========== PDF 设置集成 ==========
  const pdfSettings = usePdfSettingsStore((s) => s.settings);

  // 合并 props 与设置：props 优先（外部覆盖）
  const resolvedDefaultScale = defaultScale ?? pdfSettings.defaultScale;
  const resolvedEnableTextSelection = enableTextSelection ?? pdfSettings.enableTextLayerByDefault;
  const resolvedViewMode = pdfSettings.defaultViewMode;

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(initialPage + 1);
  const [scale, setScale] = useState<number>(
    typeof resolvedDefaultScale === 'number' ? resolvedDefaultScale : 1.0
  );
  const [showZoomMenu, setShowZoomMenu] = useState<boolean>(false);
  const [pageInputValue, setPageInputValue] = useState<string>('');
  const [containerWidth, setContainerWidth] = useState<number>(600);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // 新增功能状态
  const [rotation, setRotation] = useState<number>(0); // 0, 90, 180, 270
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>(resolvedViewMode);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('none');
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState<number>(0);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  
  const thumbnailsContainerRef = useRef<HTMLDivElement>(null);
  
  // 批注状态
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [showHighlightMenu, setShowHighlightMenu] = useState<boolean>(false);
  const [highlightMenuPos, setHighlightMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [pendingHighlight, setPendingHighlight] = useState<{ text: string; pageIndex: number; rects: { x: number; y: number; width: number; height: number }[] } | null>(null);
  const [showHighlightList, setShowHighlightList] = useState<boolean>(false);
  
  // 书签状态
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(externalBookmarks ?? []);
  const [showBookmarkList, setShowBookmarkList] = useState<boolean>(false);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingBookmarkTitle, setEditingBookmarkTitle] = useState<string>('');

  // 工具栏响应式：宽度不足时收折次要按钮到"更多"菜单
  const [isToolbarCompact, setIsToolbarCompact] = useState<boolean>(false);
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollToPageRef = useRef<(pageNum: number) => void>(() => {});
  const scrollIdleTimerRef = useRef<number | null>(null);
  const isScrollingRef = useRef(false);
  const searchTaskRef = useRef<{ id: number; cancelled: boolean } | null>(null);
  const searchIdleHandleRef = useRef<number | null>(null);
  const searchDebounceRef = useRef<number | null>(null);
  
  // 高亮持久化相关 refs
  const highlightsSaveTimerRef = useRef<number | null>(null);
  const highlightsLoadedRef = useRef<boolean>(false);
  const lastSavedHighlightsRef = useRef<string>('');
  const pendingSaveRef = useRef<(() => Promise<void>) | null>(null);

  // Cleanup PDFDocumentProxy on unmount to avoid memory leak
  useEffect(() => {
    return () => {
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
  }, []);

  // 工具栏响应式：ResizeObserver 检测宽度，窄时切换紧凑模式
  const TOOLBAR_COMPACT_THRESHOLD = 520;
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setIsToolbarCompact(w < TOOLBAR_COMPACT_THRESHOLD);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 点击外部关闭"更多"菜单
  useEffect(() => {
    if (!showMoreMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    setTimeout(() => document.addEventListener('click', handleClick), 10);
    return () => document.removeEventListener('click', handleClick);
  }, [showMoreMenu]);

  // 稳定的文件源 - 使用 useMemo 确保引用稳定
  const file = useMemo(() => {
    if (data && data.byteLength > 0) {
      return { data };
    }
    if (url) {
      return url;
    }
    return null;
  }, [data, url]);

  // Refs for callbacks
  const numPagesRef = useRef(numPages);
  const onPageChangeRef = useRef(onPageChange);
  const currentPageRef = useRef(currentPage);

  useEffect(() => {
    numPagesRef.current = numPages;
    onPageChangeRef.current = onPageChange;
    currentPageRef.current = currentPage;
  });

  // 注册命令
  useEffect(() => {
    if (onRegisterCommands) {
      onRegisterCommands({
        jumpToPage: (pageIndex: number) => {
          const targetPage = Math.max(1, Math.min(pageIndex + 1, numPagesRef.current));
          setCurrentPage(targetPage);
          onPageChangeRef.current?.(targetPage - 1);
          scrollToPageRef.current?.(targetPage);
        }
      });
    }
  }, [onRegisterCommands]);

  // 监听容器尺寸
  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    const updateWidth = () => {
      const width = container.clientWidth - 48;
      if (width > 0) {
        setContainerWidth(width);
      }
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 点击外部关闭缩放菜单
  useEffect(() => {
    if (!showZoomMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(e.target as Node)) {
        setShowZoomMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showZoomMenu]);

  // 文档加载成功
  const handleDocumentLoadSuccess = useCallback(({ numPages: pages }: { numPages: number }) => {
    setNumPages(pages);
    setIsLoading(false);
    setLoadError(null);
    onDocumentLoad?.(pages);
  }, [onDocumentLoad]);

  // 获取 PDF 文档对象用于目录和搜索
  const handleDocumentLoadSuccessWithDoc = useCallback((pdf: PDFDocumentProxy) => {
    pdfDocRef.current = pdf;
    // 加载目录
    pdf.getOutline().then((outlineItems) => {
      if (outlineItems && outlineItems.length > 0) {
        setOutline(outlineItems as OutlineItem[]);
      }
    }).catch(() => {
      // 忽略目录加载错误
    });
  }, []);

  // 旋转页面
  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360);
  }, []);

  // 全屏切换
  const handleToggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    
    if (!isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }, [isFullscreen]);

  // 监听全屏状态变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 视图模式切换
  const handleToggleViewMode = useCallback(() => {
    setViewMode(prev => prev === 'single' ? 'dual' : 'single');
  }, []);

  // 目录导航
  const handleOutlineClick = useCallback(async (item: OutlineItem) => {
    if (!pdfDocRef.current || !item.dest) return;
    
    try {
      let pageIndex: number;
      if (typeof item.dest === 'string') {
        const dest = await pdfDocRef.current.getDestination(item.dest);
        if (dest) {
          const ref = dest[0];
          pageIndex = await pdfDocRef.current.getPageIndex(ref);
        } else {
          return;
        }
      } else if (Array.isArray(item.dest)) {
        const ref = item.dest[0];
        pageIndex = await pdfDocRef.current.getPageIndex(ref);
      } else {
        return;
      }
      
      const targetPage = pageIndex + 1;
      setCurrentPage(targetPage);
      onPageChange?.(targetPage - 1);
      scrollToPageRef.current?.(targetPage);
    } catch (err) {
      console.error('Failed to navigate to outline item:', err);
    }
  }, [onPageChange]);

  const scheduleIdle = useCallback((cb: () => void) => {
    if (typeof (window as any).requestIdleCallback === 'function') {
      return (window as any).requestIdleCallback(cb, { timeout: 200 });
    }
    return window.setTimeout(cb, 16);
  }, []);

  const cancelIdle = useCallback((id: number) => {
    if (typeof (window as any).cancelIdleCallback === 'function') {
      (window as any).cancelIdleCallback(id);
    } else {
      window.clearTimeout(id);
    }
  }, []);

  const setScrollingState = useCallback((value: boolean) => {
    if (isScrollingRef.current === value) return;
    isScrollingRef.current = value;
    // 只在滚动结束时更新状态，避免滚动过程中频繁重渲染导致闪烁
    if (!value) {
      setIsScrolling(false);
    }
  }, []);

  const abortSearchTask = useCallback(() => {
    if (searchTaskRef.current) {
      searchTaskRef.current.cancelled = true;
    }
    if (searchIdleHandleRef.current !== null) {
      cancelIdle(searchIdleHandleRef.current);
      searchIdleHandleRef.current = null;
    }
  }, [cancelIdle]);

  // 搜索功能
  const handleSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    abortSearchTask();
    if (!pdfDocRef.current || !query) {
      setSearchResults([]);
      setCurrentSearchIndex(0);
      setIsSearching(false);
      return;
    }

    const task = { id: Date.now(), cancelled: false };
    searchTaskRef.current = task;
    setIsSearching(true);
    const results: SearchMatch[] = [];
    let pageIndex = 1;
    const chunkSize = 2;

    const runChunk = async () => {
      if (!pdfDocRef.current || task.cancelled) return;
      const end = Math.min(pageIndex + chunkSize - 1, numPages);

      try {
        for (; pageIndex <= end; pageIndex++) {
          if (task.cancelled || !pdfDocRef.current) return;
          const page = await pdfDocRef.current.getPage(pageIndex);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item: any) => item.str)
            .join(' ')
            .toLowerCase();

          let matchIndex = 0;
          let pos = pageText.indexOf(query);
          while (pos !== -1) {
            results.push({ pageIndex, matchIndex });
            matchIndex++;
            pos = pageText.indexOf(query, pos + 1);
          }
        }
      } catch (err) {
        if (!task.cancelled) {
          console.error('Search failed:', err);
          setIsSearching(false);
        }
        return;
      }

      if (task.cancelled) return;

      if (pageIndex <= numPages) {
        searchIdleHandleRef.current = scheduleIdle(() => {
          void runChunk();
        });
        return;
      }

      setSearchResults(results);
      setCurrentSearchIndex(0);
      setIsSearching(false);

      if (results.length > 0) {
        const firstResult = results[0];
        setCurrentPage(firstResult.pageIndex);
        onPageChange?.(firstResult.pageIndex - 1);
        scrollToPageRef.current?.(firstResult.pageIndex);
      }
    };

    void runChunk();
  }, [abortSearchTask, numPages, onPageChange, scheduleIdle, searchQuery]);

  useEffect(() => {
    if (!showSearch) return;
    if (searchDebounceRef.current) {
      window.clearTimeout(searchDebounceRef.current);
    }
    if (!searchQuery.trim()) {
      abortSearchTask();
      setSearchResults([]);
      setCurrentSearchIndex(0);
      setIsSearching(false);
      return;
    }
    searchDebounceRef.current = window.setTimeout(() => {
      handleSearch();
    }, 300);
    return () => {
      if (searchDebounceRef.current) {
        window.clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, [abortSearchTask, handleSearch, searchQuery, showSearch]);

  // 搜索导航
  const handlePrevSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const newIndex = currentSearchIndex > 0 ? currentSearchIndex - 1 : searchResults.length - 1;
    setCurrentSearchIndex(newIndex);
    const result = searchResults[newIndex];
    setCurrentPage(result.pageIndex);
    onPageChange?.(result.pageIndex - 1);
    scrollToPageRef.current?.(result.pageIndex);
  }, [searchResults, currentSearchIndex, onPageChange]);

  const handleNextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const newIndex = currentSearchIndex < searchResults.length - 1 ? currentSearchIndex + 1 : 0;
    setCurrentSearchIndex(newIndex);
    const result = searchResults[newIndex];
    setCurrentPage(result.pageIndex);
    onPageChange?.(result.pageIndex - 1);
    scrollToPageRef.current?.(result.pageIndex);
  }, [searchResults, currentSearchIndex, onPageChange]);

  // 关闭搜索
  const handleCloseSearch = useCallback(() => {
    abortSearchTask();
    setShowSearch(false);
    setSearchQuery('');
    setSearchResults([]);
    setCurrentSearchIndex(0);
    setIsSearching(false);
  }, [abortSearchTask]);

  // 文本选择处理（用于高亮批注）
  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      setShowHighlightMenu(false);
      return;
    }

    const containerEl = containerRef.current;
    const anchorNode = selection.anchorNode;
    if (!containerEl || !anchorNode || !containerEl.contains(anchorNode)) {
      setShowHighlightMenu(false);
      return;
    }
    
    const text = selection.toString().trim();
    if (!text) return;
    
    // 获取选区位置
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    // 找到所在页面
    let pageIndex = currentPage;
    const pageWrapper = range.startContainer.parentElement?.closest('[data-page-number]');
    if (pageWrapper) {
      pageIndex = parseInt(pageWrapper.getAttribute('data-page-number') || '1', 10);
    }
    
    // 获取所有选中文本的矩形位置（相对于页面，归一化到 scale=1）
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    const clientRects = range.getClientRects();
    if (pageWrapper) {
      const pageRect = pageWrapper.getBoundingClientRect();
      // 除以当前缩放比例，使坐标与 scale=1 对齐，渲染时再乘回
      const currentScale = scale;
      for (let i = 0; i < clientRects.length; i++) {
        const r = clientRects[i];
        rects.push({
          x: (r.left - pageRect.left) / currentScale,
          y: (r.top - pageRect.top) / currentScale,
          width: r.width / currentScale,
          height: r.height / currentScale,
        });
      }
    }
    
    setPendingHighlight({ text, pageIndex, rects });
    setHighlightMenuPos({ x: rect.left + rect.width / 2, y: rect.top - 10 });
    setShowHighlightMenu(true);
  }, [currentPage, scale]);

  // 添加高亮
  const addHighlight = useCallback((color: string) => {
    if (!pendingHighlight || pendingHighlight.rects.length === 0) return;
    
    const newHighlight: Highlight = {
      id: `hl-${crypto.randomUUID()}`,
      pageIndex: pendingHighlight.pageIndex,
      text: pendingHighlight.text,
      color,
      rects: pendingHighlight.rects,
      createdAt: Date.now(),
    };
    
    setHighlights(prev => [...prev, newHighlight]);
    setShowHighlightMenu(false);
    setPendingHighlight(null);
    window.getSelection()?.removeAllRanges();
  }, [pendingHighlight]);

  const highlightsByPage = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const hl of highlights) {
      const list = map.get(hl.pageIndex);
      if (list) {
        list.push(hl);
      } else {
        map.set(hl.pageIndex, [hl]);
      }
    }
    return map;
  }, [highlights]);

  // 获取某页的高亮
  const getPageHighlights = useCallback((pageNum: number) => {
    return highlightsByPage.get(pageNum) ?? [];
  }, [highlightsByPage]);

  // 删除高亮
  const removeHighlight = useCallback((id: string) => {
    setHighlights(prev => prev.filter(h => h.id !== id));
  }, []);

  // ========== 书签操作函数 ==========
  
  // 同步外部书签数据
  useEffect(() => {
    if (externalBookmarks !== undefined) {
      setBookmarks(externalBookmarks);
    }
  }, [externalBookmarks]);
  
  // 检查当前页是否有书签
  const currentPageBookmark = useMemo(() => {
    return bookmarks.find(b => b.page === currentPage);
  }, [bookmarks, currentPage]);
  
  // 按页码排序的书签列表
  const sortedBookmarks = useMemo(() => {
    return [...bookmarks].sort((a, b) => a.page - b.page);
  }, [bookmarks]);
  
  // 添加书签
  const addBookmark = useCallback(() => {
    // 检查当前页是否已有书签
    if (currentPageBookmark) {
      // 已有书签，跳转到编辑模式
      setEditingBookmarkId(currentPageBookmark.id);
      setEditingBookmarkTitle(currentPageBookmark.title);
      setShowBookmarkList(true);
      return;
    }
    
    const newBookmark: Bookmark = {
      id: `bm-${crypto.randomUUID()}`,
      page: currentPage,
      title: `${t('pdf:bookmark.defaultTitle', '书签')} - ${t('pdf:toolbar.page', '第 {{page}} 页', { page: currentPage })}`,
      createdAt: Date.now(),
    };
    
    const newBookmarks = [...bookmarks, newBookmark];
    setBookmarks(newBookmarks);
    onBookmarksChange?.(newBookmarks);
    
    // 自动进入编辑模式
    setEditingBookmarkId(newBookmark.id);
    setEditingBookmarkTitle(newBookmark.title);
    setShowBookmarkList(true);
  }, [currentPage, currentPageBookmark, bookmarks, onBookmarksChange, t]);
  
  // 删除书签
  const removeBookmark = useCallback((id: string) => {
    const newBookmarks = bookmarks.filter(b => b.id !== id);
    setBookmarks(newBookmarks);
    onBookmarksChange?.(newBookmarks);
    
    // 如果正在编辑这个书签，取消编辑状态
    if (editingBookmarkId === id) {
      setEditingBookmarkId(null);
      setEditingBookmarkTitle('');
    }
  }, [bookmarks, onBookmarksChange, editingBookmarkId]);
  
  // 更新书签标题
  const updateBookmarkTitle = useCallback((id: string, newTitle: string) => {
    const newBookmarks = bookmarks.map(b => 
      b.id === id ? { ...b, title: newTitle.trim() || b.title } : b
    );
    setBookmarks(newBookmarks);
    onBookmarksChange?.(newBookmarks);
    setEditingBookmarkId(null);
    setEditingBookmarkTitle('');
  }, [bookmarks, onBookmarksChange]);
  
  // 页面导航（提前定义，供 goToBookmark 使用）
  const goToPage = useCallback((page: number) => {
    const targetPage = Math.max(1, Math.min(page, numPages));
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage);
      onPageChange?.(targetPage - 1);
      scrollToPageRef.current?.(targetPage);
    }
  }, [numPages, currentPage, onPageChange]);
  
  // 跳转到书签页面
  const goToBookmark = useCallback((bookmark: Bookmark) => {
    goToPage(bookmark.page);
    setShowBookmarkList(false);
  }, [goToPage]);
  
  // 开始编辑书签
  const startEditBookmark = useCallback((bookmark: Bookmark) => {
    setEditingBookmarkId(bookmark.id);
    setEditingBookmarkTitle(bookmark.title);
  }, []);
  
  // 取消编辑书签
  const cancelEditBookmark = useCallback(() => {
    setEditingBookmarkId(null);
    setEditingBookmarkTitle('');
  }, []);

  // 监听文本选择
  useEffect(() => {
    if (!enableTextSelection) return;
    document.addEventListener('mouseup', handleTextSelection);
    return () => document.removeEventListener('mouseup', handleTextSelection);
  }, [enableTextSelection, handleTextSelection]);

  // ========== 高亮持久化逻辑 ==========
  
  // 从 DSTU 加载高亮数据（初始化时）
  useEffect(() => {
    // 如果提供了外部初始高亮数据，使用它
    if (initialHighlights !== undefined) {
      setHighlights(initialHighlights);
      highlightsLoadedRef.current = true;
      lastSavedHighlightsRef.current = JSON.stringify(initialHighlights);
      return;
    }
    
    // 如果没有 resourcePath，跳过加载
    if (!resourcePath) {
      highlightsLoadedRef.current = true;
      return;
    }
    
    // 重置加载状态
    highlightsLoadedRef.current = false;
    
    let isMounted = true;
    
    const loadHighlights = async () => {
      try {
        const result = await dstu.get(resourcePath);
        if (!isMounted) return;
        
        if (result.ok && result.value.metadata) {
          const savedHighlights = result.value.metadata.highlights as Highlight[] | undefined;
          if (savedHighlights && Array.isArray(savedHighlights)) {
            console.log('[EnhancedPdfViewer] 加载已保存的高亮批注:', savedHighlights.length, '条');
            setHighlights(savedHighlights);
            lastSavedHighlightsRef.current = JSON.stringify(savedHighlights);
          }
        }
        highlightsLoadedRef.current = true;
      } catch (err) {
        console.warn('[EnhancedPdfViewer] 加载高亮批注失败，降级为空列表:', err);
        highlightsLoadedRef.current = true;
      }
    };
    
    void loadHighlights();
    
    return () => {
      isMounted = false;
    };
  }, [resourcePath, initialHighlights]);
  
  // 防抖保存高亮数据到 DSTU
  useEffect(() => {
    // 如果使用外部控制模式，调用回调而不是直接保存
    if (onHighlightsChange) {
      onHighlightsChange(highlights);
      return;
    }
    
    // 如果没有 resourcePath 或尚未完成初始加载，跳过保存
    if (!resourcePath || !highlightsLoadedRef.current) {
      return;
    }
    
    // 检查是否有实际变化（避免初始加载时触发保存）
    const currentHighlightsJson = JSON.stringify(highlights);
    if (currentHighlightsJson === lastSavedHighlightsRef.current) {
      return;
    }
    
    // 清理之前的定时器
    if (highlightsSaveTimerRef.current) {
      window.clearTimeout(highlightsSaveTimerRef.current);
    }
    
    // 防抖保存（2秒延迟）
    const doSave = async () => {
      highlightsSaveTimerRef.current = null;
      pendingSaveRef.current = null;
      
      try {
        // 先获取当前元数据，保留其他字段
        const getResult = await dstu.get(resourcePath);
        if (!getResult.ok) {
          console.warn('[EnhancedPdfViewer] 获取资源元数据失败，跳过保存高亮:', getResult.error);
          return;
        }
        
        const existingMetadata = getResult.value.metadata || {};
        const newMetadata = {
          ...existingMetadata,
          highlights: highlights,
        };
        
        const result = await dstu.setMetadata(resourcePath, newMetadata);
        if (result.ok) {
          console.log('[EnhancedPdfViewer] 高亮批注已保存:', highlights.length, '条');
          lastSavedHighlightsRef.current = currentHighlightsJson;
        } else {
          console.warn('[EnhancedPdfViewer] 保存高亮批注失败:', result.error);
        }
      } catch (err) {
        console.error('[EnhancedPdfViewer] 保存高亮批注异常:', err);
      }
    };
    pendingSaveRef.current = doSave;
    highlightsSaveTimerRef.current = window.setTimeout(doSave, 2000); // 2秒防抖
    
    return () => {
      if (highlightsSaveTimerRef.current) {
        window.clearTimeout(highlightsSaveTimerRef.current);
        highlightsSaveTimerRef.current = null;
      }
    };
  }, [highlights, resourcePath, onHighlightsChange]);
  
  // 组件卸载时清理定时器并刷新待保存高亮
  useEffect(() => {
    return () => {
      if (highlightsSaveTimerRef.current) {
        window.clearTimeout(highlightsSaveTimerRef.current);
        highlightsSaveTimerRef.current = null;
      }
      // 刷新待保存的高亮，避免丢失
      pendingSaveRef.current?.();
      pendingSaveRef.current = null;
    };
  }, []);

  // 点击其他地方关闭高亮菜单
  useEffect(() => {
    if (!showHighlightMenu) return;
    const handleClick = (e: MouseEvent) => {
      const menu = document.querySelector('.ds-highlight-menu');
      if (menu && !menu.contains(e.target as Node)) {
        setShowHighlightMenu(false);
      }
    };
    setTimeout(() => document.addEventListener('click', handleClick), 100);
    return () => document.removeEventListener('click', handleClick);
  }, [showHighlightMenu]);

  // 文档加载失败
  const handleDocumentLoadError = useCallback((error: Error) => {
    console.error('PDF load error:', error);
    setIsLoading(false);
    setLoadError(error.message || 'PDF 加载失败');
  }, []);

  const handlePrevPage = useCallback(() => goToPage(currentPage - 1), [currentPage, goToPage]);
  const handleNextPage = useCallback(() => goToPage(currentPage + 1), [currentPage, goToPage]);

  const handlePageInputSubmit = useCallback(() => {
    const pageNum = parseInt(pageInputValue, 10);
    if (!isNaN(pageNum)) {
      goToPage(pageNum);
    }
    setPageInputValue('');
  }, [pageInputValue, goToPage]);

  // 缩放
  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3.0));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5));
  }, []);

  const handleZoomSelect = useCallback((newScale: number) => {
    setScale(newScale);
    setShowZoomMenu(false);
  }, []);

  // 键盘快捷键（必须在 goToPage 定义之后）
  // 作用域限定在组件容器内，避免与其他组件快捷键冲突
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果焦点在输入框中，忽略大部分快捷键
      const isInputFocused = document.activeElement?.tagName === 'INPUT' || 
                              document.activeElement?.tagName === 'TEXTAREA';
      
      // Ctrl/Cmd + F: 搜索
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 100);
        return;
      }
      
      // Escape: 关闭搜索或高亮菜单
      if (e.key === 'Escape') {
        if (showSearch) {
          // P2 fix: 确保取消搜索任务并重置 isSearching 状态
          abortSearchTask();
          setShowSearch(false);
          setSearchQuery('');
          setSearchResults([]);
          setCurrentSearchIndex(0);
          setIsSearching(false);
        }
        if (showHighlightMenu) setShowHighlightMenu(false);
        return;
      }
      
      if (isInputFocused) return;
      
      // 翻页快捷键
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPage(currentPageRef.current - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        goToPage(currentPageRef.current + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        goToPage(numPagesRef.current);
      }
      
      // 缩放快捷键（stopPropagation 防止与 global.zoom-* 命令双重执行）
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        e.stopPropagation();
        setScale(prev => Math.min(prev + 0.25, 3.0));
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        e.stopPropagation();
        setScale(prev => Math.max(prev - 0.25, 0.5));
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        setScale(1.0);
      }
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [showSearch, showHighlightMenu, goToPage]);

  // 页面选择
  const handleTogglePageSelect = useCallback((pageNum: number) => {
    onToggleSelectPage?.(pageNum);
  }, [onToggleSelectPage]);

  // 双页模式下页面宽度
  const pageWidth = viewMode === 'dual' ? (containerWidth * scale) / 2 - 8 : containerWidth * scale;
  const pageHeight = pageWidth * 1.414;
  const themeClass = isDarkMode ? 'dark-mode' : '';

  // ========== 从设置读取渲染参数 ==========
  // 使用固定 DPR，避免滚动时 DPR 变化导致页面重渲染闪烁
  const renderDpr = useMemo(() => {
    const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(deviceDpr, pdfSettings.maxDevicePixelRatio);
  }, [pdfSettings.maxDevicePixelRatio]);
  // 文本层/批注层渲染范围
  const textLayerRange = pdfSettings.textLayerRange;
  const annotationLayerRange = pdfSettings.annotationLayerRange;
  
  // 阅读进度百分比
  const readingProgress = numPages > 0 ? Math.round((currentPage / numPages) * 100) : 0;

  const pageRowCount = useMemo(() => (
    viewMode === 'dual' ? Math.ceil(numPages / 2) : numPages
  ), [viewMode, numPages]);

  const estimatedRowHeight = useMemo(() => (
    pageHeight + (viewMode === 'dual' ? 24 : 32)
  ), [pageHeight, viewMode]);

  const pageVirtualizer = useVirtualizer({
    count: pageRowCount,
    getScrollElement: () => pageContainerRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: pdfSettings.virtualizerOverscan,
    measureElement: (element) => element?.getBoundingClientRect().height ?? estimatedRowHeight,
  });

  const pageVirtualItems = pageVirtualizer.getVirtualItems();

  const getRowPages = useCallback((rowIndex: number) => {
    if (viewMode === 'dual') {
      const first = rowIndex * 2 + 1;
      const second = first + 1;
      return [first, second].filter(pageNum => pageNum <= numPages);
    }
    return [rowIndex + 1];
  }, [viewMode, numPages]);

  useEffect(() => {
    if (pageRowCount === 0) return;
    const rafId = requestAnimationFrame(() => pageVirtualizer.measure());
    return () => cancelAnimationFrame(rafId);
  }, [pageRowCount, pageVirtualizer, pageWidth, viewMode]);

  useEffect(() => {
    scrollToPageRef.current = (pageNum: number) => {
      if (!pageContainerRef.current || pageRowCount === 0) return;
      const rowIndex = viewMode === 'dual'
        ? Math.floor((pageNum - 1) / 2)
        : pageNum - 1;
      pageVirtualizer.scrollToIndex(rowIndex, { align: 'start', behavior: 'smooth' });
    };
  }, [pageRowCount, pageVirtualizer, viewMode]);

  // 滚动监听：使用虚拟列表数据更新当前页码，避免频繁 DOM 查询
  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container || numPages === 0) return;

    let rafId: number;

    const handleScroll = () => {
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
      }
      setScrollingState(true);
      scrollIdleTimerRef.current = window.setTimeout(() => {
        setScrollingState(false);
      }, 120);

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const items = pageVirtualizer.getVirtualItems();
        if (items.length === 0) return;

        const targetOffset = container.scrollTop + container.clientHeight / 2;
        let activeRow = items[0];
        for (const item of items) {
          const itemMid = item.start + item.size / 2;
          if (itemMid <= targetOffset) {
            activeRow = item;
          } else {
            break;
          }
        }

        const rowPages = getRowPages(activeRow.index);
        const visiblePage = rowPages[rowPages.length - 1];
        if (visiblePage && visiblePage !== currentPageRef.current) {
          setCurrentPage(visiblePage);
          onPageChangeRef.current?.(visiblePage - 1);
        }
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafId);
      if (scrollIdleTimerRef.current !== null) {
        window.clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
      setScrollingState(false);
    };
  }, [getRowPages, numPages, pageVirtualizer, setScrollingState]);

  // 缩略图宽度与 DPR 从设置读取
  const thumbnailWidth = pdfSettings.thumbnailWidth;
  const thumbnailDpr = pdfSettings.thumbnailDpr;
  const thumbnailHeight = Math.ceil(thumbnailWidth * 1.414) + 40; // 加上页码高度

  const thumbnailVirtualizer = useVirtualizer({
    count: sidebarMode === 'thumbnails' ? numPages : 0,
    getScrollElement: () => thumbnailsContainerRef.current,
    estimateSize: () => thumbnailHeight,
    overscan: pdfSettings.thumbnailOverscan,
    measureElement: (element) => element?.getBoundingClientRect().height ?? thumbnailHeight,
  });

  const thumbnailItems = thumbnailVirtualizer.getVirtualItems();

  useEffect(() => {
    if (sidebarMode !== 'thumbnails' || numPages === 0) return;
    const rafId = requestAnimationFrame(() => thumbnailVirtualizer.measure());
    return () => cancelAnimationFrame(rafId);
  }, [sidebarMode, numPages, thumbnailVirtualizer, thumbnailWidth]);

  // 切换侧边栏模式
  const toggleSidebar = useCallback((mode: SidebarMode) => {
    setSidebarMode(prev => prev === mode ? 'none' : mode);
  }, []);

  // 渲染目录项（递归）
  const renderOutlineItem = (item: OutlineItem, depth: number = 0): React.ReactNode => (
    <div key={`${item.title}-${depth}`}>
      <NotionButton variant="ghost" size="sm" className="ds-outline-item" style={{ paddingLeft: `${12 + depth * 16}px` }} onClick={() => handleOutlineClick(item)}>
        {item.title}
      </NotionButton>
      {item.items && item.items.map((child, idx) => renderOutlineItem(child, depth + 1))}
    </div>
  );

  const renderPage = useCallback((pageNum: number) => {
    const isSelected = selectedPages?.has(pageNum);
    const enableTextLayer =
      resolvedEnableTextSelection &&
      Math.abs(pageNum - currentPage) <= textLayerRange;
    const enableAnnotationLayer =
      pdfSettings.enableAnnotationLayerByDefault &&
      Math.abs(pageNum - currentPage) <= annotationLayerRange;
    return (
      <div
        key={pageNum}
        id={`pdf-page-${pageNum}`}
        className="ds-pdf__page-wrapper"
        data-page-number={pageNum}
        style={{ transform: rotation !== 0 ? `rotate(${rotation}deg)` : undefined }}
      >
        <MemoPage
          pageNumber={pageNum}
          width={pageWidth}
          renderTextLayer={enableTextLayer}
          renderAnnotationLayer={enableAnnotationLayer}
          rotate={rotation}
          devicePixelRatio={renderDpr}
        />

        {/* 高亮覆盖层 — 坐标已归一化到 scale=1，渲染时乘以当前 scale */}
        {getPageHighlights(pageNum).map(hl => (
          <div key={hl.id} className="ds-pdf__highlight-layer">
            {hl.rects.map((rect, idx) => (
              <div
                key={idx}
                className="ds-pdf__highlight-rect"
                style={{
                  left: rect.x * scale,
                  top: rect.y * scale,
                  width: rect.width * scale,
                  height: rect.height * scale,
                  backgroundColor: hl.color,
                }}
                title={hl.text}
              />
            ))}
          </div>
        ))}

        {enableStudyControls && (
          <div className="ds-pdf__page-overlay">
            <NotionButton variant="ghost" size="icon" iconOnly className={`ds-pdf__select-btn ${isSelected ? 'selected' : ''}`} onClick={() => handleTogglePageSelect(pageNum)}>
              {isSelected ? <CheckSquare size={16} /> : <Square size={16} />}
              {typeof maxSelections === 'number' && selectedPages && (
                <span className="ds-pdf__select-btn-text">
                  {selectedPages.size}/{maxSelections}
                </span>
              )}
            </NotionButton>
          </div>
        )}

        <div className="ds-pdf__page-number">{pageNum}</div>
      </div>
    );
  }, [
    annotationLayerRange,
    currentPage,
    enableStudyControls,
    resolvedEnableTextSelection,
    pdfSettings.enableAnnotationLayerByDefault,
    getPageHighlights,
    handleTogglePageSelect,
    maxSelections,
    pageWidth,
    renderDpr,
    rotation,
    selectedPages,
    t,
    textLayerRange,
  ]);

  // 渲染缩略图（复用已加载的 PDF 文档）
  const renderThumbnail = useCallback((pageNum: number) => {
    const placeholderHeight = Math.ceil(thumbnailWidth * 1.414);
    return (
      <div
        className={`ds-thumbnail-item ${currentPage === pageNum ? 'active' : ''}`}
        onClick={() => goToPage(pageNum)}
        style={{ minHeight: placeholderHeight + 30 }}
      >
        {pdfDocRef.current ? (
          <Thumbnail
            pageNumber={pageNum}
            width={thumbnailWidth}
            pdf={pdfDocRef.current}
            devicePixelRatio={thumbnailDpr}
          />
        ) : (
          <div
            className="ds-thumbnail-placeholder"
            style={{ width: thumbnailWidth, height: placeholderHeight }}
          >
            <span>{pageNum}</span>
          </div>
        )}
        <span className="ds-thumbnail-number">{pageNum}</span>
      </div>
    );
  }, [currentPage, goToPage, thumbnailWidth, thumbnailDpr]);

  if (!file) {
    return (
      <div className={`ds-pdf-viewer ${themeClass} ${className || ''}`} style={style}>
        <div className="ds-pdf__loading">
          <p>{t('pdf:empty.title', '未选择文件')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ds-pdf-viewer ${themeClass} ${className || ''} ${isFullscreen ? 'fullscreen' : ''} outline-none`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}
      ref={containerRef}
      tabIndex={0}
    >
      {/* 搜索栏 */}
      {showSearch && (
        <div className="ds-pdf__search-bar">
          <Search size={16} className="ds-search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            className="ds-search-input"
            placeholder={t('pdf:toolbar.search_placeholder', '输入搜索内容...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          {searchResults.length > 0 && (
            <span className="ds-search-info">
              {t('pdf:toolbar.result_count', '{{current}} / {{total}}', {
                current: currentSearchIndex + 1,
                total: searchResults.length
              })}
            </span>
          )}
          {searchQuery && searchResults.length === 0 && !isSearching && (
            <span className="ds-search-info ds-search-no-results">
              {t('pdf:toolbar.no_results', '未找到匹配')}
            </span>
          )}
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handlePrevSearchResult} disabled={searchResults.length === 0} title={t('pdf:toolbar.prev_match', '上一个')} aria-label="prev match">
            <ChevronUp size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleNextSearchResult} disabled={searchResults.length === 0} title={t('pdf:toolbar.next_match', '下一个')} aria-label="next match">
            <ChevronDown size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleCloseSearch} title={t('pdf:toolbar.close_search', '关闭搜索')} aria-label="close search">
            <X size={16} />
          </NotionButton>
        </div>
      )}

      {/* 高亮菜单 */}
      {showHighlightMenu && (
        <div
          className="ds-highlight-menu"
          style={{
            position: 'fixed',
            left: highlightMenuPos.x,
            top: highlightMenuPos.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.yellow }} onClick={() => addHighlight(HIGHLIGHT_COLORS.yellow)} title={t('pdf:toolbar.highlight_yellow', '黄色')} aria-label="yellow" />
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.green }} onClick={() => addHighlight(HIGHLIGHT_COLORS.green)} title={t('pdf:toolbar.highlight_green', '绿色')} aria-label="green" />
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.blue }} onClick={() => addHighlight(HIGHLIGHT_COLORS.blue)} title={t('pdf:toolbar.highlight_blue', '蓝色')} aria-label="blue" />
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.red }} onClick={() => addHighlight(HIGHLIGHT_COLORS.red)} title={t('pdf:toolbar.highlight_red', '红色')} aria-label="red" />
        </div>
      )}

      {/* 主体区域（侧边栏 + 内容） */}
      <div className="ds-pdf__main">
        {/* 侧边栏 */}
        {sidebarMode !== 'none' && (
          <div className="ds-pdf__sidebar">
            {/* 目录 */}
            {sidebarMode === 'outline' && outline && (
              <div className="ds-pdf__outline">
                <div className="ds-outline-header">
                  <span>{t('pdf:toolbar.outline', '目录')}</span>
                  <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setSidebarMode('none')} aria-label="close">
                    <X size={14} />
                  </NotionButton>
                </div>
                <CustomScrollArea className="ds-outline-content" viewportClassName="ds-outline-content-viewport">
                  {outline.map((item, idx) => renderOutlineItem(item, 0))}
                </CustomScrollArea>
              </div>
            )}
            
            {/* 缩略图 */}
            {sidebarMode === 'thumbnails' && (
              <div className="ds-pdf__thumbnails-panel">
                <div className="ds-outline-header">
                  <span>{t('pdf:toolbar.thumbnails', '缩略图')}</span>
                  <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setSidebarMode('none')} aria-label="close">
                    <X size={14} />
                  </NotionButton>
                </div>
                <CustomScrollArea className="ds-thumbnails-content" viewportRef={thumbnailsContainerRef} viewportClassName="ds-thumbnails-content-viewport">
                  <div
                    className="ds-thumbnails-virtualizer"
                    style={{
                      height: `${thumbnailVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {thumbnailItems.map((virtualItem) => {
                      const pageNum = virtualItem.index + 1;
                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          ref={thumbnailVirtualizer.measureElement}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualItem.start}px)`,
                          }}
                        >
                          {renderThumbnail(pageNum)}
                        </div>
                      );
                    })}
                  </div>
                </CustomScrollArea>
              </div>
            )}
          </div>
        )}

        {/* 页面容器 */}
        <CustomScrollArea
          className={`ds-pdf__content ${viewMode === 'dual' ? 'dual-page' : ''}`}
          viewportClassName="ds-pdf__content-viewport"
          viewportRef={pageContainerRef}
          orientation="both"
        >
          {loadError ? (
            <div className="ds-pdf__error">
              <p>{t('pdf:errors.load_failed', 'PDF 加载失败，请重试')}</p>
              <p style={{ fontSize: '12px', opacity: 0.7 }}>{loadError}</p>
            </div>
          ) : (
            <Document
              file={file}
              options={PDF_OPTIONS}
              onLoadSuccess={(doc) => {
                handleDocumentLoadSuccess(doc);
                handleDocumentLoadSuccessWithDoc(doc as unknown as PDFDocumentProxy);
              }}
              onLoadError={handleDocumentLoadError}
              loading={
                <div className="ds-pdf__loading">
                  <div className="ds-pdf__loading-spinner" />
                  <p>{t('pdf:loading', '加载中...')}</p>
                </div>
              }
            >
              {numPages > 0 && (
                <div className={`ds-pdf__pages-container ${viewMode === 'dual' ? 'dual' : 'single'}`}>
                  <div
                    className="ds-pdf__pages-virtualizer"
                    style={{
                      height: `${pageVirtualizer.getTotalSize()}px`,
                      width: '100%',
                      position: 'relative',
                    }}
                  >
                    {pageVirtualItems.map((virtualRow) => {
                      const rowPages = getRowPages(virtualRow.index);
                      return (
                        <div
                          key={virtualRow.key}
                          data-index={virtualRow.index}
                          ref={pageVirtualizer.measureElement}
                          className={`ds-pdf__page-row ${viewMode === 'dual' ? 'dual' : 'single'}`}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {rowPages.map((pageNum) => renderPage(pageNum))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </Document>
          )}
        </CustomScrollArea>
      </div>

      {/* 底部工具栏 - 始终单行 */}
      <div className="ds-pdf__toolbar ds-pdf__toolbar--bottom" ref={toolbarRef}>
        {/* 非紧凑模式：左侧侧边栏控制 */}
        {!isToolbarCompact && (
          <div className="ds-pdf__toolbar-left">
            {outline && outline.length > 0 && (
              <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${sidebarMode === 'outline' ? 'active' : ''}`} onClick={() => toggleSidebar('outline')} title={t('pdf:toolbar.outline', '目录')} aria-label="outline">
                <List size={16} />
              </NotionButton>
            )}
            
            <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${sidebarMode === 'thumbnails' ? 'active' : ''}`} onClick={() => toggleSidebar('thumbnails')} title={t('pdf:toolbar.thumbnails', '缩略图')} aria-label="thumbnails">
              <LayoutGrid size={16} />
            </NotionButton>
            
            <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 100); }} title={t('pdf:toolbar.search', '搜索')} aria-label="search">
              <Search size={16} />
            </NotionButton>
            
            <div className="ds-toolbar-divider" />
            
            <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${currentPageBookmark ? 'active' : ''}`} onClick={addBookmark} title={currentPageBookmark ? t('pdf:bookmark.editBookmark', '编辑书签') : t('pdf:bookmark.addBookmark', '添加书签')} aria-label="bookmark">
              {currentPageBookmark ? <BookmarkCheck size={16} /> : <BookmarkPlus size={16} />}
            </NotionButton>
            
            {bookmarks.length > 0 && (
              <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showBookmarkList ? 'active' : ''}`} onClick={() => setShowBookmarkList(!showBookmarkList)} title={t('pdf:bookmark.showBookmarks', '查看书签')} aria-label="bookmarks">
                <Bookmark size={16} />
                <span className="ds-bookmark-count">{bookmarks.length}</span>
              </NotionButton>
            )}
          </div>
        )}

        {/* 核心控制：缩放 + 页面导航（始终显示） */}
        <div className="ds-pdf__toolbar-center">
          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleZoomOut} title={t('pdf:toolbar.zoom_out', '缩小')} aria-label="zoom out">
            <ZoomOut size={16} />
          </NotionButton>

          <div className="ds-zoom-menu" ref={zoomMenuRef}>
            <NotionButton variant="ghost" size="sm" className="ds-btn" onClick={() => setShowZoomMenu(!showZoomMenu)}>
              <span className="ds-zoom-readout">{Math.round(scale * 100)}%</span>
              <ChevronDown size={12} />
            </NotionButton>
            {showZoomMenu && (
              <div className="ds-zoom-dropdown ds-zoom-dropdown--up">
                {ZOOM_LEVELS.map(z => (
                  <NotionButton key={z} variant="ghost" size="sm" className={`ds-zoom-option ${scale === z ? 'active' : ''}`} onClick={() => handleZoomSelect(z)}>
                    {Math.round(z * 100)}%
                  </NotionButton>
                ))}
              </div>
            )}
          </div>

          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleZoomIn} title={t('pdf:toolbar.zoom_in', '放大')} aria-label="zoom in">
            <ZoomIn size={16} />
          </NotionButton>

          <div className="ds-toolbar-divider" />

          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handlePrevPage} disabled={currentPage <= 1} aria-label="prev page">
            <ChevronLeft size={16} />
          </NotionButton>

          <div className="ds-page-input">
            <input
              type="text"
              className="ds-input"
              value={pageInputValue || currentPage}
              onChange={(e) => setPageInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePageInputSubmit()}
              onBlur={handlePageInputSubmit}
              onFocus={() => setPageInputValue(String(currentPage))}
            />
            <span className="ds-page-total">/ {numPages || 0}</span>
          </div>

          <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleNextPage} disabled={currentPage >= numPages} aria-label="next page">
            <ChevronRight size={16} />
          </NotionButton>
        </div>

        {/* 非紧凑模式：右侧视图控制 */}
        {!isToolbarCompact && (
          <div className="ds-pdf__toolbar-right">
            <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleRotate} title={t('pdf:toolbar.rotate_cw', '顺时针旋转 90°')} aria-label="rotate">
              <RotateCw size={16} />
            </NotionButton>

            <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${viewMode === 'dual' ? 'active' : ''}`} onClick={handleToggleViewMode} title={viewMode === 'single' ? t('pdf:toolbar.dual_page', '双页视图') : t('pdf:toolbar.single_page', '单页视图')} aria-label="view mode">
              {viewMode === 'single' ? <Book size={16} /> : <BookOpen size={16} />}
            </NotionButton>

            <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleToggleFullscreen} title={isFullscreen ? t('pdf:toolbar.exit_fullscreen', '退出全屏') : t('pdf:toolbar.fullscreen', '全屏')} aria-label="fullscreen">
              {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
            </NotionButton>
          </div>
        )}

        {/* 紧凑模式：更多菜单 */}
        {isToolbarCompact && (
          <div className="ds-pdf__toolbar-more" ref={moreMenuRef}>
            <NotionButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showMoreMenu ? 'active' : ''}`} onClick={() => setShowMoreMenu(!showMoreMenu)} title={t('pdf:toolbar.more', '更多')} aria-label="more">
              <MoreHorizontal size={16} />
            </NotionButton>
            {showMoreMenu && (
              <div className="ds-more-dropdown ds-more-dropdown--up">
                {outline && outline.length > 0 && (
                  <NotionButton variant="ghost" size="sm" className={`ds-more-item ${sidebarMode === 'outline' ? 'active' : ''}`} onClick={() => { toggleSidebar('outline'); setShowMoreMenu(false); }}>
                    <List size={14} />
                    <span>{t('pdf:toolbar.outline', '目录')}</span>
                  </NotionButton>
                )}
                <NotionButton variant="ghost" size="sm" className={`ds-more-item ${sidebarMode === 'thumbnails' ? 'active' : ''}`} onClick={() => { toggleSidebar('thumbnails'); setShowMoreMenu(false); }}>
                  <LayoutGrid size={14} />
                  <span>{t('pdf:toolbar.thumbnails', '缩略图')}</span>
                </NotionButton>
                <NotionButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { setShowSearch(true); setShowMoreMenu(false); setTimeout(() => searchInputRef.current?.focus(), 100); }}>
                  <Search size={14} />
                  <span>{t('pdf:toolbar.search', '搜索')}</span>
                </NotionButton>

                <div className="ds-more-divider" />

                <NotionButton variant="ghost" size="sm" className={`ds-more-item ${currentPageBookmark ? 'active' : ''}`} onClick={() => { addBookmark(); setShowMoreMenu(false); }}>
                  {currentPageBookmark ? <BookmarkCheck size={14} /> : <BookmarkPlus size={14} />}
                  <span>{currentPageBookmark
                    ? t('pdf:bookmark.editBookmark', '编辑书签')
                    : t('pdf:bookmark.addBookmark', '添加书签')}</span>
                </NotionButton>
                {bookmarks.length > 0 && (
                  <NotionButton variant="ghost" size="sm" className={`ds-more-item ${showBookmarkList ? 'active' : ''}`} onClick={() => { setShowBookmarkList(!showBookmarkList); setShowMoreMenu(false); }}>
                    <Bookmark size={14} />
                    <span>{t('pdf:bookmark.showBookmarks', '查看书签')} ({bookmarks.length})</span>
                  </NotionButton>
                )}

                <div className="ds-more-divider" />

                <NotionButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { handleRotate(); setShowMoreMenu(false); }}>
                  <RotateCw size={14} />
                  <span>{t('pdf:toolbar.rotate_cw', '顺时针旋转 90°')}</span>
                </NotionButton>
                <NotionButton variant="ghost" size="sm" className={`ds-more-item ${viewMode === 'dual' ? 'active' : ''}`} onClick={() => { handleToggleViewMode(); setShowMoreMenu(false); }}>
                  {viewMode === 'single' ? <Book size={14} /> : <BookOpen size={14} />}
                  <span>{viewMode === 'single' ? t('pdf:toolbar.dual_page', '双页视图') : t('pdf:toolbar.single_page', '单页视图')}</span>
                </NotionButton>
                <NotionButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { handleToggleFullscreen(); setShowMoreMenu(false); }}>
                  {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                  <span>{isFullscreen ? t('pdf:toolbar.exit_fullscreen', '退出全屏') : t('pdf:toolbar.fullscreen', '全屏')}</span>
                </NotionButton>
              </div>
            )}
          </div>
        )}
      </div>


      {/* 阅读进度条 */}
      {numPages > 0 && (
        <div className="ds-pdf__progress-bar">
          <div
            className="ds-pdf__progress-fill"
            style={{ width: `${readingProgress}%` }}
          />
          <span className="ds-pdf__progress-text">{readingProgress}%</span>
        </div>
      )}

      {/* 批注指示器和列表 */}
      {highlights.length > 0 && (
        <>
          <NotionButton variant="ghost" size="sm" className="ds-pdf__highlights-indicator" onClick={() => setShowHighlightList(!showHighlightList)} title={t('pdf:toolbar.show_highlights', '查看批注')}>
            <Highlighter size={14} />
            <span>{highlights.length}</span>
          </NotionButton>

          {/* 批注列表面板 */}
          {showHighlightList && (
            <div className="ds-pdf__highlights-panel">
              <div className="ds-outline-header">
                <span>{t('pdf:toolbar.highlights', '批注列表')}</span>
                <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setShowHighlightList(false)} aria-label="close">
                  <X size={14} />
                </NotionButton>
              </div>
              <div className="ds-highlights-list">
                {highlights.map(hl => (
                  <div
                    key={hl.id}
                    className="ds-highlight-item"
                    onClick={() => {
                      goToPage(hl.pageIndex);
                      setShowHighlightList(false);
                    }}
                  >
                    <div
                      className="ds-highlight-color"
                      style={{ backgroundColor: hl.color }}
                    />
                    <div className="ds-highlight-content">
                      <div className="ds-highlight-text">{hl.text}</div>
                      <div className="ds-highlight-meta">
                        {t('pdf:toolbar.page', '第 {{page}} 页', { page: hl.pageIndex })}
                      </div>
                    </div>
                    <NotionButton variant="ghost" size="icon" iconOnly className="ds-highlight-delete" onClick={(e) => { e.stopPropagation(); removeHighlight(hl.id); }} title={t('pdf:toolbar.delete_highlight', '删除批注')} aria-label="delete">
                      <X size={12} />
                    </NotionButton>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* 书签列表面板 */}
      {showBookmarkList && (
        <div className="ds-pdf__bookmarks-panel">
          <div className="ds-outline-header">
            <span>{t('pdf:bookmark.bookmarkList', '书签列表')}</span>
            <NotionButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setShowBookmarkList(false)} aria-label="close">
              <X size={14} />
            </NotionButton>
          </div>
          <div className="ds-bookmarks-list">
            {sortedBookmarks.length === 0 ? (
              <div className="ds-bookmarks-empty">
                <Bookmark size={24} className="ds-bookmarks-empty-icon" />
                <p>{t('pdf:bookmark.noBookmarks', '暂无书签')}</p>
                <p className="ds-bookmarks-empty-hint">{t('pdf:bookmark.addHint', '点击工具栏的书签按钮添加')}</p>
              </div>
            ) : (
              sortedBookmarks.map(bm => (
                <div
                  key={bm.id}
                  className={`ds-bookmark-item ${bm.page === currentPage ? 'current' : ''} ${editingBookmarkId === bm.id ? 'editing' : ''}`}
                  onClick={() => editingBookmarkId !== bm.id && goToBookmark(bm)}
                >
                  <div className="ds-bookmark-icon">
                    <Bookmark size={14} />
                  </div>
                  <div className="ds-bookmark-content">
                    {editingBookmarkId === bm.id ? (
                      <input
                        type="text"
                        className="ds-bookmark-title-input"
                        value={editingBookmarkTitle}
                        onChange={(e) => setEditingBookmarkTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            updateBookmarkTitle(bm.id, editingBookmarkTitle);
                          } else if (e.key === 'Escape') {
                            cancelEditBookmark();
                          }
                        }}
                        onBlur={() => updateBookmarkTitle(bm.id, editingBookmarkTitle)}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <>
                        <div className="ds-bookmark-title">{bm.title}</div>
                        <div className="ds-bookmark-meta">
                          {t('pdf:toolbar.page', '第 {{page}} 页', { page: bm.page })}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="ds-bookmark-actions">
                    {editingBookmarkId !== bm.id && (
                      <NotionButton variant="ghost" size="icon" iconOnly className="ds-bookmark-action-btn" onClick={(e) => { e.stopPropagation(); startEditBookmark(bm); }} title={t('pdf:bookmark.editTitle', '编辑标题')} aria-label="edit">
                        <Pencil size={12} />
                      </NotionButton>
                    )}
                    <NotionButton variant="ghost" size="icon" iconOnly className="ds-bookmark-action-btn ds-bookmark-delete-btn" onClick={(e) => { e.stopPropagation(); removeBookmark(bm.id); }} title={t('pdf:bookmark.deleteBookmark', '删除书签')} aria-label="delete">
                      <Trash2 size={12} />
                    </NotionButton>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const EnhancedPdfViewer = React.memo(EnhancedPdfViewerImpl);

// 导出 Highlight 类型供外部使用
export type { Highlight };

export default EnhancedPdfViewer;
