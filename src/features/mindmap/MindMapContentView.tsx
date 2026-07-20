import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useMemo,
} from 'react';
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
import {
  registerMindMapViewController,
  getMindMapViewController,
} from './viewController';
import { dstu } from '@/dstu';
import { StyleRegistry } from './registry';
import {
  exportToOpml,
  exportToMarkdown,
  exportToJson,
  exportToPlainText,
  exportToImage,
  exportToXmindFile,
} from './utils/exporters';
import { createXmindImportReport, importFromXmindZip, importMindMap } from './utils/importers';
import { fileManager } from '@/utils/fileManager';
import { TauriAPI } from '@/utils/tauriApi';
import { cn } from '@/lib/utils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
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
  Gear,
  BookOpen,
  EyeSlash,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  Presentation,
  ShareNetwork,
  Check,
  ClockCounterClockwise,
  FileMd,
  FileCode,
  FilePng,
  FileSvg,
  FileZip,
  FileTxt,
  FilePdf,
  TreeStructure,
} from '@phosphor-icons/react';
import { AnimatePresence } from 'framer-motion';
import { Input } from '@/components/ui/shad/Input';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { TextSwap } from '@/components/ui/TextSwap';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
  AppMenuCheckboxItem,
  AppMenuSeparator,
  AppMenuGroup,
} from '@/components/ui/app-menu/AppMenu';
import { OutlineView, type OutlineViewHandle } from './views/OutlineView';
import { MindMapView, type MindMapViewHandle } from './views/MindMapView';
import { StructureSelector } from './components/mindmap/StructureSelector';
import { StyleSettings } from './components/toolbar/StylePanel';
// W09 契约：选中节点时的内联格式条（无必需 props，内部消费当前 store）
import { MindMapFormatBar } from './components/toolbar/FormatBar';
import { VersionHistoryPanel } from './components/toolbar/VersionHistoryPanel';
// 快捷键帮助：内联面板（W07 键表消费与归一化已移入该组件）
import { ShortcutHelpPanel } from './components/toolbar/ShortcutHelpPanel';
import { InlineCollapse } from './components/toolbar/InlineCollapse';
import { ReciteStatusBar } from './components/shared/ReciteStatusBar';
import { Progress } from '@/components/ui/shad/Progress';
import { useMindMapClipboard } from './hooks/useMindMapClipboard';
import {
  captureOutlineResumePoint,
  prepareOutlineResume,
  type OutlineResumePoint,
} from './utils/viewContinuity';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import {
  setMindMapPreferences,
  useMindMapPreferences,
} from './utils/mindmapPreferences';
import { useCoarsePointer, useMobileScreen } from './hooks/useCoarsePointer';
import { getAncestors } from './utils/node/traverse';
import './styles/mindmap.css';

/** 挂在 ActiveContext Provider 内，使大纲/画布共用剪贴板快捷键且受 isActive 门控 */
const MindMapClipboardEffects: React.FC = () => {
  useMindMapClipboard();
  return null;
};

/** 宿主可通过 ref 调用的命令（Notes 关闭标签「丢弃修改」等场景） */
export interface MindMapContentViewHandle {
  /**
   * 丢弃语义：清除本地草稿 + 取消待执行的保存定时器 + 跳过 unmount 时的
   * saveDraftSync。调用后本实例视为终结，宿主应随即卸载该组件。
   */
  discardDraft: () => void;
  /** 与工具栏同语义的视图切换（blur + viewport + caret resume） */
  switchView: (view: 'outline' | 'mindmap') => void;
}

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

interface MindMapContentViewInnerProps extends MindMapContentViewProps {
  /** Outer 下发：discardDraft 后置 true，unmount/可见性 flush 跳过草稿写入 */
  discardedRef: React.MutableRefObject<boolean>;
}

const MindMapContentViewInner: React.FC<MindMapContentViewInnerProps> = ({
  resourceId,
  onTitleChange,
  onReady,
  onLoadError,
  isActive,
  focusOnActive,
  onSaveStateChange,
  discardedRef,
  className
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const storeApi = useMindMapStoreApi();
  const mindMapPreferences = useMindMapPreferences();
  
  // 从新 store 获取状态
  const currentView = useMindMapStore(state => state.currentView);
  const setCurrentView = useMindMapStore(state => state.setCurrentView);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const setReciteMode = useMindMapStore(state => state.setReciteMode);
  const viewRootId = useMindMapStore(state => state.viewRootId);
  const setViewRootId = useMindMapStore(state => state.setViewRootId);
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
  // 选中态：驱动工具栏下方的内联格式条（W09 FormatBar）显隐
  const focusedNodeId = useMindMapStore(state => state.focusedNodeId);
  const hasSelection = useMindMapStore(state => state.selection.length > 0);
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
  // W08 SearchOptions：大小写敏感 / 全词匹配（会话级 UI 状态，不入草稿）
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  // 版本历史内联面板（工具栏下方文档流展开）
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const lastTitleRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 工具栏面板互斥状态：同一时间只允许打开一个面板
  const [activePanel, setActivePanel] = useState<'structure' | 'style' | 'more' | null>(null);

  // 移动端全屏内联子屏状态
  const [showMobileStructure, setShowMobileStructure] = useState(false);
  const [showMobileStyle, setShowMobileStyle] = useState(false);
  const [showMobileMore, setShowMobileMore] = useState(false);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);
  // A6-16: 导入未保存确认为工具栏下方的内联确认条（不再使用模态对话框）
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  // 导入解析/读取失败：工具栏下方内联错误横幅（禁弹窗），支持一键重试
  const [importError, setImportError] = useState<string | null>(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [associationModeRequest, setAssociationModeRequest] = useState(0);
  const isCoarsePointer = useCoarsePointer();
  const isMobileScreen = useMobileScreen();

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
  const outlineResumeRef = useRef<OutlineResumePoint | null>(null);

  const switchView = useCallback(
    (next: 'outline' | 'mindmap') => {
      const prev = storeApi.getState().currentView;
      if (prev === next) return;

      // 切换前显式提交正在编辑的文本：卸载 textarea 不会触发 React onBlur，
      // 依赖 blur 同步派发 commit，避免快速切换丢失未提交字符。
      const active = window.document.activeElement;
      if (prev === 'outline') {
        outlineResumeRef.current = captureOutlineResumePoint(active);
      }
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
      if (next === 'outline') {
        const resume = outlineResumeRef.current;
        const targetId = prepareOutlineResume(state.focusedNodeId, resume);
        if (targetId) {
          window.requestAnimationFrame(() => {
            storeApi.getState().setFocusedNodeId(targetId);
            outlineViewRef.current?.scrollFocusedIntoView();
          });
        }
      }
    },
    [setCurrentView, setViewViewport, storeApi],
  );

  // B-5：把带防护语义的 switchView 注册到视图控制器注册表，
  // Workbench activation（register.ts setView）与宿主 ref 均经此路径切换视图。
  useEffect(() => {
    return registerMindMapViewController(storeApi, { switchView });
  }, [storeApi, switchView]);

  const handleToggleViewCommand = useCallback(() => {
    if (isActive === false) return;
    const next = storeApi.getState().currentView === 'outline' ? 'mindmap' : 'outline';
    switchView(next);
  }, [isActive, storeApi, switchView]);
  useEventRegistry(
    [{ target: 'window', type: 'mindmap:toggle-view', listener: handleToggleViewCommand }],
    [handleToggleViewCommand],
  );

  // 移动端浮层/子屏打开时注册 Android 返回键：返回 = 关闭当前层
  useEffect(() => {
    if (isActive === false || !showMobileStructure) return;
    return registerBackHandler(() => {
      setShowMobileStructure(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, showMobileStructure]);

  useEffect(() => {
    if (isActive === false || !showMobileStyle) return;
    return registerBackHandler(() => {
      setShowMobileStyle(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, showMobileStyle]);

  useEffect(() => {
    if (isActive === false || !showShortcutHelp) return;
    return registerBackHandler(() => {
      setShowShortcutHelp(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, showShortcutHelp]);

  useEffect(() => {
    if (isActive === false || !showMobileMore) return;
    return registerBackHandler(() => {
      setShowMobileMore(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, showMobileMore]);

  // 横竖屏/窗口跨过移动断点时，立即收掉只属于移动形态的子屏。
  // 否则 CSS 隐藏后状态仍为 open，系统返回会先消费一个不可见层。
  useEffect(() => {
    if (isMobileScreen) {
      setActivePanel(null);
      return;
    }
    setShowMobileStructure(false);
    setShowMobileStyle(false);
    setShowMobileMore(false);
  }, [isMobileScreen]);

  // 内容区浮层互斥：移动端子屏（更多/结构/样式）与快捷键/版本历史面板同一时间只保留一个
  const openMobileStructure = useCallback(() => {
    setShowMobileStyle(false);
    setShowMobileMore(false);
    setShowShortcutHelp(false);
    setShowVersionHistory(false);
    setShowMobileStructure(true);
  }, []);

  const openMobileStyle = useCallback(() => {
    setShowMobileStructure(false);
    setShowMobileMore(false);
    setShowShortcutHelp(false);
    setShowVersionHistory(false);
    setShowMobileStyle(true);
  }, []);

  const openMobileMore = useCallback(() => {
    setShowMobileStructure(false);
    setShowMobileStyle(false);
    setShowShortcutHelp(false);
    setShowVersionHistory(false);
    setShowMobileMore(true);
  }, []);

  const openShortcutHelp = useCallback(() => {
    setShowMobileStructure(false);
    setShowMobileStyle(false);
    setShowVersionHistory(false);
    setShowShortcutHelp(true);
  }, []);

  // 版本历史内联面板：与移动子屏/快捷键面板互斥
  const openVersionHistory = useCallback(() => {
    setShowMobileStructure(false);
    setShowMobileStyle(false);
    setShowMobileMore(false);
    setShowShortcutHelp(false);
    setShowVersionHistory(true);
  }, []);

  useEffect(() => {
    if (isActive === false || !showVersionHistory) return;
    return registerBackHandler(() => {
      setShowVersionHistory(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, showVersionHistory]);

  // 搜索、导入反馈和演示态不是 Radix 浮层，必须显式接入 Android 返回闭环。
  useEffect(() => {
    if (
      isActive === false ||
      (!presentationMode && !showImportConfirm && !importError && !showSearch)
    ) {
      return;
    }
    return registerBackHandler(() => {
      if (presentationMode) {
        setPresentationMode(false);
      } else if (showImportConfirm) {
        setShowImportConfirm(false);
      } else if (importError) {
        setImportError(null);
      } else if (showSearch) {
        setShowSearch(false);
        clearSearch();
        setSearchInput('');
      } else {
        return false;
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [
    clearSearch,
    importError,
    isActive,
    presentationMode,
    showImportConfirm,
    showSearch,
  ]);

  // 特殊学习态与分支专注属于视图内导航：先退出背诵，再逐级返回专注路径。
  useEffect(() => {
    if (isActive === false || (!reciteMode && !viewRootId)) return;
    return registerBackHandler(() => {
      if (reciteMode) {
        setReciteMode(false);
        return true;
      }
      if (!viewRootId) return false;
      const parent = getAncestors(mindmapDocument.root, viewRootId).at(-1);
      setViewRootId(parent && parent.id !== mindmapDocument.root.id ? parent.id : null);
      return true;
    }, BACK_PRIORITY.view);
  }, [
    isActive,
    mindmapDocument.root,
    reciteMode,
    setReciteMode,
    setViewRootId,
    viewRootId,
  ]);

  // 快捷键面板已内联到工具栏下方文档流（同版本历史范式），
  // 由 Esc / 关闭按钮 / 面板互斥收起，不再做点击外部关闭。

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

      // 静默重载，保留用户当前视图与焦点位置；
      // B-4：preserveViewports 保留大纲滚动与画布视口（W01 契约）
      const prevView = state.currentView;
      const prevFocusedNodeId = state.focusedNodeId;
      void state
        .loadMindMap(resourceId, { preserveViewports: true })
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
    
    // 图片/PDF 导出需要特殊处理：必须在思维导图视图才能导出。
    // 大纲态触发时自动切到导图并等待 ReactFlow 完成渲染，而不是让用户手动切换后重试。
    // PDF 复用 PNG 光栅 → 系统打印管线（macOS WKWebView 可能不支持，见降级提示）。
    if (format === 'png' || format === 'svg' || format === 'pdf') {
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
        if (format === 'pdf') {
          // 降级提示：WKWebView 的 window.print() 可能静默失败，提前告知用户替代方案
          showGlobalNotification('info', t('mindmap:export.pdfPrintDegradeHint'));
        }
        const result = await exportToImage({
          format: format as 'png' | 'svg' | 'pdf',
          filename,
          backgroundColor,
          container: containerRef.current,
          store: storeApi,
        });
        if (result.saved && format !== 'pdf') {
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

    // .xmind：二进制 zip 包，走独立导出管线（保存对话框在工具函数内）
    if (format === 'xmind') {
      try {
        const result = await exportToXmindFile(mindmapDocument, filename);
        if (result.saved) {
          showGlobalNotification('success', t('mindmap:shellV2.export.xmindDone'));
        }
      } catch (error: unknown) {
        console.error('.xmind export failed:', error);
        showGlobalNotification('error', t('mindmap:export.failed'));
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
      case 'text':
        content = exportToPlainText(mindmapDocument);
        ext = '.txt';
        filterName = t('mindmap:export.filterText');
        filterExt = 'txt';
        dialogTitle = t('mindmap:export.dialogExportText');
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
      // 导出成功轻量反馈（与图片导出一致）
      showGlobalNotification('success', t('mindmap:export.success'));
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
    setImportError(null);
    try {
      const filePath = await fileManager.pickSingleFile({
        title: t('mindmap:import.dialogTitle'),
        filters: [
          { name: t('mindmap:import.filterName'), extensions: ['xmind', 'opml', 'md', 'markdown', 'json', 'mm', 'txt'] },
        ],
      });

      if (!filePath) return;

      // P3 导入报告：收集 .xmind 导入时被静默丢弃的图片/概要计数
      const report = createXmindImportReport();
      const imported = filePath.toLowerCase().endsWith('.xmind')
        ? await importFromXmindZip(await TauriAPI.readFileAsBytes(filePath), report)
        : importMindMap(await fileManager.readTextFile(filePath), 'auto');
      setDocument(imported);
      setFocusedNodeId(imported.root.id);
      type CountableNode = { children?: CountableNode[] };
      const countNodes = (node: CountableNode): number =>
        1 + (node.children ?? []).reduce((sum, child) => sum + countNodes(child), 0);
      const nodeCount = countNodes(imported.root);
      const hasDropped = report.droppedImages > 0 || report.droppedSummaries > 0;
      showGlobalNotification(
        'success',
        hasDropped
          ? t('mindmap:import.successSummaryIgnored', {
            nodes: nodeCount,
            images: report.droppedImages,
            summaries: report.droppedSummaries,
          })
          : t('mindmap:import.successSummary', { nodes: nodeCount }),
      );
    } catch (error: unknown) {
      // A6-16 延伸：解析/读取失败改为工具栏下方内联错误横幅（不弹窗），支持重试
      const message = error instanceof Error ? error.message : t('mindmap:import.failed');
      console.error('[MindMapContentView] Import failed:', error);
      setImportError(message);
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

  // 内联确认条：先保存当前修改再导入（导入会整体替换文档）
  const handleSaveAndImport = useCallback(async () => {
    setShowImportConfirm(false);
    let saved = false;
    try {
      saved = await save();
    } catch {
      saved = false;
    }
    // 保存失败已由 store 层弹出通知；不继续导入，避免覆盖未保存内容
    if (!saved) return;
    void doImport();
  }, [save, doImport]);

  const handleSave = useCallback(() => {
    save();
  }, [save]);

  // W08 契约：search(query, options?) 向后兼容；大小写/全词开关变化时重跑当前查询
  const runSearch = useCallback(
    (query: string, caseSensitive: boolean, wholeWord: boolean) => {
      searchFn(query, { caseSensitive, wholeWord });
    },
    [searchFn],
  );

  const toggleSearchCaseSensitive = useCallback(() => {
    setSearchCaseSensitive((prev) => {
      const next = !prev;
      runSearch(searchInput, next, searchWholeWord);
      return next;
    });
  }, [runSearch, searchInput, searchWholeWord]);

  const toggleSearchWholeWord = useCallback(() => {
    setSearchWholeWord((prev) => {
      const next = !prev;
      runSearch(searchInput, searchCaseSensitive, next);
      return next;
    });
  }, [runSearch, searchInput, searchCaseSensitive]);

  const handleStartAssociation = useCallback(() => {
    const state = storeApi.getState();
    if (!state.focusedNodeId && state.selection.length === 0) {
      showGlobalNotification('warning', t('mindmap:association.selectSource'));
      return;
    }
    switchView('mindmap');
    setAssociationModeRequest((request) => request + 1);
  }, [storeApi, switchView, t]);

  const handleEnterPresentation = useCallback(() => {
    switchView('mindmap');
    setShowSearch(false);
    setActivePanel(null);
    // 演示模式全屏画布：收起所有内容区浮层，避免残留面板挡住演示
    setShowShortcutHelp(false);
    setShowMobileStructure(false);
    setShowMobileStyle(false);
    setShowMobileMore(false);
    setShowVersionHistory(false);
    setPresentationMode(true);
  }, [switchView]);

  // 键盘快捷键
  // ★ 标签页：仅活跃标签页响应快捷键，防止多个 MindMap 标签页同时处理同一按键
  // ★ capture：Esc 关搜索须在 document 冒泡的 useMindMapKeyboard 之前执行，否则会被 stopPropagation 吞掉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isActive === false) return;

      if (e.key === 'Escape' && presentationMode) {
        e.preventDefault();
        e.stopPropagation();
        setPresentationMode(false);
        return;
      }

      const isMod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const isTextInputContext =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // 内联浮层 Esc 关闭次序：演示模式 > 导入确认/错误条 > 版本历史 > 快捷键面板 > 搜索 > 画布级联
      if (e.key === 'Escape' && showImportConfirm) {
        e.preventDefault();
        e.stopPropagation();
        setShowImportConfirm(false);
        return;
      }

      if (e.key === 'Escape' && importError) {
        e.preventDefault();
        e.stopPropagation();
        setImportError(null);
        return;
      }

      if (e.key === 'Escape' && showVersionHistory) {
        e.preventDefault();
        e.stopPropagation();
        setShowVersionHistory(false);
        return;
      }

      if (e.key === 'Escape' && showShortcutHelp) {
        e.preventDefault();
        e.stopPropagation();
        setShowShortcutHelp(false);
        return;
      }

      // 搜索打开时 Esc 优先关闭搜索，不进入画布「退出编辑 → 退出背诵 → 清选中」级联
      if (e.key === 'Escape' && showSearch) {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(false);
        clearSearch();
        setSearchInput('');
        return;
      }

      // Save belongs to the shared document layer, including while an outline
      // textarea owns focus. Always suppress the browser Save Page shortcut.
      if (currentView !== 'mindmap' && isMod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isDirty && !isSaving) save();
        return;
      }

      // 画布视图下 undo/redo 由 useMindMapKeyboard hook 处理，避免重复触发
      if (currentView !== 'mindmap' && !isTextInputContext) {
        if (isMod && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          if (canUndo()) undo();
        }
        if (isMod && (e.key === 'Z' || e.key === 'y')) {
          e.preventDefault();
          if (canRedo()) redo();
        }
      }

      if (isMod && e.key === 'f' && !isTextInputContext) {
        e.preventDefault();
        if (showSearch) {
          // 已打开：重新聚焦并全选查询词，直接输入即覆盖（常见 Cmd+F 习惯）
          const input = containerRef.current?.querySelector<HTMLInputElement>('.mm-search-input');
          input?.focus();
          input?.select();
        } else {
          setShowSearch(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [undo, redo, canUndo, canRedo, save, isDirty, isSaving, showSearch, clearSearch, currentView, isActive, presentationMode, showImportConfirm, importError, showShortcutHelp, showVersionHistory]);

  // M-069: 组件卸载时同步保存草稿到 localStorage，防止异步 save 未完成导致数据丢失
  // loadMindMap 时会自动检查并恢复本地草稿
  // B-1：宿主已执行「丢弃修改」（discardDraft）时跳过，否则草稿会在下次打开复活
  useEffect(() => {
    return () => {
      if (discardedRef.current) return;
      storeApi.getState().saveDraftSync();
    };
  }, [storeApi, discardedRef]);

  useEffect(() => {
    const flushPendingChanges = () => {
      if (discardedRef.current) return;
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

  const activeContextValue = useMemo(
    () => ({ isActive: isActive !== false, resourceId: resourceId || null }),
    [isActive, resourceId]
  );

  return (
    <>
    {/* isActive 下发到画布内的全局键盘/剪贴板监听器，非活跃保活实例忽略按键 */}
    <MindMapActiveContext.Provider value={activeContextValue}>
    <MindMapClipboardEffects />
    <div ref={containerRef} tabIndex={-1} className={cn("flex flex-col h-full w-full bg-[var(--mm-bg)] mindmap-container", presentationMode && "is-presentation", className)}>
      {/* Compact workbench toolbar: primary commands stay visible, secondary commands live in More. */}
      <div className="mm-toolbar">
        {/* Left: View Switcher & Undo/Redo */}
        <div className="flex items-center gap-3">
          {/* 视图切换：统一到项目级 SegmentedControl（键盘左右键漫游 + thumb 动效） */}
          <SegmentedControl<'outline' | 'mindmap'>
            ariaLabel={t('mindmap:toolbar.view')}
            size="compact"
            value={currentView === 'outline' ? 'outline' : 'mindmap'}
            onValueChange={(next) => switchView(next)}
            options={[
              {
                value: 'outline',
                ariaLabel: t('mindmap:toolbar.outline'),
                label: (
                  <span className="inline-flex items-center">
                    <FileText className="mm-view-switcher-icon w-3.5 h-3.5 mr-1.5" />
                    <span className="mm-view-switcher-label">{t('mindmap:toolbar.outline')}</span>
                  </span>
                ),
              },
              {
                value: 'mindmap',
                ariaLabel: t('mindmap:toolbar.mindmap'),
                label: (
                  <span className="inline-flex items-center">
                    <GitBranch className="mm-view-switcher-icon w-3.5 h-3.5 mr-1.5" />
                    <span className="mm-view-switcher-label">{t('mindmap:toolbar.mindmap')}</span>
                  </span>
                ),
              },
            ]}
          />
          
          <div className="w-px h-4 bg-[var(--mm-border)] hidden md:block" />
          
          <div className="flex items-center gap-0.5">
            {/* disabled 按钮不冒泡鼠标事件，tooltip 挂在外层 span 上保证禁用态也有提示 */}
            <CommonTooltip
              content={canUndo() ? t('mindmap:toolbar.undo') : t('mindmap:toolbar.undoDisabled')}
              shortcut={canUndo() ? '⌘Z' : undefined}
              position="bottom"
            >
              <span className="inline-flex">
                <DsButton variant="ghost"
                  className="ds-btn"
                  onClick={undo}
                  disabled={!canUndo()}
                  aria-label={t('mindmap:toolbar.undo')}
                >
                  <ArrowCounterClockwise size={16} />
                </DsButton>
              </span>
            </CommonTooltip>
            <CommonTooltip
              content={canRedo() ? t('mindmap:toolbar.redo') : t('mindmap:toolbar.redoDisabled')}
              shortcut={canRedo() ? '⌘⇧Z' : undefined}
              position="bottom"
            >
              <span className="inline-flex">
                <DsButton variant="ghost"
                  className="ds-btn"
                  onClick={redo}
                  disabled={!canRedo()}
                  aria-label={t('mindmap:toolbar.redo')}
                >
                  <ArrowClockwise size={16} />
                </DsButton>
              </span>
            </CommonTooltip>
          </div>

          <div className="w-px h-4 bg-[var(--mm-border)] hidden md:block" />

          {/* 保存状态内联可视化：状态点常显，未保存时可点击立即保存（替代藏在菜单里的保存项） */}
          <CommonTooltip
            content={t('mindmap:toolbar.save')}
            shortcut="⌘S"
            position="bottom"
            disabled={!isDirty || isSaving}
          >
            <DsButton variant="ghost"
              className="ds-btn hidden md:flex"
              onClick={handleSave}
              disabled={!isDirty || isSaving}
            >
              <span
                aria-hidden
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  isSaving
                    ? 'bg-[var(--mm-primary)] motion-safe:animate-pulse'
                    : isDirty
                      ? 'bg-[var(--mm-warning)]'
                      : 'bg-[var(--mm-text-muted)] opacity-60'
                )}
              />
              <span aria-live="polite">
                <TextSwap
                  className="text-xs text-[var(--mm-text-muted)]"
                  text={
                    isSaving
                      ? t('mindmap:toolbar.saving')
                      : isDirty
                        ? t('mindmap:toolbar.unsaved')
                        : t('mindmap:toolbar.saved')
                  }
                />
              </span>
            </DsButton>
          </CommonTooltip>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1">
          {/* Structure and style are compact icon commands; their panels remain directly accessible. */}
          <StructureSelector 
            className="hidden md:flex"
            open={activePanel === 'structure'}
            onOpenChange={(open) => setActivePanel(open ? 'structure' : null)}
            trigger={
              <CommonTooltip content={t('mindmap:toolbar.switchStructure')} position="bottom">
                <DsButton variant="ghost" className="mm-toolbar-button" aria-label={t('mindmap:toolbar.switchStructure')}>
                  <GitBranch size={16} />
                </DsButton>
              </CommonTooltip>
            }
          />

          {/* Desktop: Style Settings */}
          <StyleSettings
            className="hidden md:flex"
            open={activePanel === 'style'}
            onOpenChange={(open) => setActivePanel(open ? 'style' : null)}
            trigger={
              <CommonTooltip content={t('mindmap:toolbar.styleSettings')} position="bottom">
                <DsButton variant="ghost" className="mm-toolbar-button" aria-label={t('mindmap:toolbar.styleSettings')}>
                  <Gear size={16} />
                </DsButton>
              </CommonTooltip>
            }
          />

          {/* Learning controls stay visible: they are a first-class mind-map workflow. */}
          <div className="mm-learning-group hidden md:flex" role="group" aria-label={t('mindmap:toolbar.learning')}>
            <span className="mm-learning-label">{t('mindmap:toolbar.learning')}</span>
            <DsButton variant="ghost"
              className={cn("mm-learning-button", reciteMode && "is-active")}
              onClick={() => setReciteMode(!reciteMode)}
              title={reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.enter')}
              aria-pressed={reciteMode}
            >
              <BookOpen size={15} />
              {reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
            </DsButton>
            <DsButton variant="ghost"
              className={cn("mm-learning-button", hideCompleted && "is-active")}
              onClick={() => setHideCompleted(!hideCompleted)}
              title={t('mindmap:toolbar.hideCompleted')}
              aria-pressed={hideCompleted}
            >
              <EyeSlash size={15} />
              {t('mindmap:toolbar.hideCompleted')}
            </DsButton>
          </div>

          {/* Desktop: Search Toggle */}
          <CommonTooltip content={t('mindmap:toolbar.search')} shortcut="⌘F" position="bottom">
            <DsButton variant="ghost" 
              className={cn("mm-toolbar-button hidden md:flex", showSearch && "is-active")}
              onClick={() => setShowSearch(!showSearch)}
              aria-label={t('mindmap:toolbar.search')}
              aria-pressed={showSearch}
            >
              <MagnifyingGlass size={16} />
            </DsButton>
          </CommonTooltip>

          <div className="w-px h-4 bg-[var(--mm-border)] mx-1 hidden md:block" />

          {/* Desktop: More Menu (simplified) */}
          <AppMenu open={activePanel === 'more'} onOpenChange={(open) => setActivePanel(open ? 'more' : null)}>
            <AppMenuTrigger asChild>
              <DsButton variant="ghost" className="mm-toolbar-button hidden md:flex" aria-label={t('mindmap:toolbar.moreActions')} title={t('mindmap:toolbar.moreActions')}>
                <DotsThree size={16} />
              </DsButton>
            </AppMenuTrigger>
            {/* NOTE: AppMenuTrigger asChild 需要直接子元素承接 ref/props，此处不包 CommonTooltip */}
            <AppMenuContent align="end" width={200}>
              {/* 保存入口移到工具栏内联状态点，菜单不再重复保存项 */}
              <AppMenuItem icon={<ArrowsOutLineVertical size={16} />} shortcut="⌘⇧]" onClick={() => expandAll()}>
                {t('mindmap:toolbar.expandAll')}
              </AppMenuItem>
              <AppMenuItem icon={<ArrowsInLineVertical size={16} />} shortcut="⌘⇧[" onClick={() => collapseAll()}>
                {t('mindmap:toolbar.collapseAll')}
              </AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(1)}>{t('mindmap:toolbar.collapseToLevel', { level: 1 })}</AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(2)}>{t('mindmap:toolbar.collapseToLevel', { level: 2 })}</AppMenuItem>
              <AppMenuItem onClick={() => collapseToDepth(3)}>{t('mindmap:toolbar.collapseToLevel', { level: 3 })}</AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Presentation size={16} />} onClick={handleEnterPresentation}>
                {t('mindmap:presentation.enter')}
              </AppMenuItem>
              <AppMenuItem icon={<ShareNetwork size={16} />} onClick={handleStartAssociation}>
                {t('mindmap:association.add')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<ClockCounterClockwise size={16} />} onClick={openVersionHistory}>
                {t('mindmap:versions.title')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Upload size={16} />} onClick={handleImport}>{t('mindmap:import.title')}</AppMenuItem>
              {/* 导出分组：每种格式配专属图标，一眼可辨（Markdown/OPML/JSON/.xmind/PNG/SVG） */}
              <AppMenuGroup label={t('mindmap:shellV2.export.group')}>
                <AppMenuItem icon={<FileMd size={16} />} onClick={() => handleExport('markdown')}>{t('mindmap:export.exportMarkdown')}</AppMenuItem>
                <AppMenuItem icon={<TreeStructure size={16} />} onClick={() => handleExport('opml')}>{t('mindmap:export.exportOpml')}</AppMenuItem>
                <AppMenuItem icon={<FileCode size={16} />} onClick={() => handleExport('json')}>{t('mindmap:export.dialogExportJson')}</AppMenuItem>
                <AppMenuItem icon={<FileZip size={16} />} onClick={() => handleExport('xmind')}>{t('mindmap:export.exportXmind')}</AppMenuItem>
                <AppMenuItem icon={<FileTxt size={16} />} onClick={() => handleExport('text')}>{t('mindmap:export.exportText')}</AppMenuItem>
                <AppMenuItem icon={<FilePng size={16} />} onClick={() => handleExport('png')}>{t('mindmap:export.pngImage')}</AppMenuItem>
                <AppMenuItem icon={<FileSvg size={16} />} onClick={() => handleExport('svg')}>{t('mindmap:export.svgVector')}</AppMenuItem>
                <AppMenuItem icon={<FilePdf size={16} />} onClick={() => handleExport('pdf')}>{t('mindmap:export.exportPdf')}</AppMenuItem>
              </AppMenuGroup>
              <AppMenuSeparator />
              <AppMenuCheckboxItem
                checked={hideCompleted}
                onCheckedChange={setHideCompleted}
              >
                {t('mindmap:toolbar.hideCompleted')}
              </AppMenuCheckboxItem>
              <AppMenuCheckboxItem
                checked={mindMapPreferences.keymap === 'classic'}
                onCheckedChange={(checked) => setMindMapPreferences({ keymap: checked ? 'classic' : 'deep-student' })}
              >
                {t('mindmap:preferences.classicKeymap')}
              </AppMenuCheckboxItem>
              <AppMenuCheckboxItem
                checked={mindMapPreferences.canvasNavigation === 'spatial'}
                onCheckedChange={(checked) => setMindMapPreferences({ canvasNavigation: checked ? 'spatial' : 'document' })}
              >
                {t('mindmap:preferences.spatialNavigation')}
              </AppMenuCheckboxItem>
              <AppMenuCheckboxItem
                checked={mindMapPreferences.descriptionPreview === 'first-line'}
                onCheckedChange={(checked) => setMindMapPreferences({ descriptionPreview: checked ? 'first-line' : 'full' })}
              >
                {t('mindmap:preferences.descriptionFirstLine')}
              </AppMenuCheckboxItem>
              <AppMenuSeparator />
              <AppMenuItem icon={<Keyboard size={16} />} onClick={openShortcutHelp}>
                {t('mindmap:toolbar.shortcutList')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>

          {/* Mobile: 「更多」入口 → 全屏内联子屏（同结构/样式子屏范式，替代浮层菜单） */}
          <DsButton
            variant="ghost"
            className="ds-btn mm-mobile-more w-10 h-10 justify-center px-0 md:hidden"
            aria-label={t('mindmap:toolbar.moreActions')}
            title={t('mindmap:toolbar.moreActions')}
            onClick={openMobileMore}
          >
            <DotsThree size={16} />
          </DsButton>
        </div>
      </div>

      {/* W09 格式条：选中节点时在工具栏下方内联展开（背诵/演示模式下隐藏，避免误编辑） */}
      {!isCoarsePointer && !reciteMode && !presentationMode && (focusedNodeId || hasSelection) && (
        <div className="border-b border-[var(--mm-border)] bg-[var(--mm-bg)] ui-drop-in">
          <MindMapFormatBar />
        </div>
      )}

      {/* A6-24: 保存冲突后，本地未保存编辑已暂存——内联横幅（保留服务器版 / 恢复我的快照） */}
      <AnimatePresence initial={false}>
        {conflictSnapshot && conflictSnapshot.mindmapId === resourceId && (
          <InlineCollapse role="alert">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm flex-1 min-w-[160px]">{t('mindmap:store.conflictBannerTitle')}</span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={() => restoreConflictSnapshot()}
              >
                <ArrowCounterClockwise size={14} />
                <span className="text-xs">{t('mindmap:store.conflictRestoreMine')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={() => dismissConflictSnapshot()}
              >
                <span className="text-xs">{t('mindmap:shellV2.conflict.keepServer')}</span>
              </DsButton>
            </div>
          </InlineCollapse>
        )}
      </AnimatePresence>

      {/* 导入解析/读取失败：内联错误横幅（禁弹窗），支持一键重试 */}
      <AnimatePresence initial={false}>
        {importError && (
          <InlineCollapse role="alert">
            <div className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]">
              <WarningCircle size={16} className="shrink-0" />
              <span className="text-sm font-medium shrink-0">{t('mindmap:shellV2.import.errorTitle')}</span>
              <span className="text-xs flex-1 min-w-[160px] break-words opacity-90">{importError}</span>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
                onClick={() => void doImport()}
              >
                <ArrowClockwise size={14} />
                <span className="text-xs">{t('mindmap:shellV2.import.retry')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
                onClick={() => setImportError(null)}
              >
                <span className="text-xs">{t('mindmap:shellV2.import.dismiss')}</span>
              </DsButton>
            </div>
          </InlineCollapse>
        )}
      </AnimatePresence>

      {/* A6-16: 导入未保存确认——工具栏下方内联确认条（复用冲突横幅的视觉模式，不再弹模态框） */}
      <AnimatePresence initial={false}>
      {showImportConfirm && (
        <InlineCollapse role="alert">
        <div
          className="mm-inline-banner flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 border-b border-[var(--mm-warning)] bg-[var(--mm-warning-soft)] text-[var(--mm-warning)]"
        >
          <WarningCircle size={16} className="shrink-0" />
          <span className="text-sm flex-1 min-w-[160px]">{t('mindmap:import.unsavedWarning')}</span>
          <DsButton
            variant="ghost"
            className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
            onClick={() => void handleSaveAndImport()}
          >
            <FloppyDisk size={14} />
            <span className="text-xs">{t('mindmap:import.saveAndImport', { defaultValue: '保存并导入' })}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            className="ds-btn shrink-0 text-[var(--mm-warning)] hover:bg-[var(--mm-warning-soft)]"
            onClick={handleConfirmImport}
          >
            <Upload size={14} />
            <span className="text-xs">{t('mindmap:import.unsavedConfirm')}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            className="ds-btn shrink-0 text-[var(--mm-text-muted)]"
            onClick={() => setShowImportConfirm(false)}
          >
            <span className="text-xs">{t('common:cancel')}</span>
          </DsButton>
        </div>
        </InlineCollapse>
      )}
      </AnimatePresence>

      {/* 窄屏时允许搜索条的模式/计数区换行，避免输入框被挤压到最小宽度以下 */}
      <AnimatePresence initial={false}>
      {showSearch && (
        <InlineCollapse role="search">
        <div className="mm-search-popover max-md:flex-wrap">
          <MagnifyingGlass size={16} className="text-[var(--mm-text-muted)]" />
          <Input
            type="search"
            className="mm-search-input"
            placeholder={t('mindmap:toolbar.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              runSearch(e.target.value, searchCaseSensitive, searchWholeWord);
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

          {/* W08 SearchOptions：大小写敏感 / 全词匹配开关 */}
          <div
            className="flex items-center gap-0.5"
            role="group"
            aria-label={t('mindmap:toolbar.searchOptions')}
          >
            <CommonTooltip content={t('mindmap:toolbar.searchCaseSensitive')} position="bottom">
              <DsButton
                variant="ghost"
                className={cn(
                  'ds-btn h-6 px-1.5 text-xs font-medium',
                  searchCaseSensitive
                    ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                    : 'text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)]'
                )}
                onClick={toggleSearchCaseSensitive}
                aria-pressed={searchCaseSensitive}
                aria-label={t('mindmap:toolbar.searchCaseSensitive')}
              >
                Aa
              </DsButton>
            </CommonTooltip>
            <CommonTooltip content={t('mindmap:toolbar.searchWholeWord')} position="bottom">
              <DsButton
                variant="ghost"
                className={cn(
                  'ds-btn h-6 px-1.5 text-xs font-medium',
                  searchWholeWord
                    ? 'bg-[var(--mm-bg-active)] text-[var(--mm-text)]'
                    : 'text-[var(--mm-text-muted)] hover:bg-[var(--mm-bg-hover)]'
                )}
                onClick={toggleSearchWholeWord}
                aria-pressed={searchWholeWord}
                aria-label={t('mindmap:toolbar.searchWholeWord')}
              >
                <span className="underline underline-offset-2">ab</span>
              </DsButton>
            </CommonTooltip>
          </div>

          {searchInput.trim() && (
            <div
              className="mm-search-mode"
              role="group"
              aria-label={t('mindmap:toolbar.searchMode')}
            >
              <DsButton
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
              </DsButton>
              <div className="mm-search-divider" />
              <DsButton
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
              </DsButton>
            </div>
          )}

          {/* 零命中空态：有查询词但无结果时的内联提示 */}
          {searchInput.trim() && searchResults.length === 0 && (
            <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap" aria-live="polite">
              {t('mindmap:toolbar.searchNoResults')}
            </span>
          )}

          {searchResults.length > 0 && (
            <div className="mm-search-results">
              <span className="tabular-nums">{currentSearchIndex + 1}/{searchResults.length}</span>
              <div className="mm-search-navigation">
                <DsButton variant="ghost" 
                  className="mm-search-nav-button"
                  onClick={prevSearchResult}
                  aria-label={t('mindmap:toolbar.prevResult')}
                >
                  <CaretUp size={12} />
                </DsButton>
                <DsButton variant="ghost" 
                  className="mm-search-nav-button"
                  onClick={nextSearchResult}
                  aria-label={t('mindmap:toolbar.nextResult')}
                >
                  <CaretDown size={12} />
                </DsButton>
              </div>
            </div>
          )}
          
          <DsButton variant="ghost" 
            className="mm-search-close"
            aria-label={t('mindmap:toolbar.closeSearch')}
            onClick={() => {
              setShowSearch(false);
              clearSearch();
              setSearchInput('');
            }}
          >
            <X className="w-4 h-4" />
          </DsButton>
        </div>
        </InlineCollapse>
      )}
      </AnimatePresence>

      {/* 版本历史：工具栏下方文档流内联面板（相对时间/来源徽标/diff 摘要 + 一键恢复） */}
      <AnimatePresence initial={false}>
      {showVersionHistory && resourceId && (
        <InlineCollapse>
          <VersionHistoryPanel
            mindmapId={resourceId}
            onClose={() => setShowVersionHistory(false)}
          />
        </InlineCollapse>
      )}
      </AnimatePresence>

      {/* 快捷键帮助：内联面板（从画布浮动卡片改为工具栏下方文档流，键盘场景桌面端展示） */}
      <AnimatePresence initial={false}>
      {showShortcutHelp && (
        <InlineCollapse className="hidden md:block">
          <ShortcutHelpPanel
            view={currentView === 'outline' ? 'outline' : 'mindmap'}
            keymap={mindMapPreferences.keymap}
            onClose={() => setShowShortcutHelp(false)}
          />
        </InlineCollapse>
      )}
      </AnimatePresence>

      {/* 导出进度：工具栏下方文档流内联进度条（非阻塞，不遮画布） */}
      <AnimatePresence initial={false}>
      {isExporting && (
        <InlineCollapse role="status" aria-live="polite">
          <div className="flex items-center gap-2.5 px-4 py-1.5 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)]">
            <Download size={14} className="shrink-0 text-[var(--mm-text-muted)]" />
            <span className="text-xs text-[var(--mm-text)] whitespace-nowrap">{t('mindmap:export.processing')}</span>
            <Progress value={exportProgress} className="h-1 flex-1 max-w-64" />
            <span className="text-xs text-[var(--mm-text-muted)] tabular-nums">{exportProgress}%</span>
          </div>
        </InlineCollapse>
      )}
      </AnimatePresence>

      <div className="flex-1 overflow-hidden relative flex flex-col bg-[var(--mm-bg)]">
        {/* 背诵模式状态条：顶部内联占位条（两个视图共享，不再悬浮遮挡画布） */}
        <ReciteStatusBar />
        <div className="flex-1 min-h-0 relative">
        {isLoadingDoc ? (
          <div className="h-full w-full flex items-center justify-center text-sm text-[var(--mm-text-muted)]">
            {t('mindmap:loading')}
          </div>
        ) : loadError ? (
          <div className="h-full w-full flex items-center justify-center p-6" role="alert">
            <div className="max-w-md w-full rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-5 text-center shadow-[var(--notes-popover-shadow)]">
              <WarningCircle size={32} className="mx-auto mb-3 text-red-500" />
              <p className="text-sm font-medium text-[var(--mm-text)] mb-2">{t('mindmap:loadFailed')}</p>
              <p className="text-xs text-[var(--mm-text-muted)] break-words">{loadError}</p>
              <DsButton variant="ghost"
                className="ds-btn mt-4 mx-auto"
                onClick={() => void tryLoadMindMap()}
              >
                <ArrowClockwise size={16} />
                <span className="text-xs">{t('mindmap:retryLoad')}</span>
              </DsButton>
            </div>
          </div>
        ) : currentView === 'outline' ? (
          <OutlineView
            ref={outlineViewRef}
            initialScrollTop={outlineScrollRestore}
            keymap={mindMapPreferences.keymap}
            descriptionPreview={mindMapPreferences.descriptionPreview}
          />
        ) : (
          <MindMapView
            ref={mindMapViewRef}
            initialViewport={mindMapViewportRestore}
            associationModeRequest={associationModeRequest}
          />
        )}
        </div>

        {presentationMode && (
          <DsButton
            variant="ghost"
            className="mm-presentation-exit"
            onClick={() => setPresentationMode(false)}
            aria-label={t('mindmap:presentation.exit')}
            title={t('mindmap:presentation.exitHint')}
          >
            <X size={18} />
          </DsButton>
        )}

        {/* Mobile: 快捷帮助必须有真实可见的全屏子屏；移动「更多」中的入口不再落入隐藏面板。 */}
        {showShortcutHelp && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden bg-[var(--mm-bg)]">
            <ShortcutHelpPanel
              mobile
              view={currentView === 'outline' ? 'outline' : 'mindmap'}
              keymap={mindMapPreferences.keymap}
              onClose={() => setShowShortcutHelp(false)}
            />
          </div>
        )}

        {/* Mobile: Structure Panel（inline 子屏：全屏替换内容区 + 顶栏返回） */}
        {showMobileStructure && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="mm-mobile-subview-header">
              <DsButton variant="ghost"
                className="mm-mobile-subview-back"
                onClick={() => setShowMobileStructure(false)}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </DsButton>
              <span className="font-medium text-sm">{t('mindmap:selectStructure')}</span>
            </div>
            <div className="mm-mobile-subview-scroll flex-1 min-h-0 overflow-y-auto p-2">
              <StructureSelector 
                placement="inline"
                onSelect={() => setShowMobileStructure(false)}
              />
            </div>
          </div>
        )}
        
        {/* Mobile: Style Panel（inline 子屏：全屏替换内容区 + 顶栏返回） */}
        {showMobileStyle && (
          <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
            <div className="mm-mobile-subview-header">
              <DsButton variant="ghost"
                className="mm-mobile-subview-back"
                onClick={() => setShowMobileStyle(false)}
                aria-label={t('common:back')}
              >
                <CaretLeft className="w-5 h-5" />
              </DsButton>
              <span className="font-medium text-sm">{t('mindmap:toolbar.styleSettings')}</span>
            </div>
            <div className="mm-mobile-subview-scroll flex-1 min-h-0 overflow-y-auto p-2">
              <StyleSettings placement="inline" />
            </div>
          </div>
        )}

        {/* Mobile: More Panel（inline 子屏：分组列表 + 顶栏返回，替代 AppMenu 浮层） */}
        {showMobileMore && (() => {
          const MenuRow: React.FC<{
            icon?: React.ReactNode;
            label: string;
            checked?: boolean;
            disabled?: boolean;
            onClick: () => void;
          }> = ({ icon, label, checked, disabled, onClick }) => (
            <DsButton
              variant="ghost"
              className="w-full h-11 !justify-start gap-3 px-3 rounded-md text-sm text-[var(--mm-text)]"
              disabled={disabled}
              onClick={onClick}
            >
              <span className="w-5 h-5 flex items-center justify-center shrink-0 text-[var(--mm-text-secondary)]">
                {icon}
              </span>
              <span className="flex-1 text-left">{label}</span>
              {checked && <Check size={16} className="text-[var(--mm-primary)] shrink-0" />}
            </DsButton>
          );
          const MenuGroup: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
            <div className="mb-2">
              <div className="h-8 flex items-end px-3 pb-1 text-[11px] font-medium text-[var(--mm-text-muted)]">
                {title}
              </div>
              {children}
            </div>
          );
          const closeThen = (action: () => void) => () => {
            setShowMobileMore(false);
            action();
          };
          return (
            <div className="mm-mobile-subview absolute inset-0 z-50 md:hidden flex flex-col bg-[var(--mm-bg)]">
              <div className="mm-mobile-subview-header">
                <DsButton variant="ghost"
                  className="mm-mobile-subview-back"
                  onClick={() => setShowMobileMore(false)}
                  aria-label={t('common:back')}
                >
                  <CaretLeft className="w-5 h-5" />
                </DsButton>
                <span className="font-medium text-sm">{t('mindmap:toolbar.moreActions')}</span>
              </div>
              <div className="mm-mobile-subview-scroll flex-1 min-h-0 overflow-y-auto px-1 py-1">
                <MenuGroup title={t('mindmap:menu.groupView', { defaultValue: '视图' })}>
                  <MenuRow icon={<GitBranch size={18} />} label={t('mindmap:toolbar.structure')} onClick={openMobileStructure} />
                  <MenuRow icon={<Gear size={18} />} label={t('mindmap:toolbar.style')} onClick={openMobileStyle} />
                  <MenuRow
                    icon={<MagnifyingGlass size={18} />}
                    label={t('mindmap:toolbar.search')}
                    onClick={closeThen(() => setShowSearch(true))}
                  />
                  <MenuRow icon={<Presentation size={18} />} label={t('mindmap:presentation.enter')} onClick={closeThen(handleEnterPresentation)} />
                  <MenuRow icon={<ArrowsOutLineVertical size={18} />} label={t('mindmap:toolbar.expandAll')} onClick={closeThen(() => expandAll())} />
                  <MenuRow icon={<ArrowsInLineVertical size={18} />} label={t('mindmap:toolbar.collapseAll')} onClick={closeThen(() => collapseAll())} />
                  <MenuRow label={t('mindmap:toolbar.collapseToLevel', { level: 1 })} onClick={closeThen(() => collapseToDepth(1))} />
                  <MenuRow label={t('mindmap:toolbar.collapseToLevel', { level: 2 })} onClick={closeThen(() => collapseToDepth(2))} />
                  <MenuRow label={t('mindmap:toolbar.collapseToLevel', { level: 3 })} onClick={closeThen(() => collapseToDepth(3))} />
                </MenuGroup>
                <MenuGroup title={t('mindmap:toolbar.learning')}>
                  <MenuRow
                    icon={<BookOpen size={18} />}
                    label={reciteMode ? t('mindmap:recite.exit') : t('mindmap:recite.title')}
                    checked={reciteMode}
                    onClick={closeThen(() => setReciteMode(!reciteMode))}
                  />
                  <MenuRow
                    icon={<EyeSlash size={18} />}
                    label={t('mindmap:toolbar.hideCompleted')}
                    checked={hideCompleted}
                    onClick={() => setHideCompleted(!hideCompleted)}
                  />
                  <MenuRow icon={<ShareNetwork size={18} />} label={t('mindmap:association.add')} onClick={closeThen(handleStartAssociation)} />
                </MenuGroup>
                <MenuGroup title={t('mindmap:menu.groupData', { defaultValue: '数据' })}>
                  <MenuRow
                    icon={<FloppyDisk size={18} />}
                    label={isSaving ? t('mindmap:toolbar.saving') : isDirty ? t('mindmap:toolbar.save') : t('mindmap:toolbar.saved')}
                    disabled={!isDirty || isSaving}
                    onClick={closeThen(handleSave)}
                  />
                  <MenuRow
                    icon={<ClockCounterClockwise size={18} />}
                    label={t('mindmap:versions.title')}
                    onClick={closeThen(openVersionHistory)}
                  />
                  <MenuRow icon={<Upload size={18} />} label={t('mindmap:import.title')} onClick={closeThen(handleImport)} />
                  <MenuRow icon={<FileMd size={18} />} label={t('mindmap:export.exportMarkdown')} onClick={closeThen(() => void handleExport('markdown'))} />
                  <MenuRow icon={<TreeStructure size={18} />} label={t('mindmap:export.exportOpml')} onClick={closeThen(() => void handleExport('opml'))} />
                  <MenuRow icon={<FileCode size={18} />} label={t('mindmap:export.dialogExportJson')} onClick={closeThen(() => void handleExport('json'))} />
                  <MenuRow icon={<FileZip size={18} />} label={t('mindmap:export.exportXmind')} onClick={closeThen(() => void handleExport('xmind'))} />
                  <MenuRow icon={<FileTxt size={18} />} label={t('mindmap:export.exportText')} onClick={closeThen(() => void handleExport('text'))} />
                  <MenuRow icon={<FilePng size={18} />} label={t('mindmap:export.exportPng')} onClick={closeThen(() => void handleExport('png'))} />
                  <MenuRow icon={<FileSvg size={18} />} label={t('mindmap:export.svgVector')} onClick={closeThen(() => void handleExport('svg'))} />
                  <MenuRow icon={<FilePdf size={18} />} label={t('mindmap:export.exportPdf')} onClick={closeThen(() => void handleExport('pdf'))} />
                </MenuGroup>
                {/* 快捷键帮助为键盘场景功能，移动端不提供入口（P0-4） */}
              </div>
            </div>
          );
        })()}

      </div>
    </div>
    </MindMapActiveContext.Provider>
    </>
  );
};

/**
 * 每个内容视图持有独立 store。resourceId 改变或错误边界重置时同步换新实例，
 * 避免旧资源的文档、历史栈、编辑状态或保存定时器泄漏到新资源。
 *
 * B-2：被替换下来的旧 store 在 commit 后调用 destroy()（W01 契约：
 * 取消 debounce/retry 定时器并终结实例），杜绝旧定时器回调跨文档保存。
 * B-11：错误边界重置（errorNonce++）时同样重建 store，清掉可能残留在
 * immer/history 里的坏状态，而不是仅 reload 文档。
 */
export const MindMapContentView = forwardRef<
  MindMapContentViewHandle,
  MindMapContentViewProps
>((props, ref) => {
  const { t } = useTranslation(['mindmap']);
  const [errorNonce, setErrorNonce] = useState(0);
  const holderRef = useRef<{
    resourceId: string | undefined;
    errorNonce: number;
    store: MindMapStoreApi;
  } | null>(null);
  // 换 store 是 render 期决策，副作用（destroy 旧实例）延迟到 commit 后执行
  const pendingDestroyRef = useRef<MindMapStoreApi[]>([]);
  // B-1：宿主调用 discardDraft 后置位；Inner 的 unmount/flush 路径读取
  const discardedRef = useRef(false);

  if (
    !holderRef.current ||
    holderRef.current.resourceId !== props.resourceId ||
    holderRef.current.errorNonce !== errorNonce
  ) {
    if (holderRef.current) {
      pendingDestroyRef.current.push(holderRef.current.store);
    }
    holderRef.current = {
      resourceId: props.resourceId,
      errorNonce,
      store: createMindMapStore(),
    };
    // 新文档实例开始新的丢弃语义周期
    discardedRef.current = false;
  }

  const store = holderRef.current.store;

  // commit 后销毁被替换的旧 store（子组件的 cleanup——saveDraftSync/注销——已先行）
  useEffect(() => {
    if (pendingDestroyRef.current.length === 0) return;
    const staleStores = pendingDestroyRef.current.splice(0);
    for (const staleStore of staleStores) {
      try {
        staleStore.getState().destroy();
      } catch (error) {
        console.error('[MindMapContentView] Failed to destroy stale store:', error);
      }
    }
  });

  useEffect(() => {
    if (!props.resourceId) return;
    return registerMindMapStore(props.resourceId, store, props.storeInstanceId);
  }, [props.resourceId, props.storeInstanceId, store]);

  useImperativeHandle(
    ref,
    () => ({
      discardDraft: () => {
        discardedRef.current = true;
        const currentStore = holderRef.current?.store;
        if (!currentStore) return;
        try {
          // 先清本地草稿（依赖 state.mindmapId 定位 key），再取消待执行定时器
          currentStore.getState().clearDraft();
          currentStore.getState().destroy();
        } catch (error) {
          console.error('[MindMapContentView] discardDraft failed:', error);
        }
      },
      switchView: (view) => {
        const currentStore = holderRef.current?.store;
        if (!currentStore) return;
        const controller = getMindMapViewController(currentStore);
        if (controller) {
          controller.switchView(view);
        } else {
          currentStore.getState().setCurrentView(view);
        }
      },
    }),
    [],
  );

  const handleErrorReset = useCallback(() => {
    setErrorNonce((nonce) => nonce + 1);
  }, []);

  return (
    <MindMapErrorBoundary
      onReset={handleErrorReset}
      fallbackMessage={t('mindmap:errorBoundary')}
    >
      <MindMapStoreContext.Provider value={store}>
        <MindMapContentViewInner
          key={`${props.resourceId ?? 'blank'}:${errorNonce}`}
          {...props}
          discardedRef={discardedRef}
        />
      </MindMapStoreContext.Provider>
    </MindMapErrorBoundary>
  );
});

MindMapContentView.displayName = 'MindMapContentView';
