import React, { useEffect, useState, useCallback, useMemo, useRef, useLayoutEffect, useSyncExternalStore, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { MagnifyingGlass, Plus, X, Trash, CircleNotch, FlowArrow, CheckSquare, ListChecks, CaretLeft, CaretRight, House } from '@phosphor-icons/react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { extractFileName, extractDisplayFileName, fileManager } from '@/utils/fileManager';
import { exportResourceById } from './utils/exportResource';
import { getMemoryConfig } from '@/api/memoryApi';
import { MemoryFolderBanner } from './components/MemoryFolderBanner';
import { LearningHubGenerativeBriefing } from './components/LearningHubGenerativeBriefing';
import { MemoryFolderGenerativeBriefing } from './components/MemoryFolderGenerativeBriefing';
import { MemoryTreePreview } from './components/MemoryTreePreview';
import { UnifiedDragDropZone, FILE_TYPES } from '@/components/shared/UnifiedDragDropZone';
import { useDebounce } from '@/hooks/useDebounce';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import {
  FolderIcon,
  NoteIcon,
  ExamIcon,
  TextbookIcon,
  TranslationIcon,
  EssayIcon,
  MindmapIcon,
} from './icons';

/** 教材导入进度事件类型 */
interface TextbookImportProgress {
  file_name: string;
  stage: 'hashing' | 'copying' | 'rendering' | 'saving' | 'done' | 'error';
  current_page?: number;
  total_pages?: number;
  progress: number;
  error?: string;
}

// ============================================================================
// ★ 拖拽导入：文件类型分类常量（模块级，避免每次渲染重建）
// ============================================================================

/** 文档类扩展名集合（通过 textbooks_add 后端命令导入） */
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm',
  'xlsx', 'xls', 'xlsb', 'ods',
  'pptx', 'epub', 'rtf',
  'csv', 'json', 'xml',
]);

/** 图片类扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif',
]);

/**
 * ★ 2026-07-20（P3 引导）：需要引导到专属模块导入的格式。
 * 资源库不直接接收这类文件，拖入时给出明确的模块引导而非笼统"导入失败"。
 */
const MODULE_GUIDANCE_EXTENSIONS: Record<string, 'flashcards' | 'mindmap'> = {
  apkg: 'flashcards',
  colpkg: 'flashcards',
  xmind: 'mindmap',
  opml: 'mindmap',
  mm: 'mindmap',
  mmap: 'mindmap',
};

/** 从文件名获取扩展名 */
const getFileExtension = (name: string): string =>
  (name.split('.').pop() || '').toLowerCase();

// 懒加载向量化状态视图
const IndexStatusView = lazy(() => import('./views/IndexStatusView'));
// ★ 2026-01-19: 懒加载 VFS 记忆管理视图
const MemoryView = lazy(() => import('./views/MemoryView'));
import { useDesktopStore, type DesktopRootConfig } from './stores/desktopStore';
import {
  useFinderStoreFor,
  setActiveFinderHostId,
  getActiveFinderHostId,
  resolveFinderHostId,
  DEFAULT_FINDER_HOST_ID,
  type FinderPath,
  type QuickAccessType,
} from './stores/finderStore';
import { useRecentStore } from './stores/recentStore';
import { useLearningHubNavigationSafe } from './LearningHubNavigationContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import {
  FinderToolbar,
  FinderQuickAccess,
  FinderFileList,
  FinderBatchToolbar,
  FinderQuickLook,
  FolderPickerDialog,
  DesktopView,
  type CreateResourceType,
} from './components/finder';
import {
  finderUndoStack,
  type FinderMoveUndoEntry,
} from './utils/finderUndoStack';
import {
  finderClipboard,
  toClipboardEntries,
  buildCopySrcPath,
  buildPasteDstPath,
  type FinderClipboardEntry,
} from './utils/finderClipboard';
import { dstu, type DstuNode, folderApi, createEmpty, trashApi } from '@/dstu';
import { updatePathCacheV2 } from '@/features/chat/context/vfsRefApi';
import { dstuNodeToResourceListItem, mapDstuTypeToFolderItemType } from './types';
import type { LearningHubSidebarProps, ResourceListItem } from './types';
import type { FolderTreeNode } from '@/dstu/types/folder';
import { VfsError, VfsErrorCode, err, ok, reportError } from '@/shared/result';
import { LearningHubContextMenu, type ContextMenuTarget } from './components/LearningHubContextMenu';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import { ImportProgressModal, type ImportProgressState, type ImportStage } from './components/ImportProgressModal';
import { useVfsContextInject } from './hooks';
import type { VfsResourceType } from '@/features/chat/context/types';
import {
  consumePathsDropHandledFlag,
  isDragDropBlockedView,
  partitionMarkdownNoteImports,
  summarizeFailedMarkdownFiles,
} from './dragDropRouting';
import { getCreatableFolderId } from './viewGuards';
import {
  getFinderPathDisplayPath,
  getQuickAccessTarget,
  getQuickAccessTypeFromPath,
  getViewCapabilities,
  resolveQuickAccessType,
} from './learningHubContracts';
import { useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import { getSearchPlaceholderKey, matchesLiveName } from './utils/searchHonesty';
import { pruneSelectionAgainstItems } from './stores/selectionPrune';

/** ★ Bug4: canvas 模式下不应显示的特殊视图（仅显示层 fallback，不写回 store） */
const CANVAS_BLOCKED_VIEW_KINDS = new Set(['indexStatus', 'memory', 'desktop']);
const CANVAS_FALLBACK_PATH = {
  viewKind: 'folder' as const,
  breadcrumbs: [] as Array<{ id: string; name: string; dstuPath: string }>,
  folderId: null as string | null,
  typeFilter: null as null,
};
const PENDING_FOLDER_ID_PREFIX = '__pending_new_folder__';

type SoftDeleteTarget = { id: string; type: string; name: string };

const isPendingFolderId = (id: string | null | undefined): boolean =>
  Boolean(id?.startsWith(PENDING_FOLDER_ID_PREFIX));

interface PendingFolderDraft {
  node: DstuNode;
  parentFolderId: string | null;
}

export function LearningHubSidebar({
  mode,
  onOpenApp,
  onOpenPreview,
  onClose,
  onReferenceToChat,
  className,
  isCollapsed = false,
  onToggleCollapse,
  activeFileId,
  mobileBottomPadding = false,
  hasOpenApp = false,
  onCloseApp,
  hideToolbarAndNav = false,
  quickAccessPortalTarget,
  toolbarPortalTarget,
  toolbarPortalMode = 'window',
  highlightedIds,
  hostId,
  sessionActive,
  commandsEnabled,
  onMultiSelectModeChange,
  multiSelectToggleRef,
}: LearningHubSidebarProps) {
  const { isActive: isLearningHubViewActive } = useViewVisibility('learning-hub');
  const commandEventsEnabled = commandsEnabled ?? isLearningHubViewActive;
  const { t } = useTranslation('learningHub');

  // ========== 响应式布局 ==========
  const { isSmallScreen } = useBreakpoint();

  // ========== 页面生命周期监控 ==========
  usePageMount('learning-hub-sidebar', 'LearningHubSidebar');

  // ★ LH-HOST：每个宿主一份访达状态（currentPath / searchQuery / selectedIds / viewMode）
  const finderStore = useFinderStoreFor(hostId);

  // Store state
  const {
    currentPath: storeCurrentPath,
    history: storeHistory,
    historyIndex: storeHistoryIndex,
    viewMode,
    sortBy,
    sortOrder,
    selectedIds: storeSelectedIds,
    searchQuery: storeSearchQuery,
    isSearching,
    searchMeta,
    items: storeItems,
    isLoading: storeIsLoading,
    error: storeError,

    // Actions
    goBack: storeGoBack,
    goForward: storeGoForward,
    goUp: storeGoUp,
    jumpToBreadcrumb: storeJumpToBreadcrumb,
    setViewMode,
    setSorting,
    select: storeSelect,
    selectAll: storeSelectAll,
    clearSelection: storeClearSelection,
    setSelectedIds: storeSetSelectedIds,
    setSearchQuery: storeSetSearchQuery,
    refresh: finderRefresh,
    enterFolder: storeEnterFolder,
    navigateTo: storeNavigateTo,
    quickAccessNavigate: storeQuickAccessNavigate,
    queryItemsForPath,
  } = finderStore();

  // ★ LH-HOST Step2：canvas 宿主的「导航位置」不再是组件本地 state，而是
  // hostId 桶内的 store。外部顶栏（ChatV2Page 移动端面包屑）因此能读到画布
  // 自己的落点，不再串到学习中心那一桶。
  // 列表 / 选中 / 搜索仍留在本地：canvas 走本地活名过滤而非后端搜索。
  const [canvasItems, setCanvasItems] = useState<DstuNode[]>([]);
  const [canvasIsLoading, setCanvasIsLoading] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [canvasSelectedIds, setCanvasSelectedIds] = useState<Set<string>>(new Set());
  const [canvasLastSelectedId, setCanvasLastSelectedId] = useState<string | null>(null);
  const [canvasSearchQuery, setCanvasSearchQuery] = useState('');
  const canvasRequestIdRef = useRef(0);

  // 导航位置统一由宿主桶 store 承载（canvas 与 fullscreen 桶不同，天然隔离）。
  const currentPath = storeCurrentPath;
  const history = storeHistory;
  const historyIndex = storeHistoryIndex;
  const items = mode === 'canvas' ? canvasItems : storeItems;
  const isLoading = mode === 'canvas' ? canvasIsLoading : storeIsLoading;
  const error = mode === 'canvas' ? canvasError : storeError;
  const selectedIds = mode === 'canvas' ? canvasSelectedIds : storeSelectedIds;
  const searchQuery = mode === 'canvas' ? canvasSearchQuery : storeSearchQuery;
  const setSearchQuery = mode === 'canvas' ? setCanvasSearchQuery : storeSetSearchQuery;

  // ★ LH-HOST：canvas 遇到特殊视图时仅显示层 fallback 到 root，不写回全局 store
  const isCanvasPathBlocked =
    mode === 'canvas' && CANVAS_BLOCKED_VIEW_KINDS.has(currentPath.viewKind);
  const effectivePath = isCanvasPathBlocked ? CANVAS_FALLBACK_PATH : currentPath;

  const currentPathDisplay = getFinderPathDisplayPath(effectivePath);
  const viewCapabilities = getViewCapabilities(effectivePath.viewKind);
  const currentCreatableFolderId = getCreatableFolderId(effectivePath);
  const baseQuickAccessType = getQuickAccessTypeFromPath(effectivePath) ?? null;
  const isTrashView = effectivePath.viewKind === 'trash';

  // ★ 记忆系统改造：跟踪记忆根文件夹 ID，用于高亮侧边栏
  // 在组件挂载和 viewKind 变化时刷新（用户可能通过 MemoryView 设置了根文件夹后返回）
  const [memoryRootFolderId, setMemoryRootFolderId] = useState<string | null>(null);
  const refreshMemoryRootFolderId = useCallback(() => {
    getMemoryConfig().then(c => setMemoryRootFolderId(c.memoryRootFolderId)).catch(() => {});
  }, []);
  useEffect(() => { refreshMemoryRootFolderId(); }, [refreshMemoryRootFolderId, effectivePath.viewKind]);

  // 判断当前是否在记忆文件夹内（检查面包屑中是否包含记忆根文件夹）
  const isInMemoryFolder = memoryRootFolderId != null && (
    effectivePath.folderId === memoryRootFolderId ||
    effectivePath.breadcrumbs?.some(b => b.id === memoryRootFolderId)
  );
  const currentQuickAccessType = isInMemoryFolder ? 'memory' as QuickAccessType : baseQuickAccessType;
  const searchPlaceholder = t(getSearchPlaceholderKey(effectivePath));
  const canCreateInCurrentView = viewCapabilities.canCreate;
  const canSearchInCurrentView = viewCapabilities.canSearch;
  const canDeleteInCurrentView = viewCapabilities.canDelete;
  const canMoveInCurrentView = viewCapabilities.canMove;
  const canAddToChatInCurrentView = viewCapabilities.canAddToChat;
  const canDragDropInCurrentView = viewCapabilities.canDragDrop;

  // ★ 搜索防抖处理：延迟 300ms 触发 API 调用，避免快速输入导致频繁请求
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // ★ 最近访问记录 Store
  const addRecent = useRecentStore(state => state.addRecent);

  // Local state for QuickAccess collapse (折叠状态，不是隐藏)
  const [quickAccessCollapsed, setQuickAccessCollapsed] = useState(false);

  // ★ 记忆系统改造：树状图预览模式（搜索时自动切回列表）
  const [memoryTreeView, setMemoryTreeView] = useState(false);
  useEffect(() => {
    if (searchQuery.trim() && memoryTreeView) {
      setMemoryTreeView(false);
    }
  }, [searchQuery, memoryTreeView]);

  // ★ 收缩态强制折叠 QuickAccess
  const effectiveQuickAccessCollapsed = quickAccessCollapsed || isCollapsed;

  // P1-20: 移动端搜索框展开状态
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);

  // 📱 移动端顶部工具栏「新建」菜单：受控 + Android 返回键关闭（契约第 4 条）。
  // AppMenu 是自绘浮层（无 data-state="open"），androidBackCoordinator 的 Radix 兜底匹配不到。
  const [mobileCreateMenuOpen, setMobileCreateMenuOpen] = useState(false);
  // 可见性锚点用触发按钮：菜单内容 portal 到 body，判定不了保活视图的隐藏态
  const mobileCreateMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!mobileCreateMenuOpen) return;
    return registerBackHandler(() => {
      // 视图离屏时（MobileSlidingLayout 给非可见屏加 inert / display:none 隐藏保活视图）
      // 让行给当前活跃层：不吞返回键、也不关用户看不见的菜单（对照 IndexStatusView 守卫）
      const el = mobileCreateMenuTriggerRef.current;
      if (!el || el.closest('[inert]') || el.offsetParent === null) return false;
      setMobileCreateMenuOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [mobileCreateMenuOpen]);

  // ★ Canvas 模式多选模式状态
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // ★ 2026-06-12（审阅问题 FE-S3）：触屏设备检测。
  // 触屏上没有 Cmd/Ctrl 修饰键，普通（非 canvas）视图也需要多选模式开关。
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 多选模式生效条件：canvas 模式（原有逻辑）或触屏普通模式
  const multiSelectActive = isMultiSelectMode && (mode === 'canvas' || isTouchPrimary);

  // 新文件夹只作为前端草稿显示；用户提交非空名称后才写入后端。
  const [pendingFolderDraft, setPendingFolderDraft] = useState<PendingFolderDraft | null>(null);
  const pendingFolderDraftRef = useRef<PendingFolderDraft | null>(null);
  const pendingFolderSequenceRef = useRef(0);
  pendingFolderDraftRef.current = pendingFolderDraft;
  
  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget>({ type: 'empty' });

  // ★ Quick Look：空格快速预览的当前项（null = 关闭）
  const [quickLookItem, setQuickLookItem] = useState<DstuNode | null>(null);

  // ★ 快捷访问「收藏」徽标真数据（undefined = 未加载，不显示假 0）
  const [favoriteCount, setFavoriteCount] = useState<number | undefined>(undefined);

  // ★ 删除确认对话框状态：仅永久删 / 清空 / 回收站批永久删（软删走 Undo toast）
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'permanent' | 'emptyTrash' | 'batch';
    permanentDeleteInfo?: { id: string; itemType: string };
    batchIds?: Set<string>;
    message: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Batch operation state
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  // ★ 2026-06-12（审阅问题 FE-M4）：右键"移动到…"的目标集合；null 表示使用当前多选集合
  const [moveTargetIds, setMoveTargetIds] = useState<Set<string> | null>(null);
  
  // ★ 教材导入进度状态
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    isImporting: false,
    fileName: '',
    stage: 'hashing',
    progress: 0,
  });

  // ★ 2026-06-12（审阅问题 FE-M5）：附件批量导入进度（非模态横幅）
  const [attachImportProgress, setAttachImportProgress] = useState<{ done: number; total: number } | null>(null);
  
  // Inline editing state (from store)
  const {
    inlineEdit,
    startInlineEdit,
    cancelInlineEdit,
  } = finderStore();
  
  // Container ref for keyboard shortcuts scope
  const containerRef = useRef<HTMLDivElement>(null);

  // ★ MEDIUM-004/005: 组件卸载标志，防止内存泄漏
  const isMountedRef = useRef(true);

  // ★ P0-001 修复: 防止 UnifiedDragDropZone 同时调用 onPathsDropped 和 onFilesDropped 导致双重导入
  const pathsDropHandledRef = useRef(false);
  const softDeleteUndoGenRef = useRef(0);
  const softDeleteUndoInFlightRef = useRef(false);

  // ★ VFS 上下文注入 Hook（用于批量添加到对话）
  const { injectToChat, canInject, isInjecting } = useVfsContextInject();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // canvas 的列表/选中/搜索仍是本地态，导航后需要跟着清一次
  const resetCanvasLocalSelection = useCallback(() => {
    setCanvasSelectedIds(new Set());
    setCanvasLastSelectedId(null);
  }, []);
  const resetCanvasLocalState = useCallback(() => {
    resetCanvasLocalSelection();
    setCanvasSearchQuery('');
  }, [resetCanvasLocalSelection]);

  const navigateCanvasTo = useCallback((path: FinderPath) => {
    storeNavigateTo(path);
    resetCanvasLocalState();
  }, [storeNavigateTo, resetCanvasLocalState]);

  const enterCanvasFolder = useCallback(async (folderId: string, folderName?: string, folderPath?: string) => {
    await storeEnterFolder(folderId, folderName, folderPath);
    resetCanvasLocalState();
  }, [storeEnterFolder, resetCanvasLocalState]);

  const goCanvasBack = useCallback(() => {
    storeGoBack();
    resetCanvasLocalSelection();
  }, [storeGoBack, resetCanvasLocalSelection]);

  const goCanvasForward = useCallback(() => {
    storeGoForward();
    resetCanvasLocalSelection();
  }, [storeGoForward, resetCanvasLocalSelection]);

  const jumpCanvasToBreadcrumb = useCallback((index: number) => {
    storeJumpToBreadcrumb(index);
    resetCanvasLocalState();
  }, [storeJumpToBreadcrumb, resetCanvasLocalState]);

  const navigateCanvasQuickAccess = useCallback((type: QuickAccessType) => {
    storeQuickAccessNavigate(type);
    resetCanvasLocalState();
  }, [storeQuickAccessNavigate, resetCanvasLocalState]);

  const goCanvasUp = useCallback(() => {
    storeGoUp();
    resetCanvasLocalState();
  }, [storeGoUp, resetCanvasLocalState]);

  const goBack = mode === 'canvas' ? goCanvasBack : storeGoBack;
  const goForward = mode === 'canvas' ? goCanvasForward : storeGoForward;
  const jumpToBreadcrumb = mode === 'canvas' ? jumpCanvasToBreadcrumb : storeJumpToBreadcrumb;
  const enterFolder = mode === 'canvas' ? enterCanvasFolder : storeEnterFolder;
  const navigateTo = mode === 'canvas' ? navigateCanvasTo : storeNavigateTo;
  const quickAccessNavigate = mode === 'canvas' ? navigateCanvasQuickAccess : storeQuickAccessNavigate;
  const goUp = mode === 'canvas' ? goCanvasUp : storeGoUp;

  const select = useCallback((id: string, selectionMode: 'single' | 'toggle' | 'range') => {
    if (mode !== 'canvas') {
      storeSelect(id, selectionMode);
      return;
    }
    setCanvasSelectedIds((previous) => {
      if (selectionMode === 'single') {
        setCanvasLastSelectedId(id);
        return new Set([id]);
      }
      if (selectionMode === 'toggle') {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setCanvasLastSelectedId(id);
        return next;
      }
      const anchor = canvasLastSelectedId;
      const anchorIndex = items.findIndex((item) => item.id === anchor);
      const currentIndex = items.findIndex((item) => item.id === id);
      if (anchorIndex === -1 || currentIndex === -1) {
        setCanvasLastSelectedId(id);
        return new Set([id]);
      }
      return new Set(items.slice(Math.min(anchorIndex, currentIndex), Math.max(anchorIndex, currentIndex) + 1).map((item) => item.id));
    });
  }, [canvasLastSelectedId, items, mode, storeSelect]);

  const selectAll = useCallback(() => {
    if (mode === 'canvas') setCanvasSelectedIds(new Set(items.map((item) => item.id)));
    else storeSelectAll();
  }, [items, mode, storeSelectAll]);
  const clearSelection = useCallback(() => {
    if (mode === 'canvas') {
      setCanvasSelectedIds(new Set());
      setCanvasLastSelectedId(null);
    } else storeClearSelection();
  }, [mode, storeClearSelection]);
  const setSelectedIds = useCallback((ids: Set<string>) => {
    if (mode === 'canvas') setCanvasSelectedIds(ids);
    else storeSetSelectedIds(ids);
  }, [mode, storeSetSelectedIds]);

  const refreshCanvas = useCallback(async () => {
    if (!isMountedRef.current) return;
    const requestId = ++canvasRequestIdRef.current;
    const pathSnapshot = currentPath;
    const querySnapshot = canvasSearchQuery.trim();
    setCanvasIsLoading(true);
    setCanvasError(null);
    const result = await queryItemsForPath(pathSnapshot);
    if (!isMountedRef.current || requestId !== canvasRequestIdRef.current) return;
    if (result.ok) {
      const nextItems = querySnapshot
        ? result.value.filter((item) => matchesLiveName(item, querySnapshot))
        : result.value;
      setCanvasItems(nextItems);
      setCanvasSelectedIds((previous) => {
        const pruned = pruneSelectionAgainstItems(
          previous,
          nextItems,
          canvasLastSelectedId,
          { preserveLastSelectedIfWasSelected: true },
        );
        setCanvasLastSelectedId(pruned.lastSelectedId);
        return pruned.selectedIds;
      });
    } else if ('error' in result) {
      setCanvasError(result.error.message);
    }
    setCanvasIsLoading(false);
  }, [canvasLastSelectedId, currentPath, canvasSearchQuery, queryItemsForPath]);

  useEffect(() => {
    if (mode !== 'canvas' || sessionActive === false) return;
    void refreshCanvas();
  }, [mode, currentPath, canvasSearchQuery, refreshCanvas, sessionActive]);

  // ★ 2025-12-31: 移除组件挂载时的 reset() 调用
  // 原因: finderStore 使用 persist 中间件保存导航状态到 localStorage
  // 如果每次挂载都 reset，会导致:
  // 1. 用户在子文件夹时切换视图，路径被意外重置到根目录
  // 2. 移动端三屏布局切换时丢失导航状态
  // 导航状态应该由用户操作控制，而非组件生命周期

  // ★ 文档28 Prompt 8: 同步 finderStore 与 LearningHubNavigationContext
  useLearningHubNavigationSafe();

  // ★ LH-HOST：把本宿主注册为「活跃访达」，让 App 级前进/后退壳层作用在本桶上。
  // canvas 宿主自带局部列表状态，不参与全局导航壳层。
  useEffect(() => {
    if (mode === 'canvas' || sessionActive === false) return;
    const bucketId = resolveFinderHostId(hostId);
    setActiveFinderHostId(bucketId);
    return () => {
      if (getActiveFinderHostId() === bucketId) {
        setActiveFinderHostId(DEFAULT_FINDER_HOST_ID);
      }
    };
  }, [mode, hostId, sessionActive]);

  // ★ 2026-01-15: 完全移除双向同步逻辑
  // 原因：LearningHubNavigationContext 现在直接使用 finderStore 的历史栈（goBack/goForward）
  // 不再需要 navContext ↔ finderStore 的同步，因为它们现在共享同一个数据源
  // 这彻底解决了两个历史栈互相干扰导致的循环问题

  // Load items when path changes
  // ★ 使用 debouncedSearchQuery 触发搜索，避免快速输入导致频繁 API 调用
  // ★ LH-HOST：sessionActive===false 时跳过（非活跃宿主不抢刷新）
  // ★ 2026-07-21：同路径因窗口焦点恢复（sessionActive false→true）时走静默刷新；
  //   store 侧若列表等价会跳过 items 写入，避免关闭预览后整表闪烁重绘。
  const lastLoadSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode === 'canvas' || sessionActive === false) return;

    let isCancelled = false;

    const loadData = async () => {
      if (searchQuery.trim() && debouncedSearchQuery !== searchQuery) {
        return;
      }

      const signature = [
        currentPath.viewKind,
        currentPath.folderId ?? '',
        currentPath.typeFilter ?? '',
        debouncedSearchQuery,
      ].join('\0');
      const silent = lastLoadSignatureRef.current === signature;

      const start = Date.now();
      pageLifecycleTracker.log(
        'learning-hub-sidebar',
        'LearningHubSidebar',
        'data_load',
        `path: ${currentPathDisplay}${silent ? ' (silent)' : ''}`,
      );

      try {
        await finderRefresh(silent ? { silent: true } : undefined);
        if (!isCancelled && isMountedRef.current) {
          lastLoadSignatureRef.current = signature;
          pageLifecycleTracker.log(
            'learning-hub-sidebar',
            'LearningHubSidebar',
            'data_ready',
            `${finderStore.getState().items.length} items`,
            { duration: Date.now() - start }
          );
        }
      } catch (err) {
        if (!isCancelled && isMountedRef.current) {
          debugLog.error('Unexpected error loading items:', err);
        }
      }
    };

    void loadData();
    return () => {
      isCancelled = true;
    };
  }, [mode, sessionActive, currentPathDisplay, currentPath.viewKind, currentPath.folderId, currentPath.typeFilter, debouncedSearchQuery, searchQuery, finderRefresh, finderStore]);

  // Handle open item
  const handleOpen = (item: DstuNode) => {
    // ★ Bug Fix: 回收站中的资源不应记录为最近访问
    if (item.type !== 'folder' && currentPath.viewKind !== 'trash') {
      addRecent({
        id: item.id,
        path: item.path,
        name: item.name,
        type: item.type,
      });
    }

    if (item.type === 'folder') {
      // 检测虚拟类型文件夹
      // 虚拟类型文件夹的 ID 格式为 type_{type}，如 type_notes
      if (item.id.startsWith('type_')) {
        // 解析类型：type_化学_notes -> notes
        const parts = item.id.split('_');
        const typeSegment = parts[parts.length - 1]; // 最后一段是类型
        const quickAccessType = resolveQuickAccessType(typeSegment);
        if (quickAccessType) {
          handleQuickAccessNavigate(quickAccessType);
          return;
        }
      }
      // 真实文件夹：使用 folderId 导航，传递后端返回的 path
      enterFolder(item.id, item.name, item.path);
    } else {
      if (onOpenApp) {
        const resourceItem = dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type));
        onOpenApp(resourceItem);
      }
    }
  };

  // ★ Quick Look「打开」：非文件夹优先走 onOpenPreview（全屏预览契约），
  // 未提供时回退 handleOpen（onOpenApp）；文件夹直接导航。
  const handleQuickLookOpen = (item: DstuNode) => {
    setQuickLookItem(null);
    if (item.type !== 'folder' && onOpenPreview) {
      if (currentPath.viewKind !== 'trash') {
        addRecent({ id: item.id, path: item.path, name: item.name, type: item.type });
      }
      onOpenPreview(dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type)));
      return;
    }
    handleOpen(item);
  };

  // ★ 多选 + Enter：打开全部选中项（访达语义）。
  // 文件夹无法并行导航：仅当选中项全是文件夹时进入第一个；
  // 资源打开数量设上限，避免一次 Enter 炸出几十个窗口。
  const OPEN_ALL_LIMIT = 12;
  const handleOpenMany = (itemsToOpen: DstuNode[]) => {
    const resources = itemsToOpen.filter((item) => item.type !== 'folder');
    if (resources.length === 0) {
      const firstFolder = itemsToOpen.find((item) => item.type === 'folder');
      if (firstFolder) handleOpen(firstFolder);
      return;
    }
    const toOpen = resources.slice(0, OPEN_ALL_LIMIT);
    toOpen.forEach((item) => handleOpen(item));
    if (resources.length > toOpen.length) {
      showGlobalNotification(
        'info',
        t('finder.multiSelect.openAllLimited', { count: toOpen.length, total: resources.length })
      );
    }
  };

  const handleRefresh = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (mode === 'canvas') await refreshCanvas();
    else await finderRefresh();
  }, [finderRefresh, mode, refreshCanvas]);

  // ★ 2026-06-12（审阅问题 FE-S1）：文件变更事件触发的后台刷新使用静默模式，
  // 保留当前列表展示直至新数据到达（stale-while-revalidate），不打断浏览。
  const handleSilentRefresh = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (mode === 'canvas') await refreshCanvas();
    else await finderRefresh({ silent: true });
  }, [finderRefresh, mode, refreshCanvas]);

  // ★ 监听 DSTU 资源变化，自动刷新列表（带防抖，避免批量操作时频繁刷新）
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (sessionActive === false) {
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current);
        watchDebounceRef.current = null;
      }
      return;
    }
    if (currentPath.viewKind === 'indexStatus' || currentPath.viewKind === 'memory' || currentPath.viewKind === 'desktop') {
      return;
    }

    const unwatch = dstu.watch('*', (event) => {
      if (
        event.type === 'created' ||
        event.type === 'updated' ||
        event.type === 'deleted' ||
        event.type === 'moved' ||
        event.type === 'restored' ||
        event.type === 'purged'
      ) {
        // 防抖：300ms 内多次事件只触发一次刷新
        if (watchDebounceRef.current) {
          clearTimeout(watchDebounceRef.current);
        }
        watchDebounceRef.current = setTimeout(() => {
          watchDebounceRef.current = null;
          // R2-04：内联重命名进行中延迟 silent refresh（非永久跳过），避免丢 agent 变更
          const trySilentRefresh = () => {
            // canvas 宿主有独立列表；勿被全局 fullscreen 的 inlineEdit 卡住刷新
            if (mode !== 'canvas' && finderStore.getState().inlineEdit.editingId) {
              watchDebounceRef.current = setTimeout(() => {
                watchDebounceRef.current = null;
                trySilentRefresh();
              }, 400);
              return;
            }
            handleSilentRefresh();
          };
          trySilentRefresh();
        }, 300);
      }
    });

    return () => {
      unwatch();
      if (watchDebounceRef.current) {
        clearTimeout(watchDebounceRef.current);
        watchDebounceRef.current = null;
      }
    };
  }, [sessionActive, currentPath.viewKind, handleSilentRefresh, mode, finderStore]);

  // ★ 快捷访问「收藏」徽标：接真数据（此前硬编码 0 是假徽标）。
  // 挂载时查询一次，之后跟随 DSTU 资源变化事件（收藏切换会发 updated）防抖刷新。
  // canvas 宿主不渲染快捷访问栏，跳过查询。
  useEffect(() => {
    if (mode === 'canvas' || sessionActive === false) return;

    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const fetchFavoriteCount = async () => {
      const result = await dstu.list('/', { isFavorite: true });
      if (cancelled || !isMountedRef.current) return;
      if (result.ok) {
        setFavoriteCount(result.value.length);
      }
    };

    void fetchFavoriteCount();

    const unwatch = dstu.watch('*', (event) => {
      if (
        event.type === 'created' ||
        event.type === 'updated' ||
        event.type === 'deleted' ||
        event.type === 'moved' ||
        event.type === 'restored' ||
        event.type === 'purged'
      ) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void fetchFavoriteCount();
        }, 800);
      }
    });

    return () => {
      cancelled = true;
      unwatch();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [mode, sessionActive]);

  // ★ Quick Look 与列表同步：项被删除/移出视图时关闭，改名/刷新时更新引用
  useEffect(() => {
    if (!quickLookItem) return;
    const updated = items.find((item) => item.id === quickLookItem.id);
    if (!updated) {
      setQuickLookItem(null);
    } else if (updated !== quickLookItem) {
      setQuickLookItem(updated);
    }
  }, [items, quickLookItem]);

  const ensureCreatableView = useCallback(() => {
    if (canCreateInCurrentView) {
      return true;
    }
    showGlobalNotification('warning', t('finder.create.notAllowedHere'));
    return false;
  }, [canCreateInCurrentView, t]);

  const handleNewFolder = useCallback(() => {
    if (!ensureCreatableView()) return;
    const beginDraft = () => {
      if (!isMountedRef.current) return;
      cancelInlineEdit();
      clearSelection();
      const now = Date.now();
      const pendingId = `${PENDING_FOLDER_ID_PREFIX}${++pendingFolderSequenceRef.current}`;
      const draft: PendingFolderDraft = {
        node: {
          id: pendingId,
          sourceId: pendingId,
          path: '',
          name: '',
          type: 'folder',
          createdAt: now,
          updatedAt: now,
          childCount: 0,
        },
        parentFolderId: currentCreatableFolderId,
      };
      pendingFolderDraftRef.current = draft;
      setPendingFolderDraft(draft);
      startInlineEdit(pendingId, 'folder', '');
    };

    // 连续新建时，先让旧输入框的 blur 完成提交/取消，再开始下一份草稿。
    if (pendingFolderDraftRef.current) {
      requestAnimationFrame(beginDraft);
    } else {
      beginDraft();
    }
  }, [cancelInlineEdit, clearSelection, currentCreatableFolderId, ensureCreatableView, startInlineEdit]);

  const handleNewNote = async () => {
    if (!ensureCreatableView()) return;
    // ★ 2025-12-13: 改为与题目集/翻译/作文一致，直接创建空笔记
    const result = await createEmpty({
      type: 'note',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.noteSuccess'));
      handleRefresh();
      // 打开右侧应用面板
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'note'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const importMarkdownPathNotes = useCallback(async (
    filePaths: string[],
    folderId: string | null = currentCreatableFolderId,
  ) => {
    if (filePaths.length === 0) {
      return { importedNodes: [] as DstuNode[], failedCount: 0, firstError: null as string | null, failedFiles: [] as string[] };
    }

    const result = await notesDstuAdapter.importMarkdownFiles(
      filePaths.map((filePath) => ({
        filePath,
        titleHint: extractDisplayFileName(filePath),
      })),
      folderId,
    );

    if (!result.ok) {
      return {
        importedNodes: [] as DstuNode[],
        failedCount: filePaths.length,
        firstError: result.error.toUserMessage(),
        failedFiles: filePaths.map((filePath) => extractDisplayFileName(filePath)),
      };
    }

    return {
      importedNodes: result.value.imported,
      failedCount: result.value.failed.length,
      firstError: result.value.failed[0]?.message ?? null,
      failedFiles: result.value.failed.map((item) => extractDisplayFileName(item.file_path)),
    };
  }, [currentCreatableFolderId]);

  const importMarkdownFileObjects = useCallback(async (
    files: File[],
    folderId: string | null = currentCreatableFolderId,
  ) => {
    if (files.length === 0) {
      return { importedNodes: [] as DstuNode[], failedCount: 0, firstError: null as string | null, failedFiles: [] as string[] };
    }

    const limit = pLimit(3);
    const results = await Promise.all(
      files.map((file) => limit(async () => {
        try {
          const content = await file.text();
          const result = await notesDstuAdapter.importMarkdownContent(file.name, content, folderId);
          return { fileName: file.name, result };
        } catch (error) {
          return {
            fileName: file.name,
            result: err(new VfsError(
              VfsErrorCode.UNKNOWN,
              error instanceof Error ? error.message : t('finder.markdownImport.failed'),
            )),
          };
        }
      }))
    );

    const importedNodes: DstuNode[] = [];
    let failedCount = 0;
    let firstError: string | null = null;
    const failedFiles: string[] = [];

    for (const { fileName, result } of results) {
      if (result.ok) {
        importedNodes.push(result.value);
      } else {
        failedCount += 1;
        firstError ??= result.error.toUserMessage();
        failedFiles.push(fileName);
      }
    }

    return { importedNodes, failedCount, firstError, failedFiles };
  }, [currentCreatableFolderId, t]);

  const notifyMarkdownImportResult = useCallback((
    importedCount: number,
    failedCount: number,
    failedFiles: string[],
    firstError?: string | null,
  ) => {
    const failedFileSummary = summarizeFailedMarkdownFiles(failedFiles);
    const failedFilesText = failedFileSummary
      ? t('finder.markdownImport.failedFiles', { names: failedFileSummary })
      : null;

    if (importedCount > 0 && failedCount === 0) {
      showGlobalNotification('success', t('finder.markdownImport.success', { count: importedCount }));
      return;
    }

    if (importedCount > 0) {
      const baseMessage = t('finder.markdownImport.partial', {
        success: importedCount,
        failed: failedCount,
      });
      showGlobalNotification('warning', failedFilesText ? `${baseMessage}；${failedFilesText}` : baseMessage);
      return;
    }

    const baseError = firstError || t('finder.markdownImport.failed');
    showGlobalNotification('error', failedFilesText ? `${baseError}；${failedFilesText}` : baseError);
  }, [t]);

  const openImportedMarkdownNote = useCallback((node: DstuNode | null) => {
    if (!node || !onOpenApp) {
      return;
    }
    onOpenApp(dstuNodeToResourceListItem(node, 'note'));
  }, [onOpenApp]);

  const handleImportMarkdownNote = useCallback(async (folderId: string | null = currentCreatableFolderId) => {
    if (!ensureCreatableView()) return;

    try {
      const selected = await dialogOpen({
        multiple: true,
        filters: [{
          name: t('finder.markdownImport.filterName'),
          extensions: ['md', 'markdown'],
        }],
        title: t('finder.markdownImport.selectFiles'),
      });

      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        return;
      }

      const filePaths = Array.isArray(selected) ? selected : [selected];
      const { importedNodes, failedCount, firstError, failedFiles } = await importMarkdownPathNotes(filePaths, folderId);

      if (!isMountedRef.current) return;

      if (importedNodes.length > 0) {
        handleRefresh();
        openImportedMarkdownNote(importedNodes[0] ?? null);
      }

      notifyMarkdownImportResult(importedNodes.length, failedCount, failedFiles, firstError);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : t('finder.markdownImport.failed'));
    }
  }, [currentCreatableFolderId, ensureCreatableView, handleRefresh, importMarkdownPathNotes, notifyMarkdownImportResult, openImportedMarkdownNote, t]);

  // ★ 记忆系统改造：拦截"记忆"入口，导航到记忆根文件夹
  const handleQuickAccessNavigate = useCallback(async (type: QuickAccessType) => {
    if (type === 'memory') {
      try {
        const config = await getMemoryConfig();
        if (config.memoryRootFolderId) {
          // 记忆根文件夹已配置，直接导航到该文件夹
          enterFolder(config.memoryRootFolderId, config.memoryRootFolderTitle || t('memory.defaultRootTitle'));
          return;
        }
      } catch (e) {
        console.warn('[LearningHub] Failed to get memory config, falling back to MemoryView:', e);
      }
      // 未配置根文件夹或获取失败，回退到 MemoryView（用于引导设置）
    }
    quickAccessNavigate(type);
  }, [enterFolder, quickAccessNavigate, t]);

  const focusSearchInput = useCallback(() => {
    setQuickAccessCollapsed(false);
    if (isSmallScreen) {
      setMobileSearchExpanded(true);
    }
    window.setTimeout(() => {
      const input = (quickAccessPortalTarget ?? containerRef.current)?.querySelector<HTMLInputElement>('input[type="search"]');
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }, [isSmallScreen, quickAccessPortalTarget]);

  useCommandEvents(
    {
      'learningHub:create-folder': () => {
        handleNewFolder();
      },
      'learningHub:focus-search': () => {
        focusSearchInput();
      },
    },
    commandEventsEnabled,
  );

  const handleNewExam = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空题目集文件并打开应用面板
    const result = await createEmpty({
      type: 'exam',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.examSuccess'));
      handleRefresh();
      // 打开右侧应用面板
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'exam'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewTextbook = async () => {
    if (!ensureCreatableView()) return;
    if (importProgress.isImporting) return; // 防止重复点击
    
    let unlisten: UnlistenFn | null = null;
    
    try {
      // 打开文件选择对话框
      const selected = await dialogOpen({
        multiple: true,
        filters: [
          {
            name: t('textbook.allDocuments'),
      // 注：doc（旧版办公文档格式）不支持，无纯 Rust 解析库
            extensions: [
              'pdf', 'docx', 'txt', 'md', 'html', 'htm',
              'xlsx', 'xls', 'xlsb', 'ods',
              'pptx', 'epub', 'rtf',
              'csv', 'json', 'xml',
            ],
          },
          {
            name: t('textbook.pdfDocuments'),
            extensions: ['pdf'],
          },
          {
            name: t('textbook.wordDocuments'),
            extensions: ['docx'],
          },
          {
            name: t('textbook.excelFiles'),
            extensions: ['xlsx', 'xls', 'xlsb', 'ods', 'csv'],
          },
          {
            name: t('textbook.textFiles'),
            extensions: ['txt', 'md', 'html', 'htm'],
          },
          {
            name: t('textbook.presentationFiles'),
            extensions: ['pptx', 'epub', 'rtf'],
          },
          {
            name: t('textbook.dataFiles'),
            extensions: ['json', 'xml'],
          },
        ],
        title: t('textbook.selectFiles'),
      });

      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        return; // 用户取消选择
      }

      const filePaths = Array.isArray(selected) ? selected : [selected];
      const firstFileName = filePaths[0] ? extractDisplayFileName(filePaths[0]) : 'textbook.pdf';
      
      // 显示导入进度模态框
      setImportProgress({
        isImporting: true,
        fileName: firstFileName,
        stage: 'hashing',
        progress: 0,
      });

      // 🆕 监听后端进度事件，实时更新模态框
      debugLog.log('[LearningHub] 🎧 开始监听 textbook-import-progress 事件');
      unlisten = await listen<TextbookImportProgress>('textbook-import-progress', (event) => {
        const { file_name, stage, current_page, total_pages, progress, error } = event.payload;
        
        debugLog.log('[LearningHub] 📥 收到进度事件:', { file_name, stage, current_page, total_pages, progress, error });
        
        // 更新模态框状态
        setImportProgress(prev => ({
          ...prev,
          fileName: file_name,
          stage: stage as ImportStage,
          currentPage: current_page,
          totalPages: total_pages,
          progress,
          error,
        }));
      });

      // ★ M-fix: 传递当前文件夹ID，使文件导入到当前浏览的文件夹中
      const targetFolderId = currentCreatableFolderId;
      const result = await textbookDstuAdapter.addTextbooks(filePaths, targetFolderId);

      // ★ MEDIUM-005: 检查组件是否已卸载
      if (!isMountedRef.current) return;

      // 取消事件监听
      if (unlisten) {
        debugLog.log('[LearningHub] 🔇 停止监听 textbook-import-progress 事件');
        unlisten();
        unlisten = null;
      }

      if (result.ok && result.value.length > 0) {
        // 显示完成状态
        setImportProgress(prev => ({
          ...prev,
          stage: 'done',
          progress: 100,
        }));
        
        // 延迟关闭模态框，让用户看到完成状态
        setTimeout(() => {
          if (isMountedRef.current) {
            setImportProgress(prev => ({ ...prev, isImporting: false }));
            handleRefresh();
            // 打开第一个导入的教材
            if (onOpenApp && result.value[0]) {
              onOpenApp(dstuNodeToResourceListItem(result.value[0], 'textbook'));
            }
          }
        }, 800);
      } else if (result.ok && result.value.length === 0) {
        // ★ Android 修复：优先使用后端通过 progress 事件发送的具体错误信息
        // 避免通用的"没有成功导入任何教材"覆盖更有诊断价值的具体原因
        setImportProgress(prev => ({
          ...prev,
          stage: 'error',
          error: prev.error || t('textbook.importEmpty'),
        }));
      } else if (!result.ok) {
        setImportProgress(prev => ({
          ...prev,
          stage: 'error',
          error: result.error.toUserMessage(),
        }));
      }
    } catch (err) {
      // 清理
      if (unlisten) unlisten();
      debugLog.error('[LearningHubSidebar] handleNewTextbook error:', err);
      setImportProgress(prev => ({
        ...prev,
        stage: 'error',
        error: t('textbook.importError'),
      }));
    }
  };

  const handleNewTranslation = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空翻译文件并打开应用面板
    const result = await createEmpty({
      type: 'translation',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.translationSuccess'));
      handleRefresh();
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'translation'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewEssay = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空作文文件并打开应用面板
    const result = await createEmpty({
      type: 'essay',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.essaySuccess'));
      handleRefresh();
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'essay'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewMindMap = async () => {
    if (!ensureCreatableView()) return;
    // ★ 创建空思维导图文件并打开应用面板
    const result = await createEmpty({
      type: 'mindmap',
      folderId: currentCreatableFolderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.mindmapSuccess'));
      handleRefresh();
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'mindmap'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  /**
   * 处理 Tauri 原生文件路径拖拽（优先路径，性能更好）
   * 按扩展名分类后分发到对应适配器
   */
  const handlePathsDrop = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    // 回收站/特殊视图不允许拖入
    if (isDragDropBlockedView(currentPath)) {
      showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere'));
      return;
    }
    // 统一导入主链路：本次拖拽已走路径分支，后续 files 回调直接跳过。
    pathsDropHandledRef.current = true;
    if (importProgress.isImporting) return;

    debugLog.log('[LearningHub] 拖拽导入文件:', paths.length, '个文件');

    const shouldImportMarkdownAsNotes = currentQuickAccessType === 'notes';

    // 按类型分组
    const docPaths: string[] = [];
    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
      flashcards: [],
      mindmap: [],
    };

    for (const p of paths) {
      const name = extractFileName(p);
      const ext = getFileExtension(name);
      const guidance = MODULE_GUIDANCE_EXTENSIONS[ext];
      if (guidance) {
        // ★ P3 引导：apkg/xmind 等不进资源库，提示到对应模块导入
        guidanceNames[guidance].push(name);
        continue;
      }
      if (DOCUMENT_EXTENSIONS.has(ext)) {
        docPaths.push(p);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        imagePaths.push(p);
      } else {
        otherPaths.push(p);
      }
    }

    if (guidanceNames.flashcards.length > 0) {
      showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
        names: guidanceNames.flashcards.join('、'),
      }));
    }
    if (guidanceNames.mindmap.length > 0) {
      showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
        names: guidanceNames.mindmap.join('、'),
      }));
    }
    if (docPaths.length === 0 && imagePaths.length === 0 && otherPaths.length === 0) {
      return;
    }

    debugLog.log('[LearningHub] 文件分类:', {
      documents: docPaths.length,
      images: imagePaths.length,
      others: otherPaths.length,
      markdownAsNotes: shouldImportMarkdownAsNotes,
    });

    const { markdownItems: markdownNotePaths, otherItems: textbookPaths } = partitionMarkdownNoteImports(
      docPaths,
      (path) => extractFileName(path),
      shouldImportMarkdownAsNotes,
    );

    let totalSuccess = 0;
    let totalFailed = 0;
    let unlisten: UnlistenFn | null = null;
    let firstImportedNode: DstuNode | null = null;
    // ★ 2026-07-20：失败文件明细（文件名 + 具体原因），toast 不再只报笼统"导入失败"
    const failedDetails: { name: string; reason?: string }[] = [];

    try {
      const dropTargetFolderId = currentCreatableFolderId;

      if (markdownNotePaths.length > 0) {
        const markdownResult = await importMarkdownPathNotes(markdownNotePaths, dropTargetFolderId);

        if (!isMountedRef.current) return;

        totalSuccess += markdownResult.importedNodes.length;
        totalFailed += markdownResult.failedCount;
        firstImportedNode = markdownResult.importedNodes[0] ?? firstImportedNode;

        if (markdownResult.importedNodes.length === 0 && markdownResult.failedCount > 0) {
          debugLog.error('[LearningHub] Markdown 笔记导入失败:', markdownResult.firstError);
        }
      }

      // 1. 文档类：通过 textbookDstuAdapter 导入（支持 PDF 渲染、哈希去重等）
      if (textbookPaths.length > 0) {
        const firstFileName = textbookPaths[0] ? extractDisplayFileName(textbookPaths[0]) : '';
        setImportProgress({
          isImporting: true,
          fileName: firstFileName,
          stage: 'hashing',
          progress: 0,
        });

        // 监听后端进度事件
        unlisten = await listen<TextbookImportProgress>('textbook-import-progress', (event) => {
          const { file_name, stage, current_page, total_pages, progress, error: progressError } = event.payload;
          setImportProgress(prev => ({
            ...prev,
            fileName: file_name,
            stage: stage as ImportStage,
            currentPage: current_page,
            totalPages: total_pages,
            progress,
            error: progressError,
          }));
        });

        const docResult = await textbookDstuAdapter.addTextbooks(textbookPaths, dropTargetFolderId);

        if (unlisten) { unlisten(); unlisten = null; }

        if (!isMountedRef.current) return;

        if (docResult.ok) {
          totalSuccess += docResult.value.length;
          if (!firstImportedNode) {
            firstImportedNode = docResult.value[0] ?? null;
          }
        } else {
          totalFailed += textbookPaths.length;
          debugLog.error('[LearningHub] 文档导入失败:', docResult.error.toUserMessage());
        }

        setImportProgress(prev => ({ ...prev, isImporting: false }));
      }

      // 2. 图片类/其他文件：通过 attachmentDstuAdapter 创建
      const attachmentPaths = [...imagePaths, ...otherPaths];
      if (attachmentPaths.length > 0) {
        // 使用 convertFileSrc + fetch 读取本地文件
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        const limit = pLimit(3);

        // ★ 2026-06-12（审阅问题 FE-M5）：批量导入显示进度横幅
        if (attachmentPaths.length > 1) {
          setAttachImportProgress({ done: 0, total: attachmentPaths.length });
        }

        const attachResults = await Promise.all(
          attachmentPaths.map((filePath) =>
            limit(async () => {
              const name = extractFileName(filePath);
              const ext = getFileExtension(name);
              const isImage = IMAGE_EXTENSIONS.has(ext);

              try {
                const url = convertFileSrc(filePath);
                const res = await fetch(url);
                if (!res.ok) {
                  return { ok: false as const, name, reason: t('finder.dragDrop.readFileFailed') };
                }

                const blob = await res.blob();
                const file = new File([blob], name, {
                  type: blob.type || (isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'),
                });

                const result = await attachmentDstuAdapter.create(
                  file,
                  isImage ? 'image' : 'file',
                  currentCreatableFolderId ? { folderId: currentCreatableFolderId } : undefined,
                );
                if (!result.ok) {
                  // ★ 携带后端结构化拒绝原因（如"不支持的文件类型 .xyz"）
                  return { ok: false as const, name, reason: result.error.toUserMessage() };
                }
                return { ok: true as const, name };
              } catch (e) {
                debugLog.error('[LearningHub] 附件导入失败:', name, e);
                return {
                  ok: false as const,
                  name,
                  reason: e instanceof Error ? e.message : undefined,
                };
              } finally {
                if (isMountedRef.current) {
                  setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
                }
              }
            })
          )
        );

        if (!isMountedRef.current) return;
        setAttachImportProgress(null);

        for (const r of attachResults) {
          if (r.ok) totalSuccess++;
          else {
            totalFailed++;
            failedDetails.push({ name: r.name, reason: r.reason });
          }
        }
      }

      // 3. 显示结果通知（失败时附具体文件与原因，最多 3 条）
      const failedSummary = failedDetails.length > 0
        ? t('finder.dragDrop.importFailedFiles', {
            names: failedDetails
              .slice(0, 3)
              .map((f) => (f.reason ? `${f.name}（${f.reason}）` : f.name))
              .join('；'),
          })
        : undefined;
      if (totalSuccess > 0 && totalFailed === 0) {
        showGlobalNotification('success',
          t('finder.dragDrop.importSuccess', { count: totalSuccess })
        );
      } else if (totalSuccess > 0 && totalFailed > 0) {
        showGlobalNotification('warning',
          t('finder.dragDrop.importPartial', {
            success: totalSuccess,
            failed: totalFailed,
          }),
          failedSummary
        );
      } else if (totalFailed > 0) {
        showGlobalNotification('error',
          t('finder.dragDrop.importFailed'),
          failedSummary
        );
      }

      // 4. 刷新文件列表
      if (totalSuccess > 0) {
        handleRefresh();
        if (firstImportedNode) {
          if (firstImportedNode.type === 'note') {
            openImportedMarkdownNote(firstImportedNode);
          } else if (onOpenApp) {
            onOpenApp(dstuNodeToResourceListItem(firstImportedNode, 'textbook'));
          }
        }
      }
    } catch (error) {
      if (unlisten) unlisten();
      debugLog.error('[LearningHub] 拖拽导入异常:', error);
      setImportProgress(prev => ({ ...prev, isImporting: false }));
      setAttachImportProgress(null);
      showGlobalNotification('error', t('finder.dragDrop.importFailed'));
    }
  }, [currentCreatableFolderId, currentPath, currentQuickAccessType, importMarkdownPathNotes, importProgress.isImporting, openImportedMarkdownNote, t, handleRefresh, onOpenApp]);

  /**
   * 处理浏览器 File 对象拖拽（非 Tauri 环境兜底）
   */
  const handleFilesDrop = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (consumePathsDropHandledFlag(pathsDropHandledRef)) {
      debugLog.log('[LearningHub] 跳过 files 回调，统一走 paths 导入链路');
      return;
    }
    if (isDragDropBlockedView(currentPath)) {
      showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere'));
      return;
    }

    debugLog.log('[LearningHub] 浏览器拖拽导入:', files.length, '个文件');

    // ★ P3 引导：apkg/xmind 等不进资源库，提示到对应模块导入
    const guidanceNames: Record<'flashcards' | 'mindmap', string[]> = {
      flashcards: [],
      mindmap: [],
    };
    const importableFiles = files.filter((file) => {
      const guidance = MODULE_GUIDANCE_EXTENSIONS[getFileExtension(file.name)];
      if (guidance) {
        guidanceNames[guidance].push(file.name);
        return false;
      }
      return true;
    });
    if (guidanceNames.flashcards.length > 0) {
      showGlobalNotification('info', t('finder.dragDrop.guidanceFlashcards', {
        names: guidanceNames.flashcards.join('、'),
      }));
    }
    if (guidanceNames.mindmap.length > 0) {
      showGlobalNotification('info', t('finder.dragDrop.guidanceMindmap', {
        names: guidanceNames.mindmap.join('、'),
      }));
    }
    if (importableFiles.length === 0) return;

    const shouldImportMarkdownAsNotes = currentQuickAccessType === 'notes';
    const { markdownItems: markdownFiles, otherItems: attachmentFiles } = partitionMarkdownNoteImports(
      importableFiles,
      (file) => file.name,
      shouldImportMarkdownAsNotes,
    );

    let totalSuccess = 0;
    let totalFailed = 0;
    const limit = pLimit(3);
    let firstImportedNode: DstuNode | null = null;

    if (markdownFiles.length > 0) {
      const markdownResult = await importMarkdownFileObjects(markdownFiles, currentCreatableFolderId);
      if (!isMountedRef.current) return;

      totalSuccess += markdownResult.importedNodes.length;
      totalFailed += markdownResult.failedCount;
      firstImportedNode = markdownResult.importedNodes[0] ?? null;
    }

    // ★ 2026-06-12（审阅问题 FE-M5）：批量导入显示进度横幅
    if (attachmentFiles.length > 1) {
      setAttachImportProgress({ done: 0, total: attachmentFiles.length });
    }

    const results = await Promise.all(
      attachmentFiles.map((file) =>
        limit(async () => {
          const ext = getFileExtension(file.name);
          const isImage = IMAGE_EXTENSIONS.has(ext);

          try {
            // ★ 2026-06-12（审阅问题 FE-M1）：传递当前文件夹 ID，
            // 修复浏览器拖入的附件总是落到根目录的问题（Tauri paths 链路本就正确）。
            const result = await attachmentDstuAdapter.create(
              file,
              isImage ? 'image' : 'file',
              currentCreatableFolderId ? { folderId: currentCreatableFolderId } : undefined,
            );
            if (!result.ok) {
              return { ok: false as const, name: file.name, reason: result.error.toUserMessage() };
            }
            return { ok: true as const, name: file.name };
          } catch (e) {
            return {
              ok: false as const,
              name: file.name,
              reason: e instanceof Error ? e.message : undefined,
            };
          } finally {
            if (isMountedRef.current) {
              setAttachImportProgress(p => (p ? { ...p, done: p.done + 1 } : p));
            }
          }
        })
      )
    );

    if (!isMountedRef.current) return;
    setAttachImportProgress(null);

    const failedDetails: { name: string; reason?: string }[] = [];
    for (const r of results) {
      if (r.ok) totalSuccess++;
      else {
        totalFailed++;
        failedDetails.push({ name: r.name, reason: r.reason });
      }
    }

    // ★ 失败时附具体文件与原因（最多 3 条），不再只报笼统"导入失败"
    const failedSummary = failedDetails.length > 0
      ? t('finder.dragDrop.importFailedFiles', {
          names: failedDetails
            .slice(0, 3)
            .map((f) => (f.reason ? `${f.name}（${f.reason}）` : f.name))
            .join('；'),
        })
      : undefined;
    if (totalSuccess > 0 && totalFailed === 0) {
      showGlobalNotification('success',
        t('finder.dragDrop.importSuccess', { count: totalSuccess })
      );
    } else if (totalSuccess > 0) {
      showGlobalNotification('warning',
        t('finder.dragDrop.importPartial', {
          success: totalSuccess,
          failed: totalFailed,
        }),
        failedSummary
      );
    } else if (totalFailed > 0) {
      showGlobalNotification('error', t('finder.dragDrop.importFailed'), failedSummary);
    }

    if (totalSuccess > 0) {
      handleRefresh();
      if (firstImportedNode) {
        openImportedMarkdownNote(firstImportedNode);
      }
    }
  }, [currentCreatableFolderId, currentPath, currentQuickAccessType, handleRefresh, importMarkdownFileObjects, openImportedMarkdownNote, t]);

  // 是否允许拖拽导入（排除回收站、特殊视图等）
  const isDragDropEnabled = mode !== 'canvas' && canDragDropInCurrentView;

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, item: DstuNode) => {
    if (isPendingFolderId(item.id)) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到容器，避免触发空白区域菜单
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    
    if (item.type === 'folder') {
      // 构造符合 FolderTreeNode 类型的对象
      const folderNode: FolderTreeNode = {
        folder: {
          id: item.id,
          parentId: currentPath.folderId,
          title: item.name,
          isExpanded: false,
          sortOrder: 0,
          createdAt: item.createdAt || Date.now(),
          updatedAt: item.updatedAt,
        },
        children: [],
        items: [],
      };
      setContextMenuTarget({ 
        type: 'folder', 
        folder: folderNode
      });
    } else {
      // Map to ResourceListItem（共用映射：此前这里漏掉 image/file，导致附件右键动作按 note 处理）
      const resourceItem = dstuNodeToResourceListItem(item, mapDstuTypeToFolderItemType(item.type));
      setContextMenuTarget({ type: 'resource', resource: resourceItem });
    }
    setContextMenuOpen(true);
  };

  const handleContainerContextMenu = (e: React.MouseEvent) => {
    // 移除 e.target === e.currentTarget 检查，因为虚拟滚动列表内部的空白区域可能不是容器本身
    // 项的右键已通过 handleContextMenu 处理并调用 stopPropagation 阻止冒泡
    e.preventDefault();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setContextMenuTarget({ type: 'empty' });
    setContextMenuOpen(true);
  };

  // 右键菜单 - 进入文件夹
  const handleOpenFolder = useCallback((folderId: string) => {
    const folder = items.find(i => i.id === folderId && i.type === 'folder');
    if (folder) {
      // ★ 27-DSTU统一虚拟路径架构改造：传递后端返回的 path
      enterFolder(folderId, folder.name, folder.path);
    }
  }, [items, enterFolder]);

  // ★ LH-UNDO：软删成功 toast + Undo → trashApi.restoreItem
  const showSoftDeleteUndoToast = useCallback((
    targets: SoftDeleteTarget[],
    opts?: { refCount?: number }
  ) => {
    if (targets.length === 0) return;
    const generation = ++softDeleteUndoGenRef.current;

    // ★ 悬挂引用清理：资源/文件夹入回收站即移除对应桌面快捷方式；
    // 快照被移除的快捷方式，Undo 恢复资源时原样放回（不丢用户桌面布局）。
    const prunedShortcuts = useDesktopStore
      .getState()
      .pruneShortcutsForTargets(targets.map((target) => target.id));

    const message = opts?.refCount && opts.refCount > 0
      ? t('finder.movedToTrashWithRefs', { count: opts.refCount })
      : targets.length === 1
        ? t('finder.movedToTrash')
        : t('finder.batchMovedToTrash', { count: targets.length });

    showGlobalNotification('success', message, undefined, {
      action: {
        label: t('finder.undo'),
        onClick: () => {
          void (async () => {
            if (generation !== softDeleteUndoGenRef.current || softDeleteUndoInFlightRef.current) {
              return;
            }
            softDeleteUndoInFlightRef.current = true;
            const limit = pLimit(3);
            try {
              const results = await Promise.all(
                targets.map((target) =>
                  limit(async () => trashApi.restoreItem(target.id, target.type))
                )
              );
              // 恢复成功的目标：放回其桌面快捷方式
              if (prunedShortcuts.length > 0) {
                const restoredIds = new Set(
                  targets.filter((_, index) => results[index]?.ok).map((target) => target.id)
                );
                useDesktopStore.getState().restoreShortcuts(
                  prunedShortcuts.filter((shortcut) => {
                    const targetId = shortcut.target.resourceId ?? shortcut.target.folderId;
                    return targetId != null && restoredIds.has(targetId);
                  })
                );
              }
              if (!isMountedRef.current) return;
              const failed = results.filter((r) => !r.ok).length;
              if (failed === 0) {
                showGlobalNotification('success', t('finder.restored'));
              } else if (failed < results.length) {
                showGlobalNotification('warning', t('finder.trash.restoreSuccess'));
              } else {
                const firstErr = results.find((r) => !r.ok);
                showGlobalNotification(
                  'error',
                  firstErr && !firstErr.ok
                    ? firstErr.error.toUserMessage()
                    : t('finder.trash.restoreSuccess')
                );
              }
              await handleRefresh();
            } finally {
              softDeleteUndoInFlightRef.current = false;
            }
          })();
        },
      },
    });
  }, [t, handleRefresh]);

  // 右键菜单 - 删除文件夹（软删除到回收站，无需确认 + Undo）
  const handleDeleteFolder = useCallback(async (folderId: string) => {
    if (!canDeleteInCurrentView) return;
    const folder = items.find((i) => i.id === folderId);
    const result = await folderApi.deleteFolder(folderId);

    if (!isMountedRef.current) return;

    if (result.ok) {
      showSoftDeleteUndoToast([{
        id: folderId,
        type: 'folder',
        name: folder?.name || folderId,
      }]);
      handleRefresh();
    } else {
      reportError(result.error, 'delete folder');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [canDeleteInCurrentView, items, handleRefresh, showSoftDeleteUndoToast]);

  // 右键菜单 - 删除资源（软删除，无确认；有引用时仅警告文案 + Undo）
  const handleDeleteResource = useCallback(async (resource: ResourceListItem) => {
    if (!canDeleteInCurrentView) return;

    const { getResourceRefCountV2 } = await import('@/features/chat/context/vfsRefApi');
    const refCountResult = await getResourceRefCountV2(resource.id);
    const refCount = refCountResult.ok ? refCountResult.value : 0;

    let deletePath = resource.path;
    if (!deletePath) {
      const item = items.find(i => i.id === resource.id);
      deletePath = item?.path;
    }
    if (!deletePath) {
      deletePath = `/${resource.id}`;
    }
    if (!deletePath) {
      showGlobalNotification('error', t('contextMenu.deleteError'));
      return;
    }

    const deleteResult = await dstu.delete(deletePath);
    if (!isMountedRef.current) return;

    if (deleteResult.ok) {
      showSoftDeleteUndoToast(
        [{ id: resource.id, type: resource.type, name: resource.title }],
        { refCount }
      );
      handleRefresh();
    } else {
      reportError(deleteResult.error, 'delete resource');
      showGlobalNotification('error', deleteResult.error.toUserMessage());
    }
  }, [canDeleteInCurrentView, items, t, handleRefresh, showSoftDeleteUndoToast]);

  // P1-14: 右键菜单 - 收藏/取消收藏资源
  const handleToggleFavorite = useCallback(async (resource: ResourceListItem) => {
    // 获取资源路径
    let resourcePath = resource.path;
    if (!resourcePath) {
      const item = items.find(i => i.id === resource.id);
      resourcePath = item?.path;
    }

    if (!resourcePath) {
      showGlobalNotification('error', t('contextMenu.favoriteError'));
      return;
    }

    // 切换收藏状态
    const newFavoriteState = !resource.isFavorite;
    const result = await dstu.setFavorite(resourcePath, newFavoriteState);

    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success',
        newFavoriteState
          ? t('contextMenu.favoriteSuccess')
          : t('contextMenu.unfavoriteSuccess')
      );
      handleRefresh();
    } else {
      reportError(result.error, 'toggle favorite');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [items, t, handleRefresh]);

  // 右键菜单 - 导出资源
  // ★ 2026-07-08：实现抽取到 utils/exportResource.ts，与命令面板「导出当前笔记」共用
  const handleExportResource = useCallback(async (resource: ResourceListItem) => {
    await exportResourceById(resource.id, t);
  }, [t]);

  // 右键菜单 - 文件夹批量导出为 ZIP（后端遍历子资源打包）
  const handleExportFolder = useCallback(async (folderId: string) => {
    await exportResourceById(folderId, t);
  }, [t]);

  // 右键菜单 - 开始文件夹内联编辑
  const handleOpenRenameDialog = useCallback((folderId: string) => {
    const folder = items.find(i => i.id === folderId);
    if (folder) {
      startInlineEdit(folderId, 'folder', folder.name);
    }
  }, [items, startInlineEdit]);

  // 右键菜单 - 开始资源内联编辑
  const handleOpenRenameResourceDialog = useCallback((resource: ResourceListItem) => {
    startInlineEdit(resource.id, 'resource', resource.title);
  }, [startInlineEdit]);

  // 内联编辑确认处理
  const handleInlineEditConfirm = useCallback(async (itemId: string, newName: string) => {
    if (!newName.trim()) {
      if (isPendingFolderId(itemId)) {
        if (pendingFolderDraftRef.current?.node.id !== itemId) return;
        pendingFolderDraftRef.current = null;
        setPendingFolderDraft(null);
      }
      cancelInlineEdit();
      return;
    }

    if (isPendingFolderId(itemId)) {
      const draft = pendingFolderDraftRef.current;
      // 旧输入框的延迟 blur 不得提交或清除后来创建的新草稿。
      if (!draft || draft.node.id !== itemId) return;

      cancelInlineEdit();
      pendingFolderDraftRef.current = null;
      setPendingFolderDraft(null);
      const result = await folderApi.createFolder(
        newName.trim(),
        draft.parentFolderId ?? undefined
      );

      if (!isMountedRef.current) return;
      if (result.ok) {
        showGlobalNotification('success', t('finder.create.folderSuccess'));
        await handleRefresh();
      } else {
        reportError(result.error, 'create folder');
        showGlobalNotification('error', result.error.toUserMessage());
      }
      return;
    }

    const item = items.find(i => i.id === itemId);
    if (!item) {
      cancelInlineEdit();
      return;
    }

    // 如果名称没有变化，直接取消
    if (newName.trim() === item.name) {
      cancelInlineEdit();
      return;
    }

    // 保存编辑类型（因为 cancelInlineEdit 会重置它）
    const editingType = inlineEdit.editingType;

    // 先取消编辑状态，避免 UI 闪烁
    cancelInlineEdit();

    let renameResult;

    if (editingType === 'folder') {
      // 重命名文件夹
      renameResult = await folderApi.renameFolder(itemId, newName.trim());
    } else {
      // 重命名资源 - 使用 DSTU rename API
      const resourcePath = item.path;
      if (!resourcePath) {
        showGlobalNotification('error', t('contextMenu.renameError'));
        if (isMountedRef.current) {
          await handleRefresh();
        }
        return;
      }
      renameResult = await dstu.rename(resourcePath, newName.trim());
    }

    // ★ Cmd+Z 撤销：记录重命名（组件卸载与否不影响入栈）
    if (renameResult.ok && mode !== 'canvas') {
      finderUndoStack.push({
        kind: 'rename',
        targetType: editingType === 'folder' ? 'folder' : 'resource',
        id: itemId,
        path: item.path ?? null,
        oldName: item.name,
        newName: newName.trim(),
      });
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (renameResult.ok) {
      showGlobalNotification('success', t('contextMenu.renameSuccess'));
      await handleRefresh();
    } else {
      reportError(renameResult.error, 'rename');
      showGlobalNotification('error', renameResult.error.toUserMessage());
      // 出错时也需要刷新以恢复原始状态
      await handleRefresh();
    }
  }, [items, inlineEdit.editingType, t, handleRefresh, cancelInlineEdit, mode]);

  // 内联编辑取消处理
  const handleInlineEditCancel = useCallback((itemId: string) => {
    if (isPendingFolderId(itemId)) {
      if (pendingFolderDraftRef.current?.node.id !== itemId) return;
      pendingFolderDraftRef.current = null;
      setPendingFolderDraft(null);
    }
    if (finderStore.getState().inlineEdit.editingId === itemId) {
      cancelInlineEdit();
    }
  }, [cancelInlineEdit, finderStore]);

  useEffect(() => {
    if (!pendingFolderDraft) return;
    setPendingFolderDraft(null);
    pendingFolderDraftRef.current = null;
    if (isPendingFolderId(finderStore.getState().inlineEdit.editingId)) {
      cancelInlineEdit();
    }
    // 路径变化后草稿不应跟随到另一个文件夹。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPathDisplay]);

  const displayedItems = useMemo(
    () => pendingFolderDraft ? [pendingFolderDraft.node, ...items] : items,
    [items, pendingFolderDraft]
  );

  // ★ Cmd+Z 撤销：仅当来源文件夹可确定时记录移动操作。
  // 文件夹视图的非搜索列表 = 当前文件夹的直接子项，来源即 folderId；
  // 收藏/最近/搜索结果里的项来源未知（path 是名称链，无 ID），不记录。
  const canRecordMoveUndo =
    mode !== 'canvas' && effectivePath.viewKind === 'folder' && !isSearching;
  const moveUndoSourceFolderId = effectivePath.folderId;

  // 拖拽移动单个项目
  const handleMoveItem = useCallback(async (itemId: string, targetFolderId: string | null) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    // 根据类型调用不同的移动 API
    let result;
    if (item.type === 'folder') {
      result = await folderApi.moveFolder(itemId, targetFolderId ?? undefined);
    } else {
      // 非文件夹使用 moveItem（共用映射，P1-13 image/file 支持随之保留）
      result = await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), itemId, targetFolderId ?? undefined);
    }

    if (result.ok && canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
      finderUndoStack.push({
        kind: 'move',
        entries: [{
          id: itemId,
          isFolder: item.type === 'folder',
          itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
          fromFolderId: moveUndoSourceFolderId,
        }],
        toFolderId: targetFolderId,
      });
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.batch.moveSuccess'));
      handleRefresh();
    } else {
      reportError(result.error, 'move item');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [items, t, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  // 拖拽移动多个项目（多选拖拽）
  const handleMoveItems = useCallback(async (itemIds: string[], targetFolderId: string | null) => {
    if (itemIds.length === 0) return;

    // ★ 并发控制：限制同时执行的移动操作为 3 个，避免文件系统操作冲突
    const limit = pLimit(3);
    const moveResults = await Promise.all(itemIds.map((itemId) =>
      limit(async () => {
        const item = items.find(i => i.id === itemId);
        if (!item) {
          const notFoundError = new VfsError(
            VfsErrorCode.NOT_FOUND,
            t('error.itemNotFound'),
            true,
            { itemId }
          );
          return err(notFoundError);
        }

        if (item.type === 'folder') {
          return await folderApi.moveFolder(itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
        } else {
          // 共用映射（P1-13 image/file 支持随之保留）
          return await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
        }
      })
    ));

    // ★ HIGH-002: 批量操作完成后统一刷新目标文件夹缓存
    if (targetFolderId) {
      const cacheResult = await updatePathCacheV2(targetFolderId);
      if (cacheResult.ok) {
        debugLog.log('[LearningHub] 批量移动后统一刷新缓存:', cacheResult.value, '项');
      } else {
        debugLog.warn('[LearningHub] 批量移动后缓存刷新失败:', cacheResult.error.message);
      }
    }

    // ★ Cmd+Z 撤销：仅记录移动成功的项
    if (canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
      const undoEntries: FinderMoveUndoEntry[] = [];
      itemIds.forEach((itemId, index) => {
        if (!moveResults[index]?.ok) return;
        const item = items.find(i => i.id === itemId);
        if (!item) return;
        undoEntries.push({
          id: itemId,
          isFolder: item.type === 'folder',
          itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
          fromFolderId: moveUndoSourceFolderId,
        });
      });
      if (undoEntries.length > 0) {
        finderUndoStack.push({ kind: 'move', entries: undoEntries, toFolderId: targetFolderId });
      }
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    const succeeded = moveResults.filter(r => r.ok).length;
    const failed = moveResults.filter(r => !r.ok).length;

    if (failed === 0) {
      showGlobalNotification('success', t('finder.batch.moveSuccess'));
    } else if (succeeded > 0) {
      showGlobalNotification('warning', t('finder.batch.movePartial', { succeeded, failed }));
    } else {
      const firstError = moveResults.find(r => !r.ok);
      if (firstError && !firstError.ok) {
        reportError(firstError.error, 'batch move items');
        showGlobalNotification('error', firstError.error.toUserMessage());
      }
    }
    clearSelection();
    handleRefresh();
  }, [items, t, clearSelection, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  // ==========================================================================
  // ★ 复制 / 粘贴 / 制造副本（Finder 内部剪贴板，对标访达 Duplicate）
  // ==========================================================================
  const clipboardState = useSyncExternalStore(
    finderClipboard.subscribe,
    finderClipboard.get,
    finderClipboard.get,
  );
  const clipboardCount = clipboardState?.entries.length ?? 0;

  // 粘贴/制造副本门禁：仅真实文件夹导航（root / 子文件夹）。
  // 智能文件夹（typeFilter）目的地会退化为根目录且可能被过滤隐藏，不开放。
  const canPasteHere =
    mode !== 'canvas' &&
    canCreateInCurrentView &&
    effectivePath.viewKind === 'folder' &&
    !effectivePath.typeFilter;

  /** 当前选中的真实节点（排除待创建文件夹草稿） */
  const getSelectedNodes = useCallback(
    () => displayedItems.filter((item) => selectedIds.has(item.id) && !isPendingFolderId(item.id)),
    [displayedItems, selectedIds],
  );

  // 右键目标解析：目标在多选集合内时作用于整组（访达语义），否则只作用于该项
  const resolveContextTargetNodes = useCallback((target: ContextMenuTarget): DstuNode[] => {
    const targetId = target.type === 'folder'
      ? target.folder.folder.id
      : target.type === 'resource'
        ? target.resource.id
        : null;
    if (!targetId || isPendingFolderId(targetId)) return [];
    if (selectedIds.has(targetId) && selectedIds.size > 1) {
      return getSelectedNodes();
    }
    const item = displayedItems.find((i) => i.id === targetId);
    return item ? [item] : [];
  }, [displayedItems, selectedIds, getSelectedNodes]);

  const handleCopyNodes = useCallback((nodes: DstuNode[]) => {
    const entries = toClipboardEntries(nodes);
    if (entries.length === 0) return;
    finderClipboard.copy(entries);
    showGlobalNotification('success', t('finder.clipboard.copied', { count: entries.length }));
  }, [t]);

  const handleCopyFromContextMenu = useCallback((target: ContextMenuTarget) => {
    handleCopyNodes(resolveContextTargetNodes(target));
  }, [handleCopyNodes, resolveContextTargetNodes]);

  const handleCopySelection = useCallback(() => {
    handleCopyNodes(getSelectedNodes());
  }, [getSelectedNodes, handleCopyNodes]);

  // 粘贴与制造副本共用执行体：批量 dstu_copy 到目标文件夹（后端追加「(副本)」）
  const executeCopyEntries = useCallback(async (
    entries: FinderClipboardEntry[],
    destFolderId: string | null,
    successKey: 'finder.clipboard.pasteSuccess' | 'finder.clipboard.duplicateSuccess',
  ) => {
    if (entries.length === 0) return;
    setIsBatchProcessing(true);
    try {
      const limit = pLimit(3);
      const results = await Promise.all(entries.map((entry) =>
        limit(() => dstu.copy(buildCopySrcPath(entry), buildPasteDstPath(destFolderId)))
      ));
      if (!isMountedRef.current) return;
      const failedResults = results.filter((r) => !r.ok);
      const succeeded = results.length - failedResults.length;
      if (failedResults.length === 0) {
        showGlobalNotification('success', t(successKey, { count: succeeded }));
      } else if (succeeded > 0) {
        showGlobalNotification('warning', t('finder.clipboard.copyPartial', {
          succeeded,
          failed: failedResults.length,
        }));
      } else {
        const firstError = failedResults[0];
        if (firstError && !firstError.ok) {
          reportError(firstError.error, 'copy items');
          showGlobalNotification('error', firstError.error.toUserMessage());
        }
      }
      if (succeeded > 0) handleRefresh();
    } finally {
      if (isMountedRef.current) setIsBatchProcessing(false);
    }
  }, [t, handleRefresh]);

  const handlePaste = useCallback(() => {
    if (!canPasteHere) return;
    const state = finderClipboard.get();
    if (!state || state.entries.length === 0) return;
    void executeCopyEntries(state.entries, currentCreatableFolderId, 'finder.clipboard.pasteSuccess');
  }, [canPasteHere, currentCreatableFolderId, executeCopyEntries]);

  // 制造副本：不经剪贴板，原地复制（目的地 = 当前文件夹，副本落在原件旁）
  const handleDuplicateNodes = useCallback((nodes: DstuNode[]) => {
    if (!canPasteHere) return;
    const entries = toClipboardEntries(nodes);
    if (entries.length === 0) return;
    void executeCopyEntries(entries, currentCreatableFolderId, 'finder.clipboard.duplicateSuccess');
  }, [canPasteHere, currentCreatableFolderId, executeCopyEntries]);

  const handleDuplicateFromContextMenu = useCallback((target: ContextMenuTarget) => {
    handleDuplicateNodes(resolveContextTargetNodes(target));
  }, [handleDuplicateNodes, resolveContextTargetNodes]);

  const handleDuplicateSelection = useCallback(() => {
    handleDuplicateNodes(getSelectedNodes());
  }, [getSelectedNodes, handleDuplicateNodes]);

  // 拖拽时可放置的面包屑祖先（含根目录）——对齐访达「拖到路径栏」
  const parentDropTargets = useMemo(() => {
    if (!canDragDropInCurrentView || mode === 'canvas') return undefined;
    if (effectivePath.viewKind !== 'folder') return undefined;
    // 仅在子目录时显示（根目录无更上级）
    if (!effectivePath.folderId && effectivePath.breadcrumbs.length === 0) return undefined;

    const targets: Array<{ id: string | null; label: string }> = [
      { id: null, label: t('learningHub:title') },
    ];
    // 不含当前目录自身（最后一个 breadcrumb）
    const ancestors = effectivePath.breadcrumbs.slice(0, -1);
    for (const crumb of ancestors) {
      targets.push({ id: crumb.id, label: crumb.name });
    }
    return targets;
  }, [canDragDropInCurrentView, mode, effectivePath.viewKind, effectivePath.folderId, effectivePath.breadcrumbs, t]);

  // 拖拽快捷目标：收藏 / 回收站（拖拽时出现在列表顶栏）
  const specialDropTargets = useMemo(() => {
    if (!canDragDropInCurrentView || mode === 'canvas') return undefined;
    return [
      { id: 'favorites' as const, label: t('finder.quickAccess.favorites') },
      { id: 'trash' as const, label: t('finder.quickAccess.trash') },
    ];
  }, [canDragDropInCurrentView, mode, t]);

  const handleSpecialDrop = useCallback(async (targetId: 'favorites' | 'trash', itemIds: string[]) => {
    if (itemIds.length === 0) return;

    if (targetId === 'favorites') {
      // 批量收藏：跳过文件夹，仅资源
      const limit = pLimit(3);
      let success = 0;
      let skipped = 0;
      let failed = 0;

      await Promise.all(itemIds.map((id) => limit(async () => {
        const item = items.find(i => i.id === id);
        if (!item || item.type === 'folder') {
          skipped += 1;
          return;
        }
        if (item.metadata?.isFavorite) {
          skipped += 1;
          return;
        }
        const resourcePath = item.path || `/${item.id}`;
        const result = await dstu.setFavorite(resourcePath, true);
        if (result.ok) success += 1;
        else failed += 1;
      })));

      if (!isMountedRef.current) return;
      if (success > 0) {
        showGlobalNotification(
          'success',
          t('finder.dragDrop.favoriteSuccess', { count: success })
        );
        handleRefresh();
        clearSelection();
      } else if (failed > 0) {
        showGlobalNotification('error', t('finder.dragDrop.favoriteFailed'));
      } else if (skipped > 0) {
        showGlobalNotification(
          'info',
          t('finder.dragDrop.favoriteSkipped')
        );
      }
      return;
    }

    // trash: 软删除（拖入回收站直接执行 + Undo）
    if (targetId === 'trash') {
      if (!canDeleteInCurrentView) return;
      setIsBatchProcessing(true);
      try {
        const limit = pLimit(3);
        const succeededTargets: SoftDeleteTarget[] = [];
        const results = await Promise.all(itemIds.map((id) => limit(async () => {
          const item = items.find(i => i.id === id);
          if (!item) return { ok: false as const };
          if (item.type === 'folder') {
            const result = await folderApi.deleteFolder(id);
            if (result.ok) succeededTargets.push({ id, type: 'folder', name: item.name });
            return { ok: result.ok };
          }
          const dstuPath = item.path || `/${item.id}`;
          const result = await dstu.delete(dstuPath);
          if (result.ok) succeededTargets.push({ id, type: item.type, name: item.name });
          return { ok: result.ok };
        })));

        if (!isMountedRef.current) return;
        const success = results.filter(r => r.ok).length;
        const failed = results.length - success;
        if (success > 0) {
          showSoftDeleteUndoToast(succeededTargets);
          if (failed > 0) {
            showGlobalNotification(
              'warning',
              t('finder.batch.deletePartial', { succeeded: success, failed })
            );
          }
          clearSelection();
          handleRefresh();
        } else {
          showGlobalNotification('error', t('finder.batch.deleteFailed'));
        }
      } finally {
        if (isMountedRef.current) setIsBatchProcessing(false);
      }
    }
  }, [items, t, handleRefresh, clearSelection, canDeleteInCurrentView, showSoftDeleteUndoToast]);

  // 批量全选 - 使用 store 的 selectAll
  const handleSelectAll = useCallback(() => {

    selectAll();
  }, [selectAll]);

  // 清除选择 - 使用 store 的 clearSelection
  const handleClearSelection = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // 多选模式切换（与旧次顶栏按钮同一语义；移动端聊天内嵌模式改由全局顶栏触发）
  const toggleMultiSelect = useCallback(() => {
    if (isMultiSelectMode) {
      setIsMultiSelectMode(false);
      handleClearSelection();
    } else {
      setIsMultiSelectMode(true);
    }
  }, [isMultiSelectMode, handleClearSelection]);

  // 把最新 toggle 句柄写入外部 ref（全局顶栏按钮持有），供外部随时调用
  useLayoutEffect(() => {
    if (multiSelectToggleRef) {
      multiSelectToggleRef.current = toggleMultiSelect;
    }
  });

  // 多选态变化通知外部（全局顶栏按钮的激活高亮）
  useEffect(() => {
    onMultiSelectModeChange?.(isMultiSelectMode);
  }, [isMultiSelectMode, onMultiSelectModeChange]);

  // ★ 执行批量软删除（非 trash；带 Undo toast）
  const executeBatchDelete = useCallback(async (idsToDelete: Set<string>) => {
    setIsBatchProcessing(true);

    try {
      const idsArray = Array.from(idsToDelete);
      // ★ 并发控制：限制同时执行的删除操作为 3 个，避免数据库锁竞争
      const limit = pLimit(3);

      const missingResults: Array<{ id: string; ok: boolean; error: string | null }> = [];
      const folderIds: string[] = [];
      const resourceEntries: Array<{ id: string; path: string }> = [];

      for (const id of idsArray) {
        const item = items.find(i => i.id === id);
        if (!item) {
          missingResults.push({
            id,
            ok: false,
            error: t('error.itemNotFound'),
          });
          continue;
        }

        if (item.type === 'folder') {
          folderIds.push(id);
          continue;
        }

        const dstuPath = item.path || `/${item.id}`;
        resourceEntries.push({ id, path: dstuPath });
      }

      const folderResults = await Promise.all(folderIds.map((id) =>
        limit(async () => {
          const result = await folderApi.deleteFolder(id);
          return {
            id,
            ok: result.ok,
            error: result.ok ? null : result.error.toUserMessage(),
          };
        })
      ));

      let resourceResults: Array<{ id: string; ok: boolean; error: string | null }> = [];
      if (resourceEntries.length > 0) {
        const paths = resourceEntries.map(entry => entry.path);
        const batchResult = await dstu.deleteMany(paths);

        if (!batchResult.ok) {
          resourceResults = resourceEntries.map(entry => ({
            id: entry.id,
            ok: false,
            error: batchResult.error.toUserMessage(),
          }));
        } else if (batchResult.value === resourceEntries.length) {
          resourceResults = resourceEntries.map(entry => ({
            id: entry.id,
            ok: true,
            error: null,
          }));
        } else {
          // 部分成功：逐个验证剩余资源，确认失败项
          resourceResults = await Promise.all(resourceEntries.map(entry =>
            limit(async () => {
              const check = await dstu.get(entry.path);
              if (!check.ok) {
                if (check.error?.code === VfsErrorCode.NOT_FOUND) {
                  return { id: entry.id, ok: true, error: null };
                }
                return { id: entry.id, ok: false, error: check.error.toUserMessage() };
              }
              return { id: entry.id, ok: false, error: t('finder.batch.deleteFailed') };
            })
          ));
        }
      }

      const deleteResults = [
        ...missingResults,
        ...folderResults,
        ...resourceResults,
      ];

      // ★ MEDIUM-005: 检查组件是否已卸载
      if (!isMountedRef.current) return;

      // ★ 单次遍历统计成功、失败和失败ID
      const failedResults = deleteResults.filter(r => !r.ok);
      const succeeded = deleteResults.length - failedResults.length;
      const failed = failedResults.length;
      const failedIds = failedResults.map(r => r.id);
      const succeededTargets: SoftDeleteTarget[] = deleteResults
        .filter((r) => r.ok)
        .map((r) => {
          const item = items.find((i) => i.id === r.id);
          return {
            id: r.id,
            type: item?.type === 'folder' ? 'folder' : (item?.type || 'note'),
            name: item?.name || r.id,
          };
        });

      if (failed === 0) {
        showSoftDeleteUndoToast(succeededTargets);
        clearSelection();
      } else if (succeeded > 0) {
        showSoftDeleteUndoToast(succeededTargets);
        showGlobalNotification('warning',
          t('finder.batch.deletePartial', { succeeded, failed }) +
          ' ' + t('finder.batch.failedItemsSelected')
        );

        // ★ 只保留失败项的选择
        const newSelected = new Set(failedIds);
        setSelectedIds(newSelected);

        debugLog.error('[LearningHub] 批量删除部分失败:', {
          failedIds,
          errors: failedResults.map(r => ({ id: r.id, error: r.error })),
        });
      } else {
        // 全部失败
        const firstError = failedResults[0];
        showGlobalNotification('error', firstError?.error || t('finder.batch.deleteFailed'));
      }

      handleRefresh();
    } finally {
      // ★ 使用 finally 确保状态恢复，即使操作失败
      if (isMountedRef.current) {
        setIsBatchProcessing(false);
      }
    }
  }, [items, t, clearSelection, setSelectedIds, handleRefresh, showSoftDeleteUndoToast]);

  // 批量删除：非 trash 直接软删；trash 仍 DsAlert 永久删
  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0 || !canDeleteInCurrentView) return;

    if (isTrashView) {
      setDeleteTarget({
        type: 'batch',
        batchIds: new Set(selectedIds),
        message: t('finder.trash.confirmBatchPermanentDelete', {
          count: selectedIds.size,
        }),
      });
      setDeleteConfirmOpen(true);
      return;
    }

    void executeBatchDelete(new Set(selectedIds));
  }, [selectedIds, t, isTrashView, canDeleteInCurrentView, executeBatchDelete]);

  // ★ 2025-12-11: 回收站相关操作
  // 恢复项目
  const handleRestoreItem = useCallback(async (id: string, itemType: string) => {
    const result = await trashApi.restoreItem(id, itemType);

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.trash.restoreSuccessWithReindex'));
      handleRefresh();
    } else {
      reportError(result.error, 'restore item');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [t, handleRefresh]);

  // 永久删除项目
  const handlePermanentDeleteItem = useCallback((id: string, itemType: string) => {
    // ★ 使用 AlertDialog 替代 window.confirm
    setDeleteTarget({
      type: 'permanent',
      permanentDeleteInfo: { id, itemType },
      message: t('finder.trash.confirmPermanentDelete'),
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  // ★ 执行永久删除操作（AlertDialog 确认后调用）
  const executePermanentDelete = useCallback(async (id: string, itemType: string) => {
    const result = await trashApi.permanentlyDelete(id, itemType);

    // ★ 悬挂引用清理：永久删除后移除对应桌面快捷方式（不可恢复，无需快照）
    if (result.ok) {
      useDesktopStore.getState().pruneShortcutsForTargets([id]);
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.trash.deleteSuccess'));
      handleRefresh();
    } else {
      reportError(result.error, 'permanent delete');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [t, handleRefresh]);

  // 清空回收站
  const handleEmptyTrash = useCallback(() => {
    // ★ 使用 AlertDialog 替代 window.confirm
    setDeleteTarget({
      type: 'emptyTrash',
      message: t('finder.trash.emptyConfirm'),
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  // ★ 执行清空回收站操作（AlertDialog 确认后调用）
  const executeEmptyTrash = useCallback(async () => {
    const result = await trashApi.emptyTrash();

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      softDeleteUndoGenRef.current += 1;
      // ★ 悬挂引用清理：清空回收站后按当前回收站列表移除桌面快捷方式
      //（列表可能被分页截断，属尽力清理；残余悬挂项打开时仍有 resourceNotFound 提示）
      if (isTrashView && items.length > 0) {
        useDesktopStore.getState().pruneShortcutsForTargets(items.map((item) => item.id));
      }
      showGlobalNotification('success', t('finder.trash.emptySuccess') + ` (${result.value})`);
      handleRefresh();
    } else {
      reportError(result.error, 'empty trash');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [t, handleRefresh, isTrashView, items]);

  // ★ AlertDialog 确认删除处理
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      switch (deleteTarget.type) {
        case 'batch':
          // 仅回收站批永久删走确认框
          if (deleteTarget.batchIds) {
            const idsArray = Array.from(deleteTarget.batchIds);
            let succeeded = 0;
            let failed = 0;
            const succeededIds: string[] = [];
            for (const id of idsArray) {
              const item = items.find(i => i.id === id);
              if (!item) { failed++; continue; }
              const result = await trashApi.permanentlyDelete(id, item.type);
              if (result.ok) { succeeded++; succeededIds.push(id); } else { failed++; }
            }
            // ★ 悬挂引用清理：批量永久删除后移除对应桌面快捷方式
            if (succeededIds.length > 0) {
              useDesktopStore.getState().pruneShortcutsForTargets(succeededIds);
            }
            if (!isMountedRef.current) break;
            if (failed === 0) {
              showGlobalNotification('success', t('finder.trash.batchDeleteSuccess', { count: succeeded }));
            } else if (succeeded > 0) {
              showGlobalNotification('warning', t('finder.trash.batchDeletePartial', { succeeded, failed }));
            } else {
              showGlobalNotification('error', t('finder.trash.batchDeleteFailed'));
            }
            clearSelection();
            handleRefresh();
          }
          break;
        case 'permanent':
          if (deleteTarget.permanentDeleteInfo) {
            await executePermanentDelete(
              deleteTarget.permanentDeleteInfo.id,
              deleteTarget.permanentDeleteInfo.itemType
            );
          }
          break;
        case 'emptyTrash':
          await executeEmptyTrash();
          break;
      }
    } finally {
      setIsDeleting(false);
      setDeleteConfirmOpen(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, executePermanentDelete, executeEmptyTrash, items, t, clearSelection, handleRefresh]);

  // ★ 右键「引用到对话」→ injectToChat（对齐批量注入契约）
  const handleReferenceToChat = useCallback(async (target: ContextMenuTarget) => {
    if (!canInject()) {
      showGlobalNotification('warning', t('finder.multiSelect.noChatSession'));
      return;
    }

    const typeMap: Record<string, VfsResourceType> = {
      note: 'note',
      textbook: 'textbook',
      exam: 'exam',
      translation: 'translation',
      essay: 'essay',
      image: 'image',
      file: 'file',
      mindmap: 'mindmap',
    };

    let sourceId: string | null = null;
    let sourceType: VfsResourceType | null = null;
    let name = '';

    if (target.type === 'resource') {
      const resource = target.resource;
      sourceType = typeMap[resource.type] ?? null;
      sourceId = resource.id;
      name = resource.title;
    } else if (target.type === 'folderItem') {
      const item = target.item;
      sourceType = typeMap[item.itemType] ?? null;
      sourceId = item.itemId || item.id;
      name = item.itemId || item.id;
    } else {
      return;
    }

    if (!sourceId || !sourceType) {
      showGlobalNotification('warning', t('error.unsupportedResourceType', { type: 'unknown' }));
      return;
    }

    const result = await injectToChat({
      sourceId,
      sourceType,
      name,
      metadata: { title: name },
    });
    if (result.success && result.contextRef && onReferenceToChat) {
      onReferenceToChat(result.contextRef);
    }
  }, [canInject, injectToChat, onReferenceToChat, t]);

  // ★ 批量添加到对话（将选中的文件引用发送到 Chat V2 附件区域）
  const handleBatchAddToChat = useCallback(async () => {
    if (selectedIds.size === 0 || !canAddToChatInCurrentView) return;
    if (!canInject()) {
      showGlobalNotification('warning', t('finder.multiSelect.noChatSession'));
      return;
    }

    setIsBatchProcessing(true);

    try {
      const idsArray = Array.from(selectedIds);
      const limit = pLimit(3);

      const injectResults = await Promise.all(idsArray.map((id) =>
        limit(async () => {
          const item = items.find(i => i.id === id);
          if (!item) {
            return { id, ok: false, error: t('error.itemNotFound') };
          }

          // 文件夹不支持添加到对话
          if (item.type === 'folder') {
            return { id, ok: false, error: t('error.folderCannotAddToChat') };
          }

          // 映射 DstuNodeType 到 VfsResourceType
          const typeMap: Record<string, VfsResourceType> = {
            note: 'note',
            textbook: 'textbook',
            exam: 'exam',
            translation: 'translation',
            essay: 'essay',
            image: 'image',
            file: 'file',
            mindmap: 'mindmap',
          };

          const sourceType = typeMap[item.type];
          if (!sourceType) {
            return { id, ok: false, error: t('error.unsupportedResourceType', { type: item.type }) };
          }

          const result = await injectToChat({
            sourceId: item.sourceId || item.id,
            sourceType,
            name: item.name,
            metadata: { title: item.name },
            resourceHash: item.resourceHash,
            openAttachmentPanel: false,
          });

          return { id, ok: result.success, error: result.error };
        })
      ));

      if (!isMountedRef.current) return;

      const failedResults = injectResults.filter(r => !r.ok);
      const succeeded = injectResults.length - failedResults.length;
      const failed = failedResults.length;

      if (succeeded > 0) {
        window.dispatchEvent(new CustomEvent('CHAT_V2_OPEN_ATTACHMENT_PANEL'));
      }

      if (failed === 0) {
        showGlobalNotification('success', t('finder.multiSelect.addToChatSuccess', { count: succeeded }));
        clearSelection();
      } else if (succeeded > 0) {
        showGlobalNotification('warning',
          t('finder.multiSelect.addToChatPartial', { succeeded, failed })
        );
        // 保留失败项的选择状态
        const failedIds = failedResults.map(r => r.id);
        setSelectedIds(new Set(failedIds));
      } else {
        showGlobalNotification('error', t('finder.multiSelect.addToChatFailed'));
      }
    } catch (err) {
      debugLog.error('[LearningHub] 批量添加到对话失败:', err);
      showGlobalNotification('error', t('finder.multiSelect.addToChatFailed'));
    } finally {
      if (isMountedRef.current) {
        setIsBatchProcessing(false);
      }
    }
  }, [selectedIds, items, canInject, injectToChat, t, clearSelection, setSelectedIds, canAddToChatInCurrentView]);

  // 批量移动（打开移动对话框）
  const handleBatchMove = useCallback(() => {
    if (selectedIds.size === 0 || !canMoveInCurrentView) return;
    setMoveTargetIds(null);
    setMoveDialogOpen(true);
  }, [selectedIds, canMoveInCurrentView]);

  // ★ 2026-06-12（审阅问题 FE-M4）：右键菜单"移动到…"
  // 若右键项属于多选集合则移动整个集合，否则只移动该项。
  const handleMoveTo = useCallback((target: ContextMenuTarget) => {
    if (!canMoveInCurrentView) return;
    let targetId: string | null = null;
    if (target.type === 'folder') {
      targetId = target.folder.folder.id;
    } else if (target.type === 'resource') {
      targetId = target.resource.id;
    } else if (target.type === 'folderItem') {
      targetId = target.item.itemId;
    }
    if (!targetId) return;

    if (selectedIds.size > 1 && selectedIds.has(targetId)) {
      setMoveTargetIds(null);
    } else {
      setMoveTargetIds(new Set([targetId]));
    }
    setMoveDialogOpen(true);
  }, [selectedIds, canMoveInCurrentView]);

  // 批量移动确认
  const handleBatchMoveConfirm = useCallback(async (targetFolderId: string | null) => {
    const effectiveIds = moveTargetIds ?? selectedIds;
    if (effectiveIds.size === 0) return;

    setIsBatchProcessing(true);

    try {
      const idsArray = Array.from(effectiveIds);
      // ★ 并发控制：限制同时执行的移动操作为 3 个，避免文件系统操作冲突
      const limit = pLimit(3);

      const moveResults = await Promise.all(idsArray.map((id, index) =>
        limit(async () => {
          const item = items.find(i => i.id === id);
          if (!item) {
            return {
              id,
              ok: false,
              error: t('error.itemNotFound')
            };
          }

          if (item.type === 'folder') {
            const result = await folderApi.moveFolder(id, targetFolderId ?? undefined, { skipCacheRefresh: true });
            return {
              id,
              ok: result.ok,
              error: result.ok ? null : result.error.toUserMessage()
            };
          } else {
            // 共用映射（P1-13 image/file 支持随之保留）
            const result = await folderApi.moveItem(mapDstuTypeToFolderItemType(item.type), id, targetFolderId ?? undefined, { skipCacheRefresh: true });
            return {
              id,
              ok: result.ok,
              error: result.ok ? null : result.error.toUserMessage()
            };
          }
        })
      ));


      // ★ HIGH-002: 批量操作完成后统一刷新目标文件夹缓存
      if (targetFolderId) {
        const cacheResult = await updatePathCacheV2(targetFolderId);
        if (cacheResult.ok) {
          debugLog.log('[LearningHub] 批量移动确认后统一刷新缓存:', cacheResult.value, '项');
        } else {
          debugLog.warn('[LearningHub] 批量移动确认后缓存刷新失败:', cacheResult.error.message);
        }
      }

      // ★ Cmd+Z 撤销：仅记录移动成功的项
      if (canRecordMoveUndo && targetFolderId !== moveUndoSourceFolderId) {
        const undoEntries: FinderMoveUndoEntry[] = [];
        idsArray.forEach((id, index) => {
          if (!moveResults[index]?.ok) return;
          const item = items.find(i => i.id === id);
          if (!item) return;
          undoEntries.push({
            id,
            isFolder: item.type === 'folder',
            itemType: item.type === 'folder' ? null : mapDstuTypeToFolderItemType(item.type),
            fromFolderId: moveUndoSourceFolderId,
          });
        });
        if (undoEntries.length > 0) {
          finderUndoStack.push({ kind: 'move', entries: undoEntries, toFolderId: targetFolderId });
        }
      }

      // ★ MEDIUM-005: 检查组件是否已卸载
      if (!isMountedRef.current) return;

      // ★ 单次遍历统计成功、失败和失败ID
      const failedResults = moveResults.filter(r => !r.ok);
      const succeeded = moveResults.length - failedResults.length;
      const failed = failedResults.length;
      const failedIds = failedResults.map(r => r.id);

      if (failed === 0) {
        // 全部成功（右键移动非选中项时不影响当前多选状态）
        showGlobalNotification('success', t('finder.batch.moveSuccess'));
        if (moveTargetIds === null) {
          clearSelection();
        }
      } else if (succeeded > 0) {
        // 部分成功 - 保留失败项的选择状态
        showGlobalNotification('warning',
          t('finder.batch.movePartial', { succeeded, failed }) +
          ' ' + t('finder.batch.failedItemsSelected')
        );

        // ★ 只保留失败项的选择
        const newSelected = new Set(failedIds);
        setSelectedIds(newSelected);

        debugLog.error('[LearningHub] 批量移动部分失败:', {
          failedIds,
          errors: failedResults.map(r => ({ id: r.id, error: r.error })),
        });
      } else {
        // 全部失败
        const firstError = failedResults[0];
        showGlobalNotification('error', firstError?.error || t('finder.batch.moveFailed'));
      }

      handleRefresh();
    } finally {
      // ★ 使用 finally 确保状态恢复，即使操作失败
      if (isMountedRef.current) {
        setIsBatchProcessing(false);
        setMoveTargetIds(null);
      }
    }
  }, [moveTargetIds, selectedIds, items, t, clearSelection, setSelectedIds, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  // ★ Cmd+Z：撤销最近一次移动/重命名（LIFO 操作栈；非完整事务系统）
  const handleUndoLastOperation = useCallback(async () => {
    const op = finderUndoStack.pop();
    if (!op) return;

    if (op.kind === 'rename') {
      let result;
      if (op.targetType === 'folder') {
        result = await folderApi.renameFolder(op.id, op.oldName);
      } else {
        // 重命名会改变 path 叶子：按 id 重新解析当前路径再反向 rename
        const nodeResult = await dstu.get(`/${op.id}`);
        const livePath = nodeResult.ok ? nodeResult.value.path : null;
        result = await dstu.rename(livePath || op.path || `/${op.id}`, op.oldName);
      }
      if (!isMountedRef.current) return;
      if (result.ok) {
        showGlobalNotification('success', t('finder.undoRenameSuccess', { name: op.oldName }));
        handleRefresh();
      } else {
        // 失败塞回栈顶：允许用户处理冲突后重试
        finderUndoStack.push(op);
        reportError(result.error, 'undo rename');
        showGlobalNotification('error', t('finder.undoFailed'));
      }
      return;
    }

    // 移动撤销：批量把各项移回原文件夹
    const limit = pLimit(3);
    const results = await Promise.all(op.entries.map((entry) =>
      limit(async () => {
        if (entry.isFolder) {
          return folderApi.moveFolder(entry.id, entry.fromFolderId ?? undefined, { skipCacheRefresh: true });
        }
        return folderApi.moveItem(entry.itemType ?? 'note', entry.id, entry.fromFolderId ?? undefined, { skipCacheRefresh: true });
      })
    ));

    // 统一刷新涉及到的原文件夹缓存
    const sourceFolderIds = new Set(
      op.entries.map((entry) => entry.fromFolderId).filter((id): id is string => id != null)
    );
    for (const folderId of sourceFolderIds) {
      const cacheResult = await updatePathCacheV2(folderId);
      if (!cacheResult.ok) {
        debugLog.warn('[LearningHub] 撤销移动后缓存刷新失败:', cacheResult.error.message);
      }
    }

    if (!isMountedRef.current) return;
    const failed = results.filter((r) => !r.ok).length;
    if (failed === 0) {
      showGlobalNotification('success', t('finder.undoMoveSuccess', { count: op.entries.length }));
    } else if (failed < results.length) {
      showGlobalNotification('warning', t('finder.undoMovePartial', { failed }));
    } else {
      finderUndoStack.push(op);
      showGlobalNotification('error', t('finder.undoFailed'));
    }
    handleRefresh();
  }, [t, handleRefresh]);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 检查焦点是否在 Learning Hub 容器内
      if (!containerRef.current?.contains(document.activeElement) && 
          !containerRef.current?.contains(e.target as Node)) {
        return;
      }
      
      // 只在非输入框中响应
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      const cmdOrCtrl = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + A：全选
      // ★ code 优先：Caps Lock 开启时 e.key 为 'A'，非拉丁布局下 e.key 可能不是字母
      if (cmdOrCtrl && !e.shiftKey && !e.altKey && (e.code === 'KeyA' || e.key.toLowerCase() === 'a')) {
        e.preventDefault();
        handleSelectAll();
      }

      // Cmd/Ctrl + Z：撤销最近一次移动/重命名（canvas 宿主不产生这类操作）
      if (
        cmdOrCtrl && !e.shiftKey && !e.altKey &&
        (e.code === 'KeyZ' || e.key.toLowerCase() === 'z') &&
        mode !== 'canvas'
      ) {
        if (finderUndoStack.size() > 0) {
          e.preventDefault();
          void handleUndoLastOperation();
        }
        return;
      }

      // ★ Cmd/Ctrl + C：复制选中项到 Finder 剪贴板。
      // 页面上有文本选区时不拦截（用户可能在复制文字）。
      if (
        cmdOrCtrl && !e.shiftKey && !e.altKey &&
        (e.code === 'KeyC' || e.key.toLowerCase() === 'c') &&
        mode !== 'canvas'
      ) {
        if (selectedIds.size > 0 && !window.getSelection()?.toString()) {
          e.preventDefault();
          handleCopySelection();
        }
        return;
      }

      // ★ Cmd/Ctrl + V：粘贴剪贴板内容到当前文件夹
      if (
        cmdOrCtrl && !e.shiftKey && !e.altKey &&
        (e.code === 'KeyV' || e.key.toLowerCase() === 'v') &&
        mode !== 'canvas'
      ) {
        if (canPasteHere && clipboardCount > 0) {
          e.preventDefault();
          handlePaste();
        }
        return;
      }

      // ★ Cmd/Ctrl + D：制造副本（访达 Duplicate 同键位）
      if (
        cmdOrCtrl && !e.shiftKey && !e.altKey &&
        (e.code === 'KeyD' || e.key.toLowerCase() === 'd') &&
        mode !== 'canvas'
      ) {
        if (canPasteHere && selectedIds.size > 0) {
          e.preventDefault();
          handleDuplicateSelection();
        }
        return;
      }

      // Cmd/Ctrl + ↑：返回上一级（访达）
      if (cmdOrCtrl && e.key === 'ArrowUp') {
        if (currentPath.viewKind === 'folder' && (currentPath.folderId || currentPath.breadcrumbs.length > 0)) {
          e.preventDefault();
          goUp();
        }
      }

      // ★ 空格：Quick Look 快速预览（访达）。
      // FinderFileList 的 type-ahead 输入若已消费空格（defaultPrevented）不重复触发；
      // 浮层打开期间的空格由浮层 capture 关闭，不会到达这里。
      if (
        e.key === ' ' && !cmdOrCtrl && !e.altKey &&
        !e.defaultPrevented && !quickLookItem && selectedIds.size > 0
      ) {
        const anchorId = mode === 'canvas' ? canvasLastSelectedId : finderStore.getState().lastSelectedId;
        const anchor =
          (anchorId && selectedIds.has(anchorId)
            ? displayedItems.find((item) => item.id === anchorId)
            : undefined)
          ?? displayedItems.find((item) => selectedIds.has(item.id));
        if (anchor && !isPendingFolderId(anchor.id)) {
          e.preventDefault();
          setQuickLookItem(anchor);
        }
      }
      
      // Delete：删除选中项
      // Backspace：仅 Cmd/Ctrl+Backspace 删除（避免与访达「上一级」心智及输入习惯冲突）
      if (e.key === 'Delete' && selectedIds.size > 0 && canDeleteInCurrentView) {
        e.preventDefault();
        handleBatchDelete();
      }
      if (e.key === 'Backspace' && cmdOrCtrl && selectedIds.size > 0 && canDeleteInCurrentView) {
        e.preventDefault();
        handleBatchDelete();
      }

      // ★ Escape 优先级：Quick Look 关闭（浮层 capture 自行消费，不会到达此处）
      // > 清除选择 > 退出多选模式 > 清空搜索
      if (e.key === 'Escape') {
        if (quickLookItem) return;
        if (selectedIds.size > 0) {
          e.preventDefault();
          handleClearSelection();
        } else if (isMultiSelectMode) {
          e.preventDefault();
          toggleMultiSelect();
        } else if (searchQuery) {
          e.preventDefault();
          setSearchQuery('');
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, handleSelectAll, handleBatchDelete, handleClearSelection, currentPath.viewKind, currentPath.folderId, currentPath.breadcrumbs.length, goUp, canDeleteInCurrentView, mode, quickLookItem, displayedItems, canvasLastSelectedId, isMultiSelectMode, toggleMultiSelect, searchQuery, setSearchQuery, handleUndoLastOperation, handleCopySelection, handlePaste, handleDuplicateSelection, canPasteHere, clipboardCount]);

  const shouldRenderQuickAccess = mode !== 'canvas' && (!isSmallScreen || Boolean(quickAccessPortalTarget));
  const quickAccessNode = shouldRenderQuickAccess ? (
    <FinderQuickAccess
      collapsed={quickAccessPortalTarget ? false : effectiveQuickAccessCollapsed}
      activeType={currentQuickAccessType}
      onNavigate={handleQuickAccessNavigate}
      onToggleCollapse={quickAccessPortalTarget ? undefined : () => setQuickAccessCollapsed(!quickAccessCollapsed)}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchPlaceholder={searchPlaceholder}
      searchDisabled={!canSearchInCurrentView}
      hideSearch={Boolean(quickAccessPortalTarget)}
      onNewFolder={handleNewFolder}
      onNewNote={handleNewNote}
      onImportMarkdownNote={() => {
        void handleImportMarkdownNote();
      }}
      onNewExam={handleNewExam}
      onNewTextbook={handleNewTextbook}
      onNewTranslation={handleNewTranslation}
      onNewEssay={handleNewEssay}
      onNewMindMap={handleNewMindMap}
      createDisabled={!canCreateInCurrentView}
      favoriteCount={favoriteCount}
      fillContainer={Boolean(quickAccessPortalTarget)}
    />
  ) : null;

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-full min-h-0 min-w-0 overflow-hidden',
        isSmallScreen && mode === 'fullscreen'
          ? 'bg-background'
          : 'study-shell-sidebar-frame',
        className,
      )}
      tabIndex={-1}
    >
      {/* 左侧快速导航；移动端由 LearningHubPage portal 到统一抽屉。 */}
      {quickAccessPortalTarget && quickAccessNode
        ? createPortal(quickAccessNode, quickAccessPortalTarget)
        : quickAccessNode}

      {/* 右侧：工具栏 + 文件列表（包裹拖拽导入区域） */}
      <UnifiedDragDropZone
        zoneId="learning-hub-finder"
        onFilesDropped={handleFilesDrop}
        onPathsDropped={handlePathsDrop}
        enabled={isDragDropEnabled}
        acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT]}
        maxFiles={20}
        maxFileSize={200 * 1024 * 1024}
        customOverlayText={t('finder.dragDrop.overlayText')}
        className="flex-1 flex flex-col min-w-0 min-h-0"
      >
        {/* P1-20: 移动端顶部工具栏（搜索 + 新建文件夹 + 新建笔记 + 清空回收站） */}
        {isSmallScreen && !hideToolbarAndNav && (
          <div
            className="flex shrink-0 items-center gap-1 border-b border-[color:var(--shell-chrome-border)] bg-[color:var(--shell-titlebar-surface)] px-2 py-1.5"
          >
            {mobileSearchExpanded ? (
              // 搜索框展开态
              <div className="flex-1 flex items-center gap-1">
                <Input
                  type="search"
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  // iOS 保留 16px 地板，同时继续响应界面字号缩放。
                  className="h-[var(--touch-target-size)] text-[max(16px,var(--font-size-lg))] flex-1"
                  autoFocus
                  disabled={!canSearchInCurrentView}
                />
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => {
                    setMobileSearchExpanded(false);
                    setSearchQuery('');
                  }}
                  aria-label={t('common:close')}
                >
                  <X className="w-5 h-5" />
                </DsButton>
              </div>
            ) : (
              // 工具栏按钮（移动端触控目标 ≥44px；刷新在顶栏，此处仅搜索/新建）
              <>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => setMobileSearchExpanded(true)}
                  title={t('finder.search.title')}
                  aria-label={t('finder.search.title')}
                  disabled={!canSearchInCurrentView}
                >
                  <MagnifyingGlass className="w-5 h-5" />
                </DsButton>
                <AppMenu open={mobileCreateMenuOpen} onOpenChange={setMobileCreateMenuOpen}>
                  <AppMenuTrigger asChild>
                    <DsButton
                      ref={mobileCreateMenuTriggerRef}
                      variant="ghost"
                      size="icon"
                      iconOnly
                      title={t('finder.toolbar.new')}
                      aria-label={t('finder.toolbar.new')}
                      disabled={!canCreateInCurrentView}
                    >
                      <Plus className="w-5 h-5" />
                    </DsButton>
                  </AppMenuTrigger>
                  <AppMenuContent align="end" className="min-w-[180px]">
                    <AppMenuItem
                      icon={<FolderIcon size={16} />}
                      onClick={handleNewFolder}
                    >
                      {t('finder.toolbar.newFolder')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<NoteIcon size={16} />}
                      onClick={handleNewNote}
                    >
                      {t('finder.toolbar.newNote')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<NoteIcon size={16} />}
                      onClick={() => {
                        void handleImportMarkdownNote();
                      }}
                    >
                      {t('finder.toolbar.importMarkdown')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<ExamIcon size={16} />}
                      onClick={handleNewExam}
                    >
                      {t('finder.toolbar.newExam')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<TextbookIcon size={16} />}
                      onClick={handleNewTextbook}
                    >
                      {t('finder.toolbar.newTextbook')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<TranslationIcon size={16} />}
                      onClick={handleNewTranslation}
                    >
                      {t('finder.toolbar.newTranslation')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<EssayIcon size={16} />}
                      onClick={handleNewEssay}
                    >
                      {t('finder.toolbar.newEssay')}
                    </AppMenuItem>
                    <AppMenuItem
                      icon={<MindmapIcon size={16} />}
                      onClick={handleNewMindMap}
                    >
                      {t('finder.toolbar.newMindMap')}
                    </AppMenuItem>
                  </AppMenuContent>
                </AppMenu>
                {/* 回收站视图显示清空按钮 */}
                {isTrashView && (
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className="text-destructive hover:text-destructive"
                    onClick={handleEmptyTrash}
                    title={t('finder.actions.emptyTrash')}
                    aria-label={t('finder.actions.emptyTrash')}
                  >
                    <Trash className="w-5 h-5" />
                  </DsButton>
                )}
                <div className="flex-1" />
                {/* 项目数显示 */}
                <span className="text-xs text-muted-foreground">
                  {items.length}
                </span>
              </>
            )}
          </div>
        )}

{/* ★ Canvas 模式导航栏：返回/前进 + 面包屑 */}
        {mode === 'canvas' && !hideToolbarAndNav && (
          <div className="study-shell-toolbar flex items-center gap-1 px-1.5 py-1 border-b shrink-0 min-w-0">
            {/* 返回/前进按钮（N-5: 小屏放大触控目标） */}
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className={cn('p-0 shrink-0', !isSmallScreen && 'h-6 w-6')}
              onClick={goBack}
              disabled={historyIndex <= 0}
              title={t('finder.toolbar.back')}
            >
              <CaretLeft className={isSmallScreen ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
            </DsButton>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className={cn('p-0 shrink-0', !isSmallScreen && 'h-6 w-6')}
              onClick={goForward}
              disabled={historyIndex >= history.length - 1}
              title={t('finder.toolbar.forward')}
            >
              <CaretRight className={isSmallScreen ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
            </DsButton>
            {/* 面包屑路径 */}
            <div className="flex items-center gap-0.5 min-w-0 overflow-hidden text-xs">
              <DsButton variant="ghost" size="icon" iconOnly onClick={() => jumpToBreadcrumb(-1)} className={cn('shrink-0 !p-0', !isSmallScreen && '!h-4 !w-4')} title={t('learningHub:title')} aria-label={t('breadcrumb.home')}>
                <House className={isSmallScreen ? 'w-4 h-4' : 'w-3 h-3'} />
              </DsButton>
              {effectivePath.breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.id}>
                  <span className="text-muted-foreground/50 shrink-0">/</span>
                  {index === effectivePath.breadcrumbs.length - 1 ? (
                    <span className="truncate text-foreground font-medium">{crumb.name}</span>
                  ) : (
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={() => jumpToBreadcrumb(index)}
                      className={cn(
                        '!h-auto !p-0 truncate text-muted-foreground hover:text-foreground',
                        isSmallScreen
                          ? '!px-2'
                          : '[@media(pointer:coarse)]:!px-2',
                      )}
                    >
                      {crumb.name}
                    </DsButton>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* ★ Canvas 模式顶部工具栏：多选模式 + 关闭按钮。
            移动端聊天内嵌（hideToolbarAndNav）不渲染此条：面板完全使用全局
            顶栏，多选切换按钮由 ChatV2Page 放到全局顶栏右上角。 */}
        {mode === 'canvas' && !hideToolbarAndNav && (
          <div data-wb-blur-surface className="study-shell-toolbar study-shell-toolbar--floating flex items-center justify-between px-2 py-1.5 border-b backdrop-blur-lg shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {isMultiSelectMode ? (
                // 多选模式下显示选中信息和操作
                <>
                  <span className="text-xs font-medium whitespace-nowrap">
                    {selectedIds.size > 0
                      ? t('finder.canvas.selected', { count: selectedIds.size })
                      : t('finder.canvas.selectHint')}
                  </span>
                  {selectedIds.size > 0 && (
                    <>
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs px-1.5"
                        onClick={selectedIds.size === items.length ? handleClearSelection : handleSelectAll}
                        title={selectedIds.size === items.length ? t('finder.batch.deselectAll') : t('finder.batch.selectAll')}
                      >
                        {selectedIds.size === items.length
                          ? <CheckSquare className="w-3.5 h-3.5" />
                          : t('finder.batch.selectAll')}
                      </DsButton>
                      {canAddToChatInCurrentView && (
                      <DsButton
                        variant="primary"
                        size="sm"
                        className="h-6 text-xs px-2"
                        onClick={handleBatchAddToChat}
                        disabled={isBatchProcessing || isInjecting}
                      >
                        {isInjecting
                          ? t('finder.canvas.adding')
                          : t('finder.canvas.addToChat')}
                      </DsButton>
                      )}
                    </>
                  )}
                </>
              ) : (
                // 普通模式显示项目数
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {t('finder.statusBar.itemCount', { count: items.length })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              {/* 多选模式切换按钮 */}
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className={cn(
                  'p-0',
                  !isSmallScreen && 'h-7 w-7',
                  isMultiSelectMode && "bg-primary/10 text-primary hover:bg-primary/15"
                )}
                onClick={toggleMultiSelect}
                title={isMultiSelectMode ? t('finder.canvas.exitMultiSelect') : t('finder.canvas.multiSelect')}
              >
                <ListChecks className={isSmallScreen ? 'w-5 h-5' : 'w-4 h-4'} />
              </DsButton>
              {/* 关闭资源库按钮 */}
              {onClose && (
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className={cn('p-0', !isSmallScreen && 'h-7 w-7')}
                  onClick={onClose}
                  title={t('common:close')}
                >
                  <X className={isSmallScreen ? 'w-5 h-5' : 'w-4 h-4'} />
                </DsButton>
              )}
            </div>
          </div>
        )}

        {!isSmallScreen && mode === 'fullscreen' && !hideToolbarAndNav && (() => {
          const toolbar = (
            <FinderToolbar
            breadcrumbs={effectivePath.breadcrumbs}
            onBreadcrumbClick={jumpToBreadcrumb}
            currentTitle={
              effectivePath.breadcrumbs[effectivePath.breadcrumbs.length - 1]?.name ||
              (currentQuickAccessType
                ? t(`finder.quickAccess.${currentQuickAccessType}`)
                : t('title'))
            }
            onNavigateHome={() => jumpToBreadcrumb(-1)}
            canGoBack={historyIndex > 0}
            canGoForward={historyIndex < history.length - 1}
            onBack={goBack}
            onForward={goForward}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={setSorting}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchPlaceholder={searchPlaceholder}
            searchDisabled={!canSearchInCurrentView}
            onNewFolder={canCreateInCurrentView ? handleNewFolder : undefined}
            onRefresh={handleRefresh}
            titlebarMode={toolbarPortalTarget ? toolbarPortalMode : false}
          />
          );
          return toolbarPortalTarget ? createPortal(toolbar, toolbarPortalTarget) : toolbar;
        })()}

        {/* ★ 2026-01-15: 向量化状态视图 */}
        {/* ★ 2026-01-19: VFS 记忆管理视图 */}
        {/* ★ 2026-01-31: 桌面视图 */}
        {effectivePath.viewKind === 'indexStatus' ? (
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center">
              <CircleNotch className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }>
            <IndexStatusView />
          </Suspense>
        ) : effectivePath.viewKind === 'memory' ? (
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center">
              <CircleNotch className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }>
            <MemoryView onOpenApp={onOpenApp} />
          </Suspense>
        ) : effectivePath.viewKind === 'desktop' ? (
          <DesktopView
            onNavigateQuickAccess={handleQuickAccessNavigate}
            onOpenResource={async (resourceId, resourceType) => {
              // ★ 2026-01-31: 桌面快捷方式打开资源
              // 首先尝试从 items 中查找（如果恰好在当前视图中）
              const item = items.find(i => i.id === resourceId);
              if (item) {
                handleOpen(item);
                return;
              }
              // 使用 dstu.get 获取资源完整信息
              const result = await dstu.get(`/${resourceId}`);
              if (result.ok && result.value) {
                handleOpen(result.value);
              } else {
                showGlobalNotification('error', t('desktop.resourceNotFound'));
              }
            }}
            onOpenFolder={(folderId) => {
              // 打开文件夹 - 通过 enterFolder 处理
              enterFolder(folderId);
            }}
            onCreateInDesktopRoot={async (type: CreateResourceType, desktopRoot: DesktopRootConfig) => {
              // ★ 2026-01-31: 在桌面根目录创建资源并跳转
              const targetFolderId = desktopRoot.folderId || null;
              
              // 1. 先创建资源
              const result = await createEmpty({
                type,
                folderId: targetFolderId,
              });

              if (!isMountedRef.current) return;

              if (result.ok) {
                const resourceNames: Record<CreateResourceType, string> = {
                  note: t('finder.create.noteSuccess'),
                  exam: t('finder.create.examSuccess'),
                  essay: t('finder.create.essaySuccess'),
                  translation: t('finder.create.translationSuccess'),
                  mindmap: t('finder.create.mindmapSuccess'),
                };
                showGlobalNotification('success', resourceNames[type]);

                // 2. 导航到目标文件夹
                if (targetFolderId) {
                  enterFolder(targetFolderId);
                } else {
                  // 导航到根目录
                  navigateTo({
                    ...currentPath,
                    viewKind: 'folder',
                    folderId: null,
                    breadcrumbs: [],
                    typeFilter: null,
                  });
                }

                // 3. 打开资源
                if (onOpenApp) {
                  onOpenApp(dstuNodeToResourceListItem(result.value, type));
                }
              } else {
                showGlobalNotification('error', result.error.toUserMessage());
              }
            }}
          />
        ) : (
          <>
          {!isInMemoryFolder && mode === 'fullscreen' && effectivePath.viewKind === 'folder' && (
            <LearningHubGenerativeBriefing />
          )}
          {isInMemoryFolder && mode !== 'canvas' && (
            <MemoryFolderGenerativeBriefing onRefresh={handleRefresh} />
          )}
          {/* ★ 记忆系统改造：记忆文件夹内显示专属工具栏 */}
          {isInMemoryFolder && mode !== 'canvas' && (
            <MemoryFolderBanner
              onRefresh={handleRefresh}
              isTreeView={memoryTreeView}
              onToggleTreeView={() => setMemoryTreeView(v => !v)}
            />
          )}
          {/* ★ 记忆系统改造：树状图预览模式 */}
          {isInMemoryFolder && memoryTreeView && mode !== 'canvas' ? (
            <MemoryTreePreview
              onNavigateToFolder={(folderId) => {
                setMemoryTreeView(false);
                enterFolder(folderId);
              }}
              className="flex-1"
            />
          ) : (
          <>
          {isSearching && searchMeta?.truncated && (
            <div className="shrink-0 px-3 py-1.5 text-caption text-muted-foreground border-b border-border/40">
              {t('finder.search.truncatedHint', { limit: searchMeta.limit })}
            </div>
          )}
          <FinderFileList
            items={displayedItems}
            viewMode={isCollapsed || mode === 'canvas' ? 'list' : viewMode}
            selectedIds={selectedIds}
            onSelect={
              multiSelectActive
                ? (id, selectMode) => {
                    // ★ 多选模式下，普通单击改为 toggle 模式，允许累加/取消选择
                    select(id, selectMode === 'single' ? 'toggle' : selectMode);
                  }
                : mode === 'canvas'
                  ? (id, _mode) => {
                      // canvas 非多选模式下，单击直接打开文件/文件夹
                      const item = displayedItems.find(i => i.id === id);
                      if (item) handleOpen(item);
                    }
                  : select
            }
            onOpen={
              multiSelectActive
                ? (item) => { if (item.type === 'folder') handleOpen(item); }
                : handleOpen
            }
            onOpenMany={mode === 'canvas' ? undefined : handleOpenMany}
            onContextMenu={mode === 'canvas' ? undefined : handleContextMenu}
            multiSelectMode={multiSelectActive}
            onContainerClick={mode === 'canvas' ? (isMultiSelectMode ? clearSelection : undefined) : clearSelection}
            onContainerContextMenu={mode === 'canvas' ? undefined : handleContainerContextMenu}
            onMoveItem={mode === 'canvas' ? undefined : handleMoveItem}
            onMoveItems={mode === 'canvas' ? undefined : handleMoveItems}
            isLoading={isLoading}
            error={error}
            canCreate={canCreateInCurrentView}
            emptyMessage={
              effectivePath.viewKind === 'favorites'
                ? t('finder.empty.favorites')
                : effectivePath.viewKind === 'recent'
                  ? t('finder.empty.recent')
                  : effectivePath.viewKind === 'trash'
                    ? t('finder.empty.trash')
                    : undefined
            }
            emptyHint={
              effectivePath.viewKind === 'trash'
                ? t('finder.empty.trashHint')
                : !canCreateInCurrentView
                  ? t(isSmallScreen ? 'finder.empty.noCreateHintTouch' : 'finder.empty.noCreateHint')
                  : undefined
            }
            enableDragDrop={mode !== 'canvas' && canDragDropInCurrentView}
            editingId={mode === 'canvas' ? undefined : inlineEdit.editingId}
            onEditConfirm={mode === 'canvas' ? undefined : handleInlineEditConfirm}
            onEditCancel={mode === 'canvas' ? undefined : handleInlineEditCancel}
            compact={isCollapsed || mode === 'canvas'}
            activeFileId={activeFileId}
            enableBoxSelect={mode === 'canvas' ? isMultiSelectMode : !isCollapsed}
            onSelectionChange={setSelectedIds}
            onRetry={handleRefresh}
            highlightedIds={highlightedIds}
            onRequestRename={
              mode === 'canvas' || isTrashView
                ? undefined
                : (item) => startInlineEdit(item.id, item.type === 'folder' ? 'folder' : 'resource', item.name)
            }
            parentDropTargets={mode === 'canvas' || !canDragDropInCurrentView ? undefined : parentDropTargets}
            specialDropTargets={mode === 'canvas' || !canDragDropInCurrentView ? undefined : specialDropTargets}
            onSpecialDrop={mode === 'canvas' || !canDragDropInCurrentView ? undefined : handleSpecialDrop}
            onNavigateUp={
              mode === 'canvas' || isTrashView
                ? undefined
                : () => {
                    if (effectivePath.viewKind === 'folder' && (effectivePath.folderId || effectivePath.breadcrumbs.length > 0)) {
                      goUp();
                    }
                  }
            }
            searchQuery={searchQuery}
            onClearSearch={() => setSearchQuery('')}
          />
          </>
          )}
          </>
        )}
      
        {/* Batch Operation Toolbar + View Mode Toggle + App Close
            canvas / 特殊系统视图（索引状态、记忆、桌面）不显示文件列表底栏，避免「0 个项目」错位 */}
        {mode === 'canvas' || effectivePath.viewKind === 'indexStatus' || effectivePath.viewKind === 'memory' || effectivePath.viewKind === 'desktop' ? null : (
          <FinderBatchToolbar
            selectedCount={selectedIds.size}
            totalCount={items.length}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onBatchDelete={canDeleteInCurrentView ? handleBatchDelete : undefined}
            onBatchMove={canMoveInCurrentView ? handleBatchMove : undefined}
            onBatchAddToChat={canAddToChatInCurrentView ? handleBatchAddToChat : undefined}
            isTrashView={isTrashView}
            isProcessing={isBatchProcessing || isInjecting}
            viewMode={isCollapsed ? 'list' : viewMode}
            onViewModeChange={isSmallScreen && !isCollapsed ? setViewMode : undefined}
            multiSelectMode={isMultiSelectMode}
            onToggleMultiSelectMode={
              isTouchPrimary
                ? () => {
                    if (isMultiSelectMode) {
                      setIsMultiSelectMode(false);
                      handleClearSelection();
                    } else {
                      setIsMultiSelectMode(true);
                    }
                  }
                : undefined
            }
            sortBy={sortBy}
            sortOrder={sortOrder}
            onSortChange={isSmallScreen ? setSorting : undefined}
            hasOpenApp={!isSmallScreen && hasOpenApp}
            onCloseApp={onCloseApp}
          />
        )}
      </UnifiedDragDropZone>

      {/* Context Menu - canvas 模式禁用 */}
      <LearningHubContextMenu
        open={mode !== 'canvas' && contextMenuOpen}
        onOpenChange={setContextMenuOpen}
        position={contextMenuPosition}
        target={contextMenuTarget}
        dataView="folder"
        currentFolderId={effectivePath.folderId}
        isTrashView={isTrashView}
        canCreate={canCreateInCurrentView}
        canDelete={canDeleteInCurrentView}
        canMove={canMoveInCurrentView}
        canAddToChat={canAddToChatInCurrentView}
        onCreateFolder={canCreateInCurrentView ? () => handleNewFolder() : undefined}
        onCreateItem={canCreateInCurrentView ? (type, _folderId) => {
          switch (type) {
            case 'note':
              handleNewNote();
              break;
            case 'exam':
              handleNewExam();
              break;
            case 'textbook':
              handleNewTextbook();
              break;
            case 'translation':
              handleNewTranslation();
              break;
            case 'essay':
              handleNewEssay();
              break;
            case 'mindmap':
              handleNewMindMap();
              break;
          }
        } : undefined}
        onImportMarkdownNote={canCreateInCurrentView ? (folderId) => {
          void handleImportMarkdownNote(folderId);
        } : undefined}
        onRefresh={handleRefresh}
        onOpenFolder={handleOpenFolder}
        onRenameFolder={handleOpenRenameDialog}
        onDeleteFolder={canDeleteInCurrentView ? (folderId) => {
          if (selectedIds.size > 1 && selectedIds.has(folderId)) {
            handleBatchDelete();
          } else {
            handleDeleteFolder(folderId);
          }
        } : undefined}
        onOpenResource={(resource) => {
          if (onOpenApp && 'id' in resource) {
            onOpenApp(resource as ResourceListItem);
          }
        }}
        onRenameResource={handleOpenRenameResourceDialog}
        onDeleteResource={canDeleteInCurrentView ? (resource) => {
          if (selectedIds.size > 1 && selectedIds.has(resource.id)) {
            handleBatchDelete();
          } else {
            handleDeleteResource(resource);
          }
        } : undefined}
        onToggleFavorite={handleToggleFavorite}
        onCopy={isTrashView ? undefined : handleCopyFromContextMenu}
        onDuplicate={canPasteHere ? handleDuplicateFromContextMenu : undefined}
        onPaste={canPasteHere ? handlePaste : undefined}
        pasteCount={clipboardCount}
        onExportResource={handleExportResource}
        onExportFolder={handleExportFolder}
        onRestoreItem={handleRestoreItem}
        onPermanentDeleteItem={handlePermanentDeleteItem}
        onEmptyTrash={handleEmptyTrash}
        onReferenceToChat={
          canAddToChatInCurrentView ? handleReferenceToChat : undefined
        }
        onMoveTo={canMoveInCurrentView ? handleMoveTo : undefined}
      />
      
      {/* Folder Picker for Batch Move
          📱 移动端契约：走 inline 全屏子屏（挂在中屏容器 absolute inset-0），桌面保留 Dialog */}
      <FolderPickerDialog
        open={moveDialogOpen}
        onOpenChange={(open) => {
          setMoveDialogOpen(open);
          if (!open) setMoveTargetIds(null);
        }}
        excludeFolderIds={Array.from(moveTargetIds ?? selectedIds).filter(id =>
          items.find(i => i.id === id)?.type === 'folder'
        )}
        onConfirm={handleBatchMoveConfirm}
        title={t('finder.batch.moveDialogTitle')}
        inline={isSmallScreen}
      />

      {/* ★ 删除确认对话框 - 替代原生 window.confirm */}
      <DsAlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setDeleteConfirmOpen(false);
            setDeleteTarget(null);
          }
        }}
        title={
          deleteTarget?.type === 'emptyTrash'
            ? t('finder.trash.emptyTitle')
            : t('contextMenu.deleteTitle')
        }
        description={deleteTarget?.message}
        confirmText={isDeleting ? t('common:actions.deleting') : t('common:delete')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        loading={isDeleting}
        disabled={isDeleting}
        onConfirm={handleConfirmDelete}
      />

      {/* Rename Dialog - Replaced with Inline Editing */}

      {/* ★ Quick Look：空格快速预览浮层（空格/Esc/点遮罩关闭） */}
      {quickLookItem && (
        <FinderQuickLook
          item={quickLookItem}
          onClose={() => setQuickLookItem(null)}
          onOpen={handleQuickLookOpen}
        />
      )}

      {/* ★ 教材导入进度模态框 */}
      <ImportProgressModal
        state={importProgress}
        onClose={() => setImportProgress(prev => ({ ...prev, isImporting: false }))}
      />

      {/* ★ 2026-06-12（审阅问题 FE-M5）：附件批量导入进度横幅（非模态，不阻塞操作） */}
      {attachImportProgress && (
        <div
          data-wb-blur-surface
          className="absolute left-1/2 z-50 flex max-w-[calc(100%_-_1rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg border bg-background/95 px-3.5 py-2 shadow-card-lg backdrop-blur-lg"
          style={{
            bottom: 'calc(3rem + var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
          }}
        >
          <CircleNotch className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
          <span className="max-w-[60vw] truncate text-xs">
            {t('finder.dragDrop.importing', {
              done: attachImportProgress.done,
              total: attachImportProgress.total,
            })}
          </span>
          <div className="w-24 h-1 rounded-full bg-muted overflow-hidden shrink-0">
            <div
              className="h-full bg-primary transition-[width] duration-200"
              style={{ width: `${Math.round((attachImportProgress.done / Math.max(1, attachImportProgress.total)) * 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
