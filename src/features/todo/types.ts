/**
 * 待办管理系统前端类型定义
 */

// ============================================================================
// 核心数据类型
// ============================================================================

export interface TodoList {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  sortOrder: number;
  isDefault: boolean;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TodoItem {
  id: string;
  todoListId: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  reminder?: string;
  tagsJson: string;
  sortOrder: number;
  parentId?: string;
  completedAt?: string;
  repeatJson?: string;
  attachmentsJson: string;
  estimatedPomodoros?: number;
  completedPomodoros?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type TodoStatus = 'pending' | 'completed' | 'cancelled';
export type TodoPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TodoActiveSummary {
  todayItems: TodoSummaryItem[];
  overdueItems: TodoSummaryItem[];
  upcomingHighPriority: TodoSummaryItem[];
  stats: TodoStats;
}

export interface TodoSummaryItem {
  id: string;
  title: string;
  priority: string;
  dueDate?: string;
  dueTime?: string;
  listTitle: string;
}

export interface TodoStats {
  totalPending: number;
  todayDue: number;
  overdueCount: number;
  todayCompleted: number;
}

// ============================================================================
// 输入参数
// ============================================================================

export interface CreateTodoListInput {
  title: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface UpdateTodoListInput {
  id: string;
  title?: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface CreateTodoItemInput {
  todoListId: string;
  title: string;
  description?: string;
  priority?: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  tags?: string[];
  parentId?: string;
  attachments?: string[];
  repeatJson?: string;
}

export interface UpdateTodoItemInput {
  id: string;
  title?: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  reminder?: string;
  tags?: string[];
  parentId?: string;
  attachments?: string[];
  repeatJson?: string;
  estimatedPomodoros?: number;
  completedPomodoros?: number;
}

// ============================================================================
// 视图过滤
// ============================================================================

export type TodoViewFilter = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed';

export interface TodoFilterState {
  view: TodoViewFilter;
  search: string;
  priorityFilter: TodoPriority | null;
  showCompleted: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

export function parseTags(tagsJson: string): string[] {
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

export function parseAttachments(attachmentsJson: string): string[] {
  try {
    return JSON.parse(attachmentsJson);
  } catch {
    return [];
  }
}

export const PRIORITY_CONFIG: Record<TodoPriority, { labelKey: string; color: string; icon: string }> = {
  none: { labelKey: 'todo:priority.none', color: 'text-[color:var(--text-muted)]', icon: 'Minus' },
  low: { labelKey: 'todo:priority.low', color: 'text-[color:hsl(var(--info))]', icon: 'ArrowDown' },
  medium: { labelKey: 'todo:priority.medium', color: 'text-[color:hsl(var(--warning))]', icon: 'ArrowRight' },
  high: { labelKey: 'todo:priority.high', color: 'text-[color:hsl(var(--brand-warm,var(--warning)))]', icon: 'ArrowUp' },
  urgent: { labelKey: 'todo:priority.urgent', color: 'text-[color:hsl(var(--destructive))]', icon: 'AlertTriangle' },
};

export const STATUS_CONFIG: Record<TodoStatus, { labelKey: string; color: string }> = {
  pending: { labelKey: 'todo:status.pending', color: 'text-[color:var(--text-muted)]' },
  completed: { labelKey: 'todo:status.completed', color: 'text-[color:hsl(var(--success))]' },
  cancelled: { labelKey: 'todo:status.cancelled', color: 'text-[color:var(--text-muted)]' },
};

// ============================================================================
// 重复规则（与后端 repeat_json 契约一致）
// ============================================================================

export type TodoRepeatFreq = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'weekdays';

export interface TodoRepeatRule {
  freq: TodoRepeatFreq;
  /** 间隔（daily/weekly/monthly/yearly 生效，weekdays 忽略），1-999 */
  interval: number;
}

const VALID_REPEAT_FREQS: TodoRepeatFreq[] = ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'];

export function parseRepeatRule(repeatJson?: string | null): TodoRepeatRule | null {
  if (!repeatJson || !repeatJson.trim()) return null;
  try {
    const raw = JSON.parse(repeatJson) as { freq?: unknown; interval?: unknown };
    if (typeof raw.freq !== 'string' || !VALID_REPEAT_FREQS.includes(raw.freq as TodoRepeatFreq)) {
      return null;
    }
    const interval =
      typeof raw.interval === 'number' && Number.isFinite(raw.interval)
        ? Math.min(999, Math.max(1, Math.round(raw.interval)))
        : 1;
    return { freq: raw.freq as TodoRepeatFreq, interval };
  } catch {
    return null;
  }
}

export function serializeRepeatRule(rule: TodoRepeatRule): string {
  return JSON.stringify({ freq: rule.freq, interval: rule.interval });
}

/** 重复频率选项（'none' 表示不重复，序列化为清空 repeatJson） */
export const REPEAT_OPTIONS: Array<{ value: TodoRepeatFreq | 'none'; labelKey: string }> = [
  { value: 'none', labelKey: 'todo:repeat.none' },
  { value: 'daily', labelKey: 'todo:repeat.daily' },
  { value: 'weekdays', labelKey: 'todo:repeat.weekdays' },
  { value: 'weekly', labelKey: 'todo:repeat.weekly' },
  { value: 'monthly', labelKey: 'todo:repeat.monthly' },
  { value: 'yearly', labelKey: 'todo:repeat.yearly' },
];

/** 重复规则的 i18n 描述（interval>1 时用 everyN* 键，携带 count 插值） */
export function repeatRuleI18n(rule: TodoRepeatRule): { key: string; count?: number } {
  if (rule.freq === 'weekdays') return { key: 'todo:repeat.weekdays' };
  if (rule.interval <= 1) return { key: `todo:repeat.${rule.freq}` };
  const everyKeys: Record<Exclude<TodoRepeatFreq, 'weekdays'>, string> = {
    daily: 'todo:repeat.everyNDays',
    weekly: 'todo:repeat.everyNWeeks',
    monthly: 'todo:repeat.everyNMonths',
    yearly: 'todo:repeat.everyNYears',
  };
  return { key: everyKeys[rule.freq], count: rule.interval };
}

/** 本地时区的今天（YYYY-MM-DD）。注意不能用 toISOString()——那是 UTC 日期 */
export function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isOverdue(item: TodoItem): boolean {
  if (!item.dueDate || item.status !== 'pending') return false;
  return item.dueDate < localToday();
}

export function isDueToday(item: TodoItem): boolean {
  if (!item.dueDate || item.status !== 'pending') return false;
  return item.dueDate === localToday();
}
