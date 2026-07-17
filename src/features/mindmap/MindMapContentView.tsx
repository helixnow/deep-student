import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
// 初始化思维导图模块（注册布局、样式、预设）
import './init';
import {
  createMindMapStore,
  MindMapStoreContext,
  registerMindMapStore,
  useMindMapStore,
  useMindMapStoreApi,
  type MindMapStoreApi,
} from './store';
import { MindMapActiveContext } from './MindMapActiveContext';
import { MindMapErrorBoundary } from './MindMapErrorBoundary';
import { dstu } from '@/dstu';
import { StyleRegistry } from './registry';
import { exportToOpml, exportToMarkdown, exportToJson, exportToImage } from './utils/exporters';
import { importMindMap } from './utils/importers';
import { fileManager } from '@/utils/fileManager';
import { cn } from '@/lib/utils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import {
  FileText,
  GitBranch,
  FloppyDisk,
  Download,
  Upload,
  DotsThree,
  ArrowCounterClockwise,
  ArrowClockwise,
  MagnifyingGlass,
  X,
  CaretUp,
  CaretDown,
  CaretLeft,
  Keyboard,
  WarningCircle,
  ArrowClockwise as RefreshIcon,
  Gear,
  BookOpen,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
} from '@phosphor-icons/react';
import { Input } from '@/components/ui/shad/Input';
import { useTranslation } from 'react-i18next';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuCheckboxItem,
  AppMenuSeparator,
} from '@/components/ui/app-menu/AppMenu';
import { OutlineView, type OutlineViewHandle } from './views/OutlineView';
import { MindMapView, type MindMapViewHandle } from './views/MindMapView';
import { StructureSelector } from './components/mindmap/StructureSelector';
import { StyleSettings } from './components/toolbar/StylePanel';
import { ReciteStatusBar } from './components/shared/ReciteStatusBar';
import { Progress } from '@/components/ui/shad/Progress';
import { useMindMapClipboard } from './hooks/useMindMapClipboard';
import { useCanvasDragMode } from './hooks/useCanvasDragMode';
import './styles/mindmap.css';

/** 挂在 ActiveContext Provider 内，使大纲/画布共用剪贴板快捷键且受 isActive 门控 */
const MindMapClipboardEffects: React.FC = () => {
  useMindMapClipboard();
  return null;
};

interface MindMapContentViewProps {
  resourceId?: string;
  /** Workbench windowId；用于同资源多宿主时精确路由 activation。 */
  storeInstanceId?: string;
  onTitleChange?: (title: string) => void;
  onReady?: () => void;
  onLoadError?: (message: string) => void;
  /** ★ 标签页：当前视图是否为活跃标签页 */
  isActive?: boolean;
  /** Move focus into the mind-map surface when this tab becomes active. */
  focusOnActive?: boolean;
  /** Report document save state to an owning workspace tab strip. */
  onSaveStateChange?: (state: 'saved' | 'saving' | 'dirty') => void;
  className?: string;
}

const MindMapContentViewInner: React.FC<MindMapContentViewProps> = ({
  resourceId,
  onTitleChange,
  onReady,
  onLoadError,
  isActive,
  focusOnActive,
  onSaveStateChange,
  className
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const storeApi = useMindMapStoreApi();
  
  // 从新 store 获取状态
  const currentView = useMindMapStore(state => state.currentView);
  const setCurrentView = useMindMapStore(state => state.setCurrentView);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const setReciteMode = useMindMapStore(state => state.setReciteMode);
  const hideCompleted = useMindMapStore(state => state.hideCompleted);
  const setHideCompleted = useMindMapStore(state => state.setHideCompleted);
  const mindmapDocument = useMindMapStore(state => state.document);
  const isDirty = useMindMapStore(state => state.isDirty);
  const isSaving = useMindMapStore(state => state.isSaving);
  const isExporting = useMindMapStore(state => state.isExporting);
  const exportProgress = useMindMapStore(state => state.exportProgress);
  const save = useMindMapStore(state => state.save);
  const loadMindMap = useMindMapStore(state => state.loadMindMap);
  const undo = useMindMapStore(state => state.undo);
  const redo = useMindMapStore(state => state.redo);
  const canUndo = useMindMapStore(state => state.canUndo);
  const canRedo = useMindMapStore(state => state.canRedo);
  
  // 搜索
  const searchFn = useMindMapStore(state => state.search);
  const searchResults = useMindMapStore(state => state.searchResults);
  const currentSearchIndex = useMindMapStore(state => state.currentSearchIndex);
  const nextSearchResult = useMindMapStore(state => state.nextSearchResult);
  const prevSearchResult = useMindMapStore(state => state.prevSearchResult);
  const clearSearch = useMindMapStore(state => state.clearSearch);
  const searchFilterMode = useMindMapStore(state => state.searchFilterMode);
  const setSearchFilterMode = useMindMapStore(state => state.setSearchFilterMode);
  const setDocument = useMindMapStore(state => state.setDocument);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  const collapseAll = useMindMapStore(state => state.collapseAll);
  const expandAll = useMindMapStore(state => state.expandAll);
  const collapseToDepth = useMindMapStore(state => state.collapseToDepth);

  // A6-24: 保存冲突时暂存的本地编辑快照 + 恢复/忽略
  const conflictSnapshot = useMindMapStore(state => state.conflictSnapshot);
  const restoreConflictSnapshot = useMindMapStore(state => state.restoreConflictSnapshot);
  const dismissConflictSnapshot = useMindMapStore(state => state.dismissConflictSnapshot);
  
  // 获取当前主题（用于导出时设置背景色）
  const styleId = useMindMapStore(state => state.styleId);
  const currentTheme = useMemo(() => StyleRegistry.get(styleId) || StyleRegistry.getDefault(), [styleId]);
  
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const lastTitleRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 工具栏面板互斥状态：同一时间只允许打开一个面板
  const [activePanel, setActivePanel] = useState<'structure' | 'style' | 'more' | null>(null);

  // 移动端悬浮面板状态
  const [showMobileStructure, setShowMobileStructure] = useState(false);
  const [showMobileStyle, setShowMobileStyle] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  // 画布空白拖拽模式（框选/平移）：快捷键帮助面板按当前模式展示对应操作
  const [canvasDragMode] = useCanvasDragMode();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);
  // A6-16: 导入未保存确认改为声明式 NotionAlertDialog（替换 window.confirm）
  const [showImportConfirm, setShowImportConfirm] = useState(false);

  useEffect(() => {
    if (!isActive || !focusOnActive) return;
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      try {
        container.focus({ preventScroll: true });
      } catch {
        container.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusOnActive, isActive]);

  useEffect(() => {
    onSaveStateChange?.(isSaving ? 'saving' : isDirty ? 'dirty' : 'saved');
  }, [isDirty, isSaving, onSaveStateChange]);

  // 大纲⇄导图双模保真：离开前写入 store.viewports，切回时作为 initial* 恢复
  // focusedNodeId / selection / collapsed 已在文档与 store 中，切换不重置
  const outlineViewRef = useRef<OutlineViewHandle>(null);
  const mindMapViewRef = useRef<MindMapViewHandle>(null);
  const setViewViewport = useMindMapStore(state => state.setViewViewport);
  const outlineScrollRestore = useMindMapStore(state => state.viewports.outline?.scrollTop ?? null);
  const mindMapViewportRestore = useMindMapStore(state => state.viewports.mindmap ?? null);

  const switchView = useCallback(
    (next: 'outline' | 'mindmap') => {
      const prev = storeApi.getState().currentView;
      if (prev === next) return;

      // 切换前显式提交正在编辑的文本：卸载 textarea 不会触发 React onBlur，
      // 依赖 blur 同步派发 commit，避免快速切换丢失未提交字符。
      const active = window.document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
      ) {
        active.blur();
      }
      const state = storeApi.getState();
      if (state.editingNodeId) state.setEditingNodeId(null);
      if (state.editingNoteNodeId) state.setEditingNoteNodeId(null);

      if (prev === 'outline') {
        const top = outlineViewRef.current?.getScrollTop() ?? 0;
        setViewViewport('outline', { scrollTop: top });
      } else if (prev === 'mindmap') {
        try {
          const vp = mindMapViewRef.current?.getViewport();
          if (vp) setViewViewport('mindmap', vp);
        } catch {
          // ReactFlow 可能已卸载，忽略
        }
      }

      setCurrentView(next);
    },
    [setCurrentView, setViewViewport, storeApi],
  );

  // 移动端浮层/子屏打开时注册 Android 返回键：返回 = 关闭当前层
  useEffect(() => {
    if (!showMobileStructure) return;
    return registerBackHandler(() => {
      setShowMobileStructure(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showMobileStructure]);

  useEffect(() => {
    if (!showMobileStyle) return;
    return registerBackHandler(() => {
      setShowMobileStyle(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showMobileStyle]);

  useEffect(() => {
    if (!showShortcutHelp) return;
    return registerBackHandler(() => {
      setShowShortcutHelp(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showShortcutHelp]);

  // ★ 标签页保活：isActive 变化时 saveDraft / loadMindMap
  const prevIsActiveRef = useRef(isActive);
  const saveDraftSync = useMindMapStore(state => state.saveDraftSync);

  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    if (wasActive && !isActive && resourceId) {
      // active → inactive：同步保存草稿
      if (storeApi.getState().mindmapId === resourceId) {
        saveDraftSync();
      }
    } else if (!wasActive && isActive && resourceId) {
      // inactive → active：从草稿恢复（仅在 store 当前 mindmapId 不匹配时）
      if (storeApi.getState().mindmapId !== resourceId) {
        void loadMindMap(resourceId).catch(err => {
          console.error('[MindMapContentView] Failed to reload from draft:', err);
        });
      }
    }
  }, [isActive, resourceId, saveDraftSync, loadMindMap, storeApi]);

  const tryLoadMindMap = useCallback(async () => {
    if (!resourceId) return;

    setIsLoadingDoc(true);
    setLoadError(null);
    try {
      await loadMindMap(resourceId);
      onReady?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('mindmap:loadError');
      setLoadError(message);
      onLoadError?.(message);
      showGlobalNotification('error', message, t('mindmap:loadErrorTitle'));
      console.error('[MindMapContentView] Failed to load mindmap:', err);
    } finally {
      setIsLoadingDoc(false);
    }
  }, [resourceId, loadMindMap, onReady, onLoadError, t]);

  // 加载文档
  useEffect(() => {
    void tryLoadMindMap();
  }, [tryLoadMindMap]);

  // ★ 监听 DSTU watch 事件：chat_v2 工具（mindmap_update/edit_nodes 等）或其他入口
  // 修改导图后，已打开的编辑器自动刷新（参照 NoteContentView 的 R3 实现）。
  // 无未保存修改时静默重载；有未保存修改时不强刷（交给保存时的 OCC 冲突流程），仅提示。
  useEffect(() => {
    if (!resourceId) return;
    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'updated' || !event.node) return;
      if (event.node.id !== resourceId) return;

      const state = storeApi.getState();
      if (state.mindmapId !== resourceId) return;
      // 自身保存进行中触发的事件由 save() 完成基线同步，跳过
      if (state.isSaving) return;

      const known = Date.parse(state.metadata?.updatedAt || '') || 0;
      const incoming = event.node.updatedAt ?? 0;
      // 等于/早于已知基线的事件来自自身保存回声或重复派发，忽略
      if (incoming <= known) return;

      if (state.isDirty) {
        showGlobalNotification('info', t('mindmap:store.externalUpdatedDirty'));
        return;
      }

      // 静默重载，保留用户当前视图与焦点位置
      const prevView = state.currentView;
      const prevFocusedNodeId = state.focusedNodeId;
      void state
        .loadMindMap(resourceId)
        .then(() => {
          if (storeApi.getState().mindmapId !== resourceId) return;
          storeApi.setState({
            currentView: prevView,
            focusedNodeId: prevFocusedNodeId,
          });
        })
        .catch((err) => {
          console.error('[MindMapContentView] watch-triggered reload failed:', err);
        });
    });
    return unwatch;
  }, [resourceId, t, storeApi]);

  // 同步标题变更到外部
  // ★ 标签页：仅活跃标签页同步标题，防止其他 MindMap 标签页加载时覆盖当前标题
  useEffect(() => {
    if (!onTitleChange || isActive === false) return;
    const title = mindmapDocument?.root?.text ?? '';
    if (lastTitleRef.current !== title) {
      lastTitleRef.current = title;
      onTitleChange(title);
    }
  }, [mindmapDocument?.root?.text, onTitleChange, isActive]);

  const handleExport = useCallback(async (format: string) => {
    if (!mindmapDocument) return;
    
    const filename = mindmapDocument.root.text || 'mindmap';
    
    // 图片导出需要特殊处理：必须在思维导图视图才能导出。
    // 大纲态触发时自动切到导图并等待 ReactFlow 完成渲染，而不是让用户手动切换后重试。
    if (format === 'png' || format === 'svg') {
      if (currentView !== 'mindmap') {
        switchView('mindmap');
        const rendered = await new Promise<boolean>((resolve) => {
          const start = Date.now();
          const poll = () => {
            const hasNodes = containerRef.current?.querySelector('.react-flow__node');
            if (hasNodes) {
              // 再等一帧让节点尺寸测量与布局稳定
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
              return;
            }
            if (Date.now() - start > 3000) {
              resolve(false);
              return;
            }
            requestAnimationFrame(poll);
          };
          poll();
        });
        if (!rendered) {
          showGlobalNotification('warning', t('mindmap:export.switchToMindMapView'));
          return;
        }
      }
      try {
        // ★ 修复：使用当前主题的背景色；传入容器 ref 避免多实例导出错误
        const themeBackground = currentTheme?.canvas?.background;
        const backgroundColor = themeBackground?.startsWith('var(')
          ? getComputedStyle(containerRef.current ?? document.documentElement)
              .getPropertyValue('--mm-bg')
              .trim() || getComputedStyle(document.documentElement).backgroundColor
          : themeBackground || getComputedStyle(document.documentElement).backgroundColor;
        const result = await exportToImage({
          format: format as 'png' | 'svg',
          filename,
          backgroundColor,
          container: containerRef.current,
          store: storeApi,
        });
        if (result.saved) {
          showGlobalNotification('success', t('mindmap:export.success'));
        }
      } catch (error: unknown) {
        console.error('Image export failed:', error);
        showGlobalNotification(
          'error',
          t('mindmap:export.failed')
        );
      }
      return;
    }
    
    let content = '';
    let ext = '.txt';
    let filterName = t('mindmap:export.filterText');
    let filterExt = 'txt';
    let dialogTitle = t('mindmap:export.exportFile');
    
    switch (format) {
      case 'opml':
        content = exportToOpml(mindmapDocument);
        ext = '.opml';
        filterName = t('mindmap:export.filterOpml');
        filterExt = 'opml';
        dialogTitle = t('mindmap:export.dialogExportOpml');
        break;
      case 'markdown':
        content = exportToMarkdown(mindmapDocument);
        ext = '.md';
        filterName = t('mindmap:export.filterMarkdown');
        filterExt = 'md';
        dialogTitle = t('mindmap:export.dialogExportMarkdown');
        break;
      case 'json':
        content = exportToJson(mindmapDocument);
        ext = '.json';
        filterName = t('mindmap:export.filterJson');
        filterExt = 'json';
        dialogTitle = t('mindmap:export.dialogExportJson');
        break;
      default:
        return;
    }
    
    try {
      // 使用 Tauri 文件对话框让用户选择保存位置
      const result = await fileManager.saveTextFile({
        title: dialogTitle,
        defaultFileName: filename + ext,
        content,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      
      if (result.canceled) {
        return; // 用户取消导出
      }
    } catch (error: unknown) {
      console.error('Export failed:', error);
        showGlobalNotification(
          'error',
          t('mindmap:export.failed')
        );
    }
  }, [mindmapDocument, currentView, switchView, t, currentTheme, storeApi]);

  // 实际执行导入（已确认或无未保存修改时调用）
  const doImport = useCallback(async () => {
    try {
      const filePath = await fileManager.pickSingleFile({
        title: t('mindmap:import.dialogTitle'),
        filters: [
          { name: t('mindmap:import.filterName'), extensions: ['opml', 'md', 'markdown', 'json'] },
        ],
      });

      if (!filePath) return;

      const content = await fileManager.readTextFile(filePath);
      const imported = importMindMap(content, 'auto');
      setDocument(imported);
      setFocusedNodeId(imported.root.id);
      showGlobalNotification('success', t('mindmap:import.success'));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : t('mindmap:import.failed');
      showGlobalNotification('error', message, t('mindmap:import.failedTitle'));
    }
  }, [setDocument, setFocusedNodeId, t]);

  // M-073 / A6-16: 导入前检查未保存修改；有修改则弹声明式确认框，否则直接导入
  const handleImport = useCallback(() => {
    if (storeApi.getState().isDirty) {
      setShowImportConfirm(true);
      return;
    }
    void doImport();
  }, [doImport, storeApi]);

  const handleConfirmImport = useCallback(() => {
    setShowImportConfirm(false);
    void doImport();
  }, [doImport]);

  const handleSave = useCallback(() => {
    save();
  }, [save]);

  // 键盘快捷键
  // ★ 标签页：仅活跃标签页响应快捷键，防止多个 MindMap 标签页同时处理同一按键
  // ★ capture：Esc 关搜索须在 document 冒泡的 useMindMapKeyboard 之前执行，否则会被 stopPropagation 吞掉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isActive === false) return;

      const isMod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const isTextInputContext =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // 搜索打开时 Esc 优先关闭搜索，不进入画布「退出编辑 → 退出背诵 → 清选中」级联
      if (e.key === 'Escape' && showSearch) {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(false);
        clearSearch();
        setSearchInput('');
        return;
      }

      // 画布视图下 undo/redo/save 由 useMindMapKeyboard hook 处理，避免重复触发
      if (currentView !== 'mindmap' && !isTextInputContext) {
        if (isMod && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (canUndo()) undo();
        }
        if (isMod && (e.key === 'Z' || e.key === 'y')) {
          e.preventDefault();
          if (canRedo()) redo();
        }
        if (isMod && e.key === 's') {
          e.preventDefault();
          if (isDirty && !isSaving) save();
        }
      }

      if (isMod && e.key === 'f' && !isTextInputContext) {
        e.preventDefault();
        setShowSearch(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [undo, redo, canUndo, canRedo, save, isDirty, isSaving, showSearch, clearSearch, currentView, isActive]);

  // M-069: 组件卸载时同步保存草稿到 localStorage，防止异步 save 未完成导致数据丢失
  // loadMindMap 时会自动检查并恢复本地草稿
  useEffect(() => {
    return () => {
      storeApi.getState().saveDraftSync();
    };
  }, [storeApi]);

  useEffect(() => {
    const flushPendingChanges = () => {
      const state = storeApi.getState();
      // M-069: 先同步写入 localStorage 草稿，确保即使异步 save 未完成也不丢失
      state.saveDraftSync();
      if (state.isDirty && !state.isSaving) {
        void state.save();
      }
    };

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const state = storeApi.getState();
      if (state.isDirty) {
        flushPendingChanges();
        event.preventDefault();
        event.returnValue = '';
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingChanges();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', flushPendingChanges);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', flushPendingChanges);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [storeApi]);

  // 错误边界重置处理
  const handleErrorReset = useCallback(() => {
    void tryLoadMindMap();
  }, [tryLoadMindMap]);

  const activeContextValue = useMemo(
    () => ({ isActive: isActive !== false, resourceId: resourceId || null }),
    [isActive, resourceId]
  );

  return (
    <MindMapErrorBoundary onReset={handleErrorReset} fallbackMessage={t('mindmap:errorBoundary')}>
    {/* isActive 下发到画布内的全局键盘/剪贴板监听器，非活跃保活实例忽略按键 */}
    <MindMapActiveContext.Provider value={activeContextValue}>
    <MindMapClipboardEffects />
    <div ref={containerRef} tabIndex={-1} className={cn("flex flex-col h-full w-full bg-[var(--mm-bg)] mindmap-container", className)}>
      {/* Compact workbench toolbar: primary commands stay visible, secondary commands live in More. */}
      <div className="mm-toolbar">
        {/* Left: View Switcher & Undo/Redo */}
        <div className="flex items-center gap-3">
          <div className="mm-view-switcher" role="group" aria-label={t('mindmap:toolbar.view')}>
            <NotionButton variant="ghost"
              className={cn(
                "mm-view-switcher-button",
                currentView === 'outline'
                  ? "is-active"
                  : ""
              )}
              onClick={() => switchView('outline')}
            >
              <FileText className="w-3.5 h-3.5 mr-1.5" />
              {t('mindmap:toolbar.outline')}
            </NotionButton>
            <NotionButton variant="ghost"
              className={cn(
                "mm-view-switcher-button",
                currentView === 'mindmap'
                  ? "is-active"
                  : ""
              )}
              onClick={() => switchView('mindmap')}
            >
              <GitBranch className="w-3.5 h-3.5 mr-1.5" />
              {t('mindmap:toolbar.mindmap')}
            </NotionButton>
          </div>
          
          <div className="w-px h-4 bg-[var(--mm-border)]" />
          
          <div className="flex items-center gap-0.5">
             <NotionButton variant="ghost" 
              className="notion-btn" 
              onClick={undo} 
              disabled={!canUndo()}
              title={t('mindmap:toolbar.undoShortcut')}
              aria-label={t('mindmap:toolbar.undo')}
            >
              <ArrowCounterClockwise size={16} />
            </NotionButton>
            <NotionButton variant="ghost" 
              className="notion-btn" 
              onClick={redo} 
              disabled={!canRedo()}
              title={t('mindmap:toolbar.redoShortcut')}
              aria-label={t('mindmap:toolbar.redo')}
            >
              <ArrowClockwise size={16} />
            </NotionButton>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Structure and style are compact icon commands; their panels remain directly accessible. */}
          <StructureSelector 
            className="hidden sm:flex"
            open={activePanel === 'structure'}
            onOpenChange={(open) => setActivePanel(open ? 'structure' : null)}
            trigger={
              <NotionButton variant="ghost" className="mm-toolbar-button" title={t('mindmap:toolbar.switchStructure')} aria-label={t('mindmap:toolbar.switchStructure')}>
                <GitBranch size={16} />
              </NotionButton>
            }
          />

          {/* Desktop: Style Settings */}
          <StyleSettings
            className="hidden sm:flex"
            open={activePanel === 'style'}
            onOpenChange={(open) => setActivePanel(open ? 'style' : null)}
            trigger={
              <NotionButton variant="ghost" className="mm-toolbar-button" title={t('mindmap:toolbar.styleSettings')} aria-label={t('mindmap:toolbar.styleSettings')}>
                <Gear size={16} />
              </NotionButton>
            }
          />

          {/* Desktop: Recite Mode Toggle */}
          <NotionButton variant="ghost"
            className={cn("mm-toolbar-button hidden sm:flex", reciteMode && "is-active")}
            onClick={() => setReciteMode(!reciteMode)}
            title={t('mindmap:recite.enter')}
            aria-label={t('mindmap:recite.enter')}
            aria-pressed={reciteMode}
          >
            <BookOpen size={16} />
          </NotionButton>

          {/* Desktop: Search Toggle */}
          <NotionButton variant="ghost" 
            className={cn("mm-toolbar-button hidden sm:flex", showSearch && "is-active")}
            onClick={() => setShowSearch(!showSearch)}
            title={t('mindmap:toolbar.searchShortcut')}
            aria-label={t('mindmap:toolbar.search')}
            aria-pressed={showSearch}
          >
            <MagnifyingGlass size={16} />
          </NotionButton>

          <div className="w-px h-4 bg-[var(--mm-border)] mx-1 hidden sm:block" />

          {/* Desktop: More Menu (simplified) */}
          <AppMenu open={activePanel === 'more'} onOpenChange={(open) => setActivePanel(open ? 'more' : null)}>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" className="mm-toolbar-button hidden sm:flex" aria-label={t('mindmap:toolbar.moreActions')} title={t('mindmap:toolbar.moreActions')}>
                <DotsThree size={16} />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={200}>
              <AppMenuItem icon={<FloppyDisk size={16} />} onClick={handleSave} disabled={!isDirty || isSaving}>
                {isSaving ? t('mindmap:toolbar.saving') : isDirty ? t('mindmap:toolbar.save') : t('mindmap:toolbar.saved')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<ArrowsOutLineVertical size={16} />} shortcut="⌘⇧]" onClick={() => expandAll()}>
                {t('mindmap:toolbar.expandAll')}
              </AppMenuItem>
              <AppMenuItem icon={<ArrowsInLineVertical size={16} />} shortcut="⌘⇧[" onClick={() => collapseAll()}>
                {t('mindmap:toolbar.collapseAll')}
              </AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(1)}>{t('mindmap:toolbar.collapseToLevel', { level: 1 })}</AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(2)}>{t('mindmap:toolbar.collapseToLevel', { level: 2 })}</AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Upload size={16} />} onClick={handleImport}>{t('mindmap:import.title')}</AppMenuItem>
              <AppMenuItem icon={<FileText size={16} />} onClick={() => handleExport('markdown')}>{t('mindmap:export.exportMarkdown')}</AppMenuItem>
              <AppMenuItem icon={<FileText size={16} />} onClick={() => handleExport('opml')}>{t('mindmap:export.exportOpml')}</AppMenuItem>
              <AppMenuItem icon={<FileText size={16} />} onClick={() => handleExport('json')}>{t('mindmap:export.dialogExportJson')}</AppMenuItem>
              <AppMenuItem icon={<Download size={16} />} onClick={() => handleExport('png')}>{t('mindmap:export.pngImage')}</AppMenuItem>
              <AppMenuItem icon={<Download size={16} />} onClick={() => handleExport('svg')}>{t('mindmap:export.svgVector')}</AppMenuItem>
              <AppMenuSeparator />
              <AppMenuCheckboxItem
                checked={hideCompleted}
                onCheckedChange={setHideCompleted}
              >
                {t('mindmap:toolbar.hideCompleted')}
              </AppMenuCheckboxItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Keyboard size={16} />} onClick={() => setShowShortcutHelp(true)}>
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>

          {/* Mobile: Unified More Menu */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" className="notion-btn mm-mobile-more w-7 justify-center px-0 sm:hidden" aria-label={t('mindmap:toolbar.moreActions')} title={t('mindmap:toolbar.moreActions')}>
                <DotsThree size={16} />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={200}>
              <AppMenuItem icon={<GitBranch size={16} />} onClick={() => setShowMobileStructure(true)}>
                {t('mindmap:toolbar.structure')}
              </AppMenuItem>
              <AppMenuItem icon={<Gear size={16} />} onClick={() => setShowMobileStyle(true)}>
                {t('mindmap:toolbar.style')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<BookOpen size={16} />} onClick={() => setReciteMode(!reciteMode)}>
                {reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
              </AppMenuItem>
              <AppMenuCheckboxItem
                checked={hideCompleted}
                onCheckedChange={setHideCompleted}
              >
                {t('mindmap:toolbar.hideCompleted')}
              </AppMenuCheckboxItem>
              <AppMenuItem icon={<MagnifyingGlass size={16} />} onClick={() => setShowSearch(!showSearch)}>
                {t('mindmap:toolbar.search')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<ArrowsOutLineVertical size={16} />} onClick={() => expandAll()}>
                {t('mindmap:toolbar.expandAll')}
              </AppMenuItem>
              <AppMenuItem icon={<ArrowsInLineVertical size={16} />} onClick={() => collapseAll()}>
                {t('mindmap:toolbar.collapseAll')}
              </AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(1)}>
                {t('mindmap:toolbar.collapseToLevel', { level: 1 })}
              </AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(2)}>
                {t('mindmap:toolbar.collapseToLevel', { level: 2 })}
              </AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(3)}>
                {t('mindmap:toolbar.collapseToLevel', { level: 3 })}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Upload size={16} />} onClick={handleImport}>
                {t('mindmap:import.title')}
              </AppMenuItem>
              <AppMenuItem icon={<FileText size={16} />} onClick={() => handleExport('markdown')}>
                {t('mindmap:export.exportMarkdown')}
              </AppMenuItem>
              <AppMenuItem icon={<FileText size={16} />} onClick={() => handleExport('opml')}>
                {t('mindmap:export.exportOpml')}
              </AppMenuItem>
              <AppMenuItem icon={<Download size={16} />} onClick={() => handleExport('png')}>
                {t('mindmap:export.exportPng')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Keyboard size={16} />} onClick={() => setShowShortcutHelp(true)}>
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
              <AppMenuItem icon={<FloppyDisk size={16} />} onClick={handleSave} disabled={!isDirty || isSaving}>
                {isSaving ? t('mindmap:toolbar.saving') : isDirty ? t('mindmap:toolbar.save') : t('mindmap:toolbar.saved')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        </div>
      </div>

      {/* A6-24: 保存冲突后，本地未保存编辑已暂存，提供"恢复我的修改"入口 */}
      {conflictSnapshot && conflictSnapshot.mindmapId === resourceId && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)] ui-drop-in">
          <WarningCircle size={16} className="shrink-0" />
          <span className="text-sm flex-1 min-w-0">{t('mindmap:store.conflictBannerTitle')}</span>
          <NotionButton
            variant="ghost"
            className="notion-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
            onClick={() => restoreConflictSnapshot()}
          >
            <ArrowCounterClockwise size={14} />
            <span className="text-xs">{t('mindmap:store.conflictRestoreMine')}</span>
          </NotionButton>
          <NotionButton
            variant="ghost"
            className="notion-btn shrink-0 text-[var(--mm-text-muted)]"
            onClick={() => dismissConflictSnapshot()}
          >
            <span className="text-xs">{t('mindmap:store.conflictDismiss')}</span>
          </NotionButton>
        </div>
      )}

      {showSearch && (
        <div className="mm-search-popover ui-drop-in" role="search">
          <MagnifyingGlass size={16} className="text-[var(--mm-text-muted)]" />
          <Input
            type="search"
            className="mm-search-input"
            placeholder={t('mindmap:toolbar.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              searchFn(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setShowSearch(false);
                clearSearch();
                setSearchInput('');
                return;
              }
              if (e.key === 'Enter') {
                if (e.shiftKey) {
                  prevSearchResult();
                } else {
                  nextSearchResult();
                }
              }
            }}
            autoFocus
          />
          
          {searchInput.trim() && (
            <div
              className="mm-search-mode"
              role="group"
              aria-label={t('mindmap:toolbar.searchMode')}
            >
              <NotionButton
                variant="ghost"
                className={cn(
                  "mm-search-mode-button",
                  searchFilterMode
                    ? "bg-[var(--mm-bg-active)] text-[var(--mm-text)]"
                    : "text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]"
                )}
                onClick={() => setSearchFilterMode(true)}
                title={t('mindmap:toolbar.searchFilterHint')}
                aria-pressed={searchFilterMode}
              >
                {t('mindmap:toolbar.searchFilter')}
              </NotionButton>
              <div className="mm-search-divider" />
              <NotionButton
                variant="ghost"
                className={cn(
                  "mm-search-mode-button",
                  !searchFilterMode
                    ? "bg-[var(--mm-bg-active)] text-[var(--mm-text)]"
                    : "text-[var(--mm-text-secondary)] hover:bg-[var(--mm-bg-hover)]"
                )}
                onClick={() => setSearchFilterMode(false)}
                title={t('mindmap:toolbar.searchLocateHint')}
                aria-pressed={!searchFilterMode}
              >
                {t('mindmap:toolbar.searchLocate')}
              </NotionButton>
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="mm-search-results">
              <span className="tabular-nums">{currentSearchIndex + 1}/{searchResults.length}</span>
              <div className="mm-search-navigation">
                <NotionButton variant="ghost" 
                  className="mm-search-nav-button"
                  onClick={prevSearchResult}
                  aria-label={t('mindmap:toolbar.prevResult')}
                >
                  <CaretUp size={12} />
                </NotionButton>
                <NotionButton variant="ghost" 
                  className="mm-search-nav-button"
                  onClick={nextSearchResult}
                  aria-label={t('mindmap:toolbar.nextResult')}
                >
                  <CaretDown size={12} />
                </NotionButton>
              </div>
            </div>
          )}
          
          <NotionButton variant="ghost" 
            className="mm-search-close"
            aria-label={t('mindmap:toolbar.closeSearch')}
            onClick={() => {
              setShowSearch(false);
              clearSearch();
              setSearchInput('');
            }}
          >
            <X className="w-4 h-4" />
          </NotionButton>
        </div>
      )}

      <div className="flex-1 overflow-hidden relative bg-[var(--mm-bg)]">
        {/* 背诵模式状态条（两个视图共享） */}
        <ReciteStatusBar />
        {isLoadingDoc ? (
          <div className="h-full w-full flex items-center justify-center text-sm text-[var(--mm-text-muted)]">
            {t('mindmap:loading')}
          </div>
        ) : loadError ? (
          <div className="h-full w-full flex items-center justify-center p-6" role="alert">
            <div className="max-w-md w-full rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-5 text-center shadow-sm">
              <WarningCircle size={32} className="mx-auto mb-3 text-red-500" />
              <p className="text-sm font-medium text-[var(--mm-text)] mb-2">{t('mindmap:loadFailed')}</p>
              <p className="text-xs text-[var(--mm-text-muted)] break-words">{loadError}</p>
              <NotionButton variant="ghost"
                className="notion-btn mt-4 mx-auto"
                onClick={() => void tryLoadMindMap()}
              >
                <ArrowClockwise size={16} />
                <span className="text-xs">{t('mindmap:retryLoad')}</span>
              </NotionButton>
            </div>
          </div>
        ) : currentView === 'outline' ? (
          <OutlineView
            ref={outlineViewRef}
            initialScrollTop={outlineScrollRestore}
          />
        ) : (
          <MindMapView
            ref={mindMapViewRef}
            initialViewport={mindMapViewportRestore}
          />
        )}

        {showShortcutHelp && (() => {
          const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
            <kbd className="px-1.5 py-0.5 rounded border border-[var(--mm-border)] text-xs whitespace-nowrap">{children}</kbd>
          );
          const Row: React.FC<{ keys: string[]; label: string }> = ({ keys, label }) => (
            <div className="flex items-center justify-between gap-3 py-1">
              <span>{label}</span>
              <span className="flex items-center gap-1 flex-shrink-0">
                {keys.map((k, i) => <Kbd key={i}>{k}</Kbd>)}
              </span>
            </div>
          );
          const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
            <div>
              <div className="text-xs font-medium text-[var(--mm-text-muted)] uppercase tracking-wide mb-1">{title}</div>
              {children}
            </div>
          );
          return (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/35" onClick={() => setShowShortcutHelp(false)} />
            <div className="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-md border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] shadow-[var(--mm-popover-shadow)]">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--mm-border)]">
                <h3 className="text-sm font-medium">{t('mindmap:shortcuts.title')}</h3>
                <NotionButton variant="ghost"
                  className="p-1 hover:bg-[var(--mm-bg-hover)] rounded"
                  onClick={() => setShowShortcutHelp(false)}
                  aria-label={t('mindmap:toolbar.closeShortcuts')}
                >
                  <X className="w-4 h-4" />
                </NotionButton>
              </div>
              <div className="p-4 text-sm text-[var(--mm-text-secondary)] space-y-4 overflow-y-auto">
                <Group title={t('mindmap:shortcuts.groupGeneral')}>
                  <Row keys={['⌘/Ctrl + Z']} label={t('mindmap:shortcuts.undo')} />
                  <Row keys={['⌘/Ctrl + ⇧ + Z', '⌘/Ctrl + Y']} label={t('mindmap:shortcuts.redo')} />
                  <Row keys={['⌘/Ctrl + S']} label={t('mindmap:shortcuts.save')} />
                  <Row keys={['⌘/Ctrl + F']} label={t('mindmap:shortcuts.search')} />
                  <Row keys={['Esc']} label={t('mindmap:shortcuts.escape')} />
                </Group>
                <Group title={t('mindmap:shortcuts.groupCanvas')}>
                  <Row keys={['Tab', '⌘/Ctrl + Enter']} label={t('mindmap:shortcuts.addChild')} />
                  <Row keys={['Enter']} label={t('mindmap:shortcuts.addSiblingOrEdit')} />
                  <Row keys={['Enter (edit)']} label={t('mindmap:shortcuts.continuousCreate')} />
                  <Row keys={['F2', 'Space']} label={t('mindmap:shortcuts.editNode')} />
                  <Row keys={['⇧ + Enter']} label={t('mindmap:shortcuts.editNote')} />
                  <Row keys={['↑ ↓ ← →']} label={t('mindmap:shortcuts.navigate')} />
                  <Row keys={['⌘/Ctrl + ↑/↓']} label={t('mindmap:shortcuts.moveNode')} />
                  <Row keys={['⌘/Ctrl + [/]']} label={t('mindmap:shortcuts.collapseExpand')} />
                  <Row
                    keys={['⌘/Ctrl + ⇧ + [/]']}
                    label={t('mindmap:shortcuts.collapseExpandAll', { defaultValue: '全部折叠 / 全部展开' })}
                  />
                  <Row
                    keys={[
                      canvasDragMode === 'pan'
                        ? t('mindmap:shortcuts.marqueeSelectKeysPanMode', { defaultValue: '⇧ + 拖拽空白处' })
                        : t('mindmap:shortcuts.marqueeSelectKeys', { defaultValue: '拖拽空白处' }),
                    ]}
                    label={t('mindmap:shortcuts.marqueeSelect', { defaultValue: '框选多选节点' })}
                  />
                  <Row
                    keys={[
                      canvasDragMode === 'pan'
                        ? t('mindmap:shortcuts.panCanvasKeysPanMode', { defaultValue: '拖拽空白处' })
                        : t('mindmap:shortcuts.panCanvasKeys', { defaultValue: 'Space / 中键 / 右键 + 拖拽' }),
                    ]}
                    label={t('mindmap:shortcuts.panCanvas', { defaultValue: '平移画布' })}
                  />
                  <Row
                    keys={[t('mindmap:shortcuts.associationEntryKeys', { defaultValue: '右键节点' })]}
                    label={t('mindmap:shortcuts.associationAdd', { defaultValue: '添加关联线（再点目标）' })}
                  />
                  <Row keys={['⌘/Ctrl + B']} label={t('mindmap:shortcuts.bold')} />
                  <Row keys={['⌘/Ctrl + C/X/V']} label={t('mindmap:shortcuts.clipboard')} />
                  <Row keys={['Del / ⌫']} label={t('mindmap:shortcuts.deleteNode')} />
                  <Row keys={['⌘/Ctrl + 0']} label={t('mindmap:shortcuts.fitView')} />
                </Group>
                <Group title={t('mindmap:shortcuts.groupOutline')}>
                  <Row keys={['Enter']} label={t('mindmap:shortcuts.addSiblingOrEdit')} />
                  <Row keys={['Enter / ⌫']} label={t('mindmap:shortcuts.splitMerge')} />
                  <Row keys={['⌘/Ctrl + Enter']} label={t('mindmap:shortcuts.addChild')} />
                  <Row keys={['Tab / ⇧ + Tab']} label={t('mindmap:shortcuts.indentOutdent')} />
                  <Row keys={['⇧ + Click', '⌘/Ctrl + Click']} label={t('mindmap:shortcuts.multiSelect')} />
                  <Row keys={['Tab / Del (multi)']} label={t('mindmap:shortcuts.batchOps')} />
                  <Row keys={['↑ ↓']} label={t('mindmap:shortcuts.navigate')} />
                  <Row keys={['⌘/Ctrl + ↑/↓']} label={t('mindmap:shortcuts.moveNode')} />
                  <Row keys={['⌘/Ctrl + [/]']} label={t('mindmap:shortcuts.collapseExpand')} />
                  <Row
                    keys={['⌘/Ctrl + ⇧ + [/]']}
                    label={t('mindmap:shortcuts.collapseExpandAll', { defaultValue: '全部折叠 / 全部展开' })}
                  />
                  <Row keys={['⌘/Ctrl + ⇧ + Enter']} label={t('mindmap:shortcuts.editNote')} />
                  <Row keys={['⌘/Ctrl + C/X/V']} label={t('mindmap:shortcuts.clipboard')} />
                </Group>
              </div>
            </div>
          </div>
          );
        })()}
        
        {/* Mobile: Structure Panel（inline 子屏：全屏替换内容区 + 顶栏返回） */}
        {showMobileStructure && (
          <div className="absolute inset-0 z-50 sm:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="flex items-center gap-1 px-2 h-12 border-b border-[var(--mm-border)] shrink-0">
              <NotionButton variant="ghost"
                className="h-10 w-10 p-0 flex items-center justify-center hover:bg-[var(--mm-bg-hover)] rounded"
                onClick={() => setShowMobileStructure(false)}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </NotionButton>
              <span className="font-medium text-sm">{t('mindmap:selectStructure')}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 pb-[var(--mobile-safe-area-bottom,0px)]">
              <StructureSelector 
                placement="inline"
                onSelect={() => setShowMobileStructure(false)}
              />
            </div>
          </div>
        )}
        
        {/* Mobile: Style Panel（inline 子屏：全屏替换内容区 + 顶栏返回） */}
        {showMobileStyle && (
          <div className="absolute inset-0 z-50 sm:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="flex items-center gap-1 px-2 h-12 border-b border-[var(--mm-border)] shrink-0">
              <NotionButton variant="ghost"
                className="h-10 w-10 p-0 flex items-center justify-center hover:bg-[var(--mm-bg-hover)] rounded"
                onClick={() => setShowMobileStyle(false)}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </NotionButton>
              <span className="font-medium text-sm">{t('mindmap:toolbar.styleSettings')}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 pb-[var(--mobile-safe-area-bottom,0px)]">
              <StyleSettings placement="inline" />
            </div>
          </div>
        )}

        {/* Export Loading Overlay */}
        {isExporting && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20">
            <div className="bg-[var(--mm-bg-elevated)] px-5 py-4 rounded-md shadow-[var(--mm-popover-shadow)] border border-[var(--mm-border)] flex flex-col items-center gap-3 ui-zoom-fade-in min-w-[240px]">
              <div className="w-full space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-[var(--mm-text)]">{t('mindmap:export.processing')}</span>
                  <span className="text-[var(--mm-text-muted)]">{exportProgress}%</span>
                </div>
                <Progress value={exportProgress} className="h-1.5" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* A6-16: 导入未保存确认（替换 window.confirm） */}
      <NotionAlertDialog
        open={showImportConfirm}
        onOpenChange={setShowImportConfirm}
        title={t('mindmap:import.unsavedTitle')}
        description={t('mindmap:import.unsavedWarning')}
        confirmText={t('mindmap:import.unsavedConfirm')}
        cancelText={t('common:cancel')}
        confirmVariant="danger"
        onConfirm={handleConfirmImport}
      />
    </div>
    </MindMapActiveContext.Provider>
    </MindMapErrorBoundary>
  );
};

/**
 * 每个内容视图持有独立 store。resourceId 改变时同步换新实例，避免旧资源的
 * 文档、历史栈、编辑状态或保存定时器泄漏到新资源。
 */
export const MindMapContentView: React.FC<MindMapContentViewProps> = (props) => {
  const holderRef = useRef<{
    resourceId: string | undefined;
    store: MindMapStoreApi;
  } | null>(null);

  if (!holderRef.current || holderRef.current.resourceId !== props.resourceId) {
    holderRef.current = {
      resourceId: props.resourceId,
      store: createMindMapStore(),
    };
  }

  const store = holderRef.current.store;
  useEffect(() => {
    if (!props.resourceId) return;
    return registerMindMapStore(props.resourceId, store, props.storeInstanceId);
  }, [props.resourceId, props.storeInstanceId, store]);

  return (
    <MindMapStoreContext.Provider value={store}>
      <MindMapContentViewInner {...props} />
    </MindMapStoreContext.Provider>
  );
};
