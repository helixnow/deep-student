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
  const [adjustedEnd, setAdjustedEnd] = useState<number | null>(targetEndTime);
  const [remaining, setRemaining] = useState(0);
  const firedRef = useRef(false);
  const pausedAtRef = useRef<number | null>(null);

  useEffect(() => {
    setAdjustedEnd(targetEndTime);
    setPausedAt(null);
    pausedAtRef.current = null;
    firedRef.current = false;
  }, [targetEndTime]);

  const pause = useCallback(() => {
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
    setAdjustedEnd((end) => (end != null ? end + pausedDuration : null));
  }, []);

  const reset = useCallback(() => {
    setAdjustedEnd(null);
    setPausedAt(null);
    pausedAtRef.current = null;
    setRemaining(0);
    firedRef.current = false;
  }, []);

  useEffect(() => {
    if (adjustedEnd == null || pausedAt != null) return;

    const tick = () => {
      const diff = Math.max(0, Math.ceil((adjustedEnd - Date.now()) / 1000));
      setRemaining(diff);
      if (diff <= 0 && !firedRef.current) {
        firedRef.current = true;
        onTimeoutRef.current?.();
      }
    };

    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [adjustedEnd, pausedAt]);

  return {
    remaining,
    isPaused: pausedAt != null,
    pause,
    resume,
    reset,
  };
}
