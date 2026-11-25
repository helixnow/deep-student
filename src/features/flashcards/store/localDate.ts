const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Small buffer past the boundary so clock getters reliably observe the new day. */
const DAY_BOUNDARY_BUFFER_MS = 50;

export const DEFAULT_FSRS_DAY_ROLLOVER_HOUR = 4;

/**
 * Deterministic local calendar date key (`YYYY-MM-DD`) derived from local
 * `getFullYear() / getMonth() + 1 / getDate()`.
 *
 * When `offsetMinutes` (minutes east of UTC, e.g. `+540` for `UTC+9`, `-300` for `UTC-5`)
 * is explicitly passed, formats the civil date at that fixed offset without depending on
 * the host timezone.
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
 * Pure calendar day arithmetic on a `YYYY-MM-DD` key (DST-safe).
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

export function sanitizeRolloverHour(dayRolloverHour: number | null | undefined): number {
  if (typeof dayRolloverHour !== 'number' || !Number.isFinite(dayRolloverHour)) {
    return DEFAULT_FSRS_DAY_ROLLOVER_HOUR;
  }
  return Math.min(23, Math.max(0, Math.trunc(dayRolloverHour)));
}

/**
 * Deterministic logical FSRS study day key (`YYYY-MM-DD`) in local time (or fixed
 * `offsetMinutes` east of UTC), matching `host/plugins/review/src/fsrs-scheduler.ts`.
 * Times before `dayRolloverHour` belong to the previous calendar day.
 */
export function formatLogicalDateKey(
  date: Date = new Date(),
  dayRolloverHour: number = DEFAULT_FSRS_DAY_ROLLOVER_HOUR,
  offsetMinutes?: number,
): string {
  const rollover = sanitizeRolloverHour(dayRolloverHour);
  if (offsetMinutes !== undefined && Number.isFinite(offsetMinutes)) {
    const shifted = new Date(
      date.getTime() + offsetMinutes * MS_PER_MINUTE - rollover * MS_PER_HOUR,
    );
    const y = String(shifted.getUTCFullYear()).padStart(4, '0');
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const calKey = formatLocalDateKey(date);
  return date.getHours() < rollover ? shiftLocalDateKey(calKey, -1) : calKey;
}

/**
 * Milliseconds from `now` until the earliest upcoming day boundary:
 * - next local calendar midnight (`00:00:00.050`), AND
 * - next local `dayRolloverHour` (`HH:00:00.050`) when `dayRolloverHour > 0`.
 */
export function msUntilNextDayBoundary(
  now: Date = new Date(),
  dayRolloverHour: number = DEFAULT_FSRS_DAY_ROLLOVER_HOUR,
): number {
  const nowMs = now.getTime();
  const candidates: number[] = [];

  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    DAY_BOUNDARY_BUFFER_MS,
  ).getTime();
  if (Number.isFinite(nextMidnight) && nextMidnight > nowMs) {
    candidates.push(nextMidnight - nowMs);
  }

  const rollover = sanitizeRolloverHour(dayRolloverHour);
  if (rollover > 0) {
    const todayRollover = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      rollover,
      0,
      0,
      DAY_BOUNDARY_BUFFER_MS,
    ).getTime();
    if (Number.isFinite(todayRollover) && todayRollover > nowMs) {
      candidates.push(todayRollover - nowMs);
    } else {
      const tomorrowRollover = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        rollover,
        0,
        0,
        DAY_BOUNDARY_BUFFER_MS,
      ).getTime();
      if (Number.isFinite(tomorrowRollover) && tomorrowRollover > nowMs) {
        candidates.push(tomorrowRollover - nowMs);
      }
    }
  }

  if (candidates.length === 0) return 1_000;
  return Math.min(Math.min(...candidates), MS_PER_DAY + 3_600_000);
}
