// 时间分组类型
export type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

interface TimeGroupBoundaries {
  startOfToday: number;
  startOfYesterday: number;
  startOf7DaysAgo: number;
  startOf30DaysAgo: number;
}

// 使用日历运算（而非固定 86400000ms 偏移）计算本地日界，避免夏令时切换日产生 1 小时偏差
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

const resolveTimeGroup = (timestamp: number, boundaries: TimeGroupBoundaries): TimeGroup => {
  if (timestamp >= boundaries.startOfToday) return 'today';
  if (timestamp >= boundaries.startOfYesterday) return 'yesterday';
  if (timestamp >= boundaries.startOf7DaysAgo) return 'previous7Days';
  if (timestamp >= boundaries.startOf30DaysAgo) return 'previous30Days';
  return 'older';
};

// 获取会话的时间分组
export const getTimeGroup = (isoString: string): TimeGroup =>
  resolveTimeGroup(new Date(isoString).getTime(), computeBoundaries(new Date()));

// 按时间分组会话（日界只计算一次，保证一次分组过程内的一致性）
export const groupSessionsByTime = <T extends { updatedAt: string }>(
  sessions: T[]
): Map<TimeGroup, T[]> => {
  const groups = new Map<TimeGroup, T[]>();
  const order: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'];
  order.forEach(g => groups.set(g, []));

  const boundaries = computeBoundaries(new Date());
  sessions.forEach(session => {
    const group = resolveTimeGroup(new Date(session.updatedAt).getTime(), boundaries);
    groups.get(group)?.push(session);
  });

  return groups;
};
