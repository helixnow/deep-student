import type { ChatSession } from '../types/session';

// 时间分组类型
export type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

// 获取会话的时间分组
export const getTimeGroup = (isoString: string): TimeGroup => {
  const date = new Date(isoString);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOf7DaysAgo = new Date(startOfToday.getTime() - 7 * 86400000);
  const startOf30DaysAgo = new Date(startOfToday.getTime() - 30 * 86400000);

  if (date >= startOfToday) return 'today';
  if (date >= startOfYesterday) return 'yesterday';
  if (date >= startOf7DaysAgo) return 'previous7Days';
  if (date >= startOf30DaysAgo) return 'previous30Days';
  return 'older';
};

// 按时间分组会话
export const groupSessionsByTime = (sessions: ChatSession[]): Map<TimeGroup, ChatSession[]> => {
  const groups = new Map<TimeGroup, ChatSession[]>();
  const order: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'];
  order.forEach(g => groups.set(g, []));
  
  sessions.forEach(session => {
    const group = getTimeGroup(session.updatedAt);
    groups.get(group)?.push(session);
  });
  
  return groups;
};
