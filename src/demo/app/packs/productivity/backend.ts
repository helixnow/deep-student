/**
 * 第 10 章「效率工具」的内存后端：待办（todo_*）、番茄钟（pomodoro_*）、定时任务（chat_v2_automation_*）。
 * 语义对齐 src-tauri/src/vfs/repos/todo_repo.rs 的查询口径（今日含逾期、即将到期 7 天、软删进回收站等）。
 * 只依赖演示数据模块与 `import type`，不触达 app 模块（见 ../../types.ts）。
 */
import type { TodoItem, TodoList, TodoPriority } from '@/features/todo/types';
import type { PomodoroRecord } from '@/features/pomodoro/api';
import { tr } from '../../../lang';
import type { DemoArgs } from '../../types';
import {
  DEMO_BREAKDOWNS,
  DEMO_LINKED_NODES,
  INBOX_ID,
  dayOffset,
  isoAt,
  pomodoroDaily,
  seedAutomationRuns,
  seedAutomations,
  seedItems,
  seedLists,
  ymd,
} from './seed';

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const PRIORITIES: TodoPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

let lists: TodoList[] = [];
let items: TodoItem[] = [];
let records: PomodoroRecord[] = [];
let automations: Record<string, unknown>[] = [];
let runs: Record<string, unknown>[] = [];
let backgroundEnabled = true;
let seq = 0;
let ready = false;

function ensureSeeded(): void {
  if (ready) return;
  ready = true;
  lists = seedLists();
  items = seedItems();
  automations = seedAutomations();
  runs = seedAutomationRuns();
  records = seedRecords();
}

const nowIso = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_demo_${Date.now().toString(36)}${(seq++).toString(36)}`;
const today = () => ymd(new Date());
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function notFound(what: string, id: unknown): never {
  throw new Error(`${what} not found: ${String(id)}`);
}

// ============================================================================
// 番茄记录：今天 3 个完成 + 1 个中断，过去的天按逐日数据铺开
// ============================================================================

function seedRecords(): PomodoroRecord[] {
  const out: PomodoroRecord[] = [];
  const push = (daysAgo: number, hh: number, mm: number, todoItemId: string | undefined, status: 'completed' | 'interrupted', minutes = 25) => {
    const start = new Date(isoAt(-daysAgo, hh, mm));
    const actual = status === 'completed' ? minutes * 60 : 11 * 60;
    out.push({
      id: `pomo_${daysAgo}_${hh}${mm}`,
      ...(todoItemId ? { todoItemId } : {}),
      startTime: start.toISOString(),
      endTime: new Date(start.getTime() + actual * 1000).toISOString(),
      duration: minutes * 60,
      actualDuration: actual,
      type: 'work',
      status,
      createdAt: start.toISOString(),
    });
  };
  const daily = pomodoroDaily(120);
  const hours = [8, 9, 10, 14, 15, 16, 19, 20, 21];
  daily.forEach((day, idx) => {
    const daysAgo = daily.length - 1 - idx;
    if (daysAgo === 0) return;
    for (let i = 0; i < day.completedCount; i++) {
      push(daysAgo, hours[(i + daysAgo) % hours.length], (i * 7) % 30, undefined, 'completed', 25);
    }
    // 逐日数据里的零头（5 分钟的倍数）记成一个短专注
    const extra = day.focusSeconds - day.completedCount * 25 * 60;
    if (extra > 0) push(daysAgo, 22, 0, undefined, 'completed', extra / 60);
    if (day.interruptedCount) push(daysAgo, 13, 30, undefined, 'interrupted');
  });
  push(0, 7, 40, 'todo_reading', 'completed');
  push(0, 8, 30, 'todo_gaoshu_3_2', 'completed');
  push(0, 9, 5, 'todo_gaoshu_3_2', 'completed');
  push(0, 9, 40, 'todo_linalg_wrong', 'interrupted');
  // 已完成的番茄数与待办上记录的 completedPomodoros 对齐：线代那次被打断，补一次完成
  push(1, 20, 10, 'todo_linalg_wrong', 'completed');
  push(2, 9, 0, 'todo_done_ch2', 'completed');
  push(2, 9, 35, 'todo_done_ch2', 'completed');
  push(2, 10, 10, 'todo_done_ch2', 'completed');
  push(1, 7, 45, 'todo_done_words', 'completed');
  return out;
}

const localDate = (iso: string) => ymd(new Date(iso));

function dailyStats(days: number) {
  const n = Math.min(366, Math.max(1, Math.round(days || 30)));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dayOffset(-i);
    const work = records.filter((r) => r.type === 'work' && localDate(r.startTime) === date);
    out.push({
      date,
      completedCount: work.filter((r) => r.status === 'completed').length,
      focusSeconds: work.reduce((s, r) => s + r.actualDuration, 0),
      interruptedCount: work.filter((r) => r.status === 'interrupted').length,
    });
  }
  return out;
}

function todayStats() {
  const d = dailyStats(1)[0];
  return { completedCount: d.completedCount, totalFocusSeconds: d.focusSeconds, interruptedCount: d.interruptedCount };
}

function streak(): { currentStreakDays: number; longestStreakDays: number } {
  const days = dailyStats(120);
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].completedCount > 0) current++;
    else if (i !== days.length - 1) break;
  }
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.completedCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return { currentStreakDays: current, longestStreakDays: longest };
}

function pomodoroOverview(days: number) {
  const daily = dailyStats(days);
  const today = daily[daily.length - 1];
  const weekly: Record<string, { weekStart: string; completedCount: number; focusSeconds: number; interruptedCount: number; activeDays: number }> = {};
  for (const d of daily) {
    const dt = new Date(`${d.date}T00:00:00`);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    const key = ymd(dt);
    const w = (weekly[key] ??= { weekStart: key, completedCount: 0, focusSeconds: 0, interruptedCount: 0, activeDays: 0 });
    w.completedCount += d.completedCount;
    w.focusSeconds += d.focusSeconds;
    w.interruptedCount += d.interruptedCount;
    if (d.completedCount > 0) w.activeDays++;
  }
  const completedFocusSeconds = records
    .filter((r) => r.type === 'work' && r.status === 'completed' && localDate(r.startTime) === today.date)
    .reduce((s, r) => s + r.actualDuration, 0);
  return {
    today: { completedCount: today.completedCount, totalFocusSeconds: today.focusSeconds, interruptedCount: today.interruptedCount, completedFocusSeconds },
    streak: streak(),
    daily,
    weekly: Object.values(weekly).sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
  };
}

function focusSummary(todoItemId: string) {
  const mine = records.filter((r) => r.todoItemId === todoItemId && r.type === 'work');
  const byDay = new Map<string, { date: string; focusSeconds: number; completedCount: number; interruptedCount: number }>();
  for (const r of mine) {
    const date = localDate(r.startTime);
    const d = byDay.get(date) ?? { date, focusSeconds: 0, completedCount: 0, interruptedCount: 0 };
    d.focusSeconds += r.actualDuration;
    if (r.status === 'completed') d.completedCount++;
    else d.interruptedCount++;
    byDay.set(date, d);
  }
  const sorted = [...mine].sort((a, b) => a.startTime.localeCompare(b.startTime));
  return {
    todoItemId,
    todoTitle: items.find((i) => i.id === todoItemId)?.title ?? null,
    totalFocusSeconds: mine.reduce((s, r) => s + r.actualDuration, 0),
    completedCount: mine.filter((r) => r.status === 'completed').length,
    interruptedCount: mine.filter((r) => r.status === 'interrupted').length,
    firstFocusAt: sorted[0]?.startTime ?? null,
    lastFocusAt: sorted[sorted.length - 1]?.startTime ?? null,
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

// ============================================================================
// 待办
// ============================================================================

const live = () => items.filter((i) => !i.deletedAt);
const liveLists = () => lists.filter((l) => !l.deletedAt);
const prio = (i: TodoItem) => PRIORITY_RANK[i.priority] ?? 4;
const statusRank = (i: TodoItem) => (i.status === 'pending' ? 0 : i.status === 'completed' ? 1 : 2);
const cmpStr = (a?: string, b?: string) => (a ?? '').localeCompare(b ?? '');
/** NULLS LAST */
const cmpNullable = (a?: string, b?: string) => (a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);

function sortLists(ls: TodoList[]): TodoList[] {
  return [...ls].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sortOrder - b.sortOrder);
}

function byDueThenPriority(a: TodoItem, b: TodoItem): number {
  return cmpStr(a.dueDate, b.dueDate) || prio(a) - prio(b) || cmpNullable(a.dueTime, b.dueTime) || a.sortOrder - b.sortOrder;
}

function getItem(id: unknown): TodoItem {
  return items.find((i) => i.id === id && !i.deletedAt) ?? notFound('TodoItem', id);
}

function getList(id: unknown): TodoList {
  return lists.find((l) => l.id === id && !l.deletedAt) ?? notFound('TodoList', id);
}

function touchList(listId: string): void {
  const l = lists.find((x) => x.id === listId);
  if (l) l.updatedAt = nowIso();
}

function descendants(rootId: string, pool: TodoItem[]): TodoItem[] {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const i of pool) {
      if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) {
        ids.add(i.id);
        changed = true;
      }
    }
  }
  return pool.filter((i) => ids.has(i.id));
}

function stepDate(date: string, rule: { freq?: string; interval?: number }): string {
  const d = new Date(`${date}T00:00:00`);
  const n = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case 'daily': d.setDate(d.getDate() + n); break;
    case 'weekly': d.setDate(d.getDate() + 7 * n); break;
    case 'monthly': d.setMonth(d.getMonth() + n); break;
    case 'yearly': d.setFullYear(d.getFullYear() + n); break;
    case 'weekdays':
      do d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6);
      break;
    default: d.setDate(d.getDate() + 1);
  }
  return ymd(d);
}

/** 重复任务完成后派生下一次实例（逾期完成跳到未来，同后端 compute_next_due_date） */
function spawnNext(item: TodoItem): void {
  if (!item.repeatJson || !item.dueDate) return;
  let rule: { freq?: string; interval?: number };
  try {
    rule = JSON.parse(item.repeatJson);
  } catch {
    return;
  }
  let next = stepDate(item.dueDate, rule);
  while (next <= today() && item.dueDate < today()) next = stepDate(next, rule);
  if (live().some((i) => i.todoListId === item.todoListId && i.title === item.title && i.dueDate === next && i.status === 'pending')) return;
  const at = nowIso();
  items.push({
    ...item,
    id: newId('todo'),
    status: 'pending',
    dueDate: next,
    completedAt: undefined,
    completedPomodoros: 0,
    reminder: item.reminder ? `${next}${item.reminder.slice(10)}` : undefined,
    sortOrder: item.sortOrder + 1,
    createdAt: at,
    updatedAt: at,
  });
}

function setStatus(item: TodoItem, status: TodoItem['status']): void {
  const wasCompleted = item.status === 'completed';
  item.status = status;
  item.updatedAt = nowIso();
  if (status === 'completed') {
    item.completedAt = item.updatedAt;
    if (!wasCompleted) spawnNext(item);
  } else {
    delete item.completedAt;
  }
  touchList(item.todoListId);
}

const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function createItem(input: Record<string, unknown>): TodoItem {
  const listId = String(input.todoListId ?? INBOX_ID);
  getList(listId);
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('Invalid argument: title must not be empty');
  const parentId = optStr(input.parentId);
  const siblings = live().filter((i) => i.todoListId === listId && (i.parentId ?? '') === (parentId ?? ''));
  const at = nowIso();
  const dueDate = optStr(input.dueDate);
  const item: TodoItem = {
    id: newId('todo'),
    todoListId: listId,
    title,
    description: optStr(input.description),
    status: 'pending',
    priority: (PRIORITIES.includes(input.priority as TodoPriority) ? input.priority : 'none') as TodoPriority,
    dueDate,
    dueTime: dueDate ? optStr(input.dueTime) : undefined,
    reminder: optStr(input.reminder),
    tagsJson: JSON.stringify(Array.isArray(input.tags) ? input.tags : []),
    sortOrder: siblings.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1,
    parentId,
    repeatJson: optStr(input.repeatJson),
    attachmentsJson: JSON.stringify(Array.isArray(input.attachments) ? input.attachments : []),
    completedPomodoros: 0,
    createdAt: at,
    updatedAt: at,
  };
  items.push(item);
  touchList(listId);
  return item;
}

function updateItem(input: Record<string, unknown>): TodoItem {
  const item = getItem(input.id);
  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (!t) throw new Error('Invalid argument: title must not be empty');
    item.title = t;
  }
  if (input.description !== undefined) item.description = optStr(input.description);
  if (input.priority !== undefined && PRIORITIES.includes(input.priority as TodoPriority)) item.priority = input.priority as TodoPriority;
  if (input.dueDate !== undefined && input.dueDate !== null) item.dueDate = optStr(input.dueDate);
  if (input.dueTime !== undefined && input.dueTime !== null) item.dueTime = optStr(input.dueTime);
  if (!item.dueDate) item.dueTime = undefined;
  if (input.reminder !== undefined && input.reminder !== null) item.reminder = optStr(input.reminder);
  if (Array.isArray(input.tags)) item.tagsJson = JSON.stringify(input.tags);
  if (input.parentId !== undefined && input.parentId !== null) item.parentId = optStr(input.parentId);
  if (Array.isArray(input.attachments)) item.attachmentsJson = JSON.stringify(input.attachments);
  if (input.repeatJson !== undefined && input.repeatJson !== null) item.repeatJson = optStr(input.repeatJson);
  if (typeof input.estimatedPomodoros === 'number') item.estimatedPomodoros = input.estimatedPomodoros || undefined;
  if (input.status !== undefined && input.status !== item.status) {
    setStatus(item, input.status as TodoItem['status']);
  } else {
    item.updatedAt = nowIso();
    touchList(item.todoListId);
  }
  return item;
}

function deleteItems(ids: string[]): string[] {
  const at = nowIso();
  const affected: string[] = [];
  for (const id of ids) {
    const root = items.find((i) => i.id === id && !i.deletedAt);
    if (!root) continue;
    for (const d of descendants(root.id, live())) {
      d.deletedAt = at;
      d.updatedAt = at;
    }
    affected.push(id);
    touchList(root.todoListId);
  }
  return affected;
}

function restoreItem(id: string): TodoItem | null {
  const root = items.find((i) => i.id === id && i.deletedAt);
  if (!root) return null;
  if (!lists.some((l) => l.id === root.todoListId && !l.deletedAt)) return null;
  const stamp = root.deletedAt;
  if (root.parentId && !live().some((i) => i.id === root.parentId)) root.parentId = undefined;
  for (const d of descendants(root.id, items)) {
    if (d.deletedAt === stamp) {
      d.deletedAt = undefined;
      d.updatedAt = nowIso();
    }
  }
  return root;
}

/** 回收站里「可独立恢复」的条目：父项未与它同批次删除 */
function deletedRoots(): TodoItem[] {
  return items.filter((i) => {
    if (!i.deletedAt) return false;
    if (lists.some((l) => l.id === i.todoListId && l.deletedAt)) return false;
    const parent = i.parentId ? items.find((p) => p.id === i.parentId) : undefined;
    return !(parent && parent.deletedAt === i.deletedAt);
  });
}

function countsSnapshot() {
  const t = today();
  const in7 = dayOffset(7);
  const pending = live().filter((i) => i.status === 'pending');
  return {
    todayCount: pending.filter((i) => i.dueDate && i.dueDate <= t).length,
    upcomingCount: pending.filter((i) => i.dueDate && i.dueDate > t && i.dueDate <= in7).length,
    inboxCount: pending.filter((i) => i.todoListId === INBOX_ID).length,
    allPendingCount: pending.length,
    perList: sortLists(liveLists()).map((l) => ({ listId: l.id, pendingCount: pending.filter((i) => i.todoListId === l.id).length })),
  };
}

function statsOverview(days: number) {
  const n = Math.min(366, Math.max(1, Math.round(days || 30)));
  const all = live();
  const t = today();
  const trend = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = dayOffset(-i);
    trend.push({
      date,
      completedCount: all.filter((x) => x.completedAt && localDate(x.completedAt) === date).length,
      createdCount: all.filter((x) => localDate(x.createdAt) === date).length,
    });
  }
  const tagMap = new Map<string, { tag: string; pendingCount: number; completedCount: number }>();
  for (const x of all) {
    for (const tag of new Set(parseTags(x.tagsJson))) {
      const e = tagMap.get(tag) ?? { tag, pendingCount: 0, completedCount: 0 };
      if (x.status === 'completed') e.completedCount++;
      else if (x.status === 'pending') e.pendingCount++;
      tagMap.set(tag, e);
    }
  }
  return {
    totalPending: all.filter((x) => x.status === 'pending').length,
    totalCompleted: all.filter((x) => x.status === 'completed').length,
    completedToday: all.filter((x) => x.completedAt && localDate(x.completedAt) === t).length,
    overdueCount: all.filter((x) => x.status === 'pending' && x.dueDate && x.dueDate < t).length,
    completionTrend: trend,
    byList: sortLists(liveLists()).map((l) => ({
      listId: l.id,
      listTitle: l.title,
      pendingCount: all.filter((x) => x.todoListId === l.id && x.status === 'pending').length,
      completedCount: all.filter((x) => x.todoListId === l.id && x.status === 'completed').length,
    })),
    byPriority: PRIORITIES.map((p) => ({ priority: p, pendingCount: all.filter((x) => x.priority === p && x.status === 'pending').length })),
    byTag: [...tagMap.values()].sort((a, b) => b.pendingCount + b.completedCount - (a.pendingCount + a.completedCount)).slice(0, 100),
  };
}

function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function activeSummary() {
  const t = today();
  const pending = live().filter((i) => i.status === 'pending' && !i.parentId);
  const toSummary = (i: TodoItem) => ({
    id: i.id, title: i.title, priority: i.priority, dueDate: i.dueDate, dueTime: i.dueTime,
    listTitle: lists.find((l) => l.id === i.todoListId)?.title ?? '',
  });
  return {
    todayItems: pending.filter((i) => i.dueDate === t).map(toSummary),
    overdueItems: pending.filter((i) => i.dueDate && i.dueDate < t).map(toSummary),
    upcomingHighPriority: pending.filter((i) => i.dueDate && i.dueDate > t && prio(i) <= 1).map(toSummary),
    stats: {
      totalPending: pending.length,
      todayDue: pending.filter((i) => i.dueDate === t).length,
      overdueCount: pending.filter((i) => i.dueDate && i.dueDate < t).length,
      todayCompleted: live().filter((i) => i.completedAt && localDate(i.completedAt) === t).length,
    },
  };
}

function withStats(list: TodoItem[]) {
  return list.map((i) => {
    const kids = live().filter((k) => k.parentId === i.id);
    return { ...i, subtaskCount: kids.length, completedSubtaskCount: kids.filter((k) => k.status === 'completed').length };
  });
}

function listItemsOf(listId: string, includeCompleted: boolean): TodoItem[] {
  return live()
    .filter((i) => i.todoListId === listId && (includeCompleted || i.status === 'pending'))
    .sort((a, b) => statusRank(a) - statusRank(b) || a.sortOrder - b.sortOrder || cmpStr(a.createdAt, b.createdAt));
}

function batchItems(ids: unknown, fn: (item: TodoItem) => boolean) {
  const out: TodoItem[] = [];
  const skipped: string[] = [];
  for (const id of (Array.isArray(ids) ? ids : []) as string[]) {
    const item = items.find((i) => i.id === id && !i.deletedAt);
    if (item && fn(item)) out.push(item);
    else skipped.push(id);
  }
  return { items: clone(out), skippedIds: skipped };
}

function moveItem(itemId: string, targetListId: string): TodoItem {
  const item = getItem(itemId);
  getList(targetListId);
  const from = item.todoListId;
  for (const d of descendants(item.id, live())) d.todoListId = targetListId;
  if (item.parentId && !live().some((p) => p.id === item.parentId && p.todoListId === targetListId)) item.parentId = undefined;
  item.sortOrder = live().filter((i) => i.todoListId === targetListId && !i.parentId).reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;
  item.updatedAt = nowIso();
  touchList(from);
  touchList(targetListId);
  return item;
}

function handleTodo(cmd: string, args: DemoArgs): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const t = today();
  switch (cmd) {
    // —— 清单 ——
    case 'todo_ensure_inbox':
      return clone(getList(INBOX_ID));
    case 'todo_list_lists':
      return clone(sortLists(liveLists()));
    case 'todo_get_list':
      return clone(lists.find((l) => l.id === args.listId && !l.deletedAt) ?? null);
    case 'todo_create_list': {
      const title = String(input.title ?? '').trim();
      if (!title) throw new Error('Invalid argument: title must not be empty');
      const at = nowIso();
      const list: TodoList = {
        id: newId('tdl'), title, description: optStr(input.description), icon: optStr(input.icon), color: optStr(input.color),
        sortOrder: liveLists().reduce((m, l) => Math.max(m, l.sortOrder), -1) + 1,
        isDefault: false, isFavorite: false, createdAt: at, updatedAt: at,
      };
      lists.push(list);
      return clone(list);
    }
    case 'todo_update_list': {
      const list = getList(input.id);
      if (input.title !== undefined) list.title = String(input.title).trim() || list.title;
      if (input.description !== undefined) list.description = optStr(input.description);
      if (input.icon !== undefined) list.icon = optStr(input.icon);
      if (input.color !== undefined) list.color = optStr(input.color);
      list.updatedAt = nowIso();
      return clone(list);
    }
    case 'todo_delete_list': {
      const list = getList(args.listId);
      if (list.isDefault) throw new Error('INVALID_OPERATION: cannot delete the default list');
      const at = nowIso();
      list.deletedAt = at;
      for (const i of live()) if (i.todoListId === list.id) i.deletedAt = at;
      return null;
    }
    case 'todo_toggle_list_favorite': {
      const list = getList(args.listId);
      list.isFavorite = !list.isFavorite;
      list.updatedAt = nowIso();
      return clone(list);
    }
    case 'todo_reorder_lists': {
      const ids = ((input.listIds ?? []) as string[]);
      ids.forEach((id, idx) => {
        const l = lists.find((x) => x.id === id);
        if (l && !l.isDefault) l.sortOrder = idx + 1;
      });
      return null;
    }
    // —— 回收站 ——
    case 'todo_list_deleted_lists':
      return clone(lists.filter((l) => l.deletedAt));
    case 'todo_list_deleted_items':
      return clone(deletedRoots());
    case 'todo_restore_list': {
      const list = lists.find((l) => l.id === args.listId && l.deletedAt) ?? notFound('TodoList', args.listId);
      const stamp = list.deletedAt;
      list.deletedAt = undefined;
      for (const i of items) if (i.todoListId === list.id && i.deletedAt === stamp) i.deletedAt = undefined;
      return clone(list);
    }
    case 'todo_purge_list':
      items = items.filter((i) => i.todoListId !== args.listId);
      lists = lists.filter((l) => l.id !== args.listId);
      return null;
    case 'todo_purge_deleted_lists': {
      const gone = lists.filter((l) => l.deletedAt).map((l) => l.id);
      items = items.filter((i) => !gone.includes(i.todoListId));
      lists = lists.filter((l) => !l.deletedAt);
      return gone.length;
    }
    case 'todo_restore_item':
      return clone(restoreItem(String(args.itemId)) ?? notFound('TodoItem', args.itemId));
    case 'todo_purge_item': {
      const root = items.find((i) => i.id === args.itemId);
      if (root) {
        const gone = new Set(descendants(root.id, items).filter((d) => d.deletedAt === root.deletedAt).map((d) => d.id));
        items = items.filter((i) => !gone.has(i.id));
      }
      return null;
    }
    case 'todo_purge_deleted_items': {
      const n = deletedRoots().length;
      items = items.filter((i) => !i.deletedAt);
      return n;
    }
    case 'todo_trash_counts':
      return { deletedItems: deletedRoots().length, deletedLists: lists.filter((l) => l.deletedAt).length };
    // —— 条目 ——
    case 'todo_create_item':
      return clone(createItem(input));
    case 'todo_get_item':
      return clone(items.find((i) => i.id === args.itemId && !i.deletedAt) ?? null);
    case 'todo_list_items':
      return clone(listItemsOf(String(args.listId), Boolean(args.includeCompleted)));
    case 'todo_list_items_with_stats':
      return clone(withStats(listItemsOf(String(args.listId), Boolean(args.includeCompleted))));
    case 'todo_update_item':
      return clone(updateItem(input));
    case 'todo_toggle_item': {
      const item = getItem(args.itemId);
      setStatus(item, item.status === 'completed' ? 'pending' : 'completed');
      return clone(item);
    }
    case 'todo_delete_item':
      if (!deleteItems([String(args.itemId)]).length) notFound('TodoItem', args.itemId);
      return null;
    case 'todo_reorder_items': {
      const ids = (input.itemIds ?? []) as string[];
      ids.forEach((id, idx) => {
        const i = items.find((x) => x.id === id);
        if (i) i.sortOrder = idx;
      });
      return null;
    }
    case 'todo_move_item':
      return clone(moveItem(String(input.itemId), String(input.targetListId)));
    // —— 视图查询 ——
    case 'todo_list_today':
      return clone(
        live()
          .filter((i) => i.dueDate && ((i.status === 'pending' && i.dueDate <= t) || (args.includeCompleted && i.status === 'completed' && i.dueDate === t)))
          .sort((a, b) => statusRank(a) - statusRank(b) || byDueThenPriority(a, b)),
      );
    case 'todo_list_overdue':
      return clone(
        live()
          .filter((i) => i.dueDate && i.dueDate < t && (i.status === 'pending' || (args.includeCompleted && i.status === 'completed')))
          .sort(byDueThenPriority),
      );
    case 'todo_list_upcoming': {
      const end = dayOffset(Number(args.days ?? 7));
      return clone(
        live()
          .filter((i) => i.dueDate && i.dueDate > t && i.dueDate <= end && (i.status === 'pending' || (args.includeCompleted && i.status === 'completed')))
          .sort(byDueThenPriority),
      );
    }
    case 'todo_list_all_pending':
      return clone(
        live()
          .filter((i) => i.status === 'pending')
          .sort((a, b) => Number(!a.dueDate) - Number(!b.dueDate) || cmpStr(a.dueDate, b.dueDate) || prio(a) - prio(b)),
      );
    case 'todo_list_reminders':
      return clone(live().filter((i) => i.reminder && i.status === 'pending').sort((a, b) => cmpStr(a.reminder, b.reminder)));
    case 'todo_list_completed':
      return clone(
        live()
          .filter((i) => i.status === 'completed' && (!args.listId || i.todoListId === args.listId))
          .sort((a, b) => cmpNullable(b.completedAt, a.completedAt)),
      );
    case 'todo_search': {
      const q = String(args.query ?? '').trim().toLowerCase();
      if (!q) return [];
      return clone(
        live()
          .filter((i) => i.title.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q))
          .sort((a, b) => cmpStr(b.updatedAt, a.updatedAt)),
      );
    }
    case 'todo_get_active_summary':
      return activeSummary();
    case 'todo_counts_snapshot':
      return countsSnapshot();
    case 'todo_stats_overview':
      return statsOverview(Number(args.days ?? 30));
    case 'todo_list_all_tags': {
      const counts = new Map<string, number>();
      for (const i of live()) for (const tag of new Set(parseTags(i.tagsJson))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    }
    case 'todo_ai_breakdown': {
      const item = getItem(args.itemId);
      const steps = DEMO_BREAKDOWNS[item.id];
      if (!steps) {
        throw new Error(tr('AI 拆解需要配置模型，请在桌面版中使用。', 'AI breakdown needs a configured model — available in the desktop app.'));
      }
      const existing = new Set(live().filter((k) => k.parentId === item.id).map((k) => k.title));
      return clone(steps.filter((s) => !existing.has(s)).map((title) => createItem({ todoListId: item.todoListId, parentId: item.id, title })));
    }
    // —— 批量 ——
    case 'todo_batch_complete':
      return batchItems(args.itemIds, (i) => {
        if (i.status !== 'completed') setStatus(i, 'completed');
        return true;
      });
    case 'todo_batch_reschedule':
      return batchItems(args.itemIds, (i) => {
        i.dueDate = optStr(args.dueDate);
        if (args.dueTime !== undefined && args.dueTime !== null) i.dueTime = optStr(args.dueTime);
        if (!i.dueDate) i.dueTime = undefined;
        i.updatedAt = nowIso();
        return true;
      });
    case 'todo_batch_set_priority':
      return batchItems(args.itemIds, (i) => {
        i.priority = args.priority as TodoPriority;
        i.updatedAt = nowIso();
        return true;
      });
    case 'todo_batch_move': {
      getList(args.targetListId);
      return batchItems(args.itemIds, (i) => {
        moveItem(i.id, String(args.targetListId));
        return true;
      });
    }
    case 'todo_batch_delete': {
      const ids = (Array.isArray(args.itemIds) ? args.itemIds : []) as string[];
      const affected = deleteItems(ids);
      return { affectedIds: affected, skippedIds: ids.filter((id) => !affected.includes(id)) };
    }
    case 'todo_batch_restore': {
      const out: TodoItem[] = [];
      const skipped: string[] = [];
      for (const id of (args.itemIds ?? []) as string[]) {
        const r = restoreItem(id);
        if (r) out.push(r);
        else skipped.push(id);
      }
      return { items: clone(out), skippedIds: skipped };
    }
    case 'todo_batch_purge': {
      const ids = (Array.isArray(args.itemIds) ? args.itemIds : []) as string[];
      const affected = ids.filter((id) => items.some((i) => i.id === id && i.deletedAt));
      for (const id of affected) handleTodo('todo_purge_item', { itemId: id });
      return { affectedIds: affected, skippedIds: ids.filter((id) => !affected.includes(id)) };
    }
    default:
      return undefined;
  }
}

function handlePomodoro(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'pomodoro_create_record': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const record: PomodoroRecord = {
        id: newId('pomo'),
        ...(optStr(input.todoItemId) ? { todoItemId: String(input.todoItemId) } : {}),
        startTime: String(input.startTime ?? nowIso()),
        ...(input.endTime ? { endTime: String(input.endTime) } : {}),
        duration: Number(input.duration ?? 0),
        actualDuration: Number(input.actualDuration ?? 0),
        type: (input.type as PomodoroRecord['type']) ?? 'work',
        status: (input.status as PomodoroRecord['status']) ?? 'completed',
        createdAt: nowIso(),
      };
      records.push(record);
      if (record.todoItemId && record.type === 'work' && record.status === 'completed') {
        const item = items.find((i) => i.id === record.todoItemId);
        if (item) item.completedPomodoros = (item.completedPomodoros ?? 0) + 1;
      }
      return clone(record);
    }
    case 'pomodoro_get_record':
      return clone(records.find((r) => r.id === args.recordId) ?? null);
    case 'pomodoro_delete_record':
      records = records.filter((r) => r.id !== args.recordId);
      return null;
    case 'pomodoro_list_by_todo':
      return clone(records.filter((r) => r.todoItemId === args.todoItemId).sort((a, b) => b.startTime.localeCompare(a.startTime)));
    case 'pomodoro_list_today':
      return clone(records.filter((r) => localDate(r.startTime) === today()));
    case 'pomodoro_list_range': {
      const from = String(args.startDate);
      const to = String(args.endDate);
      return clone(records.filter((r) => {
        const d = localDate(r.startTime);
        return d >= from && d <= to;
      }));
    }
    case 'pomodoro_today_stats':
      return todayStats();
    case 'pomodoro_daily_stats':
      return dailyStats(Number(args.days ?? 30));
    case 'pomodoro_stats_overview':
      return pomodoroOverview(Number(args.days ?? 30));
    case 'pomodoro_todo_focus_summary':
      return focusSummary(String(args.todoItemId));
    default:
      return undefined;
  }
}

// ============================================================================
// 定时任务
// ============================================================================

function automationSummary() {
  const enabled = automations.filter((a) => a.enabled);
  const next = enabled.map((a) => a.next_trigger_at as string | undefined).filter(Boolean).sort()[0];
  return {
    enabledCount: enabled.length,
    runningCount: 0,
    failedCount: 0,
    ...(next ? { nextRunAt: next } : {}),
    backgroundEnabled,
    onceCompletedCount: 0,
  };
}

function getAutomation(id: unknown): Record<string, unknown> {
  return automations.find((a) => a.id === id) ?? (() => { throw new Error(JSON.stringify({ code: 'NOT_FOUND', message: 'automation not found' })); })();
}

function applyAutomationRequest(target: Record<string, unknown>, req: Record<string, unknown>): void {
  const map: Record<string, string> = {
    name: 'name', prompt: 'prompt', actionType: 'action_type', agentPrompt: 'agent_prompt', sessionMode: 'session_mode',
    modelId: 'model_id', catchUpPolicy: 'catch_up_policy', maxRetries: 'max_retries', retryBackoffSeconds: 'retry_backoff_seconds',
    timeoutSeconds: 'timeout_seconds', enabled: 'enabled', trustedProfile: 'trusted_profile',
  };
  for (const [k, snake] of Object.entries(map)) if (req[k] !== undefined) target[snake] = req[k];
  if (req.schedule) {
    const s = req.schedule as Record<string, unknown>;
    target.schedule = { ...s, ...(s.intervalMinutes !== undefined ? { interval_minutes: s.intervalMinutes } : {}), ...(s.dayOfMonth !== undefined ? { day_of_month: s.dayOfMonth } : {}) };
    target.next_trigger_at = nextTrigger(target.schedule as Record<string, unknown>);
  }
}

function nextTrigger(s: Record<string, unknown>): string {
  const now = new Date();
  if (s.kind === 'interval') return new Date(now.getTime() + Number(s.interval_minutes ?? s.intervalMinutes ?? 60) * 60_000).toISOString();
  const [hh, mm] = String(s.time || '08:00').split(':').map(Number);
  const d = new Date(now);
  if (s.kind === 'once' && typeof s.date === 'string') return new Date(`${s.date}T${String(s.time || '08:00')}:00`).toISOString();
  d.setHours(hh || 0, mm || 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function handleAutomation(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'chat_v2_automation_list':
      return { count: automations.length, max: 20, automations: clone(automations) };
    case 'chat_v2_automation_summary':
      return automationSummary();
    case 'chat_v2_automation_runs': {
      const limit = Number(args.limit ?? 50);
      return { runs: clone(runs.filter((r) => !args.automationId || r.automation_id === args.automationId).slice(0, limit)) };
    }
    case 'chat_v2_automation_set_enabled': {
      const a = getAutomation(args.automationId);
      a.enabled = Boolean(args.enabled);
      a.version = Number(a.version) + 1;
      return { success: true, current: clone(a) };
    }
    case 'chat_v2_automation_create': {
      const req = (args.request ?? {}) as Record<string, unknown>;
      const a: Record<string, unknown> = { id: newId('auto'), version: 1, heartbeat: false, created_at: nowIso(), enabled: true };
      applyAutomationRequest(a, req);
      automations.push(a);
      return { success: true, automation: clone(a) };
    }
    case 'chat_v2_automation_update': {
      const req = (args.request ?? {}) as Record<string, unknown>;
      const a = getAutomation(req.automationId);
      applyAutomationRequest(a, req);
      a.version = Number(a.version) + 1;
      return { success: true, current: clone(a) };
    }
    case 'chat_v2_automation_delete':
      automations = automations.filter((a) => a.id !== args.automationId);
      runs = runs.filter((r) => r.automation_id !== args.automationId);
      return { success: true };
    case 'chat_v2_automation_run_now': {
      const a = getAutomation(args.automationId);
      if (a.action_type === 'agent_turn') {
        throw new Error(tr('Agent 任务要在桌面版里由模型执行，演示里只能查看历史运行。', 'Agent tasks run with a model in the desktop app; the demo only shows past runs.'));
      }
      const at = nowIso();
      runs.unshift({
        id: newId('run'), automation_id: a.id, status: 'success', trigger_type: 'manual', scheduled_for: at, fired_at: at,
        attempt: 1, max_attempts: 1, started_at: at, finished_at: at, duration_ms: 90, delivered: ['notification', 'todo'],
        summary: tr('已发送提醒，并生成待办。', 'Reminder sent and a to-do created.'),
      });
      a.last_run_at = at;
      createItem({ todoListId: INBOX_ID, title: String(a.name), priority: 'medium', dueDate: today() });
      return { success: true };
    }
    case 'chat_v2_automation_retry_run':
    case 'chat_v2_automation_cancel_run':
      return { success: true };
    case 'chat_v2_automation_set_background_enabled':
      backgroundEnabled = Boolean(args.enabled);
      return { success: true };
    default:
      return undefined;
  }
}

// ============================================================================
// 关联资料（dstu_get / dstu_search）
// ============================================================================

function dstuNode(n: (typeof DEMO_LINKED_NODES)[number]) {
  const at = Date.now() - 5 * 86_400_000;
  return { id: n.id, path: `/${n.id}`, name: n.name, type: n.type, sourceId: n.id, createdAt: at, updatedAt: at, previewType: n.type === 'textbook' ? 'pdf' : 'markdown' };
}

function handleDstu(cmd: string, args: DemoArgs): unknown {
  switch (cmd) {
    case 'dstu_get': {
      const id = String(args.path ?? '').replace(/^\//, '').split('/').pop();
      const n = DEMO_LINKED_NODES.find((x) => x.id === id);
      return n ? dstuNode(n) : null;
    }
    case 'dstu_search': {
      const q = String(args.query ?? '').trim();
      return DEMO_LINKED_NODES.filter((n) => !q || n.name.includes(q)).map(dstuNode);
    }
    default:
      return undefined;
  }
}

export function handleProductivity(cmd: string, args: DemoArgs): unknown {
  ensureSeeded();
  if (cmd.startsWith('todo_')) return handleTodo(cmd, args);
  if (cmd.startsWith('pomodoro_')) return handlePomodoro(cmd, args);
  if (cmd.startsWith('chat_v2_automation_')) return handleAutomation(cmd, args);
  if (cmd.startsWith('dstu_')) return handleDstu(cmd, args);
  return undefined;
}

/** 番茄钟 store 的持久化快照：今天已完成 3 个（与番茄记录一致） */
export function pomodoroStorageSeed(): string {
  return JSON.stringify({
    state: {
      mode: 'idle', status: 'paused', timeLeft: 25 * 60, phaseEndsAt: null, phaseStartedAt: null,
      currentTaskId: null, currentTaskTitle: null, sessionStartTime: null, sessionCountUp: null, phaseExtraSeconds: 0,
      settings: {
        workDuration: 1500, shortBreak: 300, longBreak: 900, longBreakInterval: 4, autoStartBreaks: false, autoStartWork: false,
        strictMode: false, countUp: false, endReminderSeconds: 0, noiseType: 'brown', noiseVolume: 0.12, noiseAutoWithFocus: false, dailyGoal: 8,
      },
      completedPomodorosToday: 3,
      lastActiveDate: new Date().toDateString(),
      streakDays: 4,
      lastGoalMetDate: new Date(Date.now() - 86_400_000).toDateString(),
    },
    version: 0,
  });
}
