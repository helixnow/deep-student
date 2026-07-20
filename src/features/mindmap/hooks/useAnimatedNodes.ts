/**
 * 布局坐标平滑过渡：对 React Flow nodes 的 position 做 rAF + easeOutCubic 插值。
 *
 * 设计要点：
 * - 新增节点：默认原位入场（短暂标注 NODE_SPAWN_CLASS，由 nodes.css 播放生长/淡入动画）；
 *   若提供 getSpawnOrigin（如返回父节点坐标），则同时从该起点插值到目标位置
 * - 坐标未变：零开销（返回目标数组引用，或复用单节点对象）
 * - prefers-reduced-motion：直接返回目标 nodes，且不标注入场类
 * - 卸载 / enabled=false：cancelAnimationFrame
 * - 动画中：仅对位置变化中的节点新建对象，静止节点复用目标引用
 * - 大图降级：每帧插值要 commit 全量数组（RF 全量 diff），节点数超
 *   ANIMATION_NODE_SOFT_LIMIT 时压缩时长，超 ANIMATION_NODE_HARD_LIMIT
 *   直接跳过动画（resolveAnimationDuration）
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node } from '@xyflow/react';

export type AnimatedNodePosition = { x: number; y: number };

/** 入场标注类名：挂在 RF 节点包装层，动画规则见 nodes/nodes.css */
export const NODE_SPAWN_CLASS = 'mm-node-spawn';

/** 入场类保留时长（ms）：覆盖 CSS 动画时长 + 余量，过期后剥离避免虚拟化重挂载时重播 */
export const NODE_SPAWN_DURATION_MS = 280;

export type UseAnimatedNodesOptions = {
  /** 插值时长 ms，默认 200 */
  duration?: number;
  /**
   * 为 false 时立即返回目标 nodes 并取消进行中的动画。
   * 接线建议：拖拽中传 `enabled: !isDragging`，避免拖拽坐标被当成布局过渡。
   */
  enabled?: boolean;
  /**
   * 新增节点的位置生长起点（如父节点中心坐标）。
   * 返回坐标时，新节点从该点插值滑入目标位置；返回 undefined 则原位入场。
   * 不提供时仅有 CSS 淡入/缩放入场（NODE_SPAWN_CLASS）。
   */
  getSpawnOrigin?: (node: Node) => AnimatedNodePosition | undefined;
};

/** 大图软阈值：节点数超过后按比例压缩动画时长（每帧全量 commit 的成本随 n 线性涨） */
export const ANIMATION_NODE_SOFT_LIMIT = 300;
/** 大图硬阈值：节点数超过后跳过布局动画，直接就位 */
export const ANIMATION_NODE_HARD_LIMIT = 800;
/** 软降级时的时长压缩比例 */
export const ANIMATION_SOFT_DURATION_SCALE = 0.6;

/**
 * 大图动画降级策略（纯函数，便于单测）：
 * - n ≤ soft：原时长
 * - soft < n ≤ hard：时长 × ANIMATION_SOFT_DURATION_SCALE
 * - n > hard：0（调用方 duration ≤ 0 即跳过动画）
 */
export function resolveAnimationDuration(
  baseDuration: number,
  nodeCount: number,
  softLimit = ANIMATION_NODE_SOFT_LIMIT,
  hardLimit = ANIMATION_NODE_HARD_LIMIT,
): number {
  if (nodeCount > hardLimit) return 0;
  if (nodeCount > softLimit) {
    return Math.round(baseDuration * ANIMATION_SOFT_DURATION_SCALE);
  }
  return baseDuration;
}

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
  const { duration: baseDuration = 200, enabled = true, getSpawnOrigin } = options;
  // 大图降级：节点数超阈值时缩短 / 跳过动画，避免每帧全量 setState 卡顿
  const duration = resolveAnimationDuration(baseDuration, nodes.length);

  const [reducedMotion, setReducedMotion] = useState(readPrefersReducedMotion);
  const [animatedNodes, setAnimatedNodes] = useState<NodeType[]>(nodes);

  const displayRef = useRef<NodeType[]>(nodes);
  const targetsRef = useRef<NodeType[]>(nodes);
  const animatingRef = useRef<Map<string, AnimEntry>>(new Map());
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const getSpawnOriginRef = useRef(getSpawnOrigin);
  getSpawnOriginRef.current = getSpawnOrigin;

  // 新增节点入场标注：id → 过期时间戳
  const spawnUntilRef = useRef<Map<string, number>>(new Map());
  const spawnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const clearSpawnTimer = () => {
    if (spawnTimerRef.current != null) {
      clearTimeout(spawnTimerRef.current);
      spawnTimerRef.current = null;
    }
  };

  /** 有入场标注时给对应节点追加类名；无标注时原样返回（保持引用透传） */
  const decorateSpawns = (arr: NodeType[]): NodeType[] => {
    const spawns = spawnUntilRef.current;
    if (spawns.size === 0) return arr;
    let changed = false;
    const next = arr.map((node) => {
      if (!spawns.has(node.id)) return node;
      changed = true;
      const className = node.className
        ? `${node.className} ${NODE_SPAWN_CLASS}`
        : NODE_SPAWN_CLASS;
      return { ...node, className };
    });
    return changed ? next : arr;
  };

  const commit = (next: NodeType[]) => {
    displayRef.current = next;
    setAnimatedNodes(next);
  };

  /** 过期后剥离入场类并重发目标数组，避免虚拟化重挂载时动画重播 */
  const scheduleSpawnCleanup = () => {
    if (spawnTimerRef.current != null) return;
    const spawns = spawnUntilRef.current;
    if (spawns.size === 0) return;
    let earliest = Infinity;
    spawns.forEach((until) => {
      if (until < earliest) earliest = until;
    });
    const delay = Math.max(0, earliest - Date.now());
    spawnTimerRef.current = setTimeout(() => {
      spawnTimerRef.current = null;
      const now = Date.now();
      spawns.forEach((until, id) => {
        if (until <= now) spawns.delete(id);
      });
      // 动画进行中由 tick 负责输出；静止时主动重发剥离后的数组
      if (rafRef.current == null) {
        commit(decorateSpawns(targetsRef.current));
      }
      scheduleSpawnCleanup();
    }, delay + 16);
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

    commit(decorateSpawns(next));

    if (stillAnimating) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = null;
      startTimeRef.current = null;
      // 动画结束：尽量返回目标数组引用，避免 RF 全量 diff
      commit(decorateSpawns(targets));
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
      spawnUntilRef.current.clear();
      clearSpawnTimer();
      if (displayRef.current !== nodes) {
        commit(nodes);
      }
      return;
    }

    const prevById = new Map(displayRef.current.map((n) => [n.id, n]));
    const animating = animatingRef.current;
    const spawns = spawnUntilRef.current;
    let needsAnimation = false;
    let spawnsAdded = false;

    // 清理已删除节点的动画/入场状态
    for (const id of [...animating.keys()]) {
      if (!nodes.some((n) => n.id === id)) {
        animating.delete(id);
      }
    }
    for (const id of [...spawns.keys()]) {
      if (!nodes.some((n) => n.id === id)) {
        spawns.delete(id);
      }
    }

    for (const target of nodes) {
      const prev = prevById.get(target.id);
      if (!prev) {
        // 新节点：标注 CSS 入场；有生长起点时再叠加位置插值
        animating.delete(target.id);
        spawns.set(target.id, Date.now() + NODE_SPAWN_DURATION_MS);
        spawnsAdded = true;
        const origin = getSpawnOriginRef.current?.(target);
        if (origin && !positionsEqual(origin, target.position)) {
          animating.set(target.id, {
            from: { x: origin.x, y: origin.y },
            to: { x: target.position.x, y: target.position.y },
          });
          needsAnimation = true;
        }
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

    if (spawnsAdded) {
      scheduleSpawnCleanup();
    }

    if (!needsAnimation && animating.size === 0) {
      cancelRaf();
      // 非位置字段（selected / data / className）仍可能变：对齐到目标引用
      const decorated = decorateSpawns(nodes);
      if (displayRef.current !== decorated) {
        commit(decorated);
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
      commit(decorateSpawns(bootstrap));
      startRaf();
    } else if (animating.size > 0) {
      startRaf();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅跟随 nodes/enabled/duration/reducedMotion
  }, [nodes, enabled, duration, reducedMotion]);

  useEffect(() => {
    const animating = animatingRef.current;
    const spawns = spawnUntilRef.current;
    return () => {
      cancelRaf();
      clearSpawnTimer();
      animating.clear();
      spawns.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅卸载清理
  }, []);

  if (!enabled || reducedMotion || duration <= 0) {
    return nodes;
  }

  return animatedNodes;
}
