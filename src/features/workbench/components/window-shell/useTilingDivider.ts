/**
 * useTilingDivider（主责 P2 / O4 打磨）— 左右平铺对的中缝拖拽
 *
 * 拖动中缝 → softClampTilingRatio 软区 rubber-band → rAF 直写两侧窗口 DOM
 * （读 [data-wb-window-id]，写 left/width）；松手 settle 也走 DOM，末帧才
 * commit store.setTilingRatio（避免缓动期每帧刷 Desktop/Dock）。
 * 释放时帧步进 settle 回硬约束 clampTilingRatio；双击复位 50/50；
 * 拖动态挂 wb-tile-divider-active（grip 高亮由 SnapPreview.css / workbench.css 承接）。
 *
 * 用法（P3/P11 的中缝元素）：
 *   const divider = useTilingDivider(leftId, rightId, { margin });
 *   <div
 *     data-wb-tiling-divider
 *     tabIndex={0}
 *     onPointerDown={divider.onPointerDown}
 *     onKeyDown={divider.onKeyDown}
 *   />
 */
import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import { useWindowStore } from '../../core/windowStore';
import {
  clampTilingRatio,
  computeTiledFrame,
  DEFAULT_TILE_MARGIN,
  softClampTilingRatio,
  tilingPairKey,
} from '../../core/tiling';
import { prefersReducedMotion } from '../../core/pointerEngine';

export interface UseTilingDividerOptions {
  /** 桌面区左上角相对视口的偏移（clientX → 桌面坐标），缺省 (0,0) */
  getDesktopOffset?: () => { x: number; y: number };
  /** 平铺间距（与 Desktop / WindowShell 一致），缺省 DEFAULT_TILE_MARGIN */
  margin?: number;
}

export interface UseTilingDividerResult {
  /** 绑定到中缝元素 */
  onPointerDown: (e: React.PointerEvent) => void;
  /** 键盘微调：ArrowLeft/Right 步进约 2%（硬约束 clamp） */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** 当前分割比（响应式；拖动期间保持松手前值，松手后更新） */
  ratio: number;
  /** 非响应式查询：是否正在拖动 */
  isDragging: () => boolean;
}

/** 键盘微调步长（ratio 单位，约 2%） */
const KEYBOARD_RATIO_STEP = 0.02;

/** 双击判定窗口（ms） */
const DBLCLICK_MS = 400;
/** 判定为「点击」而非拖动的最大位移（px） */
const CLICK_MOVE_TOLERANCE_PX = 4;
/** settle tween 时长（ms）；reduced-motion 下跳变 */
const SETTLE_DURATION_MS = 180;
/** 拖动态 class（与 SnapPreview.css / workbench.css 对齐） */
export const TILING_DIVIDER_ACTIVE_CLASS = 'wb-tile-divider-active';

interface DividerDrag {
  pointerId: number;
  captureTarget: Element | null;
  startRatio: number;
  startClientX: number;
  lastClientX: number;
  moved: boolean;
  rafId: number;
  pendingClientX: number | null;
  /** 最近一次 apply 用的 raw 指针占比（未 soft/hard），供释放 settle */
  lastRawRatio: number;
  /** 拖动中最近一次写入 DOM 的 soft ratio（松手 commit 用） */
  lastSoftRatio: number;
  leftEl: HTMLElement | null;
  rightEl: HTMLElement | null;
  margin: number;
}

interface SettleAnim {
  rafId: number;
  from: number;
  to: number;
  startMs: number;
}

interface LastClick {
  timeMs: number;
  clientX: number;
}

/** ease-out cubic：1 - (1-t)^3 */
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function setActiveClass(el: Element | null, on: boolean): void {
  if (!el || typeof (el as Element).classList?.toggle !== 'function') return;
  el.classList.toggle(TILING_DIVIDER_ACTIVE_CLASS, on);
}

function queryWindowEl(id: string): HTMLElement | null {
  const esc =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
  return document.querySelector<HTMLElement>(`[data-wb-window-id="${esc}"]`);
}

/** 按 ratio 直写左右窗 left/width（过程帧 0 React） */
function applyRatioToDom(
  leftEl: HTMLElement | null,
  rightEl: HTMLElement | null,
  ratio: number,
  margin: number,
): void {
  const desktop = useWindowStore.getState().desktopSize;
  const left = computeTiledFrame('tiled-left', { desktopSize: desktop, margin, ratio });
  const right = computeTiledFrame('tiled-right', { desktopSize: desktop, margin, ratio });
  if (leftEl && left) {
    leftEl.style.left = `${left.x}px`;
    leftEl.style.width = `${left.w}px`;
    leftEl.style.pointerEvents = 'none';
  }
  if (rightEl && right) {
    rightEl.style.left = `${right.x}px`;
    rightEl.style.width = `${right.w}px`;
    rightEl.style.pointerEvents = 'none';
  }
}

function clearDomPointerLock(leftEl: HTMLElement | null, rightEl: HTMLElement | null): void {
  if (leftEl) leftEl.style.pointerEvents = '';
  if (rightEl) rightEl.style.pointerEvents = '';
}

export function useTilingDivider(
  leftId: string,
  rightId: string,
  options?: UseTilingDividerOptions,
): UseTilingDividerResult {
  const key = tilingPairKey(leftId, rightId);
  const ratio = useWindowStore((s) => clampTilingRatio(s.tilingRatios[key] ?? 0.5));

  const keyRef = useRef(key);
  keyRef.current = key;
  const leftIdRef = useRef(leftId);
  leftIdRef.current = leftId;
  const rightIdRef = useRef(rightId);
  rightIdRef.current = rightId;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dragRef = useRef<DividerDrag | null>(null);
  const settleRef = useRef<SettleAnim | null>(null);
  const lastClickRef = useRef<LastClick | null>(null);

  const handlers = useMemo(() => {
    const stopSettle = () => {
      const settle = settleRef.current;
      if (!settle) return;
      if (settle.rafId !== 0) cancelAnimationFrame(settle.rafId);
      settleRef.current = null;
    };

    const writeRatio = (next: number) => {
      const s = useWindowStore.getState();
      const cur = s.tilingRatios[keyRef.current] ?? 0.5;
      if (next !== cur) s.setTilingRatio(keyRef.current, next);
    };

    const settleTo = (fromRatio: number, target: number) => {
      stopSettle();
      const to = clampTilingRatio(target);
      const from = clampTilingRatio(fromRatio);
      const margin = optionsRef.current?.margin ?? DEFAULT_TILE_MARGIN;
      const leftEl = queryWindowEl(leftIdRef.current);
      const rightEl = queryWindowEl(rightIdRef.current);
      if (from === to || prefersReducedMotion()) {
        applyRatioToDom(leftEl, rightEl, to, margin);
        clearDomPointerLock(leftEl, rightEl);
        writeRatio(to);
        return;
      }
      const anim: SettleAnim = {
        rafId: 0,
        from,
        to,
        startMs: performance.now(),
      };
      settleRef.current = anim;
      // settle 期继续锁内容命中，避免缓动中途点穿
      applyRatioToDom(leftEl, rightEl, from, margin);
      const step = (now: number) => {
        if (settleRef.current !== anim) return;
        const t = Math.min(1, (now - anim.startMs) / SETTLE_DURATION_MS);
        const next = anim.from + (anim.to - anim.from) * easeOutCubic(t);
        applyRatioToDom(leftEl, rightEl, t >= 1 ? anim.to : next, margin);
        if (t >= 1) {
          settleRef.current = null;
          clearDomPointerLock(leftEl, rightEl);
          writeRatio(anim.to);
          return;
        }
        anim.rafId = requestAnimationFrame(step);
      };
      anim.rafId = requestAnimationFrame(step);
    };

    const rawRatioFromClientX = (clientX: number): number | null => {
      const s = useWindowStore.getState();
      const desktopW = s.desktopSize.w;
      if (desktopW <= 0) return null;
      const offsetX = optionsRef.current?.getDesktopOffset?.().x ?? 0;
      return (clientX - offsetX) / desktopW;
    };

    const applyPoint = (clientX: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const raw = rawRatioFromClientX(clientX);
      if (raw === null) return;
      drag.lastRawRatio = raw;
      drag.lastClientX = clientX;
      if (Math.abs(clientX - drag.startClientX) > CLICK_MOVE_TOLERANCE_PX) {
        drag.moved = true;
      }
      const next = softClampTilingRatio(raw);
      drag.lastSoftRatio = next;
      // 过程帧：直写 DOM，不进 store（避免两侧窗口整树重渲染）
      applyRatioToDom(drag.leftEl, drag.rightEl, next, drag.margin);
    };

    const processFrame = () => {
      const drag = dragRef.current;
      if (!drag) return;
      drag.rafId = 0;
      if (drag.pendingClientX !== null) {
        const x = drag.pendingClientX;
        drag.pendingClientX = null;
        applyPoint(x);
      }
    };

    const teardown = () => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.rafId !== 0) cancelAnimationFrame(drag.rafId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      if (drag.captureTarget && typeof drag.captureTarget.releasePointerCapture === 'function') {
        try {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        } catch {
          // 已自动释放
        }
      }
      clearDomPointerLock(drag.leftEl, drag.rightEl);
      setActiveClass(drag.captureTarget, false);
      dragRef.current = null;
    };

    const cancelDrag = () => {
      const drag = dragRef.current;
      if (!drag) return;
      const startRatio = drag.startRatio;
      const leftEl = drag.leftEl;
      const rightEl = drag.rightEl;
      const margin = drag.margin;
      teardown();
      stopSettle();
      // 回退：先 DOM 回起始，再写 store（store 会驱动 React 与 DOM 对齐）
      applyRatioToDom(leftEl, rightEl, startRatio, margin);
      clearDomPointerLock(leftEl, rightEl);
      writeRatio(startRatio);
    };

    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      drag.pendingClientX = e.clientX;
      if (drag.rafId === 0) drag.rafId = requestAnimationFrame(processFrame);
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (drag.rafId !== 0) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = 0;
      }
      if (drag.pendingClientX !== null) {
        const x = drag.pendingClientX;
        drag.pendingClientX = null;
        applyPoint(x);
      } else {
        const raw = rawRatioFromClientX(e.clientX);
        if (raw !== null) {
          drag.lastRawRatio = raw;
          drag.lastClientX = e.clientX;
        }
      }

      const wasClick = !drag.moved;
      const clientX = drag.lastClientX;
      const rawForSettle = drag.lastRawRatio;
      const softForCommit = drag.lastSoftRatio;
      teardown();

      if (wasClick) {
        const prev = lastClickRef.current;
        const now = performance.now();
        if (
          prev &&
          now - prev.timeMs <= DBLCLICK_MS &&
          Math.abs(clientX - prev.clientX) <= CLICK_MOVE_TOLERANCE_PX
        ) {
          lastClickRef.current = null;
          const cur = clampTilingRatio(
            useWindowStore.getState().tilingRatios[keyRef.current] ?? 0.5,
          );
          settleTo(cur, 0.5);
          return;
        }
        lastClickRef.current = { timeMs: now, clientX };
        // 单击不改比例（避免点按中缝误写 store）
        return;
      }

      lastClickRef.current = null;
      // 松手：DOM settle 软区 → 硬约束，末帧才写 store
      settleTo(softForCommit, clampTilingRatio(rawForSettle));
    };

    const onCancel = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      cancelDrag();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!dragRef.current || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancelDrag();
    };

    const onPointerDown = (e: React.PointerEvent) => {
      if (dragRef.current) return;
      if (e.button != null && e.button > 0) return;
      stopSettle();
      const s = useWindowStore.getState();
      const target = e.currentTarget as Element;
      if (target && typeof target.setPointerCapture === 'function') {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
      const startRaw = rawRatioFromClientX(e.clientX) ?? 0.5;
      const startRatio = clampTilingRatio(s.tilingRatios[keyRef.current] ?? 0.5);
      const margin = optionsRef.current?.margin ?? DEFAULT_TILE_MARGIN;
      setActiveClass(target, true);
      dragRef.current = {
        pointerId: e.pointerId,
        captureTarget: target,
        startRatio,
        startClientX: e.clientX,
        lastClientX: e.clientX,
        moved: false,
        rafId: 0,
        pendingClientX: null,
        lastRawRatio: startRaw,
        lastSoftRatio: startRatio,
        leftEl: queryWindowEl(leftIdRef.current),
        rightEl: queryWindowEl(rightIdRef.current),
        margin,
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKeyDown, true);
      e.preventDefault();
    };

    const onDividerKeyDown = (e: React.KeyboardEvent) => {
      if (dragRef.current) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      stopSettle();
      const cur = clampTilingRatio(
        useWindowStore.getState().tilingRatios[keyRef.current] ?? 0.5,
      );
      const delta = e.key === 'ArrowLeft' ? -KEYBOARD_RATIO_STEP : KEYBOARD_RATIO_STEP;
      writeRatio(clampTilingRatio(cur + delta));
    };

    return {
      onPointerDown,
      onKeyDown: onDividerKeyDown,
      teardown: () => {
        stopSettle();
        teardown();
      },
      settleTo,
    };
  }, []);

  useEffect(() => {
    return () => {
      handlers.teardown();
    };
  }, [handlers]);

  return {
    onPointerDown: handlers.onPointerDown,
    onKeyDown: handlers.onKeyDown,
    ratio,
    isDragging: () => dragRef.current !== null,
  };
}
