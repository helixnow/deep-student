/**
 * 布局坐标平滑过渡：对 React Flow nodes 的 position 做 rAF + easeOutCubic 插值。
 *
 * 设计要点：
 * - 新增节点：直接就位（不插值；淡入可由 CSS 负责）
 * - 坐标未变：零开销（返回目标数组引用，或复用单节点对象）
 * - prefers-reduced-motion：直接返回目标 nodes
 * - 卸载 / enabled=false：cancelAnimationFrame
 * - 动画中：仅对位置变化中的节点新建对象，静止节点复用目标引用
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';

export type AnimatedNodePosition = { x: number; y: number };

export type UseAnimatedNodesOptions = {
  /** 插值时长 ms，默认 200 */
  duration?: number;
  /**
   * 为 false 时立即返回目标 nodes 并取消进行中的动画。
   * 接线建议：拖拽中传 `enabled: !isDragging`，避免拖拽坐标被当成布局过渡。
   */
  enabled?: boolean;
};

export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function positionsEqual(
  a: AnimatedNodePosition | undefined,
  b: AnimatedNodePosition | undefined,
  epsilon = 0.01,
): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

function readPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type AnimEntry = {
  from: AnimatedNodePosition;
  to: AnimatedNodePosition;
};

/**
 * @param nodes 布局引擎（或 canvas  enrichment）产出的目标 nodes
 * @returns 插值中的 animatedNodes，可直接传给 `<ReactFlow nodes={...} />`
 */
export function useAnimatedNodes<NodeType extends Node = Node>(
  nodes: NodeType[],
  options: UseAnimatedNodesOptions = {},
): NodeType[] {
  const { duration = 200, enabled = true } = options;

  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);
  const [animatedNodes, setAnimatedNodes] = useState<NodeType[]>(nodes);

  const displayRef = useRef<NodeType[]>(nodes);
  const targetsRef = useRef<NodeType[]>(nodes);
  const animatingRef = useRef<Map<string, AnimEntry>>(new Map());
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const cancelRaf = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    startTimeRef.current = null;
  };

  const commit = (next: NodeType[]) => {
    displayRef.current = next;
    setAnimatedNodes(next);
  };

  const tick = (now: number) => {
    const animating = animatingRef.current;
    if (animating.size === 0) {
      rafRef.current = null;
      startTimeRef.current = null;
      return;
    }

    if (startTimeRef.current == null) {
      startTimeRef.current = now;
    }

    const elapsed = now - startTimeRef.current;
    const t = durationRef.current <= 0 ? 1 : Math.min(1, elapsed / durationRef.current);
    const eased = easeOutCubic(t);
    const targets = targetsRef.current;
    const next: NodeType[] = new Array(targets.length);
    let stillAnimating = false;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const entry = animating.get(target.id);
      if (!entry) {
        next[i] = target;
        continue;
      }

      if (t >= 1) {
        next[i] = target;
        animating.delete(target.id);
        continue;
      }

      stillAnimating = true;
      const position = {
        x: lerp(entry.from.x, entry.to.x, eased),
        y: lerp(entry.from.y, entry.to.y, eased),
      };
      next[i] = { ...target, position };
    }

    commit(next);

    if (stillAnimating) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
      startTimeRef.current = null;
      // 动画结束：尽量返回目标数组引用，避免 RF 全量 diff
      commit(targets);
    }
  };

  const startRaf = () => {
    if (rafRef.current != null) return;
    startTimeRef.current = null;
    rafRef.current = requestAnimationFrame(tick);
  };

  useLayoutEffect(() => {
    targetsRef.current = nodes;

    if (!enabled || reducedMotion || duration <= 0) {
      cancelRaf();
      animatingRef.current.clear();
      if (displayRef.current !== nodes) {
        commit(nodes);
      }
      return;
    }

    const prevById = new Map(displayRef.current.map((n) => [n.id, n]));
    const animating = animatingRef.current;
    let needsAnimation = false;

    // 清理已删除节点的动画状态
    for (const id of [...animating.keys()]) {
      if (!nodes.some((n) => n.id === id)) {
        animating.delete(id);
      }
    }

    for (const target of nodes) {
      const prev = prevById.get(target.id);
      if (!prev) {
        // 新节点：直接就位
        animating.delete(target.id);
        continue;
      }

      const currentPos = prev.position;
      const targetPos = target.position;

      if (positionsEqual(currentPos, targetPos)) {
        // 坐标不变：若曾在动画中且已对齐，清掉
        const entry = animating.get(target.id);
        if (entry && positionsEqual(entry.to, targetPos)) {
          animating.delete(target.id);
        }
        continue;
      }

      // 坐标变化：从当前显示位置（含进行中插值）插值到新目标
      animating.set(target.id, {
        from: { x: currentPos.x, y: currentPos.y },
        to: { x: targetPos.x, y: targetPos.y },
      });
      needsAnimation = true;
    }

    if (!needsAnimation && animating.size === 0) {
      cancelRaf();
      // 非位置字段（selected / data / className）仍可能变：对齐到目标引用
      if (displayRef.current !== nodes) {
        commit(nodes);
      }
      return;
    }

    if (needsAnimation) {
      // 重置时钟，使新布局过渡从 t=0 开始
      startTimeRef.current = null;
      // 首帧先把静止节点切到最新 target，动画节点停在 from
      const bootstrap: NodeType[] = nodes.map((target) => {
        const entry = animating.get(target.id);
        if (!entry) return target;
        return { ...target, position: { ...entry.from } };
      });
      commit(bootstrap);
      startRaf();
    } else if (animating.size > 0) {
      startRaf();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅跟随 nodes/enabled/duration/reducedMotion
  }, [nodes, enabled, duration, reducedMotion]);

  useEffect(() => {
    const animating = animatingRef.current;
    return () => {
      cancelRaf();
      animating.clear();
    };
  }, []);

  if (!enabled || reducedMotion) {
    return nodes;
  }

  return animatedNodes;
}
