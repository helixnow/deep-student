/**
 * Dock 固定区状态（P5 → O6 → Liquid Glass 打磨）
 *
 * 接线（P11）前为本地内存 state；P11 在快照恢复时调用 setDockPinned(snapshot.dockPinned)，
 * 并通过 subscribeDockPinned + getDockPinned 把变更写回快照。
 *
 * 拖拽生态增强：
 * - `reorderDockPinned(from, to)`：稳定 setter，供拖拽落位
 * - `pinDockItemAt(typeId, index)` / `unpinDockItem(typeId)`：供运行区拖入固定与向上拖离取消固定
 * - `useDockPinnedDragReorder(typeId)`：固定区指针拖拽排序 + 松手弹簧落位 +
 *   向上拖离 Dock 超过 72px 显示轻提示并触发轻量 Poof 消散动画取消固定
 * - `useDockRunningDragToPin(typeId)`：运行区（runningExtra）图标向左拖入固定区自动固定
 *
 * 动效纪律：
 * - 兄弟让位与弹簧落位：fill:'none'，inline style 为唯一真相源；跨槽 / 结束时 cancel 旧动画
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

/** 将应用固定到固定区指定位置（已固定则移动到目标索引；越界自动钳位） */
export function pinDockItemAt(typeId: string, index?: number): void {
  const existing = dockPinned.indexOf(typeId);
  const base = existing >= 0 ? dockPinned.filter((id) => id !== typeId) : dockPinned.slice();
  const target =
    typeof index === 'number' && Number.isFinite(index)
      ? Math.max(0, Math.min(base.length, Math.round(index)))
      : base.length;
  base.splice(target, 0, typeId);
  if (base.length === dockPinned.length && base.every((id, i) => id === dockPinned[i])) {
    return;
  }
  dockPinned = base;
  emit();
}

/** 取消固定单个应用（未固定时为 no-op） */
export function unpinDockItem(typeId: string): void {
  if (!dockPinned.includes(typeId)) return;
  dockPinned = dockPinned.filter((id) => id !== typeId);
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
// 拖拽排序 + 拖入固定 + 拖离取消固定（Poof）+ 弹簧落位
// ---------------------------------------------------------------------------

/** 向上拖离 Dock 超过该阈值（px）松手触发取消固定与 Poof 消散动画 */
export const DOCK_UNPIN_PULL_THRESHOLD_PX = 72;

const REORDER_ATTR = 'data-wb-dock-pinned-id';
const RUNNING_ATTR = 'data-wb-dock-running-id';
const DRAGGING_ATTR = 'data-wb-dock-pinned-dragging';
const UNPIN_READY_ATTR = 'data-wb-dock-unpin-ready';
const PIN_READY_ATTR = 'data-wb-dock-pin-ready';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const POOF_CLEANUP_MS = 440;

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

function springSettleEasing(): string {
  if (typeof window === 'undefined') return 'ease-out';
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--wb-ease-spring');
  return raw.trim() || 'cubic-bezier(0.32, 1.12, 0.36, 1)';
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

function animateSiblingShift(sibling: HTMLElement, shiftPx: number): void {
  if (prefersInstantMotion()) {
    cancelElementAnimations(sibling);
    sibling.style.transition = 'none';
    sibling.style.transform = shiftPx ? `translate3d(${shiftPx}px, 0, 0)` : '';
  } else if (typeof sibling.animate === 'function') {
    cancelElementAnimations(sibling);
    const from = sibling.style.transform || 'translate3d(0px, 0, 0)';
    const to = shiftPx ? `translate3d(${shiftPx}px, 0, 0)` : 'translate3d(0px, 0, 0)';
    sibling.style.transform = to;
    sibling.animate([{ transform: from }, { transform: to }], {
      duration: motionDurationMs(150),
      easing: motionEasing(),
      fill: 'none',
    });
  } else {
    sibling.style.transform = shiftPx ? `translate3d(${shiftPx}px, 0, 0)` : '';
  }
}

/** 松手弹簧落位过渡（fill:none，inline transform 先清零避免残留压住布局） */
function playSpringSettle(el: HTMLElement, fromX: number, fromY: number, fromScale: number): void {
  if (prefersInstantMotion() || typeof el.animate !== 'function') return;
  if (Math.abs(fromX) < 0.5 && Math.abs(fromY) < 0.5 && Math.abs(fromScale - 1) < 0.01) return;
  const duration = Math.max(motionDurationMs(150) * 1.65, 220);
  try {
    el.animate(
      [
        { transform: `translate3d(${fromX}px, ${fromY}px, 0) scale(${fromScale})` },
        { transform: 'translate3d(0px, 0px, 0) scale(1)' },
      ],
      {
        duration,
        easing: springSettleEasing(),
        fill: 'none',
      },
    );
  } catch {
    // noop
  }
}

/** 在松手位置触发轻量 Poof 消散动画（纯 CSS 关键帧，播完自清理） */
function spawnDockPoof(dockRoot: HTMLElement, clientX: number, clientY: number): void {
  if (typeof document === 'undefined' || prefersInstantMotion()) return;
  const host = dockRoot.parentElement ?? document.body;
  const hostRect = host.getBoundingClientRect();
  const poof = document.createElement('div');
  poof.className = 'wb-dock-poof';
  poof.setAttribute('aria-hidden', 'true');
  poof.setAttribute('data-testid', 'wb-dock-poof');
  poof.style.left = `${clientX - hostRect.left}px`;
  poof.style.top = `${clientY - hostRect.top}px`;

  for (let i = 0; i < 5; i += 1) {
    const puff = document.createElement('span');
    puff.className = 'wb-dock-poof-puff';
    poof.appendChild(puff);
  }

  host.appendChild(poof);
  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    poof.remove();
  };
  poof.addEventListener('animationend', cleanup, { once: true });
  window.setTimeout(cleanup, POOF_CLEANUP_MS);
}

/**
 * 统一绑定窗口级拖拽指针监听与拖拽后吞 click（集中复用，避免散点重复监听）。
 */
function bindWindowDragSession(
  onMove: (ev: PointerEvent) => void,
  onEnd: (ev: PointerEvent) => void,
  onBlurCancel?: () => void,
): () => void {
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
  if (onBlurCancel) {
    window.addEventListener('blur', onBlurCancel);
  }
  return () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onEnd);
    window.removeEventListener('pointercancel', onEnd);
    if (onBlurCancel) {
      window.removeEventListener('blur', onBlurCancel);
    }
  };
}

function swallowNextWindowClick(): void {
  const swallow = (clickEv: MouseEvent) => {
    clickEv.preventDefault();
    clickEv.stopPropagation();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

function measureSlotStride(wraps: HTMLElement[], fallbackWidth: number): number {
  if (wraps.length >= 2) {
    const a = wraps[0].getBoundingClientRect();
    const b = wraps[1].getBoundingClientRect();
    const stride = Math.abs(b.left + b.width / 2 - (a.left + a.width / 2));
    if (stride > 1) return stride;
  }
  return fallbackWidth || 44;
}

export interface DockPinnedDragBind {
  [REORDER_ATTR]: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

export interface DockRunningDragBind {
  [RUNNING_ATTR]: string;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

/**
 * DockItem 固定区拖拽排序接线：仅固定区项返回拖拽 props；非固定返回空对象。
 *
 * 行为：
 * - 横向拖动重排固定区顺序，兄弟项平滑让位，松手触发弹簧落位过渡；
 * - 向上拖离 Dock 超过 72px 显示轻提示，松手触发轻量 Poof 消散动画并取消固定；
 * - 挂载/新固定时播放加入动画（scale/opacity）。
 */
export function useDockPinnedDragReorder(typeId: string): DockPinnedDragBind | Record<string, never> {
  const pinned = useDockPinned();
  const isPinned = pinned.includes(typeId);
  const wrapRef = React.useRef<HTMLElement | null>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originIndex: number;
    currentIndex: number;
    active: boolean;
    willUnpin: boolean;
    width: number;
    wraps: HTMLElement[];
    suppressClick: boolean;
    latestClientX: number;
    latestClientY: number;
    lastRenderedDx: number;
    lastRenderedY: number;
    lastRenderedScale: number;
    rafId: number | null;
    thresholdPx: number;
    unbind: (() => void) | null;
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
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-testid="wb-dock-window-list"], [role="menu"]')) return;

      const wrap = event.currentTarget;
      wrapRef.current = wrap;
      const dockRoot = wrap.closest('.wb-dock') as HTMLElement | null;
      if (!dockRoot) return;

      const wraps = collectPinnedWraps(dockRoot);
      const originIndex = wraps.indexOf(wrap);
      if (originIndex < 0) return;

      const rect = wrap.getBoundingClientRect();
      const slotStride = measureSlotStride(wraps, rect.width || 44);
      const startY = typeof event.clientY === 'number' ? event.clientY : 0;

      if (dragRef.current) {
        dragRef.current.unbind?.();
        if (dragRef.current.rafId != null) {
          window.cancelAnimationFrame(dragRef.current.rafId);
        }
        dragRef.current = null;
      }

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY,
        originIndex,
        currentIndex: originIndex,
        active: false,
        willUnpin: false,
        width: slotStride,
        wraps,
        suppressClick: false,
        latestClientX: event.clientX,
        latestClientY: startY,
        lastRenderedDx: 0,
        lastRenderedY: 0,
        lastRenderedScale: 1,
        rafId: null,
        thresholdPx: dockDragThresholdPx(event.pointerType),
        unbind: null,
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
          animateSiblingShift(sibling, shift);
        }
      };

      const flushFrame = () => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.rafId = null;
        const dx = drag.latestClientX - drag.startX;
        const dy = drag.latestClientY - drag.startY;
        const pullUpPx = -dy;

        if (!drag.active) {
          if (Math.hypot(dx, dy) < drag.thresholdPx) return;
          drag.active = true;
          drag.suppressClick = true;
          wrap.setAttribute(DRAGGING_ATTR, '');
          wrap.style.zIndex = '4';
          wrap.style.transition = 'none';
          try {
            wrap.setPointerCapture(drag.pointerId);
          } catch {
            // noop
          }
        }

        const nextWillUnpin = pullUpPx > DOCK_UNPIN_PULL_THRESHOLD_PX;
        if (nextWillUnpin !== drag.willUnpin) {
          drag.willUnpin = nextWillUnpin;
          if (nextWillUnpin) {
            wrap.setAttribute(UNPIN_READY_ATTR, 'true');
            // 准备拖离取消固定：恢复兄弟槽位，给出脱离 Dock 的视觉反馈
            if (drag.currentIndex !== drag.originIndex) {
              drag.currentIndex = drag.originIndex;
              applySiblingShift(drag.originIndex);
            }
          } else {
            wrap.removeAttribute(UNPIN_READY_ATTR);
          }
        }

        if (drag.willUnpin) {
          const renderedY = prefersInstantMotion() ? 0 : dy;
          drag.lastRenderedDx = dx;
          drag.lastRenderedY = renderedY;
          drag.lastRenderedScale = 0.92;
          wrap.style.transform = `translate3d(${dx}px, ${renderedY}px, 0) scale(0.92)`;
          wrap.style.opacity = '0.78';
          return;
        }

        const liftY = prefersInstantMotion()
          ? 0
          : dy < 0
            ? Math.max(-DOCK_UNPIN_PULL_THRESHOLD_PX, -8 + dy * 0.45)
            : -8;
        drag.lastRenderedDx = dx;
        drag.lastRenderedY = liftY;
        drag.lastRenderedScale = 1.06;
        wrap.style.transform = `translate3d(${dx}px, ${liftY}px, 0) scale(1.06)`;
        wrap.style.opacity = '0.92';

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
        if (typeof ev.clientY === 'number') drag.latestClientY = ev.clientY;
        if (drag.rafId != null) return;
        let ranSync = false;
        const id = window.requestAnimationFrame(() => {
          ranSync = true;
          flushFrame();
        });
        if (dragRef.current === drag) {
          drag.rafId = ranSync ? null : id;
        }
      };

      const finish = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.unbind?.();

        if (drag.rafId != null) {
          window.cancelAnimationFrame(drag.rafId);
          drag.rafId = null;
        }

        const {
          originIndex: origIdx,
          currentIndex: currIdx,
          wraps: dragWraps,
          active,
          willUnpin,
          suppressClick,
          width: stride,
          lastRenderedDx,
          lastRenderedY,
          lastRenderedScale,
        } = drag;
        const dropX = typeof ev.clientX === 'number' ? ev.clientX : drag.latestClientX;
        const dropY = typeof ev.clientY === 'number' ? ev.clientY : drag.latestClientY;
        const isCancelled = ev.type === 'pointercancel';
        dragRef.current = null;

        wrap.removeAttribute(DRAGGING_ATTR);
        wrap.removeAttribute(UNPIN_READY_ATTR);
        cancelElementAnimations(wrap);
        wrap.style.zIndex = '';
        wrap.style.opacity = '';
        wrap.style.transition = '';
        wrap.style.transform = '';
        clearSiblingTransforms(dragWraps);

        try {
          wrap.releasePointerCapture(ev.pointerId);
        } catch {
          // noop
        }

        if (active && willUnpin && !isCancelled) {
          spawnDockPoof(dockRoot, dropX, dropY);
          unpinDockItem(typeId);
        } else if (active) {
          const moved = !isCancelled && origIdx !== currIdx;
          if (moved) {
            reorderDockPinned(origIdx, currIdx);
          }
          const targetSlotDx = moved ? (currIdx - origIdx) * stride : 0;
          playSpringSettle(wrap, lastRenderedDx - targetSlotDx, lastRenderedY, lastRenderedScale);
        }

        if (suppressClick) {
          swallowNextWindowClick();
        }
      };

      dragRef.current.unbind = bindWindowDragSession(onMove, finish, () => {
        const drag = dragRef.current;
        if (!drag) return;
        finish({
          type: 'pointercancel',
          pointerId: drag.pointerId,
          clientX: drag.latestClientX,
          clientY: drag.latestClientY,
        } as PointerEvent);
      });
    },
    [isPinned, typeId],
  );

  React.useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.unbind?.();
      if (drag.rafId != null) {
        window.cancelAnimationFrame(drag.rafId);
      }
      dragRef.current = null;
    },
    [],
  );

  const setRefOnDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      wrapRef.current = event.currentTarget;
      onPointerDown(event);
    },
    [onPointerDown],
  );

  React.useLayoutEffect(() => {
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

/**
 * 运行区（runningExtra）图标拖入固定区自动固定接线。
 * 仅非固定项返回拖拽 props；固定项返回空对象（由 useDockPinnedDragReorder 负责）。
 */
export function useDockRunningDragToPin(typeId: string): DockRunningDragBind | Record<string, never> {
  const pinned = useDockPinned();
  const isPinned = pinned.includes(typeId);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    pinReady: boolean;
    insertIndex: number | null;
    stride: number;
    pinnedWraps: HTMLElement[];
    pinnedCenters: number[];
    pinnedRightEdge: number;
    suppressClick: boolean;
    latestClientX: number;
    latestClientY: number;
    lastRenderedDx: number;
    lastRenderedY: number;
    rafId: number | null;
    thresholdPx: number;
    unbind: (() => void) | null;
  } | null>(null);

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (isPinned) return;
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-testid="wb-dock-window-list"], [role="menu"]')) return;

      const wrap = event.currentTarget;
      const dockRoot = wrap.closest('.wb-dock') as HTMLElement | null;
      if (!dockRoot) return;

      const pinnedWraps = collectPinnedWraps(dockRoot);
      const wrapRect = wrap.getBoundingClientRect();
      const stride = measureSlotStride(pinnedWraps, wrapRect.width || 44);
      const pinnedCenters = pinnedWraps.map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      });
      const pinnedRightEdge =
        pinnedWraps.length > 0
          ? pinnedWraps[pinnedWraps.length - 1].getBoundingClientRect().right + 12
          : wrapRect.left - stride * 0.5;
      const startY = typeof event.clientY === 'number' ? event.clientY : 0;

      if (dragRef.current) {
        dragRef.current.unbind?.();
        if (dragRef.current.rafId != null) {
          window.cancelAnimationFrame(dragRef.current.rafId);
        }
        dragRef.current = null;
      }

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY,
        active: false,
        pinReady: false,
        insertIndex: null,
        stride,
        pinnedWraps,
        pinnedCenters,
        pinnedRightEdge,
        suppressClick: false,
        latestClientX: event.clientX,
        latestClientY: startY,
        lastRenderedDx: 0,
        lastRenderedY: 0,
        rafId: null,
        thresholdPx: dockDragThresholdPx(event.pointerType),
        unbind: null,
      };

      const shiftPinnedForInsertion = (insertIndex: number | null) => {
        const drag = dragRef.current;
        if (!drag) return;
        for (let i = 0; i < drag.pinnedWraps.length; i += 1) {
          const shift = insertIndex !== null && i >= insertIndex ? drag.stride * 0.55 : 0;
          animateSiblingShift(drag.pinnedWraps[i], shift);
        }
      };

      const flushFrame = () => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.rafId = null;
        const dx = drag.latestClientX - drag.startX;
        const dy = drag.latestClientY - drag.startY;

        if (!drag.active) {
          if (Math.hypot(dx, dy) < drag.thresholdPx) return;
          drag.active = true;
          drag.suppressClick = true;
          wrap.setAttribute(DRAGGING_ATTR, '');
          wrap.style.zIndex = '4';
          wrap.style.transition = 'none';
          try {
            wrap.setPointerCapture(drag.pointerId);
          } catch {
            // noop
          }
        }

        const liftY = prefersInstantMotion() ? 0 : -8;
        drag.lastRenderedDx = dx;
        drag.lastRenderedY = liftY;
        wrap.style.transform = `translate3d(${dx}px, ${liftY}px, 0) scale(1.06)`;
        wrap.style.opacity = '0.94';

        const pullUpPx = -dy;
        let nextInsertIndex: number | null = null;
        if (pullUpPx <= DOCK_UNPIN_PULL_THRESHOLD_PX) {
          if (drag.pinnedWraps.length > 0 && drag.latestClientX <= drag.pinnedRightEdge) {
            let idx = drag.pinnedCenters.length;
            for (let i = 0; i < drag.pinnedCenters.length; i += 1) {
              if (drag.latestClientX < drag.pinnedCenters[i]) {
                idx = i;
                break;
              }
            }
            nextInsertIndex = idx;
          } else if (drag.pinnedWraps.length === 0 && dx <= -(drag.stride * 0.6)) {
            nextInsertIndex = 0;
          }
        }

        const nextPinReady = nextInsertIndex !== null;
        if (nextPinReady !== drag.pinReady || nextInsertIndex !== drag.insertIndex) {
          drag.pinReady = nextPinReady;
          drag.insertIndex = nextInsertIndex;
          if (nextPinReady) {
            wrap.setAttribute(PIN_READY_ATTR, 'true');
          } else {
            wrap.removeAttribute(PIN_READY_ATTR);
          }
          shiftPinnedForInsertion(nextInsertIndex);
        }
      };

      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.latestClientX = ev.clientX;
        if (typeof ev.clientY === 'number') drag.latestClientY = ev.clientY;
        if (drag.rafId != null) return;
        let ranSync = false;
        const id = window.requestAnimationFrame(() => {
          ranSync = true;
          flushFrame();
        });
        if (dragRef.current === drag) {
          drag.rafId = ranSync ? null : id;
        }
      };

      const finish = (ev: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag || ev.pointerId !== drag.pointerId) return;
        drag.unbind?.();

        if (drag.rafId != null) {
          window.cancelAnimationFrame(drag.rafId);
          drag.rafId = null;
        }

        const {
          active,
          pinReady,
          insertIndex,
          pinnedWraps: dragPinnedWraps,
          suppressClick,
          lastRenderedDx,
          lastRenderedY,
        } = drag;
        const isCancelled = ev.type === 'pointercancel';
        dragRef.current = null;

        wrap.removeAttribute(DRAGGING_ATTR);
        wrap.removeAttribute(PIN_READY_ATTR);
        cancelElementAnimations(wrap);
        wrap.style.zIndex = '';
        wrap.style.opacity = '';
        wrap.style.transition = '';
        wrap.style.transform = '';
        clearSiblingTransforms(dragPinnedWraps);

        try {
          wrap.releasePointerCapture(ev.pointerId);
        } catch {
          // noop
        }

        if (active && pinReady && insertIndex !== null && !isCancelled) {
          pinDockItemAt(typeId, insertIndex);
        } else if (active) {
          playSpringSettle(wrap, lastRenderedDx, lastRenderedY, 1.06);
        }

        if (suppressClick) {
          swallowNextWindowClick();
        }
      };

      dragRef.current.unbind = bindWindowDragSession(onMove, finish, () => {
        const drag = dragRef.current;
        if (!drag) return;
        finish({
          type: 'pointercancel',
          pointerId: drag.pointerId,
          clientX: drag.latestClientX,
          clientY: drag.latestClientY,
        } as PointerEvent);
      });
    },
    [isPinned, typeId],
  );

  React.useEffect(
    () => () => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.unbind?.();
      if (drag.rafId != null) {
        window.cancelAnimationFrame(drag.rafId);
      }
      dragRef.current = null;
    },
    [],
  );

  if (isPinned) return {};

  return {
    [RUNNING_ATTR]: typeId,
    onPointerDown,
  };
}
