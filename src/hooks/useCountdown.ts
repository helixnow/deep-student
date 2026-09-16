import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * High-precision countdown hook based on absolute timestamps.
 * Survives timer drift, effect rebuilds, and tab backgrounding.
 *
 * @param targetEndTime - Unix timestamp (ms) when countdown reaches zero. null = inactive.
 * @param onTimeout - Called once when countdown reaches zero.
 * @returns { remaining, isPaused, pause, resume, reset }
 */
export function useCountdown(
  targetEndTime: number | null,
  onTimeout?: () => void,
) {
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => ({ target: targetEndTime, end: targetEndTime }));
  const currentClockRef = useRef(clock);
  currentClockRef.current = clock;
  const targetRef = useRef(targetEndTime);
  targetRef.current = targetEndTime;
  const adjustedEnd = clock.target === targetEndTime ? clock.end : null;
  const [remaining, setRemaining] = useState(0);
  const firedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const next = { target: targetEndTime, end: targetEndTime };
    currentClockRef.current = next;
    setClock(next);
    setRemaining(0);
    setPausedAt(null);
    pausedAtRef.current = null;
    firedRef.current = false;
  }, [targetEndTime]);

  const pause = useCallback(() => {
    if (pausedAtRef.current != null || currentClockRef.current.end == null || firedRef.current) return;
    const now = Date.now();
    setPausedAt(now);
    pausedAtRef.current = now;
  }, []);

  const resume = useCallback(() => {
    const prev = pausedAtRef.current;
    if (prev == null) return;
    const pausedDuration = Date.now() - prev;
    pausedAtRef.current = null;
    setPausedAt(null);
    const current = currentClockRef.current;
    const next = { ...current, end: current.end != null ? current.end + pausedDuration : null };
    currentClockRef.current = next;
    setClock(next);
  }, []);

  const reset = useCallback(() => {
    const next = { target: targetRef.current, end: null };
    currentClockRef.current = next;
    setClock(next);
    setPausedAt(null);
    pausedAtRef.current = null;
    setRemaining(0);
    firedRef.current = false;
  }, []);

  useEffect(() => {
    if (adjustedEnd == null || pausedAt != null) return;

    let active = true;
    const tick = () => {
      if (!active || currentClockRef.current !== clock || targetRef.current !== clock.target || pausedAtRef.current != null) return;
      const diff = Math.max(0, Math.ceil((adjustedEnd - Date.now()) / 1000));
      setRemaining(diff);
      if (diff <= 0 && !firedRef.current) {
        firedRef.current = true;
        onTimeoutRef.current?.();
      }
    };

    tick();
    const id = setInterval(tick, 250);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [adjustedEnd, pausedAt, clock]);

  return {
    remaining,
    isPaused: pausedAt != null,
    pause,
    resume,
    reset,
  };
}
