/**
 * 会话时间分组公共逻辑
 *
 * 侧栏（SessionSidebarContent）与会话浏览器（SessionBrowser）共用的
 * 「今天/昨天/最近7天/最近30天/更早」日历日界分段。
 * 统一使用日历运算（而非固定 86400000ms 偏移），避免夏令时切换日产生 1 小时偏差，
 * 也保证相对时间文案（N 天前）与分段标题（昨天/最近7天）落在同一天界。
 */

export type SessionTimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

export const SESSION_TIME_GROUP_ORDER: SessionTimeGroup[] = [
  'today',
  'yesterday',
  'previous7Days',
  'previous30Days',
  'older',
];

/** timeGroups.* i18n 子键与 SessionTimeGroup 同名，方便 t(`page.timeGroups.${group}`) 直取 */
interface TimeGroupBoundaries {
  startOfToday: number;
  startOfYesterday: number;
  startOf7DaysAgo: number;
  startOf30DaysAgo: number;
}

const computeBoundaries = (now: Date): TimeGroupBoundaries => {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  return {
    startOfToday: new Date(year, month, day).getTime(),
    startOfYesterday: new Date(year, month, day - 1).getTime(),
    startOf7DaysAgo: new Date(year, month, day - 7).getTime(),
    startOf30DaysAgo: new Date(year, month, day - 30).getTime(),
  };
};

const resolveTimeGroup = (timestamp: number, boundaries: TimeGroupBoundaries): SessionTimeGroup => {
  if (timestamp >= boundaries.startOfToday) return 'today';
  if (timestamp >= boundaries.startOfYesterday) return 'yesterday';
  if (timestamp >= boundaries.startOf7DaysAgo) return 'previous7Days';
  if (timestamp >= boundaries.startOf30DaysAgo) return 'previous30Days';
  return 'older';
};

/** 获取单条时间的日历分组 */
export const getSessionTimeGroup = (isoString: string, now: Date = new Date()): SessionTimeGroup =>
  resolveTimeGroup(new Date(isoString).getTime(), computeBoundaries(now));

/**
 * 按 updatedAt 的日历分组批量归类（日界只计算一次，保证一次分组过程内的一致性）。
 * 输入若已按 updatedAt 降序排序，各桶内保持该顺序。
 */
export const groupSessionsByTime = <T extends { updatedAt: string }>(
  sessions: T[],
  now: Date = new Date()
): Map<SessionTimeGroup, T[]> => {
  const groups = new Map<SessionTimeGroup, T[]>();
  SESSION_TIME_GROUP_ORDER.forEach((g) => groups.set(g, []));

  const boundaries = computeBoundaries(now);
  sessions.forEach((session) => {
    const group = resolveTimeGroup(new Date(session.updatedAt).getTime(), boundaries);
    groups.get(group)?.push(session);
  });

  return groups;
};

/**
 * 日历日差（今天=0、昨天=1……）。
 * 用于相对时间文案的「N 天前」，与 getSessionTimeGroup 使用同一天界语义，
 * 替代旧的 diffMs / 86400000 除法（后者在跨日临界与夏令时下与分段标题不一致）。
 */
export const getCalendarDaysDiff = (isoString: string, now: Date = new Date()): number => {
  const date = new Date(isoString);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // 跨夏令时的两个日界差可能偏离 24h 整数倍 ±1h，round 收敛回整数天
  return Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
};
