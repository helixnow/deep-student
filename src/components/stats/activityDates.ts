/**
 * 活跃度统计的日期工具（统一本地时区语义）
 *
 * 热力图/统计主页都要计算"今天/连续天数"，且后端日期串是 "YYYY-MM-DD"。
 * 裸 new Date("YYYY-MM-DD") 会按 UTC 解析，负时区用户会整体偏移一天，
 * 所有日期换算集中到这里，统一走本地时区。
 */

/** Date → 本地时区 "YYYY-MM-DD" */
export function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" / "YYYY/M/D" → 规范化 "YYYY-MM-DD"；非法输入原样返回 */
export function normalizeDateKey(dateStr: string): string {
  const parts = dateStr.split(/[-/]/).map(Number);
  if (parts.length < 3 || parts.some(p => !Number.isFinite(p) || p <= 0)) return dateStr;
  const [y, m, d] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 纯日期串补 T00:00:00 强制本地时区解析（含时间的串原样交给 Date） */
export function parseLocalDate(dateStr: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(`${dateStr}T00:00:00`)
    : new Date(dateStr);
}

/**
 * 连续学习天数（本地时区）。
 * 今天还没做题时从昨天起算，避免凌晨"断签"清零。
 */
export function computeCurrentStreak(points: Array<{ date: string; count: number }>): number {
  const activeDateSet = new Set(
    points.filter(p => p.count > 0).map(p => normalizeDateKey(p.date))
  );
  if (activeDateSet.size === 0) return 0;

  const cursor = new Date();
  if (!activeDateSet.has(toLocalDateStr(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (activeDateSet.has(toLocalDateStr(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** 今天（本地时区）的做题数；无记录返回 0 */
export function todayActivityCount(points: Array<{ date: string; count: number }>): number {
  const today = toLocalDateStr(new Date());
  let sum = 0;
  for (const p of points) {
    if (normalizeDateKey(p.date) === today) sum += p.count;
  }
  return sum;
}
