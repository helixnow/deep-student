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
import type { CreatePomodoroRecordParams, TodoItem } from '../api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-pomodoro-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const pomodoros = () => host.ctx.vfsRepo.pomodoros;
const todos = () => host.ctx.vfsRepo.todos;

function localDateString(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createItem(): TodoItem {
  const list = todos().createTodoList(db, { title: 'pomodoro test list' });
  return todos().createTodoItem(db, { todoListId: list.id, title: 'pomodoro test item' });
}

function recordParams(todoItemId: string | null, type: string, status: string): CreatePomodoroRecordParams {
  return {
    todoItemId,
    startTime: '2026-07-19T01:00:00.000Z',
    endTime: '2026-07-19T01:25:00.000Z',
    duration: 1500,
    actualDuration: 1500,
    type,
    status,
  };
}

function completedPomodoros(itemId: string): number {
  return Number(db.pluck<number>(
    'SELECT COALESCE(completed_pomodoros, 0) FROM todo_items WHERE id = ?1', [itemId]) ?? 0);
}

describe('pomodoro_repo.rs', { timeout: 120_000 }, () => {
  it('focus_seconds_by_local_date_sums_work_focus_only', () => {
    pomodoros().createRecord(db, recordParams(null, 'work', 'completed'));
    const interrupted = recordParams(null, 'work', 'interrupted');
    interrupted.actualDuration = 600;
    pomodoros().createRecord(db, interrupted);
    pomodoros().createRecord(db, recordParams(null, 'short_break', 'completed'));

    const today = localDateString();
    const byDate = pomodoros().focusSecondsByLocalDate(db, today, localDateString(1));
    expect(byDate[today]).toBe(2100);

    const yesterdayOnly = pomodoros().focusSecondsByLocalDate(
      db, localDateString(-1), today);
    expect(Object.keys(yesterdayOnly)).toHaveLength(0);
  });

  it('create_record_writes_updated_at_equal_to_created_at', () => {
    const record = pomodoros().createRecord(db, recordParams(null, 'work', 'completed'));
    expect(record.updatedAt).toBe(record.createdAt);
    expect(record.createdAt.endsWith('Z')).toBe(true);

    const row = db.get<{ updated_at: string | null; deleted_at: string | null }>(
      'SELECT updated_at, deleted_at FROM pomodoro_records WHERE id = ?1', [record.id])!;
    expect(row.updated_at).toBe(record.createdAt);
    expect(row.deleted_at).toBeNull();
  });

  it('delete_record_soft_deletes_and_rolls_back_completed_pomodoros', () => {
    const item = createItem();
    const record = pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    expect(completedPomodoros(item.id)).toBe(1);

    pomodoros().deleteRecord(db, record.id);

    expect(pomodoros().getRecord(db, record.id)).toBeNull();
    expect(pomodoros().listByTodoItem(db, item.id)).toHaveLength(0);
    expect(pomodoros().listTodayRecords(db)).toHaveLength(0);
    expect(pomodoros().getTodayStats(db).completedCount).toBe(0);

    const row = db.get<{ deleted_at: string | null; local_version: number }>(
      'SELECT deleted_at, COALESCE(local_version, 0) AS local_version FROM pomodoro_records WHERE id = ?1',
      [record.id])!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.local_version).toBeGreaterThanOrEqual(1);
    expect(completedPomodoros(item.id)).toBe(0);

    expect(() => pomodoros().deleteRecord(db, record.id)).toThrow(/PomodoroRecord not found/);
  });

  it('delete_record_does_not_touch_counter_for_break_or_interrupted', () => {
    const item = createItem();
    const interrupted = pomodoros().createRecord(db, recordParams(item.id, 'work', 'interrupted'));
    const shortBreak = pomodoros().createRecord(db, recordParams(item.id, 'short_break', 'completed'));
    expect(completedPomodoros(item.id)).toBe(0);

    pomodoros().deleteRecord(db, interrupted.id);
    pomodoros().deleteRecord(db, shortBreak.id);
    expect(completedPomodoros(item.id)).toBe(0);
  });

  it('delete_record_counter_never_goes_negative', () => {
    const item = createItem();
    const record = pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    db.run('UPDATE todo_items SET completed_pomodoros = 0 WHERE id = ?1', [item.id]);

    pomodoros().deleteRecord(db, record.id);
    expect(completedPomodoros(item.id)).toBe(0);
  });

  it('td02_create_and_delete_recount_tracks_fact_table', () => {
    const item = createItem();
    const r1 = pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    const r2 = pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    expect(completedPomodoros(item.id)).toBe(2);

    pomodoros().deleteRecord(db, r1.id);
    expect(completedPomodoros(item.id)).toBe(1);
    pomodoros().deleteRecord(db, r2.id);
    expect(completedPomodoros(item.id)).toBe(0);
  });

  it('td02_create_record_recount_heals_drifted_cache', () => {
    const item = createItem();
    pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    expect(completedPomodoros(item.id)).toBe(1);

    db.run('UPDATE todo_items SET completed_pomodoros = 99 WHERE id = ?1', [item.id]);

    pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    expect(completedPomodoros(item.id)).toBe(2);
  });

  it('td02_recount_is_idempotent_and_skips_noop_writes', () => {
    const item = createItem();
    pomodoros().createRecord(db, recordParams(item.id, 'work', 'completed'));
    const versionBefore = Number(db.pluck<number>(
      'SELECT COALESCE(local_version, 0) FROM todo_items WHERE id = ?1', [item.id]) ?? 0);

    pomodoros().recountCompletedPomodorosCache(db, item.id, '2026-07-19T09:00:00.000Z');
    pomodoros().recountCompletedPomodorosCache(db, item.id, '2026-07-19T09:00:01.000Z');

    const row = db.get<{ count: number; version: number }>(
      `SELECT COALESCE(completed_pomodoros, -1) AS count, COALESCE(local_version, 0) AS version
       FROM todo_items WHERE id = ?1`, [item.id])!;
    expect(row.count).toBe(1);
    expect(row.version).toBe(versionBefore);
  });

  it('list_range_filters_by_local_day_and_excludes_deleted', () => {
    const kept = pomodoros().createRecord(db, recordParams(null, 'work', 'completed'));
    const deleted = pomodoros().createRecord(db, recordParams(null, 'work', 'completed'));
    pomodoros().deleteRecord(db, deleted.id);

    const records = pomodoros().listRange(db, localDateString(-1), localDateString());
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe(kept.id);

    expect(pomodoros().listRange(db, '2000-01-01', '2000-01-02')).toHaveLength(0);
  });

  it('list_range_rejects_bad_input', () => {
    expect(() => pomodoros().listRange(db, '2026/07/19', '2026-07-19'))
      .toThrow(/Invalid argument 'start_date'/);
    expect(() => pomodoros().listRange(db, '2026-07-20', '2026-07-19'))
      .toThrow(/Invalid argument 'start_date'/);
  });
});
