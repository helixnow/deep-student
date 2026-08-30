/**
 * useSwipeGesture — 轴锁定滑动手势 hook（跟手位移 + fling 判定）。
 *
 * 从 MobileSlidingLayout（src/components/layout/MobileSlidingLayout.tsx）
 * 的成熟手势逻辑提炼为可复用基建：
 * - 轴锁定：起手位移超过 `axisLockDistance` 后一次性判定轴向，主轴位移
 *   须大于交叉轴 × `axisLockRatio` 才锁定；交叉轴胜出则放弃手势，让
 *   原生滚动接管；
 * - 跟手：锁定后每次移动回调 `onSwipeMove(delta)`，供调用方直接驱动
 *   translate；
 * - fling：指数平滑瞬时速度（0.7/0.3），松手前停顿 > `flingIdleMs` 视为
 *   无惯性；速度超 `flingVelocity`（默认 0.3px/ms）且与位移同向判定为
 *   fling，位移不足 `threshold` 也算滑动成功；
 * - 触摸监听以 `passive: false` 原生绑定（React 合成 touch 事件是 passive
 *   的，无法 preventDefault），锁定主轴后才阻止默认滚动；鼠标拖拽同样支持
 *   （便于桌面调试）。
 *
 * 接入示例：
 * ```tsx
 * const swipe = useSwipeGesture({
 *   axis: 'horizontal',
 *   threshold: 64,
 *   onSwipeMove: (dx) => setTranslate(base + dx),
 *   onSwipeEnd: ({ passed, direction }) => {
 *     if (passed) direction > 0 ? openPrev() : openNext();
 *     else snapBack();
 *   },
 * });
 * return <div ref={swipe.ref}>…</div>;
 * ```
 */

import { useCallback, useRef, useState } from 'react';

export type SwipeAxis = 'horizontal' | 'vertical';

export interface SwipeEndInfo {
  /** 主轴总位移（px，含符号）。 */
  delta: number;
  /** 松手时平滑速度（px/ms，含符号；停顿超时后为 0）。 */
  velocity: number;
  /** 是否为快速轻扫（速度超阈值且与位移同向）。 */
  isFling: boolean;
  /** 位移方向：1 正向（右/下）、-1 负向（左/上）、0 无位移。 */
  direction: -1 | 0 | 1;
  /** 是否判定为一次有效滑动（位移超 threshold 或 fling）。 */
  passed: boolean;
}

export interface UseSwipeGestureOptions {
  /** 手势轴向，默认 'horizontal'。 */
  axis?: SwipeAxis;
  /** 为 false 时不响应手势（监听器保留，运行时跳过），默认 true。 */
  enabled?: boolean;
  /** 松手位移判定阈值（px），默认 48。 */
  threshold?: number;
  /** fling 速度阈值（px/ms），默认 0.3。 */
  flingVelocity?: number;
  /** 轴向判定的最小起手位移（px），默认 10。 */
  axisLockDistance?: number;
  /** 主轴须超过交叉轴的倍数才锁定，默认 1.2。 */
  axisLockRatio?: number;
  /** 松手前停顿超过该时长（ms）视为无惯性，默认 100。 */
  flingIdleMs?: number;
  /** 轴锁定成功、开始跟手时回调。 */
  onSwipeStart?: () => void;
  /** 跟手位移回调（主轴 delta，px，含符号）。 */
  onSwipeMove?: (delta: number) => void;
  /** 手势结束回调（仅在轴锁定成功后触发）。 */
  onSwipeEnd?: (info: SwipeEndInfo) => void;
}

interface GestureState {
  tracking: boolean;
  axisLocked: SwipeAxis | 'rejected' | null;
  startX: number;
  startY: number;
  delta: number;
  lastPos: number;
  lastMoveTime: number;
  velocity: number;
}

const INITIAL_STATE: GestureState = {
  tracking: false,
  axisLocked: null,
  startX: 0,
  startY: 0,
  delta: 0,
  lastPos: 0,
  lastMoveTime: 0,
  velocity: 0,
};

export interface UseSwipeGestureResult<T extends HTMLElement> {
  /** 挂到手势容器上的 callback ref（负责原生监听器的绑定/清理）。 */
  ref: (node: T | null) => void;
  /** 轴锁定成功、正在跟手中（触发 re-render，可用于关闭 CSS transition）。 */
  isSwiping: boolean;
}

export function useSwipeGesture<T extends HTMLElement = HTMLElement>(
  options: UseSwipeGestureOptions = {},
): UseSwipeGestureResult<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef<GestureState>({ ...INITIAL_STATE });
  const [isSwiping, setIsSwiping] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    if (optionsRef.current.enabled === false) return;
    const s = stateRef.current;
    s.tracking = true;
    s.axisLocked = null;
    s.startX = clientX;
    s.startY = clientY;
    s.delta = 0;
    s.lastPos = optionsRef.current.axis === 'vertical' ? clientY : clientX;
    s.lastMoveTime = performance.now();
    s.velocity = 0;
  }, []);

  const handleMove = useCallback(
    (clientX: number, clientY: number, preventDefault: () => void) => {
      const s = stateRef.current;
      if (!s.tracking || s.axisLocked === 'rejected') return;

      const opts = optionsRef.current;
      const axis: SwipeAxis = opts.axis ?? 'horizontal';
      const deltaX = clientX - s.startX;
      const deltaY = clientY - s.startY;
      const main = axis === 'horizontal' ? deltaX : deltaY;
      const cross = axis === 'horizontal' ? deltaY : deltaX;

      // 轴向只判定一次
      if (s.axisLocked === null) {
        const lockDistance = opts.axisLockDistance ?? 10;
        if (Math.abs(deltaX) <= lockDistance && Math.abs(deltaY) <= lockDistance) {
          return;
        }
        const ratio = opts.axisLockRatio ?? 1.2;
        if (Math.abs(main) > Math.abs(cross) * ratio) {
          s.axisLocked = axis;
          setIsSwiping(true);
          opts.onSwipeStart?.();
        } else {
          // 交叉轴胜出：放弃手势，让原生滚动接管
          s.axisLocked = 'rejected';
          s.tracking = false;
          return;
        }
      }

      // 锁定主轴后阻止默认滚动
      preventDefault();

      // 指数平滑瞬时速度，抑制单帧抖动
      const now = performance.now();
      const dt = now - s.lastMoveTime;
      const pos = axis === 'horizontal' ? clientX : clientY;
      if (dt > 0) {
        const instantVelocity = (pos - s.lastPos) / dt;
        s.velocity = s.velocity * 0.7 + instantVelocity * 0.3;
      }
      s.lastPos = pos;
      s.lastMoveTime = now;
      s.delta = main;

      opts.onSwipeMove?.(main);
    },
    [],
  );

  const handleEnd = useCallback(() => {
    const s = stateRef.current;
    const wasSwiping = s.axisLocked !== null && s.axisLocked !== 'rejected';
    const opts = optionsRef.current;

    if (wasSwiping) {
      const flingThreshold = opts.flingVelocity ?? 0.3;
      const flingIdleMs = opts.flingIdleMs ?? 100;
      // 松手前停顿视为无惯性，避免"拖出去停住再松手"误判为 fling
      const flingExpired = performance.now() - s.lastMoveTime > flingIdleMs;
      const velocity = flingExpired ? 0 : s.velocity;
      const isFling =
        (velocity > flingThreshold && s.delta > 0) ||
        (velocity < -flingThreshold && s.delta < 0);
      const passed = Math.abs(s.delta) > (opts.threshold ?? 48) || isFling;
      const direction: -1 | 0 | 1 = s.delta > 0 ? 1 : s.delta < 0 ? -1 : 0;

      opts.onSwipeEnd?.({ delta: s.delta, velocity, isFling, direction, passed });
      setIsSwiping(false);
    }

    stateRef.current = { ...INITIAL_STATE };
  }, []);

  // 系统中断（通知栏下拉/来电/系统手势抢占）走取消路径：回弹归位，
  // 不做阈值/fling 提交——与 MobileSlidingLayout 的 touchcancel 语义对齐
  const handleCancel = useCallback(() => {
    const s = stateRef.current;
    const wasSwiping = s.axisLocked !== null && s.axisLocked !== 'rejected';
    const opts = optionsRef.current;

    if (wasSwiping) {
      opts.onSwipeEnd?.({ delta: 0, velocity: 0, isFling: false, direction: 0, passed: false });
      setIsSwiping(false);
    }

    stateRef.current = { ...INITIAL_STATE };
  }, []);

  const ref = useCallback(
    (node: T | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!node) return;

      const onTouchStart = (e: TouchEvent) => {
        const t = e.touches[0];
        if (t) handleStart(t.clientX, t.clientY);
      };
      const onTouchMove = (e: TouchEvent) => {
        const t = e.touches[0];
        if (!t) return;
        handleMove(t.clientX, t.clientY, () => {
          if (e.cancelable) e.preventDefault();
        });
      };
      const onTouchEnd = () => handleEnd();
      const onTouchCancel = () => handleCancel();

      // 鼠标路径（桌面调试）：down 在容器，move/up 在 window，拖出容器不丢事件
      const onMouseMove = (e: MouseEvent) => {
        handleMove(e.clientX, e.clientY, () => e.preventDefault());
      };
      const onMouseUp = () => {
        handleEnd();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        handleStart(e.clientX, e.clientY);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      };

      node.addEventListener('touchstart', onTouchStart, { passive: true });
      node.addEventListener('touchmove', onTouchMove, { passive: false });
      node.addEventListener('touchend', onTouchEnd);
      node.addEventListener('touchcancel', onTouchCancel);
      node.addEventListener('mousedown', onMouseDown);

      cleanupRef.current = () => {
        node.removeEventListener('touchstart', onTouchStart);
        node.removeEventListener('touchmove', onTouchMove);
        node.removeEventListener('touchend', onTouchEnd);
        node.removeEventListener('touchcancel', onTouchCancel);
        node.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
    },
    [handleStart, handleMove, handleEnd, handleCancel],
  );

  return { ref, isSwiping };
}

export default useSwipeGesture;
