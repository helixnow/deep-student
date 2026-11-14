/** Local-calendar accounting; no database or component dependencies. */
export interface StudyDay {
  date: string;
  seconds: number;
}

export const TICK_MS = 15_000;
export const MAX_TICK_MS = 30_000;
export const HEAT_STEPS_MINUTES = [15, 45, 90] as const;
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function formatLocalDateKey(tsOrDate: number | Date): string {
  const d = new Date(tsOrDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function localDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function shiftDay(key: string, offset: number): string {
  const date = localDate(key);
  date.setDate(date.getDate() + offset);
  return formatLocalDateKey(date);
}

export function splitDurationByLocalMidnight(fromMs: number, toMs: number): StudyDay[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const result: StudyDay[] = [];
  for (let cursor = fromMs; cursor < toMs;) {
    const midnight = new Date(cursor);
    midnight.setHours(24, 0, 0, 0);
    const end = Math.min(midnight.getTime(), toMs);
    result.push({ date: formatLocalDateKey(cursor), seconds: (end - cursor) / 1000 });
    cursor = end;
  }
  return result;
}

function secondsMap(rows: readonly StudyDay[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const { date, seconds } of rows) {
    if (Number.isFinite(seconds) && seconds > 0) map.set(date, (map.get(date) ?? 0) + seconds);
  }
  return map;
}

export interface StudyTimeTrackerOptions {
  /** Must atomically add all deltas and resolve only after commit. Failures are retried on the next flush. */
  persist: (deltas: readonly StudyDay[]) => Promise<void>;
  persistedDays?: readonly StudyDay[];
  idleThresholdMs?: number;
  now?: () => number;
  isPageVisible?: boolean;
}

/** Explicit start/stop ownership also works with React StrictMode. Manual tick is available for hosts. */
export class StudyTimeTracker {
  private readonly now: () => number;
  private readonly persistedByDate: Map<string, number>;
  private readonly pending = new Map<string, number>();
  private flushChain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticksSinceFlush = 0;
  private visible: boolean;
  private mediaPlaying = false;
  private lastInteraction: number;
  private lastTick: number;
  readonly idleThresholdMs: number;

  constructor(private readonly options: StudyTimeTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.lastTick = this.lastInteraction = this.now();
    this.visible = options.isPageVisible ?? (typeof document === 'undefined' || document.visibilityState === 'visible');
    this.idleThresholdMs = options.idleThresholdMs ?? 5 * 60_000;
    this.persistedByDate = secondsMap(options.persistedDays ?? []);
  }

  get lastTickMs(): number { return this.lastTick; }
  get lastUserInteractionMs(): number { return this.lastInteraction; }
  get isPageVisible(): boolean { return this.visible; }
  get isMediaPlaying(): boolean { return this.mediaPlaying; }
  get pendingByDate(): ReadonlyMap<string, number> { return new Map(this.pending); }

  shouldCount(nowMs = this.now()): boolean {
    return this.visible && (this.mediaPlaying || nowMs - this.lastInteraction < this.idleThresholdMs);
  }

  recordUserInteraction(nowMs = this.now()): void { this.lastInteraction = nowMs; }

  setMediaPlaying(playing: boolean, nowMs = this.now()): void {
    this.accrue(nowMs);
    this.mediaPlaying = playing;
  }

  /** Call with false on pause/end and when leaving or switching the playback resource. */
  clearMediaPlaying(nowMs = this.now()): void { this.setMediaPlaying(false, nowMs); }

  setPageVisible(visible: boolean, nowMs = this.now()): void {
    this.accrue(nowMs);
    this.visible = visible;
    if (visible) this.recordUserInteraction(nowMs);
    else void this.flush();
  }

  tick(nowMs = this.now()): void {
    this.accrue(nowMs);
    if (++this.ticksSinceFlush >= 4) {
      this.ticksSinceFlush = 0;
      void this.flush();
    }
  }

  private accrue(nowMs: number): void {
    if (this.shouldCount(nowMs)) {
      const slices = splitDurationByLocalMidnight(Math.max(this.lastTick, nowMs - MAX_TICK_MS), nowMs);
      for (const { date, seconds } of slices) this.pending.set(date, (this.pending.get(date) ?? 0) + seconds);
    }
    // Advance even while idle/hidden; returning must never bill the absent interval.
    this.lastTick = nowMs;
  }

  getRealtimeSeconds(date = formatLocalDateKey(this.now())): number {
    return (this.persistedByDate.get(date) ?? 0) + (this.pending.get(date) ?? 0);
  }

  getRealtimeDays(): StudyDay[] {
    const dates = new Set([...this.persistedByDate.keys(), ...this.pending.keys()]);
    return [...dates].sort().map((date) => ({ date, seconds: this.getRealtimeSeconds(date) }));
  }

  flush(): Promise<void> {
    this.flushChain = this.flushChain.then(async () => {
      // Snapshot inside the serialized operation, not when flush is requested.
      const deltas = [...this.pending].map(([date, seconds]) => ({ date, seconds }));
      if (!deltas.length) return;
      await this.options.persist(deltas);
      for (const { date, seconds } of deltas) {
        this.persistedByDate.set(date, (this.persistedByDate.get(date) ?? 0) + seconds);
        const remaining = (this.pending.get(date) ?? 0) - seconds;
        if (remaining > 0) this.pending.set(date, remaining);
        else this.pending.delete(date);
      }
    }).catch(() => { /* Keep pending intact; accounting must not break the reader. */ });
    return this.flushChain;
  }

  private readonly onActivity = (): void => { this.recordUserInteraction(); };
  private readonly onVisibility = (): void => { this.setPageVisible(document.visibilityState === 'visible'); };
  private readonly onPageHide = (): void => { this.setPageVisible(false); };
  private readonly activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

  start(): void {
    if (this.timer !== undefined) return;
    this.lastTick = this.lastInteraction = this.now();
    if (typeof document !== 'undefined') {
      this.visible = document.visibilityState === 'visible';
      document.addEventListener('visibilitychange', this.onVisibility);
    }
    if (typeof window !== 'undefined') {
      for (const event of this.activityEvents) window.addEventListener(event, this.onActivity, { passive: true, capture: true });
      window.addEventListener('pagehide', this.onPageHide);
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.accrue(this.now());
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.ticksSinceFlush = 0;
    this.mediaPlaying = false;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (typeof window !== 'undefined') {
      for (const event of this.activityEvents) window.removeEventListener(event, this.onActivity, true);
      window.removeEventListener('pagehide', this.onPageHide);
    }
    return this.flush();
  }
}

export function computeHeatLevel(seconds: number): HeatLevel {
  if (!(seconds > 0)) return 0;
  if (seconds >= HEAT_STEPS_MINUTES[2] * 60) return 4;
  if (seconds >= HEAT_STEPS_MINUTES[1] * 60) return 3;
  return seconds >= HEAT_STEPS_MINUTES[0] * 60 ? 2 : 1;
}

export function computeStudyTimeStats(rows: readonly StudyDay[], today = formatLocalDateKey(Date.now())) {
  const map = secondsMap(rows);
  const dates = [...map.keys()].filter((date) => date <= today).sort();
  let totalSeconds = 0;
  let longestStreak = 0;
  let run = 0;
  let previous: string | undefined;
  let best: StudyDay | null = null;
  for (const date of dates) {
    const seconds = map.get(date)!;
    totalSeconds += seconds;
    if (!best || seconds > best.seconds) best = { date, seconds };
    run = previous && shiftDay(previous, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }
  let currentStreak = 0;
  let cursor = map.has(today) ? today : shiftDay(today, -1);
  while (map.has(cursor)) { currentStreak++; cursor = shiftDay(cursor, -1); }
  let last7DaysSeconds = 0;
  let last7DaysActiveDays = 0;
  for (let i = 0; i < 7; i++) {
    const seconds = map.get(shiftDay(today, -i)) ?? 0;
    last7DaysSeconds += seconds;
    if (seconds > 0) last7DaysActiveDays++;
  }
  return {
    totalSeconds, activeDays: dates.length, todaySeconds: map.get(today) ?? 0,
    last7DaysSeconds, last7DaysActiveDays,
    // Window average includes all seven calendar days, including days without study.
    last7DaysAverageSeconds: last7DaysSeconds / 7,
    totalAverageSeconds: dates.length ? totalSeconds / dates.length : 0,
    currentStreak, longestStreak, best,
  };
}

export interface StudyHeatCell extends StudyDay { level: HeatLevel; future: boolean; }

/** Sunday-first columns; numeric month metadata leaves labels to the caller's i18n. */
export function buildStudyHeatmap(options: { today: string; weeks: number; seconds: ReadonlyMap<string, number> }) {
  const count = Number.isFinite(options.weeks) ? Math.max(1, Math.floor(options.weeks)) : 1;
  const sunday = shiftDay(options.today, -localDate(options.today).getDay());
  const first = shiftDay(sunday, -(count - 1) * 7);
  const weeks: StudyHeatCell[][] = [];
  const months: Array<{ index: number; month: number; year: number }> = [];
  for (let column = 0; column < count; column++) {
    const cells: StudyHeatCell[] = [];
    for (let row = 0; row < 7; row++) {
      const date = shiftDay(first, column * 7 + row);
      const future = date > options.today;
      const seconds = future ? 0 : (options.seconds.get(date) ?? 0);
      cells.push({ date, seconds, level: computeHeatLevel(seconds), future });
      if (!future && date.endsWith('-01')) months.push({ index: column, month: localDate(date).getMonth() + 1, year: localDate(date).getFullYear() });
    }
    weeks.push(cells);
  }
  if (!months.length || months[0].index > 1) months.unshift({ index: 0, month: localDate(first).getMonth() + 1, year: localDate(first).getFullYear() });
  return { weeks, months };
}
