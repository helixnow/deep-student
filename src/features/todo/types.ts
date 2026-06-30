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

export type TodoViewFilter = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed' | 'matrix';

/** 列表排序方式（manual = 后端 sort_order，仅 all 视图可拖拽） */
export type TodoSortBy = 'manual' | 'dueDate' | 'priority' | 'title';

export interface TodoFilterState {
  view: TodoViewFilter;
  search: string;
  priorityFilter: TodoPriority | null;
  showCompleted: boolean;
  sortBy: TodoSortBy;
}

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * 客户端排序（不改后端顺序）。manual 原样返回（后端已按 sort_order 排）。
 * dueDate：无到期日排最后，同日按优先级；priority：同级按到期日；title：本地化字典序。
 */
export function sortTodoItems(items: TodoItem[], sortBy: TodoSortBy): TodoItem[] {
  if (sortBy === 'manual') return items;
  const sorted = [...items];
  switch (sortBy) {
    case 'dueDate':
      sorted.sort((a, b) => {
        if (a.dueDate !== b.dueDate) {
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate < b.dueDate ? -1 : 1;
        }
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      });
      break;
    case 'priority':
      sorted.sort((a, b) => {
        const d = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (d !== 0) return d;
        if (a.dueDate !== b.dueDate) {
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate < b.dueDate ? -1 : 1;
        }
        return 0;
      });
      break;
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN-u-co-pinyin'));
      break;
  }
  return sorted;
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
  /**
   * weekly 专用：多选星期（0=周日..6=周六，与 Date.getDay() 一致），
   * 如「每周一三五」= [1,3,5]。旧版本客户端忽略该字段降级为普通每周。
   */
  byWeekday?: number[];
}

const VALID_REPEAT_FREQS: TodoRepeatFreq[] = ['daily', 'weekly', 'monthly', 'yearly', 'weekdays'];

export function parseRepeatRule(repeatJson?: string | null): TodoRepeatRule | null {
  if (!repeatJson || !repeatJson.trim()) return null;
  try {
    const raw = JSON.parse(repeatJson) as {
      freq?: unknown;
      interval?: unknown;
      byWeekday?: unknown;
    };
    if (typeof raw.freq !== 'string' || !VALID_REPEAT_FREQS.includes(raw.freq as TodoRepeatFreq)) {
      return null;
    }
    const interval =
      typeof raw.interval === 'number' && Number.isFinite(raw.interval)
        ? Math.min(999, Math.max(1, Math.round(raw.interval)))
        : 1;
    const rule: TodoRepeatRule = { freq: raw.freq as TodoRepeatFreq, interval };
    if (raw.freq === 'weekly' && Array.isArray(raw.byWeekday)) {
      const days = [...new Set(
        raw.byWeekday.filter(
          (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
        ),
      )].sort((a, b) => a - b);
      if (days.length > 0) rule.byWeekday = days;
    }
    return rule;
  } catch {
    return null;
  }
}

export function serializeRepeatRule(rule: TodoRepeatRule): string {
  if (rule.freq === 'weekly' && rule.byWeekday && rule.byWeekday.length > 0) {
    return JSON.stringify({
      freq: rule.freq,
      interval: rule.interval,
      byWeekday: rule.byWeekday,
    });
  }
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

/**
 * 重复规则的完整可读文案（含多选星期），统一供行内/详情/chip 使用。
 * `t` 为 react-i18next 的翻译函数。
 */
export function repeatRuleLabel(
  rule: TodoRepeatRule,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (rule.freq === 'weekly' && rule.byWeekday && rule.byWeekday.length > 0) {
    const dayNames = rule.byWeekday
      .map((d) => t(`todo:repeat.weekdayShort.${d}`))
      .join(t('todo:repeat.weekdayJoin'));
    if (rule.interval <= 1) {
      return t('todo:repeat.weeklyOn', { days: dayNames });
    }
    return t('todo:repeat.everyNWeeksOn', { count: rule.interval, days: dayNames });
  }
  const { key, count } = repeatRuleI18n(rule);
  return count !== undefined ? t(key, { count }) : t(key);
}

// ============================================================================
// 四象限（Eisenhower Matrix）
// ============================================================================

export type EisenhowerQuadrant =
  | 'urgentImportant'
  | 'importantNotUrgent'
  | 'urgentNotImportant'
  | 'neither';

export const EISENHOWER_QUADRANTS: EisenhowerQuadrant[] = [
  'urgentImportant',
  'importantNotUrgent',
  'urgentNotImportant',
  'neither',
];

/**
 * 四象限归类：重要 = 优先级 high/urgent；紧急 = 今天到期或已逾期。
 * 与滴答清单的默认映射一致（优先级×时间两轴）。
 */
export function classifyEisenhower(item: TodoItem, today: string = localToday()): EisenhowerQuadrant {
  const important = item.priority === 'high' || item.priority === 'urgent';
  const urgent = Boolean(item.dueDate) && (item.dueDate as string) <= today;
  if (urgent && important) return 'urgentImportant';
  if (important) return 'importantNotUrgent';
  if (urgent) return 'urgentNotImportant';
  return 'neither';
}

// ============================================================================
// 时间段分组（upcoming 视图）
// ============================================================================

export type TodoDueBucket = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later';

export interface TodoDueGroup {
  bucket: TodoDueBucket;
  items: TodoItem[];
}

/** 本地日期 + N 天 → YYYY-MM-DD */
function localDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 按到期时间段分组（逾期/今天/明天/7 天内/以后），空组剔除。
 * 输入应已按需要排序；组内保持原有顺序。无到期日归入 later。
 */
export function groupItemsByDueBucket(items: TodoItem[]): TodoDueGroup[] {
  const today = localToday();
  const tomorrow = localDatePlus(1);
  const weekEnd = localDatePlus(6);

  const buckets: Record<TodoDueBucket, TodoItem[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    later: [],
  };

  for (const item of items) {
    if (!item.dueDate) {
      buckets.later.push(item);
    } else if (item.dueDate < today) {
      buckets.overdue.push(item);
    } else if (item.dueDate === today) {
      buckets.today.push(item);
    } else if (item.dueDate === tomorrow) {
      buckets.tomorrow.push(item);
    } else if (item.dueDate <= weekEnd) {
      buckets.thisWeek.push(item);
    } else {
      buckets.later.push(item);
    }
  }

  return (Object.keys(buckets) as TodoDueBucket[])
    .filter((k) => buckets[k].length > 0)
    .map((bucket) => ({ bucket, items: buckets[bucket] }));
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

// ============================================================================
// 重复规则：下次出现预览（与后端 step_due_date/compute_next_due_date 语义一致）
// ============================================================================

function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/** 加 N 个月，日期超过目标月天数时收敛到月末（与 chrono checked_add_months 一致） */
function addMonthsClamped(d: Date, n: number): Date {
  const targetMonth = d.getMonth() + n;
  const lastDay = new Date(d.getFullYear(), targetMonth + 1, 0).getDate();
  return new Date(d.getFullYear(), targetMonth, Math.min(d.getDate(), lastDay));
}

/** 周一为一周起点（与后端 step_weekly_by_weekday 一致） */
export function mondayWeekStart(d: Date): Date {
  const offset = (d.getDay() + 6) % 7;
  return addDays(d, -offset);
}

/** 单步推进一次重复（不含逾期跳过），无法推进返回 null */
function stepRepeatDate(from: Date, rule: TodoRepeatRule): Date | null {
  const interval = Math.max(1, rule.interval || 1);
  switch (rule.freq) {
    case 'daily':
      return addDays(from, interval);
    case 'weekly': {
      const days = rule.byWeekday?.filter((d) => d >= 0 && d <= 6) ?? [];
      if (days.length === 0) return addDays(from, 7 * interval);
      const fromWeek = mondayWeekStart(from).getTime();
      const scanLimit = interval * 7 + 7;
      let d = addDays(from, 1);
      for (let i = 0; i < scanLimit; i++) {
        if (days.includes(d.getDay())) {
          const weekDiff = Math.round((mondayWeekStart(d).getTime() - fromWeek) / 604800000);
          if (weekDiff % interval === 0) return d;
        }
        d = addDays(d, 1);
      }
      return null;
    }
    case 'monthly':
      return addMonthsClamped(from, interval);
    case 'yearly':
      return addMonthsClamped(from, 12 * interval);
    case 'weekdays': {
      let d = addDays(from, 1);
      while (d.getDay() === 0 || d.getDay() === 6) d = addDays(d, 1);
      return d;
    }
    default:
      return null;
  }
}

/**
 * 重复任务的下次出现日期（YYYY-MM-DD）。
 *
 * 从 fromDate（当前到期日）推进一步；若结果仍早于今天则继续推进
 * （与后端 compute_next_due_date 的「跳过已错过周期」行为一致）。
 */
export function nextRepeatOccurrence(
  rule: TodoRepeatRule,
  fromDate: string,
  today: string = localToday(),
): string | null {
  const from = parseLocalDate(fromDate);
  if (!from) return null;
  let next = stepRepeatDate(from, rule);
  let guard = 0;
  while (next && formatLocalDate(next) < today) {
    next = stepRepeatDate(next, rule);
    guard += 1;
    if (guard > 1000) return null;
  }
  return next ? formatLocalDate(next) : null;
}
