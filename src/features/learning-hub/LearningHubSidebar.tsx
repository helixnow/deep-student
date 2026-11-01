import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { exportResourceById } from './utils/exportResource';
import { UnifiedDragDropZone, FILE_TYPES } from '@/components/shared/UnifiedDragDropZone';
import { useDebounce } from '@/hooks/useDebounce';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import {
  useFinderStoreFor,
  type FinderPath,
  type QuickAccessType,
} from './stores/finderStore';
import { useRecentStore } from './stores/recentStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import {
  FinderQuickAccess,
  FinderBatchToolbar,
  FinderQuickLook,
  FolderPickerDialog,
} from './components/finder';
import type { FinderClipboardEntry } from './utils/finderClipboard';
import { dstu, type DstuNode } from '@/dstu';
import { dstuNodeToResourceListItem } from './types';
import type { LearningHubSidebarProps, ResourceListItem } from './types';
import type { ContextMenuTarget } from './components/LearningHubContextMenu';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePageMount } from '@/debug-panel/hooks/usePageLifecycle';
import { ImportProgressModal, type ImportProgressState } from './components/ImportProgressModal';
import { useVfsContextInject } from './hooks';
import {
  CONVERT_MARKDOWN_TO_NOTE_EVENT,
  type ConvertMarkdownToNoteDetail,
  splitLeadingMarkdownHeading,
  markIntentionalRemoval,
  isDragDropBlockedView,
} from './dragDropRouting';
import { getCreatableFolderId } from './viewGuards';
import {
  getFinderPathDisplayPath,
  getQuickAccessTypeFromPath,
  getViewCapabilities,
} from './learningHubContracts';
import { useCommandEvents } from '@/command-palette/hooks/useCommandEvents';
import { getSearchPlaceholderKey } from './utils/searchHonesty';
import { CreateLearningNoteDialog } from '@/features/notes/components/CreateLearningNoteDialog';
import { useNotesLearningView } from './components/finder/NotesLearningViewTabs';
import { useExamsView } from './mistakeBook/mistakeBookNavigation';
import {
  CANVAS_BLOCKED_VIEW_KINDS,
  CANVAS_FALLBACK_PATH,
  isPendingFolderId,
  type DeleteConfirmTarget,
  type PendingFolderDraft,
  type SoftDeleteTarget,
} from './sidebar/sidebarConstants';
import { useMemoryFolderDisplay } from './sidebar/useMemoryFolderDisplay';
import { useMobileCreateMenu } from './sidebar/useMobileCreateMenu';
import { refreshCanvasList } from './sidebar/canvasLocalList';
import { useFinderHostLifecycle } from './sidebar/useFinderHostLifecycle';
import { runFinderLoadEffect } from './sidebar/finderLoadEffect';
import { createOpenHandlers } from './sidebar/openHandlers';
import { useDstuWatchRefresh } from './sidebar/useDstuWatchRefresh';
import { subscribeFavoriteCount } from './sidebar/favoriteCount';
import { beginPendingFolderDraft, confirmInlineEdit } from './sidebar/inlineEditActions';
import { createResourceCreators } from './sidebar/resourceCreators';
import { useMarkdownNoteImport, importMarkdownNoteFromDialog } from './sidebar/useMarkdownNoteImport';
import { useQuickAccessNavigation } from './sidebar/useQuickAccessNavigation';
import { importPathsIntoLibrary, importDroppedFiles } from './sidebar/importActions';
import { createContextMenuHandlers } from './sidebar/contextMenuHandlers';
import {
  showSoftDeleteUndo,
  deleteFolderToTrash,
  deleteResourceToTrash,
  executeBatchSoftDelete,
  restoreTrashItem,
  permanentlyDeleteTrashItem,
  emptyTrashBin,
  confirmPendingDelete,
} from './sidebar/trashActions';
import { toggleResourceFavorite, dropOnSpecialTarget } from './sidebar/resourceActions';
import { moveSingleItem, moveMultipleItems, confirmBatchMove, undoLastFinderOperation } from './sidebar/moveActions';
import {
  useClipboardSelection,
  useClipboardPasteActions,
  copyEntriesToFolder,
  type CopySuccessKey,
} from './sidebar/useFinderClipboard';
import { useDropTargets } from './sidebar/useDropTargets';
import { useMultiSelectBridge } from './sidebar/useMultiSelectBridge';
import {
  useSidebarReferenceToChat,
  useMakeCardsAction,
  batchAddSelectionToChat,
} from './sidebar/useSidebarChatActions';
import { handleFinderKeyDown } from './sidebar/finderKeyboardShortcuts';
import { SidebarMobileToolbar } from './sidebar/SidebarMobileToolbar';
import { SidebarCanvasNavBar, SidebarCanvasToolbar } from './sidebar/SidebarCanvasBars';
import { SidebarFinderToolbar } from './sidebar/SidebarFinderToolbar';
import { SidebarContentArea } from './sidebar/SidebarContentArea';
import { SidebarContextMenu } from './sidebar/SidebarContextMenu';
import { AttachImportProgressBanner } from './sidebar/AttachImportProgressBanner';

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

  const { isInMemoryFolder, currentQuickAccessType, displayBreadcrumbs, getItemDisplayName } = useMemoryFolderDisplay({
    effectivePath,
    baseQuickAccessType,
    t,
  });
  // 「题目集」入口：全部题目集 / 跨题目集错题本（错题本里搜索框改搜错题）
  const [examsView, setExamsView] = useExamsView();
  const examsMistakesActive = currentQuickAccessType === 'exams' && mode !== 'canvas' && examsView === 'mistakes';
  const searchPlaceholder = examsMistakesActive
    ? t('mistakeBook.searchPlaceholder')
    : t(getSearchPlaceholderKey(effectivePath));
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
  // 「笔记」智能文件夹的学习分组视图（Notion 式数据库视图：同一份列表的不同投影）
  const [notesLearningView, setNotesLearningView] = useNotesLearningView();
  const [creatingLearningNote, setCreatingLearningNote] = useState(false);
  useEffect(() => {
    if (searchQuery.trim() && memoryTreeView) {
      setMemoryTreeView(false);
    }
  }, [searchQuery, memoryTreeView]);

  // ★ 收缩态强制折叠 QuickAccess
  const effectiveQuickAccessCollapsed = quickAccessCollapsed || isCollapsed;

  // P1-20: 移动端搜索框展开状态
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);

  const { mobileCreateMenuOpen, setMobileCreateMenuOpen, mobileCreateMenuTriggerRef } = useMobileCreateMenu();

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
  const [deleteTarget, setDeleteTarget] = useState<DeleteConfirmTarget | null>(null);
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

  const refreshCanvas = useCallback(() => refreshCanvasList({
    isMountedRef,
    canvasRequestIdRef,
    currentPath,
    canvasSearchQuery,
    setCanvasIsLoading,
    setCanvasError,
    queryItemsForPath,
    setCanvasItems,
    setCanvasSelectedIds,
    canvasLastSelectedId,
    setCanvasLastSelectedId,
  }), [canvasLastSelectedId, currentPath, canvasSearchQuery, queryItemsForPath]);

  useFinderHostLifecycle({ mode, sessionActive, hostId, currentPath, canvasSearchQuery, refreshCanvas });

  // ★ 2026-01-15: 完全移除双向同步逻辑
  // 原因：LearningHubNavigationContext 现在直接使用 finderStore 的历史栈（goBack/goForward）
  // 不再需要 navContext ↔ finderStore 的同步，因为它们现在共享同一个数据源
  // 这彻底解决了两个历史栈互相干扰导致的循环问题

  const lastLoadSignatureRef = useRef<string | null>(null);
  useEffect(() => runFinderLoadEffect({
    mode,
    sessionActive,
    searchQuery,
    debouncedSearchQuery,
    currentPath: { viewKind: currentPath.viewKind, folderId: currentPath.folderId, typeFilter: currentPath.typeFilter },
    lastLoadSignatureRef,
    currentPathDisplay,
    finderRefresh,
    isMountedRef,
    finderStore,
  }), [mode, sessionActive, currentPathDisplay, currentPath.viewKind, currentPath.folderId, currentPath.typeFilter, debouncedSearchQuery, searchQuery, finderRefresh, finderStore]);

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

  useDstuWatchRefresh({ sessionActive, currentPath, handleSilentRefresh, mode, finderStore });

  useEffect(() => subscribeFavoriteCount({ mode, sessionActive, isMountedRef, setFavoriteCount }), [mode, sessionActive]);

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

  const handleNewFolder = useCallback(() => beginPendingFolderDraft({
    ensureCreatableView,
    isMountedRef,
    cancelInlineEdit,
    clearSelection,
    pendingFolderSequenceRef,
    currentCreatableFolderId,
    pendingFolderDraftRef,
    setPendingFolderDraft,
    startInlineEdit,
  }), [cancelInlineEdit, clearSelection, currentCreatableFolderId, ensureCreatableView, startInlineEdit]);

  const { importMarkdownPathNotes, importMarkdownFileObjects, notifyMarkdownImportResult, openImportedMarkdownNote } = useMarkdownNoteImport({
    currentCreatableFolderId,
    t,
    onOpenApp,
  });

  const handleImportMarkdownNote = useCallback((folderId: string | null = currentCreatableFolderId) => importMarkdownNoteFromDialog({
    ensureCreatableView,
    t,
    importMarkdownPathNotes,
    isMountedRef,
    handleRefresh,
    openImportedMarkdownNote,
    notifyMarkdownImportResult,
  }, folderId), [currentCreatableFolderId, ensureCreatableView, handleRefresh, importMarkdownPathNotes, notifyMarkdownImportResult, openImportedMarkdownNote, t]);

  const handleQuickAccessNavigate = useQuickAccessNavigation({ enterFolder, quickAccessNavigate, t, mode, sessionActive });

  const { handleOpen, handleQuickLookOpen, handleOpenMany } = createOpenHandlers({
    currentPath,
    addRecent,
    handleQuickAccessNavigate,
    enterFolder,
    onOpenApp,
    onOpenPreview,
    setQuickLookItem,
    t,
  });

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

  const importPaths = useCallback((paths: string[]) => importPathsIntoLibrary({
    importProgress: { isImporting: importProgress.isImporting },
    t,
    currentCreatableFolderId,
    importMarkdownPathNotes,
    isMountedRef,
    setImportProgress,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
    onOpenApp,
  }, paths), [currentCreatableFolderId, importMarkdownPathNotes, importProgress.isImporting, openImportedMarkdownNote, t, handleRefresh, onOpenApp]);

  /**
   * 处理 Tauri 原生文件路径拖拽（优先路径，性能更好）
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
    await importPaths(paths);
  }, [currentPath, importPaths, t]);

  const handleFilesDrop = useCallback((files: File[]) => importDroppedFiles({
    pathsDropHandledRef,
    currentPath,
    t,
    importMarkdownFileObjects,
    currentCreatableFolderId,
    isMountedRef,
    setAttachImportProgress,
    handleRefresh,
    openImportedMarkdownNote,
  }, files), [currentCreatableFolderId, currentPath, currentQuickAccessType, handleRefresh, importMarkdownFileObjects, openImportedMarkdownNote, t]);

  const {
    handleNewNote,
    handleNewExam,
    handleNewTextbook,
    handleNewTranslation,
    handleNewEssay,
    handleNewMindMap,
  } = createResourceCreators({
    ensureCreatableView,
    currentCreatableFolderId,
    isMountedRef,
    t,
    handleRefresh,
    onOpenApp,
    setSelectedIds,
    importProgress,
    importPaths,
  });

  // 是否允许拖拽导入（排除回收站、特殊视图等）
  const isDragDropEnabled = mode !== 'canvas' && canDragDropInCurrentView;

  const { handleContextMenu, handleContainerContextMenu, handleEmptyStateCreate } = createContextMenuHandlers({
    setContextMenuPosition,
    currentPath,
    setContextMenuTarget,
    setContextMenuOpen,
    effectivePath,
    handleNewNote,
    handleNewExam,
    handleNewTranslation,
    handleNewEssay,
    handleNewMindMap,
  });

  // 右键菜单 - 进入文件夹
  const handleOpenFolder = useCallback((folderId: string) => {
    const folder = items.find(i => i.id === folderId && i.type === 'folder');
    if (folder) {
      // ★ 27-DSTU统一虚拟路径架构改造：传递后端返回的 path
      enterFolder(folderId, folder.name, folder.path);
    }
  }, [items, enterFolder]);

  const showSoftDeleteUndoToast = useCallback((
    targets: SoftDeleteTarget[],
    opts?: { refCount?: number }
  ) => showSoftDeleteUndo({ softDeleteUndoGenRef, t, softDeleteUndoInFlightRef, isMountedRef, handleRefresh }, targets, opts), [t, handleRefresh]);

  const handleDeleteFolder = useCallback((folderId: string) => deleteFolderToTrash({
    canDeleteInCurrentView,
    items,
    isMountedRef,
    showSoftDeleteUndoToast,
    handleRefresh,
  }, folderId), [canDeleteInCurrentView, items, handleRefresh, showSoftDeleteUndoToast]);

  const handleDeleteResource = useCallback((resource: ResourceListItem) => deleteResourceToTrash({
    canDeleteInCurrentView,
    items,
    t,
    isMountedRef,
    showSoftDeleteUndoToast,
    handleRefresh,
  }, resource), [canDeleteInCurrentView, items, t, handleRefresh, showSoftDeleteUndoToast]);

  const handleToggleFavorite = useCallback((resource: ResourceListItem) => toggleResourceFavorite({
    items,
    t,
    isMountedRef,
    handleRefresh,
  }, resource), [items, t, handleRefresh]);

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
  const handleInlineEditConfirm = useCallback((itemId: string, newName: string) => confirmInlineEdit({
    cancelInlineEdit,
    pendingFolderDraftRef,
    setPendingFolderDraft,
    isMountedRef,
    t,
    handleRefresh,
    items,
    inlineEdit: { editingType: inlineEdit.editingType },
    mode,
  }, itemId, newName), [items, inlineEdit.editingType, t, handleRefresh, cancelInlineEdit, mode]);

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

  const handleMoveItem = useCallback((itemId: string, targetFolderId: string | null) => moveSingleItem({
    items,
    canRecordMoveUndo,
    moveUndoSourceFolderId,
    isMountedRef,
    t,
    handleRefresh,
  }, itemId, targetFolderId), [items, t, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  const handleMoveItems = useCallback((itemIds: string[], targetFolderId: string | null) => moveMultipleItems({
    items,
    t,
    canRecordMoveUndo,
    moveUndoSourceFolderId,
    isMountedRef,
    clearSelection,
    handleRefresh,
  }, itemIds, targetFolderId), [items, t, clearSelection, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  const {
    clipboardCount,
    getSelectedNodes,
    resolveContextTargetNodes,
    handleCopyFromContextMenu,
    handleCopySelection,
  } = useClipboardSelection({ displayedItems, selectedIds, t });

  // 粘贴/制造副本门禁：仅真实文件夹导航（root / 子文件夹）。
  // 智能文件夹（typeFilter）目的地会退化为根目录且可能被过滤隐藏，不开放。
  const canPasteHere =
    mode !== 'canvas' &&
    canCreateInCurrentView &&
    effectivePath.viewKind === 'folder' &&
    !effectivePath.typeFilter;

  const executeCopyEntries = useCallback((
    entries: FinderClipboardEntry[],
    destFolderId: string | null,
    successKey: CopySuccessKey,
  ) => copyEntriesToFolder({ setIsBatchProcessing, isMountedRef, t, handleRefresh }, entries, destFolderId, successKey), [t, handleRefresh]);

  const { handlePaste, handleDuplicateFromContextMenu, handleDuplicateSelection } = useClipboardPasteActions({
    canPasteHere,
    currentCreatableFolderId,
    executeCopyEntries,
    resolveContextTargetNodes,
    getSelectedNodes,
  });

  const { parentDropTargets, specialDropTargets } = useDropTargets({
    canDragDropInCurrentView,
    mode,
    effectivePath,
    displayBreadcrumbs,
    t,
  });

  const handleSpecialDrop = useCallback((targetId: 'favorites' | 'trash', itemIds: string[]) => dropOnSpecialTarget({
    items,
    isMountedRef,
    t,
    handleRefresh,
    clearSelection,
    canDeleteInCurrentView,
    setIsBatchProcessing,
    showSoftDeleteUndoToast,
  }, targetId, itemIds), [items, t, handleRefresh, clearSelection, canDeleteInCurrentView, showSoftDeleteUndoToast]);

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

  useMultiSelectBridge({ multiSelectToggleRef, toggleMultiSelect, onMultiSelectModeChange, isMultiSelectMode });

  const executeBatchDelete = useCallback((idsToDelete: Set<string>) => executeBatchSoftDelete({
    setIsBatchProcessing,
    items,
    t,
    isMountedRef,
    showSoftDeleteUndoToast,
    clearSelection,
    setSelectedIds,
    handleRefresh,
  }, idsToDelete), [items, t, clearSelection, setSelectedIds, handleRefresh, showSoftDeleteUndoToast]);

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

  const handleRestoreItem = useCallback((id: string, itemType: string) => restoreTrashItem({
    isMountedRef,
    t,
    handleRefresh,
  }, id, itemType), [t, handleRefresh]);

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

  const executePermanentDelete = useCallback((id: string, itemType: string) => permanentlyDeleteTrashItem({
    isMountedRef,
    t,
    handleRefresh,
  }, id, itemType), [t, handleRefresh]);

  // 清空回收站
  const handleEmptyTrash = useCallback(() => {
    // ★ 使用 AlertDialog 替代 window.confirm
    setDeleteTarget({
      type: 'emptyTrash',
      message: t('finder.trash.emptyConfirm'),
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  const executeEmptyTrash = useCallback(() => emptyTrashBin({
    isMountedRef,
    softDeleteUndoGenRef,
    isTrashView,
    items,
    t,
    handleRefresh,
  }), [t, handleRefresh, isTrashView, items]);

  const handleConfirmDelete = useCallback(() => confirmPendingDelete({
    deleteTarget,
    setIsDeleting,
    items,
    isMountedRef,
    t,
    clearSelection,
    handleRefresh,
    executePermanentDelete,
    executeEmptyTrash,
    setDeleteConfirmOpen,
    setDeleteTarget,
  }), [deleteTarget, executePermanentDelete, executeEmptyTrash, items, t, clearSelection, handleRefresh]);

  const handleReferenceToChat = useSidebarReferenceToChat({ canInject, injectToChat, onReferenceToChat, t });

  // 已作为资料导入的 Markdown → 笔记：新建同名笔记（当前文件夹）并打开，原文件移到回收站（可撤销）
  useEffect(() => {
    const handleConvert = async (event: Event) => {
      const detail = (event as CustomEvent<ConvertMarkdownToNoteDetail>).detail;
      if (!detail?.resourceId || typeof detail.content !== 'string') return;
      // 正文以一级标题开头时用它作笔记标题并从正文去掉，避免「标题 + 同名 H1」重复
      const { title, body } = splitLeadingMarkdownHeading(detail.content);
      const created = await notesDstuAdapter.importMarkdownContent(
        title ? `${title}.md` : detail.name,
        title ? body : detail.content,
        currentCreatableFolderId,
      );
      if (!isMountedRef.current) return;
      if (!created.ok) {
        showGlobalNotification('error', created.error.toUserMessage());
        return;
      }
      // 先打开新笔记，再把原文件移到回收站（标记为主动移除：标签照常关闭、不弹「已删除或已移动」警告）
      setSelectedIds(new Set([created.value.id]));
      openImportedMarkdownNote(created.value);
      markIntentionalRemoval(detail.resourceId);
      const removed = await dstu.deleteMany([`/${detail.resourceId}`]);
      if (!isMountedRef.current) return;
      handleRefresh();
      showGlobalNotification('success', t('finder.convertToNote.success', { name: created.value.name }));
      if (removed.ok && removed.value > 0) {
        showSoftDeleteUndoToast([{ id: detail.resourceId, type: 'textbook', name: detail.name }]);
      }
    };
    window.addEventListener(CONVERT_MARKDOWN_TO_NOTE_EVENT, handleConvert);
    return () => window.removeEventListener(CONVERT_MARKDOWN_TO_NOTE_EVENT, handleConvert);
  }, [currentCreatableFolderId, handleRefresh, openImportedMarkdownNote, setSelectedIds, showSoftDeleteUndoToast, t]);

  const handleMakeCards = useMakeCardsAction({ handleReferenceToChat, t });

  const handleBatchAddToChat = useCallback(() => batchAddSelectionToChat({
    selectedIds,
    canAddToChatInCurrentView,
    canInject,
    t,
    setIsBatchProcessing,
    items,
    injectToChat,
    isMountedRef,
    clearSelection,
    setSelectedIds,
  }), [selectedIds, items, canInject, injectToChat, t, clearSelection, setSelectedIds, canAddToChatInCurrentView]);

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

  const handleBatchMoveConfirm = useCallback((targetFolderId: string | null) => confirmBatchMove({
    moveTargetIds,
    selectedIds,
    setIsBatchProcessing,
    items,
    t,
    canRecordMoveUndo,
    moveUndoSourceFolderId,
    isMountedRef,
    clearSelection,
    setSelectedIds,
    handleRefresh,
    setMoveTargetIds,
  }, targetFolderId), [moveTargetIds, selectedIds, items, t, clearSelection, setSelectedIds, handleRefresh, canRecordMoveUndo, moveUndoSourceFolderId]);

  const handleUndoLastOperation = useCallback(() => undoLastFinderOperation({
    isMountedRef,
    t,
    handleRefresh,
  }), [t, handleRefresh]);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => handleFinderKeyDown({
      containerRef,
      handleSelectAll,
      mode,
      handleUndoLastOperation,
      selectedIds,
      handleCopySelection,
      canPasteHere,
      clipboardCount,
      handlePaste,
      handleDuplicateSelection,
      currentPath: {
        viewKind: currentPath.viewKind,
        folderId: currentPath.folderId,
        breadcrumbs: { length: currentPath.breadcrumbs.length },
      },
      goUp,
      quickLookItem,
      canvasLastSelectedId,
      finderStore,
      displayedItems,
      setQuickLookItem,
      canDeleteInCurrentView,
      handleBatchDelete,
      handleClearSelection,
      isMultiSelectMode,
      toggleMultiSelect,
      searchQuery,
      setSearchQuery,
    }, e);
    
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
      onNewLearningNote={() => setCreatingLearningNote(true)}
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
        acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT, FILE_TYPES.CODE]}
        maxFiles={20}
        maxFileSize={200 * 1024 * 1024}
        customOverlayText={t('finder.dragDrop.overlayText')}
        className="flex-1 flex flex-col min-w-0 min-h-0"
      >
        {/* P1-20: 移动端顶部工具栏（搜索 + 新建文件夹 + 新建笔记 + 清空回收站） */}
        {isSmallScreen && !hideToolbarAndNav && (
          <SidebarMobileToolbar
            t={t}
            mobileSearchExpanded={mobileSearchExpanded}
            setMobileSearchExpanded={setMobileSearchExpanded}
            searchPlaceholder={searchPlaceholder}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            canSearchInCurrentView={canSearchInCurrentView}
            mobileCreateMenuOpen={mobileCreateMenuOpen}
            setMobileCreateMenuOpen={setMobileCreateMenuOpen}
            mobileCreateMenuTriggerRef={mobileCreateMenuTriggerRef}
            canCreateInCurrentView={canCreateInCurrentView}
            handleNewFolder={handleNewFolder}
            handleNewNote={handleNewNote}
            setCreatingLearningNote={setCreatingLearningNote}
            handleImportMarkdownNote={handleImportMarkdownNote}
            handleNewExam={handleNewExam}
            handleNewTextbook={handleNewTextbook}
            handleNewTranslation={handleNewTranslation}
            handleNewEssay={handleNewEssay}
            handleNewMindMap={handleNewMindMap}
            isTrashView={isTrashView}
            handleEmptyTrash={handleEmptyTrash}
            items={items}
          />
        )}

{/* ★ Canvas 模式导航栏：返回/前进 + 面包屑 */}
        {mode === 'canvas' && !hideToolbarAndNav && (
          <SidebarCanvasNavBar
            t={t}
            isSmallScreen={isSmallScreen}
            goBack={goBack}
            goForward={goForward}
            historyIndex={historyIndex}
            history={history}
            jumpToBreadcrumb={jumpToBreadcrumb}
            displayBreadcrumbs={displayBreadcrumbs}
          />
        )}

        {/* ★ Canvas 模式顶部工具栏：多选模式 + 关闭按钮。
            移动端聊天内嵌（hideToolbarAndNav）不渲染此条：面板完全使用全局
            顶栏，多选切换按钮由 ChatV2Page 放到全局顶栏右上角。 */}
        {mode === 'canvas' && !hideToolbarAndNav && (
          <SidebarCanvasToolbar
            t={t}
            isSmallScreen={isSmallScreen}
            isMultiSelectMode={isMultiSelectMode}
            selectedIds={selectedIds}
            items={items}
            handleClearSelection={handleClearSelection}
            handleSelectAll={handleSelectAll}
            canAddToChatInCurrentView={canAddToChatInCurrentView}
            handleBatchAddToChat={handleBatchAddToChat}
            isBatchProcessing={isBatchProcessing}
            isInjecting={isInjecting}
            toggleMultiSelect={toggleMultiSelect}
            onClose={onClose}
          />
        )}

        {!isSmallScreen && mode === 'fullscreen' && !hideToolbarAndNav && (
          <SidebarFinderToolbar
            t={t}
            displayBreadcrumbs={displayBreadcrumbs}
            jumpToBreadcrumb={jumpToBreadcrumb}
            currentQuickAccessType={currentQuickAccessType}
            historyIndex={historyIndex}
            history={history}
            goBack={goBack}
            goForward={goForward}
            viewMode={viewMode}
            setViewMode={setViewMode}
            sortBy={sortBy}
            sortOrder={sortOrder}
            setSorting={setSorting}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchPlaceholder={searchPlaceholder}
            canSearchInCurrentView={canSearchInCurrentView}
            canCreateInCurrentView={canCreateInCurrentView}
            handleNewFolder={handleNewFolder}
            handleRefresh={handleRefresh}
            quickAccessPortalTarget={quickAccessPortalTarget}
            handleNewNote={handleNewNote}
            setCreatingLearningNote={setCreatingLearningNote}
            handleImportMarkdownNote={handleImportMarkdownNote}
            handleNewExam={handleNewExam}
            handleNewTextbook={handleNewTextbook}
            handleNewTranslation={handleNewTranslation}
            handleNewEssay={handleNewEssay}
            handleNewMindMap={handleNewMindMap}
            toolbarPortalTarget={toolbarPortalTarget}
            toolbarPortalMode={toolbarPortalMode}
          />
        )}

        {/* ★ 2026-01-15: 向量化状态视图 */}
        {/* ★ 2026-01-19: VFS 记忆管理视图 */}
        {/* ★ 2026-01-31: 桌面视图 */}
        <SidebarContentArea
          t={t}
          effectivePath={effectivePath}
          currentPath={currentPath}
          mode={mode}
          onOpenApp={onOpenApp}
          activeFileId={activeFileId}
          highlightedIds={highlightedIds}
          isCollapsed={isCollapsed}
          isSmallScreen={isSmallScreen}
          isMountedRef={isMountedRef}
          items={items}
          displayedItems={displayedItems}
          isLoading={isLoading}
          error={error}
          viewMode={viewMode}
          selectedIds={selectedIds}
          multiSelectActive={multiSelectActive}
          isMultiSelectMode={isMultiSelectMode}
          isSearching={isSearching}
          searchMeta={searchMeta}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          debouncedSearchQuery={debouncedSearchQuery}
          currentQuickAccessType={currentQuickAccessType}
          isInMemoryFolder={isInMemoryFolder}
          memoryTreeView={memoryTreeView}
          setMemoryTreeView={setMemoryTreeView}
          notesLearningView={notesLearningView}
          setNotesLearningView={setNotesLearningView}
          examsView={examsView}
          setExamsView={setExamsView}
          examsMistakesActive={examsMistakesActive}
          canCreateInCurrentView={canCreateInCurrentView}
          canDragDropInCurrentView={canDragDropInCurrentView}
          isTrashView={isTrashView}
          inlineEdit={inlineEdit}
          handleQuickAccessNavigate={handleQuickAccessNavigate}
          handleOpen={handleOpen}
          handleOpenMany={handleOpenMany}
          enterFolder={enterFolder}
          navigateTo={navigateTo}
          goUp={goUp}
          handleRefresh={handleRefresh}
          select={select}
          clearSelection={clearSelection}
          setSelectedIds={setSelectedIds}
          handleContextMenu={handleContextMenu}
          handleContainerContextMenu={handleContainerContextMenu}
          handleEmptyStateCreate={handleEmptyStateCreate}
          handleMoveItem={handleMoveItem}
          handleMoveItems={handleMoveItems}
          handleInlineEditConfirm={handleInlineEditConfirm}
          handleInlineEditCancel={handleInlineEditCancel}
          startInlineEdit={startInlineEdit}
          getItemDisplayName={getItemDisplayName}
          parentDropTargets={parentDropTargets}
          specialDropTargets={specialDropTargets}
          handleSpecialDrop={handleSpecialDrop}
        />
      
        {creatingLearningNote && (
          <CreateLearningNoteDialog
            folderId={effectivePath.viewKind === 'folder' ? effectivePath.folderId : null}
            onClose={() => setCreatingLearningNote(false)}
            onCreated={(node) => { void handleRefresh(); onOpenApp?.(dstuNodeToResourceListItem(node, 'note')); }}
          />
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
      <SidebarContextMenu
        mode={mode}
        contextMenuOpen={contextMenuOpen}
        setContextMenuOpen={setContextMenuOpen}
        contextMenuPosition={contextMenuPosition}
        contextMenuTarget={contextMenuTarget}
        effectivePath={effectivePath}
        isTrashView={isTrashView}
        canCreateInCurrentView={canCreateInCurrentView}
        canDeleteInCurrentView={canDeleteInCurrentView}
        canMoveInCurrentView={canMoveInCurrentView}
        canAddToChatInCurrentView={canAddToChatInCurrentView}
        handleNewFolder={handleNewFolder}
        handleNewNote={handleNewNote}
        handleNewExam={handleNewExam}
        handleNewTextbook={handleNewTextbook}
        handleNewTranslation={handleNewTranslation}
        handleNewEssay={handleNewEssay}
        handleNewMindMap={handleNewMindMap}
        handleImportMarkdownNote={handleImportMarkdownNote}
        handleRefresh={handleRefresh}
        handleOpenFolder={handleOpenFolder}
        handleOpenRenameDialog={handleOpenRenameDialog}
        selectedIds={selectedIds}
        handleBatchDelete={handleBatchDelete}
        handleDeleteFolder={handleDeleteFolder}
        onOpenApp={onOpenApp}
        handleOpenRenameResourceDialog={handleOpenRenameResourceDialog}
        handleDeleteResource={handleDeleteResource}
        handleToggleFavorite={handleToggleFavorite}
        handleCopyFromContextMenu={handleCopyFromContextMenu}
        canPasteHere={canPasteHere}
        handleDuplicateFromContextMenu={handleDuplicateFromContextMenu}
        handlePaste={handlePaste}
        clipboardCount={clipboardCount}
        handleExportResource={handleExportResource}
        handleExportFolder={handleExportFolder}
        handleRestoreItem={handleRestoreItem}
        handlePermanentDeleteItem={handlePermanentDeleteItem}
        handleEmptyTrash={handleEmptyTrash}
        handleReferenceToChat={handleReferenceToChat}
        handleMakeCards={handleMakeCards}
        handleMoveTo={handleMoveTo}
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
        <AttachImportProgressBanner t={t} attachImportProgress={attachImportProgress} />
      )}
    </div>
  );
}
