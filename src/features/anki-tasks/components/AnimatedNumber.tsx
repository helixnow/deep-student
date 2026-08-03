/**
 * 制卡任务 — 数字过渡动画
 *
 * 值变化时用 rAF 做 count-up/count-down 过渡；首次挂载直接显示终值
 * （避免打开页面时全屏数字乱跳），prefers-reduced-motion 时禁用动画。
 */
import React, { useEffect, useRef, useState } from 'react';

const DURATION_MS = 550;

/** easeOutCubic — 数字趋近终值时减速，观感更自然 */
function ease(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export const AnimatedNumber: React.FC<{
  value: number;
  className?: string;
}> = ({ value, className }) => {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  displayRef.current = display;

  useEffect(() => {
    if (!mountedRef.current) {
      // 首次挂载：直接落到终值，不做入场滚动
      mountedRef.current = true;
      setDisplay(value);
      return undefined;
    }
    if (value === displayRef.current) return undefined;
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
      setDisplay(value);
      return undefined;
    }

    const from = displayRef.current;
    const delta = value - from;
    const start = performance.now();

    const tick = (now: number) => {
      const p = Math.min((now - start) / DURATION_MS, 1);
      const next = p >= 1 ? value : Math.round(from + delta * ease(p));
      setDisplay(next);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [value]);

  return <span className={`tabular-nums ${className ?? ''}`}>{display}</span>;
};
