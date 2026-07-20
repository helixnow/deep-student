import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Document, Page, Thumbnail, pdfjs, PasswordResponses } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePdfSettingsStore, type PdfFitMode } from '../stores/pdfSettingsStore';
import { dstu } from '@/dstu';
import {
  CaretLeft,
  CaretRight,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  CaretDown,
  ArrowClockwise,
  ArrowsOut,
  ArrowsIn,
  BookOpen,
  Book,
  List,
  MagnifyingGlass,
  X,
  CaretUp,
  GridFour,
  Highlighter,
  House,
  CaretDoubleLeft,
  CaretDoubleRight,
  Bookmark,
  BookmarkSimple,
  BookmarkSimple as BookmarkCheck,
  Pencil,
  Trash,
  DotsThree,
  Moon,
  Sun,
  ArrowCounterClockwise,
  LockSimple
} from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import '../styles/enhanced-pdf.css';
import { PDF_OPTIONS } from '@/utils/pdfConfig';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { classifyPdfLoadError } from '@/features/learning-hub/apps/views/pdfLoadErrors';
import { getErrorMessage } from '@/utils/errorUtils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  resolvePdfAnnotationSaveBaseline,
  subscribePdfAnnotationChanges,
} from '../pdfAnnotationEvents';

// 配置 PDF.js worker - 使用构建基路径，避免打包后绝对路径失效
pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.wrapper.mjs`;

/** PDF 目录项 */
interface OutlineItem {
  title: string;
  dest: string | any[] | null;
  items?: OutlineItem[];
}

/** 搜索匹配结果（pageIndex 为 1-based 页码，matchIndex 为页内命中序号） */
interface SearchMatch {
  pageIndex: number;
  matchIndex: number;
}

/** 搜索命中落在某个文本 item 内的子区间（用于 customTextRenderer 页内高亮） */
interface SearchItemRange {
  /** item.str 内的起始偏移 */
  start: number;
  /** item.str 内的结束偏移（不含） */
  end: number;
  /** 该命中在本页内的序号（对应 SearchMatch.matchIndex） */
  matchOrdinal: number;
}

/** pageNumber -> itemIndex -> 高亮区间列表 */
type SearchRangesByPage = Map<number, Map<number, SearchItemRange[]>>;

/** 视图模式 */
type ViewMode = 'single' | 'dual';

/** 缩放模式：custom 为手动百分比；其余为自适应档位（resize 时自动重算） */
type ZoomMode = PdfFitMode;

/** 侧边栏模式 */
type SidebarMode = 'none' | 'outline' | 'thumbnails';

/** 高亮批注
 *
 * 坐标版本说明：
 * - `coordVersion === 2`：rects 为相对页面宽高的比例坐标（0–1），与容器尺寸/缩放/视图模式无关；
 * - 无 coordVersion（历史数据）：rects 为"捕获时容器宽度下除以 scale"的像素坐标，
 *   仅在与捕获时相同的容器宽度下才对齐，渲染时按旧逻辑乘以当前 scale 兜底显示。
 */
export interface Highlight {
  id: string;
  pageIndex: number;
  text: string;
  color: string;
  rects: { x: number; y: number; width: number; height: number }[];
  createdAt: number;
  coordVersion?: number;
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

/** 缩放范围（fit 模式计算结果也 clamp 到该范围） */
const MIN_SCALE = 0.25;
const MAX_SCALE = 3.0;

/** 双页模式两页之间的水平间距（与 CSS .ds-pdf__page-row gap 对应） */
const DUAL_PAGE_GAP = 8;

/** 无页面尺寸信息时的兜底宽高比（A4 纵向） */
const FALLBACK_PAGE_RATIO = 1.414;

const clampScale = (value: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(value * 100) / 100));

/** customTextRenderer 返回值会作为 innerHTML 注入文本层，必须转义原文 */
const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 快捷键提示使用平台习惯的修饰键符号 */
const MOD_KEY_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌘'
    : 'Ctrl';

/** 密码 PDF 内联解锁表单（居中内联，非模态） */
const PdfPasswordPrompt: React.FC<{
  incorrect: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}> = ({ incorrect, onSubmit, onCancel }) => {
  const { t } = useTranslation(['pdf', 'common']);
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    if (password.trim()) onSubmit(password);
  };

  return (
    <div className="ds-pdf__password ui-rise-in" role="form" aria-label={t('pdf:password.title')}>
      <div className="ds-pdf__password-icon">
        <LockSimple size={28} weight="duotone" />
      </div>
      <div className="ds-pdf__password-title">{t('pdf:password.title')}</div>
      <div className="ds-pdf__password-desc">{t('pdf:password.description')}</div>
      <Input
        ref={inputRef}
        type="password"
        className="ds-pdf__password-input"
        placeholder={t('pdf:password.placeholder')}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        aria-invalid={incorrect || undefined}
      />
      {incorrect && (
        <div className="ds-pdf__password-error" role="alert">
          {t('pdf:password.incorrect')}
        </div>
      )}
      <div className="ds-pdf__password-actions">
        <DsButton variant="ghost" size="sm" onClick={onCancel}>
          {t('pdf:password.cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" onClick={submit} disabled={!password.trim()}>
          {t('pdf:password.submit')}
        </DsButton>
      </div>
    </div>
  );
};

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
  const { t } = useTranslation(['pdf', 'textbook', 'common']);

  // ========== PDF 设置集成 ==========
  const pdfSettings = usePdfSettingsStore((s) => s.settings);
  // 批注模式运行时开关（会话级，不持久化）：移动端进入批注模式时临时开启文本层
  const annotationMode = usePdfSettingsStore((s) => s.annotationMode);
  const setAnnotationMode = usePdfSettingsStore((s) => s.setAnnotationMode);

  // 合并 props 与设置：props 优先（外部覆盖）→ 运行时批注模式 → 持久化默认值
  const resolvedEnableTextSelection =
    enableTextSelection ?? annotationMode ?? pdfSettings.enableTextLayerByDefault;
  const resolvedViewMode = pdfSettings.defaultViewMode;

  // 高亮批注是否有落盘/回调通道。独立阅读页（PdfReader）打开的是任意磁盘文件，
  // 无法构造 DSTU resourcePath —— 此时隐藏高亮入口，避免"创建后静默丢失"。
  const canPersistAnnotations =
    Boolean(resourcePath) || initialHighlights !== undefined || Boolean(onHighlightsChange);

  // ========== 响应式环境检测（<640 内联子屏 / coarse 触控） ==========
  // 断点设计意图：<640 为「内联子屏」形态；640-767 保留压缩桌面形态
  // （App shell 移动切换点是 768）。查询用 not (min-width:640px) 与
  // useMobileScreen 同源，避免小数视口宽度（如 639.5px）下与 CSS 断点判定不一致。
  const [isSmallViewport, setIsSmallViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('not (min-width: 640px)').matches
  );
  const [isCoarsePointer, setIsCoarsePointer] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );
  useEffect(() => {
    const smallMq = window.matchMedia('not (min-width: 640px)');
    const coarseMq = window.matchMedia('(pointer: coarse)');
    const onSmallChange = () => setIsSmallViewport(smallMq.matches);
    const onCoarseChange = () => setIsCoarsePointer(coarseMq.matches);
    smallMq.addEventListener('change', onSmallChange);
    coarseMq.addEventListener('change', onCoarseChange);
    return () => {
      smallMq.removeEventListener('change', onSmallChange);
      coarseMq.removeEventListener('change', onCoarseChange);
    };
  }, []);
  const isMobileLike = isSmallViewport || isCoarsePointer;

  // 轻点内容区显隐底部工具栏（进度细线常显）
  const [chromeVisible, setChromeVisible] = useState<boolean>(true);
  const chromeToggleTimerRef = useRef<number | null>(null);
  // 捏合预览 transform 的目标元素（.ds-pdf__pages-container）
  const pagesTransformRef = useRef<HTMLDivElement>(null);
  // 旋转状态下划词提示的节流时间戳
  const rotationTipAtRef = useRef<number>(0);
  // 进度条拖动预览页码
  const [scrubPage, setScrubPage] = useState<number | null>(null);
  const scrubbingRef = useRef(false);

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(initialPage + 1);

  // ========== 缩放模式解析 ==========
  // props.defaultScale 优先（'PageFit'|'PageWidth'|'ActualSize'|number），
  // 否则读设置 defaultFitMode / defaultScale。
  // 注意渲染模型：pageWidth = containerWidth * scale，即 scale=1.0 恒等于「适应宽度」。
  const initialZoomRef = useRef<{ mode: ZoomMode; scale: number } | null>(null);
  if (initialZoomRef.current === null) {
    const pref: EnhancedPdfViewerProps['defaultScale'] | PdfFitMode =
      defaultScale ??
      (pdfSettings.defaultFitMode !== 'custom' ? pdfSettings.defaultFitMode : pdfSettings.defaultScale);
    switch (pref) {
      case 'PageWidth':
      case 'fitWidth':
        initialZoomRef.current = { mode: 'fitWidth', scale: 1.0 };
        break;
      case 'PageFit':
      case 'fitPage':
        initialZoomRef.current = { mode: 'fitPage', scale: 1.0 };
        break;
      case 'ActualSize':
      case 'actualSize':
        initialZoomRef.current = { mode: 'actualSize', scale: 1.0 };
        break;
      default:
        initialZoomRef.current = {
          mode: 'custom',
          scale: typeof pref === 'number' ? clampScale(pref) : 1.0,
        };
        break;
    }
  }
  const [zoomMode, setZoomMode] = useState<ZoomMode>(initialZoomRef.current.mode);
  const [scale, setScale] = useState<number>(initialZoomRef.current.scale);
  // 缩放去抖期间的展示值（仅影响百分比读数，不触发页面重渲染）
  const [pendingScale, setPendingScale] = useState<number | null>(null);
  const [showZoomMenu, setShowZoomMenu] = useState<boolean>(false);
  // 捏合缩放手势读取当前 scale 用（避免 effect 因 scale 变化重订阅）
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const pendingScaleRef = useRef<number | null>(null);
  const zoomCommitTimerRef = useRef<number | null>(null);
  // 首页在 scale=1 下的 viewport 尺寸（PDF pt ≈ CSS px），fit 模式计算基准
  const [basePageSize, setBasePageSize] = useState<{ width: number; height: number } | null>(null);
  // 每页真实宽高比缓存（pageNumber -> height/width，未旋转），供虚拟行高估算
  const pageRatiosRef = useRef<Map<number, number>>(new Map());
  const [pageInputValue, setPageInputValue] = useState<string>('');
  const [containerWidth, setContainerWidth] = useState<number>(600);
  const [containerHeight, setContainerHeight] = useState<number>(800);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // 加载进度（0-100；无 total 信息时为 null，仅显示 spinner）
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorHint, setLoadErrorHint] = useState<string | null>(null);
  const [documentRetryKey, setDocumentRetryKey] = useState(0);
  
  // 新增功能状态
  const [rotation, setRotation] = useState<number>(0); // 0, 90, 180, 270
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>(resolvedViewMode);
  // 暗色阅读模式（invert 渲染，全局偏好持久化）
  const [isDarkReading, setIsDarkReading] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pdf:darkReading') === '1';
    } catch {
      return false;
    }
  });
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('none');
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  // 大纲条目（按路径 key）到目标页码的解析结果，用于「当前章节」随滚动高亮
  const [outlinePages, setOutlinePages] = useState<Map<string, number>>(() => new Map());
  // 大纲跳转失败时的轻提示（自动消失，非模态）
  const [outlineTip, setOutlineTip] = useState<string | null>(null);
  const outlineTipTimerRef = useRef<number | null>(null);
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  // 命中文本在各页各 item 内的子区间，驱动 customTextRenderer 页内高亮
  const [searchRangesByPage, setSearchRangesByPage] = useState<SearchRangesByPage>(() => new Map());
  const [currentSearchIndex, setCurrentSearchIndex] = useState<number>(0);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  // 密码 PDF：onPassword 回调驱动的内联解锁表单
  const [passwordState, setPasswordState] = useState<'none' | 'required' | 'incorrect'>('none');
  const passwordCallbackRef = useRef<((password: string | null) => void) | null>(null);
  
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
  const annotationRevisionRef = useRef<string | null>(null);

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
  // ★ 2026-07-08（移动端审计 D-3）：触屏设备按钮放大到 40px（pointer: coarse CSS），
  // 完整工具栏约需 700px，520 阈值会在 520–700px 区间溢出，触屏取更高阈值。
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const isCoarsePointer =
      typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    const threshold = isCoarsePointer ? 700 : 520;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setIsToolbarCompact(w < threshold);
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
  // ★ 2026-07-08（审计 M1）：pdf.js 会把 Uint8Array transfer 给 worker（detach 原 buffer）。
  // 必须传副本，否则父组件持有的 data 首次装载后即失效，重试/重挂载必然报 detached buffer。
  // documentRetryKey 加入依赖：重试时基于（未被 detach 的）原 data 重新切副本。
  const file = useMemo(() => {
    if (data && data.byteLength > 0) {
      return { data: data.slice() };
    }
    if (url) {
      return url;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- documentRetryKey 触发重新克隆 data
  }, [data, url, documentRetryKey]);

  // ★ 2026-07-08（审计 M3）：文档源变化时重置阅读状态，
  // 避免同一挂载实例切换 PDF 后残留旧页码/跳过初始滚动。
  // （initialScrollDoneRef 在此声明，供下方初始滚动 effect 使用）
  const initialScrollDoneRef = useRef(false);
  const fileSourceKey = typeof file === 'string' ? file : file ? 'data' : '';
  const prevFileSourceKeyRef = useRef(fileSourceKey);
  useEffect(() => {
    if (prevFileSourceKeyRef.current === fileSourceKey) return;
    prevFileSourceKeyRef.current = fileSourceKey;
    initialScrollDoneRef.current = false;
    setNumPages(0);
    setCurrentPage(initialPage + 1);
    setIsLoading(true);
    setLoadProgress(null);
    setLoadError(null);
    setLoadErrorHint(null);
    // 新文档：重置尺寸缓存 / 大纲 / 搜索高亮 / 密码状态
    pageRatiosRef.current.clear();
    setBasePageSize(null);
    setOutline(null);
    setOutlinePages(new Map());
    setSearchRangesByPage(new Map());
    setPasswordState('none');
    passwordCallbackRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在文档源变化时重置
  }, [fileSourceKey]);

  // Refs for callbacks
  const numPagesRef = useRef(numPages);
  const onPageChangeRef = useRef(onPageChange);
  const currentPageRef = useRef(currentPage);

  useEffect(() => {
    numPagesRef.current = numPages;
    onPageChangeRef.current = onPageChange;
    currentPageRef.current = currentPage;
  });

  // ACR 4.0（A7）：agent/引用 gotoPage 跳页成功后给目标页一次高亮渐隐演出。
  // 只动 opacity；prefers-reduced-motion 下 CSS 关闭动画、走静态短高亮（定时移除）。
  const [agentFocusPage, setAgentFocusPage] = useState<number | null>(null);
  const agentFocusTimerRef = useRef<number | null>(null);
  const flashAgentFocusPage = useCallback((pageNum: number) => {
    if (agentFocusTimerRef.current !== null) {
      window.clearTimeout(agentFocusTimerRef.current);
    }
    // 先清空、下一帧再置位：同页重复跳页也能重新触发 CSS 动画
    setAgentFocusPage(null);
    requestAnimationFrame(() => setAgentFocusPage(pageNum));
    agentFocusTimerRef.current = window.setTimeout(() => {
      setAgentFocusPage(null);
      agentFocusTimerRef.current = null;
    }, 1200);
  }, []);
  useEffect(() => () => {
    if (agentFocusTimerRef.current !== null) {
      window.clearTimeout(agentFocusTimerRef.current);
    }
  }, []);

  // 注册命令
  useEffect(() => {
    if (onRegisterCommands) {
      onRegisterCommands({
        jumpToPage: (pageIndex: number) => {
          const targetPage = Math.max(1, Math.min(pageIndex + 1, numPagesRef.current));
          setCurrentPage(targetPage);
          onPageChangeRef.current?.(targetPage - 1);
          scrollToPageRef.current?.(targetPage);
          flashAgentFocusPage(targetPage);
        }
      });
    }
  }, [onRegisterCommands, flashAgentFocusPage]);

  // 监听容器尺寸
  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      const width = container.clientWidth - 48;
      if (width > 0) {
        setContainerWidth(width);
      }
      // 视口 padding 上下各 16px；fit page 模式据此计算可用高度
      const height = container.clientHeight - 32;
      if (height > 0) {
        setContainerHeight(height);
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
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
    // ★ 2026-07-08（审计 M3）：页码 clamp 到有效范围（initialPage 可能越界，
    // 否则工具栏显示 "101 / 10" 且持久化进度被污染）
    setCurrentPage((prev) => Math.max(1, Math.min(prev, pages)));
    setIsLoading(false);
    setLoadProgress(null);
    setLoadError(null);
    onDocumentLoad?.(pages);
  }, [onDocumentLoad]);

  // 获取 PDF 文档对象用于目录和搜索
  const handleDocumentLoadSuccessWithDoc = useCallback((pdf: PDFDocumentProxy) => {
    pdfDocRef.current = pdf;

    // 首页基准尺寸（scale=1 的 viewport），供 fit 模式与行高估算使用
    pdf.getPage(1).then((page) => {
      if (pdfDocRef.current !== pdf) return;
      const viewport = page.getViewport({ scale: 1 });
      if (viewport.width > 0 && viewport.height > 0) {
        pageRatiosRef.current.set(1, viewport.height / viewport.width);
        setBasePageSize({ width: viewport.width, height: viewport.height });
      }
    }).catch(() => {
      // 忽略：fit 模式回退到 A4 估算
    });

    // 加载目录，并异步解析每个条目的目标页码（供当前章节高亮/快速跳转）
    pdf.getOutline().then(async (outlineItems) => {
      if (!outlineItems || outlineItems.length === 0 || pdfDocRef.current !== pdf) return;
      setOutline(outlineItems as OutlineItem[]);

      const pageMap = new Map<string, number>();
      const walk = async (items: OutlineItem[], prefix: string) => {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const path = prefix ? `${prefix}.${i}` : `${i}`;
          try {
            let dest: any = item.dest;
            if (typeof dest === 'string') {
              dest = await pdf.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0]) {
              const pageIndex = await pdf.getPageIndex(dest[0]);
              pageMap.set(path, pageIndex + 1);
            }
          } catch {
            // 单个条目解析失败不影响其余条目
          }
          if (item.items && item.items.length > 0) {
            await walk(item.items, path);
          }
        }
      };
      await walk(outlineItems as OutlineItem[], '');
      if (pdfDocRef.current === pdf) {
        setOutlinePages(pageMap);
      }
    }).catch(() => {
      // 忽略目录加载错误
    });
  }, []);

  // 旋转页面（顺时针 / 逆时针）
  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360);
  }, []);

  const handleRotateCcw = useCallback(() => {
    setRotation(prev => (prev + 270) % 360);
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

  // 窄屏/触屏隐藏双页入口的同时，把已处于双页的视图（如持久化默认值）收回单页，
  // 避免入口隐藏后用户被锁死在不可读的双页模式
  useEffect(() => {
    if ((isSmallViewport || isCoarsePointer) && viewMode === 'dual') {
      setViewMode('single');
    }
  }, [isSmallViewport, isCoarsePointer, viewMode]);

  // 暗色阅读模式切换（持久化为全局偏好）
  const handleToggleDarkReading = useCallback(() => {
    setIsDarkReading(prev => {
      const next = !prev;
      try {
        localStorage.setItem('pdf:darkReading', next ? '1' : '0');
      } catch {
        // localStorage 不可用时仅会话内生效
      }
      return next;
    });
  }, []);

  // 大纲跳转失败的轻提示（2.5s 自动消失）
  const showOutlineTip = useCallback((message: string) => {
    if (outlineTipTimerRef.current !== null) {
      window.clearTimeout(outlineTipTimerRef.current);
    }
    setOutlineTip(message);
    outlineTipTimerRef.current = window.setTimeout(() => {
      setOutlineTip(null);
      outlineTipTimerRef.current = null;
    }, 2500);
  }, []);

  useEffect(() => () => {
    if (outlineTipTimerRef.current !== null) {
      window.clearTimeout(outlineTipTimerRef.current);
    }
  }, []);

  // 目录导航（优先使用预解析的页码，失败时给用户轻提示而非仅 console）
  const handleOutlineClick = useCallback(async (item: OutlineItem, path: string) => {
    if (!pdfDocRef.current) return;

    const jumpTo = (targetPage: number) => {
      setCurrentPage(targetPage);
      onPageChange?.(targetPage - 1);
      scrollToPageRef.current?.(targetPage);
    };

    const resolved = outlinePages.get(path);
    if (resolved) {
      jumpTo(resolved);
      return;
    }

    if (!item.dest) {
      showOutlineTip(t('pdf:toolbar.outline_nav_failed'));
      return;
    }

    try {
      let pageIndex: number;
      if (typeof item.dest === 'string') {
        const dest = await pdfDocRef.current.getDestination(item.dest);
        if (dest) {
          const ref = dest[0];
          pageIndex = await pdfDocRef.current.getPageIndex(ref);
        } else {
          showOutlineTip(t('pdf:toolbar.outline_nav_failed'));
          return;
        }
      } else if (Array.isArray(item.dest)) {
        const ref = item.dest[0];
        pageIndex = await pdfDocRef.current.getPageIndex(ref);
      } else {
        showOutlineTip(t('pdf:toolbar.outline_nav_failed'));
        return;
      }

      jumpTo(pageIndex + 1);
    } catch (err) {
      console.error('Failed to navigate to outline item:', err);
      showOutlineTip(t('pdf:toolbar.outline_nav_failed'));
    }
  }, [onPageChange, outlinePages, showOutlineTip, t]);

  // 当前章节：所有已解析条目中，目标页 ≤ 当前页的最后一个（文档顺序）
  const activeOutlinePath = useMemo(() => {
    let best: string | null = null;
    let bestPage = -1;
    for (const [path, page] of outlinePages) {
      if (page <= currentPage && page >= bestPage) {
        best = path;
        bestPage = page;
      }
    }
    return best;
  }, [outlinePages, currentPage]);

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

  // 滚动降级渲染（可选设置）：滚动中把 isScrolling 接入 renderDpr，
  // 停止 250ms 后恢复高清渲染。未开启该设置时滚动中不触发任何重渲染。
  const scrollDprDowngradeEnabled = pdfSettings.enableScrollDprDowngrade;
  const setScrollingState = useCallback((value: boolean) => {
    if (isScrollingRef.current === value) return;
    isScrollingRef.current = value;
    if (value) {
      if (scrollDprDowngradeEnabled) {
        setIsScrolling(true);
      }
    } else {
      setIsScrolling(false);
    }
  }, [scrollDprDowngradeEnabled]);

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
  // ★ 文本拼接保留 item 边界：items 直接连接（hasEOL 处补换行），
  // 不再用 join(' ')——pdf.js 常把一个词拆进多个 item，旧做法插入空格导致
  // "im"+"portant" 搜 "important" 永远搜不到。同时记录每个 item 的偏移，
  // 把命中区间映射回 item 内子区间，供 customTextRenderer 做页内高亮。
  const handleSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    abortSearchTask();
    if (!pdfDocRef.current || !query) {
      setSearchResults([]);
      setSearchRangesByPage(new Map());
      setCurrentSearchIndex(0);
      setIsSearching(false);
      return;
    }

    const task = { id: Date.now(), cancelled: false };
    searchTaskRef.current = task;
    setIsSearching(true);
    const results: SearchMatch[] = [];
    const rangesByPage: SearchRangesByPage = new Map();
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

          // 拼接页面文本并记录每个 item 的偏移
          const itemOffsets: { itemIndex: number; start: number; length: number }[] = [];
          let pageText = '';
          (textContent.items as Array<{ str?: string; hasEOL?: boolean }>).forEach((item, itemIdx) => {
            const str = typeof item.str === 'string' ? item.str : '';
            itemOffsets.push({ itemIndex: itemIdx, start: pageText.length, length: str.length });
            pageText += str;
            if (item.hasEOL) pageText += '\n';
          });
          // 换行折算为空格（等长替换，偏移不变）：让含空格的短语
          // 也能命中跨行文本（"foo bar" vs "foo\nbar"）
          const lowerText = pageText.toLowerCase().replace(/\n/g, ' ');

          let matchOrdinal = 0;
          let pos = lowerText.indexOf(query);
          while (pos !== -1) {
            results.push({ pageIndex, matchIndex: matchOrdinal });

            // 命中区间 [pos, pos+len) 映射到覆盖的各 item
            const matchEnd = pos + query.length;
            for (const info of itemOffsets) {
              if (info.start >= matchEnd) break;
              const overlapStart = Math.max(pos, info.start);
              const overlapEnd = Math.min(matchEnd, info.start + info.length);
              if (overlapEnd <= overlapStart) continue;
              let pageMap = rangesByPage.get(pageIndex);
              if (!pageMap) {
                pageMap = new Map();
                rangesByPage.set(pageIndex, pageMap);
              }
              let itemRanges = pageMap.get(info.itemIndex);
              if (!itemRanges) {
                itemRanges = [];
                pageMap.set(info.itemIndex, itemRanges);
              }
              itemRanges.push({
                start: overlapStart - info.start,
                end: overlapEnd - info.start,
                matchOrdinal,
              });
            }

            matchOrdinal++;
            pos = lowerText.indexOf(query, pos + 1);
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
      setSearchRangesByPage(rangesByPage);
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
      setSearchRangesByPage(new Map());
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
    setSearchRangesByPage(new Map());
    setCurrentSearchIndex(0);
    setIsSearching(false);
  }, [abortSearchTask]);

  // 页内搜索高亮：把命中子区间包成 <mark>，当前命中加强调样式。
  // 返回值作为文本层 innerHTML 注入，原文必须转义。
  const searchHighlightActive = showSearch && searchRangesByPage.size > 0;
  const currentSearchMatch = searchResults[currentSearchIndex];
  const searchTextRenderer = useCallback(
    (props: { pageNumber: number; itemIndex: number; str: string }) => {
      const ranges = searchRangesByPage.get(props.pageNumber)?.get(props.itemIndex);
      if (!ranges || ranges.length === 0) return escapeHtml(props.str);
      let html = '';
      let cursor = 0;
      for (const range of ranges) {
        // 重叠命中（如 "aa" 在 "aaa" 中）只渲染未覆盖部分
        const start = Math.max(range.start, cursor);
        if (range.end <= cursor) continue;
        if (start > cursor) html += escapeHtml(props.str.slice(cursor, start));
        const isCurrent =
          currentSearchMatch !== undefined &&
          currentSearchMatch.pageIndex === props.pageNumber &&
          currentSearchMatch.matchIndex === range.matchOrdinal;
        html += `<mark class="ds-search-mark${isCurrent ? ' ds-search-mark--current' : ''}">${escapeHtml(props.str.slice(start, range.end))}</mark>`;
        cursor = range.end;
      }
      html += escapeHtml(props.str.slice(cursor));
      return html;
    },
    [searchRangesByPage, currentSearchMatch]
  );

  // 命中导航后把当前 <mark> 精确滚到视口中部（页级 scrollToIndex 只到页首）。
  // 仅滚动阅读器视口自身，不用 scrollIntoView 以免联动外层滚动容器。
  useEffect(() => {
    if (!showSearch || currentSearchMatch === undefined) return;
    const timer = window.setTimeout(() => {
      const viewport = pageContainerRef.current;
      if (!viewport) return;
      const el = viewport.querySelector('.ds-search-mark--current');
      if (!el) return;
      const elRect = el.getBoundingClientRect();
      const vpRect = viewport.getBoundingClientRect();
      const offset = elRect.top - vpRect.top - vpRect.height / 2 + elRect.height / 2;
      if (Math.abs(offset) < vpRect.height * 0.35) return; // 已大致可见则不打断
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      viewport.scrollBy({ top: offset, behavior: reduceMotion ? 'auto' : 'smooth' });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [showSearch, currentSearchMatch, currentSearchIndex]);

  // ★ 2026-07-08（移动端审计 D-4）：Android 系统返回键先关闭查看器内的浮层
  // （高亮菜单/更多菜单/缩放菜单/书签列表/批注列表/目录缩略图侧栏/搜索栏），
  // 而不是直接退出视图。轻量菜单优先关闭（视觉上位于最上层）。
  // 仅在有浮层打开时注册；桌面端不触发 handleAndroidBack，无行为变化。
  useEffect(() => {
    const hasOverlay =
      showHighlightMenu || showMoreMenu || showZoomMenu ||
      showBookmarkList || showHighlightList || sidebarMode !== 'none' || showSearch;
    if (!hasOverlay) return;
    return registerBackHandler(() => {
      if (showHighlightMenu) {
        setShowHighlightMenu(false);
        return true;
      }
      if (showMoreMenu) {
        setShowMoreMenu(false);
        return true;
      }
      if (showZoomMenu) {
        setShowZoomMenu(false);
        return true;
      }
      if (showBookmarkList) {
        setShowBookmarkList(false);
        return true;
      }
      if (showHighlightList) {
        setShowHighlightList(false);
        return true;
      }
      if (sidebarMode !== 'none') {
        setSidebarMode('none');
        return true;
      }
      if (showSearch) {
        handleCloseSearch();
        return true;
      }
      return false;
    }, BACK_PRIORITY.overlay);
  }, [
    showHighlightMenu,
    showMoreMenu,
    showZoomMenu,
    showBookmarkList,
    showHighlightList,
    sidebarMode,
    showSearch,
    handleCloseSearch,
  ]);

  // 文本选择处理（用于高亮批注）
  const handleTextSelection = useCallback(() => {
    // 无落盘通道时不提供高亮入口（选择/复制文本仍可用）
    if (!canPersistAnnotations) return;

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

    // ★ 旋转状态下选区 rect 是旋转后的屏幕坐标，恢复原始角度后会双重错位，
    // 暂不支持旋转时创建高亮（比错位持久化更可接受）。
    // 给出轻提示（8s 节流，避免连续划词刷屏）而非静默失败。
    if (rotation !== 0) {
      setShowHighlightMenu(false);
      const now = Date.now();
      if (now - rotationTipAtRef.current > 8000) {
        rotationTipAtRef.current = now;
        showGlobalNotification(
          'info',
          t('pdf:toolbar.highlight_rotation_disabled', {
            defaultValue: '旋转视图下暂不支持划词高亮，请恢复原始方向后再试',
          })
        );
      }
      return;
    }

    // 获取选区位置
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    // 找到所在页面
    let pageIndex = currentPage;
    const pageWrapper = range.startContainer.parentElement?.closest('[data-page-number]');
    if (pageWrapper) {
      pageIndex = parseInt(pageWrapper.getAttribute('data-page-number') || '1', 10);
    }
    
    // ★ 2026-07-08（审计 28-P1-2）：按页面实际渲染宽高归一化为 0–1 相对坐标。
    // 旧做法只除以 scale，实际基准是"捕获瞬间的容器像素宽度"，
    // 窗口缩放/侧边栏开合/单双页切换后已存高亮全部错位。
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    const clientRects = range.getClientRects();
    if (pageWrapper) {
      const pageRect = pageWrapper.getBoundingClientRect();
      if (pageRect.width > 0 && pageRect.height > 0) {
        for (let i = 0; i < clientRects.length; i++) {
          const r = clientRects[i];
          rects.push({
            x: (r.left - pageRect.left) / pageRect.width,
            y: (r.top - pageRect.top) / pageRect.height,
            width: r.width / pageRect.width,
            height: r.height / pageRect.height,
          });
        }
      }
    }
    
    setPendingHighlight({ text, pageIndex, rects });
    setHighlightMenuPos({ x: rect.left + rect.width / 2, y: rect.top - 10 });
    setShowHighlightMenu(true);
  }, [canPersistAnnotations, currentPage, rotation, t]);

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
      coordVersion: 2,
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
      title: `${t('pdf:bookmark.defaultTitle')} - ${t('pdf:toolbar.page', { page: currentPage })}`,
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
  // ★ 2026-06-12（代理 3 审阅 H1）：此处应使用 resolvedEnableTextSelection
  // （prop ?? 设置默认值），与文本层渲染开关保持一致；旧代码用原始 prop，
  // 未传 prop 时即使设置启用了文本层，划词高亮菜单也永远不会出现。
  // ★ 触屏路径：长按选词不触发 mouseup —— 补 touchend（微延迟等选区稳定）
  // 与 selectionchange（防抖 350ms，覆盖拖动选区手柄调整选区的场景）。
  useEffect(() => {
    if (!resolvedEnableTextSelection) return;
    document.addEventListener('mouseup', handleTextSelection);

    let touchEndTimer: number | null = null;
    let selectionChangeTimer: number | null = null;
    const onTouchEnd = () => {
      if (touchEndTimer !== null) window.clearTimeout(touchEndTimer);
      touchEndTimer = window.setTimeout(() => {
        touchEndTimer = null;
        handleTextSelection();
      }, 80);
    };
    const onSelectionChange = () => {
      if (selectionChangeTimer !== null) window.clearTimeout(selectionChangeTimer);
      selectionChangeTimer = window.setTimeout(() => {
        selectionChangeTimer = null;
        handleTextSelection();
      }, 350);
    };
    if (isCoarsePointer) {
      document.addEventListener('touchend', onTouchEnd);
      document.addEventListener('selectionchange', onSelectionChange);
    }
    return () => {
      document.removeEventListener('mouseup', handleTextSelection);
      if (isCoarsePointer) {
        document.removeEventListener('touchend', onTouchEnd);
        document.removeEventListener('selectionchange', onSelectionChange);
      }
      if (touchEndTimer !== null) window.clearTimeout(touchEndTimer);
      if (selectionChangeTimer !== null) window.clearTimeout(selectionChangeTimer);
    };
  }, [resolvedEnableTextSelection, isCoarsePointer, handleTextSelection]);

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
          const revision = result.value.metadata.annotationRevision;
          annotationRevisionRef.current =
            typeof revision === 'string' && revision.trim() ? revision : null;
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

  // Agent/DSTU writes emit a real Tauri event. Reload the shared metadata so
  // every already-open reader converges on the committed annotation revision.
  useEffect(() => {
    if (!resourcePath || initialHighlights !== undefined) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribePdfAnnotationChanges(resourcePath, (payload) => {
      void dstu.get(resourcePath).then((result) => {
        if (disposed || !result.ok) return;
        const next = result.value.metadata?.highlights;
        const revision = result.value.metadata?.annotationRevision;
        if (Array.isArray(next)) {
          const normalized = next as Highlight[];
          setHighlights(normalized);
          lastSavedHighlightsRef.current = JSON.stringify(normalized);
        }
        const nextBookmarks = result.value.metadata?.bookmarks;
        if (Array.isArray(nextBookmarks)) {
          setBookmarks(nextBookmarks as Bookmark[]);
        }
        annotationRevisionRef.current =
          typeof revision === 'string' && revision.trim()
            ? revision
            : payload.updated_at ?? null;
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      console.warn('[EnhancedPdfViewer] 监听批注刷新事件失败:', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [initialHighlights, resourcePath]);
  
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
        const serverRevision = existingMetadata.annotationRevision;
        const baseline = resolvePdfAnnotationSaveBaseline<Highlight>(
          annotationRevisionRef.current,
          lastSavedHighlightsRef.current,
          serverRevision,
          existingMetadata.highlights,
        );
        if (baseline.status === 'missing_revision') {
          console.warn('[EnhancedPdfViewer] 缺少批注版本，重新加载后再保存');
          return;
        }
        if (baseline.status === 'reload') {
          setHighlights(baseline.highlights);
          lastSavedHighlightsRef.current = JSON.stringify(baseline.highlights);
          annotationRevisionRef.current = baseline.revision;
          console.warn('[EnhancedPdfViewer] 批注已在其他窗口更新，已加载最新版本');
          return;
        }
        const expectedRevision = baseline.expectedRevision;
        annotationRevisionRef.current = expectedRevision;
        const newMetadata = {
          ...existingMetadata,
          highlights: highlights,
        };

        const result = await dstu.setMetadata(resourcePath, newMetadata, expectedRevision);
        if (result.ok) {
          console.log('[EnhancedPdfViewer] 高亮批注已保存:', highlights.length, '条');
          lastSavedHighlightsRef.current = currentHighlightsJson;
          const refreshed = await dstu.get(resourcePath);
          if (refreshed.ok) {
            const revision = refreshed.value.metadata?.annotationRevision;
            annotationRevisionRef.current =
              typeof revision === 'string' && revision.trim() ? revision : null;
          }
        } else {
          console.warn('[EnhancedPdfViewer] 保存高亮批注失败:', result.error);
          // OCC conflicts and failed writes must not leave an unsaved local
          // view masquerading as committed state. Reload the authoritative
          // annotations and revision so the next user edit has a valid base.
          const current = await dstu.get(resourcePath);
          if (current.ok) {
            const serverHighlights = current.value.metadata?.highlights;
            const serverRevision = current.value.metadata?.annotationRevision;
            if (Array.isArray(serverHighlights)) {
              const normalized = serverHighlights as Highlight[];
              setHighlights(normalized);
              lastSavedHighlightsRef.current = JSON.stringify(normalized);
            }
            annotationRevisionRef.current =
              typeof serverRevision === 'string' && serverRevision.trim()
                ? serverRevision
                : null;
          }
        }
      } catch (err) {
        console.error('[EnhancedPdfViewer] 保存高亮批注异常:', err);
        const current = await dstu.get(resourcePath);
        if (current.ok) {
          const serverHighlights = current.value.metadata?.highlights;
          const serverRevision = current.value.metadata?.annotationRevision;
          if (Array.isArray(serverHighlights)) {
            const normalized = serverHighlights as Highlight[];
            setHighlights(normalized);
            lastSavedHighlightsRef.current = JSON.stringify(normalized);
          }
          annotationRevisionRef.current =
            typeof serverRevision === 'string' && serverRevision.trim()
              ? serverRevision
              : null;
        }
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

  // 点击/触摸其他地方关闭高亮菜单（pointerdown 同时覆盖鼠标与触屏，
  // 触屏上 click 可能因选区操作被吞掉导致菜单关不掉）
  useEffect(() => {
    if (!showHighlightMenu) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      // 浮动菜单与移动端底部色板条内的操作都不关闭
      if (target?.closest('.ds-highlight-menu, .ds-pdf__highlight-bar')) return;
      setShowHighlightMenu(false);
    };
    const timer = window.setTimeout(
      () => document.addEventListener('pointerdown', handlePointerDown),
      100
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [showHighlightMenu]);

  // 文档加载失败
  const handleDocumentLoadError = useCallback((error: Error) => {
    console.error('PDF load error:', error);
    setIsLoading(false);
    const classified = classifyPdfLoadError(error);
    const diagnostic = getErrorMessage(error);
    switch (classified.kind) {
      case 'password':
        setLoadError(t('pdf:errors.password_protected'));
        setLoadErrorHint([
          t('pdf:errors.password_protected_hint'),
          diagnostic,
        ].filter(Boolean).join(' '));
        break;
      case 'invalid':
        setLoadError(t('pdf:errors.invalid_pdf'));
        setLoadErrorHint([
          t('pdf:errors.invalid_pdf_hint'),
          diagnostic,
        ].filter(Boolean).join(' '));
        break;
      case 'network':
        setLoadError(t('pdf:errors.stream_failed'));
        setLoadErrorHint([
          t('pdf:errors.stream_failed_hint'),
          diagnostic,
        ].filter(Boolean).join(' '));
        break;
      default:
        setLoadError(t('pdf:errors.load_failed'));
        setLoadErrorHint(diagnostic || classified.rawMessage || null);
        break;
    }
  }, [t]);

  const handleRetryLoad = useCallback(() => {
    setLoadError(null);
    setLoadErrorHint(null);
    setIsLoading(true);
    setNumPages(0);
    setDocumentRetryKey((k) => k + 1);
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

  // ========== 缩放 ==========
  // applyScale：手动缩放统一入口（切到 custom 模式）。
  // debounce=true 时（滚轮/捏合连续手势）先更新读数，120ms 空闲后才 commit 真实
  // scale——避免连续手势期间可见页 canvas 全量重绘风暴。
  const flushPendingScale = useCallback(() => {
    if (zoomCommitTimerRef.current !== null) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = null;
    }
    if (pendingScaleRef.current !== null) {
      setScale(pendingScaleRef.current);
      pendingScaleRef.current = null;
      setPendingScale(null);
    }
  }, []);

  const applyScale = useCallback((next: number, options?: { debounce?: boolean }) => {
    const clamped = clampScale(next);
    setZoomMode('custom');
    if (options?.debounce) {
      pendingScaleRef.current = clamped;
      setPendingScale(clamped);
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
      }
      zoomCommitTimerRef.current = window.setTimeout(() => {
        zoomCommitTimerRef.current = null;
        if (pendingScaleRef.current !== null) {
          setScale(pendingScaleRef.current);
          pendingScaleRef.current = null;
          setPendingScale(null);
        }
      }, 120);
    } else {
      if (zoomCommitTimerRef.current !== null) {
        window.clearTimeout(zoomCommitTimerRef.current);
        zoomCommitTimerRef.current = null;
      }
      pendingScaleRef.current = null;
      setPendingScale(null);
      setScale(clamped);
    }
  }, []);

  useEffect(() => () => {
    if (zoomCommitTimerRef.current !== null) {
      window.clearTimeout(zoomCommitTimerRef.current);
    }
  }, []);

  const handleZoomIn = useCallback(() => {
    applyScale((pendingScaleRef.current ?? scaleRef.current) + 0.25);
  }, [applyScale]);

  const handleZoomOut = useCallback(() => {
    applyScale((pendingScaleRef.current ?? scaleRef.current) - 0.25);
  }, [applyScale]);

  const handleZoomSelect = useCallback((newScale: number) => {
    applyScale(newScale);
    setShowZoomMenu(false);
  }, [applyScale]);

  const handleZoomModeSelect = useCallback((mode: ZoomMode) => {
    // 丢弃去抖中的手动缩放，避免其延迟 commit 覆盖 fit 计算结果
    if (zoomCommitTimerRef.current !== null) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = null;
    }
    pendingScaleRef.current = null;
    setPendingScale(null);
    setZoomMode(mode);
    if (mode === 'fitWidth') {
      // 渲染模型下 scale=1 即适应宽度，可立即生效
      setScale(1.0);
    }
    setShowZoomMenu(false);
  }, []);

  // fit 模式：基于容器尺寸与首页 scale=1 viewport 计算等效 scale。
  // 依赖容器尺寸/视图模式/旋转，窗口 resize 时自动重算。
  useEffect(() => {
    if (zoomMode === 'custom') return;
    if (zoomMode === 'fitWidth') {
      setScale((prev) => (prev === 1.0 ? prev : 1.0));
      return;
    }
    if (!basePageSize || containerWidth <= 0 || containerHeight <= 0) return;

    const rotated = rotation % 180 !== 0;
    const baseW = rotated ? basePageSize.height : basePageSize.width;
    const baseH = rotated ? basePageSize.width : basePageSize.height;
    const ratio = baseH / baseW;

    let next = 1.0;
    if (zoomMode === 'fitPage') {
      // 整页可见：页面渲染高度 ≤ 容器可用高度，且不超过容器宽度
      const targetPageWidth = containerHeight / ratio;
      next = viewMode === 'dual'
        ? ((targetPageWidth + DUAL_PAGE_GAP) * 2) / containerWidth
        : targetPageWidth / containerWidth;
      next = Math.min(next, 1.0);
    } else if (zoomMode === 'actualSize') {
      // 实际大小：渲染宽度 = PDF pt 宽度（≈ 100% CSS px）
      next = viewMode === 'dual'
        ? ((baseW + DUAL_PAGE_GAP) * 2) / containerWidth
        : baseW / containerWidth;
    }

    const clamped = clampScale(next);
    setScale((prev) => (Math.abs(prev - clamped) < 0.005 ? prev : clamped));
  }, [zoomMode, basePageSize, containerWidth, containerHeight, viewMode, rotation]);

  // 锚点缩放：以视口内 (clientX, clientY) 为锚点 commit 新 scale，
  // commit 后按比例补偿 scrollTop/scrollLeft，让锚点对应的文档位置尽量不动。
  // 说明：行高与 pageWidth 均正比于 scale，滚动内容近似整体线性缩放；
  // 视口 padding 等常量项带来的误差在可接受范围内。
  const applyAnchoredScale = useCallback((next: number, clientX: number, clientY: number) => {
    const viewport = pageContainerRef.current;
    const base = scaleRef.current;
    const clamped = clampScale(next);
    if (!viewport || clamped === base) {
      if (clamped !== base) applyScale(clamped);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    const k = clamped / base;
    const targetTop = (viewport.scrollTop + relY) * k - relY;
    const targetLeft = (viewport.scrollLeft + relX) * k - relX;
    applyScale(clamped);
    // 双 rAF：等新 scale 完成渲染、虚拟列表按新行高重估后再补偿滚动
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        viewport.scrollTop = Math.max(0, targetTop);
        viewport.scrollLeft = Math.max(0, targetLeft);
      });
    });
  }, [applyScale]);

  // ========== 触屏双指捏合缩放 ==========
  // 捏合期间不重渲染 canvas：对页面容器做 CSS transform: scale 视觉预览
  // （transform-origin 取双指中心），touchend 一次性 commit 最终指距对应的
  // scale 并做滚动补偿，保持双指中心下的文档位置基本不动。
  useEffect(() => {
    const viewport = pageContainerRef.current;
    if (!viewport) return;

    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let isPinching = false;
    let previewRatio = 1;
    let centerX = 0;
    let centerY = 0;

    const getTouchDist = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const getTouchCenter = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });

    const clearPreview = () => {
      const el = pagesTransformRef.current;
      if (el) {
        el.style.transform = '';
        el.style.transformOrigin = '';
        el.style.willChange = '';
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      isPinching = true;
      previewRatio = 1;
      pinchStartDist = getTouchDist(e.touches);
      // 预览以当前已布局的 scale 为基准（此期间不走 applyScale）
      flushPendingScale();
      pinchStartScale = scaleRef.current;
      const center = getTouchCenter(e.touches);
      centerX = center.x;
      centerY = center.y;
      const el = pagesTransformRef.current;
      if (el) {
        // transform-origin 取双指中心在内容元素坐标系中的位置：
        // 捏合期间视口不滚动（touchmove preventDefault），该点视觉保持不动
        const rect = el.getBoundingClientRect();
        el.style.transformOrigin = `${center.x - rect.left}px ${center.y - rect.top}px`;
        el.style.willChange = 'transform';
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isPinching || e.touches.length !== 2) return;
      // 阻止滚动/原生页面缩放，由我们接管
      e.preventDefault();
      if (pinchStartDist <= 0) return;
      const center = getTouchCenter(e.touches);
      centerX = center.x;
      centerY = center.y;
      // 预览比例 clamp 到 commit 后允许的 scale 区间，避免松手回跳
      const raw = getTouchDist(e.touches) / pinchStartDist;
      previewRatio = Math.min(
        MAX_SCALE / pinchStartScale,
        Math.max(MIN_SCALE / pinchStartScale, raw)
      );
      const el = pagesTransformRef.current;
      if (el) {
        el.style.transform = `scale(${previewRatio})`;
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!isPinching || e.touches.length >= 2) return;
      isPinching = false;
      clearPreview();
      // touchend 一次性 commit 最终指距对应的 scale（锚定双指中心）
      const next = clampScale(pinchStartScale * previewRatio);
      if (next !== scaleRef.current) {
        applyAnchoredScale(next, centerX, centerY);
      }
    };

    const onTouchCancel = () => {
      if (!isPinching) return;
      isPinching = false;
      // 手势被系统打断：还原预览，不 commit
      clearPreview();
    };

    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove, { passive: false });
    viewport.addEventListener('touchend', onTouchEnd, { passive: true });
    viewport.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      viewport.removeEventListener('touchcancel', onTouchCancel);
      clearPreview();
    };
  }, [applyAnchoredScale, flushPendingScale]);

  // ========== 触屏双击缩放 + 轻点显隐工具栏 ==========
  // 双击（~300ms 内两次轻点）在「适应宽度(scale=1)」与 2× 间切换，锚点为点击位置；
  // 单次轻点（非链接/按钮/选区）延迟 320ms 确认非双击后 toggle 底部工具栏。
  useEffect(() => {
    const viewport = pageContainerRef.current;
    if (!viewport) return;

    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let moved = false;
    let multiTouch = false;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        multiTouch = true;
        return;
      }
      multiTouch = false;
      moved = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) {
        multiTouch = true;
        return;
      }
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (Math.hypot(dx, dy) > 12) moved = true;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (multiTouch || moved) return;
      if (Date.now() - touchStartTime > 350) return; // 长按不算轻点
      const touch = e.changedTouches[0];
      if (!touch) return;
      const target = e.target as HTMLElement | null;
      // 链接/按钮/输入框等交互元素不拦截（保持原生行为）
      if (
        target?.closest(
          'a, button, input, textarea, select, .ds-pdf__select-btn, .ds-highlight-menu, .ds-pdf__highlight-rect'
        )
      ) {
        return;
      }
      // 文本层选区激活时不触发（划词高亮流程优先，避免双击与选词冲突）
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;

      const now = Date.now();
      const isDoubleTap =
        now - lastTapTime < 300 &&
        Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY) < 40;

      if (isDoubleTap) {
        lastTapTime = 0;
        if (chromeToggleTimerRef.current !== null) {
          window.clearTimeout(chromeToggleTimerRef.current);
          chromeToggleTimerRef.current = null;
        }
        // 阻止合成 click / 原生双击缩放
        if (e.cancelable) e.preventDefault();
        const current = scaleRef.current;
        const next = Math.abs(current - 1) < 0.01 ? 2 : 1;
        applyAnchoredScale(next, touch.clientX, touch.clientY);
        return;
      }

      lastTapTime = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;
      // 延迟确认非双击后再切换 chrome（避免双击缩放时工具栏闪动）
      if (chromeToggleTimerRef.current !== null) {
        window.clearTimeout(chromeToggleTimerRef.current);
      }
      chromeToggleTimerRef.current = window.setTimeout(() => {
        chromeToggleTimerRef.current = null;
        setChromeVisible((prev) => !prev);
      }, 320);
    };

    viewport.addEventListener('touchstart', onTouchStart, { passive: true });
    viewport.addEventListener('touchmove', onTouchMove, { passive: true });
    viewport.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      viewport.removeEventListener('touchstart', onTouchStart);
      viewport.removeEventListener('touchmove', onTouchMove);
      viewport.removeEventListener('touchend', onTouchEnd);
      if (chromeToggleTimerRef.current !== null) {
        window.clearTimeout(chromeToggleTimerRef.current);
        chromeToggleTimerRef.current = null;
      }
    };
  }, [applyAnchoredScale]);

  // ========== Ctrl/Cmd + 滚轮缩放 ==========
  // ★ 2026-06-12（审阅问题 FE-M2）：对齐桌面阅读器惯例（浏览器/Preview/Acrobat）。
  // passive: false 以阻止浏览器默认页面缩放；去抖 commit 避免 canvas 重渲染风暴。
  useEffect(() => {
    const viewport = pageContainerRef.current;
    if (!viewport) return;

    let lastWheelCommit = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // 触控板捏合在浏览器中也表现为 ctrlKey+wheel，统一接管
      e.preventDefault();

      const step = e.deltaY < 0 ? 0.1 : -0.1;
      const next = (pendingScaleRef.current ?? scaleRef.current) + step;
      // 连续滚动去抖 commit（120ms），每 250ms 强制 commit 保证反馈
      const now = Date.now();
      if (now - lastWheelCommit >= 250) {
        lastWheelCommit = now;
        applyScale(next);
      } else {
        applyScale(next, { debounce: true });
      }
    };

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [applyScale]);

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
          setSearchRangesByPage(new Map());
          setCurrentSearchIndex(0);
          setIsSearching(false);
        }
        if (showHighlightMenu) setShowHighlightMenu(false);
        return;
      }
      
      if (isInputFocused) return;

      // 空格：按标准阅读器行为滚动一屏（Shift+空格向上），不再抢占为翻页。
      // 焦点在按钮/链接等可激活控件上时不拦截（空格应触发该控件）。
      if (e.key === ' ') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest('button, a, select, [role="button"]')) return;
        const viewport = pageContainerRef.current;
        if (viewport) {
          e.preventDefault();
          const delta = viewport.clientHeight * 0.88 * (e.shiftKey ? -1 : 1);
          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          viewport.scrollBy({ top: delta, behavior: reduceMotion ? 'auto' : 'smooth' });
        }
        return;
      }

      // 翻页快捷键
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPage(currentPageRef.current - 1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToPage(currentPageRef.current + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        goToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        goToPage(numPagesRef.current);
      }

      // 旋转：R 顺时针，Shift+R 逆时针
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) {
          handleRotateCcw();
        } else {
          handleRotate();
        }
      }
      
      // 缩放快捷键（stopPropagation 防止与 global.zoom-* 命令双重执行）
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        e.stopPropagation();
        handleZoomIn();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        e.stopPropagation();
        handleZoomOut();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        // 重置为适应宽度（scale=1 即 fit width，且 resize 时保持自适应）
        handleZoomModeSelect('fitWidth');
      }
    };
    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [showSearch, showHighlightMenu, goToPage, abortSearchTask, handleRotate, handleRotateCcw, handleZoomIn, handleZoomOut, handleZoomModeSelect]);

  // ========== 键盘焦点保障 ==========
  // 快捷键监听挂在容器上，需要容器持有焦点。文档就绪后自动 focus 容器
  // （仅当前焦点不在任何输入类元素时），保证 ←→/±/Ctrl+F 开箱即用。
  useEffect(() => {
    if (numPages === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const active = document.activeElement;
    if (!active || active === document.body) {
      container.focus({ preventScroll: true });
    }
  }, [numPages]);

  // 点击阅读器内容（非输入控件）时把焦点收回容器，避免点击后快捷键失效
  const handleRootPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const container = containerRef.current;
    if (container && !container.contains(document.activeElement)) {
      container.focus({ preventScroll: true });
    }
  }, []);

  // 页面选择
  const handleTogglePageSelect = useCallback((pageNum: number) => {
    onToggleSelectPage?.(pageNum);
  }, [onToggleSelectPage]);

  // 双页模式下页面宽度
  const pageWidth = viewMode === 'dual'
    ? (containerWidth * scale) / 2 - DUAL_PAGE_GAP
    : containerWidth * scale;
  const themeClass = isDarkMode ? 'dark-mode' : '';

  // 移动 WebView（Android/iOS）多不支持 Fullscreen API：隐藏全屏入口
  const fullscreenSupported =
    typeof document !== 'undefined' && Boolean(document.fullscreenEnabled);
  // 窄屏/触屏隐藏双页入口（≤640 双页每页过窄不可读）
  const dualPageAvailable = !isSmallViewport && !isCoarsePointer;
  // 批注模式切换入口：有落盘通道、且文本层未被 prop 显式控制时提供
  const annotationToggleAvailable = canPersistAnnotations && enableTextSelection === undefined;

  // ========== 从设置读取渲染参数 ==========
  // DPR 上限来自设置（默认 2，Retina 清晰）；开启滚动降级时滚动中临时降低
  const renderDpr = useMemo(() => {
    const deviceDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const capped = Math.min(deviceDpr, pdfSettings.maxDevicePixelRatio);
    if (isScrolling && pdfSettings.enableScrollDprDowngrade) {
      return Math.min(pdfSettings.scrollDpr, capped);
    }
    return capped;
  }, [
    pdfSettings.maxDevicePixelRatio,
    pdfSettings.enableScrollDprDowngrade,
    pdfSettings.scrollDpr,
    isScrolling,
  ]);
  // 文本层/批注层渲染范围
  const textLayerRange = pdfSettings.textLayerRange;
  const annotationLayerRange = pdfSettings.annotationLayerRange;

  // 阅读进度百分比
  const readingProgress = numPages > 0 ? Math.round((currentPage / numPages) * 100) : 0;

  // ========== 进度条拖动跳页 ==========
  // pointerdown 捕获指针后拖动实时预览目标页码，松手 commit 跳页
  const progressPosToPage = useCallback((clientX: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || numPages <= 0) return 1;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.min(numPages, Math.max(1, Math.round(ratio * numPages) || 1));
  }, [numPages]);

  const handleProgressPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (numPages <= 0) return;
    scrubbingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubPage(progressPosToPage(e.clientX, e.currentTarget));
  }, [numPages, progressPosToPage]);

  const handleProgressPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    setScrubPage(progressPosToPage(e.clientX, e.currentTarget));
  }, [progressPosToPage]);

  const handleProgressPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    const target = progressPosToPage(e.clientX, e.currentTarget);
    setScrubPage(null);
    goToPage(target);
  }, [progressPosToPage, goToPage]);

  const handleProgressPointerCancel = useCallback(() => {
    scrubbingRef.current = false;
    setScrubPage(null);
  }, []);

  const pageRowCount = useMemo(() => (
    viewMode === 'dual' ? Math.ceil(numPages / 2) : numPages
  ), [viewMode, numPages]);

  const getRowPages = useCallback((rowIndex: number) => {
    if (viewMode === 'dual') {
      const first = rowIndex * 2 + 1;
      const second = first + 1;
      return [first, second].filter(pageNum => pageNum <= numPages);
    }
    return [rowIndex + 1];
  }, [viewMode, numPages]);

  // ========== 虚拟行高估算 ==========
  // 使用缓存的每页真实宽高比（首页来自 viewport，其余页在渲染成功时记录），
  // 未知页回退到首页比例/A4，显著降低估算误差导致的滚动抖动。
  const defaultPageRatio = basePageSize
    ? basePageSize.height / basePageSize.width
    : FALLBACK_PAGE_RATIO;
  const defaultPageRatioRef = useRef(defaultPageRatio);
  defaultPageRatioRef.current = defaultPageRatio;

  const getPageDisplayRatio = useCallback((pageNum: number) => {
    const ratio = pageRatiosRef.current.get(pageNum) ?? defaultPageRatioRef.current;
    return rotation % 180 !== 0 ? 1 / ratio : ratio;
  }, [rotation]);

  // 页面渲染成功时记录真实宽高比（originalWidth/Height 为 scale=1 未旋转尺寸）
  const handlePageLoadSuccess = useCallback((page: { pageNumber: number; originalWidth: number; originalHeight: number }) => {
    if (page.originalWidth > 0 && page.originalHeight > 0) {
      pageRatiosRef.current.set(page.pageNumber, page.originalHeight / page.originalWidth);
    }
  }, []);

  // shimmer 占位元素按页缓存：保持元素引用稳定，避免每次渲染新建 JSX
  // 导致 MemoPage 的 props 浅比较永远失败（memo 失效）
  const shimmerCacheRef = useRef<Map<number, React.ReactElement>>(new Map());
  const shimmerCacheKey = `${pageWidth}|${rotation}|${basePageSize ? `${basePageSize.width}x${basePageSize.height}` : '-'}`;
  const prevShimmerCacheKeyRef = useRef(shimmerCacheKey);
  if (prevShimmerCacheKeyRef.current !== shimmerCacheKey) {
    prevShimmerCacheKeyRef.current = shimmerCacheKey;
    shimmerCacheRef.current.clear();
  }
  const getPageShimmer = useCallback((pageNum: number) => {
    let el = shimmerCacheRef.current.get(pageNum);
    if (!el) {
      el = (
        <div
          className="ds-pdf__page-shimmer"
          style={{ width: pageWidth, height: Math.round(pageWidth * getPageDisplayRatio(pageNum)) }}
          aria-hidden="true"
        />
      );
      shimmerCacheRef.current.set(pageNum, el);
    }
    return el;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缓存失效由 shimmerCacheKey 控制
  }, [shimmerCacheKey, getPageDisplayRatio]);

  const estimatedRowHeight = pageWidth * getPageDisplayRatio(1) + (viewMode === 'dual' ? 24 : 32);

  const pageVirtualizer = useVirtualizer({
    count: pageRowCount,
    getScrollElement: () => pageContainerRef.current,
    estimateSize: (rowIndex) => {
      const rowPages = getRowPages(rowIndex);
      let ratio = 0;
      for (const pageNum of rowPages) {
        ratio = Math.max(ratio, getPageDisplayRatio(pageNum));
      }
      if (ratio <= 0) ratio = getPageDisplayRatio(1);
      return pageWidth * ratio + (viewMode === 'dual' ? 24 : 32);
    },
    overscan: pdfSettings.virtualizerOverscan,
    measureElement: (element) => element?.getBoundingClientRect().height ?? estimatedRowHeight,
  });

  const pageVirtualItems = pageVirtualizer.getVirtualItems();

  useEffect(() => {
    if (pageRowCount === 0) return;
    const rafId = requestAnimationFrame(() => pageVirtualizer.measure());
    return () => cancelAnimationFrame(rafId);
    // rotation 影响页面布局高度（90°/270° 时宽高互换），需触发重新测量；
    // basePageSize 到位后行高估算基准变化，同样需要重估
  }, [pageRowCount, pageVirtualizer, pageWidth, viewMode, rotation, basePageSize]);

  useEffect(() => {
    scrollToPageRef.current = (pageNum: number) => {
      if (!pageContainerRef.current || pageRowCount === 0) return;
      const rowIndex = viewMode === 'dual'
        ? Math.floor((pageNum - 1) / 2)
        : pageNum - 1;
      pageVirtualizer.scrollToIndex(rowIndex, { align: 'start', behavior: 'smooth' });
    };
  }, [pageRowCount, pageVirtualizer, viewMode]);

  // ★ 2026-06-12（代理 3 审阅 H3）：恢复初始页（阅读进度）。
  // 旧实现 initialPage 只初始化 currentPage 状态，从不滚动视口：
  // 恢复进度时视口停在第 1 页而页码显示第 N 页，用户一滚动
  // 进度即被覆盖为第 1 页。文档首次就绪时一次性跳转（瞬时，非平滑）。
  // （initialScrollDoneRef 声明已上移至文档源重置逻辑处）
  useEffect(() => {
    if (initialScrollDoneRef.current) return;
    if (numPages === 0 || pageRowCount === 0) return;
    initialScrollDoneRef.current = true;
    if (initialPage > 0) {
      const targetPage = Math.min(initialPage + 1, numPages);
      const rowIndex = viewMode === 'dual'
        ? Math.floor((targetPage - 1) / 2)
        : targetPage - 1;
      requestAnimationFrame(() => {
        pageVirtualizer.scrollToIndex(rowIndex, { align: 'start' });
      });
    }
  }, [numPages, pageRowCount, initialPage, viewMode, pageVirtualizer]);

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
      // 开启滚动降级时，停止 250ms 后恢复高清重渲；未开启维持 120ms 页码结算节奏
      scrollIdleTimerRef.current = window.setTimeout(() => {
        setScrollingState(false);
      }, scrollDprDowngradeEnabled ? 250 : 120);

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
        // 双页模式取行首页作为当前页（与页码输入/书签/大纲高亮语义一致）
        const visiblePage = rowPages[0];
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
  }, [getRowPages, numPages, pageVirtualizer, setScrollingState, scrollDprDowngradeEnabled]);

  // 缩略图宽度与 DPR 从设置读取
  const thumbnailWidth = pdfSettings.thumbnailWidth;
  const thumbnailDpr = pdfSettings.thumbnailDpr;

  // ≤640：缩略图改为全宽 3 列网格（内联子屏），单元宽度按 viewer 宽度均分
  const thumbnailColumns = isSmallViewport ? 3 : 1;
  // containerWidth 为内容视口宽 - 48；内联子屏占满 viewer，
  // 减去面板左右 padding(16×2) 与列间距(8×2) 后三等分
  const effectiveThumbnailWidth = isSmallViewport
    ? Math.max(72, Math.floor((containerWidth + 48 - 32 - 16) / 3))
    : thumbnailWidth;
  const thumbnailRowHeight = Math.ceil(effectiveThumbnailWidth * 1.414) + 40; // 加上页码高度
  const thumbnailRowCount = sidebarMode === 'thumbnails'
    ? Math.ceil(numPages / thumbnailColumns)
    : 0;

  const thumbnailVirtualizer = useVirtualizer({
    count: thumbnailRowCount,
    getScrollElement: () => thumbnailsContainerRef.current,
    estimateSize: () => thumbnailRowHeight,
    overscan: pdfSettings.thumbnailOverscan,
    measureElement: (element) => element?.getBoundingClientRect().height ?? thumbnailRowHeight,
  });

  const thumbnailItems = thumbnailVirtualizer.getVirtualItems();

  useEffect(() => {
    if (sidebarMode !== 'thumbnails' || numPages === 0) return;
    const rafId = requestAnimationFrame(() => thumbnailVirtualizer.measure());
    return () => cancelAnimationFrame(rafId);
  }, [sidebarMode, numPages, thumbnailVirtualizer, effectiveThumbnailWidth, thumbnailColumns]);

  // 缩略图面板跟随当前页滚动（align: auto 仅在目标不可见时滚动）
  useEffect(() => {
    if (sidebarMode !== 'thumbnails' || numPages === 0 || thumbnailRowCount === 0) return;
    const rafId = requestAnimationFrame(() => {
      const rowIndex = Math.floor((currentPage - 1) / thumbnailColumns);
      thumbnailVirtualizer.scrollToIndex(
        Math.min(Math.max(rowIndex, 0), thumbnailRowCount - 1),
        { align: 'auto' }
      );
    });
    return () => cancelAnimationFrame(rafId);
  }, [currentPage, sidebarMode, numPages, thumbnailVirtualizer, thumbnailColumns, thumbnailRowCount]);

  // 切换侧边栏模式
  const toggleSidebar = useCallback((mode: SidebarMode) => {
    setSidebarMode(prev => prev === mode ? 'none' : mode);
  }, []);

  // 渲染目录项（递归）。key 使用路径索引（title 可重复会碰撞）；
  // 当前章节随滚动高亮（aria-current + .active）。
  // onNavigate：移动端内联子屏点击条目跳页后关闭面板。
  const renderOutlineItem = (
    item: OutlineItem,
    depth: number,
    path: string,
    onNavigate?: () => void
  ): React.ReactNode => {
    const isActive = activeOutlinePath === path;
    return (
      <div key={path}>
        <DsButton
          variant="ghost"
          size="sm"
          className={`ds-outline-item ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          aria-current={isActive ? 'true' : undefined}
          onClick={() => {
            void handleOutlineClick(item, path);
            onNavigate?.();
          }}
        >
          {item.title}
        </DsButton>
        {item.items && item.items.map((child, idx) =>
          renderOutlineItem(child, depth + 1, `${path}.${idx}`, onNavigate)
        )}
      </div>
    );
  };

  // 目录侧栏打开/当前章节变化时，把当前章节滚入可视区（nearest，避免大幅跳动）
  useEffect(() => {
    if (sidebarMode !== 'outline' || !activeOutlinePath) return;
    const rafId = requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector('.ds-outline-item[aria-current="true"]')
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(rafId);
  }, [sidebarMode, activeOutlinePath]);

  const renderPage = useCallback((pageNum: number) => {
    const isSelected = selectedPages?.has(pageNum);
    // 搜索高亮激活时即使用户关闭了文本选择也临时渲染文本层（否则命中不可见）
    const enableTextLayer =
      (resolvedEnableTextSelection || searchHighlightActive) &&
      Math.abs(pageNum - currentPage) <= textLayerRange;
    const enableAnnotationLayer =
      pdfSettings.enableAnnotationLayerByDefault &&
      Math.abs(pageNum - currentPage) <= annotationLayerRange;
    const hasSearchMarks = searchHighlightActive && searchRangesByPage.has(pageNum);
    return (
      <div
        key={pageNum}
        id={`pdf-page-${pageNum}`}
        className={`ds-pdf__page-wrapper${agentFocusPage === pageNum ? ' ds-pdf__page-wrapper--agent-focus' : ''}`}
        data-page-number={pageNum}
      >
        {/* ★ 2026-07-08（审计 M2）：旋转改用 pdf.js 的 rotate 属性（参与布局），
            替代 CSS transform（不改变布局盒，导致虚拟列表测量与实际视觉高度不一致、
            相邻页重叠，且高亮取词坐标错位） */}
        <MemoPage
          pageNumber={pageNum}
          width={pageWidth}
          renderTextLayer={enableTextLayer}
          renderAnnotationLayer={enableAnnotationLayer}
          rotate={rotation}
          devicePixelRatio={renderDpr}
          onLoadSuccess={handlePageLoadSuccess}
          customTextRenderer={hasSearchMarks ? searchTextRenderer : undefined}
          loading={getPageShimmer(pageNum)}
        />

        {/* 高亮覆盖层 — v2 为 0–1 相对坐标（按百分比渲染，尺寸无关）；
            历史数据（无 coordVersion）按旧逻辑乘以当前 scale 兜底 */}
        {getPageHighlights(pageNum).map(hl => (
          <div key={hl.id} className="ds-pdf__highlight-layer">
            {hl.rects.map((rect, idx) => (
              <div
                key={idx}
                className="ds-pdf__highlight-rect"
                style={
                  hl.coordVersion === 2
                    ? {
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                        backgroundColor: hl.color,
                      }
                    : {
                        left: rect.x * scale,
                        top: rect.y * scale,
                        width: rect.width * scale,
                        height: rect.height * scale,
                        backgroundColor: hl.color,
                      }
                }
                title={hl.text}
              />
            ))}
          </div>
        ))}

        {enableStudyControls && (
          <div className="ds-pdf__page-overlay">
            <button
              type="button"
              className={`ds-pdf__select-btn ${isSelected ? 'selected' : ''}`}
              onClick={() => handleTogglePageSelect(pageNum)}
              aria-label={isSelected ? t('textbook:deselect_page') : t('textbook:select_page')}
            >
              <span className="ds-pdf__select-checkbox" />
              {typeof maxSelections === 'number' && selectedPages && (
                <span className="ds-pdf__select-btn-text">
                  {selectedPages.size}/{maxSelections}
                </span>
              )}
            </button>
          </div>
        )}

        <div className="ds-pdf__page-number">{pageNum}</div>
      </div>
    );
  }, [
    agentFocusPage,
    annotationLayerRange,
    currentPage,
    enableStudyControls,
    resolvedEnableTextSelection,
    pdfSettings.enableAnnotationLayerByDefault,
    getPageShimmer,
    getPageHighlights,
    handlePageLoadSuccess,
    handleTogglePageSelect,
    maxSelections,
    pageWidth,
    renderDpr,
    rotation,
    searchHighlightActive,
    searchRangesByPage,
    searchTextRenderer,
    selectedPages,
    t,
    textLayerRange,
  ]);

  // 渲染缩略图（复用已加载的 PDF 文档）。
  // onSelect：移动端内联子屏点击后需要额外关闭面板
  const renderThumbnail = useCallback((pageNum: number, onSelect?: () => void) => {
    const placeholderHeight = Math.ceil(effectiveThumbnailWidth * 1.414);
    return (
      <div
        className={`ds-thumbnail-item ${currentPage === pageNum ? 'active' : ''}`}
        onClick={() => {
          goToPage(pageNum);
          onSelect?.();
        }}
        style={{ minHeight: placeholderHeight + 30 }}
      >
        {pdfDocRef.current ? (
          <Thumbnail
            pageNumber={pageNum}
            width={effectiveThumbnailWidth}
            pdf={pdfDocRef.current}
            devicePixelRatio={thumbnailDpr}
          />
        ) : (
          <div
            className="ds-thumbnail-placeholder"
            style={{ width: effectiveThumbnailWidth, height: placeholderHeight }}
          >
            <span>{pageNum}</span>
          </div>
        )}
        <span className="ds-thumbnail-number">{pageNum}</span>
      </div>
    );
  }, [currentPage, goToPage, effectiveThumbnailWidth, thumbnailDpr]);

  if (!file) {
    return (
      <div className={`ds-pdf-viewer ${themeClass} ${className || ''}`} style={style}>
        <div className="ds-pdf__loading">
          <p>{t('pdf:empty.title')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ds-pdf-viewer ${themeClass} ${className || ''} ${isFullscreen ? 'fullscreen' : ''} ${chromeVisible ? '' : 'chrome-hidden'} outline-none`}
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}
      ref={containerRef}
      tabIndex={0}
      onPointerDown={handleRootPointerDown}
    >
      {/* 搜索栏 */}
      {showSearch && (
        <div className="ds-pdf__search-bar">
          <MagnifyingGlass size={16} className="ds-search-icon" />
          <Input
            ref={searchInputRef}
            type="search"
            className="ds-search-input"
            placeholder={t('pdf:toolbar.search_placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          />
          {searchResults.length > 0 && (
            <span className="ds-search-info">
              {t('pdf:toolbar.result_count', {
                current: currentSearchIndex + 1,
                total: searchResults.length
              })}
            </span>
          )}
          {searchQuery && searchResults.length === 0 && !isSearching && (
            <span className="ds-search-info ds-search-no-results">
              {t('pdf:toolbar.no_results')}
            </span>
          )}
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handlePrevSearchResult} disabled={searchResults.length === 0} title={t('pdf:toolbar.prev_match')} aria-label={t('pdf:toolbar.prev_match')}>
            <CaretUp size={16} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleNextSearchResult} disabled={searchResults.length === 0} title={t('pdf:toolbar.next_match')} aria-label={t('pdf:toolbar.next_match')}>
            <CaretDown size={16} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleCloseSearch} title={t('pdf:toolbar.close_search')} aria-label={t('pdf:toolbar.close_search')}>
            <X size={16} />
          </DsButton>
        </div>
      )}

      {/* 高亮菜单：桌面为选区上方浮动菜单；移动端改为 viewer 内底部内联色板条
          （absolute bottom，非 fixed body 层，避让底栏与 safe-area） */}
      {showHighlightMenu && !isMobileLike && (
        <div
          className="ds-highlight-menu"
          style={{
            position: 'fixed',
            left: highlightMenuPos.x,
            top: highlightMenuPos.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.yellow }} onClick={() => addHighlight(HIGHLIGHT_COLORS.yellow)} title={t('pdf:toolbar.highlight_yellow')} aria-label={t('pdf:toolbar.highlight_yellow')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.green }} onClick={() => addHighlight(HIGHLIGHT_COLORS.green)} title={t('pdf:toolbar.highlight_green')} aria-label={t('pdf:toolbar.highlight_green')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.blue }} onClick={() => addHighlight(HIGHLIGHT_COLORS.blue)} title={t('pdf:toolbar.highlight_blue')} aria-label={t('pdf:toolbar.highlight_blue')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.red }} onClick={() => addHighlight(HIGHLIGHT_COLORS.red)} title={t('pdf:toolbar.highlight_red')} aria-label={t('pdf:toolbar.highlight_red')} />
        </div>
      )}

      {showHighlightMenu && isMobileLike && (
        <div className="ds-pdf__highlight-bar ui-rise-in" role="toolbar" aria-label={t('pdf:toolbar.highlight')}>
          <span className="ds-pdf__highlight-bar-label">{t('pdf:toolbar.highlight')}</span>
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.yellow }} onClick={() => addHighlight(HIGHLIGHT_COLORS.yellow)} title={t('pdf:toolbar.highlight_yellow')} aria-label={t('pdf:toolbar.highlight_yellow')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.green }} onClick={() => addHighlight(HIGHLIGHT_COLORS.green)} title={t('pdf:toolbar.highlight_green')} aria-label={t('pdf:toolbar.highlight_green')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.blue }} onClick={() => addHighlight(HIGHLIGHT_COLORS.blue)} title={t('pdf:toolbar.highlight_blue')} aria-label={t('pdf:toolbar.highlight_blue')} />
          <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-color" style={{ background: HIGHLIGHT_COLORS.red }} onClick={() => addHighlight(HIGHLIGHT_COLORS.red)} title={t('pdf:toolbar.highlight_red')} aria-label={t('pdf:toolbar.highlight_red')} />
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="ds-btn ds-btn-sm"
            onClick={() => {
              setShowHighlightMenu(false);
              window.getSelection()?.removeAllRanges();
            }}
            aria-label={t('pdf:a11y.close')}
          >
            <X size={16} />
          </DsButton>
        </div>
      )}

      {/* 主体区域（侧边栏 + 内容） */}
      <div className="ds-pdf__main">
        {/* 侧边栏（>640 并排面板；≤640 改为下方的全屏内联子屏，不再侧滑 overlay）
            ★ 桌面端常挂容器：开合走 width 过渡（--open 修饰类），内容按需挂载。 */}
        {!isSmallViewport && (
          <div
            className={`ds-pdf__sidebar ${sidebarMode !== 'none' ? 'ds-pdf__sidebar--open' : ''}`}
            aria-hidden={sidebarMode === 'none'}
          >
            {/* 目录 */}
            {sidebarMode === 'outline' && outline && (
              <div className="ds-pdf__outline">
                <div className="ds-outline-header">
                  <span>{t('pdf:toolbar.outline')}</span>
                  <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setSidebarMode('none')} aria-label={t('pdf:a11y.close')}>
                    <X size={14} />
                  </DsButton>
                </div>
                {outlineTip && (
                  <div className="ds-outline-tip ui-fade-in" role="status">{outlineTip}</div>
                )}
                <CustomScrollArea className="ds-outline-content" viewportClassName="ds-outline-content-viewport">
                  {outline.map((item, idx) => renderOutlineItem(item, 0, String(idx)))}
                </CustomScrollArea>
              </div>
            )}
            
            {/* 缩略图 */}
            {sidebarMode === 'thumbnails' && (
              <div className="ds-pdf__thumbnails-panel">
                <div className="ds-outline-header">
                  <span>{t('pdf:toolbar.thumbnails')}</span>
                  <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setSidebarMode('none')} aria-label={t('pdf:a11y.close')}>
                    <X size={14} />
                  </DsButton>
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
          className={`ds-pdf__content ${viewMode === 'dual' ? 'dual-page' : ''} ${isDarkReading ? 'dark-reading' : ''}`}
          viewportClassName="ds-pdf__content-viewport"
          viewportRef={pageContainerRef}
          orientation="both"
        >
          {loadError ? (
            <div className="ds-pdf__error">
              <p>{loadError}</p>
              {loadErrorHint && (
                <p style={{ fontSize: '12px', opacity: 0.7, maxWidth: '28rem', textAlign: 'center' }}>
                  {loadErrorHint}
                </p>
              )}
              <DsButton variant="ghost" size="sm" onClick={handleRetryLoad} className="gap-1.5 mt-2">
                <ArrowClockwise size={14} />
                {t('common:retry')}
              </DsButton>
            </div>
          ) : (
            <Document
              key={documentRetryKey}
              file={file}
              options={PDF_OPTIONS}
              onLoadSuccess={(doc) => {
                setPasswordState('none');
                passwordCallbackRef.current = null;
                handleDocumentLoadSuccess(doc);
                handleDocumentLoadSuccessWithDoc(doc as unknown as PDFDocumentProxy);
              }}
              onLoadError={handleDocumentLoadError}
              onLoadProgress={({ loaded, total }: { loaded: number; total: number }) => {
                if (total > 0) {
                  setLoadProgress(Math.min(100, Math.round((loaded / total) * 100)));
                }
              }}
              onPassword={(callback: (password: string | null) => void, reason: number) => {
                // 密码 PDF：内联表单收集密码（非模态），错误可重试
                passwordCallbackRef.current = callback;
                setPasswordState(
                  reason === PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'required'
                );
                setIsLoading(false);
              }}
              loading={
                passwordState !== 'none' ? (
                  <PdfPasswordPrompt
                    incorrect={passwordState === 'incorrect'}
                    onSubmit={(password) => {
                      const callback = passwordCallbackRef.current;
                      passwordCallbackRef.current = null;
                      setPasswordState('none');
                      setIsLoading(true);
                      callback?.(password);
                    }}
                    onCancel={() => {
                      // 取消 → pdf.js 抛 PasswordException → 走既有错误界面（可重试）
                      const callback = passwordCallbackRef.current;
                      passwordCallbackRef.current = null;
                      setPasswordState('none');
                      callback?.(null);
                    }}
                  />
                ) : (
                  <div className="ds-pdf__loading">
                    <div className="ds-pdf__loading-spinner" />
                    <p>
                      {loadProgress !== null
                        ? t('pdf:loading_progress', { percent: loadProgress })
                        : t('pdf:loading')}
                    </p>
                    {loadProgress !== null && (
                      <div
                        className="ds-pdf__load-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={loadProgress}
                      >
                        <div
                          className="ds-pdf__load-progress-fill"
                          style={{ width: `${loadProgress}%` }}
                        />
                      </div>
                    )}
                  </div>
                )
              }
            >
              {numPages > 0 && (
                <div
                  ref={pagesTransformRef}
                  className={`ds-pdf__pages-container ${viewMode === 'dual' ? 'dual' : 'single'}`}
                >
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

      {/* ≤640：目录/缩略图全屏内联子屏（顶栏分段 + 返回；替代侧滑 overlay） */}
      {isSmallViewport && sidebarMode !== 'none' && (
        <div className="ds-pdf__mobile-panel" role="region" aria-label={sidebarMode === 'outline' ? t('pdf:toolbar.outline') : t('pdf:toolbar.thumbnails')}>
          <div className="ds-pdf__mobile-panel-header">
            <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => setSidebarMode('none')} aria-label={t('common:back')}>
              <CaretLeft size={18} />
            </DsButton>
            <div className="ds-pdf__mobile-panel-tabs" role="tablist">
              {outline && outline.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={sidebarMode === 'outline'}
                  className={`ds-pdf__mobile-panel-tab ${sidebarMode === 'outline' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('outline')}
                >
                  {t('pdf:toolbar.outline')}
                </button>
              )}
              <button
                type="button"
                role="tab"
                aria-selected={sidebarMode === 'thumbnails'}
                className={`ds-pdf__mobile-panel-tab ${sidebarMode === 'thumbnails' ? 'active' : ''}`}
                onClick={() => setSidebarMode('thumbnails')}
              >
                {t('pdf:toolbar.thumbnails')}
              </button>
            </div>
            <span className="ds-pdf__mobile-panel-spacer" aria-hidden="true" />
          </div>

          {sidebarMode === 'outline' && outline && (
            <>
              {outlineTip && (
                <div className="ds-outline-tip ui-fade-in" role="status">{outlineTip}</div>
              )}
              <CustomScrollArea className="ds-outline-content" viewportClassName="ds-outline-content-viewport">
                {outline.map((item, idx) =>
                  renderOutlineItem(item, 0, String(idx), () => setSidebarMode('none'))
                )}
              </CustomScrollArea>
            </>
          )}

          {sidebarMode === 'thumbnails' && (
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
                  const firstPage = virtualItem.index * thumbnailColumns + 1;
                  const rowPages: number[] = [];
                  for (let col = 0; col < thumbnailColumns; col++) {
                    const pageNum = firstPage + col;
                    if (pageNum <= numPages) rowPages.push(pageNum);
                  }
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={thumbnailVirtualizer.measureElement}
                      className="ds-thumbnails-grid-row"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      {rowPages.map((pageNum) => (
                        <div key={pageNum} className="ds-thumbnails-grid-cell">
                          {renderThumbnail(pageNum, () => setSidebarMode('none'))}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </CustomScrollArea>
          )}
        </div>
      )}

      {/* 底部工具栏 - 始终单行 */}
      <div className="ds-pdf__toolbar ds-pdf__toolbar--bottom" ref={toolbarRef}>
        {/* 非紧凑模式：左侧侧边栏控制 */}
        {!isToolbarCompact && (
          <div className="ds-pdf__toolbar-left">
            {outline && outline.length > 0 && (
              <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${sidebarMode === 'outline' ? 'active' : ''}`} onClick={() => toggleSidebar('outline')} title={t('pdf:toolbar.outline')} aria-label={t('pdf:toolbar.outline')}>
                <List size={16} />
              </DsButton>
            )}
            
            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${sidebarMode === 'thumbnails' ? 'active' : ''}`} onClick={() => toggleSidebar('thumbnails')} title={t('pdf:toolbar.thumbnails')} aria-label={t('pdf:toolbar.thumbnails')}>
              <GridFour size={16} />
            </DsButton>
            
            <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 100); }} title={`${t('pdf:toolbar.search')} (${MOD_KEY_LABEL} F)`} aria-label={t('pdf:a11y.search')}>
              <MagnifyingGlass size={16} />
            </DsButton>
            
            <div className="ds-toolbar-divider" />
            
            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${currentPageBookmark ? 'active' : ''}`} onClick={addBookmark} title={currentPageBookmark ? t('pdf:bookmark.editBookmark') : t('pdf:bookmark.addBookmark')} aria-label={currentPageBookmark ? t('pdf:bookmark.editBookmark') : t('pdf:bookmark.addBookmark')}>
              {currentPageBookmark ? <BookmarkCheck size={16} /> : <BookmarkSimple size={16} />}
            </DsButton>
            
            {bookmarks.length > 0 && (
              <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showBookmarkList ? 'active' : ''}`} onClick={() => setShowBookmarkList(!showBookmarkList)} title={t('pdf:bookmark.showBookmarks')} aria-label={t('pdf:bookmark.showBookmarks')}>
                <Bookmark size={16} />
                <span className="ds-bookmark-count">{bookmarks.length}</span>
              </DsButton>
            )}

            {/* 批注模式：临时开启当前页 ±N 文本层（运行时开关，不改默认设置） */}
            {annotationToggleAvailable && (
              <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${resolvedEnableTextSelection ? 'active' : ''}`} onClick={() => setAnnotationMode(!resolvedEnableTextSelection)} title={t('pdf:toolbar.highlight')} aria-label={t('pdf:toolbar.highlight')} aria-pressed={resolvedEnableTextSelection}>
                <Highlighter size={16} />
              </DsButton>
            )}

            {/* 批注列表（原右下角 FAB 收入底栏） */}
            {highlights.length > 0 && (
              <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showHighlightList ? 'active' : ''}`} onClick={() => setShowHighlightList(!showHighlightList)} title={t('pdf:toolbar.show_highlights')} aria-label={t('pdf:toolbar.show_highlights')}>
                <Highlighter size={16} weight="fill" />
                <span className="ds-bookmark-count">{highlights.length}</span>
              </DsButton>
            )}
          </div>
        )}

        {/* 核心控制：缩放 + 页面导航（始终显示） */}
        <div className="ds-pdf__toolbar-center">
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleZoomOut} title={`${t('pdf:toolbar.zoom_out')} (${MOD_KEY_LABEL} -)`} aria-label={t('pdf:toolbar.zoom_out')}>
            <MagnifyingGlassMinus size={16} />
          </DsButton>

          <div className="ds-zoom-menu" ref={zoomMenuRef}>
            <DsButton variant="ghost" size="sm" className="ds-btn" onClick={() => setShowZoomMenu(!showZoomMenu)} title={t('pdf:toolbar.zoom_level')} aria-label={t('pdf:toolbar.zoom_level')} aria-expanded={showZoomMenu}>
              <span className="ds-zoom-readout">{Math.round((pendingScale ?? scale) * 100)}%</span>
              <CaretDown size={12} />
            </DsButton>
            {showZoomMenu && (
              <CustomScrollArea
                className="ds-zoom-dropdown ds-zoom-dropdown--up ui-rise-in"
                viewportClassName="ds-zoom-dropdown-viewport"
                fullHeight={false}
              >
                {([
                  ['fitWidth', t('pdf:toolbar.fit_width')],
                  ['fitPage', t('pdf:toolbar.fit_page')],
                  ['actualSize', t('pdf:toolbar.actual_size')],
                ] as const).map(([mode, label]) => (
                  <DsButton
                    key={mode}
                    variant="ghost"
                    size="sm"
                    className={`ds-zoom-option ${zoomMode === mode ? 'active' : ''}`}
                    onClick={() => handleZoomModeSelect(mode)}
                  >
                    {label}
                  </DsButton>
                ))}
                <div className="ds-more-divider" />
                {ZOOM_LEVELS.map(z => (
                  <DsButton key={z} variant="ghost" size="sm" className={`ds-zoom-option ${zoomMode === 'custom' && scale === z ? 'active' : ''}`} onClick={() => handleZoomSelect(z)}>
                    {Math.round(z * 100)}%
                  </DsButton>
                ))}
              </CustomScrollArea>
            )}
          </div>

          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleZoomIn} title={`${t('pdf:toolbar.zoom_in')} (${MOD_KEY_LABEL} +)`} aria-label={t('pdf:toolbar.zoom_in')}>
            <MagnifyingGlassPlus size={16} />
          </DsButton>

          <div className="ds-toolbar-divider" />

          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handlePrevPage} disabled={currentPage <= 1} title={`${t('pdf:actions.previous_page')} (←)`} aria-label={t('pdf:actions.previous_page')}>
            <CaretLeft size={16} />
          </DsButton>

          <div className="ds-page-input">
            <Input
              type="text"
              inputMode="numeric"
              className="ds-input"
              value={pageInputValue || currentPage}
              onChange={(e) => setPageInputValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handlePageInputSubmit()}
              onBlur={handlePageInputSubmit}
              onFocus={(e) => {
                setPageInputValue(String(currentPage));
                const input = e.target as HTMLInputElement;
                requestAnimationFrame(() => input.select());
              }}
              aria-label={t('pdf:page_info', { current: currentPage, total: numPages || 0 })}
            />
            <span className="ds-page-total">/ {numPages || 0}</span>
          </div>

          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleNextPage} disabled={currentPage >= numPages} title={`${t('pdf:actions.next_page')} (→)`} aria-label={t('pdf:actions.next_page')}>
            <CaretRight size={16} />
          </DsButton>
        </div>

        {/* 非紧凑模式：右侧视图控制 */}
        {!isToolbarCompact && (
          <div className="ds-pdf__toolbar-right">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn"
              onClick={(e) => (e.shiftKey ? handleRotateCcw() : handleRotate())}
              title={`${t('pdf:toolbar.rotate_cw')} (R) · ${t('pdf:toolbar.rotate_ccw')} (Shift R)`}
              aria-label={t('pdf:toolbar.rotate_cw')}
            >
              <ArrowClockwise size={16} />
            </DsButton>

            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${isDarkReading ? 'active' : ''}`} onClick={handleToggleDarkReading} title={isDarkReading ? t('pdf:toolbar.light_reading') : t('pdf:toolbar.dark_reading')} aria-label={isDarkReading ? t('pdf:toolbar.light_reading') : t('pdf:toolbar.dark_reading')}>
              {isDarkReading ? <Sun size={16} /> : <Moon size={16} />}
            </DsButton>

            {dualPageAvailable && (
              <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${viewMode === 'dual' ? 'active' : ''}`} onClick={handleToggleViewMode} title={viewMode === 'single' ? t('pdf:toolbar.dual_page') : t('pdf:toolbar.single_page')} aria-label={viewMode === 'single' ? t('pdf:toolbar.dual_page') : t('pdf:toolbar.single_page')}>
                {viewMode === 'single' ? <Book size={16} /> : <BookOpen size={16} />}
              </DsButton>
            )}

            {fullscreenSupported && (
              <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleToggleFullscreen} title={isFullscreen ? t('pdf:toolbar.exit_fullscreen') : t('pdf:toolbar.fullscreen')} aria-label={isFullscreen ? t('pdf:toolbar.exit_fullscreen') : t('pdf:toolbar.fullscreen')}>
                {isFullscreen ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
              </DsButton>
            )}
          </div>
        )}

        {/* 紧凑模式：更多菜单 */}
        {isToolbarCompact && (
          <div className="ds-pdf__toolbar-more" ref={moreMenuRef}>
            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showMoreMenu ? 'active' : ''}`} onClick={() => setShowMoreMenu(!showMoreMenu)} title={t('pdf:toolbar.more')} aria-label={t('pdf:toolbar.more')}>
              <DotsThree size={16} />
            </DsButton>
            {showMoreMenu && (
              <div className="ds-more-dropdown ds-more-dropdown--up ui-rise-in">
                {outline && outline.length > 0 && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${sidebarMode === 'outline' ? 'active' : ''}`} onClick={() => { toggleSidebar('outline'); setShowMoreMenu(false); }}>
                    <List size={14} />
                    <span>{t('pdf:toolbar.outline')}</span>
                  </DsButton>
                )}
                <DsButton variant="ghost" size="sm" className={`ds-more-item ${sidebarMode === 'thumbnails' ? 'active' : ''}`} onClick={() => { toggleSidebar('thumbnails'); setShowMoreMenu(false); }}>
                  <GridFour size={14} />
                  <span>{t('pdf:toolbar.thumbnails')}</span>
                </DsButton>
                <DsButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { setShowSearch(true); setShowMoreMenu(false); setTimeout(() => searchInputRef.current?.focus(), 100); }}>
                  <MagnifyingGlass size={14} />
                  <span>{t('pdf:toolbar.search')}</span>
                </DsButton>

                <div className="ds-more-divider" />

                <DsButton variant="ghost" size="sm" className={`ds-more-item ${currentPageBookmark ? 'active' : ''}`} onClick={() => { addBookmark(); setShowMoreMenu(false); }}>
                  {currentPageBookmark ? <BookmarkCheck size={14} /> : <BookmarkSimple size={14} />}
                  <span>{currentPageBookmark
                    ? t('pdf:bookmark.editBookmark')
                    : t('pdf:bookmark.addBookmark')}</span>
                </DsButton>
                {bookmarks.length > 0 && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${showBookmarkList ? 'active' : ''}`} onClick={() => { setShowBookmarkList(!showBookmarkList); setShowMoreMenu(false); }}>
                    <Bookmark size={14} />
                    <span>{t('pdf:bookmark.showBookmarks')} ({bookmarks.length})</span>
                  </DsButton>
                )}
                {annotationToggleAvailable && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${resolvedEnableTextSelection ? 'active' : ''}`} onClick={() => { setAnnotationMode(!resolvedEnableTextSelection); setShowMoreMenu(false); }}>
                    <Highlighter size={14} />
                    <span>{t('pdf:toolbar.highlight')}</span>
                  </DsButton>
                )}
                {highlights.length > 0 && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${showHighlightList ? 'active' : ''}`} onClick={() => { setShowHighlightList(!showHighlightList); setShowMoreMenu(false); }}>
                    <Highlighter size={14} weight="fill" />
                    <span>{t('pdf:toolbar.show_highlights')} ({highlights.length})</span>
                  </DsButton>
                )}

                <div className="ds-more-divider" />

                <DsButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { handleRotate(); setShowMoreMenu(false); }}>
                  <ArrowClockwise size={14} />
                  <span>{t('pdf:toolbar.rotate_cw')}</span>
                </DsButton>
                <DsButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { handleRotateCcw(); setShowMoreMenu(false); }}>
                  <ArrowCounterClockwise size={14} />
                  <span>{t('pdf:toolbar.rotate_ccw')}</span>
                </DsButton>
                <DsButton variant="ghost" size="sm" className={`ds-more-item ${isDarkReading ? 'active' : ''}`} onClick={() => { handleToggleDarkReading(); setShowMoreMenu(false); }}>
                  {isDarkReading ? <Sun size={14} /> : <Moon size={14} />}
                  <span>{isDarkReading ? t('pdf:toolbar.light_reading') : t('pdf:toolbar.dark_reading')}</span>
                </DsButton>
                {dualPageAvailable && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${viewMode === 'dual' ? 'active' : ''}`} onClick={() => { handleToggleViewMode(); setShowMoreMenu(false); }}>
                    {viewMode === 'single' ? <Book size={14} /> : <BookOpen size={14} />}
                    <span>{viewMode === 'single' ? t('pdf:toolbar.dual_page') : t('pdf:toolbar.single_page')}</span>
                  </DsButton>
                )}
                {fullscreenSupported && (
                  <DsButton variant="ghost" size="sm" className="ds-more-item" onClick={() => { handleToggleFullscreen(); setShowMoreMenu(false); }}>
                    {isFullscreen ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
                    <span>{isFullscreen ? t('pdf:toolbar.exit_fullscreen') : t('pdf:toolbar.fullscreen')}</span>
                  </DsButton>
                )}
              </div>
            )}
          </div>
        )}
      </div>


      {/* 阅读进度条（支持拖动跳页：拖动中显示目标页码，松手跳转） */}
      {numPages > 0 && (
        <div
          className={`ds-pdf__progress-bar ${scrubPage !== null ? 'scrubbing' : ''}`}
          role="slider"
          aria-valuemin={1}
          aria-valuemax={numPages}
          aria-valuenow={scrubPage ?? currentPage}
          aria-label={t('pdf:page_info', { current: scrubPage ?? currentPage, total: numPages })}
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          onPointerCancel={handleProgressPointerCancel}
        >
          <div
            className="ds-pdf__progress-fill"
            style={{
              width: `${numPages > 0 ? Math.round(((scrubPage ?? currentPage) / numPages) * 100) : 0}%`,
            }}
          />
          <span className="ds-pdf__progress-text">
            {scrubPage !== null ? `${scrubPage} / ${numPages}` : `${readingProgress}%`}
          </span>
        </div>
      )}

      {/* 批注列表：>640 浮动面板；≤640 全屏内联子屏（入口在底栏/更多菜单） */}
      {highlights.length > 0 && showHighlightList && (
        <div className={isSmallViewport ? 'ds-pdf__mobile-panel' : 'ds-pdf__highlights-panel'}>
          {isSmallViewport ? (
            <div className="ds-pdf__mobile-panel-header">
              <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => setShowHighlightList(false)} aria-label={t('common:back')}>
                <CaretLeft size={18} />
              </DsButton>
              <span className="ds-pdf__mobile-panel-title">{t('pdf:toolbar.highlights')}</span>
              <span className="ds-pdf__mobile-panel-spacer" aria-hidden="true" />
            </div>
          ) : (
            <div className="ds-outline-header">
              <span>{t('pdf:toolbar.highlights')}</span>
              <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setShowHighlightList(false)} aria-label={t('pdf:a11y.close')}>
                <X size={14} />
              </DsButton>
            </div>
          )}
          <CustomScrollArea
            className="ds-highlights-list"
            viewportClassName="ds-highlights-list-viewport"
          >
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
                    {t('pdf:toolbar.page', { page: hl.pageIndex })}
                  </div>
                </div>
                <DsButton variant="ghost" size="icon" iconOnly className="ds-highlight-delete" onClick={(e) => { e.stopPropagation(); removeHighlight(hl.id); }} title={t('pdf:toolbar.delete_highlight')} aria-label={t('pdf:a11y.delete')}>
                  <X size={12} />
                </DsButton>
              </div>
            ))}
          </CustomScrollArea>
        </div>
      )}

      {/* 书签列表：>640 浮动面板；≤640 全屏内联子屏 */}
      {showBookmarkList && (
        <div className={isSmallViewport ? 'ds-pdf__mobile-panel' : 'ds-pdf__bookmarks-panel'}>
          {isSmallViewport ? (
            <div className="ds-pdf__mobile-panel-header">
              <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => setShowBookmarkList(false)} aria-label={t('common:back')}>
                <CaretLeft size={18} />
              </DsButton>
              <span className="ds-pdf__mobile-panel-title">{t('pdf:bookmark.bookmarkList')}</span>
              <span className="ds-pdf__mobile-panel-spacer" aria-hidden="true" />
            </div>
          ) : (
            <div className="ds-outline-header">
              <span>{t('pdf:bookmark.bookmarkList')}</span>
              <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={() => setShowBookmarkList(false)} aria-label={t('pdf:a11y.close')}>
                <X size={14} />
              </DsButton>
            </div>
          )}
          <CustomScrollArea
            className="ds-bookmarks-list"
            viewportClassName="ds-bookmarks-list-viewport"
          >
            {sortedBookmarks.length === 0 ? (
              <div className="ds-bookmarks-empty">
                <Bookmark size={24} className="ds-bookmarks-empty-icon" />
                <p>{t('pdf:bookmark.noBookmarks')}</p>
                <p className="ds-bookmarks-empty-hint">{t('pdf:bookmark.addHint')}</p>
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
                          {t('pdf:toolbar.page', { page: bm.page })}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="ds-bookmark-actions">
                    {editingBookmarkId !== bm.id && (
                      <DsButton variant="ghost" size="icon" iconOnly className="ds-bookmark-action-btn" onClick={(e) => { e.stopPropagation(); startEditBookmark(bm); }} title={t('pdf:bookmark.editTitle')} aria-label={t('pdf:a11y.edit')}>
                        <Pencil size={12} />
                      </DsButton>
                    )}
                    <DsButton variant="ghost" size="icon" iconOnly className="ds-bookmark-action-btn ds-bookmark-delete-btn" onClick={(e) => { e.stopPropagation(); removeBookmark(bm.id); }} title={t('pdf:bookmark.deleteBookmark')} aria-label={t('pdf:a11y.delete')}>
                      <Trash size={12} />
                    </DsButton>
                  </div>
                </div>
              ))
            )}
          </CustomScrollArea>
        </div>
      )}
    </div>
  );
};

export const EnhancedPdfViewer = React.memo(EnhancedPdfViewerImpl);

export default EnhancedPdfViewer;
