import React, { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Search, Plus, FolderPlus, X, Trash2, Loader2, Workflow, CheckSquare, ListChecks, ChevronLeft, ChevronRight, Home } from 'lucide-react';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { textbookDstuAdapter } from '@/dstu/adapters/textbookDstuAdapter';
import { attachmentDstuAdapter } from '@/dstu/adapters/attachmentDstuAdapter';
import { UnifiedDragDropZone, FILE_TYPES } from '@/components/shared/UnifiedDragDropZone';
import { useDebounce } from '@/hooks/useDebounce';

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
  'pdf', 'docx', 'txt', 'md', 'html', 'htm',
  'xlsx', 'xls', 'xlsb', 'ods',
  'pptx', 'epub', 'rtf',
  'csv', 'json', 'xml',
]);

/** 图片类扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif',
]);

/** 从文件名获取扩展名 */
const getFileExtension = (name: string): string =>
  (name.split('.').pop() || '').toLowerCase();

// 懒加载向量化状态视图
const IndexStatusView = lazy(() => import('./views/IndexStatusView'));
// ★ 2026-01-19: 懒加载 VFS 记忆管理视图
const MemoryView = lazy(() => import('./views/MemoryView'));
// ★ 2026-01-31: 懒加载桌面视图
import { DesktopView, type CreateResourceType } from './components/finder';
import type { DesktopRootConfig } from './stores/desktopStore';
import { useFinderStore } from './stores/finderStore';
import { useRecentStore } from './stores/recentStore';
import { useLearningHubNavigationSafe } from './LearningHubNavigationContext';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  FinderToolbar,
  FinderQuickAccess,
  FinderFileList,
  FinderBatchToolbar,
  FolderPickerDialog,
} from './components/finder';
import { dstu, type DstuNode, folderApi, createEmpty, trashApi } from '@/dstu';
import { updatePathCacheV2 } from '@/chat-v2/context/vfsRefApi';
import { dstuNodeToResourceListItem } from './types';
import type { LearningHubSidebarProps, ResourceListItem } from './types';
import type { FolderItemType, FolderTreeNode } from '@/dstu/types/folder';
import { VfsError, VfsErrorCode, err, ok, reportError } from '@/shared/result';
import { LearningHubContextMenu, type ContextMenuTarget } from './components/LearningHubContextMenu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/shad/Dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/shad/AlertDialog';
import { Input } from '@/components/ui/shad/Input';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { usePageMount, pageLifecycleTracker } from '@/debug-panel/hooks/usePageLifecycle';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { pLimit } from '@/utils/concurrency';
import { ImportProgressModal, type ImportProgressState, type ImportStage } from './components/ImportProgressModal';
import { useVfsContextInject } from './hooks';
import type { VfsResourceType } from '@/chat-v2/context/types';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import { consumePathsDropHandledFlag, isDragDropBlockedView } from './dragDropRouting';

/** ★ Bug4: canvas 模式下不应显示的特殊视图 folderId 集合 */
const CANVAS_BLOCKED_VIEW_IDS = new Set(['indexStatus', 'memory', 'desktop']);

export function LearningHubSidebar({
  mode,
  onOpenApp,
  onClose,
  className,
  isCollapsed = false,
  onToggleCollapse,
  activeFileId,
  mobileBottomPadding = false,
  hasOpenApp = false,
  onCloseApp,
  hideToolbarAndNav = false,
}: LearningHubSidebarProps) {
  const { t } = useTranslation('learningHub');

  // ========== 响应式布局 ==========
  const { isSmallScreen } = useBreakpoint();

  // ========== 页面生命周期监控 ==========
  usePageMount('learning-hub-sidebar', 'LearningHubSidebar');

  // Store state
  const {
    currentPath,
    history,
    historyIndex,
    viewMode,
    selectedIds,
    searchQuery,
    isSearching,
    items,
    isLoading,
    error,

    // Actions
    goBack,
    goForward,
    jumpToBreadcrumb,
    setViewMode,
    select,
    selectAll,
    clearSelection,
    setSelectedIds,
    setSearchQuery,
    setItems,
    setLoading,
    setError,
    enterFolder,
    navigateTo,
    quickAccessNavigate,
    setCurrentPathWithoutHistory,
  } = useFinderStore();

  // ★ Bug4 修复：canvas 模式下，如果 currentPath 是特殊视图（indexStatus/memory/desktop），
  // 自动重置到 root，避免从 LearningHubPage 泄露的特殊视图状态影响聊天侧边栏
  // 使用 setCurrentPathWithoutHistory 避免污染共享的导航历史栈
  useEffect(() => {
    if (mode === 'canvas' && currentPath.folderId && CANVAS_BLOCKED_VIEW_IDS.has(currentPath.folderId)) {
      debugLog.log('[LearningHub] canvas 模式检测到特殊视图，重置到 root:', currentPath.folderId);
      setCurrentPathWithoutHistory('root');
    }
  }, [mode]); // 仅在组件挂载/mode 变化时检查，避免循环

  // ★ 搜索防抖处理：延迟 300ms 触发 API 调用，避免快速输入导致频繁请求
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  // ★ 最近访问记录 Store
  const addRecent = useRecentStore(state => state.addRecent);

  // Local state for QuickAccess collapse (折叠状态，不是隐藏)
  const [quickAccessCollapsed, setQuickAccessCollapsed] = useState(false);

  // ★ 收缩态强制折叠 QuickAccess
  const effectiveQuickAccessCollapsed = quickAccessCollapsed || isCollapsed;

  // P1-20: 移动端搜索框展开状态
  const [mobileSearchExpanded, setMobileSearchExpanded] = useState(false);

  // ★ Canvas 模式多选模式状态
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // New folder/note dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createDialogType, setCreateDialogType] = useState<'folder' | 'note' | 'exam' | 'textbook' | 'translation' | 'essay' | 'mindmap'>('folder');
  const [createDialogName, setCreateDialogName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  
  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget>({ type: 'empty' });

  // ★ 删除确认对话框状态（替代 window.confirm）
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'resource' | 'permanent' | 'emptyTrash' | 'batch';
    resource?: ResourceListItem;
    permanentDeleteInfo?: { id: string; itemType: string };
    batchIds?: Set<string>;
    message: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Batch operation state
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  
  // ★ 教材导入进度状态
  const [importProgress, setImportProgress] = useState<ImportProgressState>({
    isImporting: false,
    fileName: '',
    stage: 'hashing',
    progress: 0,
  });
  
  // Inline editing state (from store)
  const {
    inlineEdit,
    startInlineEdit,
    cancelInlineEdit,
  } = useFinderStore();
  
  // Container ref for keyboard shortcuts scope
  const containerRef = useRef<HTMLDivElement>(null);

  // ★ MEDIUM-004/005: 组件卸载标志，防止内存泄漏
  const isMountedRef = useRef(true);

  // ★ P0-001 修复: 防止 UnifiedDragDropZone 同时调用 onPathsDropped 和 onFilesDropped 导致双重导入
  const pathsDropHandledRef = useRef(false);

  // ★ VFS 上下文注入 Hook（用于批量添加到对话）
  const { injectToChat, canInject, isInjecting } = useVfsContextInject();

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ★ 2025-12-31: 移除组件挂载时的 reset() 调用
  // 原因: finderStore 使用 persist 中间件保存导航状态到 localStorage
  // 如果每次挂载都 reset，会导致:
  // 1. 用户在子文件夹时切换视图，路径被意外重置到根目录
  // 2. 移动端三屏布局切换时丢失导航状态
  // 导航状态应该由用户操作控制，而非组件生命周期

  // ★ 文档28 Prompt 8: 同步 finderStore 与 LearningHubNavigationContext
  const navContext = useLearningHubNavigationSafe();
  const navContextFolderId = navContext?.currentFolderId;

  // ★ 2026-01-15: 规范化 folderId，统一 null/'root'/undefined 为 null
  // 解决死循环问题：navContext 使用 null 表示根目录，finderStore 使用 'root'
  const normalizeRootFolderId = useCallback((id: string | null | undefined): string | null => {
    if (id === 'root' || id === null || id === undefined) return null;
    return id;
  }, []);

  const normalizedFinderFolderId = normalizeRootFolderId(currentPath.folderId);
  const normalizedNavFolderId = normalizeRootFolderId(navContextFolderId);

  // ★ 2026-01-15: 完全移除双向同步逻辑
  // 原因：LearningHubNavigationContext 现在直接使用 finderStore 的历史栈（goBack/goForward）
  // 不再需要 navContext ↔ finderStore 的同步，因为它们现在共享同一个数据源
  // 这彻底解决了两个历史栈互相干扰导致的循环问题

  // ★ 获取 DSTU 列表选项（文件夹优先模式）
  const { getDstuListOptions } = useFinderStore();

  // Load items when path changes
  // ★ 使用 debouncedSearchQuery 触发搜索，避免快速输入导致频繁 API 调用
  useEffect(() => {
    // ★ MEDIUM-004: 使用取消标志防止快速导航时的状态不同步
    let isCancelled = false;
    const currentPathSnapshot = currentPath; // 保存当前路径快照

    const loadData = async () => {
      const start = Date.now();
      pageLifecycleTracker.log('learning-hub-sidebar', 'LearningHubSidebar', 'data_load', `path: ${currentPath.dstuPath}`);
      setLoading(true);
      setError(null);

      let result;

      try {
        // ★ 2026-01-15: indexStatus 视图不需要加载 DSTU 列表
        // ★ 2026-01-19: memory 视图不需要加载 DSTU 列表
        // ★ 2026-01-31: desktop 视图不需要加载 DSTU 列表
        if (currentPath.folderId === 'indexStatus' || currentPath.folderId === 'memory' || currentPath.folderId === 'desktop') {
          result = ok([]);
          setLoading(false);
          return;
        }
        
        if (isSearching && debouncedSearchQuery) {
          const listOptions = { ...getDstuListOptions() };
          // search/searchInFolder 由参数决定范围，避免传递特殊 folderId
          if (listOptions.folderId) {
            delete listOptions.folderId;
          }
          const isSearchInFolder = Boolean(
            currentPath.folderId &&
            !['root', 'trash', 'recent', 'indexStatus', 'memory', 'desktop'].includes(currentPath.folderId)
          );
          result = isSearchInFolder
            ? await dstu.searchInFolder(currentPath.folderId, debouncedSearchQuery, listOptions)
            : await dstu.search(debouncedSearchQuery, listOptions);
        } else if (currentPath.folderId === 'trash') {
          result = await trashApi.listTrash();
        } else if (currentPath.folderId === 'recent') {
          // 🔧 P0-11 修复: 最近文件视图使用前端存储
          const recentStore = useRecentStore.getState();
          const recentItems = recentStore.getRecentItems();
          const nodes: DstuNode[] = [];

          for (const recent of recentItems) {
            // 尝试获取资源详情
            let nodeResult = await dstu.get(recent.path);
            if (!nodeResult.ok) {
              // 降级：尝试用 ID 构造路径重试
              nodeResult = await dstu.get(`/${recent.id}`);
            }
            if (nodeResult.ok && nodeResult.value) {
              nodes.push(nodeResult.value);
            } else {
              // 资源已不存在，从最近记录中移除
              debugLog.warn('[LearningHub] 最近文件已不存在，从记录中移除:', recent.path, recent.id);
              recentStore.removeRecent(recent.id);
            }
          }
          result = ok(nodes);
        } else {
          const listOptions = getDstuListOptions();
          const path = currentPath.dstuPath.startsWith('/') ? currentPath.dstuPath : `/${currentPath.dstuPath}`;
          result = await dstu.list(path, listOptions);
        }

        // ★ 检查是否已取消或路径已变化
        if (isCancelled) {
          debugLog.log('[LearningHub] 数据加载已取消，丢弃结果');
          return;
        }

        // ★ 检查路径是否仍然匹配（避免快速导航时的数据错乱）
        const { currentPath: latestPath } = useFinderStore.getState();
        if (latestPath.dstuPath !== currentPathSnapshot.dstuPath ||
            latestPath.folderId !== currentPathSnapshot.folderId) {
          debugLog.log('[LearningHub] 路径已变化，丢弃过期数据');
          return;
        }

        // ★ MEDIUM-005: 检查组件是否已卸载
        if (!isMountedRef.current) {
          debugLog.log('[LearningHub] 组件已卸载，丢弃数据加载结果');
          return;
        }

        if (result.ok) {
          setItems(result.value);
          pageLifecycleTracker.log('learning-hub-sidebar', 'LearningHubSidebar', 'data_ready', `${result.value.length} items`, { duration: Date.now() - start });
        } else {
          debugLog.error('Failed to load items:', result.error);
          reportError(result.error, 'load resource list');
          setError(result.error.toUserMessage());
        }
      } catch (err) {
        if (!isCancelled && isMountedRef.current) {
          debugLog.error('Unexpected error loading items:', err);
          setError(t('error.loadFailedRetry', '加载失败，请重试'));
        }
      } finally {
        if (!isCancelled && isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    loadData();

    // ★ 清理函数：取消请求
    return () => {
      isCancelled = true;
    };
  }, [currentPath.dstuPath, currentPath.folderId, currentPath.typeFilter, isSearching, debouncedSearchQuery, setItems, setLoading, setError, getDstuListOptions]);

  // Handle open item
  const handleOpen = (item: DstuNode) => {
    // ★ 记录访问（排除文件夹）
    if (item.type !== 'folder') {
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
        // 映射到 QuickAccessType
        const typeMap: Record<string, Parameters<typeof quickAccessNavigate>[0]> = {
          'notes': 'notes',
          'textbooks': 'textbooks',
          'exams': 'exams',
          'essays': 'essays',
          'translations': 'translations',
          'images': 'images',
          'files': 'files',
        };
        const quickAccessType = typeMap[typeSegment];
        if (quickAccessType) {
          quickAccessNavigate(quickAccessType);
          return;
        }
      }
      // 真实文件夹：使用 folderId 导航，传递后端返回的 path
      enterFolder(item.id, item.name, item.path);
    } else {
      if (onOpenApp) {
        // Map DstuNodeType to FolderItemType
        let itemType: FolderItemType = 'note';
        switch (item.type) {
            case 'textbook': itemType = 'textbook'; break;
            case 'exam': itemType = 'exam'; break;
            case 'translation': itemType = 'translation'; break;
            case 'essay': itemType = 'essay'; break;
            case 'image': itemType = 'image'; break;
            case 'file': itemType = 'file'; break;
            case 'mindmap': itemType = 'mindmap'; break;
            default: itemType = 'note';
        }

        const resourceItem = dstuNodeToResourceListItem(item, itemType);
        onOpenApp(resourceItem);
      }
    }
  };

  // ★ 刷新请求 ID，用于取消过期请求
  const refreshRequestIdRef = useRef(0);

  // Refresh current directory
  const handleRefresh = useCallback(async () => {
    // ★ MEDIUM-005: 组件卸载检查
    if (!isMountedRef.current) return;

    // ★ 生成新的请求 ID，取消之前的刷新请求
    const requestId = ++refreshRequestIdRef.current;

    setLoading(true);
    setError(null);

    let result;

    try {
      // ★ 2026-01-15: indexStatus 视图不需要刷新 DSTU 列表
      // ★ 2026-01-19: memory 视图不需要刷新 DSTU 列表
      // ★ 2026-01-31: desktop 视图不需要刷新 DSTU 列表
      if (currentPath.folderId === 'indexStatus' || currentPath.folderId === 'memory' || currentPath.folderId === 'desktop') {
        setLoading(false);
        return;
      }
      
      // ★ 使用 debouncedSearchQuery 刷新搜索结果
      if (isSearching && debouncedSearchQuery) {
        const listOptions = { ...getDstuListOptions() };
        if (listOptions.folderId) {
          delete listOptions.folderId;
        }
        const isSearchInFolder = Boolean(
          currentPath.folderId &&
          !['root', 'trash', 'recent', 'indexStatus', 'memory', 'desktop'].includes(currentPath.folderId)
        );
        result = isSearchInFolder
          ? await dstu.searchInFolder(currentPath.folderId, debouncedSearchQuery, listOptions)
          : await dstu.search(debouncedSearchQuery, listOptions);
      } else if (currentPath.folderId === 'trash') {
        result = await trashApi.listTrash();
      } else if (currentPath.folderId === 'recent') {
        // 🔧 P0-11 修复: 最近文件视图使用前端存储
        const recentStore = useRecentStore.getState();
        const recentItems = recentStore.getRecentItems();
        const nodes: DstuNode[] = [];

        for (const recent of recentItems) {
          let nodeResult = await dstu.get(recent.path);
          if (!nodeResult.ok) {
            nodeResult = await dstu.get(`/${recent.id}`);
          }
          if (nodeResult.ok && nodeResult.value) {
            nodes.push(nodeResult.value);
          } else {
            recentStore.removeRecent(recent.id);
          }
        }
        result = ok(nodes);
      } else {
        const listOptions = getDstuListOptions();
        const path = currentPath.dstuPath.startsWith('/') ? currentPath.dstuPath : `/${currentPath.dstuPath}`;
        result = await dstu.list(path, listOptions);
      }

      // ★ 检查请求是否已过期（有更新的刷新请求发起）
      if (refreshRequestIdRef.current !== requestId) {
        debugLog.log('[LearningHub] handleRefresh 请求已过期，丢弃结果', { requestId, current: refreshRequestIdRef.current });
        return;
      }

      // ★ 异步操作完成后检查组件是否已卸载
      if (!isMountedRef.current) return;

      if (result.ok) {
        setItems(result.value);
      } else {
        reportError(result.error, 'refresh resource list');
        setError(result.error.toUserMessage());
      }
    } catch (err) {
      // ★ 检查请求是否已过期
      if (refreshRequestIdRef.current !== requestId) return;
      if (isMountedRef.current) {
        debugLog.error('Unexpected error refreshing items:', err);
        setError(t('error.refreshFailedRetry', '刷新失败，请重试'));
      }
    } finally {
      // ★ 只有当前请求才更新 loading 状态
      if (refreshRequestIdRef.current === requestId && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, [currentPath.dstuPath, currentPath.folderId, isSearching, debouncedSearchQuery, setItems, setLoading, setError, getDstuListOptions]);

  // ★ 监听 DSTU 资源变化，自动刷新列表（带防抖，避免批量操作时频繁刷新）
  const watchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (currentPath.folderId === 'indexStatus' || currentPath.folderId === 'memory' || currentPath.folderId === 'desktop') {
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
          handleRefresh();
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
  }, [currentPath.folderId, handleRefresh]);

  // Open create dialog
  const handleNewFolder = () => {
    setCreateDialogType('folder');
    setCreateDialogName('');
    setCreateDialogOpen(true);
  };

  const handleNewNote = async () => {
    // ★ 2025-12-13: 改为与题目集/翻译/作文一致，直接创建空笔记
    const result = await createEmpty({
      type: 'note',
      folderId: currentPath.folderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.noteSuccess', '笔记已创建'));
      handleRefresh();
      // 打开右侧应用面板
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'note'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewExam = async () => {
    // ★ 创建空题目集文件并打开应用面板
    const result = await createEmpty({
      type: 'exam',
      folderId: currentPath.folderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.examSuccess', '题目集识别已创建'));
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
    if (importProgress.isImporting) return; // 防止重复点击
    
    let unlisten: UnlistenFn | null = null;
    
    try {
      // 打开文件选择对话框
      const selected = await dialogOpen({
        multiple: true,
        filters: [
          {
            name: t('textbook.allDocuments', '所有文档'),
            // 注：doc（旧版 Word）不支持，无纯 Rust 解析库
            extensions: [
              'pdf', 'docx', 'txt', 'md', 'html', 'htm',
              'xlsx', 'xls', 'xlsb', 'ods',
              'pptx', 'epub', 'rtf',
              'csv', 'json', 'xml',
            ],
          },
          {
            name: t('textbook.pdfDocuments', 'PDF 文档'),
            extensions: ['pdf'],
          },
          {
            name: t('textbook.wordDocuments', 'Word 文档'),
            extensions: ['docx'],
          },
          {
            name: t('textbook.excelFiles', 'Excel/CSV 表格'),
            extensions: ['xlsx', 'xls', 'xlsb', 'ods', 'csv'],
          },
          {
            name: t('textbook.textFiles', '文本文件'),
            extensions: ['txt', 'md', 'html', 'htm'],
          },
          {
            name: t('textbook.presentationFiles', '演示文稿/电子书'),
            extensions: ['pptx', 'epub', 'rtf'],
          },
          {
            name: t('textbook.dataFiles', '数据文件'),
            extensions: ['json', 'xml'],
          },
        ],
        title: t('textbook.selectFiles', '选择学习资料文件'),
      });

      if (!selected || (Array.isArray(selected) && selected.length === 0)) {
        return; // 用户取消选择
      }

      const filePaths = Array.isArray(selected) ? selected : [selected];
      const firstFileName = filePaths[0]?.split('/').pop() || 'textbook.pdf';
      
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
      const targetFolderId = currentPath.folderId && currentPath.folderId !== 'root' ? currentPath.folderId : null;
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
        setImportProgress(prev => ({
          ...prev,
          stage: 'error',
          error: t('textbook.importEmpty', '没有成功导入任何教材'),
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
        error: t('textbook.importError', '导入教材失败'),
      }));
    }
  };

  const handleNewTranslation = async () => {
    // ★ 创建空翻译文件并打开应用面板
    const result = await createEmpty({
      type: 'translation',
      folderId: currentPath.folderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.translationSuccess', '翻译已创建'));
      handleRefresh();
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'translation'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewEssay = async () => {
    // ★ 创建空作文文件并打开应用面板
    const result = await createEmpty({
      type: 'essay',
      folderId: currentPath.folderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.essaySuccess', '作文已创建'));
      handleRefresh();
      if (onOpenApp) {
        onOpenApp(dstuNodeToResourceListItem(result.value, 'essay'));
      }
    } else {
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  const handleNewMindMap = async () => {
    // ★ 创建空思维导图文件并打开应用面板
    const result = await createEmpty({
      type: 'mindmap',
      folderId: currentPath.folderId,
    });

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.mindmapSuccess', '知识导图已创建'));
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
    if (isDragDropBlockedView(currentPath.folderId)) {
      showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere', '当前视图不支持拖入文件'));
      return;
    }
    // 统一导入主链路：本次拖拽已走路径分支，后续 files 回调直接跳过。
    pathsDropHandledRef.current = true;
    if (importProgress.isImporting) return;

    debugLog.log('[LearningHub] 拖拽导入文件:', paths.length, '个文件');

    // 按类型分组
    const docPaths: string[] = [];
    const imagePaths: string[] = [];
    const otherPaths: string[] = [];

    for (const p of paths) {
      const name = p.split(/[/\\]/).pop() || '';
      const ext = getFileExtension(name);
      if (DOCUMENT_EXTENSIONS.has(ext)) {
        docPaths.push(p);
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        imagePaths.push(p);
      } else {
        otherPaths.push(p);
      }
    }

    debugLog.log('[LearningHub] 文件分类:', {
      documents: docPaths.length,
      images: imagePaths.length,
      others: otherPaths.length,
    });

    let totalSuccess = 0;
    let totalFailed = 0;
    let unlisten: UnlistenFn | null = null;

    try {
      // 1. 文档类：通过 textbookDstuAdapter 导入（支持 PDF 渲染、哈希去重等）
      if (docPaths.length > 0) {
        const firstFileName = docPaths[0]?.split(/[/\\]/).pop() || '';
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

        // ★ M-fix: 拖拽导入也传递当前文件夹ID
        const dropTargetFolderId = currentPath.folderId && currentPath.folderId !== 'root' ? currentPath.folderId : null;
        const docResult = await textbookDstuAdapter.addTextbooks(docPaths, dropTargetFolderId);

        if (unlisten) { unlisten(); unlisten = null; }

        if (!isMountedRef.current) return;

        if (docResult.ok) {
          totalSuccess += docResult.value.length;
          // 打开第一个导入的文档
          if (docResult.value.length > 0 && onOpenApp) {
            onOpenApp(dstuNodeToResourceListItem(docResult.value[0], 'textbook'));
          }
        } else {
          totalFailed += docPaths.length;
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

        const attachResults = await Promise.all(
          attachmentPaths.map((filePath) =>
            limit(async () => {
              const name = filePath.split(/[/\\]/).pop() || 'file';
              const ext = getFileExtension(name);
              const isImage = IMAGE_EXTENSIONS.has(ext);

              try {
                const url = convertFileSrc(filePath);
                const res = await fetch(url);
                if (!res.ok) return { ok: false as const, name };

                const blob = await res.blob();
                const file = new File([blob], name, {
                  type: blob.type || (isImage ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'),
                });

                const result = await attachmentDstuAdapter.create(
                  file,
                  isImage ? 'image' : 'file',
                );
                return { ok: result.ok, name };
              } catch (e) {
                debugLog.error('[LearningHub] 附件导入失败:', name, e);
                return { ok: false as const, name };
              }
            })
          )
        );

        if (!isMountedRef.current) return;

        for (const r of attachResults) {
          if (r.ok) totalSuccess++;
          else totalFailed++;
        }
      }

      // 3. 显示结果通知
      if (totalSuccess > 0 && totalFailed === 0) {
        showGlobalNotification('success',
          t('finder.dragDrop.importSuccess', '已导入 {{count}} 个文件', { count: totalSuccess })
        );
      } else if (totalSuccess > 0 && totalFailed > 0) {
        showGlobalNotification('warning',
          t('finder.dragDrop.importPartial', '导入 {{success}} 个成功，{{failed}} 个失败', {
            success: totalSuccess,
            failed: totalFailed,
          })
        );
      } else if (totalFailed > 0) {
        showGlobalNotification('error',
          t('finder.dragDrop.importFailed', '文件导入失败')
        );
      }

      // 4. 刷新文件列表
      if (totalSuccess > 0) {
        handleRefresh();
      }
    } catch (error) {
      if (unlisten) unlisten();
      debugLog.error('[LearningHub] 拖拽导入异常:', error);
      setImportProgress(prev => ({ ...prev, isImporting: false }));
      showGlobalNotification('error', t('finder.dragDrop.importFailed', '文件导入失败'));
    }
  }, [currentPath.folderId, importProgress.isImporting, t, handleRefresh, onOpenApp]);

  /**
   * 处理浏览器 File 对象拖拽（非 Tauri 环境兜底）
   */
  const handleFilesDrop = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (consumePathsDropHandledFlag(pathsDropHandledRef)) {
      debugLog.log('[LearningHub] 跳过 files 回调，统一走 paths 导入链路');
      return;
    }
    if (isDragDropBlockedView(currentPath.folderId)) {
      showGlobalNotification('warning', t('finder.dragDrop.notAllowedHere', '当前视图不支持拖入文件'));
      return;
    }

    debugLog.log('[LearningHub] 浏览器拖拽导入:', files.length, '个文件');

    let totalSuccess = 0;
    let totalFailed = 0;
    const limit = pLimit(3);

    const results = await Promise.all(
      files.map((file) =>
        limit(async () => {
          const ext = getFileExtension(file.name);
          const isImage = IMAGE_EXTENSIONS.has(ext);

          try {
            const result = await attachmentDstuAdapter.create(
              file,
              isImage ? 'image' : 'file',
            );
            return result.ok;
          } catch {
            return false;
          }
        })
      )
    );

    if (!isMountedRef.current) return;

    for (const ok of results) {
      if (ok) totalSuccess++;
      else totalFailed++;
    }

    if (totalSuccess > 0 && totalFailed === 0) {
      showGlobalNotification('success',
        t('finder.dragDrop.importSuccess', '已导入 {{count}} 个文件', { count: totalSuccess })
      );
    } else if (totalSuccess > 0) {
      showGlobalNotification('warning',
        t('finder.dragDrop.importPartial', '导入 {{success}} 个成功，{{failed}} 个失败', {
          success: totalSuccess,
          failed: totalFailed,
        })
      );
    } else {
      showGlobalNotification('error', t('finder.dragDrop.importFailed', '文件导入失败'));
    }

    if (totalSuccess > 0) handleRefresh();
  }, [currentPath.folderId, t, handleRefresh]);

  // 是否允许拖拽导入（排除回收站、特殊视图等）
  const isDragDropEnabled = mode !== 'canvas' && !isDragDropBlockedView(currentPath.folderId);

  // Create folder (note creation moved to handleNewNote)
  const handleCreate = async () => {
    if (!createDialogName.trim()) return;

    setIsCreating(true);
    // ★ 2025-12-13: 对话框现在只用于创建文件夹，笔记创建使用 createEmpty
    const result = await folderApi.createFolder(
      createDialogName.trim(),
      currentPath.folderId ?? undefined
    );

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    setIsCreating(false);

    if (result.ok) {
      showGlobalNotification('success', t('finder.create.folderSuccess'));
      setCreateDialogOpen(false);
      handleRefresh();
    } else {
      reportError(result.error, 'create folder');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  };

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, item: DstuNode) => {
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
      // Map to ResourceListItem
      let itemType: FolderItemType = 'note';
      switch (item.type) {
        case 'textbook': itemType = 'textbook'; break;
        case 'exam': itemType = 'exam'; break;
        case 'translation': itemType = 'translation'; break;
        case 'essay': itemType = 'essay'; break;
        case 'mindmap': itemType = 'mindmap'; break;
        default: itemType = 'note';
      }
      const resourceItem = dstuNodeToResourceListItem(item, itemType);
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

  // 右键菜单 - 删除文件夹（软删除到回收站，无需确认）
  const handleDeleteFolder = useCallback(async (folderId: string) => {
    const result = await folderApi.deleteFolder(folderId);

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('contextMenu.deleteFolderSuccess', '文件夹已移至回收站'));
      handleRefresh();
    } else {
      reportError(result.error, 'delete folder');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [t, handleRefresh]);

  // 右键菜单 - 删除资源（软删除到回收站，显示引用计数）
  const handleDeleteResource = useCallback(async (resource: ResourceListItem) => {
    // ★ MEDIUM-004: 删除前查询引用数量
    const { getResourceRefCountV2 } = await import('@/chat-v2/context/vfsRefApi');
    const refCountResult = await getResourceRefCountV2(resource.id);

    let confirmMessage = t('contextMenu.confirmDelete', '确定要删除此资源吗？');
    if (refCountResult.ok && refCountResult.value > 0) {
      confirmMessage = t(
        'contextMenu.confirmDeleteWithRefs',
        `此资源被 ${refCountResult.value} 个对话引用，删除后这些对话将无法访问此资源。确定要删除吗？`,
        { count: refCountResult.value }
      );
    }

    // ★ 使用 AlertDialog 替代 window.confirm
    setDeleteTarget({
      type: 'resource',
      resource,
      message: confirmMessage,
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  // ★ 执行删除资源操作（AlertDialog 确认后调用）
  const executeDeleteResource = useCallback(async (resource: ResourceListItem) => {
    // 优先使用 resource.path，如果没有则从 items 中查找
    let deletePath = resource.path;
    if (!deletePath) {
      const item = items.find(i => i.id === resource.id);
      deletePath = item?.path;
    }

    if (!deletePath) {
      const resourceId = resource.id;
      deletePath = `/${resourceId}`;
    }

    if (!deletePath) {
      showGlobalNotification('error', t('contextMenu.deleteError', '无法删除：资源路径未找到'));
      return;
    }

    const deleteResult = await dstu.delete(deletePath);

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (deleteResult.ok) {
      showGlobalNotification('success', t('contextMenu.deleteSuccess', '删除成功'));
      handleRefresh();
    } else {
      reportError(deleteResult.error, 'delete resource');
      showGlobalNotification('error', deleteResult.error.toUserMessage());
    }
  }, [items, t, handleRefresh]);

  // P1-14: 右键菜单 - 收藏/取消收藏资源
  const handleToggleFavorite = useCallback(async (resource: ResourceListItem) => {
    // 获取资源路径
    let resourcePath = resource.path;
    if (!resourcePath) {
      const item = items.find(i => i.id === resource.id);
      resourcePath = item?.path;
    }

    if (!resourcePath) {
      showGlobalNotification('error', t('contextMenu.favoriteError', '无法收藏：资源路径未找到'));
      return;
    }

    // 切换收藏状态
    const newFavoriteState = !resource.isFavorite;
    const result = await dstu.setFavorite(resourcePath, newFavoriteState);

    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success',
        newFavoriteState
          ? t('contextMenu.favoriteSuccess', '已添加到收藏')
          : t('contextMenu.unfavoriteSuccess', '已取消收藏')
      );
      handleRefresh();
    } else {
      reportError(result.error, 'toggle favorite');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [items, t, handleRefresh]);

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
      cancelInlineEdit();
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
        showGlobalNotification('error', t('contextMenu.renameError', '无法重命名：资源路径未找到'));
        if (isMountedRef.current) {
          await handleRefresh();
        }
        return;
      }
      renameResult = await dstu.rename(resourcePath, newName.trim());
    }

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (renameResult.ok) {
      showGlobalNotification('success', t('contextMenu.renameSuccess', '重命名成功'));
      await handleRefresh();
    } else {
      reportError(renameResult.error, 'rename');
      showGlobalNotification('error', renameResult.error.toUserMessage());
      // 出错时也需要刷新以恢复原始状态
      await handleRefresh();
    }
  }, [items, inlineEdit.editingType, t, handleRefresh, cancelInlineEdit]);

  // 内联编辑取消处理
  const handleInlineEditCancel = useCallback(() => {
    cancelInlineEdit();
  }, [cancelInlineEdit]);

  // 拖拽移动单个项目
  const handleMoveItem = useCallback(async (itemId: string, targetFolderId: string | null) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    // 根据类型调用不同的移动 API
    let result;
    if (item.type === 'folder') {
      result = await folderApi.moveFolder(itemId, targetFolderId ?? undefined);
    } else {
      // 非文件夹使用 moveItem
      // P1-13: 修复 image/file 类型拖拽移动失败
      let itemType: FolderItemType = 'note';
      switch (item.type) {
        case 'textbook': itemType = 'textbook'; break;
        case 'exam': itemType = 'exam'; break;
        case 'translation': itemType = 'translation'; break;
        case 'essay': itemType = 'essay'; break;
        case 'image': itemType = 'image'; break;
        case 'file': itemType = 'file'; break;
        case 'mindmap': itemType = 'mindmap'; break;
        default: itemType = 'note';
      }
      result = await folderApi.moveItem(itemType, itemId, targetFolderId ?? undefined);
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
  }, [items, t, handleRefresh]);

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
            t('error.itemNotFound', '项目未找到'),
            true,
            { itemId }
          );
          return err(notFoundError);
        }

        if (item.type === 'folder') {
          return await folderApi.moveFolder(itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
        } else {
          // P1-13: 修复 image/file 类型拖拽移动失败
          let itemType: FolderItemType = 'note';
          switch (item.type) {
            case 'textbook': itemType = 'textbook'; break;
            case 'exam': itemType = 'exam'; break;
            case 'translation': itemType = 'translation'; break;
            case 'essay': itemType = 'essay'; break;
            case 'image': itemType = 'image'; break;
            case 'file': itemType = 'file'; break;
            case 'mindmap': itemType = 'mindmap'; break;
            default: itemType = 'note';
          }
          return await folderApi.moveItem(itemType, itemId, targetFolderId ?? undefined, { skipCacheRefresh: true });
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
  }, [items, t, clearSelection, handleRefresh]);

  // 批量全选 - 使用 store 的 selectAll
  const handleSelectAll = useCallback(() => {
    selectAll();
  }, [selectAll]);

  // 清除选择 - 使用 store 的 clearSelection
  const handleClearSelection = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  // 批量删除（显示确认对话框）
  const handleBatchDelete = useCallback(() => {
    if (selectedIds.size === 0) return;

    // ★ 使用 AlertDialog 替代直接删除
    setDeleteTarget({
      type: 'batch',
      batchIds: new Set(selectedIds),
      message: t('finder.batch.confirmDelete', {
        count: selectedIds.size,
        defaultValue: `确定要删除选中的 ${selectedIds.size} 个项目吗？删除后可在回收站恢复。`
      }),
    });
    setDeleteConfirmOpen(true);
  }, [selectedIds, t]);

  // ★ 执行批量删除操作（AlertDialog 确认后调用）
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
            error: t('error.itemNotFound', '项目未找到'),
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

      if (failed === 0) {
        // 全部成功
        showGlobalNotification('success', t('finder.batch.deleteSuccess', { count: idsToDelete.size }));
        clearSelection();
      } else if (succeeded > 0) {
        // 部分成功 - 保留失败项的选择状态
        showGlobalNotification('warning',
          t('finder.batch.deletePartial', { succeeded, failed }) +
          ' ' + t('finder.batch.failedItemsSelected', '失败的项目已保持选中状态，可重试')
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
  }, [items, t, clearSelection, setSelectedIds, handleRefresh]);

  // ★ 2025-12-11: 回收站相关操作
  // 检测是否在回收站视图
  const isTrashView = currentPath.folderId === 'trash';

  // 恢复项目
  const handleRestoreItem = useCallback(async (id: string, itemType: string) => {
    const result = await trashApi.restoreItem(id, itemType);

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.trash.restoreSuccess', '已恢复'));
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
      message: t('finder.trash.confirmPermanentDelete', '确定要永久删除此项目吗？此操作不可撤销。'),
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  // ★ 执行永久删除操作（AlertDialog 确认后调用）
  const executePermanentDelete = useCallback(async (id: string, itemType: string) => {
    const result = await trashApi.permanentlyDelete(id, itemType);

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.trash.deleteSuccess', '已永久删除'));
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
      message: t('finder.trash.emptyConfirm', '确定要永久删除回收站中的所有项目吗？此操作不可撤销。'),
    });
    setDeleteConfirmOpen(true);
  }, [t]);

  // ★ 执行清空回收站操作（AlertDialog 确认后调用）
  const executeEmptyTrash = useCallback(async () => {
    const result = await trashApi.emptyTrash();

    // ★ MEDIUM-005: 检查组件是否已卸载
    if (!isMountedRef.current) return;

    if (result.ok) {
      showGlobalNotification('success', t('finder.trash.emptySuccess', '已清空回收站') + ` (${result.value})`);
      handleRefresh();
    } else {
      reportError(result.error, 'empty trash');
      showGlobalNotification('error', result.error.toUserMessage());
    }
  }, [t, handleRefresh]);

  // ★ AlertDialog 确认删除处理
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      switch (deleteTarget.type) {
        case 'resource':
          if (deleteTarget.resource) {
            await executeDeleteResource(deleteTarget.resource);
          }
          break;
        case 'batch':
          if (deleteTarget.batchIds) {
            await executeBatchDelete(deleteTarget.batchIds);
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
  }, [deleteTarget, executeDeleteResource, executeBatchDelete, executePermanentDelete, executeEmptyTrash]);

  // ★ 批量添加到对话（将选中的文件引用发送到 Chat V2 附件区域）
  const handleBatchAddToChat = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (!canInject()) {
      showGlobalNotification('warning', t('finder.multiSelect.noChatSession', '请先打开一个对话'));
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
            return { id, ok: false, error: t('error.itemNotFound', '项目未找到') };
          }

          // 文件夹不支持添加到对话
          if (item.type === 'folder') {
            return { id, ok: false, error: t('error.folderCannotAddToChat', '文件夹不支持添加到对话') };
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
            return { id, ok: false, error: t('error.unsupportedResourceType', '不支持的资源类型: {{type}}', { type: item.type }) };
          }

          const result = await injectToChat({
            sourceId: item.sourceId || item.id,
            sourceType,
            name: item.name,
            metadata: { title: item.name },
            resourceHash: item.resourceHash,
          });

          return { id, ok: result.success, error: result.error };
        })
      ));

      if (!isMountedRef.current) return;

      const failedResults = injectResults.filter(r => !r.ok);
      const succeeded = injectResults.length - failedResults.length;
      const failed = failedResults.length;

      if (failed === 0) {
        showGlobalNotification('success', t('finder.multiSelect.addToChatSuccess', '已添加 {{count}} 项到对话', { count: succeeded }));
        clearSelection();
      } else if (succeeded > 0) {
        showGlobalNotification('warning',
          t('finder.multiSelect.addToChatPartial', '成功添加 {{succeeded}} 项，{{failed}} 项失败', { succeeded, failed })
        );
        // 保留失败项的选择状态
        const failedIds = failedResults.map(r => r.id);
        setSelectedIds(new Set(failedIds));
      } else {
        showGlobalNotification('error', t('finder.multiSelect.addToChatFailed', '添加失败'));
      }
    } catch (err) {
      debugLog.error('[LearningHub] 批量添加到对话失败:', err);
      showGlobalNotification('error', t('finder.multiSelect.addToChatFailed', '添加失败'));
    } finally {
      if (isMountedRef.current) {
        setIsBatchProcessing(false);
      }
    }
  }, [selectedIds, items, canInject, injectToChat, t, clearSelection, setSelectedIds]);

  // 批量移动（打开移动对话框）
  const handleBatchMove = useCallback(() => {
    if (selectedIds.size === 0) return;
    setMoveDialogOpen(true);
  }, [selectedIds]);

  // 批量移动确认
  const handleBatchMoveConfirm = useCallback(async (targetFolderId: string | null) => {
    if (selectedIds.size === 0) return;

    setIsBatchProcessing(true);

    try {
      const idsArray = Array.from(selectedIds);
      // ★ 并发控制：限制同时执行的移动操作为 3 个，避免文件系统操作冲突
      const limit = pLimit(3);

      const moveResults = await Promise.all(idsArray.map((id, index) =>
        limit(async () => {
          const item = items.find(i => i.id === id);
          if (!item) {
            return {
              id,
              ok: false,
              error: t('error.itemNotFound', '项目未找到')
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
            // P1-13: 修复 image/file 类型拖拽移动失败
            let itemType: FolderItemType = 'note';
            switch (item.type) {
              case 'textbook': itemType = 'textbook'; break;
              case 'exam': itemType = 'exam'; break;
              case 'translation': itemType = 'translation'; break;
              case 'essay': itemType = 'essay'; break;
              case 'image': itemType = 'image'; break;
              case 'file': itemType = 'file'; break;
              case 'mindmap': itemType = 'mindmap'; break; // 🔒 审计修复: 添加遗漏的 mindmap 类型映射
              default: itemType = 'note';
            }
            const result = await folderApi.moveItem(itemType, id, targetFolderId ?? undefined, { skipCacheRefresh: true });
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

      // ★ MEDIUM-005: 检查组件是否已卸载
      if (!isMountedRef.current) return;

      // ★ 单次遍历统计成功、失败和失败ID
      const failedResults = moveResults.filter(r => !r.ok);
      const succeeded = moveResults.length - failedResults.length;
      const failed = failedResults.length;
      const failedIds = failedResults.map(r => r.id);

      if (failed === 0) {
        // 全部成功
        showGlobalNotification('success', t('finder.batch.moveSuccess'));
        clearSelection();
      } else if (succeeded > 0) {
        // 部分成功 - 保留失败项的选择状态
        showGlobalNotification('warning',
          t('finder.batch.movePartial', { succeeded, failed }) +
          ' ' + t('finder.batch.failedItemsSelected', '失败的项目已保持选中状态，可重试')
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
      }
    }
  }, [selectedIds, items, t, clearSelection, setSelectedIds, handleRefresh]);

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
      
      // Cmd/Ctrl + A：全选
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        handleSelectAll();
      }
      
      // Delete/Backspace：删除选中项
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
        e.preventDefault();
        handleBatchDelete();
      }
      
      // Escape：清除选择
      if (e.key === 'Escape' && selectedIds.size > 0) {
        e.preventDefault();
        handleClearSelection();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, handleSelectAll, handleBatchDelete, handleClearSelection]);

  return (
    <div ref={containerRef} className={cn("flex h-full bg-background border-r", className)} tabIndex={-1}>
      {/* 左侧：快速导航栏（可折叠，包含搜索和新建）- 移动端和 canvas 模式隐藏 */}
      {!isSmallScreen && mode !== 'canvas' && (
        <FinderQuickAccess
          collapsed={effectiveQuickAccessCollapsed}
          activeType={
            // ★ 根据 currentPath 计算正确的 activeType
            currentPath.folderId === 'root' ? 'allFiles' :
            currentPath.folderId === 'trash' ? 'trash' :
            currentPath.folderId === 'recent' ? 'recent' :
            currentPath.folderId === 'indexStatus' ? 'indexStatus' :
            currentPath.folderId === 'memory' ? 'memory' :
            currentPath.folderId === 'desktop' ? 'desktop' :
            currentPath.dstuPath === '/@favorites' ? 'favorites' :
            (currentPath.typeFilter as any)
          }
          onNavigate={quickAccessNavigate}
          onToggleCollapse={() => setQuickAccessCollapsed(!quickAccessCollapsed)}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onNewFolder={handleNewFolder}
          onNewNote={handleNewNote}
          onNewExam={handleNewExam}
          onNewTextbook={handleNewTextbook}
          onNewTranslation={handleNewTranslation}
          onNewEssay={handleNewEssay}
          onNewMindMap={handleNewMindMap}
          // Counts
          favoriteCount={0}
        />
      )}

      {/* 右侧：工具栏 + 文件列表（包裹拖拽导入区域） */}
      <UnifiedDragDropZone
        zoneId="learning-hub-finder"
        onFilesDropped={handleFilesDrop}
        onPathsDropped={handlePathsDrop}
        enabled={isDragDropEnabled}
        acceptedFileTypes={[FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT]}
        maxFiles={20}
        maxFileSize={200 * 1024 * 1024}
        customOverlayText={t('finder.dragDrop.overlayText', '拖放文件到此处导入')}
        className="flex-1 flex flex-col min-w-0 min-h-0"
      >
        {/* P1-20: 移动端顶部工具栏（搜索 + 新建文件夹 + 新建笔记 + 清空回收站） */}
        {isSmallScreen && !hideToolbarAndNav && (
          <div 
            className="flex items-center gap-1 px-2 py-1.5 border-b border-border/40 bg-background/95 backdrop-blur-lg shrink-0"
            style={{ marginTop: 3 }}
          >
            {mobileSearchExpanded ? (
              // 搜索框展开态
              <div className="flex-1 flex items-center gap-1">
                <Input
                  type="text"
                  placeholder={t('finder.search.placeholder', '搜索...')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="h-7 text-sm flex-1"
                  autoFocus
                />
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => {
                    setMobileSearchExpanded(false);
                    setSearchQuery('');
                  }}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              </div>
            ) : (
              // 工具栏按钮
              <>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setMobileSearchExpanded(true)}
                  title={t('finder.search.title', '搜索')}
                >
                  <Search className="w-4 h-4" />
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={handleNewFolder}
                  title={t('finder.actions.newFolder', '新建文件夹')}
                >
                  <FolderPlus className="w-4 h-4" />
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={handleNewNote}
                  title={t('finder.actions.newNote', '新建笔记')}
                >
                  <Plus className="w-4 h-4" />
                </NotionButton>
                {/* 回收站视图显示清空按钮 */}
                {isTrashView && (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={handleEmptyTrash}
                    title={t('finder.actions.emptyTrash', '清空回收站')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </NotionButton>
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
          <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border/40 bg-muted/30 shrink-0 min-w-0">
            {/* 返回/前进按钮 */}
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              onClick={goBack}
              disabled={historyIndex <= 0}
              title={t('finder.toolbar.back', '返回')}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 shrink-0"
              onClick={goForward}
              disabled={historyIndex >= history.length - 1}
              title={t('finder.toolbar.forward', '前进')}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </NotionButton>
            {/* 面包屑路径 */}
            <div className="flex items-center gap-0.5 min-w-0 overflow-hidden text-xs">
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => jumpToBreadcrumb(-1)} className="shrink-0 !h-4 !w-4 !p-0" title={t('learningHub:title', '资源库')} aria-label="home">
                <Home className="w-3 h-3" />
              </NotionButton>
              {currentPath.breadcrumbs.map((crumb, index) => (
                <React.Fragment key={crumb.id}>
                  <span className="text-muted-foreground/50 shrink-0">/</span>
                  {index === currentPath.breadcrumbs.length - 1 ? (
                    <span className="truncate text-foreground font-medium">{crumb.name}</span>
                  ) : (
                    <NotionButton variant="ghost" size="sm" onClick={() => jumpToBreadcrumb(index)} className="!h-auto !p-0 truncate text-muted-foreground hover:text-foreground">
                      {crumb.name}
                    </NotionButton>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* ★ Canvas 模式顶部工具栏：多选模式 + 关闭按钮 */}
        {mode === 'canvas' && (
          <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/40 bg-background/95 backdrop-blur-lg shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {isMultiSelectMode ? (
                // 多选模式下显示选中信息和操作
                <>
                  <span className="text-xs font-medium whitespace-nowrap">
                    {selectedIds.size > 0
                      ? t('finder.canvas.selected', '已选 {{count}} 项', { count: selectedIds.size })
                      : t('finder.canvas.selectHint', '点击选择文件')}
                  </span>
                  {selectedIds.size > 0 && (
                    <>
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs px-1.5"
                        onClick={selectedIds.size === items.length ? handleClearSelection : handleSelectAll}
                        title={selectedIds.size === items.length ? t('finder.batch.deselectAll', '取消全选') : t('finder.batch.selectAll', '全选')}
                      >
                        {selectedIds.size === items.length
                          ? <CheckSquare className="w-3.5 h-3.5" />
                          : t('finder.batch.selectAll', '全选')}
                      </NotionButton>
                      <NotionButton
                        variant="primary"
                        size="sm"
                        className="h-6 text-xs px-2"
                        onClick={handleBatchAddToChat}
                        disabled={isBatchProcessing || isInjecting}
                      >
                        {isInjecting
                          ? t('finder.canvas.adding', '添加中...')
                          : t('finder.canvas.addToChat', '添加到聊天')}
                      </NotionButton>
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
              <NotionButton
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 w-7 p-0",
                  isMultiSelectMode && "bg-primary/10 text-primary hover:bg-primary/15"
                )}
                onClick={() => {
                  if (isMultiSelectMode) {
                    setIsMultiSelectMode(false);
                    handleClearSelection();
                  } else {
                    setIsMultiSelectMode(true);
                  }
                }}
                title={isMultiSelectMode ? t('finder.canvas.exitMultiSelect', '退出多选') : t('finder.canvas.multiSelect', '多选')}
              >
                <ListChecks className="w-4 h-4" />
              </NotionButton>
              {/* 关闭资源库按钮 */}
              {onClose && (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={onClose}
                  title={t('common:close', '关闭')}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              )}
            </div>
          </div>
        )}

        {/* ★ 2026-01-15: 向量化状态视图 */}
        {/* ★ 2026-01-19: VFS 记忆管理视图 */}
        {/* ★ 2026-01-31: 桌面视图 */}
        {currentPath.folderId === 'indexStatus' ? (
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }>
            <IndexStatusView />
          </Suspense>
        ) : currentPath.folderId === 'memory' ? (
          <Suspense fallback={
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }>
            <MemoryView onOpenApp={onOpenApp} />
          </Suspense>
        ) : currentPath.folderId === 'desktop' ? (
          <DesktopView
            onNavigateQuickAccess={quickAccessNavigate}
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
                showGlobalNotification('error', t('desktop.resourceNotFound', '资源不存在或已被删除'));
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
                  note: t('finder.create.noteSuccess', '笔记已创建'),
                  exam: t('finder.create.examSuccess', '题目集已创建'),
                  essay: t('finder.create.essaySuccess', '作文已创建'),
                  translation: t('finder.create.translationSuccess', '翻译已创建'),
                  mindmap: t('finder.create.mindmapSuccess', '思维导图已创建'),
                };
                showGlobalNotification('success', resourceNames[type]);

                // 2. 导航到目标文件夹
                if (targetFolderId) {
                  enterFolder(targetFolderId);
                } else {
                  // 导航到根目录
                  navigateTo({
                    ...currentPath,
                    dstuPath: '/',
                    folderId: null,
                    breadcrumbs: [],
                    typeFilter: null,
                    resourceType: null,
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
          <FinderFileList
            items={items}
            viewMode={isCollapsed || mode === 'canvas' ? 'list' : viewMode}
            selectedIds={selectedIds}
            onSelect={
              mode === 'canvas' && !isMultiSelectMode
                ? (id, _mode) => {
                    // 非多选模式下，单击直接打开文件/文件夹
                    const item = items.find(i => i.id === id);
                    if (item) handleOpen(item);
                  }
                : mode === 'canvas' && isMultiSelectMode
                  ? (id, selectMode) => {
                      // ★ 多选模式下，普通单击改为 toggle 模式，允许累加/取消选择
                      select(id, selectMode === 'single' ? 'toggle' : selectMode);
                    }
                  : select
            }
            onOpen={
              mode === 'canvas'
                ? isMultiSelectMode
                  ? (item) => { if (item.type === 'folder') handleOpen(item); }
                  : handleOpen
                : handleOpen
            }
            onContextMenu={mode === 'canvas' ? undefined : handleContextMenu}
            onContainerClick={mode === 'canvas' ? (isMultiSelectMode ? clearSelection : undefined) : clearSelection}
            onContainerContextMenu={mode === 'canvas' ? undefined : handleContainerContextMenu}
            onMoveItem={mode === 'canvas' ? undefined : handleMoveItem}
            onMoveItems={mode === 'canvas' ? undefined : handleMoveItems}
            isLoading={isLoading}
            error={error}
            enableDragDrop={mode !== 'canvas'}
            editingId={mode === 'canvas' ? undefined : inlineEdit.editingId}
            onEditConfirm={mode === 'canvas' ? undefined : handleInlineEditConfirm}
            onEditCancel={mode === 'canvas' ? undefined : handleInlineEditCancel}
            compact={isCollapsed || mode === 'canvas'}
            activeFileId={activeFileId}
            enableBoxSelect={mode === 'canvas' ? isMultiSelectMode : !isCollapsed}
            onSelectionChange={setSelectedIds}
            onRetry={handleRefresh}
          />
        )}
      
        {/* Batch Operation Toolbar + View Mode Toggle + App Close - canvas 模式用顶部工具栏 */}
        {mode === 'canvas' ? null : (
          <FinderBatchToolbar
            selectedCount={selectedIds.size}
            totalCount={items.length}
            onSelectAll={handleSelectAll}
            onClearSelection={handleClearSelection}
            onBatchDelete={handleBatchDelete}
            onBatchMove={handleBatchMove}
            onBatchAddToChat={handleBatchAddToChat}
            isProcessing={isBatchProcessing || isInjecting}
            viewMode={isCollapsed ? 'list' : viewMode}
            onViewModeChange={isCollapsed ? undefined : setViewMode}
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
        currentFolderId={currentPath.folderId}
        isTrashView={isTrashView}
        onCreateFolder={() => handleNewFolder()}
        onCreateItem={(type, _folderId) => {
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
        }}
        onRefresh={handleRefresh}
        onOpenFolder={handleOpenFolder}
        onRenameFolder={handleOpenRenameDialog}
        onDeleteFolder={(folderId) => {
          // ★ BUG FIX: 如果右键的文件夹属于多选集合且选中数量 > 1，走批量删除路径
          if (selectedIds.size > 1 && selectedIds.has(folderId)) {
            handleBatchDelete();
          } else {
            handleDeleteFolder(folderId);
          }
        }}
        onOpenResource={(resource) => {
          if (onOpenApp && 'id' in resource) {
            onOpenApp(resource as ResourceListItem);
          }
        }}
        onRenameResource={handleOpenRenameResourceDialog}
        onDeleteResource={(resource) => {
          // ★ BUG FIX: 如果右键的资源属于多选集合且选中数量 > 1，走批量删除路径
          if (selectedIds.size > 1 && selectedIds.has(resource.id)) {
            handleBatchDelete();
          } else {
            handleDeleteResource(resource);
          }
        }}
        onToggleFavorite={handleToggleFavorite}
        onRestoreItem={handleRestoreItem}
        onPermanentDeleteItem={handlePermanentDeleteItem}
        onEmptyTrash={handleEmptyTrash}
      />
      
      {/* Create Folder Dialog - Notion 风格 */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-[400px] p-2.5 gap-0 overflow-hidden">
          {/* 标题区 */}
          <DialogHeader className="px-5 pt-5 pb-3">
            <DialogTitle className="flex items-center gap-2 text-base font-medium">
              <FolderPlus className="w-4 h-4 text-muted-foreground" />
              {t('finder.create.folderTitle')}
            </DialogTitle>
          </DialogHeader>
          {/* 内容区 */}
          <div className="px-5 pb-4">
            <input
              type="text"
              placeholder={t('finder.create.folderPlaceholder')}
              value={createDialogName}
              onChange={(e) => setCreateDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isCreating) {
                  handleCreate();
                }
              }}
              autoFocus
              className="w-full h-9 px-3 text-sm bg-muted/30 border-transparent rounded-md focus:border-border focus:bg-background focus:outline-none transition-colors"
            />
          </div>
          {/* 底部操作区 */}
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border/40">
            <NotionButton variant="ghost" size="sm" onClick={() => setCreateDialogOpen(false)} disabled={isCreating}>
              {t('common:cancel')}
            </NotionButton>
            <NotionButton variant="primary" size="sm" onClick={handleCreate} disabled={!createDialogName.trim() || isCreating}>
              {isCreating && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin inline" />}
              {isCreating ? t('common:actions.creating') : t('common:actions.create')}
            </NotionButton>
          </div>
        </DialogContent>
      </Dialog>
      
      {/* Folder Picker Dialog for Batch Move */}
      <FolderPickerDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        excludeFolderIds={Array.from(selectedIds).filter(id =>
          items.find(i => i.id === id)?.type === 'folder'
        )}
        onConfirm={handleBatchMoveConfirm}
        title={t('finder.batch.moveDialogTitle', '移动到...')}
      />

      {/* ★ 删除确认对话框 - 替代原生 window.confirm */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={(open) => {
        if (!open && !isDeleting) {
          setDeleteConfirmOpen(false);
          setDeleteTarget(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteTarget?.type === 'emptyTrash'
                ? t('finder.trash.emptyTitle', '清空回收站')
                : t('contextMenu.deleteTitle', '确认删除')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('common:cancel', '取消')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t('common:deleting', '删除中...') : t('common:delete', '删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename Dialog - Replaced with Inline Editing */}

      {/* ★ 教材导入进度模态框 */}
      <ImportProgressModal
        state={importProgress}
        onClose={() => setImportProgress(prev => ({ ...prev, isImporting: false }))}
      />
    </div>
  );
}
