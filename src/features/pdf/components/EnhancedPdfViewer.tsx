import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Document, Page, Thumbnail, pdfjs, PasswordResponses } from 'react-pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePdfSettingsStore, type PdfFitMode } from '../stores/pdfSettingsStore';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import {
  canNavigateNext,
  canNavigatePrev,
  getNextNavigationPage,
  getPrevNavigationPage,
  resolvePageScrollKeyAction,
} from '../pdfPageNavigation';
import { collectPageSearchMatches, normalizePdfLigatures, type SearchItemRange } from '../pdfSearch';
import { loadPdfViewState, savePdfViewState, type PdfViewState } from '../pdfViewState';
import {
  resolveSelectionMenuFrame,
  type PdfSelectionPayload,
  type SelectionMenuAnchor,
  type SelectionMenuFrame,
} from '../pdfSelectionActions';
import {
  ACADEMIC_HIGHLIGHT_COLORS,
  cleanAcademicDocumentTitle,
  formatAcademicCitation,
  normalizePdfAcademicText,
} from '../pdfAcademicText';
import {
  EMPTY_JUMP_HISTORY,
  buildPaperReadingContextSnapshot,
  buildSelectedPagesLocator,
  detectAcademicReference,
  formatPdfOutlineForAgent,
  locateAcademicReferencePage,
  navigateJumpBack,
  navigateJumpForward,
  peekJumpBackEntry,
  peekJumpForwardEntry,
  previewAcademicReference,
  recordReadingJump,
  resolvePaperGuideTargetPages,
  type AcademicReferencePreview,
  type PaperGuideReadingMode,
  type ReadingJumpHistoryState,
} from '../pdfPaperNavigation';
import {
  SINGLE_COLUMN_ZOOM_SCALE,
  buildProgressBarTicks,
  computeColumnDoubleClickZoom,
  computeTrimmedPageLayout,
  type SavedColumnZoomBaseline,
} from '../pdfViewportEnhance';
import type { PinnedPdfRegion } from './PdfPinnedRegionsOverlay';
import type { PinRegionPayload } from './PdfRegionCapture';
import { resourceIdFromDstuPath } from '../pdfAnnotationList';
import { sendSelectionToChatInput } from '../selectionStudyActions';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { openUrl } from '@/utils/urlOpener';
import { dstu } from '@/dstu';
import { startPdfProcessing } from '@/api/vfsPdfProcessingApi';
import { usePdfProcessingStore } from '../stores/pdfProcessingStore';
import { readPdfOcrText } from '../pdfOcrText';
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
  LinkSimple,
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
  LockSimple,
  BookOpenText,
  Copy,
  Crop,
  NotePencil,
  Quotes,
  Sparkle,
  ArrowUUpLeft,
  ArrowUUpRight,
  Crosshair,
  TreeStructure,
} from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import '../styles/enhanced-pdf.css';
import '../styles/pdf-viewer.css';
import { PDF_OPTIONS } from '@/utils/pdfConfig';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { classifyPdfLoadError } from '@/features/learning-hub/apps/views/pdfLoadErrors';
import { getErrorMessage } from '@/utils/errorUtils';
import { registerVisibilityGuardedBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import type { AnchorEdgeRecord } from '@/ui-kernel/contracts/interop';
import { cn } from '@/utils/cn';
import {
  groupPdfAnchorEdgesByPage,
  rotateNormalizedRect,
} from '../interop/pdfInteropBridge';
import { usePdfAnchorReveal } from '../interop/usePdfAnchorReveal';
import { PdfLinkedExcerptTintLayer } from '../interop/PdfLinkedExcerptTintLayer';
import {
  resolvePdfAnnotationSaveBaseline,
  subscribePdfAnnotationChanges,
} from '../pdfAnnotationEvents';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';

// 配置 PDF.js worker - 使用构建基路径，避免打包后绝对路径失效
pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.wrapper.mjs`;

// 共享层划词工具条：必须懒加载——它内部依赖 shared/selection、shared/notes
// 与聊天弹层（解释/翻译 Popover），若在此静态导入，翻译/制卡链路会被
// 重新打进 PDF chunk（见 docs/0824-quality-review/pdf-documents.md）。
// 学习动作（做笔记/翻译/出题/制卡/引用到对话）统一由它承载，
// viewer 内建的 ds-highlight-menu 只保留高亮选色 + 复制，不再重复这些入口。
const PdfSelectionActions = React.lazy(() => import('./PdfSelectionActions'));

// 框选提问覆盖层：点了「框选提问」才加载
const PdfRegionCapture = React.lazy(() => import('./PdfRegionCapture'));
const PdfPageMarginBacklinks = React.lazy(() => import('./PdfPageMarginBacklinks'));
const PdfPinnedRegionsOverlay = React.lazy(() => import('./PdfPinnedRegionsOverlay'));

// 侧栏批注面板（筛选/导出为笔记/回链）同样懒加载：它静态依赖 shared/notes
// 的目录选择流程（FolderPickerDialog），不能随 PDF 主 chunk 打包。
const PdfAnnotationsPanel = React.lazy(() => import('./PdfAnnotationsPanel'));
const PdfRelatedPanel = React.lazy(() => import('./PdfRelatedPanel'));

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

/** pageNumber -> itemIndex -> 高亮区间列表（SearchItemRange 见 ../pdfSearch） */
type SearchRangesByPage = Map<number, Map<number, SearchItemRange[]>>;

/** 视图模式 */
type ViewMode = 'single' | 'dual';

/** 缩放模式：custom 为手动百分比；其余为自适应档位（resize 时自动重算） */
type ZoomMode = PdfFitMode;

/** 侧边栏模式（桌面端目录/缩略图/书签/批注合并为同一侧栏的 tab） */
type SidebarMode = 'none' | 'outline' | 'thumbnails' | 'bookmarks' | 'highlights' | 'related';

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
  /** 批注笔记或一键钉住的 AI 翻译 / 精读结论 */
  comment?: string;
  updatedAt?: number;
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
  toolbarVariant?: 'reader' | 'preview';
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
  /** 划词「添加到聊天」locator 回调，透传给 PdfSelectionActions
   *  （上层视图接 useReferenceToChat：资源引用 + `page:N` locator，Agent 可回读原文）。
   *  缺省时工具条走 PREFILL_CHAT_INPUT 文本注入兜底。 */
  onQuoteToChat?: (payload: PdfSelectionPayload) => void;
  /** P0 选区即上下文：源资源 id（tb_xxx/file_xxx），透传给 PdfSelectionActions。
   *  提供时划词条渲染「引用到聊天」（选区快照 + page locator 的结构化 contextRef）。 */
  selectionSourceId?: string;
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

/** 默认文本层渲染：只做私有区连字还原（fi / fl），保证划词、复制、引用拿到正确文字 */
const ligatureTextRenderer = (props: { str: string }) =>
  escapeHtml(normalizePdfLigatures(props.str));

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
        // 触屏：32px → 44px 触控高度；16px 防 iOS 聚焦自动缩放（同 .ds-search-input coarse 规则，
        // CSS coarse 块漏掉了该输入框；!important 对冲 .ds-pdf__password-input 的 height/font-size）
        className="ds-pdf__password-input [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!text-base"
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
        <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onCancel}>
          {t('pdf:password.cancel')}
        </DsButton>
        <DsButton variant="primary" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={submit} disabled={!password.trim()}>
          {t('pdf:password.submit')}
        </DsButton>
      </div>
    </div>
  );
};

/** Semantic highlight color constants for PDF annotations (5-color academic palette).
 *  These are intentional fixed colors for annotation UX, not theme-dependent. */
const HIGHLIGHT_COLORS = ACADEMIC_HIGHLIGHT_COLORS;

const MemoPage = React.memo(Page);

/**
 * 浮动菜单视口钳位：挂载后测量真实尺寸，经 resolveSelectionMenuFrame
 * 计算钳位坐标。frame 为 null 期间调用方应隐藏菜单（visibility: hidden），
 * 避免未钳位坐标闪现。
 */
function useClampedMenuFrame(anchor: SelectionMenuAnchor | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<SelectionMenuFrame | null>(null);
  const updateFrame = useCallback(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const rect = el.getBoundingClientRect();
    setFrame(
      resolveSelectionMenuFrame(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [anchor]);
  useEventRegistry(
    anchor ? [{ target: 'window', type: 'resize', listener: updateFrame }] : [],
    [anchor, updateFrame],
  );
  useLayoutEffect(() => {
    if (!anchor) {
      setFrame(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    updateFrame();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateFrame);
    resizeObserver?.observe(el);
    return () => {
      resizeObserver?.disconnect();
    };
  }, [anchor, updateFrame]);
  return { ref, frame };
}

const EnhancedPdfViewerImpl: React.FC<EnhancedPdfViewerProps> = ({
  data,
  url,
  fileName,
  defaultScale,
  initialPage = 0,
  style,
  className,
  enableStudyControls = false,
  toolbarVariant = 'reader',
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
  onQuoteToChat,
  selectionSourceId,
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

  // 复制为 viewer 内建动作，不依赖高亮落盘或上层回调；只要文本层可选，
  // 划词菜单就应可用。翻译/出题/制卡/做笔记/引用到对话走共享层 SelectionToolbar。

  // ========== 响应式环境检测（<640 内联子屏 / coarse 触控） ==========
  // 断点设计意图：<640 为「内联子屏」形态；640-767 保留压缩桌面形态
  // （App shell 移动切换点是 768）。查询用 (max-width: 639.98px)，与本文件
  // CSS 断点完全同式（此前的 not (min-width) 为 MQ4 语法，旧 WebView 不支持）。
  const [isSmallViewport, setIsSmallViewport] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 639.98px)').matches
  );
  const [isCoarsePointer, setIsCoarsePointer] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  );
  useEffect(() => {
    const smallMq = window.matchMedia('(max-width: 639.98px)');
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
  // 进度条拖动预览页码
  const [scrubPage, setScrubPage] = useState<number | null>(null);
  const scrubbingRef = useRef(false);

  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(initialPage + 1);

  // ========== 缩放模式解析 ==========
  // 优先级：每文档持久化视图状态（localStorage，按 resourcePath）→ props.defaultScale
  // （'PageFit'|'PageWidth'|'ActualSize'|number）→ 设置 defaultFitMode / defaultScale。
  // 注意渲染模型：pageWidth = containerWidth * scale，即 scale=1.0 恒等于「适应宽度」。
  const persistedViewStateRef = useRef<PdfViewState | null>(null);
  if (persistedViewStateRef.current === null) {
    persistedViewStateRef.current = loadPdfViewState(resourcePath);
  }
  const initialZoomRef = useRef<{ mode: ZoomMode; scale: number } | null>(null);
  if (initialZoomRef.current === null) {
    const persisted = persistedViewStateRef.current;
    const pref: EnhancedPdfViewerProps['defaultScale'] | PdfFitMode =
      persisted.zoomMode ??
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
      case 'custom':
        initialZoomRef.current = {
          mode: 'custom',
          scale: clampScale(persisted.scale ?? pdfSettings.defaultScale),
        };
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
  // 内容视口完整宽度（未扣 padding），供移动端缩略图网格列宽计算
  const [viewportFullWidth, setViewportFullWidth] = useState<number>(648);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  // 加载进度（0-100；无 total 信息时为 null，仅显示 spinner）
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorHint, setLoadErrorHint] = useState<string | null>(null);
  const [documentRetryKey, setDocumentRetryKey] = useState(0);
  
  // 新增功能状态
  const [rotation, setRotation] = useState<number>(0); // 0, 90, 180, 270
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  // 视图模式：每文档持久化值优先，其次全局默认设置
  const [viewMode, setViewMode] = useState<ViewMode>(
    persistedViewStateRef.current?.viewMode ?? resolvedViewMode
  );
  // 双页封面偏移：第 1 页单独成页（书籍类 PDF 的真实对页是 [2,3] [4,5] …）
  const [coverOffset, setCoverOffset] = useState<boolean>(
    persistedViewStateRef.current?.coverOffset ?? false
  );
  // 紧凑裁白边：裁剪学术论文四周冗余留白，在分屏阅读下放大有效版心约 20.5%
  const [trimMargins, setTrimMargins] = useState<boolean>(
    persistedViewStateRef.current?.trimMargins ?? false
  );
  // 双栏论文单栏贴合双击缩放的还原基线
  const columnZoomBaselineRef = useRef<SavedColumnZoomBaseline | null>(null);
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
  // 增量搜索扫描进度（大文档不再"转圈到全部扫完才出结果"）
  const [searchProgress, setSearchProgress] = useState<{ scanned: number; total: number } | null>(null);
  const [isScrolling, setIsScrolling] = useState<boolean>(false);
  // 密码 PDF：onPassword 回调驱动的内联解锁表单
  const [passwordState, setPasswordState] = useState<'none' | 'required' | 'incorrect'>('none');
  const passwordCallbackRef = useRef<((password: string | null) => void) | null>(null);
  
  const thumbnailsContainerRef = useRef<HTMLDivElement>(null);
  
  // 批注状态
  const [highlightState, setHighlightState] = useState<{
    resourcePath: string | undefined;
    initialHighlights: Highlight[] | undefined;
    value: Highlight[];
  }>({ resourcePath, initialHighlights, value: initialHighlights ?? [] });
  const highlights = highlightState.resourcePath === resourcePath &&
    highlightState.initialHighlights === initialHighlights
    ? highlightState.value
    : initialHighlights ?? [];
  const setHighlights = useCallback((update: React.SetStateAction<Highlight[]>) => {
    setHighlightState(previous => {
      const current = previous.resourcePath === resourcePath &&
        previous.initialHighlights === initialHighlights
        ? previous.value
        : initialHighlights ?? [];
      return {
        resourcePath,
        initialHighlights,
        value: typeof update === 'function' ? update(current) : update,
      };
    });
  }, [resourcePath, initialHighlights]);
  const [showHighlightMenu, setShowHighlightMenu] = useState<boolean>(false);
  // 划词菜单锚点（选区 rect 的中点与上下边缘，viewport 坐标）；
  // 实际渲染坐标由 useClampedMenuFrame 钳位到视口内（贴顶时翻转到选区下方）
  const [highlightMenuPos, setHighlightMenuPos] = useState<SelectionMenuAnchor>({ x: 0, top: 0, bottom: 0 });
  const [pendingHighlight, setPendingHighlight] = useState<{ text: string; pageIndex: number; rects: { x: number; y: number; width: number; height: number }[] } | null>(null);
  const [selectionTranslation, setSelectionTranslation] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
  } | null>(null);
  // 点击页面内高亮块后的操作入口：
  // 触屏 → 底部轻量操作条；桌面 → 锚定高亮块的改色/删除浮层（anchor 非空时）
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [activeHighlightAnchor, setActiveHighlightAnchor] = useState<SelectionMenuAnchor | null>(null);
  // 页面内浮层直接编辑批注笔记（创建「高亮并批注」或点按高亮块点编辑时开启）
  const [editingHighlightNoteId, setEditingHighlightNoteId] = useState<string | null>(null);
  const [highlightNoteDraft, setHighlightNoteDraft] = useState<string>('');
  // 论文跨页跳转历史栈（目录 / 内部引用 / 搜索跳页后一键返回原处）
  const [jumpHistory, setJumpHistory] = useState<ReadingJumpHistoryState>(EMPTY_JUMP_HISTORY);
  const jumpHistoryRef = useRef<ReadingJumpHistoryState>(EMPTY_JUMP_HISTORY);
  jumpHistoryRef.current = jumpHistory;
  // 文内图表/文献定位与就地预览卡片状态
  const [isLocatingRef, setIsLocatingRef] = useState<boolean>(false);
  const [refPreviewCard, setRefPreviewCard] = useState<{
    preview: AcademicReferencePreview;
    anchor: SelectionMenuAnchor | null;
  } | null>(null);
  // 画中画对照浮窗（钉在角落的架构图 / 公式 / 表格，最多保留 4 张）
  const [pinnedRegions, setPinnedRegions] = useState<PinnedPdfRegion[]>([]);
  const pinnedRegionsRef = useRef<PinnedPdfRegion[]>([]);
  pinnedRegionsRef.current = pinnedRegions;
  const locateRefTokenRef = useRef<number>(0);
  useEffect(() => () => {
    locateRefTokenRef.current++;
    for (const item of pinnedRegionsRef.current) {
      URL.revokeObjectURL(item.imageUrl);
    }
  }, []);
  // 记住最近一次划词的坐标快照：支持用户先点「翻译/解释」、再点「存入批注」时原地补建高亮块
  const lastSelectionSnapshotRef = useRef<{
    text: string;
    pageIndex: number;
    rects: { x: number; y: number; width: number; height: number }[];
  } | null>(null);
  // 当前 PDF 已抽取的页面干净文本缓存（pageNumber -> normalized academic text）
  const pageTextCacheRef = useRef<Map<number, string>>(new Map());

  // 书签状态（书签/批注列表已并入侧栏 tab，见 sidebarMode）
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(externalBookmarks ?? []);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingBookmarkTitle, setEditingBookmarkTitle] = useState<string>('');

  const [toolbarWidth, setToolbarWidth] = useState(0);
  const isPreviewToolbar = toolbarVariant === 'preview';
  const showStudyShortcuts = !isPreviewToolbar && toolbarWidth >= (isCoarsePointer ? 520 : 390);
  const [showMoreMenu, setShowMoreMenu] = useState<boolean>(false);
  const [showPaperGuideMenu, setShowPaperGuideMenu] = useState<boolean>(false);
  const [regionCaptureActive, setRegionCaptureActive] = useState<boolean>(false);
  // 「划选即入图」：划词或框选完成即送入当前导图 / 笔记（会话级，不持久化）
  const [autoExcerptActive, setAutoExcerptActive] = useState<boolean>(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const paperGuideMenuRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const lastViewportWidthRef = useRef(0);
  const captureResizeAnchorRef = useRef<(() => void) | null>(null);
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
  const annotationSession = useMemo(() => ({
    highlightsSaveTimerRef: { current: null as number | null },
    highlightsLoadedRef: { current: false },
    lastSavedHighlightsRef: { current: '[]' },
    pendingSaveRef: { current: null as (() => Promise<void>) | null },
    annotationRevisionRef: { current: null as string | null },
    saveQueue: Promise.resolve(),
    readVersion: 0,
    currentHighlights: '[]',
    disposed: false,
  }), [resourcePath]);
  const {
    highlightsSaveTimerRef, highlightsLoadedRef, lastSavedHighlightsRef,
    pendingSaveRef, annotationRevisionRef,
  } = annotationSession;
  annotationSession.currentHighlights = JSON.stringify(highlights);

  // Cleanup PDFDocumentProxy on unmount to avoid memory leak
  useEffect(() => {
    return () => {
      if (pdfDocRef.current) {
        pdfDocRef.current.destroy();
        pdfDocRef.current = null;
      }
    };
  }, []);

  // Observe the reader itself; a split panel can be narrow even on a wide desktop.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setToolbarWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, url]);

  // 点击外部关闭"更多"菜单 / "AI 论文导读"菜单
  useEffect(() => {
    if (!showMoreMenu && !showPaperGuideMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (showMoreMenu && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setShowMoreMenu(false);
      }
      if (
        showPaperGuideMenu &&
        paperGuideMenuRef.current &&
        !paperGuideMenuRef.current.contains(target)
      ) {
        setShowPaperGuideMenu(false);
      }
    };
    const timer = window.setTimeout(() => document.addEventListener('click', handleClick), 10);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', handleClick);
    };
  }, [showMoreMenu, showPaperGuideMenu]);

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
  const fileSourceKey = file;
  const resizeAnchorRef = useRef<{ source: typeof fileSourceKey; index: number; fraction: number } | null>(null);
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
    setRegionCaptureActive(false);
    setShowPaperGuideMenu(false);
    setShowHighlightMenu(false);
    setPendingHighlight(null);
    locateRefTokenRef.current++;
    setIsLocatingRef(false);
    jumpHistoryRef.current = EMPTY_JUMP_HISTORY;
    setJumpHistory(EMPTY_JUMP_HISTORY);
    setEditingHighlightNoteId(null);
    lastSelectionSnapshotRef.current = null;
    pageTextCacheRef.current.clear();
    setRefPreviewCard(null);
    columnZoomBaselineRef.current = null;
    setPinnedRegions((prev) => {
      for (const item of prev) {
        URL.revokeObjectURL(item.imageUrl);
      }
      return [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在文档源变化时重置
  }, [fileSourceKey]);

  // Refs for callbacks
  const numPagesRef = useRef(numPages);
  const onPageChangeRef = useRef(onPageChange);
  const currentPageRef = useRef(currentPage);
  const viewModeRef = useRef(viewMode);
  const coverOffsetRef = useRef(coverOffset);

  useEffect(() => {
    numPagesRef.current = numPages;
    onPageChangeRef.current = onPageChange;
    currentPageRef.current = currentPage;
    viewModeRef.current = viewMode;
    coverOffsetRef.current = coverOffset;
  });

  // ========== 每文档视图状态持久化（zoom / fitMode / viewMode / 封面偏移） ==========
  // 窄屏/触屏会把双页自动收回单页（见下方效果），该自动降级不覆盖持久化的
  // 双页偏好：payload 里的 viewMode 只跟随「双页入口可用时」的用户选择。
  const viewModeForPersistRef = useRef<ViewMode>(
    persistedViewStateRef.current?.viewMode ?? viewMode
  );
  const lastSavedViewStateRef = useRef<string | null>(null);
  // 同一挂载实例切换文档（resourcePath 变化）：重新加载新文档的视图状态
  const prevResourcePathRef = useRef(resourcePath);
  useEffect(() => {
    if (prevResourcePathRef.current === resourcePath) return;
    prevResourcePathRef.current = resourcePath;
    lastSavedViewStateRef.current = null;
    const next = loadPdfViewState(resourcePath);
    persistedViewStateRef.current = next;
    if (next.zoomMode) {
      setZoomMode(next.zoomMode);
      if (next.zoomMode === 'custom' && typeof next.scale === 'number') {
        setScale(next.scale);
      }
    }
    if (next.viewMode) {
      setViewMode(next.viewMode);
      viewModeForPersistRef.current = next.viewMode;
    }
    setCoverOffset(next.coverOffset ?? false);
    if (typeof next.trimMargins === 'boolean') {
      setTrimMargins(next.trimMargins);
    }
  }, [resourcePath]);

  // 视图状态变化即落盘（scale 仅在 custom 模式持久化，fit 模式随窗口重算不算变化）。
  // 首次运行只建立基线，避免每次打开文档都把默认值写进 localStorage。
  useEffect(() => {
    if (!resourcePath) return;
    const dualAvailable = !isSmallViewport && !isCoarsePointer;
    if (dualAvailable) viewModeForPersistRef.current = viewMode;
    const payload: PdfViewState = {
      zoomMode,
      ...(zoomMode === 'custom' ? { scale } : {}),
      viewMode: viewModeForPersistRef.current,
      coverOffset,
      trimMargins,
    };
    const json = JSON.stringify(payload);
    if (lastSavedViewStateRef.current === null) {
      lastSavedViewStateRef.current = json;
      return;
    }
    if (json === lastSavedViewStateRef.current) return;
    lastSavedViewStateRef.current = json;
    savePdfViewState(resourcePath, payload);
  }, [resourcePath, zoomMode, scale, viewMode, coverOffset, trimMargins, isSmallViewport, isCoarsePointer]);

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
          const previousPage = currentPageRef.current;
          if (targetPage !== previousPage && previousPage >= 1) {
            setJumpHistory((prev) => {
              const next = recordReadingJump(prev, previousPage, targetPage, { force: true });
              jumpHistoryRef.current = next;
              return next;
            });
            currentPageRef.current = targetPage;
          }
          setCurrentPage(targetPage);
          onPageChangeRef.current?.(targetPage - 1);
          scrollToPageRef.current?.(targetPage);
          flashAgentFocusPage(targetPage);
        }
      });
    }
  }, [onRegisterCommands, flashAgentFocusPage]);

  // 监听容器尺寸
  // ★ 移动端审计：不再写死 -48/-32（视口 padding 在 ≤640 收窄为 8px，
  // 固定扣减在 360px 屏浪费 32px 正文宽度），改读 computed padding。
  useEffect(() => {
    const container = pageContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      const styles = window.getComputedStyle(container);
      const padX =
        (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      const padY =
        (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
      const fullWidth = container.clientWidth;
      setViewportFullWidth((prev) => (fullWidth > 0 ? fullWidth : prev));
      const width = fullWidth - padX;
      if (width > 0 && width !== lastViewportWidthRef.current) {
        if (lastViewportWidthRef.current > 0) captureResizeAnchorRef.current?.();
        lastViewportWidthRef.current = width;
        setContainerWidth(width);
      }
      const height = container.clientHeight - padY;
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
      const fromPage = currentPageRef.current;
      if (targetPage !== fromPage) {
        setJumpHistory((prev) =>
          recordReadingJump(prev, fromPage, targetPage, { force: true, label: item.title }),
        );
      }
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

  const fileIdForOcr = resourceIdFromDstuPath(resourcePath);
  const ocrStage = usePdfProcessingStore(state => fileIdForOcr ? state.statusMap.get(fileIdForOcr)?.stage : undefined);
  const ocrReady = usePdfProcessingStore(state => fileIdForOcr
    ? state.statusMap.get(fileIdForOcr)?.readyModes.includes('ocr') : false);
  const [ocrCache, setOcrCache] = useState<{ path: string; pages: ReadonlyMap<number, string> }>();
  const ocrPages = ocrCache?.path === resourcePath ? ocrCache?.pages : undefined;
  useEffect(() => {
    if (!resourcePath) return;
    let disposed = false;
    void dstu.get(resourcePath).then(result => {
      if (!disposed && result.ok) {
        setOcrCache({ path: resourcePath, pages: readPdfOcrText(result.value.metadata?.ocrPagesJson) });
      }
    });
    return () => { disposed = true; };
  }, [resourcePath, ocrReady, ocrStage]);

  const [startingOcr, setStartingOcr] = useState(false);
  const runDocumentOcr = useCallback(async () => {
    if (!fileIdForOcr) return;
    setShowMoreMenu(false);
    setStartingOcr(true);
    try {
      await startPdfProcessing(fileIdForOcr);
      showGlobalNotification('info', t('pdf:toolbar.ocr_started'));
    } catch (error) {
      console.error('[EnhancedPdfViewer] PDF OCR could not start:', error);
      showGlobalNotification('error', t('pdf:toolbar.ocr_failed'));
    } finally {
      setStartingOcr(false);
    }
  }, [fileIdForOcr, t]);

  const abortSearchTask = useCallback(() => {
    if (searchTaskRef.current) {
      searchTaskRef.current.cancelled = true;
    }
    if (searchIdleHandleRef.current !== null) {
      cancelIdle(searchIdleHandleRef.current);
      searchIdleHandleRef.current = null;
    }
  }, [cancelIdle]);

  // 搜索功能（增量展示）
  // ★ 页内匹配逻辑抽到 ../pdfSearch（保留 item 边界拼接语义，见该模块注释）。
  // ★ 增量发布：每扫完一个分块就把已有命中发布出去——首个命中立即跳转、
  // 计数实时增长，大文档不再"只转圈到全部扫完才出结果"。
  // rangesByPage 外层 Map 浅克隆即可发布：每页只在自己所属分块内被写入一次，
  // 已发布页的内层 Map 之后不会再被修改。
  const handleSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    abortSearchTask();
    if (!pdfDocRef.current || !query) {
      setSearchResults([]);
      setSearchRangesByPage(new Map());
      setCurrentSearchIndex(0);
      setIsSearching(false);
      setSearchProgress(null);
      return;
    }

    const task = { id: Date.now(), cancelled: false };
    searchTaskRef.current = task;
    setIsSearching(true);
    setSearchResults([]);
    setSearchRangesByPage(new Map());
    setCurrentSearchIndex(0);
    setSearchProgress({ scanned: 0, total: numPages });
    const results: SearchMatch[] = [];
    const rangesByPage: SearchRangesByPage = new Map();
    let pageIndex = 1;
    let publishedCount = 0;
    let jumpedToFirst = false;
    const chunkSize = 2;

    const publishPartial = () => {
      setSearchProgress({ scanned: Math.min(pageIndex - 1, numPages), total: numPages });
      if (results.length === publishedCount) return;
      publishedCount = results.length;
      setSearchResults(results.slice());
      setSearchRangesByPage(new Map(rangesByPage));
      if (!jumpedToFirst && results.length > 0) {
        jumpedToFirst = true;
        const firstResult = results[0];
        if (firstResult.pageIndex !== currentPageRef.current) {
          setJumpHistory((prev) => {
            const next = recordReadingJump(prev, currentPageRef.current, firstResult.pageIndex, {
              force: true,
            });
            jumpHistoryRef.current = next;
            return next;
          });
        }
        currentPageRef.current = firstResult.pageIndex;
        setCurrentPage(firstResult.pageIndex);
        onPageChange?.(firstResult.pageIndex - 1);
        scrollToPageRef.current?.(firstResult.pageIndex);
      }
    };

    const runChunk = async () => {
      if (!pdfDocRef.current || task.cancelled) return;
      const end = Math.min(pageIndex + chunkSize - 1, numPages);

      try {
        for (; pageIndex <= end; pageIndex++) {
          if (task.cancelled || !pdfDocRef.current) return;
          const page = await pdfDocRef.current.getPage(pageIndex);
          const textContent = await page.getTextContent();
          const items = textContent.items as Array<{ str?: string; hasEOL?: boolean }>;
          const cachedOcr = ocrPages?.get(pageIndex);
          const useOcr = Boolean(cachedOcr) && !items.some(item => item.str?.trim());
          const { matchCount, itemRanges } = collectPageSearchMatches(
            useOcr ? [{ str: cachedOcr }] : items, query,
          );
          if (matchCount > 0) {
            if (!useOcr) rangesByPage.set(pageIndex, itemRanges);
            for (let ordinal = 0; ordinal < matchCount; ordinal++) {
              results.push({ pageIndex, matchIndex: ordinal });
            }
          }
        }
      } catch (err) {
        if (!task.cancelled) {
          console.error('Search failed:', err);
          setIsSearching(false);
          setSearchProgress(null);
        }
        return;
      }

      if (task.cancelled) return;

      if (pageIndex <= numPages) {
        publishPartial();
        searchIdleHandleRef.current = scheduleIdle(() => {
          void runChunk();
        });
        return;
      }

      publishPartial();
      setIsSearching(false);
      setSearchProgress(null);
    };

    void runChunk();
  }, [abortSearchTask, numPages, ocrPages, onPageChange, scheduleIdle, searchQuery]);

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
      setSearchProgress(null);
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
    if (result.pageIndex !== currentPageRef.current) {
      setJumpHistory((prev) => {
        const next = recordReadingJump(prev, currentPageRef.current, result.pageIndex, {
          force: true,
        });
        jumpHistoryRef.current = next;
        return next;
      });
    }
    currentPageRef.current = result.pageIndex;
    setCurrentPage(result.pageIndex);
    onPageChange?.(result.pageIndex - 1);
    scrollToPageRef.current?.(result.pageIndex);
  }, [searchResults, currentSearchIndex, onPageChange]);

  const handleNextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const newIndex = currentSearchIndex < searchResults.length - 1 ? currentSearchIndex + 1 : 0;
    setCurrentSearchIndex(newIndex);
    const result = searchResults[newIndex];
    if (result.pageIndex !== currentPageRef.current) {
      setJumpHistory((prev) => {
        const next = recordReadingJump(prev, currentPageRef.current, result.pageIndex, {
          force: true,
        });
        jumpHistoryRef.current = next;
        return next;
      });
    }
    currentPageRef.current = result.pageIndex;
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
    setSearchProgress(null);
  }, [abortSearchTask]);

  // 页内搜索高亮：把命中子区间包成 <mark>，当前命中加强调样式。
  // 返回值作为文本层 innerHTML 注入，原文必须转义。
  const searchHighlightActive = showSearch && searchRangesByPage.size > 0;
  const currentSearchMatch = searchResults[currentSearchIndex];
  const searchTextRenderer = useCallback(
    (props: { pageNumber: number; itemIndex: number; str: string }) => {
      // 与 collectPageSearchMatches 同一份还原后的字符串，命中偏移才对得上
      const str = normalizePdfLigatures(props.str);
      const ranges = searchRangesByPage.get(props.pageNumber)?.get(props.itemIndex);
      if (!ranges || ranges.length === 0) return escapeHtml(str);
      let html = '';
      let cursor = 0;
      for (const range of ranges) {
        // 重叠命中（如 "aa" 在 "aaa" 中）只渲染未覆盖部分
        const start = Math.max(range.start, cursor);
        if (range.end <= cursor) continue;
        if (start > cursor) html += escapeHtml(str.slice(cursor, start));
        const isCurrent =
          currentSearchMatch !== undefined &&
          currentSearchMatch.pageIndex === props.pageNumber &&
          currentSearchMatch.matchIndex === range.matchOrdinal;
        html += `<mark class="ds-search-mark${isCurrent ? ' ds-search-mark--current' : ''}">${escapeHtml(str.slice(start, range.end))}</mark>`;
        cursor = range.end;
      }
      html += escapeHtml(str.slice(cursor));
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
  // （高亮菜单/更多菜单/缩放菜单/侧栏[目录·缩略图·书签·批注]/搜索栏），
  // 而不是直接退出视图。轻量菜单优先关闭（视觉上位于最上层）。
  // 仅在有浮层打开时注册；桌面端不触发 handleAndroidBack，无行为变化。
  useEffect(() => {
    const hasOverlay =
      showHighlightMenu || activeHighlightId !== null || refPreviewCard !== null ||
      showPaperGuideMenu || showMoreMenu || showZoomMenu ||
      sidebarMode !== 'none' || showSearch;
    if (!hasOverlay) return;
    return registerVisibilityGuardedBackHandler(containerRef, () => {
      if (selectionTranslation) {
        setSelectionTranslation(null);
        return true;
      }
      if (refPreviewCard !== null) {
        setRefPreviewCard(null);
        return true;
      }
      if (showHighlightMenu) {
        setShowHighlightMenu(false);
        return true;
      }
      if (activeHighlightId !== null) {
        setActiveHighlightId(null);
        setActiveHighlightAnchor(null);
        return true;
      }
      if (showPaperGuideMenu) {
        setShowPaperGuideMenu(false);
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
    activeHighlightId,
    refPreviewCard,
    showPaperGuideMenu,
    showMoreMenu,
    showZoomMenu,
    sidebarMode,
    showSearch,
    handleCloseSearch,
  ]);

  // 文本选择处理（用于高亮批注 / 划词动作）
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
    
    const rawText = selection.toString().trim();
    const text = normalizePdfAcademicText(rawText) || rawText;
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
    
    // ★ 2026-07-08（审计 28-P1-2）：按页面实际渲染宽高归一化为 0–1 相对坐标。
    // 旧做法只除以 scale，实际基准是"捕获瞬间的容器像素宽度"，
    // 窗口缩放/侧边栏开合/单双页切换后已存高亮全部错位。
    const rects: { x: number; y: number; width: number; height: number }[] = [];
    const clientRects = range.getClientRects();
    // 旋转状态下选区 rect 是旋转后的屏幕坐标，持久化后恢复原始角度会
    // 双重错位；因此只禁用“创建高亮”，复制仍可使用。
    if (rotation === 0 && pageWrapper) {
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
    
    const snapshot = { text, pageIndex, rects };
    lastSelectionSnapshotRef.current = snapshot;
    setPendingHighlight(snapshot);
    setHighlightMenuPos({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    setShowHighlightMenu(true);
  }, [currentPage, rotation]);

  // 翻译/出题/制卡等学习动作不在此处：统一由共享层 SelectionToolbar
  // （PdfSelectionActions）承载，避免与 viewer 内建划词菜单双入口重复。

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
  }, [pendingHighlight, setHighlights]);

  // 高亮并立即打开页面内批注笔记编辑器（快捷键 N）
  const addHighlightWithNote = useCallback(
    (color: string = HIGHLIGHT_COLORS.yellow) => {
      if (!canPersistAnnotations || rotation !== 0) return;
      if (!pendingHighlight || pendingHighlight.rects.length === 0) return;
      const id = `hl-${crypto.randomUUID()}`;
      const newHighlight: Highlight = {
        id,
        pageIndex: pendingHighlight.pageIndex,
        text: pendingHighlight.text,
        color,
        rects: pendingHighlight.rects,
        createdAt: Date.now(),
        coordVersion: 2,
      };
      const anchor = highlightMenuPos;
      setHighlights((prev) => [...prev, newHighlight]);
      setShowHighlightMenu(false);
      setPendingHighlight(null);
      window.getSelection()?.removeAllRanges();
      setActiveHighlightId(id);
      setActiveHighlightAnchor(isCoarsePointer ? null : anchor);
      setEditingHighlightNoteId(id);
      setHighlightNoteDraft('');
    },
    [canPersistAnnotations, rotation, pendingHighlight, highlightMenuPos, isCoarsePointer, setHighlights],
  );

  // 划词动作统一收尾：关菜单 + 清选区 + 将焦点归还给阅读器（避免按钮卸载后焦点掉回 body 导致 Alt+← 失效）
  const closeSelectionMenu = useCallback(() => {
    setShowHighlightMenu(false);
    setPendingHighlight(null);
    window.getSelection()?.removeAllRanges();
    requestAnimationFrame(() => {
      const root = containerRef.current;
      if (
        root &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          !root.contains(document.activeElement))
      ) {
        root.focus({ preventScroll: true });
      }
    });
  }, []);

  // 划词：复制原文（已自动消去 PDF 跨行断词与硬换行）
  const handleCopySelection = useCallback(() => {
    if (!pendingHighlight) return;
    const text = pendingHighlight.text;
    closeSelectionMenu();
    void copyTextToClipboard(text).then((ok) => {
      showGlobalNotification(
        ok ? 'success' : 'error',
        ok ? t('pdf:selection.copied') : t('pdf:selection.copy_failed')
      );
    });
  }, [pendingHighlight, closeSelectionMenu, t]);

  // 划词 / 批注：复制学术引文 `"..." (Title, p. N)`（快捷键 C）
  const handleCopyCitation = useCallback(
    (override?: { text: string; pageIndex: number }) => {
      const target = override ?? pendingHighlight;
      if (!target) return;
      const citation = formatAcademicCitation({
        text: target.text,
        documentTitle: fileName,
        page: target.pageIndex,
        sourceId: selectionSourceId ?? resourceIdFromDstuPath(resourcePath),
        style: 'inline',
      });
      if (!override) {
        closeSelectionMenu();
      }
      void copyTextToClipboard(citation).then((ok) => {
        showGlobalNotification(
          ok ? 'success' : 'error',
          ok ? t('pdf:selection.citation_copied') : t('pdf:selection.copy_failed'),
        );
      });
    },
    [pendingHighlight, fileName, selectionSourceId, resourcePath, closeSelectionMenu, t],
  );

  const detectedSelectionRef = useMemo(
    () => (pendingHighlight ? detectAcademicReference(pendingHighlight.text) : null),
    [pendingHighlight],
  );

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
    setActiveHighlightId(prev => (prev === id ? null : prev));
    setActiveHighlightAnchor(null);
    setEditingHighlightNoteId(prev => (prev === id ? null : prev));
  }, [setHighlights]);

  // 修改已存在高亮的颜色（点击高亮块弹出的操作层入口）
  const updateHighlightColor = useCallback((id: string, color: string) => {
    setHighlights(prev => prev.map(h => (h.id === id ? { ...h, color } : h)));
  }, [setHighlights]);

  // 新增 / 编辑批注笔记文本（侧栏面板与页内高亮浮层共用）
  const updateHighlightComment = useCallback(
    (id: string, comment: string) => {
      const normalized = comment.trim();
      setHighlights((prev) =>
        prev.map((h) =>
          h.id === id
            ? {
                ...h,
                comment: normalized || undefined,
                updatedAt: Date.now(),
              }
            : h,
        ),
      );
      setEditingHighlightNoteId((prev) => (prev === id ? null : prev));
    },
    [setHighlights],
  );

  // 将划词翻译 / AI 学术精读结果一键钉入当前选区对应的高亮批注：
  // 若该页已有同文高亮则追加/更新其批注；若尚未高亮则利用选区坐标快照自动补建黄色高亮并写入批注。
  const handlePinToAnnotation = useCallback(
    (payload: { sourceText: string; noteText: string; page?: number }) => {
      if (!canPersistAnnotations) return;
      const cleanNote = payload.noteText.trim();
      if (!cleanNote) return;
      const snapshot = lastSelectionSnapshotRef.current;
      const targetPage = payload.page ?? snapshot?.pageIndex ?? currentPageRef.current;
      const cleanSource = normalizePdfAcademicText(payload.sourceText) || payload.sourceText.trim();

      const existingIdx = highlights.findIndex(
        (h) =>
          h.pageIndex === targetPage &&
          (normalizePdfAcademicText(h.text) === cleanSource || h.text.trim() === cleanSource),
      );

      if (existingIdx >= 0) {
        const now = Date.now();
        setHighlights((prev) =>
          prev.map((h, idx) => {
            if (idx !== existingIdx) return h;
            const mergedComment =
              h.comment?.trim() && !h.comment.includes(cleanNote)
                ? `${h.comment.trim()}\n\n${cleanNote}`
                : cleanNote;
            return { ...h, comment: mergedComment, updatedAt: now };
          }),
        );
        showGlobalNotification('success', t('pdf:annotations.pinned_to_annotation'));
        return;
      }

      const snapshotMatches =
        snapshot !== null &&
        snapshot.rects.length > 0 &&
        snapshot.pageIndex === targetPage &&
        (normalizePdfAcademicText(snapshot.text) === cleanSource ||
          snapshot.text.trim() === cleanSource);

      if (snapshotMatches && rotation === 0) {
        const now = Date.now();
        const created: Highlight = {
          id: `hl-${crypto.randomUUID()}`,
          pageIndex: snapshot.pageIndex,
          text: cleanSource || snapshot.text,
          color: HIGHLIGHT_COLORS.yellow,
          rects: snapshot.rects,
          createdAt: now,
          updatedAt: now,
          coordVersion: 2,
          comment: cleanNote,
        };
        setHighlights((prev) => [...prev, created]);
        showGlobalNotification('success', t('pdf:annotations.pinned_to_annotation'));
      }
    },
    [canPersistAnnotations, highlights, rotation, setHighlights, t],
  );

  // 翻页或缩放变化时收起旧选区的高亮浮动菜单与引用预览卡片，避免悬停在过期坐标上
  useEffect(() => {
    setShowHighlightMenu(false);
    setRefPreviewCard(null);
  }, [currentPage, scale]);

  const activeHighlight = useMemo(
    () => (activeHighlightId ? highlights.find(h => h.id === activeHighlightId) ?? null : null),
    [activeHighlightId, highlights]
  );

  // 浮动菜单的视口钳位（贴顶时翻转到锚点下方，水平方向夹在视口内）
  const selectionMenu = useClampedMenuFrame(
    showHighlightMenu && !isMobileLike ? highlightMenuPos : null
  );
  const highlightActionMenu = useClampedMenuFrame(
    activeHighlight && activeHighlightAnchor ? activeHighlightAnchor : null
  );
  const refPreviewMenu = useClampedMenuFrame(
    refPreviewCard && !isMobileLike ? refPreviewCard.anchor : null
  );

  // 点按外部区域关闭引用就地预览卡
  useEventRegistry(
    refPreviewCard
      ? [
          {
            target: 'document',
            type: 'pointerdown',
            listener: (e) => {
              const target = (e as PointerEvent).target as Element | null;
              if (
                target?.closest(
                  '.ds-pdf__ref-preview-card, .ds-highlight-menu, .ds-pdf__highlight-bar',
                )
              ) {
                return;
              }
              setRefPreviewCard(null);
            },
          },
        ]
      : [],
    [refPreviewCard],
  );

  // 点按其他区域关闭高亮操作条/浮层（操作条自身与高亮块内不关闭）
  useEffect(() => {
    if (!activeHighlightId) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('.ds-pdf__highlight-bar, .ds-pdf__highlight-rect, .ds-highlight-menu')) return;
      setActiveHighlightId(null);
      setActiveHighlightAnchor(null);
      setEditingHighlightNoteId(null);
    };
    const timer = window.setTimeout(
      () => document.addEventListener('pointerdown', handlePointerDown),
      100
    );
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [activeHighlightId]);

  // ========== 书签操作函数 ==========
  
  // 同步外部书签数据
  useEffect(() => {
    if (externalBookmarks === undefined) return;
    // Don't clobber an in-progress rename with a stale parent snapshot.
    if (editingBookmarkId) return;
    setBookmarks(externalBookmarks);
  }, [externalBookmarks, editingBookmarkId]);
  
  // 检查当前页是否有书签
  const currentPageBookmark = useMemo(() => {
    return bookmarks.find(b => b.page === currentPage);
  }, [bookmarks, currentPage]);
  
  // 按页码排序的书签列表
  const sortedBookmarks = useMemo(() => {
    return [...bookmarks].sort((a, b) => a.page - b.page);
  }, [bookmarks]);
  
  // 添加书签（编辑入口在侧栏书签 tab 内）
  const addBookmark = useCallback(() => {
    // 检查当前页是否已有书签
    if (currentPageBookmark) {
      // 已有书签，跳转到编辑模式
      setEditingBookmarkId(currentPageBookmark.id);
      setEditingBookmarkTitle(currentPageBookmark.title);
      setSidebarMode('bookmarks');
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
    setSidebarMode('bookmarks');
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
    setBookmarks((prev) => {
      const next = prev.map((b) =>
        b.id === id ? { ...b, title: newTitle.trim() || b.title } : b,
      );
      // Notify parent after this updater returns so persist sees the renamed title.
      Promise.resolve().then(() => onBookmarksChange?.(next));
      return next;
    });
    setEditingBookmarkId(null);
    setEditingBookmarkTitle('');
  }, [onBookmarksChange]);
  
  // 页面导航（提前定义，供 goToBookmark / 引用定位 / 内部链接使用）
  const goToPage = useCallback(
    (
      page: number,
      jumpOptions?: { recordJump?: boolean; forceJump?: boolean; label?: string },
    ) => {
      const totalPages = numPages || numPagesRef.current;
      if (totalPages <= 0) return;
      const targetPage = Math.max(1, Math.min(page, totalPages));
      const fromPage = currentPageRef.current;
      if (targetPage !== fromPage) {
        if (jumpOptions?.recordJump !== false) {
          const minDelta = viewModeRef.current === 'dual' ? 3 : 2;
          setJumpHistory((prev) => {
            const next = recordReadingJump(prev, fromPage, targetPage, {
              force: jumpOptions?.forceJump,
              label: jumpOptions?.label,
              minDelta,
            });
            jumpHistoryRef.current = next;
            return next;
          });
        }
        currentPageRef.current = targetPage;
        setCurrentPage(targetPage);
        onPageChange?.(targetPage - 1);
        scrollToPageRef.current?.(targetPage);
      }
    },
    [numPages, onPageChange],
  );
  const goToPageRef = useRef(goToPage);
  goToPageRef.current = goToPage;

  // 阅读位置跳回 / 前进（Alt+← / Alt+→ 或顶部悬浮胶囊点击）
  const handleJumpBack = useCallback(() => {
    const { targetPage, nextState } = navigateJumpBack(
      jumpHistoryRef.current,
      currentPageRef.current,
    );
    jumpHistoryRef.current = nextState;
    setJumpHistory(nextState);
    if (targetPage !== null && numPagesRef.current > 0) {
      const clamped = Math.max(1, Math.min(targetPage, numPagesRef.current));
      currentPageRef.current = clamped;
      setCurrentPage(clamped);
      onPageChangeRef.current?.(clamped - 1);
      scrollToPageRef.current?.(clamped);
    }
  }, []);

  const handleJumpForward = useCallback(() => {
    const { targetPage, nextState } = navigateJumpForward(
      jumpHistoryRef.current,
      currentPageRef.current,
    );
    jumpHistoryRef.current = nextState;
    setJumpHistory(nextState);
    if (targetPage !== null && numPagesRef.current > 0) {
      const clamped = Math.max(1, Math.min(targetPage, numPagesRef.current));
      currentPageRef.current = clamped;
      setCurrentPage(clamped);
      onPageChangeRef.current?.(clamped - 1);
      scrollToPageRef.current?.(clamped);
    }
  }, []);

  // PDF 原生批注层内部链接跳转（如点击论文内 [12]、Section 3、Fig. 4 超链接）。
  // ★ 注意：react-pdf 的 `<Document>` 将 `viewer.scrollPageIntoView` 缓存在首次挂载的 `useRef` 中，
  // 永远调用首帧传入的 `onItemClick` 闭包（当时 `numPages === 0`）！必须经 `goToPageRef.current` 转发。
  const handlePdfInternalLinkClick = useCallback(
    ({ pageNumber }: { pageNumber: number }) => {
      if (typeof pageNumber === 'number' && pageNumber >= 1) {
        goToPageRef.current(pageNumber, { forceJump: true });
        requestAnimationFrame(() => {
          containerRef.current?.focus({ preventScroll: true });
        });
      }
    },
    [],
  );

  // 划选文内引用（如无超链接的 [12] / Fig. 3 / Table 2 / Eq. (4)）一键定位到目标页
  const handleLocateAcademicRef = useCallback(async () => {
    if (!detectedSelectionRef || !pdfDocRef.current || isLocatingRef) return;
    const ref = detectedSelectionRef;
    const doc = pdfDocRef.current;
    const token = ++locateRefTokenRef.current;
    closeSelectionMenu();
    setIsLocatingRef(true);
    try {
      const targetPage = await locateAcademicReferencePage({
        numPages,
        currentPage: currentPageRef.current,
        ref,
        getPageText: async (pageNumber) => {
          if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) {
            throw new Error('aborted');
          }
          const page = await doc.getPage(pageNumber);
          if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) {
            throw new Error('aborted');
          }
          const content = await page.getTextContent();
          const parts: string[] = [];
          for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
            if (typeof item.str === 'string') {
              parts.push(normalizePdfLigatures(item.str));
            }
            if (item.hasEOL) {
              parts.push('\n');
            }
          }
          return parts.join('');
        },
      });
      if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) return;
      if (targetPage !== null) {
        goToPage(targetPage, { forceJump: true, label: ref.displayLabel });
        showGlobalNotification(
          'success',
          t('pdf:selection.ref_located', { label: ref.displayLabel, page: targetPage }),
        );
      } else {
        showGlobalNotification(
          'info',
          t('pdf:selection.ref_not_found', { label: ref.displayLabel }),
        );
      }
    } catch {
      if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) return;
      showGlobalNotification(
        'error',
        t('pdf:selection.ref_not_found', { label: ref.displayLabel }),
      );
    } finally {
      if (token === locateRefTokenRef.current) {
        setIsLocatingRef(false);
      }
    }
  }, [detectedSelectionRef, isLocatingRef, closeSelectionMenu, numPages, goToPage, t]);

  // 划选文内引用就地预览卡片（Zotero 7 / ReadCube 风格：不跳离当前页，先展示文献题录/图注/公式摘要）
  const handlePreviewAcademicRef = useCallback(async () => {
    if (!detectedSelectionRef || !pdfDocRef.current || isLocatingRef) return;
    const ref = detectedSelectionRef;
    const anchorSnapshot: SelectionMenuAnchor = { ...highlightMenuPos };
    const doc = pdfDocRef.current;
    const token = ++locateRefTokenRef.current;
    closeSelectionMenu();
    setIsLocatingRef(true);
    try {
      const preview = await previewAcademicReference({
        numPages,
        currentPage: currentPageRef.current,
        ref,
        getPageText: async (pageNumber) => {
          if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) {
            throw new Error('aborted');
          }
          const cached = pageTextCacheRef.current.get(pageNumber);
          if (cached !== undefined) return cached;
          const page = await doc.getPage(pageNumber);
          if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) {
            throw new Error('aborted');
          }
          const content = await page.getTextContent();
          const parts: string[] = [];
          for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
            if (typeof item.str === 'string') {
              parts.push(normalizePdfLigatures(item.str));
            }
            if (item.hasEOL) {
              parts.push('\n');
            }
          }
          return parts.join('');
        },
      });
      if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) return;
      if (preview) {
        setRefPreviewCard({
          preview,
          anchor: isMobileLike ? null : anchorSnapshot,
        });
      } else {
        showGlobalNotification(
          'info',
          t('pdf:selection.ref_not_found', { label: ref.displayLabel }),
        );
      }
    } catch {
      if (token !== locateRefTokenRef.current || pdfDocRef.current !== doc) return;
      showGlobalNotification(
        'error',
        t('pdf:selection.ref_not_found', { label: ref.displayLabel }),
      );
    } finally {
      if (token === locateRefTokenRef.current) {
        setIsLocatingRef(false);
      }
    }
  }, [
    detectedSelectionRef,
    isLocatingRef,
    highlightMenuPos,
    closeSelectionMenu,
    numPages,
    isMobileLike,
    t,
  ]);

  // 画中画钉图对照（Sioyek Portal 风格）
  const handlePinRegion = useCallback((payload: PinRegionPayload) => {
    const container = containerRef.current;
    const defaultX = container ? Math.max(12, container.clientWidth - 264) : 24;
    setPinnedRegions((prev) => {
      const nextUrl = URL.createObjectURL(payload.blob);
      const offsetIdx = prev.length % 4;
      const newEntry: PinnedPdfRegion = {
        id: `pin-${crypto.randomUUID()}`,
        page: payload.page,
        title: payload.title,
        blob: payload.blob,
        imageUrl: nextUrl,
        x: Math.max(12, defaultX - offsetIdx * 14),
        y: 16 + offsetIdx * 36,
        expanded: false,
        collapsed: false,
      };
      if (prev.length >= 4) {
        const [oldest, ...rest] = prev;
        if (oldest) URL.revokeObjectURL(oldest.imageUrl);
        return [...rest, newEntry];
      }
      return [...prev, newEntry];
    });
  }, []);

  const handleUpdatePinnedRegion = useCallback(
    (id: string, patch: Partial<PinnedPdfRegion>) => {
      setPinnedRegions((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const handleRemovePinnedRegion = useCallback((id: string) => {
    setPinnedRegions((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.imageUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const exportAnnotatedCopy = useCallback(async () => {
    const document = pdfDocRef.current;
    if (!document || highlights.length === 0) return;
    setShowMoreMenu(false);
    try {
      const [{ createAnnotatedPdf }, { fileManager }] = await Promise.all([
        import('../pdfAnnotatedExport'),
        import('@/utils/fileManager'),
      ]);
      const data = await createAnnotatedPdf(document, highlights);
      const title = t('pdf:annotations.export_pdf');
      const result = await fileManager.saveBinaryFile({
        data, title,
        defaultFileName: `${fileName?.replace(/\.pdf$/i, '') || 'PDF'}-annotated.pdf`,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!result.canceled) showGlobalNotification('success', t('pdf:annotations.export_pdf_success'));
    } catch (error) {
      console.error('[EnhancedPdfViewer] Annotated PDF export failed:', error);
      showGlobalNotification('error', t('pdf:annotations.export_pdf_failed'));
    }
  }, [fileName, highlights, t]);

  // 从当前打开的 PDFDocumentProxy 按页抽取归一化后的学术文本（带页级内存缓存）
  const extractPdfPageAcademicText = useCallback(async (pageNumber: number): Promise<string> => {
    const cached = pageTextCacheRef.current.get(pageNumber);
    if (cached) return cached;
    const ocrText = ocrPages?.get(pageNumber);
    if (cached !== undefined) return ocrText ?? cached;
    const doc = pdfDocRef.current;
    if (!doc || pageNumber < 1 || pageNumber > numPagesRef.current) return '';
    try {
      const page = await doc.getPage(pageNumber);
      if (pdfDocRef.current !== doc) return '';
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str === 'string') {
          parts.push(normalizePdfLigatures(item.str));
        }
        if (item.hasEOL) {
          parts.push('\n');
        }
      }
      const normalized = normalizePdfAcademicText(parts.join(''));
      if (pdfDocRef.current === doc) {
        pageTextCacheRef.current.set(pageNumber, normalized);
      }
      return normalized || ocrText || '';
    } catch {
      return ocrText || '';
    }
  }, [ocrPages]);

  // 当用户勾选「选择此页」（selectedPages）时，自动从 pdfDocRef 抽取所选页的正文并广播给 Chat InputBar，
  // 确保用户在输入框提问时模型能直接读到所选页面的完整文本，而非仅有空标签。
  useEffect(() => {
    if (!selectedPages || selectedPages.size === 0 || numPages <= 0 || !pdfDocRef.current) return;
    let cancelled = false;
    const doc = pdfDocRef.current;
    const effectiveSourceId = selectionSourceId ?? resourceIdFromDstuPath(resourcePath) ?? '';
    const pages = Array.from(selectedPages)
      .filter((p) => Number.isInteger(p) && p >= 1 && p <= numPages)
      .sort((a, b) => a - b);
    if (pages.length === 0) return;

    void (async () => {
      const pageTexts: Array<{ page: number; text: string }> = [];
      for (const p of pages) {
        if (cancelled || pdfDocRef.current !== doc) return;
        const text = await extractPdfPageAcademicText(p);
        if (text) {
          pageTexts.push({ page: p, text });
        }
      }
      if (cancelled || pdfDocRef.current !== doc || pageTexts.length === 0) return;
      document.dispatchEvent(
        new CustomEvent('pdf-page-refs:content', {
          detail: {
            sourceId: effectiveSourceId,
            sourceName: fileName || '',
            numPages,
            pageTexts,
          },
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedPages, numPages, selectionSourceId, resourcePath, fileName, extractPdfPageAcademicText]);

  // AI 论文导读快捷动作：自动提取论文目录大纲（TOC）+ 目标章节/页面正文快照注入上下文，并将精读指令预填入对话输入框
  const handlePaperGuideAction = useCallback(
    async (mode: PaperGuideReadingMode, attachOnly = false) => {
      setShowPaperGuideMenu(false);
      setShowMoreMenu(false);
      const readableTitle = cleanAcademicDocumentTitle(fileName) || fileName || t('pdf:title');
      const effectiveSourceId = selectionSourceId ?? resourceIdFromDstuPath(resourcePath);
      const prompt = t(`pdf:paperGuide.prompt_${mode}`, { name: readableTitle, page: currentPage });
      const doc = pdfDocRef.current;
      if (!doc) return;
      const targetPages = resolvePaperGuideTargetPages({
        mode, numPages, currentPage, selectedPages, outline, outlinePages,
      });

      const pageTexts: Array<{ page: number; text: string }> = [];
      for (const page of targetPages) {
        const text = await extractPdfPageAcademicText(page);
        if (pdfDocRef.current !== doc) return;
        if (text) pageTexts.push({ page, text });
      }
      if (!pageTexts.length) {
        showGlobalNotification('warning', t('pdf:paperGuide.no_text'));
        return;
      }

      const { selectionToChat } = await import('@/features/chat/context/selectionRef');
      const snapshot = buildPaperReadingContextSnapshot({
        title: readableTitle, sourceId: effectiveSourceId, numPages, currentPage, mode,
        outlineText: formatPdfOutlineForAgent(outline, outlinePages), pageTexts,
      });
      const result = await selectionToChat({
        text: snapshot,
        source: {
          kind: 'pdf', sourceId: effectiveSourceId ?? undefined,
          locator: buildSelectedPagesLocator(pageTexts.map(item => item.page), currentPage),
          title: fileName || readableTitle,
        },
        silent: !attachOnly,
      });
      if (result.success && !attachOnly) {
        sendSelectionToChatInput({ text: prompt, sourceName: fileName || readableTitle, page: currentPage });
      }
    },
    [fileName, currentPage, numPages, selectedPages, outline, outlinePages,
      selectionSourceId, resourcePath, extractPdfPageAcademicText, t],
  );

  // 跳转到书签页面（桌面侧栏保持打开便于连续跳转；移动端由调用处关闭子屏）
  const goToBookmark = useCallback((bookmark: Bookmark) => {
    goToPage(bookmark.page, { forceJump: true, label: bookmark.title });
  }, [goToPage]);

  // ========== 批注列表精确定位（r5-S1，对标 Zotero「Show on Page」） ==========
  // 点击批注项不再只 goToPage：跳页后轮询等待目标高亮块渲染
  // （页面虚拟化 + 高亮层随页挂载，滚动到位前元素不存在），
  // 找到后把首个矩形滚到视口中部并闪烁（CSS 动画，reduced-motion 有静态降级）。
  const [focusedHighlightId, setFocusedHighlightId] = useState<string | null>(null);
  const highlightFocusPollTimerRef = useRef<number | null>(null);
  const highlightFocusFadeTimerRef = useRef<number | null>(null);
  const clearHighlightFocusTimers = useCallback(() => {
    if (highlightFocusPollTimerRef.current !== null) {
      window.clearTimeout(highlightFocusPollTimerRef.current);
      highlightFocusPollTimerRef.current = null;
    }
    if (highlightFocusFadeTimerRef.current !== null) {
      window.clearTimeout(highlightFocusFadeTimerRef.current);
      highlightFocusFadeTimerRef.current = null;
    }
  }, []);
  useEffect(() => clearHighlightFocusTimers, [clearHighlightFocusTimers]);

  const focusHighlight = useCallback((hl: Pick<Highlight, 'id' | 'pageIndex'>) => {
    clearHighlightFocusTimers();
    setFocusedHighlightId(null);
    goToPage(hl.pageIndex, { forceJump: true });
    const escapedId =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(hl.id)
        : hl.id.replace(/["\\]/g, '\\$&');
    const deadline = Date.now() + 3000;
    const tryLocate = () => {
      highlightFocusPollTimerRef.current = null;
      const layer = pageContainerRef.current?.querySelector(
        `[data-highlight-id="${escapedId}"]`
      );
      const rect = layer?.querySelector('.ds-pdf__highlight-rect');
      if (rect) {
        // 跳页的虚拟列表平滑滚动已把目标页带近，这里再精确到矩形本身
        rect.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFocusedHighlightId(hl.id);
        highlightFocusFadeTimerRef.current = window.setTimeout(() => {
          setFocusedHighlightId(null);
          highlightFocusFadeTimerRef.current = null;
        }, 1600);
        return;
      }
      if (Date.now() < deadline) {
        highlightFocusPollTimerRef.current = window.setTimeout(tryLocate, 120);
      }
      // 超时静默放弃：goToPage 已完成页级跳转，定位闪烁是增强不是承诺
    };
    tryLocate();
  }, [clearHighlightFocusTimers, goToPage]);
  
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
    const readVersion = ++annotationSession.readVersion;

    const loadHighlights = async () => {
      try {
        const result = await dstu.get(resourcePath);
        if (!isMounted || readVersion !== annotationSession.readVersion) return;
        if (!result.ok) {
          console.warn('[EnhancedPdfViewer] 加载高亮批注失败:', result.error);
          return;
        }
        {
          const savedHighlights = result.value.metadata?.highlights;
          const revision = result.value.metadata?.annotationRevision;
          annotationRevisionRef.current =
            typeof revision === 'string' && revision.trim() ? revision : null;
          const normalized = Array.isArray(savedHighlights) ? savedHighlights as Highlight[] : [];
          setHighlights(normalized);
          lastSavedHighlightsRef.current = JSON.stringify(normalized);
        }
        highlightsLoadedRef.current = true;
      } catch (err) {
        console.warn('[EnhancedPdfViewer] 加载高亮批注失败:', err);
      }
    };
    
    void loadHighlights();
    
    return () => {
      isMounted = false;
    };
  }, [resourcePath, initialHighlights, annotationSession, setHighlights, highlightsLoadedRef, lastSavedHighlightsRef, annotationRevisionRef]);

  // Agent/DSTU writes emit a real Tauri event. Reload the shared metadata so
  // every already-open reader converges on the committed annotation revision.
  useEffect(() => {
    if (!resourcePath || initialHighlights !== undefined) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void subscribePdfAnnotationChanges(resourcePath, (payload) => {
      if (pendingSaveRef.current) return;
      const readVersion = ++annotationSession.readVersion;
      void annotationSession.saveQueue.then(() => dstu.get(resourcePath)).then((result) => {
        if (disposed || !result.ok || pendingSaveRef.current ||
          readVersion !== annotationSession.readVersion) return;
        const next = result.value.metadata?.highlights;
        const revision = result.value.metadata?.annotationRevision;
        const normalized = Array.isArray(next) ? next as Highlight[] : [];
        setHighlights(normalized);
        lastSavedHighlightsRef.current = JSON.stringify(normalized);
        highlightsLoadedRef.current = true;
        const nextBookmarks = result.value.metadata?.bookmarks;
        if (Array.isArray(nextBookmarks)) {
          setBookmarks(nextBookmarks as Bookmark[]);
        }
        annotationRevisionRef.current =
          typeof revision === 'string' && revision.trim()
            ? revision
            : payload.updated_at ?? null;
      }).catch(error => {
        console.warn('[EnhancedPdfViewer] 刷新批注失败:', error);
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
  }, [initialHighlights, resourcePath, annotationSession, setHighlights, pendingSaveRef, highlightsLoadedRef, lastSavedHighlightsRef, annotationRevisionRef]);
  
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
    ++annotationSession.readVersion;
    let enqueued = false;
    const doSave = () => {
      if (enqueued) return annotationSession.saveQueue;
      enqueued = true;
      if (pendingSaveRef.current === doSave) {
        highlightsSaveTimerRef.current = null;
        pendingSaveRef.current = null;
      }
      const save = annotationSession.saveQueue.then(async () => {
        try {
          // 先获取当前元数据，保留其他字段
          const getResult = await dstu.get(resourcePath);
          if (!getResult.ok) {
            console.warn('[EnhancedPdfViewer] 获取资源元数据失败，跳过保存高亮:', getResult.error);
            showGlobalNotification('error', t('pdf:annotations.save_failed'));
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
            showGlobalNotification('error', t('pdf:annotations.save_failed'));
            return;
          }
          if (baseline.status === 'reload') {
            if (!annotationSession.disposed && annotationSession.currentHighlights === currentHighlightsJson) {
              setHighlights(baseline.highlights);
              lastSavedHighlightsRef.current = JSON.stringify(baseline.highlights);
              annotationRevisionRef.current = baseline.revision;
            }
            console.warn('[EnhancedPdfViewer] 批注已在其他窗口更新，已加载最新版本');
            // 本地修改被服务端版本覆盖 —— 必须让用户知道，而不是静默回滚
            showGlobalNotification('warning', t('pdf:annotations.remote_updated'));
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
            if (refreshed.ok &&
              JSON.stringify(refreshed.value.metadata?.highlights ?? []) === currentHighlightsJson) {
              const revision = refreshed.value.metadata?.annotationRevision;
              annotationRevisionRef.current =
                typeof revision === 'string' && revision.trim() ? revision : null;
            }
          } else {
            console.warn('[EnhancedPdfViewer] 保存高亮批注失败:', result.error);
            // OCC conflicts and failed writes must not leave an unsaved local
            // view masquerading as committed state. Reload the authoritative
            // annotations and revision so the next user edit has a valid base.
            // 回滚对用户必须可见：弹错误提示而非静默丢弃本地修改。
            showGlobalNotification('error', t('pdf:annotations.save_failed'));
            const current = await dstu.get(resourcePath);
            if (current.ok && !annotationSession.disposed &&
              annotationSession.currentHighlights === currentHighlightsJson) {
              const serverHighlights = current.value.metadata?.highlights;
              const serverRevision = current.value.metadata?.annotationRevision;
              if (Array.isArray(serverHighlights)) {
                const normalized = serverHighlights as Highlight[];
                if (!annotationSession.disposed) setHighlights(normalized);
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
          showGlobalNotification('error', t('pdf:annotations.save_failed'));
          const current = await dstu.get(resourcePath).catch(() => null);
          if (current?.ok && !annotationSession.disposed &&
            annotationSession.currentHighlights === currentHighlightsJson) {
            const serverHighlights = current.value.metadata?.highlights;
            const serverRevision = current.value.metadata?.annotationRevision;
            if (Array.isArray(serverHighlights)) {
              const normalized = serverHighlights as Highlight[];
              if (!annotationSession.disposed) setHighlights(normalized);
              lastSavedHighlightsRef.current = JSON.stringify(normalized);
            }
            annotationRevisionRef.current =
              typeof serverRevision === 'string' && serverRevision.trim()
                ? serverRevision
                : null;
          }
        }
      });
      annotationSession.saveQueue = save.catch(error => {
        console.error('[EnhancedPdfViewer] 高亮保存队列失败:', error);
      });
      return annotationSession.saveQueue;
    };
    pendingSaveRef.current = doSave;
    highlightsSaveTimerRef.current = window.setTimeout(doSave, 2000); // 2秒防抖
    
    return () => {
      if (highlightsSaveTimerRef.current) {
        window.clearTimeout(highlightsSaveTimerRef.current);
        highlightsSaveTimerRef.current = null;
      }
    };
  }, [highlights, resourcePath, onHighlightsChange, t, annotationSession, setHighlights, highlightsLoadedRef, lastSavedHighlightsRef, highlightsSaveTimerRef, pendingSaveRef, annotationRevisionRef]);
  
  // 资源切换或卸载时，将待保存快照留在原资源的队列中。
  useEffect(() => {
    annotationSession.disposed = false;
    return () => {
      annotationSession.disposed = true;
      if (highlightsSaveTimerRef.current) {
        window.clearTimeout(highlightsSaveTimerRef.current);
        highlightsSaveTimerRef.current = null;
      }
      void pendingSaveRef.current?.();
      pendingSaveRef.current = null;
    };
  }, [annotationSession, highlightsSaveTimerRef, pendingSaveRef]);

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

  // 翻页步进：单页 ±1；双页按 spread ±2（对齐行首，避免同 spread 内空翻；
  // 封面偏移下 [1] [2,3] [4,5] … 以偶数页为行首）
  const handlePrevPage = useCallback(
    () =>
      goToPage(getPrevNavigationPage(currentPage, viewMode, numPages, coverOffset), {
        recordJump: false,
      }),
    [currentPage, viewMode, numPages, coverOffset, goToPage],
  );
  const handleNextPage = useCallback(
    () =>
      goToPage(getNextNavigationPage(currentPage, viewMode, numPages, coverOffset), {
        recordJump: false,
      }),
    [currentPage, viewMode, numPages, coverOffset, goToPage],
  );

  const [pageJumpError, setPageJumpError] = useState<string | null>(null);

  const handlePageInputSubmit = useCallback(() => {
    const pageNum = parseInt(pageInputValue, 10);
    if (Number.isNaN(pageNum)) {
      setPageJumpError(t('pdf:toolbar.pageJumpInvalid', { defaultValue: '请输入有效页码' }));
      setPageInputValue('');
      return;
    }
    if (numPages > 0 && (pageNum < 1 || pageNum > numPages)) {
      setPageJumpError(
        t('pdf:toolbar.pageJumpOutOfRange', {
          max: numPages,
          defaultValue: `页码超出范围（1–${numPages}）`,
        }),
      );
      // Clamp so the reader still moves to a valid page.
      goToPage(pageNum);
      setPageInputValue('');
      return;
    }
    setPageJumpError(null);
    goToPage(pageNum);
    setPageInputValue('');
  }, [pageInputValue, goToPage, numPages, t]);

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
    columnZoomBaselineRef.current = null;
    applyScale(newScale);
    setShowZoomMenu(false);
  }, [applyScale]);

  const handleZoomModeSelect = useCallback((mode: ZoomMode) => {
    columnZoomBaselineRef.current = null;
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

  // 双栏论文双击空白/栏间留白（或按住 Alt 双击任意位置）：智能贴合单栏宽度并居中该栏，再次双击恢复原视图
  const handlePageDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (viewMode === 'dual') return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(
          'a, button, input, textarea, select, .ds-pdf__select-btn, .ds-highlight-menu, .ds-pdf__highlight-rect, .ds-pdf__ref-preview-card',
        )
      ) {
        return;
      }
      // 保护双击选词：若未按住 Alt 且当前双击在文本层选出了词语，优先保留浏览器选词行为
      if (!e.altKey) {
        const selText = window.getSelection()?.toString().trim() ?? '';
        if (selText.length > 0 && target.closest('.react-pdf__Page__textContent')) {
          return;
        }
      }
      const pageEl = target.closest('.ds-pdf__page-crop-frame, .ds-pdf__page-wrapper') as HTMLElement | null;
      const viewport = pageContainerRef.current;
      if (!pageEl || !viewport) return;

      e.preventDefault();
      const pageRect = pageEl.getBoundingClientRect();
      const decision = computeColumnDoubleClickZoom({
        currentZoomMode: zoomMode,
        currentScale: pendingScaleRef.current ?? scaleRef.current,
        currentScrollLeft: viewport.scrollLeft,
        savedBaseline: columnZoomBaselineRef.current,
        clickClientX: e.clientX,
        pageRect: { left: pageRect.left, width: pageRect.width },
        viewportWidth: viewport.clientWidth,
      });

      if (decision.action === 'restore') {
        columnZoomBaselineRef.current = null;
        if (decision.zoomMode !== 'custom') {
          handleZoomModeSelect(decision.zoomMode);
        } else {
          applyScale(decision.nextScale);
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            viewport.scrollLeft = decision.targetScrollLeft;
          });
        });
        return;
      }

      columnZoomBaselineRef.current = decision.baselineToSave;
      applyScale(decision.nextScale);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          viewport.scrollLeft = decision.targetScrollLeft;
        });
      });
    },
    [applyScale, handleZoomModeSelect, viewMode, zoomMode],
  );

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
  // Mod+F uses window capture while the PDF has focus-within so notes find
  // (document/window listeners) cannot steal it when the reader is focused.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pdfHasFocus = (target: EventTarget | null) => {
      if (!(target instanceof Node)) {
        return container === document.activeElement || container.contains(document.activeElement);
      }
      return container === target || container.contains(target);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 如果焦点在输入框中，忽略大部分快捷键
      const isInputFocused = document.activeElement?.tagName === 'INPUT' || 
                              document.activeElement?.tagName === 'TEXTAREA';
      
      // Ctrl/Cmd + F: 搜索
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (!pdfHasFocus(e.target) && !pdfHasFocus(document.activeElement)) return;
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
        setTimeout(() => searchInputRef.current?.focus(), 100);
        return;
      }
      
      // Window-capture listener: ignore non-search shortcuts unless PDF focused.
      if (!pdfHasFocus(e.target) && !pdfHasFocus(document.activeElement)) {
        return;
      }

      // Escape: 关闭搜索、取消引用扫描或关闭高亮/预览/导读菜单
      if (e.key === 'Escape') {
        if (isLocatingRef) {
          locateRefTokenRef.current++;
          setIsLocatingRef(false);
        }
        if (refPreviewCard) {
          setRefPreviewCard(null);
        }
        if (showPaperGuideMenu) {
          setShowPaperGuideMenu(false);
        }
        if (showSearch) {
          // P2 fix: 确保取消搜索任务并重置 isSearching 状态
          abortSearchTask();
          setShowSearch(false);
          setSearchQuery('');
          setSearchResults([]);
          setSearchRangesByPage(new Map());
          setCurrentSearchIndex(0);
          setIsSearching(false);
          setSearchProgress(null);
        }
        if (showHighlightMenu) setShowHighlightMenu(false);
        return;
      }
      
      if (isInputFocused) return;

      // Alt + ← / →：跨页跳转历史栈「返回原处 / 前进」（对标 Zotero / Sioyek）
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          handleJumpBack();
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleJumpForward();
          return;
        }
      }

      // 划词激活态单键快捷动作（1-5 五色语义高亮 / N 写批注 / C 复制学术引文 / T 翻译 / E 精读解释）
      if (showHighlightMenu && pendingHighlight && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const lower = e.key.toLowerCase();
        if (canPersistAnnotations && rotation === 0) {
          if (e.key === '1') {
            e.preventDefault();
            addHighlight(HIGHLIGHT_COLORS.yellow);
            return;
          }
          if (e.key === '2') {
            e.preventDefault();
            addHighlight(HIGHLIGHT_COLORS.green);
            return;
          }
          if (e.key === '3') {
            e.preventDefault();
            addHighlight(HIGHLIGHT_COLORS.blue);
            return;
          }
          if (e.key === '4') {
            e.preventDefault();
            addHighlight(HIGHLIGHT_COLORS.red);
            return;
          }
          if (e.key === '5') {
            e.preventDefault();
            addHighlight(HIGHLIGHT_COLORS.purple);
            return;
          }
          if (lower === 'n') {
            e.preventDefault();
            addHighlightWithNote();
            return;
          }
        }
        if (lower === 'c') {
          e.preventDefault();
          handleCopyCitation();
          return;
        }
        if (lower === 't' || lower === 'e') {
          e.preventDefault();
          const selected = pendingHighlight.text;
          setShowHighlightMenu(false);
          container.dispatchEvent(
            new CustomEvent('pdf-selection-trigger-action', {
              detail: {
                action: lower === 't' ? 'translate' : 'explain',
                text: selected,
              },
            }),
          );
          return;
        }
      }

      // 进度条（role=slider）持有焦点时，翻页类按键交给它自己的 onKeyDown
      // 处理（本监听是容器上的原生监听，先于 React 合成事件触发，
      // 不做豁免会双跳一页）。
      const sliderFocused = Boolean(
        (e.target as HTMLElement | null)?.closest?.('.ds-pdf__progress-bar')
      );

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

      // 翻页快捷键（双页模式按 spread ±2；封面偏移下首行为 [1] 单独成页）
      if (!sliderFocused && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        goToPage(
          e.key === 'ArrowLeft'
            ? getPrevNavigationPage(currentPageRef.current, viewModeRef.current, numPagesRef.current, coverOffsetRef.current)
            : getNextNavigationPage(currentPageRef.current, viewModeRef.current, numPagesRef.current, coverOffsetRef.current),
          { recordJump: false },
        );
      } else if (!sliderFocused && (e.key === 'PageUp' || e.key === 'PageDown')) {
        // ★ 明确语义：页面放大到一屏放不下时 PageUp/Down 滚一屏
        // （避免跳页略过当前页未读部分）；页面完整可见时按 spread/页翻页。
        e.preventDefault();
        const viewport = pageContainerRef.current;
        const pageEl = viewport?.querySelector(
          `[data-page-number="${currentPageRef.current}"]`
        );
        const action = resolvePageScrollKeyAction(
          pageEl?.getBoundingClientRect().height ?? 0,
          viewport?.clientHeight ?? 0
        );
        if (action === 'scroll' && viewport) {
          const delta = viewport.clientHeight * 0.88 * (e.key === 'PageUp' ? -1 : 1);
          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          viewport.scrollBy({ top: delta, behavior: reduceMotion ? 'auto' : 'smooth' });
        } else {
          goToPage(
            e.key === 'PageUp'
              ? getPrevNavigationPage(currentPageRef.current, viewModeRef.current, numPagesRef.current, coverOffsetRef.current)
              : getNextNavigationPage(currentPageRef.current, viewModeRef.current, numPagesRef.current, coverOffsetRef.current),
            { recordJump: false },
          );
        }
      } else if (!sliderFocused && e.key === 'Home') {
        e.preventDefault();
        goToPage(1);
      } else if (!sliderFocused && e.key === 'End') {
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
    const handleModFCapture = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      if (!pdfHasFocus(e.target) && !pdfHasFocus(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      setShowSearch(true);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    };

    // Capture Mod+F on window so notes find cannot steal it while PDF is focused.
    window.addEventListener('keydown', handleModFCapture, true);
    container.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleModFCapture, true);
      container.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    showSearch,
    showHighlightMenu,
    showPaperGuideMenu,
    refPreviewCard,
    isLocatingRef,
    pendingHighlight,
    canPersistAnnotations,
    rotation,
    addHighlight,
    addHighlightWithNote,
    handleCopyCitation,
    handleJumpBack,
    handleJumpForward,
    goToPage,
    abortSearchTask,
    handleRotate,
    handleRotateCcw,
    handleZoomIn,
    handleZoomOut,
    handleZoomModeSelect,
  ]);

  // ========== 壳层搜索转发 ==========
  // 文件预览窗（FilePreviewAppWindow）的 Cmd/Ctrl+F 通过自定义事件转发到
  // 本组件的全文搜索，与 EPUB 的 epub-preview-open-search 同构。
  // 依赖 file：无文档时根节点走空态分支、containerRef 为 null，文档就绪后再绑。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const openSearch = () => {
      setShowSearch(true);
      setTimeout(() => searchInputRef.current?.focus(), 100);
    };
    container.addEventListener('pdf-preview-open-search', openSearch);
    return () => container.removeEventListener('pdf-preview-open-search', openSearch);
  }, [file]);

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

  // 批注层外部超链接（DOI / arXiv / 参考文献 http(s) 链接）统一交由跨平台 openUrl 打开，
  // 避免 Tauri / Electron WebView 下裸 target="_blank" 被拦截或跳空窗
  const handleRootClickCapture = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    const anchor = target?.closest('.react-pdf__Page__annotations a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const rawHref = anchor.getAttribute('href')?.trim() ?? '';
    if (!/^(?:https?:|mailto:)/i.test(rawHref)) return;
    e.preventDefault();
    e.stopPropagation();
    void openUrl(rawHref);
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

  // role=slider 键盘操作（WAI-ARIA slider pattern）：
  // ←/↓ 上一页、→/↑ 下一页（双页按 spread 步进）、PageUp/Down ±10 页、Home/End 首末页。
  // 容器级快捷键监听对 slider 焦点已豁免这些按键，此处不会双跳。
  const handleProgressKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (numPages <= 0) return;
    let target: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        target = getNextNavigationPage(currentPage, viewMode, numPages, coverOffset);
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        target = getPrevNavigationPage(currentPage, viewMode, numPages, coverOffset);
        break;
      case 'PageUp':
        target = Math.max(1, currentPage - 10);
        break;
      case 'PageDown':
        target = Math.min(numPages, currentPage + 10);
        break;
      case 'Home':
        target = 1;
        break;
      case 'End':
        target = numPages;
        break;
      default:
        return;
    }
    e.preventDefault();
    goToPage(target);
  }, [numPages, currentPage, viewMode, coverOffset, goToPage]);

  // 双页行映射：标准配对 [1,2] [3,4] …；封面偏移 [1] [2,3] [4,5] …
  // （封面行独占 rowIndex 0，其余行以偶数页为行首，与 pdfPageNavigation 语义一致）
  const pageRowCount = useMemo(() => {
    if (viewMode !== 'dual') return numPages;
    if (coverOffset) return numPages > 0 ? 1 + Math.ceil((numPages - 1) / 2) : 0;
    return Math.ceil(numPages / 2);
  }, [viewMode, numPages, coverOffset]);

  const getRowPages = useCallback((rowIndex: number) => {
    if (viewMode === 'dual') {
      let first: number;
      if (coverOffset) {
        if (rowIndex === 0) return numPages >= 1 ? [1] : [];
        first = rowIndex * 2;
      } else {
        first = rowIndex * 2 + 1;
      }
      return [first, first + 1].filter(pageNum => pageNum <= numPages);
    }
    return [rowIndex + 1];
  }, [viewMode, numPages, coverOffset]);

  // 页码 → 虚拟行索引（getRowPages 的逆映射）
  const getRowIndexForPage = useCallback((pageNum: number) => {
    if (viewMode !== 'dual') return pageNum - 1;
    return coverOffset ? Math.floor(pageNum / 2) : Math.floor((pageNum - 1) / 2);
  }, [viewMode, coverOffset]);

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
  const shimmerCacheKey = `${pageWidth}|${trimMargins ? 'trim' : 'full'}|${rotation}|${basePageSize ? `${basePageSize.width}x${basePageSize.height}` : '-'}`;
  const prevShimmerCacheKeyRef = useRef(shimmerCacheKey);
  if (prevShimmerCacheKeyRef.current !== shimmerCacheKey) {
    prevShimmerCacheKeyRef.current = shimmerCacheKey;
    shimmerCacheRef.current.clear();
  }
  const getPageShimmer = useCallback((pageNum: number) => {
    let el = shimmerCacheRef.current.get(pageNum);
    if (!el) {
      const ratio = getPageDisplayRatio(pageNum);
      const layout = computeTrimmedPageLayout(pageWidth, ratio, trimMargins);
      el = (
        <div
          className="ds-pdf__page-shimmer"
          style={{ width: layout.renderWidth, height: Math.round(layout.renderWidth * ratio) }}
          aria-hidden="true"
        />
      );
      shimmerCacheRef.current.set(pageNum, el);
    }
    return el;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缓存失效由 shimmerCacheKey 控制
  }, [shimmerCacheKey, getPageDisplayRatio]);

  const estimatedRowHeight =
    computeTrimmedPageLayout(pageWidth, getPageDisplayRatio(1), trimMargins).visibleHeight +
    (viewMode === 'dual' ? 24 : 32);

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
      return (
        computeTrimmedPageLayout(pageWidth, ratio, trimMargins).visibleHeight +
        (viewMode === 'dual' ? 24 : 32)
      );
    },
    overscan: pdfSettings.virtualizerOverscan,
    measureElement: (element) => element?.getBoundingClientRect().height ?? estimatedRowHeight,
  });

  const pageVirtualItems = pageVirtualizer.getVirtualItems();

  // Reflow preserves the point at the viewport center, just as the page indicator does.
  useLayoutEffect(() => {
    captureResizeAnchorRef.current = () => {
      const viewport = pageContainerRef.current;
      if (!viewport || !initialScrollDoneRef.current || resizeAnchorRef.current) return;
      const offset = viewport.scrollTop + viewport.clientHeight / 2;
      const item = pageVirtualizer.getVirtualItemForOffset(offset);
      if (item?.size) {
        resizeAnchorRef.current = {
          source: fileSourceKey,
          index: item.index,
          fraction: Math.min(1, Math.max(0, (offset - item.start) / item.size)),
        };
      }
    };
    return () => { captureResizeAnchorRef.current = null; };
  }, [fileSourceKey, pageVirtualizer]);

  useEffect(() => {
    if (pageRowCount === 0) return;
    let restoreFrame: number | undefined;
    const measureFrame = requestAnimationFrame(() => {
      pageVirtualizer.measure();
      if (!resizeAnchorRef.current) return;
      restoreFrame = requestAnimationFrame(() => {
        const anchor = resizeAnchorRef.current;
        resizeAnchorRef.current = null;
        const viewport = pageContainerRef.current;
        if (!viewport || !anchor || anchor.source !== fileSourceKey || anchor.index >= pageRowCount) return;
        // The preceding measurement refresh populated the row cache with the new sizes.
        const item = pageVirtualizer.measurementsCache[anchor.index];
        if (item) pageVirtualizer.scrollToOffset(item.start + item.size * anchor.fraction - viewport.clientHeight / 2);
      });
    });
    return () => {
      cancelAnimationFrame(measureFrame);
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    };
    // rotation 影响页面布局高度（90°/270° 时宽高互换），需触发重新测量；
    // basePageSize 到位后行高估算基准变化，同样需要重估；
    // coverOffset / trimMargins 改变行配对或裁切高度，同样需要重排
  }, [pageRowCount, pageVirtualizer, pageWidth, viewMode, rotation, basePageSize, coverOffset, trimMargins, fileSourceKey]);

  useEffect(() => {
    let alignmentRaf: number | null = null;
    scrollToPageRef.current = (pageNum: number) => {
      if (alignmentRaf !== null) cancelAnimationFrame(alignmentRaf);
      if (!pageContainerRef.current || pageRowCount === 0) return;
      resizeAnchorRef.current = null;
      const targetRow = getRowIndexForPage(pageNum);
      const visibleItems = pageVirtualizer.getVirtualItems();
      const approxCurrentRow = visibleItems.length > 0 ? visibleItems[0]!.index : targetRow;
      if (Math.abs(targetRow - approxCurrentRow) > 1) {
        // 跨多页跳转（目录 / 引用定位 / 返回原处）：虚拟列表跨未测量行使用 smooth 会产生 1–3s 漂移，
        // 改为瞬时定位并在下一帧按真实测量高度二次对齐，确保一步精准落位到页顶
        pageVirtualizer.scrollToIndex(targetRow, { align: 'start' });
        alignmentRaf = requestAnimationFrame(() => {
          alignmentRaf = null;
          pageVirtualizer.scrollToIndex(targetRow, { align: 'start' });
        });
      } else {
        pageVirtualizer.scrollToIndex(targetRow, { align: 'start', behavior: 'smooth' });
      }
    };
    return () => {
      if (alignmentRaf !== null) cancelAnimationFrame(alignmentRaf);
      scrollToPageRef.current = () => {};
    };
  }, [pageRowCount, pageVirtualizer, getRowIndexForPage, fileSourceKey]);

  // ========== 跨插件互操作：语义锚点定位 + 页边反向链接（Interop Protocol v1） ==========
  // 本阅读器可被识别的资源 id：DSTU sourceId、路径末段与 VFS resourceId（异步解析）
  const [vfsAlias, setVfsAlias] = useState<{ path: string; id: string } | null>(null);
  const vfsNodeResourceId = vfsAlias?.path === resourcePath ? vfsAlias?.id : undefined;
  useEffect(() => {
    setVfsAlias(null);
    if (!resourcePath) return;
    let cancelled = false;
    void dstu.get(resourcePath).then((result) => {
      if (cancelled || !result.ok) return;
      const id = result.value?.resourceId;
      if (typeof id === 'string' && id.trim()) setVfsAlias({ path: resourcePath, id: id.trim() });
    }).catch(() => {
      // 解析失败只影响 VFS 别名匹配，不影响 DSTU id 匹配
    });
    return () => {
      cancelled = true;
    };
  }, [resourcePath]);

  const interopResourceId = selectionSourceId ?? resourceIdFromDstuPath(resourcePath) ?? undefined;
  const matchedResourceIds = useMemo(() => {
    const ids = [selectionSourceId, resourceIdFromDstuPath(resourcePath), resourcePath, vfsNodeResourceId]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return Array.from(new Set(ids));
  }, [selectionSourceId, resourcePath, vfsNodeResourceId]);
  const matchedResourceKey = JSON.stringify(matchedResourceIds);

  // 定位脉冲：pointer-events: none（CSS），绝不挡住下方划词 / 点击；1800ms 自动淡出
  useEffect(() => setAutoExcerptActive(false), [fileSourceKey, resourcePath]);
  const anchorPulseOverlay = usePdfAnchorReveal({
    documentKey: fileSourceKey,
    resourceIds: matchedResourceIds,
    containerRef,
    viewportRef: pageContainerRef,
    // 源变化的首帧仍可能留着旧 numPages，不能用它裁剪新文档的定位页码。
    numPages: prevFileSourceKeyRef.current === fileSourceKey ? numPages : 0,
    onNavigate: (targetPage) => {
      initialScrollDoneRef.current = true;
      if (targetPage !== currentPageRef.current) {
        currentPageRef.current = targetPage;
        setCurrentPage(targetPage);
        onPageChangeRef.current?.(targetPage - 1);
      }
      scrollToPageRef.current(targetPage);
    },
  });
  const displayedAnchorPulse = anchorPulseOverlay && rotateNormalizedRect(anchorPulseOverlay.rect, rotation);

  // 页边反向链接：查询 + 订阅变更（查询序号防止旧响应覆盖新结果）
  const [anchorEdges, setAnchorEdges] = useState<AnchorEdgeRecord[]>([]);
  useEffect(() => {
    setAnchorEdges([]);
    if (matchedResourceIds.length === 0) return;
    const kernel = getAppKernel();
    const ids = matchedResourceIds;
    const idSet = new Set(ids);
    let disposed = false;
    let querySeq = 0;
    const load = () => {
      const seq = ++querySeq;
      void kernel.anchors
        .queryAnchorEdgesByTarget({ targetResourceIds: ids, targetKind: 'pdf' })
        .then((edges) => {
          if (!disposed && seq === querySeq) setAnchorEdges(edges);
        })
        .catch(() => {
          // 反向链接是增强信息：查询失败保持现状
        });
    };
    load();
    const unsubscribe = kernel.anchors.subscribeAnchorEdgesChanged((detail) => {
      if (detail.targetResourceIds.length === 0 || detail.targetResourceIds.some((id) => idSet.has(id))) load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchedResourceKey 是 matchedResourceIds 的稳定摘要
  }, [matchedResourceKey]);
  const edgesByPage = useMemo(() => groupPdfAnchorEdgesByPage(anchorEdges), [anchorEdges]);

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
      const rowIndex = getRowIndexForPage(targetPage);
      const raf = requestAnimationFrame(() => {
        pageVirtualizer.scrollToIndex(rowIndex, { align: 'start' });
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [numPages, pageRowCount, initialPage, getRowIndexForPage, pageVirtualizer]);

  // 滚动监听：使用虚拟列表数据更新当前页码，避免频繁 DOM 查询。
  // 在 document 上捕获滚动、事件发生时再比对当前页面容器：滚动视口由 CustomScrollArea
  //（OverlayScrollbars）初始化时替换，直接挂在当时的 ref 元素上会挂到旧元素，
  // 之后滚动 / 引用跳页都不再更新页码（页码框停在 1）。
  useEffect(() => {
    if (numPages === 0) return;

    let rafId: number;

    const handleScroll = (event: Event) => {
      const container = pageContainerRef.current;
      if (!container || event.target !== container) return;
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

        // 视口中线落在哪一页就是当前页。旧判定「页中线越过视口中线」在页高于视口时
        // 会滞后一页：跳到第 4 页（页顶贴住视口顶）页码框仍显示 3
        const targetOffset = container.scrollTop + container.clientHeight / 2;
        let activeRow = items[0];
        for (const item of items) {
          if (item.start <= targetOffset) {
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

    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('scroll', handleScroll, { capture: true });
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
  const useOverlaySidebar = isSmallViewport || (toolbarWidth > 0 && toolbarWidth < 440);
  const thumbnailColumns = useOverlaySidebar ? 3 : 1;
  // 内联子屏占满 viewer（≈ 内容视口完整宽度），
  // 减去面板左右 padding(16×2) 与列间距(8×2) 后三等分
  const effectiveThumbnailWidth = useOverlaySidebar
    ? Math.max(72, Math.floor((viewportFullWidth - 32 - 16) / 3))
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
    const pageBacklinksCandidate = edgesByPage.get(pageNum);
    const pageBacklinks = pageBacklinksCandidate && pageBacklinksCandidate.total > 0 ? pageBacklinksCandidate : null;
    const trimmedLayout = computeTrimmedPageLayout(
      pageWidth,
      getPageDisplayRatio(pageNum),
      trimMargins,
    );

    const pageControls = (
      <>
        {enableStudyControls && (
          <div className="ds-pdf__page-overlay">
            <button
              type="button"
              className={`ds-pdf__select-btn [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 [@media(pointer:coarse)]:justify-center ${isSelected ? 'selected' : ''}`}
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
      </>
    );

    const innerPageWrapper = (
      <div
        key={trimMargins ? undefined : pageNum}
        id={`pdf-page-${pageNum}`}
        className={`ds-pdf__page-wrapper${agentFocusPage === pageNum ? ' ds-pdf__page-wrapper--agent-focus' : ''}`}
        data-page-number={pageNum}
        data-page-rotation={rotation}
        style={
          trimMargins
            ? {
                width: trimmedLayout.renderWidth,
                marginLeft: trimmedLayout.offsetX,
                marginRight: trimmedLayout.offsetX,
                marginTop: trimmedLayout.offsetY,
                marginBottom: trimmedLayout.offsetY,
              }
            : undefined
        }
      >
        {/* ★ 2026-07-08（审计 M2）：旋转改用 pdf.js 的 rotate 属性（参与布局），
            替代 CSS transform（不改变布局盒，导致虚拟列表测量与实际视觉高度不一致、
            相邻页重叠，且高亮取词坐标错位） */}
        <MemoPage
          pageNumber={pageNum}
          width={trimmedLayout.renderWidth}
          renderTextLayer={enableTextLayer}
          renderAnnotationLayer={enableAnnotationLayer}
          rotate={rotation}
          devicePixelRatio={renderDpr}
          onLoadSuccess={handlePageLoadSuccess}
          customTextRenderer={hasSearchMarks ? searchTextRenderer : ligatureTextRenderer}
          loading={getPageShimmer(pageNum)}
        />

        {/* 高亮覆盖层 — v2 为 0–1 相对坐标（按百分比渲染，尺寸无关）；
            历史数据（无 coordVersion）按旧逻辑乘以当前 scale 兜底 */}
        {getPageHighlights(pageNum).map(hl => {
          const hasComment = Boolean(hl.comment?.trim());
          const rectTitle = hasComment ? `${hl.text}\n— ${hl.comment}` : hl.text;
          return (
            // data-highlight-id：批注列表精确定位（focusHighlight）用它找到高亮块
            <div key={hl.id} className="ds-pdf__highlight-layer" data-highlight-id={hl.id}>
              {hl.rects.map((rect, idx) => (
                <div
                  key={idx}
                  className={`ds-pdf__highlight-rect${hasComment ? ' ds-pdf__highlight-rect--has-comment' : ''}${focusedHighlightId === hl.id ? ' ds-pdf__highlight-rect--focus' : ''}`}
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
                  title={rectTitle}
                  // 触屏 → 底部轻量操作条；桌面 → 锚定高亮块的改色/批注/删除浮层
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isCoarsePointer) {
                      setActiveHighlightAnchor(null);
                    } else {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setActiveHighlightAnchor({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom });
                    }
                    setEditingHighlightNoteId(null);
                    setActiveHighlightId(prev => (prev === hl.id ? null : hl.id));
                  }}
                />
              ))}
            </div>
          );
        })}

        {pageBacklinks && (
          <PdfLinkedExcerptTintLayer
            resourceId={interopResourceId}
            aliasResourceIds={matchedResourceIds}
            page={pageNum}
            rotation={rotation}
            edges={pageBacklinks.edges}
            isDark={isDarkMode || isDarkReading}
          />
        )}

        {anchorPulseOverlay && displayedAnchorPulse && anchorPulseOverlay.page === pageNum && (
          <div
            key={anchorPulseOverlay.key}
            className="ds-pdf__anchor-pulse"
            data-testid="pdf-anchor-pulse"
            aria-hidden="true"
            style={{
              left: `${displayedAnchorPulse.x * 100}%`,
              top: `${displayedAnchorPulse.y * 100}%`,
              width: `${displayedAnchorPulse.w * 100}%`,
              height: `${displayedAnchorPulse.h * 100}%`,
            }}
          />
        )}

        {pageBacklinks && (
          <React.Suspense fallback={null}>
            <PdfPageMarginBacklinks
              summary={pageBacklinks}
              page={pageNum}
              offsetForPageControls={enableStudyControls}
            />
          </React.Suspense>
        )}

        {!trimMargins && pageControls}
      </div>
    );

    if (!trimMargins) {
      return innerPageWrapper;
    }

    return (
      <div
        key={pageNum}
        className="ds-pdf__page-crop-frame"
        style={{ width: trimmedLayout.visibleWidth }}
      >
        {innerPageWrapper}
        {pageControls}
      </div>
    );
  }, [
    agentFocusPage,
    anchorPulseOverlay,
    displayedAnchorPulse,
    edgesByPage,
    annotationLayerRange,
    currentPage,
    enableStudyControls,
    focusedHighlightId,
    resolvedEnableTextSelection,
    pdfSettings.enableAnnotationLayerByDefault,
    getPageDisplayRatio,
    getPageShimmer,
    getPageHighlights,
    handlePageLoadSuccess,
    handleTogglePageSelect,
    interopResourceId,
    isCoarsePointer,
    isDarkMode,
    isDarkReading,
    matchedResourceIds,
    maxSelections,
    pageWidth,
    renderDpr,
    rotation,
    scale,
    searchHighlightActive,
    searchRangesByPage,
    searchTextRenderer,
    selectedPages,
    t,
    textLayerRange,
    trimMargins,
  ]);

  // 底部阅读进度条上的批注热力与搜索命中微刻度点
  const progressBarTicks = useMemo(
    () =>
      buildProgressBarTicks({
        numPages,
        highlights,
        searchResults,
        searchActive: searchHighlightActive,
      }),
    [numPages, highlights, searchResults, searchHighlightActive],
  );

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

  // 侧栏 tab 标签（桌面 tabs 与移动子屏分段共用）
  const sidebarTabLabels: Record<Exclude<SidebarMode, 'none'>, string> = {
    outline: t('pdf:toolbar.outline'),
    thumbnails: t('pdf:toolbar.thumbnails'),
    bookmarks: t('pdf:bookmark.bookmarkList'),
    highlights: t('pdf:toolbar.highlights'),
    related: t('pdf:related.tab', { defaultValue: '关联' }),
  };

  // 书签 tab 内容（桌面侧栏 / 移动子屏共用）。
  // onNavigate：移动端点击条目跳页后关闭子屏；桌面保持打开便于连续跳转。
  const renderBookmarkList = (onNavigate?: () => void) => (
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
            className={`ds-bookmark-item border-l-2 ${bm.page === currentPage ? 'current border-l-primary' : 'border-l-transparent'} ${editingBookmarkId === bm.id ? 'editing' : ''}`}
            onClick={() => {
              if (editingBookmarkId === bm.id) return;
              goToBookmark(bm);
              onNavigate?.();
            }}
          >
            <div className="ds-bookmark-icon">
              <Bookmark size={14} />
            </div>
            <div className="ds-bookmark-content">
              {editingBookmarkId === bm.id ? (
                <input
                  type="text"
                  className="ds-bookmark-title-input [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!text-[16px]"
                  value={editingBookmarkTitle}
                  onChange={(e) => setEditingBookmarkTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (isComposingKeyEvent(e)) return;
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      updateBookmarkTitle(bm.id, editingBookmarkTitle);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelEditBookmark();
                    }
                  }}
                  onBlur={() => {
                    // Enter already committed and cleared editingBookmarkId; skip empty re-commit.
                    if (editingBookmarkId !== bm.id) return;
                    updateBookmarkTitle(bm.id, editingBookmarkTitle);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <>
                  <div className="ds-bookmark-title">{bm.title}</div>
                  <div className="ds-bookmark-meta font-mono tabular-nums">
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
  );

  // 批注 tab 内容（桌面侧栏 / 移动子屏共用）——r5 起独立为 PdfAnnotationsPanel
  // （筛选 + 导出为笔记 + 回链），点击批注项走 focusHighlight 精确定位；
  // 移动端 onNavigate 关闭子屏后再定位（面板挡着页面时闪烁无意义）。
  const renderHighlightList = (onNavigate?: () => void) => (
    <React.Suspense fallback={null}>
      <PdfAnnotationsPanel
        highlights={highlights}
        fileName={fileName}
        resourcePath={resourcePath}
        onSelectHighlight={(hl) => {
          onNavigate?.();
          focusHighlight(hl);
        }}
        onRemoveHighlight={removeHighlight}
        onUpdateHighlightComment={canPersistAnnotations ? updateHighlightComment : undefined}
      />
    </React.Suspense>
  );

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
      data-pdf-preview
      data-pdf-toolbar={toolbarVariant}
      onPointerDown={handleRootPointerDown}
      onClickCapture={handleRootClickCapture}
    >
      <div
        className="ds-pdf__toolbar ds-pdf__toolbar--top"
        role="group"
        aria-label={t('pdf:toolbar.reader_tools')}
      >
        <div className="ds-pdf__toolbar-left">
          <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${sidebarMode !== 'none' ? 'active' : ''}`}
            onClick={() => setSidebarMode(sidebarMode !== 'none' ? 'none' : outline?.length ? 'outline' : 'thumbnails')}
            aria-label={t('pdf:toolbar.document_panel')} aria-expanded={sidebarMode !== 'none'}>
            <List size={17} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showSearch ? 'active' : ''}`}
            onClick={() => {
              if (showSearch) handleCloseSearch();
              else {
                setShowSearch(true);
                window.requestAnimationFrame(() => searchInputRef.current?.focus());
              }
            }}
            aria-label={t('pdf:toolbar.search')} aria-expanded={showSearch}>
            <MagnifyingGlass size={16} />
          </DsButton>
          {showStudyShortcuts && <>
            <div className="ds-toolbar-divider" />
            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${regionCaptureActive ? 'active' : ''}`}
              onClick={() => setRegionCaptureActive(prev => !prev)}
              disabled={numPages === 0} aria-label={t('pdf:toolbar.capture_ask')} aria-pressed={regionCaptureActive}>
              <Crop size={16} />
            </DsButton>
            {/* AI 论文导读：四类学术精读工作流一键发往对话 */}
            <div className="ds-paper-guide-menu" ref={paperGuideMenuRef}>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className={`ds-btn ${showPaperGuideMenu ? 'active' : ''}`}
                disabled={numPages === 0}
                onClick={() => setShowPaperGuideMenu((prev) => !prev)}
                title={t('pdf:toolbar.paper_guide')}
                aria-label={t('pdf:toolbar.paper_guide')}
                aria-expanded={showPaperGuideMenu}
              >
                <Sparkle size={16} />
              </DsButton>
              {showPaperGuideMenu && (
                <div
                  className="ds-more-dropdown ds-paper-guide-dropdown"
                  role="menu"
                  aria-label={t('pdf:paperGuide.menu_label')}
                >
                  <div className="ds-paper-guide-header">{t('pdf:paperGuide.menu_label')}</div>
                  <DsButton variant="ghost" size="sm" className="ds-more-item"
                    onClick={() => void handlePaperGuideAction('current_page', true)}>
                    <span>{t('pdf:paperGuide.attach_for_comparison')}</span>
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="ds-more-item"
                    onClick={() => handlePaperGuideAction('overview')}
                  >
                    <span>{t('pdf:paperGuide.overview')}</span>
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="ds-more-item"
                    onClick={() => handlePaperGuideAction('current_page')}
                  >
                    <span>{t('pdf:paperGuide.current_page', { page: currentPage })}</span>
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="ds-more-item"
                    onClick={() => handlePaperGuideAction('methodology')}
                  >
                    <span>{t('pdf:paperGuide.methodology')}</span>
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="ds-more-item"
                    onClick={() => handlePaperGuideAction('critique')}
                  >
                    <span>{t('pdf:paperGuide.critique')}</span>
                  </DsButton>
                </div>
              )}
            </div>

          </>}
        </div>
        <div className="ds-pdf__toolbar-right">
          <div className="ds-zoom-menu" ref={zoomMenuRef}>
            <DsButton variant="ghost" size="sm" className="ds-btn" onClick={() => setShowZoomMenu(!showZoomMenu)} title={t('pdf:toolbar.zoom_level')} aria-label={t('pdf:toolbar.zoom_level')} aria-expanded={showZoomMenu}>
              <span className="ds-zoom-readout font-mono tabular-nums">{Math.round((pendingScale ?? scale) * 100)}%</span>
              <CaretDown size={12} />
            </DsButton>
            {showZoomMenu && (
              <CustomScrollArea
                className="ds-zoom-dropdown ds-zoom-dropdown--top"
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
                <DsButton
                  variant="ghost"
                  size="sm"
                  className={`ds-zoom-option ${trimMargins ? 'active' : ''}`}
                  aria-pressed={trimMargins}
                  onClick={() => {
                    setTrimMargins((prev) => !prev);
                    setShowZoomMenu(false);
                  }}
                >
                  {t('pdf:toolbar.trim_margins')}
                </DsButton>
                {viewMode === 'single' && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className={`ds-zoom-option ${zoomMode === 'custom' && Math.abs(scale - SINGLE_COLUMN_ZOOM_SCALE) < 0.05 ? 'active' : ''}`}
                    onClick={() => handleZoomSelect(SINGLE_COLUMN_ZOOM_SCALE)}
                  >
                    {t('pdf:toolbar.single_column_zoom')}
                  </DsButton>
                )}
                <div className="ds-more-divider" />
                <div className="ds-pdf__zoom-steps">
                  <DsButton variant="ghost" size="icon" iconOnly onClick={handleZoomOut} aria-label={t('pdf:toolbar.zoom_out')}>
                    <MagnifyingGlassMinus size={16} />
                  </DsButton>
                  <DsButton variant="ghost" size="icon" iconOnly onClick={handleZoomIn} aria-label={t('pdf:toolbar.zoom_in')}>
                    <MagnifyingGlassPlus size={16} />
                  </DsButton>
                </div>
                {ZOOM_LEVELS.map(z => (
                  <DsButton key={z} variant="ghost" size="sm" className={`ds-zoom-option font-mono tabular-nums ${zoomMode === 'custom' && scale === z ? 'active' : ''}`} onClick={() => handleZoomSelect(z)}>
                    {Math.round(z * 100)}%
                  </DsButton>
                ))}
              </CustomScrollArea>
            )}
          </div>

          <div className="ds-pdf__toolbar-more" ref={moreMenuRef}>
            <DsButton variant="ghost" size="icon" iconOnly className={`ds-btn ${showMoreMenu ? 'active' : ''}`} onClick={() => setShowMoreMenu(!showMoreMenu)} title={t('pdf:toolbar.more')} aria-label={t('pdf:toolbar.more')} aria-expanded={showMoreMenu}>
              <DotsThree size={16} />
            </DsButton>
            {showMoreMenu && (
              <div className="ds-more-dropdown">
                {fileIdForOcr && (
                  <DsButton variant="ghost" size="sm" className="ds-more-item"
                    disabled={startingOcr || ocrStage === 'ocr_processing'}
                    onClick={() => void runDocumentOcr()}>
                    <MagnifyingGlass size={16} />
                    <span>{t('pdf:toolbar.run_ocr')}</span>
                  </DsButton>
                )}
                {highlights.length > 0 && (
                  <DsButton variant="ghost" size="sm" className="ds-more-item" onClick={() => void exportAnnotatedCopy()}>
                    <Highlighter size={16} />
                    <span>{t('pdf:annotations.export_pdf')}</span>
                  </DsButton>
                )}
                <div className="ds-more-divider" />
                <DsButton variant="ghost" size="sm" className={`ds-more-item ${currentPageBookmark ? 'active' : ''}`} onClick={() => { addBookmark(); setShowMoreMenu(false); }}>
                  {currentPageBookmark ? <BookmarkCheck size={14} /> : <BookmarkSimple size={14} />}
                  <span>{currentPageBookmark
                    ? t('pdf:bookmark.editBookmark')
                    : t('pdf:bookmark.addBookmark')}</span>
                </DsButton>
                {annotationToggleAvailable && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${resolvedEnableTextSelection ? 'active' : ''}`} onClick={() => { setAnnotationMode(!resolvedEnableTextSelection); setShowMoreMenu(false); }}>
                    <Highlighter size={14} />
                    <span>{t('pdf:toolbar.highlight')}</span>
                  </DsButton>
                )}
                <DsButton variant="ghost" size="sm" className={`ds-more-item ${regionCaptureActive ? 'active' : ''}`} disabled={numPages === 0} onClick={() => { setRegionCaptureActive(prev => !prev); setShowMoreMenu(false); }}>
                  <Crop size={14} />
                  <span>{t('pdf:toolbar.capture_ask')}</span>
                </DsButton>
                {interopResourceId && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className={`ds-more-item ${autoExcerptActive ? 'active' : ''}`}
                    disabled={numPages === 0}
                    aria-pressed={autoExcerptActive}
                    title={t('pdf:interop.auto_excerpt_hint')}
                    onClick={() => { setAutoExcerptActive((prev) => !prev); setShowMoreMenu(false); }}
                  >
                    <TreeStructure size={14} />
                    <span>{t('pdf:interop.auto_excerpt')}</span>
                    {autoExcerptActive && (
                      <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
                    )}
                  </DsButton>
                )}
                {!showStudyShortcuts && (
                  <>
                    <div className="ds-paper-guide-header">{t('pdf:paperGuide.menu_label')}</div>
                    <DsButton variant="ghost" size="sm" className="ds-more-item"
                      disabled={numPages === 0} onClick={() => void handlePaperGuideAction('current_page', true)}>
                      <BookOpenText size={16} />
                      <span>{t('pdf:paperGuide.attach_for_comparison')}</span>
                    </DsButton>
                    {(['overview', 'current_page', 'methodology', 'critique'] as const).map(mode => (
                      <DsButton key={mode} variant="ghost" size="sm" className="ds-more-item"
                        disabled={numPages === 0} onClick={() => void handlePaperGuideAction(mode)}>
                        <Sparkle size={14} />
                        <span>{t(`pdf:paperGuide.${mode}`, { page: currentPage })}</span>
                      </DsButton>
                    ))}
                  </>
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
                <DsButton variant="ghost" size="sm" className={`ds-more-item ${trimMargins ? 'active' : ''}`} onClick={() => { setTrimMargins(prev => !prev); setShowMoreMenu(false); }}>
                  <ArrowsOut size={14} />
                  <span>{t('pdf:toolbar.trim_margins')}</span>
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
                {dualPageAvailable && viewMode === 'dual' && (
                  <DsButton variant="ghost" size="sm" className={`ds-more-item ${coverOffset ? 'active' : ''}`} onClick={() => { setCoverOffset(prev => !prev); setShowMoreMenu(false); }}>
                    <BookOpenText size={14} />
                    <span>{t('pdf:toolbar.cover_offset')}</span>
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
        </div>
      </div>

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
            onKeyDown={(e) => e.key === 'Enter' && !isComposingKeyEvent(e) && handleSearch()}
          />
          {searchResults.length > 0 && (
            <span className="ds-search-info">
              {isSmallViewport
                ? `${currentSearchIndex + 1}/${searchResults.length}`
                : t('pdf:toolbar.result_count', {
                    current: currentSearchIndex + 1,
                    total: searchResults.length
                  })}
            </span>
          )}
          {/* 增量扫描进度：命中已实时展示，此处标注还在扫（大文档不再只有转圈） */}
          {isSearching && searchProgress && searchProgress.total > 0 && (
            <span className="ds-search-info ds-search-progress" role="status">
              {isSmallViewport
                ? `${searchProgress.scanned}/${searchProgress.total}…`
                : t('pdf:toolbar.search_progress', {
                    scanned: searchProgress.scanned,
                    total: searchProgress.total,
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

      {/* 阅读划词工具条（共享层 SelectionToolbar）：解释 / 翻译 / 保存为笔记 /
          制卡 / 添加到聊天。挂在选区下方，与上方的高亮选色菜单错开。
          注意：documentTitle 必须用 fileName——DSTU resourcePath 的末段是资源 ID
          （如 /我的教材/tb_xyz789），不是人类可读的文件名。
          onQuoteToChat 必须转发：否则「添加到聊天」永远落 PREFILL 文本兜底，
          丢失资源引用 + page locator 语义。 */}
      <React.Suspense fallback={null}>
        <PdfSelectionActions
          containerRef={containerRef}
          enabled={resolvedEnableTextSelection}
          isMobileLike={isMobileLike}
          documentTitle={fileName}
          onQuoteToChat={onQuoteToChat}
          selectionSourceId={selectionSourceId}
          onPinToAnnotation={canPersistAnnotations ? handlePinToAnnotation : undefined}
          interopResourceId={interopResourceId}
          interopAliasResourceId={vfsNodeResourceId}
          autoExcerptActive={autoExcerptActive}
        />
      </React.Suspense>

      {/* 跨页跳转历史悬浮胶囊（点击目录/参考文献/图表链接跳页后一键返回原处） */}
      {(jumpHistory.backStack.length > 0 || jumpHistory.forwardStack.length > 0) && (
        <div
          className="ds-pdf__jump-pill ui-rise-in"
          role="navigation"
          aria-label={t('pdf:toolbar.jump_back_hint')}
        >
          {jumpHistory.backStack.length > 0 && (
            <DsButton
              variant="ghost"
              size="sm"
              className="ds-pdf__jump-pill-btn font-mono tabular-nums"
              onClick={handleJumpBack}
              title={t('pdf:toolbar.jump_back_hint')}
              aria-label={t('pdf:toolbar.jump_back_hint')}
            >
              <ArrowUUpLeft size={14} />
              <span className="font-sans max-w-40 truncate">
                {t('pdf:toolbar.jump_back', {
                  page: peekJumpBackEntry(jumpHistory)!.page,
                })}
              </span>
              {peekJumpBackEntry(jumpHistory)?.label && (
                <span className="max-w-24 truncate font-mono tabular-nums" title={peekJumpBackEntry(jumpHistory)!.label}>
                  · {peekJumpBackEntry(jumpHistory)!.label}
                </span>
              )}
            </DsButton>
          )}
          {jumpHistory.forwardStack.length > 0 && (
            <DsButton
              variant="ghost"
              size="sm"
              className="ds-pdf__jump-pill-btn font-mono tabular-nums"
              onClick={handleJumpForward}
              title={t('pdf:toolbar.jump_forward_hint')}
              aria-label={t('pdf:toolbar.jump_forward_hint')}
            >
              <ArrowUUpRight size={14} />
              <span className="font-sans max-w-40 truncate">{t('pdf:toolbar.jump_forward', { page: peekJumpForwardEntry(jumpHistory)!.page })}</span>
            </DsButton>
          )}
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="ds-pdf__jump-pill-close"
            onClick={() => setJumpHistory(EMPTY_JUMP_HISTORY)}
            title={t('pdf:a11y.close')}
            aria-label={t('pdf:a11y.close')}
          >
            <X size={12} />
          </DsButton>
        </div>
      )}

      {pinnedRegions.length > 0 && (
        <React.Suspense fallback={null}>
          <PdfPinnedRegionsOverlay
            containerRef={containerRef}
            regions={pinnedRegions}
            documentTitle={fileName}
            onUpdateRegion={handleUpdatePinnedRegion}
            onRemoveRegion={handleRemovePinnedRegion}
            onJumpToPage={(page, label) => goToPage(page, { forceJump: true, label })}
          />
        </React.Suspense>
      )}

      {regionCaptureActive && numPages > 0 && (
        <React.Suspense fallback={null}>
          <PdfRegionCapture
            containerRef={containerRef}
            viewportRef={pageContainerRef}
            documentTitle={fileName}
            isTouch={isCoarsePointer}
            onPinRegion={handlePinRegion}
            onExit={() => setRegionCaptureActive(false)}
            interopResourceId={interopResourceId}
            interopAliasResourceId={vfsNodeResourceId}
            autoExcerptActive={autoExcerptActive}
            viewStateKey={`${currentPage}:${pageWidth}:${rotation}`}
          />
        </React.Suspense>
      )}

      {/* 文内引用 / 图表 / 公式就地预览卡片（不跳离当前页即可查看完整参考文献题录或图注） */}
      {refPreviewCard && (
        <div
          ref={isMobileLike ? undefined : refPreviewMenu.ref}
          className={`ds-pdf__ref-preview-card ui-rise-in ${isMobileLike ? 'ds-pdf__ref-preview-card--mobile' : ''}`}
          role="dialog"
          aria-label={refPreviewCard.preview.ref.displayLabel}
          data-testid="pdf-ref-preview-card"
          style={
            isMobileLike
              ? undefined
              : refPreviewMenu.frame
                ? { position: 'fixed', left: refPreviewMenu.frame.left, top: refPreviewMenu.frame.top }
                : refPreviewCard.anchor
                  ? {
                      position: 'fixed',
                      left: refPreviewCard.anchor.x,
                      top: refPreviewCard.anchor.top,
                      visibility: 'hidden',
                    }
                  : undefined
          }
        >
          <div className="ds-pdf__ref-preview-header">
            <span className="ds-pdf__ref-preview-dot" aria-hidden="true" />
            <span className="ds-pdf__ref-preview-badge font-mono tabular-nums">
              {refPreviewCard.preview.ref.displayLabel}
            </span>
            <span className="ds-pdf__ref-preview-page font-mono tabular-nums">
              {t('pdf:toolbar.page', { page: refPreviewCard.preview.page })}
            </span>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-pdf__ref-preview-close"
              onClick={() => setRefPreviewCard(null)}
              title={t('pdf:a11y.close')}
              aria-label={t('pdf:a11y.close')}
            >
              <X size={12} />
            </DsButton>
          </div>
          <p className="ds-pdf__ref-preview-snippet">{refPreviewCard.preview.snippet}</p>
          <div className="ds-pdf__ref-preview-footer">
            <DsButton
              variant="ghost"
              size="sm"
              className="px-2.5 text-xs gap-1"
              onClick={() => {
                void copyTextToClipboard(refPreviewCard.preview.snippet).then((ok) => {
                  showGlobalNotification(
                    ok ? 'success' : 'error',
                    ok ? t('pdf:selection.copied') : t('pdf:selection.copy_failed'),
                  );
                });
              }}
            >
              <Copy size={14} />
              <span>{t('pdf:selection.ref_preview_copy')}</span>
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="px-2.5 text-xs gap-1 font-mono tabular-nums border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)] hover:bg-[color:var(--button-primary-hover)] active:bg-[color:var(--button-primary-active)]"
              onClick={() => {
                const { page, ref } = refPreviewCard.preview;
                setRefPreviewCard(null);
                goToPage(page, { forceJump: true, label: ref.displayLabel });
              }}
            >
              <Crosshair size={14} />
              <span className="font-sans">
                {t('pdf:selection.jump_to_ref', { page: refPreviewCard.preview.page })}
              </span>
            </DsButton>
          </div>
        </div>
      )}

      {/* 划词菜单：桌面为选区上方浮动菜单（钳位到视口内，贴顶时翻到选区下方）；
          移动端改为 viewer 内底部内联色板条
          （absolute bottom，非 fixed body 层，避让底栏与 safe-area）。
          承载 5 色学术语义高亮、高亮并批注、文内引用定位、复制与复制学术引文；
          翻译/解释/做笔记/制卡/引用到对话由共享层 SelectionToolbar（上方 PdfSelectionActions）统一承载。 */}
      {showHighlightMenu && !isMobileLike && (
        <div
          ref={selectionMenu.ref}
          className="ds-highlight-menu"
          role="toolbar"
          aria-label={t('pdf:selection.menu_label')}
          style={
            selectionMenu.frame
              ? { position: 'fixed', left: selectionMenu.frame.left, top: selectionMenu.frame.top }
              : { position: 'fixed', left: highlightMenuPos.x, top: highlightMenuPos.top, visibility: 'hidden' }
          }
        >
          <div className="ds-highlight-menu__row">
            {canPersistAnnotations && rotation === 0 && (
              <>
                {(Object.entries(HIGHLIGHT_COLORS) as [keyof typeof HIGHLIGHT_COLORS, string][]).map(
                  ([name, color]) => (
                    <DsButton
                      key={name}
                      variant="ghost"
                      size="icon"
                      iconOnly
                      className="ds-highlight-color"
                      style={{ background: color }}
                      onClick={() => addHighlight(color)}
                      title={t(`pdf:toolbar.highlight_semantic_${name}`)}
                      aria-label={t(`pdf:toolbar.highlight_semantic_${name}`)}
                    />
                  ),
                )}
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="ds-btn ds-btn-sm"
                  onClick={() => addHighlightWithNote()}
                  title={`${t('pdf:selection.highlight_with_note')} (N)`}
                  aria-label={t('pdf:selection.highlight_with_note')}
                >
                  <NotePencil size={15} />
                </DsButton>
                <span className="ds-highlight-menu__divider" aria-hidden="true" />
              </>
            )}
            {detectedSelectionRef && (
              <>
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="ds-highlight-locate-btn gap-1 !h-6 !px-2 text-xs"
                  disabled={isLocatingRef}
                  onClick={() => void handlePreviewAcademicRef()}
                  title={t('pdf:selection.preview_ref', { label: detectedSelectionRef.displayLabel })}
                >
                  <MagnifyingGlass size={14} />
                  <span>
                    {t(isLocatingRef ? 'pdf:selection.locating_ref' : 'pdf:selection.preview_ref', {
                      label: detectedSelectionRef.displayLabel,
                    })}
                  </span>
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="ds-btn ds-btn-sm"
                  disabled={isLocatingRef}
                  onClick={() => void handleLocateAcademicRef()}
                  title={t('pdf:selection.locate_ref', { label: detectedSelectionRef.displayLabel })}
                  aria-label={t('pdf:selection.locate_ref', { label: detectedSelectionRef.displayLabel })}
                >
                  <Crosshair size={14} />
                </DsButton>
                <span className="ds-highlight-menu__divider" aria-hidden="true" />
              </>
            )}
            <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleCopySelection} title={t('pdf:selection.copy')} aria-label={t('pdf:selection.copy')}>
              <Copy size={16} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={() => handleCopyCitation()}
              title={`${t('pdf:selection.copy_citation')} (C)`}
              aria-label={t('pdf:selection.copy_citation')}
            >
              <Quotes size={16} />
            </DsButton>
          </div>
        </div>
      )}

      {showHighlightMenu && isMobileLike && (
        <div className="ds-pdf__highlight-bar ui-rise-in" role="toolbar" aria-label={t('pdf:selection.menu_label')}>
          <span className="ds-pdf__highlight-bar-label">{t('pdf:toolbar.highlight')}</span>
          {canPersistAnnotations && rotation === 0 && (
            <>
              {/* 色板 36px（bar 内 CSS 特异性高于 coarse 全局 32px）：伪元素扩命中区到 44px
                  （36 + 2×4；bar gap 10px，相邻命中区不重叠），视觉尺寸不变 */}
              {(Object.entries(HIGHLIGHT_COLORS) as [keyof typeof HIGHLIGHT_COLORS, string][]).map(
                ([name, color]) => (
                  <DsButton
                    key={name}
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="ds-highlight-color relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-['']"
                    style={{ background: color }}
                    onClick={() => addHighlight(color)}
                    title={t(`pdf:toolbar.highlight_semantic_${name}`)}
                    aria-label={t(`pdf:toolbar.highlight_semantic_${name}`)}
                  />
                ),
              )}
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="ds-btn ds-btn-sm"
                onClick={() => addHighlightWithNote()}
                title={t('pdf:selection.highlight_with_note')}
                aria-label={t('pdf:selection.highlight_with_note')}
              >
                <NotePencil size={16} />
              </DsButton>
            </>
          )}
          {detectedSelectionRef && (
            <>
              <DsButton
                variant="ghost"
                size="sm"
                className="ds-highlight-locate-btn gap-1 text-xs"
                disabled={isLocatingRef}
                onClick={() => void handlePreviewAcademicRef()}
              >
                <MagnifyingGlass size={14} />
                <span>
                  {t('pdf:selection.preview_ref', { label: detectedSelectionRef.displayLabel })}
                </span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="ds-btn ds-btn-sm"
                disabled={isLocatingRef}
                onClick={() => void handleLocateAcademicRef()}
                title={t('pdf:selection.locate_ref', { label: detectedSelectionRef.displayLabel })}
                aria-label={t('pdf:selection.locate_ref', { label: detectedSelectionRef.displayLabel })}
              >
                <Crosshair size={14} />
              </DsButton>
            </>
          )}
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm" onClick={handleCopySelection} title={t('pdf:selection.copy')} aria-label={t('pdf:selection.copy')}>
            <Copy size={16} />
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="ds-btn ds-btn-sm"
            onClick={() => handleCopyCitation()}
            title={t('pdf:selection.copy_citation')}
            aria-label={t('pdf:selection.copy_citation')}
          >
            <Quotes size={16} />
          </DsButton>
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

      {/* 桌面端点按高亮块后的浮动操作层：5 色语义切换 + 批注笔记内联编辑 + 复制引文 + 删除 */}
      {activeHighlight && activeHighlightAnchor && !showHighlightMenu && (
        <div
          ref={highlightActionMenu.ref}
          className="ds-highlight-menu ds-highlight-menu--action"
          role="toolbar"
          aria-label={t('pdf:toolbar.highlights')}
          style={
            highlightActionMenu.frame
              ? { position: 'fixed', left: highlightActionMenu.frame.left, top: highlightActionMenu.frame.top }
              : { position: 'fixed', left: activeHighlightAnchor.x, top: activeHighlightAnchor.top, visibility: 'hidden' }
          }
        >
          <div className="ds-highlight-menu__row">
            {(Object.entries(HIGHLIGHT_COLORS) as [keyof typeof HIGHLIGHT_COLORS, string][]).map(([name, color]) => (
              <DsButton
                key={name}
                variant="ghost"
                size="icon"
                iconOnly
                className={`ds-highlight-color ${activeHighlight.color === color ? 'ds-highlight-color--current' : ''}`}
                style={{ background: color }}
                onClick={() => updateHighlightColor(activeHighlight.id, color)}
                title={t(`pdf:toolbar.highlight_semantic_${name}`)}
                aria-label={t(`pdf:toolbar.highlight_semantic_${name}`)}
                aria-pressed={activeHighlight.color === color}
              />
            ))}
            <span className="ds-highlight-menu__divider" aria-hidden="true" />
            {canPersistAnnotations && (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className={`ds-btn ds-btn-sm ${editingHighlightNoteId === activeHighlight.id || activeHighlight.comment ? 'active' : ''}`}
                onClick={() => {
                  if (editingHighlightNoteId === activeHighlight.id) {
                    setEditingHighlightNoteId(null);
                  } else {
                    setEditingHighlightNoteId(activeHighlight.id);
                    setHighlightNoteDraft(activeHighlight.comment ?? '');
                  }
                }}
                title={
                  activeHighlight.comment
                    ? t('pdf:annotations.edit_note')
                    : t('pdf:annotations.add_note')
                }
                aria-label={
                  activeHighlight.comment
                    ? t('pdf:annotations.edit_note')
                    : t('pdf:annotations.add_note')
                }
              >
                <NotePencil size={15} />
              </DsButton>
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={() =>
                handleCopyCitation({
                  text: activeHighlight.text,
                  pageIndex: activeHighlight.pageIndex,
                })
              }
              title={t('pdf:selection.copy_citation')}
              aria-label={t('pdf:selection.copy_citation')}
            >
              <Quotes size={15} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={() => removeHighlight(activeHighlight.id)}
              title={t('pdf:toolbar.delete_highlight')}
              aria-label={t('pdf:a11y.delete')}
            >
              <Trash size={16} />
            </DsButton>
          </div>
          {editingHighlightNoteId === activeHighlight.id ? (
            <div className="ds-highlight-popover-note">
              <textarea
                rows={2}
                value={highlightNoteDraft}
                onChange={(e) => setHighlightNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposingKeyEvent(e)) return;
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    e.stopPropagation();
                    updateHighlightComment(activeHighlight.id, highlightNoteDraft);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditingHighlightNoteId(null);
                  }
                }}
                placeholder={t('pdf:annotations.note_placeholder')}
                className="ds-highlight-note-textarea"
                autoFocus
              />
              <div className="ds-highlight-note-actions">
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="!h-6 !px-2 text-xs"
                  onClick={() => setEditingHighlightNoteId(null)}
                >
                  {t('pdf:annotations.cancel_note')}
                </DsButton>
                <DsButton
                  variant="primary"
                  size="sm"
                  className="!h-6 !px-2.5 text-xs"
                  onClick={() => updateHighlightComment(activeHighlight.id, highlightNoteDraft)}
                >
                  {t('pdf:annotations.save_note')}
                </DsButton>
              </div>
            </div>
          ) : activeHighlight.comment ? (
            <div
              className="ds-highlight-popover-comment"
              onClick={() => {
                if (!canPersistAnnotations) return;
                setEditingHighlightNoteId(activeHighlight.id);
                setHighlightNoteDraft(activeHighlight.comment ?? '');
              }}
            >
              {activeHighlight.comment}
            </div>
          ) : null}
        </div>
      )}

      {/* 触屏点按页面内高亮块后的轻量操作条（复用底部选色条样式）：改色 + 批注编辑 + 删除 */}
      {activeHighlight && !activeHighlightAnchor && !showHighlightMenu && (
        <div className="ds-pdf__highlight-bar ds-pdf__highlight-bar--column ui-rise-in" role="toolbar" aria-label={t('pdf:toolbar.highlights')}>
          <div className="ds-pdf__highlight-bar-row">
            {(Object.entries(HIGHLIGHT_COLORS) as [keyof typeof HIGHLIGHT_COLORS, string][]).map(([name, color]) => (
              <DsButton
                key={name}
                variant="ghost"
                size="icon"
                iconOnly
                className={`ds-highlight-color ${activeHighlight.color === color ? 'ds-highlight-color--current' : ''}`}
                style={{ background: color }}
                onClick={() => updateHighlightColor(activeHighlight.id, color)}
                title={t(`pdf:toolbar.highlight_semantic_${name}`)}
                aria-label={t(`pdf:toolbar.highlight_semantic_${name}`)}
                aria-pressed={activeHighlight.color === color}
              />
            ))}
            <span className="ds-pdf__highlight-bar-text">
              {activeHighlight.comment || activeHighlight.text}
            </span>
            {canPersistAnnotations && (
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="ds-btn ds-btn-sm"
                onClick={() => {
                  if (editingHighlightNoteId === activeHighlight.id) {
                    setEditingHighlightNoteId(null);
                  } else {
                    setEditingHighlightNoteId(activeHighlight.id);
                    setHighlightNoteDraft(activeHighlight.comment ?? '');
                  }
                }}
                title={t('pdf:annotations.edit_note')}
                aria-label={t('pdf:annotations.edit_note')}
              >
                <NotePencil size={16} />
              </DsButton>
            )}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={() => removeHighlight(activeHighlight.id)}
              title={t('pdf:toolbar.delete_highlight')}
              aria-label={t('pdf:a11y.delete')}
            >
              <Trash size={16} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={() => {
                setActiveHighlightId(null);
                setEditingHighlightNoteId(null);
              }}
              aria-label={t('pdf:a11y.close')}
            >
              <X size={16} />
            </DsButton>
          </div>
          {editingHighlightNoteId === activeHighlight.id && (
            <div className="ds-highlight-popover-note w-full">
              <textarea
                rows={2}
                value={highlightNoteDraft}
                onChange={(e) => setHighlightNoteDraft(e.target.value)}
                placeholder={t('pdf:annotations.note_placeholder')}
                className="ds-highlight-note-textarea [@media(pointer:coarse)]:!text-base"
                autoFocus
              />
              <div className="ds-highlight-note-actions">
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingHighlightNoteId(null)}
                >
                  {t('pdf:annotations.cancel_note')}
                </DsButton>
                <DsButton
                  variant="primary"
                  size="sm"
                  onClick={() => updateHighlightComment(activeHighlight.id, highlightNoteDraft)}
                >
                  {t('pdf:annotations.save_note')}
                </DsButton>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 主体区域（侧边栏 + 内容） */}
      <div className="ds-pdf__main">
        {/* 侧边栏（>640 并排面板；≤640 改为下方的全屏内联子屏，不再侧滑 overlay）
            ★ 桌面端常挂容器：开合走 width 过渡（--open 修饰类），内容按需挂载。
            ★ 目录/缩略图/书签/批注合并为同一侧栏的 tab（原书签/批注为独立浮动
            面板，与侧栏互相遮挡；合并后同域互斥切换，浮层只剩菜单类）。 */}
        {!useOverlaySidebar && (
          <div
            className={`ds-pdf__sidebar ${sidebarMode !== 'none' ? 'ds-pdf__sidebar--open' : ''}`}
            aria-hidden={sidebarMode === 'none'}
          >
            {sidebarMode !== 'none' && (
              <div className="ds-pdf__sidebar-inner">
                <div className="ds-pdf__sidebar-tabs" role="tablist" aria-label={t('pdf:toolbar.sidebar')}>
                  {outline && outline.length > 0 && (
                    <DsButton
                      variant="ghost"
                      role="tab"
                      aria-selected={sidebarMode === 'outline'}
                      className={`ds-pdf__sidebar-tab ${sidebarMode === 'outline' ? 'active' : ''}`}
                      onClick={() => setSidebarMode('outline')}
                      title={sidebarTabLabels.outline}
                      aria-label={sidebarTabLabels.outline}
                    >
                      <List size={15} />
                    </DsButton>
                  )}
                  <DsButton
                    variant="ghost"
                    role="tab"
                    aria-selected={sidebarMode === 'thumbnails'}
                    className={`ds-pdf__sidebar-tab ${sidebarMode === 'thumbnails' ? 'active' : ''}`}
                    onClick={() => setSidebarMode('thumbnails')}
                    title={sidebarTabLabels.thumbnails}
                    aria-label={sidebarTabLabels.thumbnails}
                  >
                    <GridFour size={15} />
                  </DsButton>
                  <DsButton
                    variant="ghost"
                    role="tab"
                    aria-selected={sidebarMode === 'bookmarks'}
                    className={`ds-pdf__sidebar-tab ${sidebarMode === 'bookmarks' ? 'active' : ''}`}
                    onClick={() => setSidebarMode('bookmarks')}
                    title={sidebarTabLabels.bookmarks}
                    aria-label={sidebarTabLabels.bookmarks}
                  >
                    <BookmarkSimple size={15} />
                    {bookmarks.length > 0 && <span className="ds-pdf__sidebar-tab-count">{bookmarks.length}</span>}
                  </DsButton>
                  {(canPersistAnnotations || highlights.length > 0) && (
                    <DsButton
                      variant="ghost"
                      role="tab"
                      aria-selected={sidebarMode === 'highlights'}
                      className={`ds-pdf__sidebar-tab ${sidebarMode === 'highlights' ? 'active' : ''}`}
                      onClick={() => setSidebarMode('highlights')}
                      title={sidebarTabLabels.highlights}
                      aria-label={sidebarTabLabels.highlights}
                    >
                      <Highlighter size={15} />
                      {highlights.length > 0 && <span className="ds-pdf__sidebar-tab-count">{highlights.length}</span>}
                    </DsButton>
                  )}
                  {selectionSourceId && (
                    <DsButton
                      variant="ghost"
                      role="tab"
                      aria-selected={sidebarMode === 'related'}
                      className={`ds-pdf__sidebar-tab ${sidebarMode === 'related' ? 'active' : ''}`}
                      onClick={() => setSidebarMode('related')}
                      title={sidebarTabLabels.related}
                      aria-label={sidebarTabLabels.related}
                    >
                      <LinkSimple size={15} />
                    </DsButton>
                  )}
                  <DsButton variant="ghost" size="icon" iconOnly className="ds-btn ds-btn-sm ds-pdf__sidebar-close" onClick={() => setSidebarMode('none')} aria-label={t('pdf:a11y.close')}>
                    <X size={14} />
                  </DsButton>
                </div>

                {/* 目录 */}
                {sidebarMode === 'outline' && outline && (
                  <div className="ds-pdf__outline">
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

                {/* 书签 */}
                {sidebarMode === 'bookmarks' && renderBookmarkList()}

                {/* 批注 */}
                {sidebarMode === 'highlights' && renderHighlightList()}

                {/* 关联：引用此资料的笔记 / 讨论过它的对话 */}
                {sidebarMode === 'related' && selectionSourceId && (
                  <React.Suspense fallback={null}><PdfRelatedPanel sourceId={selectionSourceId} /></React.Suspense>
                )}
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
              <DsButton variant="ghost" size="sm" onClick={handleRetryLoad} className="gap-1.5 mt-2 [@media(pointer:coarse)]:!min-h-11">
                <ArrowClockwise size={14} />
                {t('common:retry')}
              </DsButton>
            </div>
          ) : (
            <Document
              key={documentRetryKey}
              file={file}
              options={PDF_OPTIONS}
              onItemClick={handlePdfInternalLinkClick}
              externalLinkTarget="_blank"
              externalLinkRel="noopener noreferrer"
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
                  onDoubleClick={handlePageDoubleClick}
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

      {/* ≤640：目录/缩略图/书签/批注全屏内联子屏（顶栏分段 + 返回；替代侧滑 overlay） */}
      {useOverlaySidebar && sidebarMode !== 'none' && (
        <div className="ds-pdf__mobile-panel ds-pdf__document-overlay" role="region" aria-label={sidebarTabLabels[sidebarMode]}>
          <div className="ds-pdf__mobile-panel-header">
            <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={() => setSidebarMode('none')} aria-label={t('common:back')}>
              <CaretLeft size={18} />
            </DsButton>
            <div className="ds-pdf__mobile-panel-tabs" role="tablist">
              {outline && outline.length > 0 && (
                <DsButton
                  variant="ghost"
                  role="tab"
                  aria-selected={sidebarMode === 'outline'}
                  className={`ds-pdf__mobile-panel-tab [@media(pointer:coarse)]:!min-h-11 ${sidebarMode === 'outline' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('outline')}
                >
                  {t('pdf:toolbar.outline')}
                </DsButton>
              )}
              <DsButton
                variant="ghost"
                role="tab"
                aria-selected={sidebarMode === 'thumbnails'}
                className={`ds-pdf__mobile-panel-tab [@media(pointer:coarse)]:!min-h-11 ${sidebarMode === 'thumbnails' ? 'active' : ''}`}
                onClick={() => setSidebarMode('thumbnails')}
              >
                {t('pdf:toolbar.thumbnails')}
              </DsButton>
              <DsButton
                variant="ghost"
                role="tab"
                aria-selected={sidebarMode === 'bookmarks'}
                className={`ds-pdf__mobile-panel-tab [@media(pointer:coarse)]:!min-h-11 ${sidebarMode === 'bookmarks' ? 'active' : ''}`}
                onClick={() => setSidebarMode('bookmarks')}
              >
                {t('pdf:bookmark.tabLabel')}
              </DsButton>
              {(canPersistAnnotations || highlights.length > 0) && (
                <DsButton
                  variant="ghost"
                  role="tab"
                  aria-selected={sidebarMode === 'highlights'}
                  className={`ds-pdf__mobile-panel-tab [@media(pointer:coarse)]:!min-h-11 ${sidebarMode === 'highlights' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('highlights')}
                >
                  {t('pdf:toolbar.highlight_tab')}
                </DsButton>
              )}
              {selectionSourceId && (
                <DsButton
                  variant="ghost"
                  role="tab"
                  aria-selected={sidebarMode === 'related'}
                  className={`ds-pdf__mobile-panel-tab [@media(pointer:coarse)]:!min-h-11 ${sidebarMode === 'related' ? 'active' : ''}`}
                  onClick={() => setSidebarMode('related')}
                >
                  {sidebarTabLabels.related}
                </DsButton>
              )}
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

          {sidebarMode === 'bookmarks' && renderBookmarkList(() => setSidebarMode('none'))}
          {sidebarMode === 'related' && selectionSourceId && (
            <React.Suspense fallback={null}><PdfRelatedPanel sourceId={selectionSourceId} /></React.Suspense>
          )}

          {sidebarMode === 'highlights' && renderHighlightList(() => setSidebarMode('none'))}
        </div>
      )}

      {/* 底部工具栏 - 始终单行 */}
      <div className="ds-pdf__toolbar ds-pdf__toolbar--bottom" role="group" aria-label={t('pdf:toolbar.page_navigation')}>
        <div className="ds-pdf__toolbar-center">
          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handlePrevPage} disabled={!canNavigatePrev(currentPage, viewMode, coverOffset)} title={`${t('pdf:actions.previous_page')} (←)`} aria-label={t('pdf:actions.previous_page')}>
            <CaretLeft size={16} />
          </DsButton>

          <div className="ds-page-input font-mono tabular-nums">
            <Input
              type="text"
              inputMode="numeric"
              className="ds-input font-mono tabular-nums"
              value={pageInputValue || currentPage}
              aria-invalid={pageJumpError ? true : undefined}
              aria-describedby={pageJumpError ? 'ds-pdf-page-jump-error' : undefined}
              title={pageJumpError ?? undefined}
              onChange={(e) => {
                setPageJumpError(null);
                setPageInputValue(e.target.value);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handlePageInputSubmit()}
              // 失焦不提交：未经 Enter 确认的输入还原显示为当前页，
              // 避免误触（点击空白处收起键盘）触发意外跳页
              onBlur={() => {
                setPageInputValue('');
                setPageJumpError(null);
              }}
              onFocus={(e) => {
                setPageInputValue(String(currentPage));
                const input = e.target as HTMLInputElement;
                requestAnimationFrame(() => input.select());
              }}
              aria-label={t('pdf:page_info', { current: currentPage, total: numPages || 0 })}
            />
            <span className="ds-page-total font-mono tabular-nums">/ {numPages || 0}</span>
          </div>
          {pageJumpError ? (
            <span id="ds-pdf-page-jump-error" role="alert" className="text-xs text-destructive whitespace-nowrap">
              {pageJumpError}
            </span>
          ) : null}

          <DsButton variant="ghost" size="icon" iconOnly className="ds-btn" onClick={handleNextPage} disabled={!canNavigateNext(currentPage, viewMode, numPages, coverOffset)} title={`${t('pdf:actions.next_page')} (→)`} aria-label={t('pdf:actions.next_page')}>
            <CaretRight size={16} />
          </DsButton>
        </div>

      </div>

      {/* 阅读进度条（支持拖动跳页：拖动中显示目标页码，松手跳转） */}
      {numPages > 0 && (
        <div
          className={`ds-pdf__progress-bar ${scrubPage !== null ? 'scrubbing' : ''}`}
          role="slider"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={numPages}
          aria-valuenow={scrubPage ?? currentPage}
          aria-valuetext={t('pdf:page_info', { current: scrubPage ?? currentPage, total: numPages })}
          aria-label={t('pdf:page_info', { current: scrubPage ?? currentPage, total: numPages })}
          onPointerDown={handleProgressPointerDown}
          onPointerMove={handleProgressPointerMove}
          onPointerUp={handleProgressPointerUp}
          onPointerCancel={handleProgressPointerCancel}
          onKeyDown={handleProgressKeyDown}
        >
          <div
            className="ds-pdf__progress-fill"
            style={{
              width: `${numPages > 0 ? Math.round(((scrubPage ?? currentPage) / numPages) * 100) : 0}%`,
            }}
          />
          {progressBarTicks.map((tick) => {
            const summaryLabel =
              tick.highlightCount > 0 && tick.searchCount > 0
                ? t('pdf:progress.tick_both', {
                    page: tick.page,
                    highlights: tick.highlightCount,
                    searches: tick.searchCount,
                  })
                : tick.highlightCount > 0
                  ? t('pdf:progress.tick_highlight_only', {
                      page: tick.page,
                      count: tick.highlightCount,
                    })
                  : t('pdf:progress.tick_search_only', {
                      page: tick.page,
                      count: tick.searchCount,
                    });
            const tooltip = tick.previewText
              ? `${summaryLabel} — ${tick.previewText}`
              : summaryLabel;
            return (
              <span
                key={tick.page}
                className={`ds-pdf__progress-tick${tick.searchCount > 0 && !tick.color ? ' ds-pdf__progress-tick--search' : ''}`}
                style={{
                  left: `${tick.percent}%`,
                  ...(tick.color ? { backgroundColor: tick.color } : {}),
                }}
                title={tooltip}
                data-page={tick.page}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  goToPage(tick.page, { forceJump: true });
                }}
              />
            );
          })}
          <span className="ds-pdf__progress-text font-mono tabular-nums">
            {scrubPage !== null ? `${scrubPage} / ${numPages}` : `${readingProgress}%`}
          </span>
        </div>
      )}

    </div>
  );
};

export const EnhancedPdfViewer = React.memo(EnhancedPdfViewerImpl);

export default EnhancedPdfViewer;
