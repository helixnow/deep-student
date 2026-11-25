/**
 * 学习时长与活跃天数口径对齐（S4-11）
 *
 * 将热力图每日记录（含在场学习时长 study_time_daily 与离散学习活动 count）、
 * 可选当日尚未刷盘的内存学习时长（pendingTodaySeconds）、
 * 番茄专注时长（pomodoro_stats_overview.daily.focusSeconds）与
 * FSRS 闪卡复习时长（fsrs_get_review_statistics.dailyReviews.studyMs，毫秒转秒）
 * 按本地日历日期统一聚合，避免：
 * 1. 仅统计单一计时器或忽略毫秒→秒换算导致学习时长严重低估；
 * 2. 同一天重叠计时器重复累加（取单日各计时口径最大值作为保守下界）；
 * 3. 在存在多日非计时学习活动、但累计计时不足 1 分钟时在同一张卡片上展示
 *    「学习时长 不到 1 分钟」与「活跃 N 天」的自相矛盾文案。
 */

export interface HeatmapStudyEntry {
  date: string;
  count: number;
  studySeconds?: number;
}

export interface PomodoroDailyEntry {
  date: string;
  focusSeconds?: number;
  completedCount?: number;
}

export interface FsrsDailyReviewEntry {
  date: string;
  total?: number;
  studyMs?: number;
}

export interface ReconcileStudyWindowInput {
  startKey: string;
  endKey: string;
  maxDays: number;
  heatmapData: readonly HeatmapStudyEntry[];
  pendingTodaySeconds?: number;
  pomodoroDaily?: readonly PomodoroDailyEntry[] | null;
  fsrsDailyReviews?: readonly FsrsDailyReviewEntry[] | null;
}

export type StudyInsightDisplayMode = 'duration' | 'activity' | 'seconds' | 'empty';

export interface ReconciledStudyWindow {
  /** 区间内去重对齐后的有效学习总秒数（永不双算重叠计时器） */
  studySeconds: number;
  /** 区间内离散学习活动总次数（笔记/对话/做题/复习/待办等） */
  totalActivities: number;
  /** 区间内有任意学习活动或计时记录的去重天数（不超过 maxDays） */
  activeDays: number;
  /** 区间内有计时学习记录的去重天数（不超过 maxDays） */
  timedDays: number;
  /** 卡片展示口径：>=60s 展示时长；<60s 但有离散活动切到学习活跃度；仅短计时展示精确秒数；全空展示 0 分钟 */
  displayMode: StudyInsightDisplayMode;
}

function normalizePositiveNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function inRange(date: string, startKey: string, endKey: string): boolean {
  return typeof date === 'string' && date >= startKey && date <= endKey;
}

/**
 * 聚合指定本地日期闭区间 `[startKey, endKey]` 内的学习时长与活跃指标。
 */
export function reconcileStudyWindow(input: ReconcileStudyWindowInput): ReconciledStudyWindow {
  const {
    startKey,
    endKey,
    maxDays,
    heatmapData,
    pendingTodaySeconds = 0,
    pomodoroDaily,
    fsrsDailyReviews,
  } = input;

  const presenceSecondsByDate = new Map<string, number>();
  const pomodoroSecondsByDate = new Map<string, number>();
  const fsrsSecondsByDate = new Map<string, number>();
  const activitiesByDate = new Map<string, number>();
  const allDates = new Set<string>();

  for (const item of heatmapData) {
    if (!item || !inRange(item.date, startKey, endKey)) continue;
    const count = normalizePositiveNumber(item.count);
    const secs = normalizePositiveNumber(item.studySeconds);
    if (count > 0) {
      activitiesByDate.set(item.date, (activitiesByDate.get(item.date) ?? 0) + count);
      allDates.add(item.date);
    }
    if (secs > 0) {
      presenceSecondsByDate.set(item.date, (presenceSecondsByDate.get(item.date) ?? 0) + secs);
      allDates.add(item.date);
    }
  }

  const pendingToday = Math.floor(normalizePositiveNumber(pendingTodaySeconds));
  if (pendingToday > 0 && inRange(endKey, startKey, endKey)) {
    presenceSecondsByDate.set(endKey, (presenceSecondsByDate.get(endKey) ?? 0) + pendingToday);
    allDates.add(endKey);
  }

  if (Array.isArray(pomodoroDaily)) {
    for (const item of pomodoroDaily) {
      if (!item || !inRange(item.date, startKey, endKey)) continue;
      const focusSec = normalizePositiveNumber(item.focusSeconds);
      const completed = normalizePositiveNumber(item.completedCount);
      if (focusSec > 0) {
        pomodoroSecondsByDate.set(item.date, (pomodoroSecondsByDate.get(item.date) ?? 0) + focusSec);
        allDates.add(item.date);
      }
      if (completed > 0 && !activitiesByDate.has(item.date)) {
        activitiesByDate.set(item.date, completed);
        allDates.add(item.date);
      }
    }
  }

  if (Array.isArray(fsrsDailyReviews)) {
    for (const item of fsrsDailyReviews) {
      if (!item || !inRange(item.date, startKey, endKey)) continue;
      // studyMs 为毫秒，统一换算为整数秒，避免 ms/sec 单位混用
      const reviewSec = Math.round(normalizePositiveNumber(item.studyMs) / 1000);
      const total = normalizePositiveNumber(item.total);
      if (reviewSec > 0) {
        fsrsSecondsByDate.set(item.date, (fsrsSecondsByDate.get(item.date) ?? 0) + reviewSec);
        allDates.add(item.date);
      }
      if (total > 0 && !activitiesByDate.has(item.date)) {
        activitiesByDate.set(item.date, total);
        allDates.add(item.date);
      }
    }
  }

  let studySeconds = 0;
  let totalActivities = 0;
  let timedDaysCount = 0;
  let activeDaysCount = 0;

  for (const date of allDates) {
    const dayPresence = presenceSecondsByDate.get(date) ?? 0;
    const dayPomodoro = pomodoroSecondsByDate.get(date) ?? 0;
    const dayFsrs = fsrsSecondsByDate.get(date) ?? 0;
    // 单日取各计时来源的最大值作为保守下界，既不遗漏番茄/闪卡独立计时，也不重复累加并行计时
    const effectiveDaySeconds = Math.max(dayPresence, dayPomodoro, dayFsrs);
    const dayActivities = activitiesByDate.get(date) ?? 0;

    if (effectiveDaySeconds > 0) {
      studySeconds += effectiveDaySeconds;
      timedDaysCount += 1;
    }
    if (dayActivities > 0) {
      totalActivities += dayActivities;
    }
    if (dayActivities > 0 || effectiveDaySeconds > 0) {
      activeDaysCount += 1;
    }
  }

  const clampedMaxDays = Math.max(1, Math.floor(maxDays));
  const activeDays = Math.min(clampedMaxDays, activeDaysCount);
  const timedDays = Math.min(clampedMaxDays, timedDaysCount);

  let displayMode: StudyInsightDisplayMode;
  if (studySeconds >= 60) {
    displayMode = 'duration';
  } else if (totalActivities > 0) {
    displayMode = 'activity';
  } else if (studySeconds > 0) {
    displayMode = 'seconds';
  } else {
    displayMode = 'empty';
  }

  return {
    studySeconds,
    totalActivities,
    activeDays,
    timedDays,
    displayMode,
  };
}
