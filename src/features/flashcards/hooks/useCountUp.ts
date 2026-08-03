import { useEffect, useRef, useState } from 'react';

/**
 * 仅当浏览器明确声明「无减少动效偏好」时才做数字动画。
 * 其余环境（prefers-reduced-motion、jsdom 测试、无 rAF）直接渲染最终值，
 * 保证可测性与 a11y。
 */
function canAnimateNumbers(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.requestAnimationFrame !== 'function') return false;
  if (typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: no-preference)').matches;
  } catch {
    return false;
  }
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

/** 数字 count-up：目标值变化时从当前显示值滚动到目标值。 */
export function useCountUp(target: number, durationMs = 640): number {
  const animatableRef = useRef(canAnimateNumbers());
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [display, setDisplay] = useState(() => (animatableRef.current ? 0 : safeTarget));
  const displayRef = useRef(display);
  displayRef.current = display;

  useEffect(() => {
    if (!animatableRef.current) {
      setDisplay(safeTarget);
      return undefined;
    }
    const from = displayRef.current;
    if (from === safeTarget) return undefined;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      if (progress >= 1) {
        setDisplay(safeTarget);
        return;
      }
      setDisplay(Math.round(from + (safeTarget - from) * easeOutCubic(progress)));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [safeTarget, durationMs]);

  return display;
}
