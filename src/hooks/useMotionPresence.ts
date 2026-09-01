import { useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '@/styles/motion-springs';

export type MotionPresenceState = {
  /** Keep the node in the tree (including the close animation). */
  mounted: boolean;
  /**
   * Transition end-state. For `enter: 'transition'`, this flips true one/two
   * frames after mount so CSS transitions have a from-state.
   */
  shown: boolean;
  /** True while the close animation is playing. */
  exiting: boolean;
};

export function readCssDurationMs(varName: string, fallback: number): number {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return fallback;
  if (raw.endsWith('s') && !raw.endsWith('ms')) return value * 1000;
  return value;
}

/**
 * Keep a surface mounted through its close animation, and (for CSS
 * *transitions*) delay the open class by a frame so enter is not skipped.
 *
 * CSS *animations* (`ui-*-in`) play on mount; pass `enter: 'animation'`
 * and swap to the `*-out` class while `exiting`.
 *
 * Open/close flags commit in `useLayoutEffect` so children can measure and
 * take focus in the same act()/frame as `open` flipping true.
 */
export function useMotionPresence(
  open: boolean,
  options?: {
    exitMs?: number;
    enter?: 'animation' | 'transition';
  },
): MotionPresenceState {
  const enter = options?.enter ?? 'animation';
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(enter === 'animation' ? open : false);
  const [exiting, setExiting] = useState(false);
  const mountedRef = useRef(open);

  mountedRef.current = mounted;

  useLayoutEffect(() => {
    let frame1 = 0;
    let frame2 = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reduced = prefersReducedMotion();
    const exitMs = reduced ? 0 : (options?.exitMs ?? 150);

    if (open) {
      setMounted(true);
      setExiting(false);
      if (reduced || enter === 'animation') {
        setShown(true);
      } else {
        setShown(false);
        frame1 = requestAnimationFrame(() => {
          frame2 = requestAnimationFrame(() => setShown(true));
        });
      }
    } else if (mountedRef.current) {
      setShown(false);
      setExiting(true);
      if (exitMs <= 0) {
        setMounted(false);
        setExiting(false);
      } else {
        timer = setTimeout(() => {
          setMounted(false);
          setExiting(false);
        }, exitMs);
      }
    } else {
      setShown(false);
      setExiting(false);
      setMounted(false);
    }

    return () => {
      if (frame1) cancelAnimationFrame(frame1);
      if (frame2) cancelAnimationFrame(frame2);
      if (timer) clearTimeout(timer);
    };
  }, [open, enter, options?.exitMs]);

  return { mounted, shown, exiting };
}
