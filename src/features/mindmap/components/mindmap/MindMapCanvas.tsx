import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  MiniMap,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  Node,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';

import { useMindMapStore, useMindMapStoreApi } from '../../store';
import { LayoutRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { REACTFLOW_CONFIG, calculateBaseNodeHeight } from '../../constants';
import { WHEEL_MODE_PAN_PROPS, WHEEL_MODE_ZOOM_PROPS } from '../../constants/layout';
import { nodeTypes as defaultNodeTypes } from './nodes';
import { edgeTypes as defaultEdgeTypes } from './edges';
import './edges/associationEdge.css';
import { useMindMapKeyboard } from '../../hooks/useMindMapKeyboard';
import {
  MindMapThemeContext,
  useMindMapDarkMode,
  useMindMapTheme,
  useStableCanvasThemeContext,
} from '../../hooks/useMindMapTheme';
import { useAnimatedNodes } from '../../hooks/useAnimatedNodes';
import { computeLayoutNodesBounds, useProgressiveLargeGraph } from '../../hooks/useProgressiveLargeGraph';
import { useMarqueeSelection } from '../../hooks/useMarqueeSelection';
import { useCanvasDragMode, useCanvasWheelMode } from '../../hooks/useCanvasDragMode';
import { useMomentumPan } from '../../hooks/useMomentumPan';
import {
  useViewportFollowContainerResize,
  type FollowViewport,
} from '../../hooks/useViewportFollowContainerResize';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { CanvasContextMenu } from './CanvasContextMenu';
import {
  buildCanvasThemeVars,
  CanvasBottomControls,
  CanvasMobileToolbars,
  CanvasTopBanners,
  CanvasViewportPortals,
  useCanvasContextMenuState,
  useCanvasEditAutoZoom,
  useCanvasMarqueeBadge,
  useCanvasReadiness,
  useCanvasSpotlightCamera,
  useCanvasTouchToolbar,
  useCanvasZoomShortcuts,
} from './CanvasBottomControls';
import { MindMapResourcePicker } from './MindMapResourcePicker';
import {
  useCanvasNodeDrag,
  enrichCanvasNodes,
  applyDragPositionOverrides,
  captureRfNodeDimensions,
} from './hooks/useCanvasNodeDrag';
import { useCanvasAssociationMode } from './hooks/useCanvasAssociationMode';
import {
  useCanvasExcerptDrop,
  useCanvasCameraRequests,
  isNodeIntersectingViewport,
  isNodeFullyInViewport,
} from './hooks/useCanvasExcerptDrop';
import {
  useCanvasHoverPath,
  computeCanvasLayout,
  computeNodeSpawnOrigin,
  buildMinimapBranchColorMap,
  computeAncestorPathEdgeKeys,
  computeBranchIndexMap,
  computeSpotlightActiveIds,
  buildStyledCanvasEdges,
} from './hooks/useCanvasHoverPath';
import { prefersReducedMotion } from '@/styles/motion-springs';
import { cn } from '@/utils/cn';
import { findNodeById } from '../../utils/node/find';
import { getAncestors } from '../../utils/node/traverse';
import { resolveVisibleFocusId } from '../../utils/hideCompleted';
import { DEFAULT_MINDMAP_VIEWPORT, normalizeMindMapViewport } from '../../utils/viewport';
import type { LayoutDirection, MindMapNode, MindMapNodeRef } from '../../types';
import type { ILayoutEngine } from '../../registry/types';
import '../../styles/canvas-enhancements.css';
import '../../styles/canvas-interactions.css';
import '../../styles/mn5-excerpt.css';

const EDGE_TYPE_MAP: Record<string, string> = {
  bezier: 'curved',
  curved: 'curved',
  straight: 'straight',
  orthogonal: 'orthogonal',
  step: 'step',
  smoothstep: 'smoothstep',
};

export interface MindMapCanvasHandle {
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
}

export interface MindMapCanvasProps {
  /** 从大纲切回时恢复的视口；有值则跳过初始 fitView，避免冲掉保真视口 */
  initialViewport?: { x: number; y: number; zoom: number } | null;
  /** Increment to start an association from the focused/selected node. */
  associationModeRequest?: number;
  /** 打开/切换快捷键帮助面板 */
  onToggleShortcutHelp?: () => void;
  /** 是否开启 FSRS 掌握度热力叠加层 */
  showMasteryOverlay?: boolean;
  /** 各节点的 FSRS 掌握度状态（nodeId -> status） */
  masteryStatusByNodeId?: Readonly<Record<string, 'due' | 'struggling' | 'learning' | 'mastered'>>;
  /** 原生画布 AI 节点操作回调（透传给 CanvasContextMenu） */
  onAiNodeAction?: (action: 'expand' | 'summarize' | 'cloze' | 'ask', nodeId: string) => void;
  /** 演示模式：是否处于 Spotlight 分支演示模式 */
  presentationMode?: boolean;
  /** 演示模式当前聚焦的一级分支节点 ID（高亮该分支并淡化其他分支、居中镜头） */
  presentationBranchId?: string | null;
}

const MindMapCanvasInner = React.forwardRef<MindMapCanvasHandle, MindMapCanvasProps>(
  function MindMapCanvasInner(
    {
      initialViewport = null,
      associationModeRequest = 0,
      onToggleShortcutHelp,
      showMasteryOverlay = false,
      masteryStatusByNodeId,
      onAiNodeAction,
      presentationMode = false,
      presentationBranchId = null,
    },
    ref,
  ) {
    ensureInitialized();
    const { t } = useTranslation('mindmap');

    const document = useMindMapStore((s) => s.document);
    const hideCompleted = useMindMapStore((s) => s.hideCompleted);
    const viewRootId = useMindMapStore((s) => s.viewRootId);
    const focusedNodeId = useMindMapStore((s) => s.focusedNodeId);
    const selection = useMindMapStore((s) => s.selection);
    const agentEnteringIds = useMindMapStore((s) => s.agentEnteringIds);
    const agentExitingIds = useMindMapStore((s) => s.agentExitingIds);
    const agentUpdatedIds = useMindMapStore((s) => s.agentUpdatedIds);
    const layoutId = useMindMapStore((s) => s.layoutId);
    const layoutDirection = useMindMapStore((s) => s.layoutDirection);
    const edgeType = useMindMapStore((s) => s.edgeType);
    const styleId = useMindMapStore((s) => s.styleId);
    const measuredNodeHeights = useMindMapStore((s) => s.measuredNodeHeights);
    const reciteMode = useMindMapStore((s) => s.reciteMode);
    const isExporting = useMindMapStore((s) => s.isExporting);
    const editingNodeId = useMindMapStore((s) => s.editingNodeId);
    const editingNoteNodeId = useMindMapStore((s) => s.editingNoteNodeId);
    const storeApi = useMindMapStoreApi();

    const activeTheme = useMindMapTheme(styleId);
    const isDark = useMindMapDarkMode();
    const isExplicitDarkTheme =
      activeTheme?.id === 'dark' || Boolean(activeTheme?.id?.endsWith('-dark'));
    const isDarkTheme = isDark || isExplicitDarkTheme;

    const isCoarsePointer = useCoarsePointer();
    const [dragMode, setDragMode] = useCanvasDragMode();
    const [wheelMode, setWheelMode] = useCanvasWheelMode();
    const wheelProps = wheelMode === 'zoom' ? WHEEL_MODE_ZOOM_PROPS : WHEEL_MODE_PAN_PROPS;
    const marqueeProps = useMarqueeSelection(storeApi, {
      variant: isCoarsePointer || dragMode === 'pan' ? 'conservative' : 'aggressive',
    });

    const reactFlowInstance = useReactFlow();
    const { fitView, setCenter, getNodes, getZoom } = reactFlowInstance;
    const safeInitialViewport = useMemo(
      () => normalizeMindMapViewport(initialViewport),
      [initialViewport],
    );
    const momentumPan = useMomentumPan(reactFlowInstance, { enabled: !isExporting });
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const { isCanvasReady, isNarrowContainer, lastCompositionEndAtRef } = useCanvasReadiness(canvasContainerRef);
    const autoFitViewportRef = useRef<FollowViewport | null>(null);
    const hasFitView = useRef(!!safeInitialViewport);
    const skipMountLayoutFitRef = useRef(!!safeInitialViewport);
    const prevFocusedNodeId = useRef<string | null>(
      safeInitialViewport ? focusedNodeId : null,
    );
    const isCanvasActive = useMindMapIsActive();

    const fitVisibleNodes = useCallback(
      (duration: number, padding = 0.2): boolean => {
        const rect = canvasContainerRef.current?.getBoundingClientRect();
        if (
          !isCanvasReady ||
          window.document.visibilityState === 'hidden' ||
          !rect ||
          rect.width <= 1 ||
          rect.height <= 1
        ) {
          return false;
        }
        autoFitViewportRef.current = null;
        const visibleNodeCount = reactFlowInstance.getNodes().length;
        const readableMinZoom = visibleNodeCount > 60 ? 0.45 : 0.25;
        void Promise.resolve(fitView({ padding, duration, minZoom: readableMinZoom, maxZoom: 1 })).then((fitted) => {
          if (fitted) {
            autoFitViewportRef.current = normalizeMindMapViewport(reactFlowInstance.getViewport());
          }
        });
        return true;
      },
      [fitView, isCanvasReady, reactFlowInstance],
    );

    React.useImperativeHandle(
      ref,
      () => ({
        getViewport: () =>
          normalizeMindMapViewport(reactFlowInstance.getViewport()) ?? {
            ...DEFAULT_MINDMAP_VIEWPORT,
          },
        setViewport: (viewport) => {
          const safeViewport = normalizeMindMapViewport(viewport);
          if (safeViewport) reactFlowInstance.setViewport(safeViewport, { duration: 0 });
        },
      }),
      [reactFlowInstance],
    );

    useMindMapKeyboard({ containerRef: canvasContainerRef });
    useCanvasZoomShortcuts({
      isCanvasActive,
      fitVisibleNodes,
      reactFlowInstance,
      lastCompositionEndAtRef,
    });

    useEffect(() => {
      if (!hideCompleted || !focusedNodeId) return;
      const next = resolveVisibleFocusId(document.root, focusedNodeId, true);
      if (next && next !== focusedNodeId) storeApi.getState().setFocusedNodeId(next);
    }, [hideCompleted, focusedNodeId, document.root, storeApi]);

    useEffect(() => {
      const getter = () => reactFlowInstance;
      storeApi.getState().setReactFlowGetter(getter);
      return () => storeApi.getState().setReactFlowGetter(null);
    }, [reactFlowInstance, storeApi]);

    const {
      contextMenu,
      setContextMenu,
      closeContextMenu,
      handleContainerMouseDownCapture,
      onPaneContextMenu,
    } = useCanvasContextMenuState({
      canvasContainerRef,
      isCanvasActive,
      reciteMode,
      isCoarsePointer,
    });

    const [resourcePickerNodeId, setResourcePickerNodeId] = useState<string | null>(null);
    const handleResourcePickerSelect = useCallback(
      (nodeRef: MindMapNodeRef) => {
        if (resourcePickerNodeId) storeApi.getState().addNodeRef(resourcePickerNodeId, nodeRef);
      },
      [resourcePickerNodeId, storeApi],
    );
    const handleResourcePickerClose = useCallback(() => setResourcePickerNodeId(null), []);

    const layoutEngine = useMemo<ILayoutEngine | undefined>(
      () => LayoutRegistry.get(layoutId) ?? LayoutRegistry.get('tree'),
      [layoutId],
    );

    const effectiveLayoutDirection = useMemo<LayoutDirection>(() => {
      const direction = layoutDirection as LayoutDirection;
      if (!layoutEngine) return direction;
      return layoutEngine.directions.includes(direction)
        ? direction
        : layoutEngine.defaultDirection;
    }, [layoutEngine, layoutDirection]);

    const branchBaseHeight = calculateBaseNodeHeight(activeTheme?.node?.branch, 15, '6px 12px');
    const leafBaseHeight = calculateBaseNodeHeight(activeTheme?.node?.leaf, 14, '4px 8px');
    const unnamedNodeLabel = t('node.unnamed');

    const { nodes: layoutNodes, edges } = useMemo(
      () =>
        computeCanvasLayout({
          root: document?.root,
          viewRootId,
          hideCompleted,
          layoutId,
          layoutDirection,
          layoutEngine,
          branchBaseHeight,
          leafBaseHeight,
          measuredNodeHeights,
          unnamedNodeLabel,
        }),
      [
        document?.root, hideCompleted, viewRootId, layoutId, layoutDirection,
        layoutEngine, branchBaseHeight, leafBaseHeight, measuredNodeHeights, unnamedNodeLabel,
      ],
    );

    const layoutNodeById = useMemo(
      () => new Map(layoutNodes.map((n) => [n.id, n])),
      [layoutNodes],
    );

    const breadcrumbPath = useMemo(() => {
      if (!viewRootId) return [] as MindMapNode[];
      const ancestors = getAncestors(document.root, viewRootId);
      const target = findNodeById(document.root, viewRootId);
      return target ? [...ancestors, target] : ancestors;
    }, [document.root, viewRootId]);

    const branchIndexById = useMemo(
      () => computeBranchIndexMap(document.root, viewRootId),
      [document.root, viewRootId],
    );

    const spotlightActiveIds = useMemo(
      () =>
        computeSpotlightActiveIds(document.root, viewRootId, presentationMode, presentationBranchId),
      [document.root, viewRootId, presentationMode, presentationBranchId],
    );

    const effectiveRootId = useMemo(
      () => (viewRootId && findNodeById(document.root, viewRootId) ? viewRootId : document.root.id),
      [document.root, viewRootId],
    );

    const openAssociationContextMenu = useCallback(
      (associationId: string, position: { x: number; y: number }) => {
        setContextMenu({ isOpen: true, position, nodeId: null, associationId, pane: false });
        const state = storeApi.getState();
        state.setFocusedNodeId(null);
        state.setSelection([]);
      },
      [setContextMenu, storeApi],
    );

    // 模块化 Hook 2：关联线模式与选中/编辑态（先声明，供拖拽 disabled 复用）
    const assoc = useCanvasAssociationMode({
      canvasContainerRef,
      reactFlowInstance,
      storeApi,
      layoutNodes,
      associations: document.associations,
      focusedNodeId,
      selection,
      associationModeRequest,
      isCanvasActive,
      reciteMode,
      openAssociationContextMenu,
      lastCompositionEndAtRef,
    });

    // 模块化 Hook 1：节点拖拽重排 / 重挂
    const drag = useCanvasNodeDrag({
      root: document.root,
      effectiveRootId,
      disabled: reciteMode || presentationMode || Boolean(assoc.associatingFromId),
      selection,
      effectiveLayoutDirection,
      getNodes,
      setSelection: storeApi.getState().setSelection,
      setFocusedNodeId: storeApi.getState().setFocusedNodeId,
      moveNodes: storeApi.getState().moveNodes,
      prevFocusedNodeIdRef: prevFocusedNodeId,
    });

    // 模块化 Hook 3：PDF/笔记摘录拖拽投放
    const excerpt = useCanvasExcerptDrop({
      canvasContainerRef,
      reactFlowInstance,
      storeApi,
      layoutDirection: effectiveLayoutDirection,
      layoutNodeById,
      reciteMode,
      isExporting,
      isCanvasReady,
      prevFocusedNodeIdRef: prevFocusedNodeId,
    });

    // 模块化 Hook 4：触屏交互与底部工具条
    const touch = useCanvasTouchToolbar({
      canvasContainerRef,
      reactFlowInstance,
      storeApi,
      isCanvasActive,
      isCoarsePointer,
      reciteMode,
      presentationMode,
      associatingFromId: assoc.associatingFromId,
      isDragging: drag.isDragging,
      focusedNodeId,
      selectionLength: selection.length,
      editingNodeId,
      editingNoteNodeId,
      prevFocusedNodeIdRef: prevFocusedNodeId,
    });

    const clearSelectedAssociation = useCallback(
      () => assoc.setSelectedAssociationId(null),
      [assoc.setSelectedAssociationId],
    );

    const { onSelectionStart, onSelectionEnd, onMarqueeSelectionChange } = useCanvasMarqueeBadge({
      canvasContainerRef,
      selectionLength: selection.length,
      associatingFromId: assoc.associatingFromId,
      onClearSelectedAssociation: clearSelectedAssociation,
      onMarqueeSelectionChangeRaw: marqueeProps.onSelectionChange,
    });

    const nodeTypes = useMemo(
      () =>
        layoutEngine?.customNodeTypes
          ? { ...defaultNodeTypes, ...layoutEngine.customNodeTypes }
          : defaultNodeTypes,
      [layoutEngine],
    );
    const edgeTypes = useMemo(
      () =>
        layoutEngine?.customEdgeTypes
          ? { ...defaultEdgeTypes, ...layoutEngine.customEdgeTypes }
          : defaultEdgeTypes,
      [layoutEngine],
    );

    // 右键菜单：若节点已在当前多选集（>1）内，保留多选以支持批量操作；否则切为单选
    const openNodeContextMenu = useCallback(
      (nodeId: string, position: { x: number; y: number }) => {
        setContextMenu({ isOpen: true, position, nodeId, associationId: null, pane: false });
        prevFocusedNodeId.current = nodeId;
        const state = storeApi.getState();
        state.setFocusedNodeId(nodeId);
        if (!(state.selection.length > 1 && state.selection.includes(nodeId))) {
          state.setSelection([nodeId]);
        }
        assoc.setSelectedAssociationId(null);
      },
      [setContextMenu, storeApi, assoc.setSelectedAssociationId],
    );

    const enrichedDataCacheRef = useRef(new WeakMap<object, Record<string, unknown>>());
    const rfMeasuredRef = useRef(new Map<string, { width: number; height: number }>());
    const prevEnrichedNodesRef = useRef<Map<string, Node>>(new Map());
    const prevMeasureScopeRef = useRef({ rootId: document.root.id, layoutDirection });
    if (
      prevMeasureScopeRef.current.rootId !== document.root.id ||
      prevMeasureScopeRef.current.layoutDirection !== layoutDirection
    ) {
      prevMeasureScopeRef.current = { rootId: document.root.id, layoutDirection };
      rfMeasuredRef.current.clear();
    }
    const excerptNodeTargetId =
      excerpt.excerptDropTarget?.kind === 'node' ? excerpt.excerptDropTarget.nodeId : null;
    const excerptNodeTargetMerge =
      excerpt.excerptDropTarget?.kind === 'node' && excerpt.excerptDropTarget.merge;

    const enrichedNodes = useMemo(() => {
      const next = enrichCanvasNodes({
        layoutNodes,
        rootId: effectiveRootId,
        focusedNodeId,
        selection,
        agentEnteringIds,
        agentExitingIds,
        agentUpdatedIds,
        isDragging: drag.isDragging,
        dragNodeId: drag.dragNodeIdRef.current,
        dragSubtreeOffsets: drag.dragSubtreeOffsetsRef.current,
        dropTargetId: drag.dropTargetId,
        dropMode: drag.dropMode,
        dropOrientation: drag.dropOrientation,
        excerptNodeTargetId,
        excerptNodeTargetMerge,
        spotlightActiveIds,
        branchIndexById,
        showMasteryOverlay,
        masteryStatusByNodeId,
        openNodeContextMenu,
        dataCache: enrichedDataCacheRef.current,
        measuredById: rfMeasuredRef.current,
        prevNodesById: prevEnrichedNodesRef.current,
      });
      const nextById = new Map<string, Node>();
      for (const n of next) nextById.set(n.id, n);
      prevEnrichedNodesRef.current = nextById;
      return next;
    }, [
      layoutNodes, effectiveRootId, focusedNodeId, selection,
      agentEnteringIds, agentExitingIds, agentUpdatedIds,
      drag.isDragging, drag.dragNodeIdRef, drag.dragSubtreeOffsetsRef,
      drag.dropTargetId, drag.dropMode, drag.dropOrientation,
      excerptNodeTargetId, excerptNodeTargetMerge, spotlightActiveIds,
      branchIndexById, showMasteryOverlay, masteryStatusByNodeId, openNodeContextMenu,
    ]);

    const nodes = useMemo(
      () => applyDragPositionOverrides(enrichedNodes, drag.dragPositionOverride),
      [enrichedNodes, drag.dragPositionOverride],
    );

    const parentIdByNodeId = useMemo(() => {
      const map = new Map<string, string>();
      for (const edge of edges) map.set(edge.target, edge.source);
      return map;
    }, [edges]);

    const getSpawnOrigin = useCallback(
      (node: Node) => computeNodeSpawnOrigin(node, parentIdByNodeId, layoutNodeById),
      [parentIdByNodeId, layoutNodeById],
    );

    const animatedNodes = useAnimatedNodes(nodes, {
      duration: 200,
      enabled: !drag.isDragging && nodes.length <= 120,
      getSpawnOrigin,
    });

    const defaultEdgeType = EDGE_TYPE_MAP[edgeType] || 'curved';

    const allEdges = useMemo(
      () => [
        ...edges.map((edge) => ({
          ...edge,
          selectable: false,
          data: { ...(edge.data as object | undefined), kind: 'tree' as const },
        })),
        ...assoc.associationEdges,
      ],
      [edges, assoc.associationEdges],
    );

    const ancestorPathEdgeKeys = useMemo(
      () => computeAncestorPathEdgeKeys(document.root, focusedNodeId),
      [document.root, focusedNodeId],
    );

    // 模块化 Hook 5：零 React 重渲染的悬停祖先路径高亮（直接操作 DOM 类名，0 styledEdges 重算）
    const { onNodeMouseEnter, onNodeMouseLeave } = useCanvasHoverPath({
      canvasContainerRef,
      root: document.root,
      edges,
      focusedNodeId,
      ancestorPathEdgeKeys,
      isCoarsePointer,
      isDragging: drag.isDragging,
    });

    const useBranchPalette = Boolean(activeTheme?.useBranchPalette);
    const effectiveEdgeDark = useBranchPalette && isDarkTheme;
    const styledEdges = useMemo(
      () =>
        buildStyledCanvasEdges({
          allEdges,
          layoutNodeById,
          ancestorPathEdgeKeys,
          focusedNodeId,
          useBranchPalette,
          branchIndexById,
          isDarkTheme: effectiveEdgeDark,
          spotlightActiveIds,
        }),
      [
        allEdges,
        layoutNodeById,
        ancestorPathEdgeKeys,
        focusedNodeId,
        useBranchPalette,
        branchIndexById,
        effectiveEdgeDark,
        spotlightActiveIds,
      ],
    );

    // MiniMap 分支着色：同步使用 activeTheme.palette（随暗色/主题即时切换）
    const minimapBranchColorById = useMemo(
      () => buildMinimapBranchColorMap(branchIndexById, activeTheme?.palette),
      [branchIndexById, activeTheme],
    );

    const minimapNodeColor = useCallback(
      (node: Node) =>
        node.selected ? 'var(--mm-primary)' : (minimapBranchColorById.get(node.id) ?? 'var(--mm-text-muted)'),
      [minimapBranchColorById],
    );

    // 切回导图：恢复上次视口；并 seed prevFocused，避免挂载 focus effect 冲掉视口
    useEffect(() => {
      if (!safeInitialViewport) return;
      reactFlowInstance.setViewport(safeInitialViewport, { duration: 0 });
      if (focusedNodeId) prevFocusedNodeId.current = focusedNodeId;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时恢复一次
    }, []);

    // 初始 fitView（大图渐进挂载完成后再精准适配全图边界；修复 cleanup 防内存泄漏）
    const isLargeGraph = layoutNodes.length > 120;
    const progressiveGraph = useProgressiveLargeGraph(animatedNodes, styledEdges, {
      enabled: !isExporting,
      resetKey: effectiveRootId,
    });

    useEffect(() => {
      if (nodes.length === 0 || !isCanvasReady || hasFitView.current) return;
      if (isLargeGraph && !progressiveGraph.isComplete) {
        const bounds = computeLayoutNodesBounds(layoutNodes);
        if (bounds) {
          void Promise.resolve(reactFlowInstance.fitBounds(bounds, { padding: 0.2, duration: 0 })).then(() => {
            autoFitViewportRef.current = normalizeMindMapViewport(reactFlowInstance.getViewport());
          });
          hasFitView.current = true;
        }
        return;
      }
      if (!progressiveGraph.isComplete) return;
      const timer = setTimeout(() => {
        if (!hasFitView.current && fitVisibleNodes(0)) hasFitView.current = true;
      }, 50);
      return () => clearTimeout(timer);
    }, [nodes.length, isCanvasReady, isLargeGraph, progressiveGraph.isComplete, layoutNodes, reactFlowInstance, fitVisibleNodes]);

    useViewportFollowContainerResize({
      containerRef: canvasContainerRef,
      autoFitViewportRef,
      enabled: isCanvasReady && nodes.length > 0 && !isExporting,
      adapter: {
        getViewport: () =>
          normalizeMindMapViewport(reactFlowInstance.getViewport()) ?? {
            ...DEFAULT_MINDMAP_VIEWPORT,
          },
        setViewport: (viewport) => {
          const safeViewport = normalizeMindMapViewport(viewport);
          if (safeViewport) void reactFlowInstance.setViewport(safeViewport, { duration: 0 });
        },
        refit: () => fitVisibleNodes(0),
      },
    });

    useEffect(() => {
      if (!isCanvasReady) return;
      if (!normalizeMindMapViewport(reactFlowInstance.getViewport())) {
        reactFlowInstance.setViewport(
          safeInitialViewport ?? { ...DEFAULT_MINDMAP_VIEWPORT },
          { duration: 0 },
        );
      }
    }, [isCanvasReady, reactFlowInstance, safeInitialViewport]);

    const ensureNodeVisible = useCallback(
      (nodeId: string, mode: 'intersecting' | 'fully' = 'intersecting') => {
        if (!isCanvasReady) return;
        const targetNode = getNodes().find((n) => n.id === nodeId);
        const viewportRect = canvasContainerRef.current?.getBoundingClientRect();
        if (!targetNode || !viewportRect || viewportRect.width <= 1 || viewportRect.height <= 1) {
          return;
        }
        const nodeWidth = targetNode.measured?.width || targetNode.width || 100;
        const nodeHeight = targetNode.measured?.height || targetNode.height || 36;
        const checker = mode === 'fully' ? isNodeFullyInViewport : isNodeIntersectingViewport;
        if (
          checker(
            reactFlowInstance.flowToScreenPosition,
            targetNode.position,
            nodeWidth,
            nodeHeight,
            viewportRect,
          )
        ) {
          return;
        }
        setCenter(targetNode.position.x + nodeWidth / 2, targetNode.position.y + nodeHeight / 2, {
          zoom: normalizeMindMapViewport({ x: 0, y: 0, zoom: getZoom() })?.zoom ?? 1,
          duration: prefersReducedMotion() ? 0 : 250,
        });
      },
      [getNodes, getZoom, isCanvasReady, setCenter, reactFlowInstance],
    );

    // 当布局变化时重新适应视图（修复: 添加 cleanup 防止内存泄漏）
    useEffect(() => {
      if (!isCanvasReady) return;
      if (skipMountLayoutFitRef.current) {
        skipMountLayoutFitRef.current = false;
        return;
      }
      if (nodes.length > 0 && hasFitView.current) {
        if (focusedNodeId) {
          const focusTimer = setTimeout(() => ensureNodeVisible(focusedNodeId, 'intersecting'), 260);
          return () => clearTimeout(focusTimer);
        }
        const timer = setTimeout(() => fitVisibleNodes(300), 50);
        return () => clearTimeout(timer);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅布局/方向/就绪时重跑
    }, [layoutId, layoutDirection, isCanvasReady, fitVisibleNodes, ensureNodeVisible]);

    // 聚焦居中：仅当节点完全在视口外时才 setCenter
    useEffect(() => {
      if (focusedNodeId && focusedNodeId !== prevFocusedNodeId.current) {
        const timer = setTimeout(() => {
          ensureNodeVisible(focusedNodeId, 'intersecting');
          prevFocusedNodeId.current = focusedNodeId;
        }, 50);
        return () => clearTimeout(timer);
      }
      if (!focusedNodeId) prevFocusedNodeId.current = null;
    }, [focusedNodeId, ensureNodeVisible]);

    // 引用回链定位与 Agent 批量演出结束镜头跟随
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;
    useCanvasCameraRequests({
      nodesRef,
      nodesLength: nodes.length,
      isCanvasReady,
      hasFitViewRef: hasFitView,
      prevFocusedNodeIdRef: prevFocusedNodeId,
      reactFlowInstance,
      fitVisibleNodes,
    });

    useCanvasSpotlightCamera({
      presentationMode,
      presentationBranchId,
      isCanvasReady,
      spotlightActiveIds,
      nodesRef,
      hasFitViewRef: hasFitView,
      fitView,
      fitVisibleNodes,
    });

    // 进入编辑：低缩放（< 0.55）自动平滑拉近至 0.85 并居中；否则确保完全可见
    useCanvasEditAutoZoom({
      editingNodeId,
      isCanvasReady,
      layoutNodeById,
      reactFlowInstance,
      ensureNodeVisible,
    });

    const onConnect = useCallback(
      (connection: Connection) => {
        const { source: sourceId, target: targetId } = connection;
        if (!sourceId || !targetId || sourceId === targetId) return;
        const targetNode = findNodeById(document.root, targetId);
        if (!targetNode) return;
        const state = storeApi.getState();
        state.moveNode(sourceId, targetId, targetNode.children.length);
        state.setSelection([sourceId]);
        state.setFocusedNodeId(sourceId);
      },
      [document.root, storeApi],
    );

    const onNodesChange = useCallback((changes: NodeChange[]) => {
      captureRfNodeDimensions(changes, rfMeasuredRef.current);
    }, []);

    const onNodeClick = useCallback(
      (event: React.MouseEvent, node: Node) => {
        if (touch.suppressNodeClickRef.current) {
          touch.suppressNodeClickRef.current = false;
          return;
        }
        const state = storeApi.getState();
        if (assoc.associatingFromId) {
          event.stopPropagation();
          if (node.id !== assoc.associatingFromId) {
            state.addAssociation(assoc.associatingFromId, node.id);
          }
          assoc.clearAssociationMode();
          assoc.setSelectedAssociationId(null);
          state.setSelection([node.id]);
          state.setFocusedNodeId(node.id);
          return;
        }

        assoc.setSelectedAssociationId(null);
        assoc.setEditingAssociationId(null);
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
          state.setSelection(
            selection.includes(node.id)
              ? selection.filter((id) => id !== node.id)
              : [...selection, node.id],
          );
          state.setFocusedNodeId(node.id);
          return;
        }

        if (isCoarsePointer && !reciteMode) {
          const wasSoleSelection =
            state.focusedNodeId === node.id &&
            state.selection.length === 1 &&
            state.selection[0] === node.id &&
            state.editingNodeId !== node.id;
          if (wasSoleSelection) {
            prevFocusedNodeId.current = node.id;
            state.setSelection([node.id]);
            state.setFocusedNodeId(node.id);
            state.setEditingNodeId(node.id);
            return;
          }
        }

        state.setSelection([node.id]);
        state.setFocusedNodeId(node.id);
      },
      [touch.suppressNodeClickRef, storeApi, assoc, selection, isCoarsePointer, reciteMode],
    );

    const onNodeDoubleClick = useCallback(
      (_: React.MouseEvent, node: Node) => {
        if (reciteMode) return;
        const state = storeApi.getState();
        if (state.editingNodeId === node.id) return;
        prevFocusedNodeId.current = node.id;
        state.setSelection([node.id]);
        state.setFocusedNodeId(node.id);
        state.setEditingNodeId(node.id);
      },
      [reciteMode, storeApi],
    );

    const onPaneClick = useCallback(() => {
      if (assoc.associatingFromId) {
        assoc.clearAssociationMode();
        return;
      }
      const state = storeApi.getState();
      state.setFocusedNodeId(null);
      state.setSelection([]);
      state.setEditingNodeId(null);
      state.setEditingNoteNodeId(null);
      assoc.setSelectedAssociationId(null);
      assoc.setEditingAssociationId(null);
      closeContextMenu();
    }, [assoc, closeContextMenu, storeApi]);

    const onNodeContextMenu = useCallback(
      (event: React.MouseEvent, node: Node) => {
        event.preventDefault();
        if (reciteMode) return;
        if (isCoarsePointer) {
          touch.cancelLongPress();
          touch.suppressNextNodeClick();
          touch.openMobileNodeActions(node.id);
          return;
        }
        openNodeContextMenu(node.id, { x: event.clientX, y: event.clientY });
      },
      [openNodeContextMenu, reciteMode, isCoarsePointer, touch],
    );

    const handleAddTopic = useCallback(() => {
      const state = storeApi.getState();
      const newId = state.addNode(effectiveRootId);
      if (newId) {
        state.setFocusedNodeId(newId);
        requestAnimationFrame(() => storeApi.getState().setEditingNodeId(newId));
      }
    }, [effectiveRootId, storeApi]);

    const handleFocusBranch = useCallback(
      (nid: string) => {
        storeApi.getState().setViewRootId(nid);
        requestAnimationFrame(() => fitVisibleNodes(200, REACTFLOW_CONFIG.fitViewPadding));
      },
      [storeApi, fitVisibleNodes],
    );

    const handleFitViewAnimated = useCallback(
      () => fitVisibleNodes(prefersReducedMotion() ? 0 : 300),
      [fitVisibleNodes],
    );

    const canvasThemeStyle = useMemo<React.CSSProperties>(
      () => buildCanvasThemeVars(activeTheme, isDark),
      [activeTheme, isDark],
    );

    const themeContextValue = useStableCanvasThemeContext(styleId, activeTheme, isDark, isLargeGraph);
    const hideNarrowLargeMiniMap = layoutNodes.length > 150 && isNarrowContainer;

    return (
      <div
        ref={canvasContainerRef}
        data-large-graph={isLargeGraph ? 'true' : undefined}
        style={canvasThemeStyle}
        className={cn(
          'w-full h-full overflow-hidden bg-[var(--mm-bg)] relative',
          isExporting && 'mm-exporting',
          presentationMode && 'mm-presentation-mode',
          !isCoarsePointer && (presentationMode ? 'mm-canvas-mode-pan' : `mm-canvas-mode-${dragMode}`),
          touch.showMobileToolbar && 'mm-has-mobile-toolbar',
          touch.showMobileToolbar && touch.mobileToolbarPanel && 'mm-has-mobile-toolbar-panel',
        )}
        onMouseDownCapture={handleContainerMouseDownCapture}
        onPointerDownCapture={momentumPan.cancelMomentum}
        onWheelCapture={momentumPan.cancelMomentum}
        onTouchStartCapture={touch.handleContainerTouchStart}
        onTouchMoveCapture={touch.handleContainerTouchMove}
        onTouchEndCapture={touch.handleContainerTouchEnd}
        onTouchCancelCapture={touch.handleContainerTouchEnd}
        onDragEnter={excerpt.handleExcerptDragEnter}
        onDragOver={excerpt.handleExcerptDragOver}
        onDragLeave={excerpt.handleExcerptDragLeave}
        onDrop={excerpt.handleExcerptDrop}
      >
        <CanvasTopBanners
          breadcrumbPath={breadcrumbPath}
          onSetViewRootId={(id) => storeApi.getState().setViewRootId(id)}
          associatingFromId={assoc.associatingFromId}
          isCoarsePointer={isCoarsePointer}
          onClearAssociationMode={assoc.clearAssociationMode}
        />

        <MindMapThemeContext.Provider value={themeContextValue}>
        <ReactFlow
          nodes={progressiveGraph.nodes}
          edges={progressiveGraph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          onPaneClick={onPaneClick}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onEdgeClick={assoc.onEdgeClick}
          onEdgeContextMenu={assoc.onEdgeContextMenu}
          onNodeDragStart={drag.onNodeDragStart}
          onNodeDrag={drag.onNodeDrag}
          onNodeDragStop={drag.onNodeDragStop}
          onConnect={onConnect}
          defaultEdgeOptions={{ type: defaultEdgeType }}
          fitView={false}
          fitViewOptions={{ padding: REACTFLOW_CONFIG.fitViewPadding }}
          defaultViewport={safeInitialViewport ?? DEFAULT_MINDMAP_VIEWPORT}
          minZoom={REACTFLOW_CONFIG.minZoom}
          maxZoom={REACTFLOW_CONFIG.maxZoom}
          nodeDragThreshold={REACTFLOW_CONFIG.nodeDragThreshold}
          nodesDraggable={!reciteMode && !presentationMode && !assoc.associatingFromId}
          nodesConnectable={REACTFLOW_CONFIG.nodesConnectable}
          elementsSelectable={REACTFLOW_CONFIG.elementsSelectable}
          edgesFocusable={!reciteMode}
          panOnScroll={wheelProps.panOnScroll}
          zoomOnScroll={wheelProps.zoomOnScroll}
          zoomOnPinch={REACTFLOW_CONFIG.zoomOnPinch}
          zoomActivationKeyCode={wheelProps.zoomActivationKeyCode}
          zoomOnDoubleClick={false}
          onMoveStart={momentumPan.onMoveStart}
          onMove={momentumPan.onMove}
          onMoveEnd={momentumPan.onMoveEnd}
          onSelectionStart={onSelectionStart}
          onSelectionEnd={onSelectionEnd}
          proOptions={{ hideAttribution: true }}
          onlyRenderVisibleElements={!isExporting}
          selectionOnDrag={!presentationMode && !assoc.associatingFromId && marqueeProps.selectionOnDrag}
          selectionMode={marqueeProps.selectionMode}
          panOnDrag={presentationMode ? true : marqueeProps.panOnDrag}
          selectionKeyCode={presentationMode || assoc.associatingFromId ? null : marqueeProps.selectionKeyCode}
          disableKeyboardA11y
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={presentationMode ? null : marqueeProps.panActivationKeyCode}
          onSelectionChange={onMarqueeSelectionChange}
        >
          <CanvasBottomControls
            isCoarsePointer={isCoarsePointer}
            reciteMode={reciteMode}
            presentationMode={presentationMode}
            showMobileToolbar={touch.showMobileToolbar}
            dragMode={dragMode}
            setDragMode={setDragMode}
            wheelMode={wheelMode}
            setWheelMode={setWheelMode}
            onFitView={handleFitViewAnimated}
            onAddTopic={handleAddTopic}
            onToggleShortcutHelp={onToggleShortcutHelp}
          />
          {!presentationMode && layoutNodes.length > 10 && !hideNarrowLargeMiniMap && progressiveGraph.isComplete && (
            <MiniMap
              nodeColor={minimapNodeColor}
              nodeStrokeWidth={3}
              maskColor="hsl(var(--foreground) / 0.08)"
              style={{ width: 104, height: 68 }}
              className="mm-canvas-minimap"
              pannable
              zoomable
            />
          )}
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="color-mix(in srgb, var(--mm-border) 55%, transparent)"
          />
          <CanvasViewportPortals
            dropPreview={drag.dropPreview}
            isDragging={drag.isDragging}
            dragCount={drag.dragCount}
            dragNodeId={drag.dragNodeIdRef.current}
            dragPositionOverride={drag.dragPositionOverride}
            dragNodeSize={drag.dragNodeSizeRef.current}
            summaries={document.summaries}
            root={document.root}
            layoutNodeById={layoutNodeById}
            layoutDirection={effectiveLayoutDirection}
            readonlySummary={reciteMode || isExporting}
            onUpdateSummaryLabel={storeApi.getState().updateSummaryBrace}
            onRemoveSummary={storeApi.getState().removeSummaryBrace}
            excerptDropTarget={excerpt.excerptDropTarget}
            associatingFromId={assoc.associatingFromId}
            associationSourceCenter={assoc.associationSourceCenter}
            associationPointer={assoc.associationPointer}
          />
        </ReactFlow>
        </MindMapThemeContext.Provider>

        <CanvasContextMenu
          isOpen={contextMenu.isOpen}
          position={contextMenu.position}
          nodeId={contextMenu.nodeId}
          associationId={contextMenu.associationId}
          paneMenu={contextMenu.pane}
          onFitView={handleFitViewAnimated}
          onExitFocusMode={viewRootId ? () => storeApi.getState().setViewRootId(null) : null}
          onClose={closeContextMenu}
          onOpenResourcePicker={(nid) => setResourcePickerNodeId(nid)}
          onFocusBranch={handleFocusBranch}
          onStartAssociation={assoc.handleStartAssociation}
          onEditAssociationLabel={assoc.handleEditAssociationLabel}
          onDeleteAssociation={assoc.handleDeleteAssociation}
          onAiNodeAction={onAiNodeAction}
        />
        <MindMapResourcePicker
          isOpen={!!resourcePickerNodeId}
          nodeId={resourcePickerNodeId || ''}
          existingRefs={
            resourcePickerNodeId
              ? findNodeById(document.root, resourcePickerNodeId)?.refs
              : undefined
          }
          onSelect={handleResourcePickerSelect}
          onClose={handleResourcePickerClose}
        />
        <CanvasMobileToolbars
          isCoarsePointer={isCoarsePointer}
          reciteMode={reciteMode}
          selectedAssociationId={assoc.selectedAssociationId}
          editingAssociationId={assoc.editingAssociationId}
          lastAssociationIdRef={assoc.lastAssociationIdRef}
          onEditAssociationLabel={(id) => assoc.setEditingAssociationId(id)}
          onDeleteAssociation={assoc.handleDeleteAssociation}
          onClearSelectedAssociation={clearSelectedAssociation}
          showMobileToolbar={touch.showMobileToolbar}
          focusedNodeId={focusedNodeId}
          lastMobileToolbarNodeIdRef={touch.lastMobileToolbarNodeIdRef}
          mobileToolbarPanel={touch.mobileToolbarPanel}
          onMobileToolbarPanelChange={touch.setMobileToolbarPanel}
          onCloseMobileToolbar={touch.closeMobileToolbar}
          onOpenResourcePicker={(nid) => setResourcePickerNodeId(nid)}
          onStartAssociation={assoc.handleStartAssociation}
          onFocusBranch={handleFocusBranch}
          excerptDropTarget={excerpt.excerptDropTarget}
        />
      </div>
    );
  },
);

export const MindMapCanvas = React.memo(
  React.forwardRef<MindMapCanvasHandle, MindMapCanvasProps>(
    function MindMapCanvas(props, ref) {
      return (
        <ReactFlowProvider>
          <MindMapCanvasInner ref={ref} {...props} />
        </ReactFlowProvider>
      );
    },
  ),
);
