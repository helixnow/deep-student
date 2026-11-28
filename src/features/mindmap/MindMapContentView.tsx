import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import './init';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react';
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
import { getMindMapViewController, registerMindMapViewController } from './viewController';
import { dstu } from '@/dstu';
import {
  exportToImage,
  exportToJson,
  exportToMarkdown,
  exportToOpml,
  exportToPlainText,
  exportToXmindFile,
} from './utils/exporters';
import {
  createXmindImportReport,
  importFromFile,
  importFromMmapZip,
  importFromXmindZip,
  importMindMap,
} from './utils/importers';
import { fileManager } from '@/utils/fileManager';
import { TauriAPI } from '@/utils/tauriApi';
import { cn } from '@/utils/cn';
import { BACK_PRIORITY, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { OutlineView, type OutlineViewHandle } from './views/OutlineView';
import { MindMapView, type MindMapViewHandle } from './views/MindMapView';
import { MindMapStagingTray } from './components/mindmap/MindMapStagingTray';
import { MindMapToolbar, type MindMapToolbarPanel } from './components/shell/MindMapToolbar';
import {
  MindMapFormatDock,
  MindMapSearchBanner,
  MindMapStatusBanners,
  type MindMapImportReportBannerData,
} from './components/shell/MindMapStatusBanners';
import { MindMapMobileSubviews, type MindMapMobileOverlay } from './components/shell/MindMapMobileSubviews';
import { MindMapPresentationHud } from './components/shell/MindMapPresentationBar';
import { dispatchMindMapAiAction, type MindMapAiAction } from './components/shell/dispatchMindMapAiAction';
import { useMindMapClipboard } from './hooks/useMindMapClipboard';
import { useMindMapTheme } from './hooks/useMindMapTheme';
import { StyleRegistry } from './registry/StyleRegistry';
import { useMindMapExcerptBridge } from './hooks/useMindMapExcerptBridge';
import { useMindMapHandoutSync } from './hooks/useMindMapHandoutSync';
import {
  DS_MINDMAP_FLASHCARD_PROJECTED_EVENT,
  loadMindMapMasterySummary,
  type MindMapNodeMasteryStatus,
} from './interop/mindmapCardProjection';
import { addTypedEventListener } from '@/events';
import {
  FLASHCARDS_CHANGED_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  subscribeFlashcardsDueRefresh,
} from '@/events/flashcards';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { captureOutlineResumePoint, prepareOutlineResume, type OutlineResumePoint } from './utils/viewContinuity';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useMindMapPreferences } from './utils/mindmapPreferences';
import { useCoarsePointer, useMobileScreen } from './hooks/useCoarsePointer';
import { getAncestors } from './utils/node/traverse';
import type { MindMapDocument } from './types';
import './styles/mindmap.css';

const EMPTY_MASTERY_STATUS: Record<string, MindMapNodeMasteryStatus> = {};
const MINDMAP_IMPORT_EXTENSIONS = ['xmind', 'mmap', 'opml', 'md', 'markdown', 'json', 'mm', 'txt'] as const;
const MINDMAP_IMPORT_ACCEPT = MINDMAP_IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(',');

function isNativeFileDialogAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as Record<string, unknown>;
  return Boolean(win.__TAURI_INTERNALS__ || win.__TAURI_IPC__);
}

const MindMapClipboardEffects: React.FC = () => {
  useMindMapClipboard();
  return null;
};

/** 隔离 isDirty / isSaving 订阅，仅向宿主工作区标签页同步保存态 */
const MindMapSaveStateReporter: React.FC<{
  onSaveStateChange?: (state: 'saved' | 'saving' | 'dirty') => void;
}> = ({ onSaveStateChange }) => {
  const isDirty = useMindMapStore((s) => s.isDirty);
  const isSaving = useMindMapStore((s) => s.isSaving);
  useEffect(() => {
    onSaveStateChange?.(isSaving ? 'saving' : isDirty ? 'dirty' : 'saved');
  }, [isDirty, isSaving, onSaveStateChange]);
  return null;
};

const isInsideSearchBar = (el: Element | null): boolean => Boolean(el?.closest('.mm-search-popover'));

function isEditableElement(el: Element | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return Boolean(el.closest('[contenteditable="true"], [data-node-editing="true"]'));
}

/**
 * 判断焦点或事件目标是否处于节点/备注/关联线/总结框内联编辑态（排除搜索框）。
 * 编辑态按 Escape 必须让位于内联编辑器取消编辑，不得误退演示或关闭侧栏面板。
 */
function isInlineMindMapEditorActive(target: EventTarget | null): boolean {
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
  if (isEditableElement(activeEl) && !isInsideSearchBar(activeEl)) return true;
  const targetEl = target instanceof Element ? target : null;
  return isEditableElement(targetEl) && !isInsideSearchBar(targetEl);
}

const TRANSIENT_OVERLAY_SELECTOR = [
  '[role="menu"][data-state="open"]',
  '[data-testid="mm-context-menu"]:not([data-state="closed"])',
  '[data-testid="mm-image-lightbox"]',
  '.mm-format-popover[data-state="open"]',
  '.mm-dragging',
].join(', ');

/** 判断页面上是否存在更高优先级的瞬态浮层（右键菜单 / 下拉菜单 / 格式条 Popover / 图片灯箱） */
function hasOpenTransientOverlay(container: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false;
  const overlays = document.querySelectorAll(TRANSIENT_OVERLAY_SELECTOR);
  for (const el of overlays) {
    if (!container || !el.contains(container)) return true;
  }
  return false;
}

const TEXT_EXPORT_SPECS: Record<
  string,
  { serialize: (doc: MindMapDocument) => string; ext: string; filterExt: string; filterKey: string; dialogKey: string }
> = {
  opml: { serialize: exportToOpml, ext: '.opml', filterExt: 'opml', filterKey: 'mindmap:export.filterOpml', dialogKey: 'mindmap:export.dialogExportOpml' },
  markdown: { serialize: exportToMarkdown, ext: '.md', filterExt: 'md', filterKey: 'mindmap:export.filterMarkdown', dialogKey: 'mindmap:export.dialogExportMarkdown' },
  json: { serialize: exportToJson, ext: '.json', filterExt: 'json', filterKey: 'mindmap:export.filterJson', dialogKey: 'mindmap:export.dialogExportJson' },
  text: { serialize: exportToPlainText, ext: '.txt', filterExt: 'txt', filterKey: 'mindmap:export.filterText', dialogKey: 'mindmap:export.dialogExportText' },
};

type CountableTree = { children?: CountableTree[] };
const countTreeNodes = (node: CountableTree): number =>
  1 + (node.children ?? []).reduce((sum, child) => sum + countTreeNodes(child), 0);

function waitForCanvasNodes(
  containerRef: React.RefObject<HTMLDivElement | null>,
  isCurrent: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (!isCurrent()) return resolve(false);
      if (containerRef.current?.querySelector('.react-flow__node')) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        return;
      }
      if (Date.now() - start > 3000) return resolve(false);
      requestAnimationFrame(poll);
    };
    poll();
  });
}

/** 宿主可通过 ref 调用的命令（Notes 关闭标签「丢弃修改」等场景） */
export interface MindMapContentViewHandle {
  discardDraft: () => void;
  switchView: (view: 'outline' | 'mindmap') => void;
}

interface MindMapContentViewProps {
  resourceId?: string;
  storeInstanceId?: string;
  onTitleChange?: (title: string) => void;
  onReady?: () => void;
  onLoadError?: (message: string) => void;
  isActive?: boolean;
  focusOnActive?: boolean;
  onSaveStateChange?: (state: 'saved' | 'saving' | 'dirty') => void;
  className?: string;
}

interface MindMapContentViewInnerProps extends MindMapContentViewProps {
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
  className,
}) => {
  const { t } = useTranslation(['mindmap', 'common']);
  const storeApi = useMindMapStoreApi();
  const kernel = useOptionalUiKernel();
  const mindMapPreferences = useMindMapPreferences();

  // 细粒度 Store 订阅：杜绝对整个 state.document / 高频编辑状态的订阅，避免敲字时根壳层重渲染
  const slice = useMindMapStore(
    useShallow((s) => ({
      currentView: s.currentView,
      reciteMode: s.reciteMode,
      autoExcerptEnabled: s.autoExcerptEnabled,
      stagingTrayOpen: s.stagingTrayOpen,
      viewRootId: s.viewRootId,
      styleId: s.styleId,
      docRootTitle: s.document.root.text,
      outlineScrollRestore: s.viewports.outline?.scrollTop ?? null,
      mindMapViewportRestore: s.viewports.mindmap ?? null,
    })),
  );
  const { currentView, reciteMode, autoExcerptEnabled, stagingTrayOpen, viewRootId, styleId, docRootTitle, outlineScrollRestore, mindMapViewportRestore } = slice;
  const firstLevelBranchIds = useMindMapStore(useShallow((s) => s.document.root.children.map((c) => c.id)));

  const currentTheme = useMindMapTheme(styleId, { enabled: currentView === 'mindmap' });
  const themeCanvasBg = currentView === 'mindmap' ? currentTheme?.canvas?.background : undefined;
  const themeEdgeStroke = currentView === 'mindmap' ? currentTheme?.edge?.stroke : undefined;
  const themeEdgeStrokeActive = currentView === 'mindmap' ? currentTheme?.edge?.strokeActive : undefined;
  const mindmapThemeVars = useMemo<React.CSSProperties | undefined>(() => {
    if (currentView !== 'mindmap' || (!themeCanvasBg && !themeEdgeStroke && !themeEdgeStrokeActive)) {
      return undefined;
    }
    const vars: Record<string, string> = {};
    if (themeCanvasBg) vars['--mm-bg'] = themeCanvasBg;
    if (themeEdgeStroke) vars['--mm-edge'] = themeEdgeStroke;
    if (themeEdgeStrokeActive) vars['--mm-edge-active'] = themeEdgeStrokeActive;
    return vars as React.CSSProperties;
  }, [currentView, themeCanvasBg, themeEdgeStroke, themeEdgeStrokeActive]);

  // 壳层本地 UI 状态
  const [overlayPanel, setOverlayPanel] = useState<MindMapMobileOverlay>(null);
  const [activePanel, setActivePanel] = useState<MindMapToolbarPanel>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<MindMapImportReportBannerData | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [associationModeRequest, setAssociationModeRequest] = useState(0);

  // Spotlight 分支演示状态（-1 = 全图总览；0..N-1 = 一级分支步进）
  const [presentationMode, setPresentationMode] = useState(false);
  const [presentationStepIndex, setPresentationStepIndex] = useState(-1);

  // FSRS 掌握度热力图闭环
  const [showMasteryOverlay, setShowMasteryOverlay] = useState(false);
  const [masteryStatusByNodeId, setMasteryStatusByNodeId] = useState<Record<string, MindMapNodeMasteryStatus>>(EMPTY_MASTERY_STATUS);
  const [masteryRefreshNonce, setMasteryRefreshNonce] = useState(0);
  const prevReciteModeRef = useRef(reciteMode);
  const lastTitleRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outlineViewRef = useRef<OutlineViewHandle>(null);
  const mindMapViewRef = useRef<MindMapViewHandle>(null);
  const outlineResumeRef = useRef<OutlineResumePoint | null>(null);
  const isCoarsePointer = useCoarsePointer();
  const isMobileScreen = useMobileScreen();
  const normalizedView: 'outline' | 'mindmap' = currentView === 'outline' ? 'outline' : 'mindmap';
  const clampedPresentationStep =
    presentationStepIndex >= 0 && presentationStepIndex < firstLevelBranchIds.length ? presentationStepIndex : -1;
  const presentationBranchId =
    presentationMode && clampedPresentationStep >= 0 ? firstLevelBranchIds[clampedPresentationStep] ?? null : null;

  // 背诵模式退出后自动刷新一次掌握度热力图
  useEffect(() => {
    const wasRecite = prevReciteModeRef.current;
    prevReciteModeRef.current = reciteMode;
    if (wasRecite && !reciteMode) setMasteryRefreshNonce((n) => n + 1);
  }, [reciteMode]);

  // 热力图开启时，仅在导图画布视图订阅闪卡复习 / 投影 / 变更事件以实时刷新掌握度徽标
  useEffect(() => {
    if (!showMasteryOverlay || normalizedView !== 'mindmap' || !resourceId) return;
    const bump = () => setMasteryRefreshNonce((n) => n + 1);
    const unsubDue = subscribeFlashcardsDueRefresh(bump);
    const unsubProjected = addTypedEventListener<{ mapId?: string }>(
      DS_MINDMAP_FLASHCARD_PROJECTED_EVENT,
      (detail) => {
        if (detail?.mapId && detail.mapId !== resourceId) return;
        bump();
      },
    );
    const unsubStats = addTypedEventListener(FSRS_STATS_REFRESH_EVENT, bump);
    const unsubChanged = addTypedEventListener(FLASHCARDS_CHANGED_EVENT, bump);
    return () => {
      unsubDue();
      unsubProjected();
      unsubStats();
      unsubChanged();
    };
  }, [showMasteryOverlay, normalizedView, resourceId]);

  useEffect(() => {
    if (!showMasteryOverlay || !resourceId) {
      setMasteryStatusByNodeId(EMPTY_MASTERY_STATUS);
      return;
    }
    if (normalizedView !== 'mindmap') return;
    let cancelled = false;
    void loadMindMapMasterySummary(resourceId)
      .then((summary) => {
        if (cancelled) return;
        const next: Record<string, MindMapNodeMasteryStatus> = {};
        for (const [nodeId, entry] of Object.entries(summary)) {
          if (entry?.status) next[nodeId] = entry.status;
        }
        setMasteryStatusByNodeId(next);
      })
      .catch(() => {
        if (!cancelled) setMasteryStatusByNodeId(EMPTY_MASTERY_STATUS);
      });
    return () => {
      cancelled = true;
    };
  }, [showMasteryOverlay, normalizedView, resourceId, masteryRefreshNonce]);

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

  // 大纲⇄导图双模保真切换（blur 提交 + viewport 保存 + 光标恢复）
  const switchView = useCallback(
    (next: 'outline' | 'mindmap') => {
      const state = storeApi.getState();
      const prev = state.currentView;
      if (prev === next) return;

      const active = window.document.activeElement;
      if (prev === 'outline') outlineResumeRef.current = captureOutlineResumePoint(active);
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)
      ) {
        active.blur();
      }
      if (state.editingNodeId) state.setEditingNodeId(null);
      if (state.editingNoteNodeId) state.setEditingNoteNodeId(null);

      if (prev === 'outline') {
        state.setViewViewport('outline', { scrollTop: outlineViewRef.current?.getScrollTop() ?? 0 });
      } else if (prev === 'mindmap') {
        try {
          const vp = mindMapViewRef.current?.getViewport();
          if (vp) state.setViewViewport('mindmap', vp);
        } catch {
          // ReactFlow 已卸载时忽略
        }
      }

      state.setCurrentView(next);
      if (next === 'outline') {
        setActivePanel((p) => (p === 'structure' || p === 'style' ? null : p));
        setOverlayPanel((p) => (p === 'structure' || p === 'style' ? null : p));
        setPresentationMode(false);
        setPresentationStepIndex(-1);
        const targetId = prepareOutlineResume(state.focusedNodeId, outlineResumeRef.current);
        if (targetId) {
          window.requestAnimationFrame(() => {
            const current = storeApi.getState();
            if (current.document !== state.document || current.currentView !== 'outline') return;
            current.setFocusedNodeId(targetId);
            outlineViewRef.current?.scrollFocusedIntoView();
          });
        }
      }
    },
    [storeApi],
  );

  useEffect(() => registerMindMapViewController(storeApi, { switchView }), [storeApi, switchView]);

  const handleToggleViewCommand = useCallback(() => {
    if (isActive === false) return;
    switchView(storeApi.getState().currentView === 'outline' ? 'mindmap' : 'outline');
  }, [isActive, storeApi, switchView]);

  // 画布 / 大纲 / 格式条统一 AI 节点一键操作闭环
  const handleAiNodeAction = useCallback(
    (action: MindMapAiAction, nodeId: string) => {
      const state = storeApi.getState();
      void dispatchMindMapAiAction({
        action,
        nodeId,
        document: state.document,
        resourceId: resourceId ?? state.mindmapId,
        t,
      });
    },
    [resourceId, storeApi, t],
  );

  const handleAiActionEvent = useCallback(
    (event: Event) => {
      if (isActive === false || event.defaultPrevented) return;
      const detail = (
        event as CustomEvent<{ action?: MindMapAiAction; nodeId?: string; mindmapId?: string | null }>
      ).detail;
      if (!detail?.action || !detail.nodeId) return;
      const currentDocId = resourceId ?? storeApi.getState().mindmapId ?? null;
      const eventDocId = detail.mindmapId ?? null;
      if (eventDocId !== currentDocId) return;
      event.preventDefault();
      handleAiNodeAction(detail.action, detail.nodeId);
    },
    [handleAiNodeAction, isActive, resourceId, storeApi],
  );

  useEventRegistry(
    [
      { target: 'window', type: 'mindmap:toggle-view', listener: handleToggleViewCommand },
      { target: 'window', type: 'mindmap:ai-action', listener: handleAiActionEvent },
    ],
    [handleToggleViewCommand, handleAiActionEvent],
  );

  const handleCloseSearch = useCallback(() => {
    setShowSearch(false);
    storeApi.getState().clearSearch();
    setSearchInput('');
  }, [storeApi]);

  const handleToggleSearch = useCallback(() => {
    setShowSearch((prev) => {
      if (prev) {
        storeApi.getState().clearSearch();
        setSearchInput('');
        return false;
      }
      return true;
    });
  }, [storeApi]);

  const handleToggleMasteryOverlay = useCallback(() => setShowMasteryOverlay((p) => !p), []);

  useEffect(() => {
    if (isMobileScreen) {
      setActivePanel(null);
      return;
    }
    setOverlayPanel((p) => (p === 'structure' || p === 'style' || p === 'more' ? null : p));
  }, [isMobileScreen]);

  // Spotlight 分支演示控制
  const handleEnterPresentation = useCallback(() => {
    switchView('mindmap');
    setShowSearch(false);
    setActivePanel(null);
    setOverlayPanel(null);
    setPresentationStepIndex(-1);
    setPresentationMode(true);
  }, [switchView]);

  const handleExitPresentation = useCallback(() => {
    setPresentationMode(false);
    setPresentationStepIndex(-1);
  }, []);

  const handlePresentationNext = useCallback(
    () => setPresentationStepIndex((p) => (firstLevelBranchIds.length === 0 ? -1 : Math.min(p + 1, firstLevelBranchIds.length - 1))),
    [firstLevelBranchIds.length],
  );
  const handlePresentationPrev = useCallback(() => setPresentationStepIndex((p) => Math.max(p - 1, -1)), []);
  const handlePresentationOverview = useCallback(() => setPresentationStepIndex(-1), []);

  // 同步快照 ref：消除全局键盘与返回键监听器因局部 UI 态切换导致的频繁拆装抖动
  const shellUiSnapshot = {
    activePanel,
    overlayPanel,
    isMobileScreen,
    stagingTrayOpen,
    presentationMode,
    reciteMode,
    showImportConfirm,
    importError,
    importReport,
    showSearch,
    currentView,
    firstLevelBranchCount: firstLevelBranchIds.length,
  };
  const shellUiRef = useRef(shellUiSnapshot);
  shellUiRef.current = shellUiSnapshot;

  // 移动端打开暂存盘时自动收起搜索条与子屏，避免层叠压盖
  const prevMobileStagingRef = useRef(false);
  useEffect(() => {
    const mobileStagingVisible = isMobileScreen && stagingTrayOpen && !presentationMode && !reciteMode;
    const justOpened = mobileStagingVisible && !prevMobileStagingRef.current;
    prevMobileStagingRef.current = mobileStagingVisible;
    if (!justOpened) return;
    setOverlayPanel(null);
    if (shellUiRef.current.showSearch) handleCloseSearch();
  }, [handleCloseSearch, isMobileScreen, presentationMode, reciteMode, stagingTrayOpen]);

  const isMobileStagingOpen =
    isMobileScreen && stagingTrayOpen && !presentationMode && !reciteMode;

  const topOverlayBackKey = isMobileStagingOpen
    ? 'mobileStaging'
    : overlayPanel !== null
      ? `overlay:${overlayPanel}`
      : showImportConfirm
        ? 'importConfirm'
        : importError
          ? 'importError'
          : importReport
            ? 'importReport'
            : showSearch
              ? 'search'
              : presentationMode
                ? 'presentation'
                : null;

  useEffect(() => {
    if (isActive === false || !topOverlayBackKey) return;
    return registerBackHandler(() => {
      const ui = shellUiRef.current;
      if (ui.isMobileScreen && ui.stagingTrayOpen && !ui.presentationMode && !ui.reciteMode) {
        storeApi.getState().setStagingTrayOpen(false);
      } else if (ui.overlayPanel !== null) {
        setOverlayPanel(null);
      } else if (ui.showImportConfirm) {
        setShowImportConfirm(false);
      } else if (ui.importError) {
        setImportError(null);
      } else if (ui.importReport) {
        setImportReport(null);
      } else if (ui.showSearch) {
        handleCloseSearch();
      } else if (ui.presentationMode) {
        handleExitPresentation();
      } else {
        return false;
      }
      return true;
    }, BACK_PRIORITY.overlay);
  }, [handleCloseSearch, handleExitPresentation, isActive, storeApi, topOverlayBackKey]);

  const topViewBackKey = reciteMode ? 'recite' : viewRootId ? `focus:${viewRootId}` : null;

  useEffect(() => {
    if (isActive === false || !topViewBackKey) return;
    return registerBackHandler(() => {
      const state = storeApi.getState();
      if (state.reciteMode) {
        state.setReciteMode(false);
        return true;
      }
      if (!state.viewRootId) return false;
      const root = state.document.root;
      const parent = getAncestors(root, state.viewRootId).at(-1);
      state.setViewRootId(parent && parent.id !== root.id ? parent.id : null);
      return true;
    }, BACK_PRIORITY.view);
  }, [isActive, storeApi, topViewBackKey]);

  // 标签页保活：isActive 变化时同步草稿/按需重载
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;
    const state = storeApi.getState();
    if (wasActive && !isActive && resourceId && state.mindmapId === resourceId) {
      state.saveDraftSync();
    } else if (!wasActive && isActive && resourceId && state.mindmapId !== resourceId) {
      void state.loadMindMap(resourceId).catch((err) => {
        console.error('[MindMapContentView] Failed to reload from draft:', err);
      });
    }
  }, [isActive, resourceId, storeApi]);

  const documentLoadRequestRef = useRef(0);
  const tryLoadMindMap = useCallback(async () => {
    const request = ++documentLoadRequestRef.current;
    if (!resourceId) return;
    setIsLoadingDoc(true);
    setLoadError(null);
    try {
      await storeApi.getState().loadMindMap(resourceId);
      if (request !== documentLoadRequestRef.current) return;
      const loadedState = storeApi.getState();
      if (!loadedState.focusedNodeId && loadedState.document?.root?.id) {
        loadedState.setFocusedNodeId(loadedState.document.root.id);
      }
      onReady?.();
    } catch (err: unknown) {
      if (request !== documentLoadRequestRef.current) return;
      const message = err instanceof Error ? err.message : t('mindmap:loadError');
      setLoadError(message);
      onLoadError?.(message);
      showGlobalNotification('error', message, t('mindmap:loadErrorTitle'));
      console.error('[MindMapContentView] Failed to load mindmap:', err);
    } finally {
      if (request === documentLoadRequestRef.current) setIsLoadingDoc(false);
    }
  }, [resourceId, onReady, onLoadError, storeApi, t]);

  useEffect(() => {
    void tryLoadMindMap();
    return () => {
      documentLoadRequestRef.current += 1;
    };
  }, [tryLoadMindMap]);

  // 监听 DSTU watch：外部（AI 工具等）更新导图时静默重载
  useEffect(() => {
    if (!resourceId) return;
    return dstu.watch('*', (event) => {
      if (event.type !== 'updated' || !event.node || event.node.id !== resourceId) return;
      const state = storeApi.getState();
      if (state.mindmapId !== resourceId || state.isSaving) return;
      const known = Date.parse(state.metadata?.updatedAt || '') || 0;
      if ((event.node.updatedAt ?? 0) <= known) return;
      if (state.isDirty) {
        showGlobalNotification('info', t('mindmap:store.externalUpdatedDirty'));
        return;
      }
      void state
        .loadMindMap(resourceId, { preserveViewports: true, preserveLocalChanges: true })
        .catch((err) => console.error('[MindMapContentView] watch-triggered reload failed:', err));
    });
  }, [resourceId, t, storeApi]);

  useEffect(() => {
    if (!onTitleChange || isActive === false) return;
    const title = docRootTitle ?? '';
    if (lastTitleRef.current !== title) {
      lastTitleRef.current = title;
      onTitleChange(title);
    }
  }, [docRootTitle, onTitleChange, isActive]);

  // 命令式导出：按需通过 storeApi.getState().document 读取
  const handleExport = useCallback(
    async (format: string) => {
      const currentState = storeApi.getState();
      const doc = currentState.document;
      if (!doc) return;
      const loadRequest = documentLoadRequestRef.current;
      const filename = doc.root.text || 'mindmap';

      if (format === 'png' || format === 'svg' || format === 'pdf') {
        if (currentState.currentView !== 'mindmap') {
          switchView('mindmap');
          const rendered = await waitForCanvasNodes(
            containerRef,
            () => loadRequest === documentLoadRequestRef.current,
          );
          if (loadRequest !== documentLoadRequestRef.current) return;
          if (!rendered) {
            showGlobalNotification('warning', t('mindmap:export.switchToMindMapView'));
            return;
          }
        }
        try {
          const themeBg = StyleRegistry.get(currentState.styleId)?.canvas?.background;
          const backgroundColor = themeBg?.startsWith('var(')
            ? getComputedStyle(containerRef.current ?? document.documentElement)
                .getPropertyValue('--mm-bg')
                .trim() || getComputedStyle(document.documentElement).backgroundColor
            : themeBg || getComputedStyle(document.documentElement).backgroundColor;
          if (format === 'pdf') showGlobalNotification('info', t('mindmap:export.pdfPrintDegradeHint'));
          const result = await exportToImage({
            format: format as 'png' | 'svg' | 'pdf',
            filename,
            backgroundColor,
            container: containerRef.current,
            store: storeApi,
          });
          if (result.saved && format !== 'pdf') showGlobalNotification('success', t('mindmap:export.success'));
        } catch (error: unknown) {
          console.error('Image export failed:', error);
          showGlobalNotification('error', t('mindmap:export.failed'));
        }
        return;
      }

      if (format === 'xmind') {
        try {
          const result = await exportToXmindFile(doc, filename);
          if (result.saved) showGlobalNotification('success', t('mindmap:shellV2.export.xmindDone'));
        } catch (error: unknown) {
          console.error('.xmind export failed:', error);
          showGlobalNotification('error', t('mindmap:export.failed'));
        }
        return;
      }

      const spec = TEXT_EXPORT_SPECS[format];
      if (!spec) return;
      try {
        const result = await fileManager.saveTextFile({
          title: t(spec.dialogKey),
          defaultFileName: filename + spec.ext,
          content: spec.serialize(doc),
          filters: [{ name: t(spec.filterKey), extensions: [spec.filterExt] }],
        });
        if (!result.canceled) showGlobalNotification('success', t('mindmap:export.success'));
      } catch (error: unknown) {
        console.error('Export failed:', error);
        showGlobalNotification('error', t('mindmap:export.failed'));
      }
    },
    [switchView, t, storeApi],
  );

  // 命令式导入（Tauri 走原生文件选择器；WebUI 走隐藏 <input type="file"> 兜底）
  const importRequestRef = useRef(0);
  const webImportInputRef = useRef<HTMLInputElement | null>(null);

  const finalizeImportedDocument = useCallback(
    (
      imported: MindMapDocument,
      report: ReturnType<typeof createXmindImportReport>,
      initialDocument: MindMapDocument,
      isCurrent: () => boolean,
    ) => {
      if (!isCurrent()) return;
      const latest = storeApi.getState();
      if (latest.document !== initialDocument) {
        setShowImportConfirm(true);
        return;
      }
      latest.setDocument(imported);
      latest.setFocusedNodeId(imported.root.id);
      const importedTitle = imported.root.text?.trim();
      const targetMindmapId = resourceId ?? storeApi.getState().mindmapId;
      if (targetMindmapId) {
        void storeApi.getState().save().then(() => {
          if (importedTitle) {
            void dstu.rename(`/${targetMindmapId}`, importedTitle);
            onTitleChange?.(importedTitle);
          }
        }).catch((err) => {
          console.warn('[MindMapContentView] Auto-save after import failed:', err);
        });
      } else if (typeof dstu.create === 'function') {
        void Promise.resolve(
          dstu.create('/', {
            type: 'mindmap',
            name: importedTitle || t('mindmap:outline.untitled', { defaultValue: '导入的思维导图' }),
            content: JSON.stringify(imported),
          }),
        ).then((res) => {
          if (res?.ok && res.value?.id) {
            void storeApi.getState().loadMindMap(res.value.id, { preserveViewports: true });
            if (importedTitle) onTitleChange?.(importedTitle);
          }
        }).catch((err) => {
          console.warn('[MindMapContentView] VFS persist for imported mindmap failed:', err);
        });
      }
      const nodeCount = countTreeNodes(imported.root);
      const hasDropped = report.droppedImages > 0 || report.droppedSummaries > 0;
      if (hasDropped) {
        setImportReport({
          nodes: nodeCount,
          droppedImages: report.droppedImages,
          droppedSummaries: report.droppedSummaries,
        });
      }
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
    },
    [storeApi, t],
  );

  const reportImportError = useCallback(
    (error: unknown, isCurrent: () => boolean) => {
      if (!isCurrent()) return;
      console.error('[MindMapContentView] Import failed:', error);
      const message =
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : t('mindmap:import.failed');
      setImportError(message);
      showGlobalNotification('error', message);
    },
    [t],
  );

  const handleWebImportFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;

      const request = ++importRequestRef.current;
      const loadRequest = documentLoadRequestRef.current;
      const initialDocument = storeApi.getState().document;
      const isCurrent = () =>
        request === importRequestRef.current && loadRequest === documentLoadRequestRef.current;
      setImportError(null);
      setImportReport(null);
      setIsImporting(true);
      try {
        const report = createXmindImportReport();
        const lowerName = file.name.toLowerCase();
        const imported = lowerName.endsWith('.xmind')
          ? await importFromXmindZip(await file.arrayBuffer(), report)
          : await importFromFile(file);
        finalizeImportedDocument(imported, report, initialDocument, isCurrent);
      } catch (error: unknown) {
        reportImportError(error, isCurrent);
      } finally {
        if (request === importRequestRef.current) setIsImporting(false);
      }
    },
    [finalizeImportedDocument, reportImportError, storeApi],
  );

  const doImport = useCallback(async () => {
    setImportError(null);
    setImportReport(null);

    if (!isNativeFileDialogAvailable()) {
      const input = webImportInputRef.current;
      if (!input) {
        const msg = t('mindmap:import.failed');
        setImportError(msg);
        showGlobalNotification('error', msg);
        return;
      }
      input.value = '';
      input.click();
      return;
    }

    const request = ++importRequestRef.current;
    const loadRequest = documentLoadRequestRef.current;
    const initialDocument = storeApi.getState().document;
    const isCurrent = () =>
      request === importRequestRef.current && loadRequest === documentLoadRequestRef.current;
    try {
      const filePath = await fileManager.pickSingleFile({
        title: t('mindmap:import.dialogTitle'),
        filters: [
          { name: t('mindmap:import.filterName'), extensions: [...MINDMAP_IMPORT_EXTENSIONS] },
        ],
      });
      if (!filePath || !isCurrent()) return;
      setIsImporting(true);

      const report = createXmindImportReport();
      const lowerPath = filePath.toLowerCase();
      const imported = lowerPath.endsWith('.xmind')
        ? await importFromXmindZip(await TauriAPI.readFileAsBytes(filePath), report)
        : lowerPath.endsWith('.mmap')
          ? await importFromMmapZip(await TauriAPI.readFileAsBytes(filePath))
          : importMindMap(await fileManager.readTextFile(filePath), 'auto');
      finalizeImportedDocument(imported, report, initialDocument, isCurrent);
    } catch (error: unknown) {
      reportImportError(error, isCurrent);
    } finally {
      if (request === importRequestRef.current) setIsImporting(false);
    }
  }, [finalizeImportedDocument, reportImportError, storeApi, t]);

  const handleImport = useCallback(() => {
    if (storeApi.getState().isDirty) setShowImportConfirm(true);
    else void doImport();
  }, [doImport, storeApi]);

  const handleSaveAndImport = useCallback(async () => {
    const loadRequest = documentLoadRequestRef.current;
    setShowImportConfirm(false);
    let saved = false;
    try { saved = await storeApi.getState().save(); } catch { saved = false; }
    if (!saved || loadRequest !== documentLoadRequestRef.current) return;
    if (storeApi.getState().isDirty) setShowImportConfirm(true);
    else void doImport();
  }, [doImport, storeApi]);

  const handleStartAssociation = useCallback(() => {
    const state = storeApi.getState();
    if (!state.focusedNodeId && state.selection.length === 0) {
      showGlobalNotification('warning', t('mindmap:association.selectSource'));
      return;
    }
    switchView('mindmap');
    setAssociationModeRequest((request) => request + 1);
  }, [storeApi, switchView, t]);

  // 全局键盘快捷键（window capture）：IME 合成跳过 + Escape 内联编辑让位 + Spotlight 步进
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isActive === false || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const ui = shellUiRef.current;
      const inlineEditing = isInlineMindMapEditorActive(e.target);

      if (e.key === 'Escape') {
        // 1. 内联编辑器 / IME 合成中 → 放行
        if (inlineEditing) return;
        // 2. 页面存在打开的右键菜单 / Popover / 图片灯箱 → 放行交给对应浮层关闭
        if (hasOpenTransientOverlay(containerRef.current)) return;
        // 3–8. 严格按「顶部面板 → 覆盖子屏/历史/快捷键 → 导入横幅 → 搜索 → 背诵 → 演示」逐层关闭
        const closeAction =
          ui.activePanel === 'style' || ui.activePanel === 'structure'
            ? () => setActivePanel(null)
            : ui.overlayPanel !== null
              ? () => setOverlayPanel(null)
              : ui.showImportConfirm
                ? () => setShowImportConfirm(false)
                : ui.importError
                  ? () => setImportError(null)
                  : ui.importReport
                    ? () => setImportReport(null)
                    : ui.showSearch
                      ? handleCloseSearch
                      : ui.reciteMode
                        ? () => storeApi.getState().setReciteMode(false)
                        : ui.presentationMode
                          ? handleExitPresentation
                          : null;
        if (closeAction) {
          e.preventDefault();
          e.stopPropagation();
          closeAction();
        }
        return;
      }

      if (
        ui.presentationMode &&
        !inlineEditing &&
        !isEditableElement(e.target instanceof Element ? e.target : null) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        if (e.repeat) return;
        if (
          e.target instanceof Element &&
          e.target.closest('button, a, select, summary, [role="button"], [role="menuitem"]')
        ) {
          return;
        }
        if (e.key === 'ArrowRight' || e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          e.stopPropagation();
          setPresentationStepIndex((p) =>
            ui.firstLevelBranchCount === 0 ? -1 : Math.min(p + 1, ui.firstLevelBranchCount - 1),
          );
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          e.stopPropagation();
          setPresentationStepIndex((p) => Math.max(p - 1, -1));
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          e.stopPropagation();
          setPresentationStepIndex(-1);
          return;
        }
      }

      const isMod = e.ctrlKey || e.metaKey;
      const isTextInputContext = isEditableElement(e.target instanceof Element ? e.target : null);

      if (ui.currentView !== 'mindmap' && isMod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        const state = storeApi.getState();
        if (state.isDirty && !state.isSaving) void state.save();
        return;
      }

      if (ui.currentView !== 'mindmap' && !isTextInputContext) {
        if (isMod && e.key === 'z' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const state = storeApi.getState();
          if (state.canUndo()) state.undo();
          return;
        }
        if (isMod && (e.key === 'Z' || e.key === 'y')) {
          e.preventDefault();
          e.stopPropagation();
          const state = storeApi.getState();
          if (state.canRedo()) state.redo();
          return;
        }
      }

      if (isMod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (ui.showSearch) {
          const input = containerRef.current?.querySelector<HTMLInputElement>('.mm-search-input');
          input?.focus();
          input?.select();
        } else {
          setShowSearch(true);
        }
        return;
      }

      if (isMod && e.shiftKey && !e.altKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) {
        e.preventDefault();
        e.stopPropagation();
        const state = storeApi.getState();
        if (e.key === '[' || e.key === '{') state.collapseAll();
        else state.expandAll();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleCloseSearch, handleExitPresentation, isActive, storeApi]);

  // 卸载及页面隐藏/关闭时同步写入草稿并刷盘
  useEffect(() => () => {
    if (!discardedRef.current) storeApi.getState().saveDraftSync();
  }, [storeApi, discardedRef]);

  useEffect(() => {
    const flushPendingChanges = () => {
      if (discardedRef.current) return;
      const state = storeApi.getState();
      state.saveDraftSync();
      if (state.isDirty && !state.isSaving) void state.save();
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (storeApi.getState().isDirty) {
        flushPendingChanges();
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushPendingChanges();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', flushPendingChanges);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', flushPendingChanges);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [storeApi, discardedRef]);

  const activeContextValue = useMemo(
    () => ({ isActive: isActive !== false, resourceId: resourceId || null }),
    [isActive, resourceId],
  );

  useMindMapExcerptBridge({
    storeApi,
    kernel,
    resourceId,
    isActive: isActive !== false,
    autoExcerptEnabled,
    reciteMode,
    isLoading: isLoadingDoc,
  });

  useMindMapHandoutSync({ mindmapId: resourceId, isLoading: isLoadingDoc });

  const hasMobileSubview =
    overlayPanel === 'structure' || overlayPanel === 'style' || overlayPanel === 'more' || overlayPanel === 'shortcuts';

  return (
    <MindMapActiveContext.Provider value={activeContextValue}>
      <MindMapClipboardEffects />
      <MindMapSaveStateReporter onSaveStateChange={onSaveStateChange} />
      <div
        ref={containerRef}
        tabIndex={-1}
        data-view={currentView}
        style={mindmapThemeVars}
        className={cn(
          'flex h-full w-full mindmap-container',
          presentationMode && 'is-presentation',
          hasMobileSubview && 'has-mobile-subview',
          className,
        )}
      >
        <div className="mm-document-column relative flex min-w-0 flex-1 flex-col">
          <input
            ref={webImportInputRef}
            type="file"
            accept={MINDMAP_IMPORT_ACCEPT}
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="mm-webui-import-input"
            onChange={(e) => void handleWebImportFileChange(e)}
          />
          <MindMapToolbar
            currentView={normalizedView}
            activePanel={activePanel}
            onActivePanelChange={setActivePanel}
            showSearch={showSearch}
            onToggleSearch={handleToggleSearch}
            showMasteryOverlay={showMasteryOverlay}
            onToggleMasteryOverlay={handleToggleMasteryOverlay}
            onSwitchView={switchView}
            onEnterPresentation={handleEnterPresentation}
            onStartAssociation={handleStartAssociation}
            onOpenVersionHistory={() => setOverlayPanel('versions')}
            onImport={handleImport}
            onExport={(format) => void handleExport(format)}
            onOpenShortcutHelp={() => setOverlayPanel('shortcuts')}
            onOpenMobileMore={() => setOverlayPanel('more')}
          />

          <MindMapStatusBanners
            resourceId={resourceId}
            currentView={normalizedView}
            keymap={mindMapPreferences.keymap}
            isImporting={isImporting}
            importError={importError}
            importReport={importReport}
            showImportConfirm={showImportConfirm}
            showVersionHistory={overlayPanel === 'versions'}
            showShortcutHelp={overlayPanel === 'shortcuts'}
            onRetryImport={() => void doImport()}
            onDismissImportError={() => setImportError(null)}
            onDismissImportReport={() => setImportReport(null)}
            onSaveAndImport={() => void handleSaveAndImport()}
            onConfirmImport={() => { setShowImportConfirm(false); void doImport(); }}
            onCancelImportConfirm={() => setShowImportConfirm(false)}
            onCloseVersionHistory={() => setOverlayPanel(null)}
            onCloseShortcutHelp={() => setOverlayPanel(null)}
          />

          <div className="mm-content-stage flex-1 overflow-hidden relative flex flex-col bg-[var(--mm-bg)]">
            <MindMapFormatDock
              currentView={normalizedView}
              isCoarsePointer={isCoarsePointer}
              reciteMode={reciteMode}
              presentationMode={presentationMode}
            />

            <MindMapSearchBanner
              showSearch={showSearch}
              searchInput={searchInput}
              onSearchInputChange={setSearchInput}
              onCloseSearch={handleCloseSearch}
              presentationMode={presentationMode}
            />

            <div className="flex-1 min-w-0 min-h-0 relative">
              {isLoadingDoc ? (
                <div className="h-full w-full flex items-center justify-center text-sm text-[var(--mm-text-muted)]">
                  {t('mindmap:loading')}
                </div>
              ) : loadError ? (
                <div className="h-full w-full flex items-center justify-center p-6" role="alert">
                  <div className="max-w-md w-full rounded-lg border border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] p-5 text-center shadow-[var(--notes-popover-shadow)]">
                    <WarningCircle size={32} className="mx-auto mb-3 text-destructive" />
                    <p className="text-sm font-medium text-[var(--mm-text)] mb-2">{t('mindmap:loadFailed')}</p>
                    <p className="text-xs text-[var(--mm-text-muted)] break-words">{loadError}</p>
                    <DsButton
                      variant="ghost"
                      className="ds-btn mt-4 mx-auto [@media(pointer:coarse)]:!min-h-11"
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
                  showMasteryOverlay={showMasteryOverlay}
                  masteryStatusByNodeId={masteryStatusByNodeId}
                  onAiNodeAction={handleAiNodeAction}
                  presentationMode={presentationMode}
                  presentationBranchId={presentationBranchId}
                />
              )}
            </div>

            {presentationMode && (
              <MindMapPresentationHud
                stepIndex={clampedPresentationStep}
                onPrev={handlePresentationPrev}
                onNext={handlePresentationNext}
                onOverview={handlePresentationOverview}
                onExit={handleExitPresentation}
              />
            )}
          </div>

          <MindMapMobileSubviews
            resourceId={resourceId}
            currentView={normalizedView}
            keymap={mindMapPreferences.keymap}
            overlayPanel={overlayPanel}
            onOverlayPanelChange={setOverlayPanel}
            showMasteryOverlay={showMasteryOverlay}
            onOpenSearch={() => setShowSearch(true)}
            onEnterPresentation={handleEnterPresentation}
            onToggleMasteryOverlay={handleToggleMasteryOverlay}
            onStartAssociation={handleStartAssociation}
            onImport={handleImport}
            onExport={(format) => void handleExport(format)}
          />
        </div>

        {!presentationMode && stagingTrayOpen && !reciteMode && (
          <MindMapStagingTray className="max-md:absolute max-md:inset-0 max-md:w-full max-md:max-w-none max-md:z-overlay max-md:border-l-0" />
        )}
      </div>
    </MindMapActiveContext.Provider>
  );
};

/** 每个内容视图持有独立 store；resourceId 变更或错误边界重置时同步换新并销毁旧实例 */
export const MindMapContentView = forwardRef<MindMapContentViewHandle, MindMapContentViewProps>(
  (props, ref) => {
    const { t } = useTranslation(['mindmap']);
    const [errorNonce, setErrorNonce] = useState(0);
    const holderRef = useRef<{ resourceId: string | undefined; errorNonce: number; store: MindMapStoreApi } | null>(null);
    const pendingDestroyRef = useRef<MindMapStoreApi[]>([]);
    const discardedRef = useRef(false);

    if (
      !holderRef.current ||
      holderRef.current.resourceId !== props.resourceId ||
      holderRef.current.errorNonce !== errorNonce
    ) {
      if (holderRef.current) pendingDestroyRef.current.push(holderRef.current.store);
      holderRef.current = { resourceId: props.resourceId, errorNonce, store: createMindMapStore() };
      discardedRef.current = false;
    }

    const store = holderRef.current.store;

    useEffect(() => {
      if (pendingDestroyRef.current.length === 0) return;
      for (const staleStore of pendingDestroyRef.current.splice(0)) {
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
          if (controller) controller.switchView(view);
          else currentStore.getState().setCurrentView(view);
        },
      }),
      [],
    );

    const handleErrorReset = useCallback(() => setErrorNonce((nonce) => nonce + 1), []);

    return (
      <MindMapErrorBoundary onReset={handleErrorReset} fallbackMessage={t('mindmap:errorBoundary')}>
        <MindMapStoreContext.Provider value={store}>
          <MindMapContentViewInner
            key={`${props.resourceId ?? 'blank'}:${errorNonce}`}
            {...props}
            discardedRef={discardedRef}
          />
        </MindMapStoreContext.Provider>
      </MindMapErrorBoundary>
    );
  },
);

MindMapContentView.displayName = 'MindMapContentView';
