import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Node, NodeChange, OnNodeDrag } from '@xyflow/react';
import type { LayoutDirection, MindMapNode } from '../../../types';
import { findNodeById, findParentNode, isDescendantOf } from '../../../utils/node/find';
import {
  resolveDropTarget,
  dropOrientationForDirection,
  DROP_TARGET_RADIUS,
  type DropMode,
  type DropCandidate,
  type DropOrientation,
} from '../../../utils/dropTarget';
import {
  computeDropPreview,
  dropPreviewEquals,
  type DropPreviewRect,
} from '../../../utils/dragLayoutPreview';
import {
  collectCanvasDragSubtreeIds,
  resolveCanvasDragNodeIds,
} from '../../../utils/canvasDragSelection';

export interface UseCanvasNodeDragOptions {
  root: MindMapNode;
  /** 当前视图根节点 ID（分支聚焦时锁死 viewRootId 不可拖拽；默认回退 document.root.id） */
  effectiveRootId?: string;
  /** 是否禁用节点拖拽（背诵/关联线模式等，拖拽中禁用会立即中断并复位状态） */
  disabled?: boolean;
  selection: string[];
  effectiveLayoutDirection: LayoutDirection;
  getNodes: () => Node[];
  setSelection: (ids: string[]) => void;
  setFocusedNodeId: (id: string | null) => void;
  moveNodes: (nodeIds: string[], newParentId: string, index: number) => boolean;
  prevFocusedNodeIdRef: React.MutableRefObject<string | null>;
}

export interface UseCanvasNodeDragResult {
  isDragging: boolean;
  dropTargetId: string | null;
  dropMode: DropMode;
  dropOrientation: DropOrientation;
  dropPreview: DropPreviewRect | null;
  dragCount: number;
  dragPositionOverride: Record<string, { x: number; y: number }>;
  dragNodeIdRef: React.MutableRefObject<string | null>;
  dragNodeSizeRef: React.MutableRefObject<{ width: number; height: number }>;
  dragSubtreeOffsetsRef: React.MutableRefObject<Record<string, { dx: number; dy: number }>>;
  onNodeDragStart: OnNodeDrag;
  onNodeDrag: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
}

/**
 * 计算将拖拽节点作为目标节点的子节点放下时的插入索引：
 * 默认追加到目标节点子节点列表末尾（符合主流导图与用户直觉）。
 */
export function resolveChildAppendIndex(root: MindMapNode, targetId: string): number {
  const targetNode = findNodeById(root, targetId);
  return targetNode ? targetNode.children.length : 0;
}

/** 计算节点在拖拽态下的基础 CSS 类名（落点目标或正在拖拽的子树） */
export function resolveNodeDragClassName(params: {
  nodeId: string;
  isDragging: boolean;
  dragNodeId: string | null;
  dragSubtreeOffsets: Record<string, { dx: number; dy: number }>;
  dropTargetId: string | null;
  dropMode: DropMode;
  dropOrientation: DropOrientation;
}): { className?: string; isSubtreeOfDragged: boolean } {
  const {
    nodeId,
    isDragging,
    dragNodeId,
    dragSubtreeOffsets,
    dropTargetId,
    dropMode,
    dropOrientation,
  } = params;
  const isBeingDragged = isDragging && nodeId === dragNodeId;
  const isSubtreeOfDragged = isDragging && nodeId in dragSubtreeOffsets;
  if (nodeId === dropTargetId) {
    if (dropMode === 'child') {
      return { className: 'mm-drop-target mm-drop-child', isSubtreeOfDragged };
    }
    const orientationClass =
      dropOrientation === 'horizontal'
        ? 'mm-drop-sibling--horizontal'
        : 'mm-drop-sibling--vertical';
    const className =
      dropMode === 'sibling-before'
        ? `mm-drop-target mm-drop-sibling-before ${orientationClass}`
        : `mm-drop-target mm-drop-sibling-after ${orientationClass}`;
    return { className, isSubtreeOfDragged };
  }
  if (isBeingDragged || isSubtreeOfDragged) {
    return { className: 'mm-dragging', isSubtreeOfDragged };
  }
  return { className: undefined, isSubtreeOfDragged };
}

/** 仅对被拖拽子树节点叠加位置 override，其余节点保持对象引用不变 */
export function applyDragPositionOverrides<T extends Node>(
  nodes: T[],
  dragPositionOverride: Record<string, { x: number; y: number }>,
): T[] {
  if (Object.keys(dragPositionOverride).length === 0) return nodes;
  return nodes.map((node) => {
    const posOverride = dragPositionOverride[node.id];
    return posOverride ? { ...node, position: posOverride } : node;
  });
}

/** 同步收集 ReactFlow 的节点尺寸测量结果，避免受控 nodes 重建后丢失 measured */
export function captureRfNodeDimensions(
  changes: NodeChange[],
  measuredById: Map<string, { width: number; height: number }>,
): void {
  for (const change of changes) {
    if (change.type === 'dimensions' && change.dimensions) {
      const prev = measuredById.get(change.id);
      if (
        !prev ||
        prev.width !== change.dimensions.width ||
        prev.height !== change.dimensions.height
      ) {
        measuredById.set(change.id, {
          width: change.dimensions.width,
          height: change.dimensions.height,
        });
      }
    }
  }
}

function measuredEqual(
  a: Node['measured'] | undefined,
  b: Node['measured'] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.width === b.width && a.height === b.height;
}

export interface EnrichCanvasNodesParams {
  layoutNodes: Node[];
  rootId: string;
  focusedNodeId: string | null;
  selection: string[];
  agentEnteringIds: Set<string>;
  agentExitingIds: Set<string>;
  agentUpdatedIds: Set<string>;
  isDragging: boolean;
  dragNodeId: string | null;
  dragSubtreeOffsets: Record<string, { dx: number; dy: number }>;
  dropTargetId: string | null;
  dropMode: DropMode;
  dropOrientation: DropOrientation;
  excerptNodeTargetId: string | null;
  excerptNodeTargetMerge: boolean;
  spotlightActiveIds: Set<string> | null;
  branchIndexById: Map<string, number>;
  showMasteryOverlay: boolean;
  masteryStatusByNodeId?: Readonly<Record<string, 'due' | 'struggling' | 'learning' | 'mastered'>>;
  openNodeContextMenu: (nodeId: string, position: { x: number; y: number }) => void;
  dataCache: WeakMap<object, Record<string, unknown>>;
  measuredById?: ReadonlyMap<string, { width: number; height: number }>;
  prevNodesById?: ReadonlyMap<string, Node>;
}

/**
 * 组装画布节点展示态：合并拖拽/Agent/摘录/Spotlight 类名，
 * 并通过 WeakMap 缓存注入稳定的 onOpenMenu / branchIndex / FSRS 掌握度，避免击穿 React.memo。
 */
export function enrichCanvasNodes({
  layoutNodes,
  rootId,
  focusedNodeId,
  selection,
  agentEnteringIds,
  agentExitingIds,
  agentUpdatedIds,
  isDragging,
  dragNodeId,
  dragSubtreeOffsets,
  dropTargetId,
  dropMode,
  dropOrientation,
  excerptNodeTargetId,
  excerptNodeTargetMerge,
  spotlightActiveIds,
  branchIndexById,
  showMasteryOverlay,
  masteryStatusByNodeId,
  openNodeContextMenu,
  dataCache,
  measuredById,
  prevNodesById,
}: EnrichCanvasNodesParams): Node[] {
  const selectionSet = selection.length > 0 ? new Set(selection) : null;
  const masteryActive = Boolean(showMasteryOverlay);

  return layoutNodes.map((node) => {
    const { className: dragClass, isSubtreeOfDragged } = resolveNodeDragClassName({
      nodeId: node.id,
      isDragging,
      dragNodeId,
      dragSubtreeOffsets,
      dropTargetId,
      dropMode,
      dropOrientation,
    });

    const classes: string[] = [];
    if (dragClass) classes.push(dragClass);
    if (agentEnteringIds.has(node.id)) classes.push('agent-entering');
    if (agentExitingIds.has(node.id)) classes.push('agent-exiting');
    if (agentUpdatedIds.has(node.id)) classes.push('agent-updated');
    if (excerptNodeTargetId === node.id) {
      classes.push(
        excerptNodeTargetMerge ? 'mm-mn5-drop-node mm-mn5-drop-merge' : 'mm-mn5-drop-node',
      );
    }
    if (spotlightActiveIds && !spotlightActiveIds.has(node.id)) {
      classes.push('mm-spotlight-dimmed');
    }

    const layoutData = node.data as object;
    const branchIndex = branchIndexById.get(node.id);
    const masteryStatus = masteryActive ? masteryStatusByNodeId?.[node.id] : undefined;
    let data = dataCache.get(layoutData);
    if (
      !data ||
      data.onOpenMenu !== openNodeContextMenu ||
      data.branchIndex !== branchIndex ||
      data.showMasteryOverlay !== masteryActive ||
      data.masteryStatus !== masteryStatus
    ) {
      data = {
        ...node.data,
        onOpenMenu: openNodeContextMenu,
        ...(branchIndex !== undefined ? { branchIndex } : {}),
        showMasteryOverlay: masteryActive,
        masteryStatus,
      };
      dataCache.set(layoutData, data);
    }

    const selected = selectionSet ? selectionSet.has(node.id) : node.id === focusedNodeId;
    const draggable = node.id !== rootId && !isSubtreeOfDragged;
    const className = classes.length > 0 ? classes.join(' ') : undefined;
    const measured = measuredById?.get(node.id) ?? node.measured;
    const prevNode = prevNodesById?.get(node.id);

    if (
      prevNode &&
      prevNode.type === node.type &&
      prevNode.position.x === node.position.x &&
      prevNode.position.y === node.position.y &&
      prevNode.width === node.width &&
      prevNode.height === node.height &&
      prevNode.data === data &&
      prevNode.selected === selected &&
      prevNode.draggable === draggable &&
      prevNode.className === className &&
      prevNode.style === node.style &&
      measuredEqual(prevNode.measured, measured)
    ) {
      return prevNode;
    }

    const resolvedMeasured =
      prevNode && measuredEqual(prevNode.measured, measured) ? prevNode.measured : measured;

    return {
      ...node,
      ...(resolvedMeasured ? { measured: resolvedMeasured } : {}),
      data,
      selected,
      draggable,
      className,
    };
  });
}

/**
 * 画布节点拖拽编排 Hook：
 * - 多选/子树跟随位移（rAF 节流合帧，避免 mousemove 同步 flushSync 卡顿）
 * - 滞回落点解析（child / sibling-before / sibling-after，方向感知）
 * - ghost 插槽预览（几何去重，非每帧 setState）
 * - 落点提交（子节点模式追加到末尾；兄弟模式插入前后位）
 */
export function useCanvasNodeDrag({
  root,
  effectiveRootId,
  disabled = false,
  selection,
  effectiveLayoutDirection,
  getNodes,
  setSelection,
  setFocusedNodeId,
  moveNodes,
  prevFocusedNodeIdRef,
}: UseCanvasNodeDragOptions): UseCanvasNodeDragResult {
  const lockedRootId = effectiveRootId ?? root.id;
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<DropMode>('child');
  // 滞回读取用 ref，避免 onNodeDrag 闭包依赖 drop 状态导致重建
  const dropTargetIdRef = useRef<string | null>(null);
  const dropModeRef = useRef<DropMode>('child');
  const [isDragging, setIsDragging] = useState(false);
  const dragNodeIdRef = useRef<string | null>(null);
  const dragRootIdsRef = useRef<string[]>([]);
  const dragSubtreeIdsRef = useRef<Set<string>>(new Set());
  // 拖拽 ghost 插槽预览：仅目标/模式变化时更新（dropPreviewEquals 去重），非每帧 setState
  const [dropPreview, setDropPreview] = useState<DropPreviewRect | null>(null);
  const dropPreviewRef = useRef<DropPreviewRect | null>(null);
  // 多选拖拽数量角标：>1 时跟随被拖节点右上角
  const [dragCount, setDragCount] = useState(0);
  const dragNodeSizeRef = useRef<{ width: number; height: number }>({ width: 100, height: 36 });
  const [dragPositionOverride, setDragPositionOverride] = useState<
    Record<string, { x: number; y: number }>
  >({});
  // rAF 合帧：mousemove 只写 pending，每帧最多一次 setState，避免 flushSync 卡顿
  const pendingDragOverrideRef = useRef<Record<string, { x: number; y: number }> | null>(null);
  const dragRafRef = useRef<number | null>(null);
  // 拖拽子树：记录所有后代节点相对于被拖节点的偏移
  const dragSubtreeOffsetsRef = useRef<Record<string, { dx: number; dy: number }>>({});

  // 兄弟排列轴：left/right/both 布局兄弟上下排列（vertical），up/down 布局左右排列（horizontal）。
  const dropOrientation = dropOrientationForDirection(effectiveLayoutDirection);
  const dropOrientationRef = useRef(dropOrientation);
  dropOrientationRef.current = dropOrientation;
  const effectiveLayoutDirectionRef = useRef(effectiveLayoutDirection);
  effectiveLayoutDirectionRef.current = effectiveLayoutDirection;

  const flushPendingDragOverride = useCallback(() => {
    dragRafRef.current = null;
    const pending = pendingDragOverrideRef.current;
    if (!pending) return;
    pendingDragOverrideRef.current = null;
    setDragPositionOverride(pending);
  }, []);

  const scheduleDragOverride = useCallback(
    (next: Record<string, { x: number; y: number }>) => {
      pendingDragOverrideRef.current = next;
      if (dragRafRef.current != null) return;
      dragRafRef.current = requestAnimationFrame(flushPendingDragOverride);
    },
    [flushPendingDragOverride],
  );

  const cancelPendingDragOverride = useCallback(() => {
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingDragOverrideRef.current = null;
  }, []);

  const resetDragState = useCallback(() => {
    dragNodeIdRef.current = null;
    dragRootIdsRef.current = [];
    dragSubtreeIdsRef.current = new Set();
    dragSubtreeOffsetsRef.current = {};
    cancelPendingDragOverride();
    dropTargetIdRef.current = null;
    dropModeRef.current = 'child';
    dropPreviewRef.current = null;
    setIsDragging(false);
    setDragPositionOverride({});
    setDragCount(0);
    setDropTargetId(null);
    setDropMode('child');
    setDropPreview(null);
  }, [cancelPendingDragOverride]);

  useEffect(() => () => cancelPendingDragOverride(), [cancelPendingDragOverride]);

  // 拖拽中断清理：窗口失焦或按下 Escape 时立即复位所有拖拽状态，避免残留悬空幽灵线与位置覆写
  useEffect(() => {
    if (!isDragging) return;
    const handleBlur = () => {
      resetDragState();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dragNodeIdRef.current) {
        event.preventDefault();
        event.stopPropagation();
        resetDragState();
      }
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isDragging, resetDragState]);

  // 拖拽中被禁用（切入背诵/关联模式）或被拖节点从文档中消失（Agent 删除/撤销）时自动复位
  useEffect(() => {
    if (!isDragging) return;
    if (disabled) {
      resetDragState();
      return;
    }
    const draggedId = dragNodeIdRef.current;
    if (draggedId && !findNodeById(root, draggedId)) {
      resetDragState();
    }
  }, [isDragging, disabled, root, resetDragState]);

  const onNodeDragStart = useCallback<OnNodeDrag>(
    (_, node) => {
      if (disabled || node.id === lockedRootId) return;
      // 拖拽选中不强制居中
      prevFocusedNodeIdRef.current = node.id;
      const dragRootIds = resolveCanvasDragNodeIds(root, selection, node.id);
      if (!selection.includes(node.id)) setSelection([node.id]);
      setFocusedNodeId(node.id);
      dragNodeIdRef.current = node.id;
      dragRootIdsRef.current = dragRootIds;
      const draggedTreeIds = collectCanvasDragSubtreeIds(root, dragRootIds);
      dragSubtreeIdsRef.current = draggedTreeIds;
      dropTargetIdRef.current = null;
      dropModeRef.current = 'child';
      setDropTargetId(null);
      setDropMode('child');
      setIsDragging(true);
      // 多选拖拽角标 + 角标定位所需的节点尺寸
      setDragCount(dragRootIds.length);
      dragNodeSizeRef.current = {
        width: node.measured?.width || 100,
        height: node.measured?.height || 36,
      };
      dropPreviewRef.current = null;
      setDropPreview(null);

      // 收集所有后代节点的相对偏移，使子树跟随拖拽（先建索引 O(n) 避免 O(n²)）
      const allNodes = getNodes();
      const nodeById = new Map(allNodes.map((n) => [n.id, n]));
      const offsets: Record<string, { dx: number; dy: number }> = {};
      const overrides: Record<string, { x: number; y: number }> = { [node.id]: node.position };

      for (const draggedId of draggedTreeIds) {
        if (draggedId === node.id) continue;
        const layoutNode = nodeById.get(draggedId);
        if (!layoutNode) continue;
        offsets[draggedId] = {
          dx: layoutNode.position.x - node.position.x,
          dy: layoutNode.position.y - node.position.y,
        };
        overrides[draggedId] = layoutNode.position;
      }

      dragSubtreeOffsetsRef.current = offsets;
      cancelPendingDragOverride();
      setDragPositionOverride(overrides);
    },
    [
      root,
      lockedRootId,
      disabled,
      selection,
      setFocusedNodeId,
      setSelection,
      getNodes,
      cancelPendingDragOverride,
      prevFocusedNodeIdRef,
    ],
  );

  const onNodeDrag = useCallback<OnNodeDrag>(
    (_, draggedNode) => {
      if (!dragNodeIdRef.current) return;
      const dragId = dragNodeIdRef.current;
      const dragPos = draggedNode.position;
      const offsets = dragSubtreeOffsetsRef.current;

      // rAF 合帧更新子树位置
      const next: Record<string, { x: number; y: number }> = { [dragId]: dragPos };
      for (const [childId, offset] of Object.entries(offsets)) {
        next[childId] = { x: dragPos.x + offset.dx, y: dragPos.y + offset.dy };
      }
      scheduleDragOverride(next);

      const allNodes = getNodes();
      const dragW = draggedNode.measured?.width || 100;
      const dragH = draggedNode.measured?.height || 36;
      const dragCenterX = dragPos.x + dragW / 2;
      const dragCenterY = dragPos.y + dragH / 2;
      const dragSubtreeIds = dragSubtreeIdsRef.current;

      const candidates: DropCandidate[] = [];
      for (const n of allNodes) {
        if (n.id === dragId) continue;
        if (n.id in offsets) continue;
        if (dragSubtreeIds.has(n.id)) continue;

        const width = n.measured?.width || 100;
        const height = n.measured?.height || 36;
        if (
          Math.abs(dragCenterX - (n.position.x + width / 2)) > DROP_TARGET_RADIUS ||
          Math.abs(dragCenterY - (n.position.y + height / 2)) > DROP_TARGET_RADIUS
        ) {
          continue;
        }

        candidates.push({
          id: n.id,
          x: n.position.x,
          y: n.position.y,
          width,
          height,
        });
      }

      const resolved = resolveDropTarget({
        dragCenterX,
        dragCenterY,
        candidates,
        previousTargetId: dropTargetIdRef.current,
        previousMode: dropModeRef.current,
        orientation: dropOrientationRef.current,
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

      // ghost 插槽预览：算出预计插入位置的指示线；仅几何变化时 setState
      let nextPreview: DropPreviewRect | null = null;
      if (resolved.targetId) {
        const target = candidates.find((c) => c.id === resolved.targetId);
        if (target) {
          nextPreview = computeDropPreview({
            target,
            mode: resolved.mode,
            orientation: dropOrientationRef.current,
            layoutDirection: effectiveLayoutDirectionRef.current,
            dragCenterX,
            dragCenterY,
          });
        }
      }
      if (!dropPreviewEquals(dropPreviewRef.current, nextPreview)) {
        dropPreviewRef.current = nextPreview;
        setDropPreview(nextPreview);
      }
    },
    [getNodes, scheduleDragOverride],
  );

  const onNodeDragStop = useCallback<OnNodeDrag>(() => {
    const draggedId = dragNodeIdRef.current;
    const draggedRootIds = dragRootIdsRef.current;
    // 用 ref 而非 React state，避免最后一帧滞回未 flush 时落到旧目标
    const finalTargetId = dropTargetIdRef.current;
    const finalMode = dropModeRef.current;

    resetDragState();

    if (draggedId && finalTargetId && draggedId !== finalTargetId) {
      if (!isDescendantOf(root, draggedId, finalTargetId)) {
        const idsToMove = draggedRootIds.length > 0 ? draggedRootIds : [draggedId];
        if (finalMode === 'child') {
          moveNodes(idsToMove, finalTargetId, resolveChildAppendIndex(root, finalTargetId));
        } else {
          const parent = findParentNode(root, finalTargetId);
          if (parent) {
            const idx = parent.children.findIndex((c) => c.id === finalTargetId);
            const insertIdx = finalMode === 'sibling-before' ? idx : idx + 1;
            moveNodes(idsToMove, parent.id, insertIdx);
          } else {
            moveNodes(idsToMove, finalTargetId, resolveChildAppendIndex(root, finalTargetId));
          }
        }
      }
    }
  }, [root, moveNodes, resetDragState]);

  return {
    isDragging,
    dropTargetId,
    dropMode,
    dropOrientation,
    dropPreview,
    dragCount,
    dragPositionOverride,
    dragNodeIdRef,
    dragNodeSizeRef,
    dragSubtreeOffsetsRef,
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
  };
}
