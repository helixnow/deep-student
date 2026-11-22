import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { Node, ReactFlowInstance } from '@xyflow/react';
import { addTypedEventListener } from '@/events';
import { hasExcerptMime, readExcerptDrag } from '@/ui-sdk';
import { clearActiveExcerptDrag } from '@/ui-kernel/services/excerpt-dnd';
import type { MindMapStoreApi } from '../../../store';
import { useMindMapStore } from '../../../store';
import { findNodeById } from '../../../utils/node/find';
import {
  computeBranchInsertIndex,
  computeNodeDropZone,
  consumeActiveStagingExcerptDragId,
  createExcerptDragDepthTracker,
  isScreenRectWithinViewportInset,
} from '../../../utils/excerptIngest';
import { normalizeMindMapViewport } from '../../../utils/viewport';
import { NODE_LOCATE_REQUEST_TTL_MS } from '../../../utils/nodeTarget';
import { prefersReducedMotion } from '@/styles/motion-springs';

const NODE_LOCATE_MIN_ZOOM = 0.85;

/** 摘录拖拽投放目标：节点（子节点 / Alt 合并）或空白处（按指针位置插入一级分支） */
export type ExcerptCanvasDropTarget =
  | { kind: 'node'; nodeId: string; merge: boolean }
  | { kind: 'pane'; flowX: number; flowY: number; insertIndex: number };

export function getNodeScreenBounds(
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

/** 节点是否与画布视口有任何交集（屏幕坐标）。完全在外才返回 false。 */
export function isNodeIntersectingViewport(
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
export function isNodeFullyInViewport(
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

export interface UseCanvasExcerptDropOptions {
  canvasContainerRef: React.RefObject<HTMLDivElement | null>;
  reactFlowInstance: ReactFlowInstance;
  storeApi: MindMapStoreApi;
  layoutDirection: string;
  layoutNodeById: Map<string, Node>;
  reciteMode: boolean;
  isExporting: boolean;
  isCanvasReady: boolean;
  prevFocusedNodeIdRef: React.MutableRefObject<string | null>;
}

export interface UseCanvasExcerptDropResult {
  excerptDropTarget: ExcerptCanvasDropTarget | null;
  handleExcerptDragEnter: (event: React.DragEvent) => void;
  handleExcerptDragOver: (event: React.DragEvent) => void;
  handleExcerptDragLeave: (event: React.DragEvent) => void;
  handleExcerptDrop: (event: React.DragEvent) => void;
}

/**
 * PDF/笔记摘录拖拽双区域落点检测与投放执行 Hook（DS_EXCERPT_MIME）：
 * - 节点内双区域（子节点 / Alt 合并）与空白画布插入一级分支
 * - 深度计数防子元素抖动 + rAF 合帧
 * - 摘录入图后的视口安全边距跟随
 */
export function useCanvasExcerptDrop({
  canvasContainerRef,
  reactFlowInstance,
  storeApi,
  layoutDirection,
  layoutNodeById,
  reciteMode,
  isExporting,
  isCanvasReady,
  prevFocusedNodeIdRef,
}: UseCanvasExcerptDropOptions): UseCanvasExcerptDropResult {
  const [excerptDropTarget, setExcerptDropTarget] = useState<ExcerptCanvasDropTarget | null>(null);
  const excerptDragDepthRef = useRef(createExcerptDragDepthTracker());
  const excerptDropPendingRef = useRef<ExcerptCanvasDropTarget | null>(null);
  const excerptDropFrameRef = useRef<number | null>(null);
  const excerptDropKeyRef = useRef<string | null>(null);

  const clearExcerptDropTarget = useCallback(() => {
    excerptDragDepthRef.current.reset();
    excerptDropPendingRef.current = null;
    excerptDropKeyRef.current = null;
    if (excerptDropFrameRef.current != null) {
      cancelAnimationFrame(excerptDropFrameRef.current);
      excerptDropFrameRef.current = null;
    }
    setExcerptDropTarget(null);
  }, []);

  useEffect(() => {
    const reset = () => clearExcerptDropTarget();
    const doc = typeof window !== 'undefined' ? window.document : null;
    const onVisibility = () => {
      if (doc && doc.visibilityState === 'hidden') {
        clearExcerptDropTarget();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearExcerptDropTarget();
    };
    const cleanups = [
      addTypedEventListener('dragend', () => reset(), true),
      addTypedEventListener('drop', () => reset()),
      addTypedEventListener('blur', () => reset()),
      addTypedEventListener('keydown', (_d, event) => onKeyDown(event as unknown as KeyboardEvent), true),
      addTypedEventListener('visibilitychange', () => onVisibility(), undefined, 'document'),
    ];
    return () => {
      cleanups.forEach((dispose) => dispose());
      if (excerptDropFrameRef.current != null) cancelAnimationFrame(excerptDropFrameRef.current);
    };
  }, [clearExcerptDropTarget]);

  const resolveExcerptDropTarget = useCallback(
    (event: React.DragEvent): ExcerptCanvasDropTarget => {
      const nodeEl = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
        '.react-flow__node[data-id]',
      );
      const nodeId = nodeEl?.getAttribute('data-id');
      if (nodeId && nodeEl) {
        const rect = nodeEl.getBoundingClientRect();
        const prev = excerptDropPendingRef.current;
        const prevZone =
          prev && prev.kind === 'node' && prev.nodeId === nodeId
            ? prev.merge
              ? 'merge'
              : 'child'
            : null;
        const zone = computeNodeDropZone(
          rect,
          { clientX: event.clientX, clientY: event.clientY },
          { altKey: event.altKey, prevZone },
        );
        return { kind: 'node', nodeId, merge: zone === 'merge' };
      }
      const flow = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const state = storeApi.getState();
      const scope =
        (state.viewRootId ? findNodeById(state.document.root, state.viewRootId) : null) ??
        state.document.root;
      const slots = scope.children.flatMap((child) => {
        const laid = layoutNodeById.get(child.id);
        if (!laid) return [];
        return [
          {
            id: child.id,
            x: laid.position.x,
            y: laid.position.y,
            width: laid.width ?? 0,
            height: laid.height ?? 0,
          },
        ];
      });
      const axis = layoutDirection === 'up' || layoutDirection === 'down' ? 'x' : 'y';
      return {
        kind: 'pane',
        flowX: flow.x,
        flowY: flow.y,
        insertIndex: computeBranchInsertIndex(flow, slots, axis),
      };
    },
    [layoutDirection, layoutNodeById, reactFlowInstance, storeApi],
  );

  const scheduleExcerptDropTarget = useCallback((target: ExcerptCanvasDropTarget) => {
    excerptDropPendingRef.current = target;
    if (excerptDropFrameRef.current != null) return;
    excerptDropFrameRef.current = requestAnimationFrame(() => {
      excerptDropFrameRef.current = null;
      const next = excerptDropPendingRef.current;
      if (!next) return;
      // 节点目标仅在节点 / Alt 状态变化时提交，避免每帧重渲染；空白处跟随指针移动幽灵胶囊
      const key = next.kind === 'node' ? `node:${next.nodeId}:${next.merge ? 1 : 0}` : null;
      if (key && key === excerptDropKeyRef.current) return;
      excerptDropKeyRef.current = key;
      setExcerptDropTarget(next);
    });
  }, []);

  const acceptsExcerptDrag = useCallback(
    (event: React.DragEvent) => !reciteMode && !isExporting && hasExcerptMime(event.nativeEvent),
    [isExporting, reciteMode],
  );

  const handleExcerptDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (!acceptsExcerptDrag(event)) return;
      event.preventDefault();
      excerptDragDepthRef.current.enter();
    },
    [acceptsExcerptDrag],
  );

  const handleExcerptDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!acceptsExcerptDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.dataTransfer.dropEffect = 'copy';
      } catch {
        // 部分合成事件的 dropEffect 只读
      }
      scheduleExcerptDropTarget(resolveExcerptDropTarget(event));
    },
    [acceptsExcerptDrag, resolveExcerptDropTarget, scheduleExcerptDropTarget],
  );

  const handleExcerptDragLeave = useCallback(
    (event: React.DragEvent) => {
      if (!hasExcerptMime(event.nativeEvent)) return;
      const leftByDepth = excerptDragDepthRef.current.leave();
      const related = event.relatedTarget;
      if (
        typeof globalThis.Node !== 'undefined' &&
        related instanceof globalThis.Node &&
        event.currentTarget.contains(related)
      ) {
        return;
      }
      if (leftByDepth) clearExcerptDropTarget();
    },
    [clearExcerptDropTarget],
  );

  const handleExcerptDrop = useCallback(
    (event: React.DragEvent) => {
      if (!acceptsExcerptDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const target = resolveExcerptDropTarget(event);
      const stagingId = consumeActiveStagingExcerptDragId();
      const payload = readExcerptDrag(event.nativeEvent);
      clearActiveExcerptDrag();
      clearExcerptDropTarget();
      const state = storeApi.getState();
      const dropOptions =
        target.kind === 'node'
          ? ({ mode: target.merge ? 'merge' : 'child', targetNodeId: target.nodeId } as const)
          : ({ mode: 'branch', insertIndex: target.insertIndex } as const);
      if (
        stagingId &&
        state.document.stagingExcerpts?.some((entry) => entry.id === stagingId)
      ) {
        state.commitStagingExcerpt(stagingId, dropOptions);
        return;
      }
      if (!payload) return;
      state.ingestExcerpt(payload, dropOptions);
    },
    [acceptsExcerptDrag, clearExcerptDropTarget, resolveExcerptDropTarget, storeApi],
  );

  // 摘录入图后的视口跟随：新节点已在视口安全边距（12%）内则镜头不动；
  // 先于聚焦居中 effect 声明，抢先写 prevFocusedNodeId，避免两次镜头动画。
  const excerptRevealRequest = useMindMapStore((s) => s.excerptRevealRequest);
  const handledExcerptRevealRef = useRef(0);
  const { getNodes, getZoom, setCenter } = reactFlowInstance;
  useEffect(() => {
    const request = excerptRevealRequest;
    if (!request || request.nonce === handledExcerptRevealRef.current) return;
    handledExcerptRevealRef.current = request.nonce;
    prevFocusedNodeIdRef.current = request.nodeId;
    if (!isCanvasReady) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      const rendered = getNodes().find((n) => n.id === request.nodeId);
      const viewportRect = canvasContainerRef.current?.getBoundingClientRect();
      if (!rendered || !viewportRect || viewportRect.width <= 1 || viewportRect.height <= 1) {
        attempts += 1;
        if (attempts < 4) timer = setTimeout(check, 80);
        return;
      }
      const width = rendered.measured?.width || rendered.width || 100;
      const height = rendered.measured?.height || rendered.height || 36;
      const bounds = getNodeScreenBounds(
        reactFlowInstance.flowToScreenPosition,
        rendered.position,
        width,
        height,
      );
      if (isScreenRectWithinViewportInset(bounds, viewportRect)) return;
      setCenter(rendered.position.x + width / 2, rendered.position.y + height / 2, {
        zoom: normalizeMindMapViewport({ x: 0, y: 0, zoom: getZoom() })?.zoom ?? 1,
        duration: 240,
      });
    };
    timer = setTimeout(check, 60);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [
    excerptRevealRequest,
    getNodes,
    getZoom,
    isCanvasReady,
    reactFlowInstance,
    setCenter,
    canvasContainerRef,
    prevFocusedNodeIdRef,
  ]);

  return {
    excerptDropTarget,
    handleExcerptDragEnter,
    handleExcerptDragOver,
    handleExcerptDragLeave,
    handleExcerptDrop,
  };
}

/** 引用回链定位与 Agent 批量演出结束后的镜头跟随 Hook */
export function useCanvasCameraRequests(params: {
  nodesRef: React.MutableRefObject<Node[]>;
  nodesLength: number;
  isCanvasReady: boolean;
  hasFitViewRef: React.MutableRefObject<boolean>;
  prevFocusedNodeIdRef: React.MutableRefObject<string | null>;
  reactFlowInstance: ReactFlowInstance;
  fitVisibleNodes: (duration: number, padding?: number) => boolean;
}) {
  const {
    nodesRef,
    nodesLength,
    isCanvasReady,
    hasFitViewRef,
    prevFocusedNodeIdRef,
    reactFlowInstance,
    fitVisibleNodes,
  } = params;
  const nodeLocateRequest = useMindMapStore((s) => s.nodeLocateRequest);
  const agentFitViewNonce = useMindMapStore((s) => s.agentFitViewNonce);
  const { getNodes, getZoom, setCenter } = reactFlowInstance;

  const handledLocateNonceRef = useRef(0);
  useEffect(() => {
    const request = nodeLocateRequest;
    if (!request || request.nonce === handledLocateNonceRef.current) return;
    if (Date.now() - request.requestedAt > NODE_LOCATE_REQUEST_TTL_MS) {
      handledLocateNonceRef.current = request.nonce;
      return;
    }
    if (!isCanvasReady || nodesLength === 0) return;
    hasFitViewRef.current = true;
    prevFocusedNodeIdRef.current = request.nodeId;
    const timer = setTimeout(() => {
      const layoutNode = nodesRef.current.find((n) => n.id === request.nodeId);
      if (!layoutNode) return;
      handledLocateNonceRef.current = request.nonce;
      const rendered = getNodes().find((n) => n.id === request.nodeId);
      const width = rendered?.measured?.width || rendered?.width || layoutNode.width || 100;
      const height = rendered?.measured?.height || rendered?.height || layoutNode.height || 36;
      const currentZoom = normalizeMindMapViewport({ x: 0, y: 0, zoom: getZoom() })?.zoom ?? 1;
      setCenter(layoutNode.position.x + width / 2, layoutNode.position.y + height / 2, {
        zoom: Math.max(currentZoom, NODE_LOCATE_MIN_ZOOM),
        duration: prefersReducedMotion() ? 0 : 300,
      });
    }, 280);
    return () => clearTimeout(timer);
  }, [
    nodeLocateRequest,
    isCanvasReady,
    nodesLength,
    nodesRef,
    hasFitViewRef,
    prevFocusedNodeIdRef,
    getNodes,
    getZoom,
    setCenter,
  ]);

  const prevAgentFitViewNonce = useRef(agentFitViewNonce);
  useEffect(() => {
    if (agentFitViewNonce === prevAgentFitViewNonce.current) return;
    prevAgentFitViewNonce.current = agentFitViewNonce;
    if (agentFitViewNonce <= 0) return;
    const timer = setTimeout(() => fitVisibleNodes(300), 80);
    return () => clearTimeout(timer);
  }, [agentFitViewNonce, fitVisibleNodes]);
}
