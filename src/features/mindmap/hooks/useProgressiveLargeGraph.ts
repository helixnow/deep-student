import { useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';

export const LARGE_GRAPH_PROGRESSIVE_THRESHOLD = 120;
export const LARGE_GRAPH_INITIAL_BATCH = 40;
export const LARGE_GRAPH_BATCH_STEP = 35;
export const LARGE_GRAPH_BATCH_DELAY_MS = 40;

export interface UseProgressiveLargeGraphOptions {
  enabled?: boolean;
  resetKey: string;
}

export interface ProgressiveLargeGraphResult {
  nodes: Node[];
  edges: Edge[];
  isComplete: boolean;
}

export interface LayoutNodesBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 根据布局节点预估全图包围盒，供大图首批挂载时即完成 fitBounds，避免末批切视口瞬时挂 200+ 节点 */
export function computeLayoutNodesBounds(nodes: readonly Node[]): LayoutNodesBounds | null {
  if (nodes.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]!;
    const x = n.position?.x;
    const y = n.position?.y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    const w = n.measured?.width ?? n.width ?? 140;
    const h = n.measured?.height ?? n.height ?? 36;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/**
 * 大图渐进分批挂载（>120 节点）：
 * 把 250+ 节点首开的同步 React commit + Blink 首次布局/光栅化拆成多个独立宏任务，
 * 首帧立刻呈现根节点与主干（80 节点），随后每帧增量补齐剩余节点与边，避免单帧 >2s 主线程卡顿。
 * 小图（<=120 节点）或导出模式零开销直通。
 */
export function useProgressiveLargeGraph(
  nodes: Node[],
  edges: Edge[],
  options: UseProgressiveLargeGraphOptions,
): ProgressiveLargeGraphResult {
  const { enabled = true, resetKey } = options;
  const shouldStage = enabled && nodes.length > LARGE_GRAPH_PROGRESSIVE_THRESHOLD;
  const [visibleLimit, setVisibleLimit] = useState<number>(() =>
    shouldStage ? LARGE_GRAPH_INITIAL_BATCH : Number.POSITIVE_INFINITY,
  );
  const prevResetKeyRef = useRef(resetKey);
  const prevWasLargeRef = useRef(shouldStage);

  useEffect(() => {
    const keyChanged = prevResetKeyRef.current !== resetKey;
    const enteredLarge = !prevWasLargeRef.current && shouldStage;
    prevResetKeyRef.current = resetKey;
    prevWasLargeRef.current = shouldStage;

    if (!shouldStage) {
      setVisibleLimit(Number.POSITIVE_INFINITY);
      return;
    }
    if (keyChanged || enteredLarge) {
      setVisibleLimit(LARGE_GRAPH_INITIAL_BATCH);
    }
  }, [resetKey, shouldStage]);

  useEffect(() => {
    if (!shouldStage || visibleLimit >= nodes.length) return;
    let rafId: number | null = null;
    const timer = setTimeout(() => {
      const advance = () => {
        setVisibleLimit((prev) => {
          const next = prev + LARGE_GRAPH_BATCH_STEP;
          return next >= nodes.length ? Number.POSITIVE_INFINITY : next;
        });
      };
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(advance);
      } else {
        advance();
      }
    }, LARGE_GRAPH_BATCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [shouldStage, visibleLimit, nodes.length]);

  const isComplete = !shouldStage || visibleLimit >= nodes.length;

  return useMemo(() => {
    if (isComplete) {
      return { nodes, edges, isComplete: true };
    }
    const stagedNodes = nodes.slice(0, visibleLimit);
    const idSet = new Set<string>();
    for (let i = 0; i < stagedNodes.length; i += 1) {
      idSet.add(stagedNodes[i]!.id);
    }
    const stagedEdges = edges.filter(
      (edge) => idSet.has(edge.source) && idSet.has(edge.target),
    );
    return { nodes: stagedNodes, edges: stagedEdges, isComplete: false };
  }, [isComplete, nodes, edges, visibleLimit]);
}
