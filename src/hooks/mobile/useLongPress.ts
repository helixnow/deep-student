/**
 * useLongPress — 触控长按 hook（长按呼出上下文菜单 / 进入多选等）。
 *
 * 目标：收敛 TreeRow（src/features/workbench/apps/notes/tree/TreeRow.tsx）等处
 * 手写的 setTimeout 长按实现（本轮只提供基建，后续轮次再接线；
 * 历史第二份实现位于 notes/DndFileTree/TreeNode.tsx，该组件已于 2026-08 零挂载删除）。
 *
 * 行为：
 * - 按下后 `delay`（默认 450ms）触发 `onLongPress`，携带按下坐标；
 * - 按住期间移动超过 `moveTolerance`（默认 10px）即取消（滚动/拖拽让位）；
 * - 优先走 Pointer Events（同时覆盖鼠标/触摸/笔），在不支持 PointerEvent
 *   的环境自动降级为 Touch Events，两套不会重复触发；
 * - 触发过长按的这次交互会抑制后续 click（避免"长按弹菜单又触发点击"）。
 *
 * 接入示例：
 * ```tsx
 * const longPress = useLongPress({
 *   onLongPress: ({ x, y }) => openContextMenu(x, y),
 * });
 * return <div {...longPress.bind}>…</div>;
 * ```
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type * as React from 'react';

export interface LongPressPoint {
  x: number;
  y: number;
}

export interface UseLongPressOptions {
  /** 长按触发回调，参数为按下时的视口坐标。 */
  onLongPress: (point: LongPressPoint) => void;
  /** 触发时长（ms），默认 450。 */
  delay?: number;
  /** 按住期间允许的移动容差（px），超过即取消，默认 10。 */
  moveTolerance?: number;
  /** 为 true 时完全禁用（不启动计时器）。 */
  disabled?: boolean;
  /**
   * 是否抑制浏览器原生 contextmenu（默认 true）。
   * 移动端长按会同时触发原生 contextmenu / 文本选择菜单，与自定义菜单竞争。
   */
  preventContextMenu?: boolean;
}

export interface LongPressBind {
  onPointerDown: React.PointerEventHandler;
  onPointerMove: React.PointerEventHandler;
  onPointerUp: React.PointerEventHandler;
  onPointerCancel: React.PointerEventHandler;
  onPointerLeave: React.PointerEventHandler;
  onTouchStart: React.TouchEventHandler;
  onTouchMove: React.TouchEventHandler;
  onTouchEnd: React.TouchEventHandler;
  onTouchCancel: React.TouchEventHandler;
  onContextMenu: React.MouseEventHandler;
  onClickCapture: React.MouseEventHandler;
}

export interface UseLongPressResult {
  /** 展开到目标元素上的事件绑定。 */
  bind: LongPressBind;
  /** 手动取消当前计时（如外部滚动开始时）。 */
  cancel: () => void;
}

const DEFAULT_DELAY = 450;
const DEFAULT_MOVE_TOLERANCE = 10;

function supportsPointerEvents(): boolean {
  return typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined';
}

export function useLongPress(options: UseLongPressOptions): UseLongPressResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPointRef = useRef<LongPressPoint | null>(null);
  /** 本次交互是否已触发过长按（用于抑制随后的 click / contextmenu）。 */
  const firedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPointRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    (x: number, y: number) => {
      if (optionsRef.current.disabled) return;
      cancel();
      firedRef.current = false;
      startPointRef.current = { x, y };
      const delay = optionsRef.current.delay ?? DEFAULT_DELAY;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const point = startPointRef.current;
        startPointRef.current = null;
        if (!point) return;
        firedRef.current = true;
        optionsRef.current.onLongPress(point);
      }, delay);
    },
    [cancel],
  );

  const move = useCallback(
    (x: number, y: number) => {
      const startPoint = startPointRef.current;
      if (!startPoint || timerRef.current === null) return;
      const tolerance = optionsRef.current.moveTolerance ?? DEFAULT_MOVE_TOLERANCE;
      if (Math.abs(x - startPoint.x) > tolerance || Math.abs(y - startPoint.y) > tolerance) {
        cancel();
      }
    },
    [cancel],
  );

  const bind = useMemo<LongPressBind>(
    () => ({
      onPointerDown: (e) => {
        // 鼠标仅响应主键；右键交给原生 contextmenu
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        start(e.clientX, e.clientY);
      },
      onPointerMove: (e) => {
        move(e.clientX, e.clientY);
      },
      onPointerUp: () => cancel(),
      onPointerCancel: () => cancel(),
      onPointerLeave: () => cancel(),

      // Touch 降级路径：支持 PointerEvent 的环境直接忽略，避免双触发
      onTouchStart: (e) => {
        if (supportsPointerEvents()) return;
        const t = e.touches[0];
        if (t) start(t.clientX, t.clientY);
      },
      onTouchMove: (e) => {
        if (supportsPointerEvents()) return;
        const t = e.touches[0];
        if (t) move(t.clientX, t.clientY);
      },
      onTouchEnd: () => {
        if (supportsPointerEvents()) return;
        cancel();
      },
      onTouchCancel: () => {
        if (supportsPointerEvents()) return;
        cancel();
      },

      onContextMenu: (e) => {
        if (optionsRef.current.preventContextMenu ?? true) {
          e.preventDefault();
        }
      },
      onClickCapture: (e) => {
        if (firedRef.current) {
          firedRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    [start, move, cancel],
  );

  return { bind, cancel };
}

export default useLongPress;
