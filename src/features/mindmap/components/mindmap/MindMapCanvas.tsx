import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Controls,
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

import { useMindMapStore } from '../../store';
import { LayoutRegistry, StyleRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { DEFAULT_LAYOUT_CONFIG, REACTFLOW_CONFIG, ROOT_NODE_STYLE, calculateBaseNodeHeight } from '../../constants';
import { nodeTypes as defaultNodeTypes } from './nodes';
import { edgeTypes as defaultEdgeTypes } from './edges';
import { useMindMapKeyboard } from '../../hooks/useMindMapKeyboard';
import { useMindMapIsActive } from '../../MindMapActiveContext';
import { CanvasContextMenu } from './CanvasContextMenu';
import { MindMapResourcePicker } from './MindMapResourcePicker';
import { findNodeById, findParentNode, isDescendantOf } from '../../utils/node/find';
import {
  resolveDropTarget,
  type DropMode,
  type DropCandidate,
} from '../../utils/dropTarget';
import {
  filterCompletedTree,
  resolveVisibleFocusId,
} from '../../utils/hideCompleted';
import { useTranslation } from 'react-i18next';
import { House } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { LayoutDirection, MindMapNode } from '../../types';
import type { ILayoutEngine } from '../../registry/types';
import { getAncestors } from '../../utils/node/traverse';

// 临时诊断开关：关闭所有与 hover 模糊相关的可疑动画/透明度联动。
const DISABLE_HOVER_BLUR_FACTORS = false;

/** 节点是否与画布视口有任何交集（屏幕坐标）。完全在外才返回 false。 */
function isNodeIntersectingViewport(
  flowToScreen: (pos: { x: number; y: number }) => { x: number; y: number },
  nodePos: { x: number; y: number },
  nodeWidth: number,
  nodeHeight: number,
  viewportRect: DOMRect,
): boolean {
  const { left, right, top, bottom } = getNodeScreenBounds(
    flowToScreen,
    nodePos,
    nodeWidth,
    nodeHeight,
  );
  return !(
    right < viewportRect.left ||
    left > viewportRect.right ||
    bottom < viewportRect.top ||
    top > viewportRect.bottom
  );
}

/** 节点是否完全落在视口内（新建/进入编辑时保证可见用）。 */
function isNodeFullyInViewport(
  flowToScreen: (pos: { x: number; y: number }) => { x: number; y: number },
  nodePos: { x: number; y: number },
  nodeWidth: number,
  nodeHeight: number,
  viewportRect: DOMRect,
  padding = 8,
): boolean {
  const { left, right, top, bottom } = getNodeScreenBounds(
    flowToScreen,
    nodePos,
    nodeWidth,
    nodeHeight,
  );
  return (
    left >= viewportRect.left + padding &&
    right <= viewportRect.right - padding &&
    top >= viewportRect.top + padding &&
    bottom <= viewportRect.bottom - padding
  );
}

function getNodeScreenBounds(
  flowToScreen: (pos: { x: number; y: number }) => { x: number; y: number },
  nodePos: { x: number; y: number },
  nodeWidth: number,
  nodeHeight: number,
) {
  const topLeft = flowToScreen(nodePos);
  const bottomRight = flowToScreen({
    x: nodePos.x + nodeWidth,
    y: nodePos.y + nodeHeight,
  });
  return {
    left: Math.min(topLeft.x, bottomRight.x),
    right: Math.max(topLeft.x, bottomRight.x),
    top: Math.min(topLeft.y, bottomRight.y),
    bottom: Math.max(topLeft.y, bottomRight.y),
  };
}

export interface MindMapCanvasHandle {
  getViewport: () => { x: number; y: number; zoom: number };
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
}

export interface MindMapCanvasProps {
  /** 从大纲切回时恢复的视口；有值则跳过初始 fitView，避免冲掉保真视口 */
  initialViewport?: { x: number; y: number; zoom: number } | null;
}

const MindMapCanvasInner = React.forwardRef<MindMapCanvasHandle, MindMapCanvasProps>(function MindMapCanvasInner(
  { initialViewport = null },
  ref,
) {
  ensureInitialized();
  const { t } = useTranslation('mindmap');

  const document = useMindMapStore(s => s.document);
  const hideCompleted = useMindMapStore(s => s.hideCompleted);
  const viewRootId = useMindMapStore(s => s.viewRootId);
  const setViewRootId = useMindMapStore(s => s.setViewRootId);
  const setFocusedNodeId = useMindMapStore(s => s.setFocusedNodeId);
  const focusedNodeId = useMindMapStore(s => s.focusedNodeId);
  const selection = useMindMapStore(s => s.selection);
  const agentEnteringIds = useMindMapStore(s => s.agentEnteringIds);
  /** ACR R2-02：driver 演出结束 requestAgentFitView → 一次 fitView（禁每 op） */
  const agentFitViewNonce = useMindMapStore(s => s.agentFitViewNonce);
  const setSelection = useMindMapStore(s => s.setSelection);
  const layoutId = useMindMapStore(s => s.layoutId);
  const layoutDirection = useMindMapStore(s => s.layoutDirection);
  const edgeType = useMindMapStore(s => s.edgeType);
  const styleId = useMindMapStore(s => s.styleId);
  const measuredNodeHeights = useMindMapStore(s => s.measuredNodeHeights);
  const reciteMode = useMindMapStore(s => s.reciteMode);
  // M-078: 导出时禁用虚拟化，确保所有节点都被渲染
  const isExporting = useMindMapStore(s => s.isExporting);
  const reactFlowInstance = useReactFlow();
  const { fitView, setCenter, getNodes, getZoom } = reactFlowInstance;
  // 有恢复视口时视为已 fit，避免挂载时 fitView 冲掉保真状态
  const hasFitView = useRef(!!initialViewport);
  const skipMountLayoutFitRef = useRef(!!initialViewport);
  // 有恢复视口时同步 seed，避免首帧 focus effect 在 setViewport 前 setCenter
  const prevFocusedNodeId = useRef<string | null>(
    initialViewport ? focusedNodeId : null,
  );
  const isCanvasActive = useMindMapIsActive();

  React.useImperativeHandle(ref, () => ({
    getViewport: () => reactFlowInstance.getViewport(),
    setViewport: (viewport) => {
      reactFlowInstance.setViewport(viewport, { duration: 0 });
    },
  }), [reactFlowInstance]);

  // 画布专属导航/编辑快捷键；剪贴板已上提到 MindMapContentView，大纲视图也可共用
  useMindMapKeyboard();

  // 隐藏已完成时，焦点若落在不可见节点则上移到可见祖先
  useEffect(() => {
    if (!hideCompleted || !focusedNodeId) return;
    const next = resolveVisibleFocusId(document.root, focusedNodeId, true);
    if (next && next !== focusedNodeId) {
      setFocusedNodeId(next);
    }
  }, [hideCompleted, focusedNodeId, document.root, setFocusedNodeId]);

  // 注册 ReactFlow 实例到 store，供图片导出使用
  const setReactFlowGetter = useMindMapStore(s => s.setReactFlowGetter);
  useEffect(() => {
    const getter = () => reactFlowInstance;
    setReactFlowGetter(getter);
    return () => setReactFlowGetter(null);
  }, [reactFlowInstance, setReactFlowGetter]);

  const addNodeRef = useMindMapStore(s => s.addNodeRef);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    nodeId: string | null;
  }>({ isOpen: false, position: { x: 0, y: 0 }, nodeId: null });

  const [resourcePickerNodeId, setResourcePickerNodeId] = useState<string | null>(null);

  const handleResourcePickerSelect = useCallback((ref: import('../../types').MindMapNodeRef) => {
    if (resourcePickerNodeId) {
      addNodeRef(resourcePickerNodeId, ref);
    }
  }, [resourcePickerNodeId, addNodeRef]);

  const handleResourcePickerClose = useCallback(() => {
    setResourcePickerNodeId(null);
  }, []);

  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<DropMode>('child');
  // 滞回读取用 ref，避免 onNodeDrag 闭包依赖 drop 状态导致重建
  const dropTargetIdRef = useRef<string | null>(null);
  const dropModeRef = useRef<DropMode>('child');
  const [isDragging, setIsDragging] = useState(false);
  const dragNodeIdRef = useRef<string | null>(null);
  const [dragPositionOverride, setDragPositionOverride] = useState<Record<string, { x: number; y: number }>>({});
  // rAF 合帧：mousemove 只写 pending，每帧最多一次 setState，避免 flushSync 卡顿
  const pendingDragOverrideRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const dragRafRef = useRef<number | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // 拖拽子树：记录所有后代节点相对于被拖节点的偏移
  const dragSubtreeOffsetsRef = useRef<Record<string, { dx: number; dy: number }>>({});
  const canvasContainerRef = useRef<HTMLDivElement>(null);

  const flushPendingDragOverride = useCallback(() => {
    dragRafRef.current = null;
    const pending = pendingDragOverrideRef.current;
    if (!pending) return;
    pendingDragOverrideRef.current = null;
    setDragPositionOverride(pending);
  }, []);

  const scheduleDragOverride = useCallback((next: Record<string, { x: number; y: number }>) => {
    pendingDragOverrideRef.current = next;
    if (dragRafRef.current != null) return;
    dragRafRef.current = requestAnimationFrame(flushPendingDragOverride);
  }, [flushPendingDragOverride]);

  const cancelPendingDragOverride = useCallback(() => {
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingDragOverrideRef.current = null;
  }, []);

  useEffect(() => () => cancelPendingDragOverride(), [cancelPendingDragOverride]);

  // 获取当前布局引擎
  const layoutEngine = useMemo<ILayoutEngine | undefined>(() => {
    const engine = LayoutRegistry.get(layoutId);
    if (!engine) {
      return LayoutRegistry.get('tree');
    }
    return engine;
  }, [layoutId]);

  // 使用注册系统获取布局引擎并计算布局
  const { nodes: layoutNodes, edges } = useMemo(() => {
    if (!document?.root) {
      return { nodes: [], edges: [] };
    }

    if (!layoutEngine) {
      console.warn(`Layout engine "${layoutId}" not found and no default available`);
      return { nodes: [], edges: [] };
    }

    // 确保方向有效
    const validDirection = layoutEngine.directions.includes(layoutDirection as LayoutDirection)
      ? layoutDirection
      : layoutEngine.defaultDirection;

    const theme = StyleRegistry.get(styleId) || StyleRegistry.getDefault();
    const layoutConfig = {
      ...DEFAULT_LAYOUT_CONFIG,
      direction: validDirection as LayoutDirection,
      nodeHeight: Math.max(
        DEFAULT_LAYOUT_CONFIG.nodeHeight,
        calculateBaseNodeHeight(theme?.node?.branch, 15, '6px 12px'),
        calculateBaseNodeHeight(theme?.node?.leaf, 14, '4px 8px')
      ),
      rootNodeHeight: Math.max(
        DEFAULT_LAYOUT_CONFIG.rootNodeHeight,
        calculateBaseNodeHeight(ROOT_NODE_STYLE, 18, '12px 24px')
      ),
      measuredNodeHeights,
    };

    let layoutRoot = document.root;
    if (viewRootId) {
      const focused = findNodeById(document.root, viewRootId);
      if (focused) layoutRoot = focused;
    }
    if (hideCompleted) {
      layoutRoot = filterCompletedTree(layoutRoot);
    }

    const layoutResult = layoutEngine.calculate(
      layoutRoot,
      layoutConfig,
      validDirection as LayoutDirection
    );

    // ============================================================================
    // 彩虹分支颜色已禁用——节点和连线统一使用主题默认色，避免视觉干扰

    return layoutResult;
  }, [document, hideCompleted, viewRootId, layoutId, layoutDirection, layoutEngine, styleId, measuredNodeHeights]);

  const breadcrumbPath = useMemo(() => {
    if (!viewRootId) return [] as MindMapNode[];
    const ancestors = getAncestors(document.root, viewRootId);
    const target = findNodeById(document.root, viewRootId);
    return target ? [...ancestors, target] : ancestors;
  }, [document.root, viewRootId]);

  // 动态合并节点组件（默认 + 布局引擎自定义）
  const nodeTypes = useMemo(() => {
    if (!layoutEngine?.customNodeTypes) {
      return defaultNodeTypes;
    }
    return {
      ...defaultNodeTypes,
      ...layoutEngine.customNodeTypes,
    };
  }, [layoutEngine]);

  // 动态合并边组件（默认 + 布局引擎自定义）
  const edgeTypes = useMemo(() => {
    if (!layoutEngine?.customEdgeTypes) {
      return defaultEdgeTypes;
    }
    return {
      ...defaultEdgeTypes,
      ...layoutEngine.customEdgeTypes,
    };
  }, [layoutEngine]);

  const openNodeContextMenu = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setContextMenu({
      isOpen: true,
      position,
      nodeId,
    });
    // 右键菜单不触发视角居中：提前同步 prevFocusedNodeId 使居中 effect 跳过
    prevFocusedNodeId.current = nodeId;
    setFocusedNodeId(nodeId);
    setSelection([nodeId]);
  }, [setFocusedNodeId, setSelection]);

  // layout data → 附带稳定 onOpenMenu 的 data；layout 对象引用不变时复用，避免选中变化击穿节点 memo
  const enrichedDataCacheRef = useRef(new WeakMap<object, Record<string, unknown>>());

  // 将 focusedNodeId 同步到节点的 selected 属性。
  // onOpenMenu 直接复用稳定的 openNodeContextMenu，避免每节点新建箭头。
  const nodes = useMemo(() => {
    const selectionSet = selection.length > 0 ? new Set(selection) : null;
    const cache = enrichedDataCacheRef.current;
    return layoutNodes.map(node => {
      const isBeingDragged = isDragging && node.id === dragNodeIdRef.current;
      const isSubtreeOfDragged = isDragging && node.id in dragSubtreeOffsetsRef.current;
      const isDropTarget = node.id === dropTargetId;
      let className: string | undefined;
      if (isDropTarget) {
        className =
          dropMode === 'child'
            ? 'mm-drop-target mm-drop-child'
            : dropMode === 'sibling-before'
              ? 'mm-drop-target mm-drop-sibling-before'
              : 'mm-drop-target mm-drop-sibling-after';
      } else if (isBeingDragged || isSubtreeOfDragged) {
        className = 'mm-dragging';
      }
      // ACR R1-11：Agent 入场动画（复用 nodeSlideIn）
      if (agentEnteringIds.has(node.id)) {
        className = className ? `${className} agent-entering` : 'agent-entering';
      }

      const posOverride = dragPositionOverride[node.id];
      const layoutData = node.data as object;
      let data = cache.get(layoutData);
      if (!data || data.onOpenMenu !== openNodeContextMenu) {
        data = { ...node.data, onOpenMenu: openNodeContextMenu };
        cache.set(layoutData, data);
      }

      return {
        ...node,
        ...(posOverride ? { position: posOverride } : {}),
        data,
        selected: selectionSet
          ? selectionSet.has(node.id)
          : node.id === focusedNodeId,
        // 拖拽期间后代节点不可单独拖拽
        draggable: node.id !== document.root.id && !isSubtreeOfDragged,
        className,
      };
    });
  }, [layoutNodes, focusedNodeId, selection, agentEnteringIds, document.root.id, dropTargetId, dropMode, isDragging, dragPositionOverride, openNodeContextMenu]);

  // 根据 edgeType 设置默认边选项
  const defaultEdgeType = useMemo(() => {
    // 映射边类型到实际使用的类型
    // smoothstep 是 ReactFlow 内置类型，直接使用
    const edgeTypeMap: Record<string, string> = {
      bezier: 'curved',
      curved: 'curved',
      straight: 'straight',
      orthogonal: 'orthogonal',
      step: 'step',
      smoothstep: 'smoothstep', // ReactFlow 内置的圆角阶梯边
    };
    return edgeTypeMap[edgeType] || 'curved';
  }, [edgeType]);

  const styledEdges = useMemo(() => {
    if (DISABLE_HOVER_BLUR_FACTORS || isExporting) {
      return edges.map(edge => ({
        ...edge,
        style: {
          ...edge.style,
          opacity: 1,
        },
      }));
    }

    if (!hoveredNodeId) return edges;
    return edges.map(edge => {
      const isConnected = edge.source === hoveredNodeId || edge.target === hoveredNodeId;
      if (isConnected) {
        return {
          ...edge,
          style: {
            ...edge.style,
            strokeWidth: 2.5,
            opacity: 1,
          },
          className: 'mm-edge-highlighted',
        };
      }
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: 0.25,
        },
      };
    });
  }, [edges, hoveredNodeId, isExporting]);

  // 切回导图：恢复上次视口；并 seed prevFocused，避免挂载 focus effect 冲掉视口
  useEffect(() => {
    if (!initialViewport) return;
    reactFlowInstance.setViewport(initialViewport, { duration: 0 });
    if (focusedNodeId) {
      prevFocusedNodeId.current = focusedNodeId;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载时恢复一次
  }, []);

  // 初始 fitView（修复: 添加 cleanup 防止内存泄漏）
  useEffect(() => {
    if (nodes.length === 0) return;
    if (!hasFitView.current) {
      hasFitView.current = true;
      const timer = setTimeout(() => {
        // 空间锚定：如果有 focusedNodeId，跳过初始 fitView，让后续的 setCenter effect 接管
        if (focusedNodeId) return;
        fitView({ padding: 0.2, duration: 0 });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [nodes.length, fitView, focusedNodeId]);

  // 当布局变化时重新适应视图（修复: 添加 cleanup 防止内存泄漏）
  useEffect(() => {
    // 视口保真挂载：跳过首次 layout effect，避免冲掉 setViewport
    if (skipMountLayoutFitRef.current) {
      skipMountLayoutFitRef.current = false;
      return;
    }
    if (nodes.length > 0 && hasFitView.current) {
      const timer = setTimeout(() => {
        // 空间锚定：如果有 focusedNodeId，跳过重新 fitView
        if (focusedNodeId) return;
        fitView({ padding: 0.2, duration: 300 });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [layoutId, layoutDirection, fitView, focusedNodeId]);

  /**
   * 轻量保证节点可见：不全图 fitView，仅必要时 setCenter。
   * - intersecting：与现有聚焦策略一致，仅完全在屏外才居中
   * - fully：新建/进入编辑时，部分裁切也居中，保证可编辑区域完整可见
   */
  const ensureNodeVisible = useCallback((
    nodeId: string,
    mode: 'intersecting' | 'fully' = 'intersecting',
  ) => {
    const targetNode = getNodes().find(n => n.id === nodeId);
    if (!targetNode) return;

    const nodeWidth = targetNode.measured?.width || targetNode.width || 100;
    const nodeHeight = targetNode.measured?.height || targetNode.height || 36;
    const viewportEl = canvasContainerRef.current;
    const viewportRect = viewportEl?.getBoundingClientRect();
    if (!viewportRect) return;

    const ok = mode === 'fully'
      ? isNodeFullyInViewport(
          reactFlowInstance.flowToScreenPosition,
          targetNode.position,
          nodeWidth,
          nodeHeight,
          viewportRect,
        )
      : isNodeIntersectingViewport(
          reactFlowInstance.flowToScreenPosition,
          targetNode.position,
          nodeWidth,
          nodeHeight,
          viewportRect,
        );

    if (ok) return;

    const centerX = targetNode.position.x + nodeWidth / 2;
    const centerY = targetNode.position.y + nodeHeight / 2;
    // 保持用户当前缩放，不再强制抬到 0.8（会破坏双模视口保真）
    setCenter(centerX, centerY, {
      zoom: getZoom(),
      duration: 250,
    });
  }, [getNodes, getZoom, setCenter, reactFlowInstance]);

  // 聚焦居中：仅当节点完全在视口外时才 setCenter。
  // 单击扫视可见节点不再拽视口；键盘导航 / 大纲切回 / 加载定位仍会在节点不可见时居中。
  // 双击编辑 / 右键菜单通过提前写 prevFocusedNodeId 跳过本 effect（勿破坏）。
  // 新建后的「保证完全可见」由下方 editingNodeId effect（fully 模式）负责。
  // ACR：agent 节流后的 setFocusedNodeId 同样走此路径（ensureNodeVisible，非 fitView）。
  useEffect(() => {
    if (
      focusedNodeId &&
      focusedNodeId !== prevFocusedNodeId.current
    ) {
      const timer = setTimeout(() => {
        ensureNodeVisible(focusedNodeId, 'intersecting');
        prevFocusedNodeId.current = focusedNodeId;
      }, 50);
      return () => clearTimeout(timer);
    }
    if (!focusedNodeId) {
      prevFocusedNodeId.current = null;
    }
  }, [focusedNodeId, ensureNodeVisible]);

  // ACR R2-02：批量演出结束一次 fitView（DESIGN §4.3 normal 档）
  const prevAgentFitViewNonce = useRef(agentFitViewNonce);
  useEffect(() => {
    if (agentFitViewNonce === prevAgentFitViewNonce.current) return;
    prevAgentFitViewNonce.current = agentFitViewNonce;
    if (agentFitViewNonce <= 0) return;
    const timer = setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 80);
    return () => clearTimeout(timer);
  }, [agentFitViewNonce, fitView]);

  const setEditingNodeId = useMindMapStore(s => s.setEditingNodeId);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const moveNode = useMindMapStore(s => s.moveNode);
  const editingNodeId = useMindMapStore(s => s.editingNodeId);

  // 进入编辑（含连续建点新建）：节点未完全在视口内时轻量居中，不 fitView。
  // 新建节点需等布局写入 ReactFlow，故短延迟 + 一次重试。
  useEffect(() => {
    if (!editingNodeId) return;
    let cancelled = false;
    const run = (attempt: number) => {
      if (cancelled) return;
      const exists = getNodes().some(n => n.id === editingNodeId);
      if (!exists && attempt < 1) {
        window.setTimeout(() => run(attempt + 1), 60);
        return;
      }
      ensureNodeVisible(editingNodeId, 'fully');
    };
    const timer = window.setTimeout(() => run(0), 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [editingNodeId, ensureNodeVisible, getNodes]);

  const onConnect = useCallback((connection: Connection) => {
    const sourceId = connection.source;
    const targetId = connection.target;
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }

    const targetNode = findNodeById(document.root, targetId);
    if (!targetNode) {
      return;
    }

    moveNode(sourceId, targetId, targetNode.children.length);
    setSelection([sourceId]);
    setFocusedNodeId(sourceId);
  }, [document.root, moveNode, setFocusedNodeId, setSelection]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const isMultiSelect = event.metaKey || event.ctrlKey || event.shiftKey;
    if (isMultiSelect) {
      setSelection(
        selection.includes(node.id)
          ? selection.filter(id => id !== node.id)
          : [...selection, node.id]
      );
    } else {
      setSelection([node.id]);
    }
    setFocusedNodeId(node.id);
  }, [selection, setFocusedNodeId, setSelection]);

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (reciteMode) {
      // 背诵模式下双击不进入编辑
      return;
    }
    // 提前同步 prevFocusedNodeId，阻止居中 effect 触发动画。
    // 进入编辑会导致节点尺寸微变 → 布局重算 → 节点位置更新，
    // 如果此时居中动画正在进行，会被打断后重启导致严重卡顿。
    prevFocusedNodeId.current = node.id;
    setSelection([node.id]);
    setFocusedNodeId(node.id);
    setEditingNodeId(node.id);
  }, [setEditingNodeId, setFocusedNodeId, setSelection, reciteMode]);

  const onPaneClick = useCallback(() => {
    setFocusedNodeId(null);
    setSelection([]);
    setEditingNodeId(null);
    setEditingNoteNodeId(null);
    setContextMenu(prev => ({ ...prev, isOpen: false }));
  }, [setFocusedNodeId, setSelection, setEditingNodeId, setEditingNoteNodeId]);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    if (DISABLE_HOVER_BLUR_FACTORS) return;
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    if (DISABLE_HOVER_BLUR_FACTORS) return;
    setHoveredNodeId(null);
  }, []);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    if (reciteMode) return; // 背诵模式下禁用右键菜单
    openNodeContextMenu(node.id, { x: event.clientX, y: event.clientY });
  }, [openNodeContextMenu, reciteMode]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id === document.root.id) return;
    // 拖拽选中不强制居中
    prevFocusedNodeId.current = node.id;
    setSelection([node.id]);
    setFocusedNodeId(node.id);
    dragNodeIdRef.current = node.id;
    dropTargetIdRef.current = null;
    dropModeRef.current = 'child';
    setDropTargetId(null);
    setDropMode('child');
    setIsDragging(true);

    // 收集所有后代节点的相对偏移，使子树跟随拖拽
    // ★ A6-25：先建 id→layoutNode 索引，避免每个后代各做一次 O(n) 的 allNodes.find
    const allNodes = getNodes();
    const layoutNodeById = new Map(allNodes.map(n => [n.id, n]));
    const offsets: Record<string, { dx: number; dy: number }> = {};
    const overrides: Record<string, { x: number; y: number }> = { [node.id]: node.position };

    const collectDescendants = (parentId: string) => {
      const mmNode = findNodeById(document.root, parentId);
      if (!mmNode?.children) return;
      for (const child of mmNode.children) {
        const layoutNode = layoutNodeById.get(child.id);
        if (layoutNode) {
          offsets[child.id] = {
            dx: layoutNode.position.x - node.position.x,
            dy: layoutNode.position.y - node.position.y,
          };
          overrides[child.id] = layoutNode.position;
        }
        collectDescendants(child.id);
      }
    };
    collectDescendants(node.id);

    dragSubtreeOffsetsRef.current = offsets;
    cancelPendingDragOverride();
    setDragPositionOverride(overrides);
  }, [document.root, setFocusedNodeId, setSelection, getNodes, cancelPendingDragOverride]);

  const onNodesChange = useCallback((_changes: NodeChange[]) => {
    // 位置同步由 onNodeDrag 处理，此处无需操作
  }, []);

  const onNodeDrag = useCallback((_: React.MouseEvent, draggedNode: Node) => {
    if (!dragNodeIdRef.current) return;
    const dragId = dragNodeIdRef.current;
    const dragPos = draggedNode.position;
    const offsets = dragSubtreeOffsetsRef.current;

    // rAF 合帧更新子树位置（去掉 flushSync，mousemove 不再同步强制渲染）
    const next: Record<string, { x: number; y: number }> = { [dragId]: dragPos };
    for (const [childId, offset] of Object.entries(offsets)) {
      next[childId] = { x: dragPos.x + offset.dx, y: dragPos.y + offset.dy };
    }
    scheduleDragOverride(next);

    // 寻找最近的放置目标（用最新 dragPos，不依赖 override 是否已 flush）
    const allNodes = getNodes();

    const dragW = draggedNode.measured?.width || 100;
    const dragH = draggedNode.measured?.height || 36;
    const dragCenterX = dragPos.x + dragW / 2;
    const dragCenterY = dragPos.y + dragH / 2;

    // ★ A6-25：每次 drag move 只算一次拖拽子树 id 集合（O(子树)），
    // 替代旧实现对每个候选节点调用 isDescendantOf（每个候选 O(全树)，整体 O(n²)，
    // 500+ 节点大图拖拽时每次 mousemove 高达数十万次节点访问，明显卡顿）。
    const dragSubtree = findNodeById(document.root, dragId);
    const dragSubtreeIds = new Set<string>();
    if (dragSubtree) {
      const stack: MindMapNode[] = [dragSubtree];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        dragSubtreeIds.add(cur.id);
        for (const child of cur.children) stack.push(child);
      }
    }

    const candidates: DropCandidate[] = [];
    for (const n of allNodes) {
      if (n.id === dragId) continue;
      if (n.id in offsets) continue; // 跳过子树节点（拖拽开始时快照）
      if (dragSubtreeIds.has(n.id)) continue; // 防御：拖拽中文档被外部更新时的新后代

      candidates.push({
        id: n.id,
        x: n.position.x,
        y: n.position.y,
        width: n.measured?.width || 100,
        height: n.measured?.height || 36,
      });
    }

    const resolved = resolveDropTarget({
      dragCenterX,
      dragCenterY,
      candidates,
      previousTargetId: dropTargetIdRef.current,
      previousMode: dropModeRef.current,
    });

    if (resolved.targetId !== dropTargetIdRef.current) {
      dropTargetIdRef.current = resolved.targetId;
      setDropTargetId(resolved.targetId);
    }
    if (resolved.targetId) {
      if (resolved.mode !== dropModeRef.current) {
        dropModeRef.current = resolved.mode;
        setDropMode(resolved.mode);
      }
    } else if (dropModeRef.current !== 'child') {
      dropModeRef.current = 'child';
      setDropMode('child');
    }
  }, [document.root, getNodes, scheduleDragOverride]);

  const onNodeDragStop = useCallback((_: React.MouseEvent, _draggedNode: Node) => {
    const draggedId = dragNodeIdRef.current;
    dragNodeIdRef.current = null;
    dragSubtreeOffsetsRef.current = {};
    cancelPendingDragOverride();
    setIsDragging(false);
    setDragPositionOverride({});

    // 用 ref 而非 React state，避免最后一帧滞回未 flush 时落到旧目标
    const finalTargetId = dropTargetIdRef.current;
    const finalMode = dropModeRef.current;

    if (draggedId && finalTargetId && draggedId !== finalTargetId) {
      if (!isDescendantOf(document.root, draggedId, finalTargetId)) {
        if (finalMode === 'child') {
          moveNode(draggedId, finalTargetId, 0);
        } else {
          const parent = findParentNode(document.root, finalTargetId);
          if (parent) {
            const idx = parent.children.findIndex(c => c.id === finalTargetId);
            const insertIdx = finalMode === 'sibling-before' ? idx : idx + 1;
            moveNode(draggedId, parent.id, insertIdx);
          } else {
            moveNode(draggedId, finalTargetId, 0);
          }
        }
      }
    }

    dropTargetIdRef.current = null;
    dropModeRef.current = 'child';
    setDropTargetId(null);
    setDropMode('child');
  }, [document.root, moveNode, cancelPendingDragOverride]);

  // Ctrl+0 / Cmd+0: 适应视图（注册在 document，stopPropagation 防止 global.zoom-reset 冲突）
  useEffect(() => {
    // ★ 标签页保活：非活跃实例不注册，防止隐藏标签页抢占快捷键
    if (!isCanvasActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;

      if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        fitView({ padding: 0.2, duration: 300 });
      }
    };

    // 使用 window.document 避免与组件内 MindMapDocument 变量 shadowing
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [fitView, isCanvasActive]);

  // ★ 移动端虚拟键盘：进入节点编辑后若节点位于键盘遮挡区，向上平移画布。
  // ReactFlow 画布不是文档流，浏览器不会自动滚动聚焦元素，需手动调整 viewport。
  useEffect(() => {
    if (!editingNodeId) return;
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const ensureAboveKeyboard = () => {
      const node = reactFlowInstance
        .getNodes()
        .find((n) => n.id === editingNodeId);
      if (!node) return;
      const center = {
        x: node.position.x + (node.measured?.width ?? 0) / 2,
        y: node.position.y + (node.measured?.height ?? 0) / 2,
      };
      const screen = reactFlowInstance.flowToScreenPosition(center);
      // visualViewport 高度已扣除键盘；节点低于可视区 55% 视为可能被遮挡
      if (screen.y > vv.height * 0.55) {
        const dy = screen.y - vv.height * 0.35;
        const vp = reactFlowInstance.getViewport();
        reactFlowInstance.setViewport({ ...vp, y: vp.y - dy }, { duration: 200 });
      }
    };

    // 键盘弹出会触发 visualViewport resize；进入编辑稍后也主动检查一次
    vv.addEventListener('resize', ensureAboveKeyboard);
    const timer = window.setTimeout(ensureAboveKeyboard, 350);
    return () => {
      vv.removeEventListener('resize', ensureAboveKeyboard);
      window.clearTimeout(timer);
    };
  }, [editingNodeId, reactFlowInstance]);

  return (
    <div
      ref={canvasContainerRef}
      className={`w-full h-full overflow-hidden bg-[var(--mm-bg)] relative ${DISABLE_HOVER_BLUR_FACTORS ? 'mm-blur-safety-mode' : ''} ${isExporting ? 'mm-exporting' : ''}`}
    >
      {breadcrumbPath.length > 1 && (
        <div className="mm-canvas-breadcrumb">
          <NotionButton
            variant="ghost"
            onClick={() => setViewRootId(null)}
            className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)]"
            title={t('outline.exitFocusMode')}
          >
            <House size={14} />
          </NotionButton>
          {breadcrumbPath.map((node, index) => (
            <React.Fragment key={node.id}>
              <span className="text-[var(--mm-text-muted)]">/</span>
              <NotionButton
                variant="ghost"
                onClick={() => setViewRootId(node.id)}
                className={cn(
                  "px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] truncate max-w-[100px]",
                  index === breadcrumbPath.length - 1
                    ? "text-[var(--mm-text)] font-medium"
                    : "",
                )}
              >
                {node.text || t('outline.untitled')}
              </NotionButton>
            </React.Fragment>
          ))}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        defaultEdgeOptions={{ type: defaultEdgeType }}
        fitView={!initialViewport}
        fitViewOptions={{ padding: REACTFLOW_CONFIG.fitViewPadding }}
        defaultViewport={initialViewport ?? undefined}
        minZoom={REACTFLOW_CONFIG.minZoom}
        maxZoom={REACTFLOW_CONFIG.maxZoom}
        nodesDraggable={!reciteMode}
        nodesConnectable={REACTFLOW_CONFIG.nodesConnectable}
        elementsSelectable={REACTFLOW_CONFIG.elementsSelectable}
        panOnScroll={REACTFLOW_CONFIG.panOnScroll}
        zoomOnScroll={REACTFLOW_CONFIG.zoomOnScroll}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={!isExporting}
      >
        <Controls
          showInteractive={false}
          className="mm-canvas-controls"
        />
        <MiniMap
          nodeColor={() => 'var(--mm-text-muted)'}
          nodeStrokeWidth={3}
          maskColor="hsl(var(--foreground) / 0.08)"
          style={{ width: 104, height: 68, backgroundColor: 'var(--mm-bg-elevated)' }}
          className="mm-canvas-minimap"
          pannable
          zoomable
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--mm-text-muted)"
          style={{ opacity: 0.3 }}
        />
      </ReactFlow>

      <CanvasContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        nodeId={contextMenu.nodeId}
        onClose={() => setContextMenu(prev => ({ ...prev, isOpen: false }))}
        onOpenResourcePicker={(nid) => setResourcePickerNodeId(nid)}
        onFocusBranch={(nid) => {
          setViewRootId(nid);
          requestAnimationFrame(() => {
            fitView({ padding: REACTFLOW_CONFIG.fitViewPadding, duration: 200 });
          });
        }}
      />
      <MindMapResourcePicker
        isOpen={!!resourcePickerNodeId}
        nodeId={resourcePickerNodeId || ''}
        existingRefs={resourcePickerNodeId ? findNodeById(document.root, resourcePickerNodeId)?.refs : undefined}
        onSelect={handleResourcePickerSelect}
        onClose={handleResourcePickerClose}
      />
    </div>
  );
});

export const MindMapCanvas = React.forwardRef<MindMapCanvasHandle, MindMapCanvasProps>(
  function MindMapCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <MindMapCanvasInner ref={ref} {...props} />
      </ReactFlowProvider>
    );
  },
);
