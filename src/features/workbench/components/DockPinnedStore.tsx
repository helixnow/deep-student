/**
 * Dock 固定区状态（P5 → O6）
 *
 * 接线（P11）前为本地内存 state；P11 在快照恢复时调用 setDockPinned(snapshot.dockPinned)，
 * 并通过 subscribeDockPinned + getDockPinned 把变更写回快照。
 *
 * O6 增补：
 * - `reorderDockPinned(from, to)`：稳定 setter，供拖拽落位 / O5 协作
 * - `useDockPinnedDragReorder(typeId)`：DockItem 一行接线的指针拖拽排序
 *   （抬升 + 兄弟让位 WAAPI，仅 transform/opacity；落位提交 reorder）
 *   并在固定项挂载时播放加入动画
 *
 * 动效纪律（2026-07-09 审计修复）：
 * - 兄弟让位：fill:'none'，inline style 为唯一真相源；跨槽 / 结束时 cancel 旧动画
 * - 拖拽位移：pointermove 只记坐标，rAF 合帧写 transform
 */
import React, { useSyncExternalStore } from 'react';
import { dockDragThresholdPx } from './dockGestures';

let dockPinned: string[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 当前固定应用 typeId 列表（引用稳定，变更时才换新数组） */
export function getDockPinned(): string[] {
  return dockPinned;
}

/** 整体替换固定区（快照恢复用，自动去重保序） */
export function setDockPinned(next: string[]): void {
  const deduped = Array.from(new Set(next));
  if (deduped.length === dockPinned.length && deduped.every((id, i) => id === dockPinned[i])) {
    return;
  }
  dockPinned = deduped;
  emit();
}

/** 固定 / 取消固定单个应用 */
export function toggleDockPinned(typeId: string): void {
  dockPinned = dockPinned.includes(typeId)
    ? dockPinned.filter((id) => id !== typeId)
    : [...dockPinned, typeId];
  emit();
}

/**
 * 稳定 setter：将固定区 from 索引项移到 to 索引（供拖拽落位）。
 * 越界 / 同索引为 no-op；持久化经既有 subscribeDockPinned → 快照路径。
 */
export function reorderDockPinned(from: number, to: number): void {
  const len = dockPinned.length;
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= len ||
    to >= len ||
    !Number.isInteger(from) ||
    !Number.isInteger(to)
  ) {
    return;
  }
  const next = dockPinned.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  dockPinned = next;
  emit();
}

export function subscribeDockPinned(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook：订阅固定区列表 */
export function useDockPinned(): string[] {
  return useSyncExternalStore(subscribeDockPinned, getDockPinned);
}

// ---------------------------------------------------------------------------
// 拖拽排序 + 固定加入动画
// ---------------------------------------------------------------------------

const REORDER_ATTR = 'data-wb-dock-pinned-id';
const DRAGGING_ATTR = 'data-wb-dock-pinned-dragging';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function motionDurationMs(fallback: number): number {
  if (typeof window === 'undefined') return 0;
  if (window.matchMedia?.(REDUCED_MOTION_QUERY)?.matches) return 0;
  if (document.documentElement.getAttribute('data-wb-material') === 'minimal') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--wb-motion-quick');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function motionEasing(): string {
  if (typeof window === 'undefined') return 'ease-out';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--wb-ease-overshoot');
  return raw.trim() || 'cubic-bezier(0.34, 1.56, 0.64, 1)';
}

function prefersInstantMotion(): boolean {
  return motionDurationMs(150) <= 0;
}

function collectPinnedWraps(dockRoot: HTMLElement): HTMLElement[] {
  return Array.from(dockRoot.querySelectorAll<HTMLElement>(`[${REORDER_ATTR}]`));
}

/** 取消元素上全部 WAAPI，避免 fill:forwards / 跨槽残留压住布局 */
function cancelElementAnimations(el: HTMLElement): void {
  if (typeof el.getAnimations !== 'function') return;
  try {
    for (const anim of el.getAnimations()) {
      try {
        anim.cancel();
      } catch {
        // noop
      }
    }
  } catch {
    // noop
  }
}

function clearSiblingTransforms(wraps: HTMLElement[], except?: HTMLElement): void {
  for (const el of wraps) {
    if (el === except) continue;
    cancelElementAnimations(el);
    el.style.transform = '';
    el.style.opacity = '';
    el.style.zIndex = '';
    el.style.transition = '';
  }
}

export interface DockPinnedDragBind {
  [REORDER_ATTR]: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

/**
 * DockItem 一行接线：仅固定区项返回拖拽 props；非固定返回空对象。
 *
 * ```tsx
 * <div {...useDockPinnedDragReorder(typeId)} />
 * ```
 *
 * 行为：主键按下后超过阈值进入拖拽 → 抬升当前项、兄弟项 WAAPI/直写 transform 让位 →
 * 松手提交 `reorderDockPinned`。挂载时播放固定加入动画（scale/opacity）。
 */
export function useDockPinnedDragReorder(typeId: string): DockPinnedDragBind | Record<string, never> {
  const pinned = useDockPinned();
  const isPinned = pinned.includes(typeId);
  const wrapRef = React.useRef<HTMLElement | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    originIndex: number;
    currentIndex: number;
    active: boolean;
    width: number;
    wraps: HTMLElement[];
    suppressClick: boolean;
    /** pointermove 最新 clientX；rAF 合帧消费 */
    latestClientX: number;
    rafId: number | null;
    /** 拖拽启动阈值：pointerdown 时按指针类型取档（触屏 14px / 鼠标笔 5px） */
    thresholdPx: number;
  } | null>(null);

  // 固定加入 / 取消固定移除动画（仅 transform/opacity；reduced-motion / minimal 跳过）
  const wasPinnedRef = React.useRef(isPinned);
  React.useEffect(() => {
    const el =
      wrapRef.current ??
      document.querySelector<HTMLElement>(
        `[${REORDER_ATTR}="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(typeId) : typeId}"]`,
      );
    if (el) wrapRef.current = el;

    const prev = wasPinnedRef.current;
    wasPinnedRef.current = isPinned;

    if (!el || prefersInstantMotion() || typeof el.animate !== 'function') return undefined;
    const duration = motionDurationMs(150);
    if (duration <= 0) return undefined;

    // 新固定 / 首次挂载即固定 → 加入
    if (isPinned && (!prev || prev === isPinned)) {
      // 仅在 false→true 或挂载时播放；reorder 保 isPinned 不变不重播
      if (prev === true) return undefined;
      const anim = el.animate(
        [
          { opacity: 0, transform: 'scale(0.72) translateY(6px)' },
          { opacity: 1, transform: 'scale(1) translateY(0)' },
        ],
        { duration, easing: motionEasing(), fill: 'both' },
      );
      const clear = () => {
        try {
          anim.cancel();
        } catch {
          // noop
        }
        el.style.opacity = '';
        el.style.transform = '';
      };
      anim.finished.then(clear).catch(clear);
      return clear;
    }

    // true→false：取消固定移除（项可能仍留在运行区，仅播一次缩小淡出再复位）
    if (!isPinned && prev === true) {
      const anim = el.animate(
        [
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0.55, transform: 'scale(0.82)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: duration * 1.2, easing: motionEasing(), fill: 'both' },
      );
      const clear = () => {
        try {
          anim.cancel();
        } catch {
          // noop
        }
        el.style.opacity = '';
        el.style.transform = '';
      };
      anim.finished.then(clear).catch(clear);
      return clear;
    }

    return undefined;
  }, [isPinned, typeId]);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!isPinned) return;
      if (event.button !== 0) return;
      // 弹层 / 菜单内不启动拖拽
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-testid="wb-dock-window-list"], [role="menu"]')) return;

      const wrap = event.currentTarget;
      wrapRef.current = wrap;
      const dockRoot = wrap.closest('.wb-dock') as HTMLElement | null;
      if (!dockRoot) return;

      const wraps = collectPinnedWraps(dockRoot);
      const originIndex = wraps.indexOf(wrap);
      if (originIndex < 0) return;

      // 槽位步长 = 项宽 + flex gap：只按 width 折算会在多格拖动时目标索引偏一格。
      // 相邻 wrap 中心差是含 gap 的真实步长；单项时回退 width。
      const rect = wrap.getBoundingClientRect();
      const width = rect.width || 44;
      let slotStride = width;
      if (wraps.length >= 2) {
        const a = wraps[0].getBoundingClientRect();
        const b = wraps[1].getBoundingClientRect();
        const stride = Math.abs(b.left + b.width / 2 - (a.left + a.width / 2));
        if (stride > 1) slotStride = stride;
      }
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        originIndex,
        currentIndex: originIndex,
        active: false,
        width: slotStride,
        wraps,
        suppressClick: false,
        latestClientX: event.clientX,
        rafId: null,
        thresholdPx: dockDragThresholdPx(event.pointerType),
      };

      const applySiblingShift = (nextIndex: number) => {
        const drag = dragRef.current;
        if (!drag) return;
        for (let i = 0; i < drag.wraps.length; i++) {
          const sibling = drag.wraps[i];
          if (sibling === wrap) continue;
          let shift = 0;
          if (drag.originIndex < nextIndex && i > drag.originIndex && i <= nextIndex) {
            shift = -drag.width;
          } else if (drag.originIndex > nextIndex && i >= nextIndex && i < drag.originIndex) {
            shift = drag.width;
          }
          if (prefersInstantMotion()) {
            cancelElementAnimations(sibling);
            sibling.style.transition = 'none';
            sibling.style.transform = shift ? `translate3d(${shift}px, 0, 0)` : '';
          } else if (typeof sibling.animate === 'function') {
            // 跨槽前先 cancel，避免动画对象累积 + forwards 残留
            cancelElementAnimations(sibling);
            const from = sibling.style.transform || 'translate3d(0px, 0, 0)';
            const to = shift ? `translate3d(${shift}px, 0, 0)` : 'translate3d(0px, 0, 0)';
            // inline style 为唯一真相源；fill:none 动画结束后不压住布局
            sibling.style.transform = to;
            sibling.animate([{ transform: from }, { transform: to }], {
              duration: motionDurationMs(150),
              easing: motionEasing(),
              fill: 'none',
            });
          } else {
            sibling.style.transform = shift ? `translate3d(${shift}px, 0, 0)` : '';
          }
        }
      };

      const flushFrame = () => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.rafId = null;
        const dx = drag.latestClientX - drag.startX;

        if (!drag.active) {
          // 触屏阈值 14px（> 长按容差 10px，见 dockGestures）：想长按开窗口
          // 列表的手指抖动不会误启动重排；鼠标 / 笔维持 5px 灵敏手感。
          if (Math.abs(dx) < drag.thresholdPx) return;
          drag.active = true;
          drag.suppressClick = true;
          wrap.setAttribute(DRAGGING_ATTR, '');
          wrap.style.zIndex = '2';
          wrap.style.transition = 'none';
          try {
            wrap.setPointerCapture(drag.pointerId);
          } catch {
            // noop
          }
        }

        const liftY = prefersInstantMotion() ? 0 : -8;
        wrap.style.transform = `translate3d(${dx}px, ${liftY}px, 0) scale(1.06)`;
        wrap.style.opacity = '0.92';

        // 目标索引：按水平位移 / 项宽估算，再钳到合法范围
        const deltaSlots = Math.round(dx / Math.max(drag.width, 1));
        const nextIndex = Math.max(0, Math.min(drag.wraps.length - 1, drag.originIndex + deltaSlots));
        if (nextIndex === drag.currentIndex) return;
        drag.currentIndex = nextIndex;
        applySiblingShift(nextIndex);
      };

      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.latestClientX = ev.clientX;
        if (drag.rafId != null) return;
        drag.rafId = window.requestAnimationFrame(flushFrame);
      };

      const finish = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || ev.pointerId !== drag.pointerId) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);

        if (drag.rafId != null) {
          window.cancelAnimationFrame(drag.rafId);
          drag.rafId = null;
        }

        const { originIndex, currentIndex, wraps: dragWraps, active, suppressClick } = drag;
        dragRef.current = null;

        wrap.removeAttribute(DRAGGING_ATTR);
        cancelElementAnimations(wrap);
        wrap.style.zIndex = '';
        wrap.style.opacity = '';
        wrap.style.transition = '';
        wrap.style.transform = '';
        // drop 后强制清理全部兄弟动画 + inline，避免 React 重排后残留叠加
        clearSiblingTransforms(dragWraps);

        try {
          wrap.releasePointerCapture(ev.pointerId);
        } catch {
          // noop
        }

        if (active && originIndex !== currentIndex) {
          reorderDockPinned(originIndex, currentIndex);
        }

        // 拖拽后吞掉紧随的 click，避免误触发 launch/focus
        if (suppressClick) {
          const swallow = (clickEv: MouseEvent) => {
            clickEv.preventDefault();
            clickEv.stopPropagation();
            window.removeEventListener('click', swallow, true);
          };
          window.addEventListener('click', swallow, true);
          window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
        }
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [isPinned],
  );

  // 用 callback 形式在 pointerdown 时记下 wrap；同时提供 data 属性供 Dock 查询
  const setRefOnDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      wrapRef.current = event.currentTarget;
      onPointerDown(event);
    },
    [onPointerDown],
  );

  // 非固定项：仍挂 ref 探测（加入动画仅 isPinned）；不绑定拖拽
  React.useLayoutEffect(() => {
    // 若父级已渲染 data 属性，尝试找回 wrap（供挂载动画）
    if (!isPinned || wrapRef.current) return;
    const escape =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : (s: string) => s;
    const el = document.querySelector<HTMLElement>(`[${REORDER_ATTR}="${escape(typeId)}"]`);
    if (el) wrapRef.current = el;
  }, [isPinned, typeId]);

  if (!isPinned) return {};

  return {
    [REORDER_ATTR]: typeId,
    onPointerDown: setRefOnDown,
  };
}
