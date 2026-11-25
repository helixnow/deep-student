import { useEffect, useState } from 'react';

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Small buffer past 00:00:00.000 so local clock getters reliably report the new calendar day. */
const MIDNIGHT_ROLLOVER_BUFFER_MS = 50;

/**
 * Deterministic local calendar day key (`YYYY-MM-DD`) derived from local
 * `getFullYear() / getMonth() + 1 / getDate()`.
 *
 * When `offsetMinutes` (minutes east of UTC, e.g. `+540` for `UTC+9`, `-300` for `UTC-5`)
 * is explicitly supplied, formats the calendar date at that fixed offset without
 * depending on the host timezone.
 */
export function formatLocalDateKey(date: Date = new Date(), offsetMinutes?: number): string {
  if (offsetMinutes !== undefined && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(date.getTime() + offsetMinutes * MS_PER_MINUTE);
    const y = String(shifted.getUTCFullYear()).padStart(4, '0');
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Pure calendar day arithmetic on a `YYYY-MM-DD` key (DST-safe across 23h/25h days).
 */
export function shiftLocalDateKey(dateKey: string, deltaDays: number): string {
  const match = YMD_RE.exec(dateKey);
  if (!match) return dateKey;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const shifted = new Date(Date.UTC(year, month - 1, day + Math.trunc(deltaDays)));
  const y = String(shifted.getUTCFullYear()).padStart(4, '0');
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Normalize either a canonical `YYYY-MM-DD` key or a legacy `Date#toDateString()`
 * persisted value (e.g. `"Wed Nov 25 2026"`) into a canonical local `YYYY-MM-DD` key.
 */
export function normalizeLocalDateKey(
  value: string | null | undefined,
  offsetMinutes?: number,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (YMD_RE.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatLocalDateKey(parsed, offsetMinutes);
}

/**
 * Construct a local Date at 12:00:00 noon for `YYYY-MM-DD`.
 * Using local noon avoids DST spring-forward transitions that skip `00:00:00`.
 */
export function parseLocalDateNoon(dateKey: string): Date | null {
  const match = YMD_RE.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/**
 * Milliseconds from `now` until the next local calendar midnight (`00:00:00.050`).
 */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    MIDNIGHT_ROLLOVER_BUFFER_MS,
  );
  const delta = nextMidnight.getTime() - now.getTime();
  return Number.isFinite(delta) && delta > 0 ? Math.min(delta, MS_PER_DAY + 3_600_000) : 1_000;
}

/**
 * React hook returning the current local calendar date key (`YYYY-MM-DD`).
 * Automatically updates when the clock crosses local midnight or when the tab
 * wakes/focuses on a new local day.
 */
export function useLocalDateKey(): string {
  const [dateKey, setDateKey] = useState<string>(() => formatLocalDateKey());

  useEffect(() => {
    let timerId: number | null = null;

    const syncAndSchedule = () => {
      const now = new Date();
      const current = formatLocalDateKey(now);
      setDateKey((prev) => (prev === current ? prev : current));
      if (timerId !== null) window.clearTimeout(timerId);
      timerId = window.setTimeout(syncAndSchedule, msUntilNextLocalMidnight(now));
    };

    syncAndSchedule();

    const handleWake = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      syncAndSchedule();
    };
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);

    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, []);

  return dateKey;
}
