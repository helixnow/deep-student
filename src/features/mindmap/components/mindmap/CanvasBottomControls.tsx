import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Controls,
  ViewportPortal,
  type Node,
  type OnSelectionChangeParams,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  CornersOut,
  Hand,
  House,
  MouseScroll,
  Pencil,
  Plus,
  Selection,
  Trash,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { UiPresence } from '@/components/ui/UiPresence';
import { cn } from '@/utils/cn';
import { isMacOS } from '@/utils/platform';
import { prefersReducedMotion } from '@/styles/motion-springs';
import { normalizeMindMapViewport } from '../../utils/viewport';
import type { CanvasDragMode, CanvasWheelMode } from '../../hooks/useCanvasDragMode';
import type { IStyleTheme } from '../../registry/types';
import type { LayoutDirection, MindMapNode, MindMapSummaryBrace } from '../../types';
import type { MindMapStoreApi } from '../../store';
import type { DropPreviewRect } from '../../utils/dragLayoutPreview';
import type { ExcerptCanvasDropTarget } from './hooks/useCanvasExcerptDrop';
import { CanvasZoomIndicator } from './CanvasZoomIndicator';
import { CanvasShortcutHintPill } from './CanvasShortcutHintPill';
import { MobileNodeToolbar, type MobileToolbarPanel } from './MobileNodeToolbar';
import { SummaryBraceOverlay } from './SummaryBraceOverlay';

export interface UseCanvasTouchToolbarOptions {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  reactFlowInstance: ReactFlowInstance;
  storeApi: MindMapStoreApi;
  isCanvasActive: boolean;
  isCoarsePointer: boolean;
  reciteMode: boolean;
  presentationMode?: boolean;
  associatingFromId: string | null;
  isDragging: boolean;
  focusedNodeId: string | null;
  selectionLength: number;
  editingNodeId: string | null;
  editingNoteNodeId: string | null;
  prevFocusedNodeIdRef: React.MutableRefObject<string | null>;
}

/**
 * 触屏交互与底部工具条协调 Hook：
 * - 单指长按（450ms）打开底部节点工具条 + 吞掉紧随的 click
 * - 工具条出现时若遮挡节点则轻量上移视口
 * - 移动端虚拟键盘弹出时上移画布避免遮挡编辑节点
 */
export function useCanvasTouchToolbar({
  canvasContainerRef,
  reactFlowInstance,
  storeApi,
  isCanvasActive,
  isCoarsePointer,
  reciteMode,
  presentationMode = false,
  associatingFromId,
  isDragging,
  focusedNodeId,
  selectionLength,
  editingNodeId,
  editingNoteNodeId,
  prevFocusedNodeIdRef,
}: UseCanvasTouchToolbarOptions) {
  const [mobileToolbarPanel, setMobileToolbarPanel] = useState<MobileToolbarPanel>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const suppressNodeClickRef = useRef(false);
  const lastMobileToolbarNodeIdRef = useRef<string | null>(null);

  if (focusedNodeId) lastMobileToolbarNodeIdRef.current = focusedNodeId;

  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressOriginRef.current = null;
  }, []);

  useEffect(() => () => cancelLongPress(), [cancelLongPress]);

  const suppressNextNodeClick = useCallback(() => {
    suppressNodeClickRef.current = true;
    window.setTimeout(() => {
      suppressNodeClickRef.current = false;
    }, 350);
  }, []);

  const openMobileNodeActions = useCallback(
    (nodeId: string) => {
      prevFocusedNodeIdRef.current = nodeId;
      const state = storeApi.getState();
      state.setSelection([nodeId]);
      state.setFocusedNodeId(nodeId);
      setMobileToolbarPanel('more');
    },
    [prevFocusedNodeIdRef, storeApi],
  );

  const handleContainerTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isCoarsePointer || reciteMode || presentationMode || associatingFromId) return;
      if (e.touches.length !== 1) {
        cancelLongPress();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest?.('textarea, input, [contenteditable="true"]')) return;
      const nodeEl = target.closest?.('.react-flow__node');
      const nodeId = nodeEl?.getAttribute('data-id');
      if (!nodeId) return;
      const touch = e.touches[0];
      longPressOriginRef.current = { x: touch.clientX, y: touch.clientY };
      if (longPressTimerRef.current != null) window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        suppressNextNodeClick();
        openMobileNodeActions(nodeId);
      }, 450);
    },
    [
      isCoarsePointer,
      reciteMode,
      presentationMode,
      associatingFromId,
      cancelLongPress,
      suppressNextNodeClick,
      openMobileNodeActions,
    ],
  );

  const handleContainerTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const origin = longPressOriginRef.current;
      if (!origin || longPressTimerRef.current == null) return;
      const touch = e.touches[0];
      if (Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 10) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  const handleContainerTouchEnd = useCallback(() => {
    cancelLongPress();
  }, [cancelLongPress]);

  const showMobileToolbar =
    isCanvasActive &&
    isCoarsePointer &&
    !!focusedNodeId &&
    selectionLength <= 1 &&
    !editingNodeId &&
    !editingNoteNodeId &&
    !reciteMode &&
    !presentationMode &&
    !associatingFromId &&
    !isDragging;

  useEffect(() => {
    if (!showMobileToolbar) setMobileToolbarPanel(null);
  }, [showMobileToolbar]);

  // 底部工具条出现后若遮挡当前节点则仅上移必要距离
  useEffect(() => {
    if (!showMobileToolbar || !focusedNodeId) return;
    const frame = requestAnimationFrame(() => {
      const container = canvasContainerRef.current;
      const toolbar = container?.querySelector<HTMLElement>('.mm-mobile-node-toolbar');
      if (!container || !toolbar) return;
      const escaped =
        typeof CSS !== 'undefined' && CSS.escape
          ? CSS.escape(focusedNodeId)
          : focusedNodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const node = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`);
      if (!node) return;
      const nodeRect = node.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const overlap = nodeRect.bottom - (toolbarRect.top - 12);
      if (overlap <= 0) return;
      const viewport = reactFlowInstance.getViewport();
      void reactFlowInstance.setViewport(
        { ...viewport, y: viewport.y - overlap },
        { duration: prefersReducedMotion() ? 0 : 160 },
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [canvasContainerRef, focusedNodeId, mobileToolbarPanel, reactFlowInstance, showMobileToolbar]);

  // 移动端虚拟键盘弹出时上移画布避免遮挡编辑节点
  useEffect(() => {
    if (!editingNodeId) return;
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const ensureAboveKeyboard = () => {
      const node = reactFlowInstance.getNodes().find((n) => n.id === editingNodeId);
      if (!node) return;
      const center = {
        x: node.position.x + (node.measured?.width ?? 0) / 2,
        y: node.position.y + (node.measured?.height ?? 0) / 2,
      };
      const screen = reactFlowInstance.flowToScreenPosition(center);
      if (screen.y > vv.height * 0.55) {
        const dy = screen.y - vv.height * 0.35;
        const vp = reactFlowInstance.getViewport();
        reactFlowInstance.setViewport({ ...vp, y: vp.y - dy }, { duration: 200 });
      }
    };

    vv.addEventListener('resize', ensureAboveKeyboard);
    const timer = window.setTimeout(ensureAboveKeyboard, 350);
    return () => {
      vv.removeEventListener('resize', ensureAboveKeyboard);
      window.clearTimeout(timer);
    };
  }, [editingNodeId, reactFlowInstance]);

  const closeMobileToolbar = useCallback(() => {
    setMobileToolbarPanel(null);
    const state = storeApi.getState();
    state.setFocusedNodeId(null);
    state.setSelection([]);
  }, [storeApi]);

  return {
    mobileToolbarPanel,
    setMobileToolbarPanel,
    showMobileToolbar,
    lastMobileToolbarNodeIdRef,
    suppressNodeClickRef,
    cancelLongPress,
    suppressNextNodeClick,
    openMobileNodeActions,
    handleContainerTouchStart,
    handleContainerTouchMove,
    handleContainerTouchEnd,
    closeMobileToolbar,
  };
}

/**
 * 画布级缩放快捷键 Hook：
 * - Mod+0：适应画布
 * - Mod+1：缩放到 100%
 * - Mod+= / Mod++：放大
 * - Mod+-：缩小
 * 严格跳过可编辑输入区与 IME 组合态（含 Safari/WKWebView compositionend 100ms 守卫）。
 */
export function useCanvasZoomShortcuts(params: {
  isCanvasActive: boolean;
  fitVisibleNodes: (duration: number, padding?: number) => boolean;
  reactFlowInstance: ReactFlowInstance;
  lastCompositionEndAtRef: React.MutableRefObject<number>;
}) {
  const { isCanvasActive, fitVisibleNodes, reactFlowInstance, lastCompositionEndAtRef } = params;
  useEffect(() => {
    if (!isCanvasActive) return;
    const handleZoomKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (Date.now() - lastCompositionEndAtRef.current < 100) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      const reduced = prefersReducedMotion();
      if (e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        fitVisibleNodes(reduced ? 0 : 300);
      } else if (e.key === '1') {
        e.preventDefault();
        e.stopPropagation();
        void reactFlowInstance.zoomTo(1, { duration: reduced ? 0 : 200 });
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        e.stopPropagation();
        void reactFlowInstance.zoomIn({ duration: reduced ? 0 : 180 });
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        e.stopPropagation();
        void reactFlowInstance.zoomOut({ duration: reduced ? 0 : 180 });
      }
    };
      window.document.addEventListener('keydown', handleZoomKeyDown, true);
    return () => window.document.removeEventListener('keydown', handleZoomKeyDown, true);
  }, [isCanvasActive, fitVisibleNodes, reactFlowInstance, lastCompositionEndAtRef]);
}

const EDIT_AUTO_ZOOM_THRESHOLD = 0.55;
const EDIT_AUTO_ZOOM_TARGET = 0.85;

/** 低缩放进入编辑自动拉近（< 0.55 时平滑拉近至 0.85 并居中，否则仅确保完全可见） */
export function useCanvasEditAutoZoom(params: {
  editingNodeId: string | null;
  isCanvasReady?: boolean;
  layoutNodeById?: ReadonlyMap<string, Node>;
  reactFlowInstance: ReactFlowInstance;
  ensureNodeVisible: (nodeId: string, mode?: 'intersecting' | 'fully') => void;
}) {
  const {
    editingNodeId,
    isCanvasReady = true,
    layoutNodeById,
    reactFlowInstance,
    ensureNodeVisible,
  } = params;
  const { getNodes, getZoom, setCenter } = reactFlowInstance;
  const layoutNodeByIdRef = useRef(layoutNodeById);
  layoutNodeByIdRef.current = layoutNodeById;

  useEffect(() => {
    if (!editingNodeId || !isCanvasReady) return;
    let cancelled = false;
    let retryTimer: number | null = null;
    const run = (attempt: number) => {
      if (cancelled) return;
      const layoutNode = layoutNodeByIdRef.current?.get(editingNodeId);
      const rfNode = getNodes().find((n) => n.id === editingNodeId);
      const targetNode = layoutNode ?? rfNode;
      if (!targetNode && attempt < 1) {
        retryTimer = window.setTimeout(() => run(attempt + 1), 60);
        return;
      }
      if (!targetNode) return;
      const currentZoom = normalizeMindMapViewport({ x: 0, y: 0, zoom: getZoom() })?.zoom ?? 1;
      if (currentZoom < EDIT_AUTO_ZOOM_THRESHOLD) {
        const position = layoutNode?.position ?? targetNode.position;
        const nodeWidth =
          rfNode?.measured?.width ||
          rfNode?.width ||
          targetNode.measured?.width ||
          targetNode.width ||
          100;
        const nodeHeight =
          rfNode?.measured?.height ||
          rfNode?.height ||
          targetNode.measured?.height ||
          targetNode.height ||
          36;
        setCenter(position.x + nodeWidth / 2, position.y + nodeHeight / 2, {
          zoom: EDIT_AUTO_ZOOM_TARGET,
          duration: prefersReducedMotion() ? 0 : 240,
        });
        return;
      }
      ensureNodeVisible(editingNodeId, 'fully');
    };
    const timer = window.setTimeout(() => run(0), 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
    };
  }, [editingNodeId, isCanvasReady, ensureNodeVisible, getNodes, getZoom, setCenter]);
}

/**
 * 解析画布容器内联主题 CSS 变量：
 * 除基础背景/边色外，当用户在亮色应用模式下显式选择 `dark` / `*-dark` 导图主题时，
 * 补充暗色文字、次级文字、边框与浮层底色令牌，避免亮暗令牌撕裂。
 */
export function buildCanvasThemeVars(
  activeTheme: IStyleTheme | undefined,
  isDark: boolean,
): React.CSSProperties {
  const vars: Record<string, string> = {};
  if (activeTheme?.canvas?.background) vars['--mm-bg'] = activeTheme.canvas.background;
  if (activeTheme?.edge?.stroke) vars['--mm-edge'] = activeTheme.edge.stroke;
  if (activeTheme?.edge?.strokeActive) vars['--mm-edge-active'] = activeTheme.edge.strokeActive;
  if (activeTheme?.node?.root) {
    const rootStyle = activeTheme.node.root;
    if (rootStyle.background) vars['--mm-root-bg'] = rootStyle.background;
    if (rootStyle.foreground) vars['--mm-root-fg'] = rootStyle.foreground;
    if (rootStyle.border) vars['--mm-root-border'] = rootStyle.border;
    if (rootStyle.shadow) vars['--mm-root-shadow'] = rootStyle.shadow;
  }
  if (activeTheme?.node?.branch) {
    const branchStyle = activeTheme.node.branch;
    if (branchStyle.background) vars['--mm-branch-bg'] = branchStyle.background;
    if (branchStyle.foreground) vars['--mm-branch-fg'] = branchStyle.foreground;
    if (branchStyle.border) vars['--mm-branch-border'] = branchStyle.border;
    if (branchStyle.shadow) vars['--mm-branch-shadow'] = branchStyle.shadow;
  }
  if (activeTheme?.node?.leaf?.foreground) {
    vars['--mm-leaf-fg'] = activeTheme.node.leaf.foreground;
  }
  const isExplicitDarkTheme =
    activeTheme?.id === 'dark' || Boolean(activeTheme?.id?.endsWith('-dark'));
  if (isExplicitDarkTheme && !isDark) {
    const text = activeTheme?.node?.branch?.foreground;
    const textSecondary = activeTheme?.node?.leaf?.foreground;
    const bgElevated = activeTheme?.node?.branch?.background;
    const border = activeTheme?.edge?.stroke;
    if (text) vars['--mm-text'] = text;
    if (textSecondary) {
      vars['--mm-text-secondary'] = textSecondary;
      vars['--mm-text-muted'] = `color-mix(in srgb, ${textSecondary} 82%, transparent)`;
    }
    if (border) {
      vars['--mm-border'] = border;
      if (text) vars['--mm-border-strong'] = `color-mix(in srgb, ${text} 28%, ${border})`;
    }
    if (bgElevated) {
      vars['--mm-bg-elevated'] = bgElevated;
      if (text) vars['--mm-bg-hover'] = `color-mix(in srgb, ${text} 10%, ${bgElevated})`;
    }
  }
  return vars as React.CSSProperties;
}

/**
 * Spotlight 分支演示模式镜头控制 Hook：
 * - 通过 ref 读取 spotlightActiveIds，避免演示中编辑文档引发重跑抢镜头；
 * - 聚焦分支时置 hasFitViewRef = true，避免与初始 fitView(0) 竞态；
 * - 仍在演示模式且分支从非空切回 null（全图总览）时平滑复位镜头。
 */
export function useCanvasSpotlightCamera(params: {
  presentationMode: boolean;
  presentationBranchId: string | null;
  isCanvasReady: boolean;
  spotlightActiveIds: Set<string> | null;
  nodesRef: React.MutableRefObject<Node[]>;
  hasFitViewRef: React.MutableRefObject<boolean>;
  fitView: ReactFlowInstance['fitView'];
  fitVisibleNodes: (duration: number, padding?: number) => boolean;
}) {
  const {
    presentationMode,
    presentationBranchId,
    isCanvasReady,
    spotlightActiveIds,
    nodesRef,
    hasFitViewRef,
    fitView,
    fitVisibleNodes,
  } = params;
  const spotlightActiveIdsRef = useRef(spotlightActiveIds);
  spotlightActiveIdsRef.current = spotlightActiveIds;
  const prevPresentationBranchIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevBranchId = prevPresentationBranchIdRef.current;
    if (!presentationMode) {
      prevPresentationBranchIdRef.current = null;
      return;
    }
    if (!isCanvasReady) return;

    prevPresentationBranchIdRef.current = presentationBranchId;
    if (!presentationBranchId) {
      if (prevBranchId !== null) {
        hasFitViewRef.current = true;
        const timer = window.setTimeout(() => {
          fitVisibleNodes(prefersReducedMotion() ? 0 : 320);
        }, 40);
        return () => window.clearTimeout(timer);
      }
      return;
    }

    const activeIds = spotlightActiveIdsRef.current;
    if (!activeIds) return;
    const activeBranchFlowNodes = nodesRef.current.filter((n) => activeIds.has(n.id));
    if (activeBranchFlowNodes.length === 0) return;
    hasFitViewRef.current = true;
    const timer = window.setTimeout(() => {
      void fitView({
        nodes: activeBranchFlowNodes,
        padding: 0.28,
        duration: prefersReducedMotion() ? 0 : 320,
        maxZoom: 1.25,
      });
    }, 40);
    return () => window.clearTimeout(timer);
  }, [
    presentationMode,
    presentationBranchId,
    isCanvasReady,
    fitView,
    fitVisibleNodes,
    nodesRef,
    hasFitViewRef,
  ]);
}

/** 画布容器可见性/尺寸就绪监测 + Safari/WKWebView compositionend 时间戳守卫 */
export function useCanvasReadiness(canvasContainerRef: React.RefObject<HTMLDivElement | null>) {
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [isNarrowContainer, setIsNarrowContainer] = useState(false);
  const lastCompositionEndAtRef = useRef(0);

  useEffect(() => {
    const onCompositionEnd = () => {
      lastCompositionEndAtRef.current = Date.now();
    };
    window.document.addEventListener('compositionend', onCompositionEnd, true);
    return () => window.document.removeEventListener('compositionend', onCompositionEnd, true);
  }, []);

  useEffect(() => {
    const element = canvasContainerRef.current;
    if (!element) return;
    const applySize = (width: number, height: number) => {
      setIsCanvasReady(
        window.document.visibilityState !== 'hidden' && width > 1 && height > 1,
      );
      setIsNarrowContainer(width > 0 && width < 700);
    };
    const measureFromDom = () => {
      if (window.document.visibilityState === 'hidden') {
        setIsCanvasReady(false);
        return;
      }
      const rect = element.getBoundingClientRect();
      applySize(rect.width, rect.height);
    };
    measureFromDom();
    let rafId = 0;
    const scheduleSize = (width: number, height: number) => {
      if (typeof requestAnimationFrame !== 'function') {
        applySize(width, height);
        return;
      }
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        applySize(width, height);
      });
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1];
            const box = entry?.borderBoxSize?.[0];
            if (box && Number.isFinite(box.inlineSize) && Number.isFinite(box.blockSize)) {
              scheduleSize(box.inlineSize, box.blockSize);
              return;
            }
            if (entry?.contentRect) {
              scheduleSize(entry.contentRect.width, entry.contentRect.height);
              return;
            }
            measureFromDom();
          });
    observer?.observe(element);
    window.document.addEventListener('visibilitychange', measureFromDom);
    if (!observer) {
      window.addEventListener('resize', measureFromDom);
    }
    return () => {
      if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.document.removeEventListener('visibilitychange', measureFromDom);
      if (!observer) {
        window.removeEventListener('resize', measureFromDom);
      }
    };
  }, [canvasContainerRef]);

  return { isCanvasReady, isNarrowContainer, lastCompositionEndAtRef };
}

/** 框选进行中：给 RF 选框元素挂实时选中数量徽标 */
export function useCanvasMarqueeBadge(params: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  selectionLength: number;
  associatingFromId: string | null;
  onClearSelectedAssociation: () => void;
  onMarqueeSelectionChangeRaw: (params: OnSelectionChangeParams) => void;
}) {
  const {
    canvasContainerRef,
    selectionLength,
    associatingFromId,
    onClearSelectedAssociation,
    onMarqueeSelectionChangeRaw,
  } = params;
  const [isMarqueeActive, setIsMarqueeActive] = useState(false);
  const isMarqueeActiveRef = useRef(false);

  const onSelectionStart = useCallback(() => {
    isMarqueeActiveRef.current = true;
    setIsMarqueeActive(true);
  }, []);

  const onSelectionEnd = useCallback(() => {
    queueMicrotask(() => {
      isMarqueeActiveRef.current = false;
      setIsMarqueeActive(false);
    });
  }, []);

  const onMarqueeSelectionChange = useCallback(
    (change: OnSelectionChangeParams) => {
      if (associatingFromId || !isMarqueeActiveRef.current) return;
      if (change.nodes.length > 0) onClearSelectedAssociation();
      onMarqueeSelectionChangeRaw(change);
    },
    [associatingFromId, onClearSelectedAssociation, onMarqueeSelectionChangeRaw],
  );

  useEffect(() => {
    if (!isMarqueeActive) return;
    const selectionEl = canvasContainerRef.current?.querySelector<HTMLElement>(
      '.react-flow__selection',
    );
    if (!selectionEl) return;
    if (selectionLength > 0) {
      selectionEl.setAttribute('data-mm-selection-count', String(selectionLength));
    } else {
      selectionEl.removeAttribute('data-mm-selection-count');
    }
  }, [canvasContainerRef, isMarqueeActive, selectionLength]);

  return { onSelectionStart, onSelectionEnd, onMarqueeSelectionChange };
}

/** 右键菜单状态（宿主失活/离开视口自动收起 + 右键平移防误弹） */
export function useCanvasContextMenuState(params: {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  isCanvasActive: boolean;
  reciteMode: boolean;
  isCoarsePointer: boolean;
}) {
  const { canvasContainerRef, isCanvasActive, reciteMode, isCoarsePointer } = params;
  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    nodeId: string | null;
    associationId: string | null;
    pane: boolean;
  }>({ isOpen: false, position: { x: 0, y: 0 }, nodeId: null, associationId: null, pane: false });
  const rightButtonDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
  }, []);

  useEffect(() => {
    if (!contextMenu.isOpen) return undefined;
    if (!isCanvasActive) {
      closeContextMenu();
      return undefined;
    }
    const container = canvasContainerRef.current;
    if (!container) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry && !entry.isIntersecting) closeContextMenu();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [canvasContainerRef, closeContextMenu, contextMenu.isOpen, isCanvasActive]);

  const handleContainerMouseDownCapture = useCallback((event: React.MouseEvent) => {
    if (event.button === 2) {
      rightButtonDownPosRef.current = { x: event.clientX, y: event.clientY };
    }
  }, []);

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      if (reciteMode || isCoarsePointer) return;
      const downPos = rightButtonDownPosRef.current;
      rightButtonDownPosRef.current = null;
      if (downPos && Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y) > 5) return;
      setContextMenu({
        isOpen: true,
        position: { x: event.clientX, y: event.clientY },
        nodeId: null,
        associationId: null,
        pane: true,
      });
    },
    [reciteMode, isCoarsePointer],
  );

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    handleContainerMouseDownCapture,
    onPaneContextMenu,
  };
}

export interface CanvasTopBannersProps {
  breadcrumbPath: MindMapNode[];
  onSetViewRootId: (id: string | null) => void;
  associatingFromId: string | null;
  isCoarsePointer: boolean;
  onClearAssociationMode: () => void;
}

/** 画布顶部浮层条：分支聚焦面包屑 + 关联线创建提示 */
export const CanvasTopBanners: React.FC<CanvasTopBannersProps> = ({
  breadcrumbPath,
  onSetViewRootId,
  associatingFromId,
  isCoarsePointer,
  onClearAssociationMode,
}) => {
  const { t } = useTranslation('mindmap');
  return (
    <>
      {breadcrumbPath.length > 1 && (
        <div className="mm-canvas-breadcrumb">
          <DsButton
            variant="ghost"
            onClick={() => onSetViewRootId(null)}
            className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
            title={t('outline.exitFocusMode')}
          >
            <House size={14} />
          </DsButton>
          {breadcrumbPath.map((node, index) => (
            <React.Fragment key={node.id}>
              <span className="text-[var(--mm-text-muted)]">/</span>
              <DsButton
                variant="ghost"
                onClick={() => onSetViewRootId(node.id)}
                className={cn(
                  'px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] truncate max-w-[100px] [@media(pointer:coarse)]:!min-h-11',
                  index === breadcrumbPath.length - 1 ? 'text-[var(--mm-text)] font-medium' : '',
                )}
              >
                {node.text || t('outline.untitled')}
              </DsButton>
            </React.Fragment>
          ))}
        </div>
      )}
      {associatingFromId && (
        <div className="mm-association-hint" role="status">
          <span>{t('association.pickTarget', { defaultValue: '点击目标节点' })}</span>
          {isCoarsePointer ? (
            <DsButton
              variant="ghost"
              className="mm-association-cancel"
              onClick={onClearAssociationMode}
            >
              {t('association.cancel', { defaultValue: '取消' })}
            </DsButton>
          ) : (
            <kbd>Esc</kbd>
          )}
        </div>
      )}
    </>
  );
};

export interface CanvasViewportPortalsProps {
  dropPreview: DropPreviewRect | null;
  isDragging: boolean;
  dragCount: number;
  dragNodeId: string | null;
  dragPositionOverride: Record<string, { x: number; y: number }>;
  dragNodeSize: { width: number; height: number };
  summaries?: readonly MindMapSummaryBrace[];
  root: MindMapNode;
  layoutNodeById: Map<string, Node>;
  layoutDirection: LayoutDirection;
  readonlySummary: boolean;
  onUpdateSummaryLabel: (id: string, label: string) => void;
  onRemoveSummary: (id: string) => void;
  excerptDropTarget: ExcerptCanvasDropTarget | null;
  associatingFromId: string | null;
  associationSourceCenter: { x: number; y: number } | null;
  associationPointer: { x: number; y: number } | null;
}

/** 画布 ViewportPortal 叠加层（拖拽预览线/角标、概括括号、摘录幽灵胶囊、关联线预览） */
export const CanvasViewportPortals: React.FC<CanvasViewportPortalsProps> = ({
  dropPreview,
  isDragging,
  dragCount,
  dragNodeId,
  dragPositionOverride,
  dragNodeSize,
  summaries,
  root,
  layoutNodeById,
  layoutDirection,
  readonlySummary,
  onUpdateSummaryLabel,
  onRemoveSummary,
  excerptDropTarget,
  associatingFromId,
  associationSourceCenter,
  associationPointer,
}) => {
  const draggedPos = dragNodeId ? dragPositionOverride[dragNodeId] : undefined;
  return (
    <>
      {(dropPreview || (isDragging && dragCount > 1)) && (
        <ViewportPortal>
          {dropPreview && (
            <div
              className={cn(
                'mm-drop-insert-line',
                dropPreview.axis === 'h'
                  ? 'mm-drop-insert-line--h'
                  : 'mm-drop-insert-line--v',
                dropPreview.kind === 'child-link' && 'mm-drop-insert-line--child-link',
              )}
              style={{
                left: dropPreview.left,
                top: dropPreview.top,
                width: dropPreview.width,
                height: dropPreview.height,
              }}
            />
          )}
          {isDragging && dragCount > 1 && draggedPos && (
            <span
              className="mm-canvas-drag-count-badge"
              style={{
                left: draggedPos.x + dragNodeSize.width,
                top: draggedPos.y,
              }}
            >
              {dragCount}
            </span>
          )}
        </ViewportPortal>
      )}
      {summaries && summaries.length > 0 && (
        <ViewportPortal>
          <SummaryBraceOverlay
            summaries={summaries}
            root={root}
            layoutNodeById={layoutNodeById}
            direction={layoutDirection}
            readonly={readonlySummary}
            onUpdateLabel={onUpdateSummaryLabel}
            onRemove={onRemoveSummary}
          />
        </ViewportPortal>
      )}
      {excerptDropTarget?.kind === 'pane' && (
        <ViewportPortal>
          <div
            className="mm-mn5-drop-branch-ghost"
            style={{ left: excerptDropTarget.flowX, top: excerptDropTarget.flowY }}
            aria-hidden="true"
          />
        </ViewportPortal>
      )}
      {associatingFromId && associationSourceCenter && associationPointer && (
        <ViewportPortal>
          <svg
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: 1,
              height: 1,
              overflow: 'visible',
              pointerEvents: 'none',
            }}
          >
            <line
              className="mm-association-preview-line"
              x1={associationSourceCenter.x}
              y1={associationSourceCenter.y}
              x2={associationPointer.x}
              y2={associationPointer.y}
            />
          </svg>
        </ViewportPortal>
      )}
    </>
  );
};

export interface CanvasBottomControlsProps {
  isCoarsePointer: boolean;
  reciteMode: boolean;
  presentationMode?: boolean;
  showMobileToolbar: boolean;
  dragMode: CanvasDragMode;
  setDragMode: (mode: CanvasDragMode) => void;
  wheelMode: CanvasWheelMode;
  setWheelMode: (mode: CanvasWheelMode) => void;
  onFitView: () => void;
  onAddTopic: () => void;
  onToggleShortcutHelp?: () => void;
}

/**
 * 画布内底部控制区（须渲染在 `<ReactFlow>` 子树内）：
 * - `<Controls>`（隐藏重复的 FitView，统一收敛到右侧控制胶囊）
 * - 触屏快捷栏 / 桌面端右下角模式切换 + 缩放指示 + 适应视图 / 左下角快捷键提示胶囊
 */
export const CanvasBottomControls: React.FC<CanvasBottomControlsProps> = ({
  isCoarsePointer,
  reciteMode,
  presentationMode = false,
  showMobileToolbar,
  dragMode,
  setDragMode,
  wheelMode,
  setWheelMode,
  onFitView,
  onAddTopic,
  onToggleShortcutHelp,
}) => {
  const { t } = useTranslation('mindmap');
  const fitShortcut = isMacOS() ? '⌘0' : 'Ctrl+0';

  return (
    <>
      <Controls
        showInteractive={false}
        showFitView={false}
        className="mm-canvas-controls"
      />
      {!presentationMode && isCoarsePointer && !reciteMode && !showMobileToolbar && (
        <div
          className="mm-canvas-touch-actions"
          role="group"
          aria-label={t('canvas.touchActions', { defaultValue: '画布快捷操作' })}
        >
          <DsButton
            variant="ghost"
            size="sm"
            className="mm-canvas-touch-button"
            onClick={onFitView}
            title={t('contextMenu.fitView', { defaultValue: '适应视图' })}
          >
            <CornersOut size={15} />
            <span>{t('contextMenu.fitView', { defaultValue: '适应视图' })}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            className="mm-canvas-touch-button"
            onClick={onAddTopic}
            title={t('contextMenu.addTopic', { defaultValue: '新建主题' })}
          >
            <Plus size={15} />
            <span>{t('contextMenu.addTopic', { defaultValue: '新建主题' })}</span>
          </DsButton>
          <span className="mm-canvas-mode-divider" aria-hidden="true" />
          <CanvasZoomIndicator />
        </div>
      )}
      {!presentationMode && !isCoarsePointer && (
        <div
          className="mm-canvas-mode-switch"
          role="group"
          aria-label={t('canvas.dragModeGroup', { defaultValue: '画布拖拽模式' })}
        >
          <DsButton
            variant="ghost"
            size="sm"
            className={cn('mm-canvas-mode-button', dragMode === 'select' && 'is-active')}
            onClick={() => setDragMode('select')}
            title={t('canvas.dragModeSelect', {
              defaultValue: '框选模式：拖拽空白框选（Space/中键/右键拖拽平移）',
            })}
            aria-pressed={dragMode === 'select'}
          >
            <Selection size={15} weight={dragMode === 'select' ? 'bold' : 'regular'} />
            <span>{t('canvas.selectMode', { defaultValue: '框选' })}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            className={cn('mm-canvas-mode-button', dragMode === 'pan' && 'is-active')}
            onClick={() => setDragMode('pan')}
            title={t('canvas.dragModePan', {
              defaultValue: '拖动画布模式：拖拽空白移动画布（Shift+拖拽框选）',
            })}
            aria-pressed={dragMode === 'pan'}
          >
            <Hand size={15} weight={dragMode === 'pan' ? 'fill' : 'regular'} />
            <span>{t('canvas.panMode', { defaultValue: '拖动画布' })}</span>
          </DsButton>
          <span className="mm-canvas-mode-divider" aria-hidden="true" />
          <DsButton
            variant="ghost"
            size="sm"
            className={cn(
              'mm-canvas-mode-button mm-canvas-wheel-toggle',
              wheelMode === 'zoom' && 'is-active',
            )}
            onClick={() => setWheelMode(wheelMode === 'zoom' ? 'pan' : 'zoom')}
            title={
              wheelMode === 'zoom'
                ? t('canvas.wheelModeZoom', {
                    defaultValue: '滚轮缩放（默认）：滚轮/双指滑动直接缩放；点击切换为双指平移',
                  })
                : t('canvas.wheelModePan', {
                    defaultValue:
                      '双指平移（已开启）：滚轮/双指滑动平移，捏合或 Cmd/Ctrl+滚轮缩放；点击切换为滚轮缩放',
                  })
            }
            aria-pressed={wheelMode === 'zoom'}
          >
            <MouseScroll size={15} weight={wheelMode === 'zoom' ? 'fill' : 'regular'} />
            <span>{t('canvas.wheelZoom', { defaultValue: '滚轮缩放' })}</span>
          </DsButton>
          <span className="mm-canvas-mode-divider" aria-hidden="true" />
          <CanvasZoomIndicator />
          <DsButton
            variant="ghost"
            size="sm"
            className="mm-canvas-mode-button !min-w-0 !px-1.5"
            onClick={onFitView}
            title={`${t('contextMenu.fitView', { defaultValue: '适应视图' })} (${fitShortcut})`}
            aria-label={t('contextMenu.fitView', { defaultValue: '适应视图' })}
          >
            <CornersOut size={14} />
          </DsButton>
        </div>
      )}
      {!presentationMode && !isCoarsePointer && (
        <CanvasShortcutHintPill
          reciteMode={reciteMode}
          onOpenShortcuts={onToggleShortcutHelp}
        />
      )}
    </>
  );
};

export interface CanvasMobileToolbarsProps {
  isCoarsePointer: boolean;
  reciteMode: boolean;
  selectedAssociationId: string | null;
  editingAssociationId: string | null;
  lastAssociationIdRef: React.MutableRefObject<string | null>;
  onEditAssociationLabel: (id: string | null) => void;
  onDeleteAssociation: (id: string) => void;
  onClearSelectedAssociation: () => void;
  showMobileToolbar: boolean;
  focusedNodeId: string | null;
  lastMobileToolbarNodeIdRef: React.MutableRefObject<string | null>;
  mobileToolbarPanel: MobileToolbarPanel;
  onMobileToolbarPanelChange: (panel: MobileToolbarPanel) => void;
  onCloseMobileToolbar: () => void;
  onOpenResourcePicker: (nodeId: string) => void;
  onStartAssociation: (nodeId: string) => void;
  onFocusBranch: (nodeId: string) => void;
  excerptDropTarget: ExcerptCanvasDropTarget | null;
}

/** 触屏底部内联工具条组合 + 摘录投放提示条，渲染在 `<ReactFlow>` 外部 */
export const CanvasMobileToolbars: React.FC<CanvasMobileToolbarsProps> = ({
  isCoarsePointer,
  reciteMode,
  selectedAssociationId,
  editingAssociationId,
  lastAssociationIdRef,
  onEditAssociationLabel,
  onDeleteAssociation,
  onClearSelectedAssociation,
  showMobileToolbar,
  focusedNodeId,
  lastMobileToolbarNodeIdRef,
  mobileToolbarPanel,
  onMobileToolbarPanelChange,
  onCloseMobileToolbar,
  onOpenResourcePicker,
  onStartAssociation,
  onFocusBranch,
  excerptDropTarget,
}) => {
  const { t } = useTranslation('mindmap');
  const activeMobileNodeId = focusedNodeId ?? lastMobileToolbarNodeIdRef.current;

  return (
    <>
      {excerptDropTarget && (
        <div className="mm-mn5-drop-hint" role="status" data-testid="mm-excerpt-drop-hint">
          <span className="mm-mn5-drop-hint-dot" aria-hidden="true" />
          <span>
            {excerptDropTarget.kind === 'pane'
              ? t('mn5.dropNewBranchHint')
              : excerptDropTarget.merge
                ? t('mn5.dropMergeHint')
                : t('mn5.dropAsChildHint')}
          </span>
        </div>
      )}

      {isCoarsePointer && !reciteMode && (
        <UiPresence
          open={Boolean(selectedAssociationId && !editingAssociationId)}
          inClass=""
          outClass=""
          exitMs={150}
        >
          <div
            className="mm-mobile-node-toolbar"
            role="toolbar"
            aria-label={t('association.menuLabel', { defaultValue: '关联线菜单' })}
          >
            <div className="mm-mobile-toolbar-row">
              <DsButton
                variant="ghost"
                className="mm-mobile-toolbar-btn"
                onClick={() =>
                  onEditAssociationLabel(selectedAssociationId ?? lastAssociationIdRef.current)
                }
              >
                <Pencil size={18} />
                <span>{t('association.editLabel', { defaultValue: '编辑标签' })}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="mm-mobile-toolbar-btn destructive"
                onClick={() => {
                  const id = selectedAssociationId ?? lastAssociationIdRef.current;
                  if (!id) return;
                  onDeleteAssociation(id);
                }}
              >
                <Trash size={18} />
                <span>{t('association.delete', { defaultValue: '删除关联线' })}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                className="mm-mobile-toolbar-btn"
                onClick={onClearSelectedAssociation}
                aria-label={t('association.closeActions', { defaultValue: '关闭操作栏' })}
              >
                <X size={18} />
                <span>{t('association.closeActions', { defaultValue: '关闭' })}</span>
              </DsButton>
            </div>
          </div>
        </UiPresence>
      )}

      <UiPresence
        open={Boolean(showMobileToolbar && focusedNodeId)}
        inClass=""
        outClass=""
        exitMs={150}
      >
        {activeMobileNodeId ? (
          <MobileNodeToolbar
            nodeId={activeMobileNodeId}
            panel={mobileToolbarPanel}
            onPanelChange={onMobileToolbarPanelChange}
            onClose={onCloseMobileToolbar}
            onOpenResourcePicker={onOpenResourcePicker}
            onStartAssociation={onStartAssociation}
            onFocusBranch={onFocusBranch}
          />
        ) : null}
      </UiPresence>
    </>
  );
};
