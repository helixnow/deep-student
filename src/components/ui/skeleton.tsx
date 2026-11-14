import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import { Skeleton, type SkeletonProps } from './shad/Skeleton';

export const SKELETON_DELAY_MS = 200;
export const SKELETON_MIN_VISIBLE_MS = 400;
export const SKELETON_REVEAL_MS = 220;

export interface SkeletonGateOptions {
  /** 延迟门控毫秒数：在此时间内完成的加载完全不显示骨架屏（默认 200ms） */
  delayMs?: number;
  /** 最短驻留毫秒数：一旦显示骨架屏，至少停留该时长后再收起（默认 400ms） */
  minVisibleMs?: number;
}

/**
 * 防闪烁骨架屏延迟门控 Hook：
 * 1. 加载在 `delayMs`（默认 200ms）内结束时，全程返回 `false`，不闪出骨架屏；
 * 2. 一旦超过 `delayMs` 露出骨架屏，则至少驻留 `minVisibleMs`（默认 400ms）后再收起。
 */
export function useSkeletonGate(
  loading: boolean,
  options: SkeletonGateOptions = {},
): boolean {
  const {
    delayMs = SKELETON_DELAY_MS,
    minVisibleMs = SKELETON_MIN_VISIBLE_MS,
  } = options;

  const [show, setShow] = useState<boolean>(() => loading && delayMs <= 0);
  const shownAtRef = useRef<number | null>(loading && delayMs <= 0 ? Date.now() : null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (loading) {
      if (shownAtRef.current !== null) {
        clearTimer();
        return;
      }
      clearTimer();
      if (delayMs <= 0) {
        shownAtRef.current = Date.now();
        setShow(true);
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        shownAtRef.current = Date.now();
        setShow(true);
      }, delayMs);
      return clearTimer;
    }

    clearTimer();
    if (shownAtRef.current === null) {
      setShow(false);
      return;
    }

    const elapsed = Date.now() - shownAtRef.current;
    const remain = minVisibleMs - elapsed;
    if (remain <= 0) {
      shownAtRef.current = null;
      setShow(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      shownAtRef.current = null;
      setShow(false);
    }, remain);
    return clearTimer;
  }, [loading, delayMs, minVisibleMs, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  return show;
}

export type SkeletonRevealPhase = 'idle' | 'loading' | 'revealing';

export interface SkeletonRevealProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 数据是否正在加载（内部经过 useSkeletonGate 防闪烁门控） */
  loading?: boolean;
  /** 可选：直接受控指定骨架是否显示（传入时优先于 loading） */
  show?: boolean;
  /** 与真实内容同形的骨架节点 */
  skeleton: React.ReactNode;
  /** 真实内容节点 */
  children: React.ReactNode;
  /** 延迟门控毫秒数（默认 200ms） */
  delayMs?: number;
  /** 最短驻留毫秒数（默认 400ms） */
  minVisibleMs?: number;
  /** 测试标识 */
  testId?: string;
}

/**
 * 同格叠放骨架切换容器（CSS Grid `gridTemplateAreas: '"stack"'`，子层 `gridArea: 'stack'`）：
 * - 骨架与真实内容处于同一 Grid 单元格，切换期间容器高度零跳变；
 * - 从骨架切换到真实内容时执行平滑交叉淡入淡出（真实内容 `opacity` + `translateY(4px -> 0)`）。
 */
export const SkeletonReveal: React.FC<SkeletonRevealProps> = ({
  loading = false,
  show,
  skeleton,
  children,
  delayMs = SKELETON_DELAY_MS,
  minVisibleMs = SKELETON_MIN_VISIBLE_MS,
  className,
  style,
  testId,
  ...rest
}) => {
  const gatedShow = useSkeletonGate(loading, { delayMs, minVisibleMs });
  const isSkeletonVisible = show !== undefined ? show : gatedShow;

  const [phase, setPhase] = useState<SkeletonRevealPhase>(
    isSkeletonVisible ? 'loading' : 'idle',
  );

  if (isSkeletonVisible && phase !== 'loading') {
    setPhase('loading');
  } else if (!isSkeletonVisible && phase === 'loading') {
    setPhase('revealing');
  }

  useEffect(() => {
    if (phase !== 'revealing') return;
    const timer = setTimeout(() => setPhase('idle'), SKELETON_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const hideContent = isSkeletonVisible || (loading && phase === 'loading');

  return (
    <div
      {...rest}
      data-testid={testId ?? 'skeleton-reveal'}
      data-phase={phase}
      data-skeleton-visible={isSkeletonVisible ? 'true' : 'false'}
      aria-busy={isSkeletonVisible || loading || undefined}
      className={cn('skel-reveal grid', `is-${phase}`, className)}
      style={{
        display: 'grid',
        gridTemplateAreas: '"stack"',
        ...style,
      }}
    >
      <div
        data-testid="skeleton-reveal-skeleton"
        aria-hidden={!isSkeletonVisible}
        className={cn(
          'skel-reveal__skeleton min-w-0 transition-opacity duration-200 ease-out',
          isSkeletonVisible ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        style={{
          gridArea: 'stack',
          opacity: isSkeletonVisible ? 1 : 0,
          pointerEvents: isSkeletonVisible ? 'auto' : 'none',
          transition: `opacity ${SKELETON_REVEAL_MS}ms ease-out`,
        }}
      >
        {skeleton}
      </div>
      <div
        data-testid="skeleton-reveal-content"
        aria-hidden={hideContent}
        className={cn(
          'skel-reveal__content min-w-0 transition-all duration-200 ease-out',
          hideContent ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
        style={{
          gridArea: 'stack',
          minWidth: 0,
          opacity: hideContent ? 0 : 1,
          transform: hideContent ? 'translateY(4px)' : 'translateY(0)',
          pointerEvents: hideContent ? 'none' : 'auto',
          transition: `opacity ${SKELETON_REVEAL_MS}ms ease-out, transform ${SKELETON_REVEAL_MS}ms ease-out`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

SkeletonReveal.displayName = 'SkeletonReveal';

export { Skeleton, type SkeletonProps };
export default Skeleton;
