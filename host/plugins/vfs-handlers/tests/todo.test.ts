import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBreakdownTitles } from '../src/todo.ts';
import { createVfsHost, type VfsHost } from './harness.ts';

let vfs: VfsHost;
beforeEach(async () => { vfs = await createVfsHost(); }, 120_000);
afterEach(async () => { await vfs?.dispose(); }, 120_000);

const invoke = <T = unknown>(name: string, args: Record<string, unknown> = {}) => vfs.host.invoke(name, args) as Promise<T>;

describe('vfs/todo_handlers.rs command layer', { timeout: 120_000 }, () => {
  it('todo and pomodoro CRUD observe their writes before resolving', async () => {
    // Supplemental CRUD coverage only. Rust's thread-isolation test is pending (R13-02).
    const list = await invoke<{ id: string; title: string }>('todo_create_list', { input: { title: 'Inbox' } });
    expect(list.title).toBe('Inbox');
    expect(await invoke('todo_get_list', { listId: list.id })).toMatchObject({ id: list.id, title: 'Inbox' });

    const record = await invoke<{ id: string; duration: number }>('pomodoro_create_record', {
      input: { startTime: '2026-01-01T00:00:00Z', duration: 25, actualDuration: 25 },
    });
    expect(record.duration).toBe(25);
    expect(await invoke('pomodoro_get_record', { recordId: record.id })).toMatchObject({ id: record.id });
  });

  it('todo and pomodoro commands preserve their distinct business error shapes', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const todoError = await invoke<Record<string, unknown>>('todo_create_item', {
      input: { todoListId: list.id, title: '   ' },
    }).catch((error: unknown) => error as Record<string, unknown>);
    expect(todoError).toMatchObject({
      code: 'VFS_INVALID_ARGUMENT',
      message: "Invalid argument 'title': Todo item title cannot be empty",
      data: { param: 'title' },
    });
    expect(typeof todoError.traceId).toBe('string');

    const pomodoroError = await invoke('pomodoro_delete_record', { recordId: 'pd_missing' }).catch(error => error);
    expect(pomodoroError).toBe('PomodoroRecord not found: pd_missing');
  });

  it('parses_plain_string_array', () => {
    expect(parseBreakdownTitles('["查资料","写提纲","完成初稿"]')).toEqual(['查资料', '写提纲', '完成初稿']);
  });

  it('parses_fenced_and_object_array', () => {
    const raw = '```json\n[{"title":"step one"},{"title":"step two"}]\n```';
    expect(parseBreakdownTitles(raw)).toEqual(['step one', 'step two']);
  });

  it('extracts_array_from_surrounding_text', () => {
    const raw = '好的，拆解如下：["a","b"] 希望有帮助';
    expect(parseBreakdownTitles(raw)).toEqual(['a', 'b']);
  });

  it('rejects_garbage_and_filters_empty', () => {
    expect(parseBreakdownTitles('无法拆解')).toEqual([]);
    expect(parseBreakdownTitles('["", "ok"]')).toEqual(['ok']);
  });

  it('todo CRUD emits todo://changed with source user', async () => {
    vfs.host.events.length = 0;
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'Work' } });
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([
      { source: 'user', action: 'create_list', entityIds: [list.id] },
    ]);
    vfs.host.events.length = 0;
    const item = await invoke<{ id: string; status: string; todoListId: string }>('todo_create_item', {
      input: { todoListId: list.id, title: 'Task' },
    });
    expect(item.status).toBe('pending');
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([
      { source: 'user', action: 'create', entityIds: [item.id] },
    ]);
    vfs.host.events.length = 0;
    const toggled = await invoke<{ status: string }>('todo_toggle_item', { itemId: item.id, expectedUpdatedAt: null });
    expect(toggled.status).toBe('completed');
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([
      { source: 'user', action: 'toggle', entityIds: [item.id] },
    ]);
  });

  it('todo_update_item rejects derived completedPomodoros like Rust', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const item = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: 'T' } });
    const error = await invoke('todo_update_item', {
      input: { id: item.id, completedPomodoros: 2 },
    }).catch(problem => problem);
    expect(error).toMatchObject({
      code: 'VFS_INVALID_ARGUMENT',
      message: 'completedPomodoros is derived from pomodoro records and cannot be updated directly',
    });
  });

  it('todo batch operations skip unknown ids and report affected ids', async () => {
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const first = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: 'A' } });
    const result = await invoke<{ items: Array<{ id: string }>; skippedIds: string[] }>('todo_batch_complete', {
      itemIds: [first.id, 'ti_missing'],
    });
    expect(result.items.map(item => item.id)).toEqual([first.id]);
    expect(result.skippedIds).toEqual(['ti_missing']);
    const trash = await invoke<{ affectedIds: string[]; skippedIds: string[] }>('todo_batch_delete', {
      itemIds: [first.id, 'ti_missing'],
    });
    expect(trash.affectedIds).toEqual([first.id]);
    expect(trash.skippedIds).toEqual(['ti_missing']);
  });

  it('todo stats and snapshots aggregate the current rows', async () => {
    const list = await invoke<{ id: string }>('todo_ensure_inbox', { title: '收件箱' });
    expect(list).toMatchObject({ title: '收件箱', isDefault: true });
    await invoke('todo_create_item', { input: { todoListId: list.id, title: 'A', priority: 'high', tags: ['x'] } });
    await invoke('todo_create_item', { input: { todoListId: list.id, title: 'B', tags: ['x', 'y'] } });
    const snapshot = await invoke<{ inboxCount: number; allPendingCount: number }>('todo_counts_snapshot');
    expect(snapshot.inboxCount).toBe(2);
    expect(snapshot.allPendingCount).toBe(2);
    expect(await invoke('todo_list_all_tags')).toEqual([{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }]);
    expect(await invoke('todo_trash_counts')).toEqual({ deletedItems: 0, deletedLists: 0 });
    const overview = await invoke<{ totalPending: number; byPriority: Array<{ priority: string; pendingCount: number }> }>(
      'todo_stats_overview', { days: 7 },
    );
    expect(overview.totalPending).toBe(2);
    expect(overview.byPriority).toContainEqual({ priority: 'high', pendingCount: 1 });
  });

  it('todo_ai_breakdown persists all subtasks in one savepoint', async () => {
    const seen: Array<{ prompt: string; caller: unknown }> = [];
    const llm = {
      callModel2RawPrompt: async (prompt: string, images: null, caller: unknown) => {
        seen.push({ prompt, caller });
        expect(images).toBeNull();
        return { assistant_message: '[{"title":"收集素材"},{"title":"写提纲"}]' };
      },
    };
    await vfs.dispose();
    vfs = await createVfsHost({ llm });
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const parent = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: 'Prepare deck' } });
    const children = await invoke<Array<{ id: string; title: string; parentId: string }>>(
      'todo_ai_breakdown', { itemId: parent.id },
    );
    expect(children.map(child => child.title)).toEqual(['收集素材', '写提纲']);
    expect(children.every(child => child.parentId === parent.id)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.caller).toEqual({ Other: 'todo_breakdown' });
    expect(seen[0]!.prompt).toContain('任务标题：Prepare deck');
    expect(await invoke('todo_list_items', { listId: list.id, includeCompleted: false })).toHaveLength(3);
  });

  it('todo_ai_breakdown rolls back owner writes and emits nothing when the second subtask fails', async () => {
    await vfs.dispose();
    vfs = await createVfsHost({ llm: { callModel2RawPrompt: async () => ({ assistant_message: '["first","second"]' }) } });
    const list = await invoke<{ id: string }>('todo_create_list', { input: { title: 'L' } });
    const parent = await invoke<{ id: string }>('todo_create_item', { input: { todoListId: list.id, title: 'Parent' } });
    const db = vfs.storage.database('vfs');
    db.exec(`CREATE TRIGGER reject_second_subtask BEFORE INSERT ON todo_items
      WHEN NEW.title = 'second' BEGIN SELECT RAISE(ABORT, 'second subtask rejected'); END;`);
    vfs.host.events.length = 0;
    await expect(invoke('todo_ai_breakdown', { itemId: parent.id })).rejects.toMatchObject({
      code: 'VFS_STORAGE', message: 'Database error: second subtask rejected',
    });
    expect(await invoke('todo_list_items', { listId: list.id, includeCompleted: false }))
      .toEqual([expect.objectContaining({ id: parent.id })]);
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([]);
    db.exec('DROP TRIGGER reject_second_subtask');
    const children = await invoke<Array<{ id: string }>>('todo_ai_breakdown', { itemId: parent.id });
    expect(children).toHaveLength(2);
    expect(vfs.host.eventsNamed('todo://changed')).toEqual([{ source: 'user', action: 'create', entityIds: children.map(child => child.id) }]);
  });
});
