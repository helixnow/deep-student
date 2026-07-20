/**
 * PullToRefresh — 移动端下拉刷新容器。
 *
 * 行为：
 * - 组件自身就是滚动容器（overflow-y: auto）。根部 app.css 设置了
 *   `overscroll-behavior: none`，本容器用 `overscroll-behavior-y: contain`
 *   局部放宽，既拦下原生橡皮筋/浏览器刷新，又保留内部滚动；
 * - 触摸起手时 scrollTop ≤ 0 才进入下拉跟踪；下拉位移做 0.5 阻尼并
 *   封顶 `maxPull`，超过 `threshold`（默认 64px）松手触发 `onRefresh`；
 * - `onRefresh` 返回 Promise 时指示器保持吸附直到 resolve/reject；
 * - 回弹动画消费 --m-sheet-dur / --ease-standard token；
 *   prefers-reduced-motion 下位移即时归位、spinner 不转；
 * - 仅响应触摸（下拉刷新是触屏专属交互），桌面鼠标不受影响。
 *
 * 接入示例：
 * ```tsx
 * <PullToRefresh className="h-full" onRefresh={async () => refetch()}>
 *   <ListContent />
 * </PullToRefresh>
 * ```
 */

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { prefersReducedMotion } from '@/styles/motion-springs';

export interface PullToRefreshProps {
  /** 刷新回调；返回 Promise 时指示器保持到完成。 */
  onRefresh: () => void | Promise<void>;
  /** 为 true 时禁用下拉（滚动不受影响）。 */
  disabled?: boolean;
  /** 触发刷新的下拉位移阈值（px，阻尼后），默认 64。 */
  threshold?: number;
  /** 下拉位移上限（px，阻尼后），默认 112。 */
  maxPull?: number;
  /** 外层容器类名（负责给定高度，如 h-full）。 */
  className?: string;
  /** 滚动内容层类名。 */
  contentClassName?: string;
  children: ReactNode;
}

type PullPhase = 'idle' | 'pulling' | 'refreshing';

const DEFAULT_THRESHOLD = 64;
const DEFAULT_MAX_PULL = 112;
/** 下拉阻尼系数：手指位移 × 0.5 = 内容位移。 */
const PULL_RESISTANCE = 0.5;

export const PullToRefresh: React.FC<PullToRefreshProps> = ({
  onRefresh,
  disabled = false,
  threshold = DEFAULT_THRESHOLD,
  maxPull = DEFAULT_MAX_PULL,
  className,
  contentClassName,
  children,
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(0);
  const [phase, setPhase] = useState<PullPhase>('idle');

  /** 原生监听器里读取的可变状态（避免闭包过期）。 */
  const gestureRef = useRef({
    startY: 0,
    tracking: false,
    dragging: false,
    offset: 0,
  });
  const configRef = useRef({ onRefresh, disabled, threshold, maxPull, phase });
  configRef.current = { onRefresh, disabled, threshold, maxPull, phase };

  const settleTo = useCallback((value: number) => {
    gestureRef.current.offset = value;
    setOffset(value);
  }, []);

  const finishRefresh = useCallback(() => {
    setPhase('idle');
    settleTo(0);
  }, [settleTo]);

  const triggerRefresh = useCallback(() => {
    setPhase('refreshing');
    settleTo(configRef.current.threshold);
    let result: void | Promise<void>;
    try {
      result = configRef.current.onRefresh();
    } catch {
      finishRefresh();
      return;
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      (result as Promise<void>).then(finishRefresh, finishRefresh);
    } else {
      finishRefresh();
    }
  }, [settleTo, finishRefresh]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const onTouchStart = (e: TouchEvent) => {
      const g = gestureRef.current;
      const cfg = configRef.current;
      g.tracking = false;
      g.dragging = false;
      if (cfg.disabled || cfg.phase === 'refreshing') return;
      if (node.scrollTop > 0) return;
      const t = e.touches[0];
      if (!t) return;
      g.tracking = true;
      g.startY = t.clientY;
    };

    const onTouchMove = (e: TouchEvent) => {
      const g = gestureRef.current;
      const cfg = configRef.current;
      if (!g.tracking) return;
      const t = e.touches[0];
      if (!t) return;

      const rawDelta = t.clientY - g.startY;

      // 上滑或容器已离开顶部：交还原生滚动
      if (!g.dragging && (rawDelta <= 0 || node.scrollTop > 0)) {
        g.tracking = false;
        return;
      }

      if (rawDelta > 0) {
        if (!g.dragging) {
          g.dragging = true;
          setPhase('pulling');
        }
        // 已接管下拉：阻止原生滚动/橡皮筋
        if (e.cancelable) e.preventDefault();
        const next = Math.min(cfg.maxPull, rawDelta * PULL_RESISTANCE);
        g.offset = next;
        setOffset(next);
      } else if (g.dragging) {
        // 拉出后又推回顶部以上
        g.offset = 0;
        setOffset(0);
      }
    };

    const onTouchEnd = () => {
      const g = gestureRef.current;
      const cfg = configRef.current;
      if (!g.tracking) return;
      g.tracking = false;
      if (!g.dragging) return;
      g.dragging = false;

      if (g.offset >= cfg.threshold) {
        triggerRefresh();
      } else {
        setPhase('idle');
        setOffset(0);
        g.offset = 0;
      }
    };

    node.addEventListener('touchstart', onTouchStart, { passive: true });
    node.addEventListener('touchmove', onTouchMove, { passive: false });
    node.addEventListener('touchend', onTouchEnd, { passive: true });
    node.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      node.removeEventListener('touchstart', onTouchStart);
      node.removeEventListener('touchmove', onTouchMove);
      node.removeEventListener('touchend', onTouchEnd);
      node.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [triggerRefresh]);

  const isDragging = phase === 'pulling';
  const isRefreshing = phase === 'refreshing';
  const progress = Math.min(1, offset / Math.max(threshold, 1));
  const reduceMotion = prefersReducedMotion();

  // 拖拽中完全跟手（无过渡）；松手/刷新结束的归位走 token 过渡
  const settleTransition =
    isDragging || reduceMotion
      ? 'none'
      : 'transform var(--m-sheet-dur, 260ms) var(--ease-standard, cubic-bezier(0.22, 1, 0.36, 1))';

  return (
    <div className={cn('relative overflow-hidden', className)}>
      {/* 指示器层：藏在内容上缘之外，随下拉一起露出 */}
      <div
        aria-hidden={offset <= 0}
        className="pointer-events-none absolute inset-x-0 top-0 z-[1] flex justify-center"
        style={{
          height: threshold,
          transform: `translate3d(0, ${offset - threshold}px, 0)`,
          transition: settleTransition,
          opacity: isRefreshing ? 1 : progress,
        }}
      >
        <span
          className="mt-auto mb-2 flex h-8 w-8 items-center justify-center rounded-pill bg-muted text-muted-foreground shadow-soft"
          role="status"
          aria-live="polite"
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className={cn(isRefreshing && !reduceMotion && 'animate-spin')}
            style={
              isRefreshing
                ? undefined
                : {
                    transform: `rotate(${progress * 180}deg)`,
                    transition: reduceMotion ? 'none' : 'transform 100ms linear',
                  }
            }
          >
            {isRefreshing ? (
              // spinner：3/4 圆弧
              <path d="M8 1.5 A 6.5 6.5 0 1 1 1.5 8" />
            ) : (
              // 下拉箭头：过阈值后随 progress 转 180° 指向上方
              <path d="M8 2.5 v11 M4 9.5 l4 4 4 -4" />
            )}
          </svg>
        </span>
      </div>

      <div
        ref={scrollRef}
        data-pull-to-refresh
        className={cn('h-full overflow-y-auto', contentClassName)}
        style={{
          overscrollBehaviorY: 'contain',
          touchAction: 'pan-y',
          transform: `translate3d(0, ${offset}px, 0)`,
          transition: settleTransition,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default PullToRefresh;
