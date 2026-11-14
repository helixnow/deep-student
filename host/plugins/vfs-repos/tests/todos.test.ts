import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import {
  computeNextDueDate, parseDate, parseRepeatRule, shiftReminder, stepDueDate,
  type LocalDate, type TodoRepeatRule,
} from '../repository/todos-helpers.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-todo-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.todos;

function createList(title: string) {
  return repo().createTodoList(db, { title });
}
function createItem(listId: string, title: string, dueDate: string | null = null, parentId: string | null = null) {
  return repo().createTodoItem(db, {
    todoListId: listId, title, description: null, priority: 'none', dueDate, dueTime: null,
    reminder: null, tags: null, parentId, attachments: null, repeatJson: null,
  });
}
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function yesterday(): string {
  const now = new Date(Date.now() - 86_400_000);
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function tomorrow(): string {
  const now = new Date(Date.now() + 86_400_000);
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function date(text: string): LocalDate {
  const parsed = parseDate(text);
  if (parsed === null) throw new Error(`invalid date ${text}`);
  return parsed;
}
function rule(freq: string, interval: number): TodoRepeatRule {
  return { freq, interval, byWeekday: null };
}
function weeklyRule(interval: number, byWeekday: number[]): TodoRepeatRule {
  return { freq: 'weekly', interval, byWeekday };
}

describe('todo_repo.rs', { timeout: 120_000 }, () => {
  it('test_create_todo_item_rejects_cross_list_parent', () => {
    const listA = createList('List A');
    const listB = createList('List B');
    const parent = createItem(listA.id, 'Parent');
    let message = '';
    try {
      repo().createTodoItem(db, {
        todoListId: listB.id, title: 'Child', description: null, priority: 'none', dueDate: null,
        dueTime: null, reminder: null, tags: null, parentId: parent.id, attachments: null, repeatJson: null,
      });
    } catch (error) { message = String(error); }
    expect(message).toContain('Parent item belongs to list');
  });

  it('test_update_todo_item_rejects_parent_cycle', () => {
    const list = createList('Cycle Test');
    const parent = createItem(list.id, 'Parent');
    const child = createItem(list.id, 'Child', null, parent.id);
    let message = '';
    try { repo().updateTodoItem(db, parent.id, { parentId: child.id }); }
    catch (error) { message = String(error); }
    expect(message).toContain('descendant');
  });

  it('test_list_today_items_include_completed_flag_controls_completed_visibility', () => {
    const list = createList('Today');
    const pending = createItem(list.id, 'Pending', today());
    const completed = createItem(list.id, 'Completed', today());
    repo().updateTodoItem(db, completed.id, { status: 'completed' });

    const pendingOnly = repo().listTodayItems(db, false);
    expect(pendingOnly).toHaveLength(1);
    expect(pendingOnly[0]!.id).toBe(pending.id);

    const withCompleted = repo().listTodayItems(db, true);
    expect(withCompleted).toHaveLength(2);
    expect(withCompleted.some(item => item.id === completed.id)).toBe(true);
  });

  it('test_list_today_items_includes_overdue_pending_excludes_overdue_completed', () => {
    const list = createList('Today');
    const dueToday = createItem(list.id, 'Due today', today());
    const overdue = createItem(list.id, 'Overdue', yesterday());
    const overdueDone = createItem(list.id, 'Overdue done', yesterday());
    createItem(list.id, 'No due', null);
    repo().updateTodoItem(db, overdueDone.id, { status: 'completed' });

    const items = repo().listTodayItems(db, false);
    const ids = items.map(item => item.id);
    expect(ids).toContain(dueToday.id);
    expect(ids).toContain(overdue.id);
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe(overdue.id);

    const withCompleted = repo().listTodayItems(db, true);
    expect(withCompleted.some(item => item.id === overdueDone.id)).toBe(false);
  });

  it('test_todo_insert_trigger_rejects_invalid_status', () => {
    const list = createList('Trigger');
    const now = new Date().toISOString();
    let message = '';
    try {
      db.run(`INSERT INTO todo_items (
        id, todo_list_id, title, status, priority, tags_json, attachments_json, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, '[]', '[]', ?6, ?7)`,
      ['ti_invalid_status', list.id, 'Broken', 'not-a-real-status', 'none', now, now]);
    } catch (error) { message = String(error); }
    expect(message).toContain('todo_items.status is invalid');
  });

  it('test_create_todo_item_rejects_invalid_priority', () => {
    const list = createList('Priority');
    let message = '';
    try {
      repo().createTodoItem(db, {
        todoListId: list.id, title: 'Broken', description: null, priority: 'impossible', dueDate: null,
        dueTime: null, reminder: null, tags: null, parentId: null, attachments: null, repeatJson: null,
      });
    } catch (error) { message = String(error); }
    expect(message).toContain('Unsupported todo priority');
  });

  it('test_update_todo_item_rejects_invalid_status', () => {
    const list = createList('Status');
    const item = createItem(list.id, 'Task');
    let message = '';
    try { repo().updateTodoItem(db, item.id, { status: 'done-ish' }); }
    catch (error) { message = String(error); }
    expect(message).toContain('Unsupported todo status');
  });

  it('test_parse_repeat_rule_validation', () => {
    expect(parseRepeatRule('{"freq":"daily"}')).not.toBeNull();
    expect(parseRepeatRule('{"freq":"weekly","interval":2}')).not.toBeNull();
    expect(parseRepeatRule('{"freq":"weekdays"}')).not.toBeNull();
    expect(parseRepeatRule('{"freq":"hourly"}')).toBeNull();
    expect(parseRepeatRule('{"freq":"daily","interval":0}')).toBeNull();
    expect(parseRepeatRule('{"freq":"daily","interval":1000}')).toBeNull();
    expect(parseRepeatRule('not json')).toBeNull();
  });

  it('test_parse_repeat_rule_by_weekday', () => {
    const parsed = parseRepeatRule('{"freq":"weekly","interval":1,"byWeekday":[5,1,3,1]}');
    expect(parsed?.byWeekday).toEqual([1, 3, 5]);
    expect(parseRepeatRule('{"freq":"weekly","byWeekday":[7]}')).toBeNull();
    expect(parseRepeatRule('{"freq":"weekly","byWeekday":[]}')?.byWeekday).toBeNull();
    expect(parseRepeatRule('{"freq":"daily","byWeekday":[1,3]}')?.byWeekday).toBeNull();
  });

  it('test_step_due_date_weekly_by_weekday', () => {
    expect(stepDueDate(date('2026-06-08'), weeklyRule(1, [1, 3, 5]))).toEqual(date('2026-06-10'));
    expect(stepDueDate(date('2026-06-10'), weeklyRule(1, [1, 3, 5]))).toEqual(date('2026-06-12'));
    expect(stepDueDate(date('2026-06-12'), weeklyRule(1, [1, 3, 5]))).toEqual(date('2026-06-15'));
    expect(stepDueDate(date('2026-06-11'), weeklyRule(1, [1, 3, 5]))).toEqual(date('2026-06-12'));
  });

  it('test_step_due_date_weekly_by_weekday_interval', () => {
    expect(stepDueDate(date('2026-06-08'), weeklyRule(2, [1, 5]))).toEqual(date('2026-06-12'));
    expect(stepDueDate(date('2026-06-12'), weeklyRule(2, [1, 5]))).toEqual(date('2026-06-22'));
  });

  it('test_step_due_date_monthly_clamps_to_month_end', () => {
    expect(stepDueDate(date('2026-01-31'), rule('monthly', 1))).toEqual(date('2026-02-28'));
    expect(stepDueDate(date('2028-02-29'), rule('yearly', 1))).toEqual(date('2029-02-28'));
  });

  it('test_shift_reminder_follows_due_date', () => {
    expect(shiftReminder('2026-06-12T08:30', date('2026-06-12'), date('2026-06-19'))).toBe('2026-06-19T08:30');
    expect(shiftReminder('2026-06-11T21:00:00', date('2026-06-12'), date('2026-06-13'))).toBe('2026-06-12T21:00');
    expect(shiftReminder('not-a-date', date('2026-06-12'), date('2026-06-13'))).toBeNull();
  });

  it('test_step_due_date_weekdays_skips_weekend', () => {
    expect(stepDueDate(date('2026-06-12'), rule('weekdays', 1))).toEqual(date('2026-06-15'));
    expect(stepDueDate(date('2026-06-15'), rule('weekdays', 1))).toEqual(date('2026-06-16'));
  });

  it('test_compute_next_due_date_skips_missed_cycles', () => {
    expect(computeNextDueDate(rule('weekly', 1), date('2026-06-01'), date('2026-06-12'))).toEqual(date('2026-06-15'));
    expect(computeNextDueDate(rule('daily', 1), date('2026-06-11'), date('2026-06-12'))).toEqual(date('2026-06-12'));
    expect(computeNextDueDate(rule('daily', 1), date('2026-06-20'), date('2026-06-12'))).toEqual(date('2026-06-21'));
  });

  it('test_complete_repeating_item_spawns_next_occurrence', () => {
    const list = createList('Repeat');
    const item = repo().createTodoItem(db, {
      todoListId: list.id, title: '每日复习', description: '背 20 个单词', priority: 'high',
      dueDate: today(), dueTime: '08:00', reminder: null, tags: null, parentId: null,
      attachments: null, repeatJson: '{"freq":"daily","interval":1}',
    });
    expect(item.repeatJson).toBe('{"freq":"daily","interval":1}');

    const completed = repo().toggleTodoItem(db, item.id);
    expect(completed.status).toBe('completed');

    let items = repo().listItemsByList(db, list.id, true);
    expect(items).toHaveLength(2);
    const spawned = items.find(entry => entry.status === 'pending');
    expect(spawned).toBeDefined();
    expect(spawned!.title).toBe('每日复习');
    expect(spawned!.dueDate).toBe(tomorrow());
    expect(spawned!.dueTime).toBe('08:00');
    expect(spawned!.priority).toBe('high');
    expect(spawned!.repeatJson).toBe('{"freq":"daily","interval":1}');

    repo().toggleTodoItem(db, item.id);
    repo().toggleTodoItem(db, item.id);
    items = repo().listItemsByList(db, list.id, true);
    expect(items).toHaveLength(2);
  });

  it('test_complete_without_due_date_or_rule_spawns_nothing', () => {
    const list = createList('NoRepeat');
    const noDue = repo().createTodoItem(db, {
      todoListId: list.id, title: '无日期', description: null, priority: 'none', dueDate: null,
      dueTime: null, reminder: null, tags: null, parentId: null, attachments: null,
      repeatJson: '{"freq":"daily"}',
    });
    repo().toggleTodoItem(db, noDue.id);

    const plain = createItem(list.id, '普通任务', '2026-01-01');
    repo().toggleTodoItem(db, plain.id);

    const items = repo().listItemsByList(db, list.id, true);
    expect(items).toHaveLength(2);
  });

  it('test_create_todo_item_rejects_invalid_repeat_json', () => {
    const list = createList('BadRepeat');
    let message = '';
    try {
      repo().createTodoItem(db, {
        todoListId: list.id, title: 'Broken', description: null, priority: 'none', dueDate: null,
        dueTime: null, reminder: null, tags: null, parentId: null, attachments: null,
        repeatJson: '{"freq":"hourly"}',
      });
    } catch (error) { message = String(error); }
    expect(message).toContain('Invalid repeat rule');
  });

  it('test_deleted_items_trash_roundtrip', () => {
    const list = createList('Trash');
    const parent = createItem(list.id, 'Parent');
    createItem(list.id, 'Child', null, parent.id);
    const solo = createItem(list.id, 'Solo');

    repo().deleteTodoItem(db, parent.id);
    repo().deleteTodoItem(db, solo.id);

    let trash = repo().listDeletedTodoItems(db, 100, 0);
    let titles = trash.map(item => item.title);
    expect(titles).toContain('Parent');
    expect(titles).toContain('Solo');
    expect(titles).not.toContain('Child');

    repo().restoreTodoItem(db, parent.id);
    const alive = repo().listItemsByList(db, list.id, true);
    const aliveTitles = alive.map(item => item.title);
    expect(aliveTitles).toContain('Parent');
    expect(aliveTitles).toContain('Child');

    repo().purgeTodoItem(db, solo.id);
    trash = repo().listDeletedTodoItems(db, 100, 0);
    expect(trash).toHaveLength(0);
    expect(() => repo().restoreTodoItem(db, solo.id)).toThrow();
    expect(() => repo().purgeTodoItem(db, parent.id)).toThrow();
  });

  it('test_purge_all_deleted_items_keeps_alive_ones', () => {
    const list = createList('PurgeAll');
    const keep = createItem(list.id, 'Keep');
    const goneA = createItem(list.id, 'GoneA');
    const goneB = createItem(list.id, 'GoneB');
    repo().deleteTodoItem(db, goneA.id);
    repo().deleteTodoItem(db, goneB.id);

    expect(repo().purgeDeletedTodoItems(db)).toBe(2);
    const alive = repo().listItemsByList(db, list.id, true);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.id).toBe(keep.id);
  });

  it('agent_list_update_and_delete_enforce_atomic_occ', () => {
    const list = createList('OCC');
    const [previous, updated] = repo().updateTodoListIfVersion(db, list.id, { title: 'OCC updated' }, list.updatedAt);
    expect(previous.title).toBe('OCC');
    expect(updated.title).toBe('OCC updated');
    expect(updated.updatedAt).not.toBe(list.updatedAt);

    let staleUpdate = '';
    try { repo().updateTodoListIfVersion(db, list.id, { title: 'stale' }, list.updatedAt); }
    catch (error) { staleUpdate = String(error); }
    expect(staleUpdate).toContain('TODO_CONFLICT');

    let staleDelete = '';
    try { repo().deleteTodoListIfVersion(db, list.id, list.updatedAt); }
    catch (error) { staleDelete = String(error); }
    expect(staleDelete).toContain('TODO_CONFLICT');
    expect(repo().getTodoList(db, list.id)).not.toBeNull();
  });

  it('agent_item_delete_enforces_occ_and_is_restorable', () => {
    const list = createList('Item OCC');
    const item = createItem(list.id, 'Task');
    const updated = repo().updateTodoItem(db, item.id, { title: 'Task updated', expectedUpdatedAt: item.updatedAt });

    let stale = '';
    try { repo().deleteTodoItemIfVersion(db, item.id, item.updatedAt); }
    catch (error) { stale = String(error); }
    expect(stale).toContain('TODO_CONFLICT');

    const previous = repo().deleteTodoItemIfVersion(db, item.id, updated.updatedAt);
    expect(previous.title).toBe('Task updated');
    expect(repo().getTodoItem(db, item.id)).toBeNull();
    const restored = repo().restoreTodoItem(db, item.id);
    expect(restored.id).toBe(item.id);
  });

  it('agent_cannot_delete_default_inbox', () => {
    const inbox = repo().ensureDefaultInbox(db);
    let message = '';
    try { repo().deleteTodoListIfVersion(db, inbox.id, inbox.updatedAt); }
    catch (error) { message = String(error); }
    expect(message).toContain('delete_default_todo_list');
  });

  it('agent_reorder_requires_exact_unique_list_membership', () => {
    const list = createList('Reorder');
    const first = createItem(list.id, 'First');
    const second = createItem(list.id, 'Second');
    const otherList = createList('Other');
    const outside = createItem(otherList.id, 'Outside');
    const revision = repo().getTodoList(db, list.id)!.updatedAt;

    for (const invalid of [
      [first.id, first.id],
      [first.id],
      [first.id, outside.id],
    ]) {
      let message = '';
      try { repo().reorderItems(db, list.id, invalid, revision); }
      catch (error) { message = String(error); }
      expect(message).toContain('item_ids');
      expect(repo().getTodoList(db, list.id)!.updatedAt).toBe(revision);
    }

    repo().reorderItems(db, list.id, [second.id, first.id], revision);
    const ordered = repo().listItemsByList(db, list.id, true);
    expect(ordered.map(item => item.id)).toEqual([second.id, first.id]);
  });

  it('reorder_lists_requires_exact_unique_membership_and_persists_order', () => {
    const a = createList('Alpha');
    const b = createList('Beta');
    const c = createList('Gamma');

    for (const invalid of [
      [a.id, a.id, b.id],
      [a.id, b.id],
      [a.id, b.id, 'tdl_missing'],
    ]) {
      let message = '';
      try { repo().reorderTodoLists(db, invalid); }
      catch (error) { message = String(error); }
      expect(message).toContain('list_ids');
    }

    repo().reorderTodoLists(db, [c.id, a.id, b.id]);
    const ordered = repo().listTodoLists(db);
    expect(ordered.map(list => list.id)).toEqual([c.id, a.id, b.id]);
    expect(ordered.map(list => list.sortOrder)).toEqual([0, 1, 2]);
    expect(ordered[0]!.updatedAt).not.toBe(c.updatedAt);
  });

  it('move_todo_item_moves_subtree_to_target_list_tail', () => {
    const source = createList('Source');
    const target = createList('Target');
    const existing = createItem(target.id, 'Existing');
    const parent = createItem(source.id, 'Parent');
    const child = createItem(source.id, 'Child', null, parent.id);
    const grandchild = createItem(source.id, 'Grandchild', null, child.id);

    const moved = repo().moveTodoItem(db, parent.id, target.id);
    expect(moved.todoListId).toBe(target.id);
    expect(moved.parentId).toBeUndefined();
    expect(moved.sortOrder).toBe(existing.sortOrder + 1);

    const movedChild = repo().getTodoItem(db, child.id)!;
    expect(movedChild.todoListId).toBe(target.id);
    expect(movedChild.parentId).toBe(parent.id);
    const movedGrandchild = repo().getTodoItem(db, grandchild.id)!;
    expect(movedGrandchild.todoListId).toBe(target.id);
    expect(movedGrandchild.parentId).toBe(child.id);

    expect(repo().listItemsByList(db, source.id, true)).toHaveLength(0);
  });

  it('move_todo_item_rejects_missing_or_deleted_target_list', () => {
    const source = createList('Source');
    const doomed = createList('Doomed');
    const item = createItem(source.id, 'Task');

    expect(() => repo().moveTodoItem(db, item.id, 'tdl_missing')).toThrow();

    repo().deleteTodoList(db, doomed.id);
    let message = '';
    try { repo().moveTodoItem(db, item.id, doomed.id); }
    catch (error) { message = String(error); }
    expect(message).toContain('TodoList');

    const untouched = repo().getTodoItem(db, item.id)!;
    expect(untouched.todoListId).toBe(source.id);
  });
});
