/**
 * FSRS 会话卡面滑动评分手势。
 *
 * 方向映射（与主流 SRS 应用习惯对齐，惯用手横滑覆盖最高频的两档）：
 * - 左滑 = Again(1)：否定动作向左「丢弃」
 * - 右滑 = Good(3)：肯定动作向右「通过」
 * - 上滑 = Easy(4)：轻松「抛出」
 * - 下滑 = Hard(2)：吃力「下坠」
 *
 * 交互契约：
 * - Pointer Events 驱动，位移超过死区(12px)进入拖动，超过阈值(默认 80px)松手触发评分；
 * - 拖动中卡片跟手位移 + 轻微旋转，由调用方用 state 渲染；
 * - 松手超阈值置 flyout 方向（飞出动画由 CSS 完成），未超阈值弹回；
 * - 拖动结束后的合成 click 会被 onClickCapture 吞掉，避免误触翻面。
 */
import React from 'react';
import type { FsrsRating } from '../store/fsrsReviewStore';

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export const SWIPE_RATING_MAP: Record<SwipeDirection, FsrsRating> = {
  left: 1,
  down: 2,
  right: 3,
  up: 4,
};

const DEAD_ZONE_PX = 12;
const DEFAULT_THRESHOLD_PX = 80;

export interface SwipeRatingState {
  /** 当前拖动位移（px） */
  dx: number;
  dy: number;
  /** 是否处于拖动中（超过死区后为 true） */
  dragging: boolean;
  /** 越过死区后的主导方向 */
  direction: SwipeDirection | null;
  /** 朝主导方向的进度 0..1（达到 1 即松手可触发） */
  progress: number;
  /** 松手触发评分后的飞出方向（触发 CSS 飞出动画） */
  flyout: SwipeDirection | null;
}

const IDLE_STATE: SwipeRatingState = {
  dx: 0,
  dy: 0,
  dragging: false,
  direction: null,
  progress: 0,
  flyout: null,
};

export interface UseSwipeRatingOptions {
  /** 手势是否可用（翻面后且未在评分/编辑中） */
  enabled: boolean;
  /** 当前卡片标识；变化时内部状态复位 */
  resetKey: string | null;
  /** 触发阈值（px），默认 80 */
  threshold?: number;
  onRate: (rating: FsrsRating) => void;
}

export interface UseSwipeRatingResult {
  state: SwipeRatingState;
  /** 强制复位（评分失败等场景把飞出的卡片拉回来） */
  reset: () => void;
  handlers: {
    onPointerDown: React.PointerEventHandler<HTMLElement>;
    onPointerMove: React.PointerEventHandler<HTMLElement>;
    onPointerUp: React.PointerEventHandler<HTMLElement>;
    onPointerCancel: React.PointerEventHandler<HTMLElement>;
    onClickCapture: React.MouseEventHandler<HTMLElement>;
  };
}

function dominantDirection(dx: number, dy: number): SwipeDirection {
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'down' : 'up';
}

export function useSwipeRating({
  enabled,
  resetKey,
  threshold = DEFAULT_THRESHOLD_PX,
  onRate,
}: UseSwipeRatingOptions): UseSwipeRatingResult {
  const [state, setState] = React.useState<SwipeRatingState>(IDLE_STATE);
  const gestureRef = React.useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    moved: boolean;
    suppressClick: boolean;
  }>({ pointerId: null, startX: 0, startY: 0, moved: false, suppressClick: false });
  const onRateRef = React.useRef(onRate);
  onRateRef.current = onRate;

  const reset = React.useCallback(() => {
    gestureRef.current.pointerId = null;
    gestureRef.current.moved = false;
    setState(IDLE_STATE);
  }, []);

  // 卡片切换（评分成功推进队列）后复位，让新卡从原位入场
  React.useEffect(() => {
    reset();
  }, [resetKey, reset]);

  const onPointerDown = React.useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    if (!enabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const gesture = gestureRef.current;
    if (gesture.pointerId !== null) return;
    gesture.pointerId = event.pointerId;
    gesture.startX = event.clientX;
    gesture.startY = event.clientY;
    gesture.moved = false;
  }, [enabled]);

  const onPointerMove = React.useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < DEAD_ZONE_PX) return;
      gesture.moved = true;
      // 捕获指针，拖出卡面也能继续跟踪
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const direction = dominantDirection(dx, dy);
    const dominant = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
    setState({
      dx,
      dy,
      dragging: true,
      direction,
      progress: Math.min(dominant / threshold, 1),
      flyout: null,
    });
  }, [threshold]);

  const finishGesture = React.useCallback((event: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const gesture = gestureRef.current;
    if (gesture.pointerId !== event.pointerId) return;
    gesture.pointerId = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    if (!gesture.moved) return;
    // 拖动过就吞掉随后的合成 click，避免翻回正面
    gesture.suppressClick = true;
    gesture.moved = false;

    if (cancelled) {
      setState(IDLE_STATE);
      return;
    }
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const direction = dominantDirection(dx, dy);
    const dominant = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
    if (dominant >= threshold) {
      setState({ dx, dy, dragging: false, direction, progress: 1, flyout: direction });
      onRateRef.current(SWIPE_RATING_MAP[direction]);
    } else {
      // 未超阈值：弹回（CSS transition 负责回弹动画）
      setState(IDLE_STATE);
    }
  }, [threshold]);

  const onPointerUp = React.useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    finishGesture(event, false);
  }, [finishGesture]);

  const onPointerCancel = React.useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    // 浏览器接管（如触屏纵向滚动）时优雅复位，不误触评分
    finishGesture(event, true);
  }, [finishGesture]);

  const onClickCapture = React.useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    if (gestureRef.current.suppressClick) {
      gestureRef.current.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return {
    state,
    reset,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture },
  };
}
