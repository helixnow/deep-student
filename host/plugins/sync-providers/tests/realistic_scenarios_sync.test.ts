/**
 * [L20-engine port] `sync_realistic_scenarios.rs` S.01-S.15.
 *
 * The Rust file's inline harness reimplements apply (INSERT OR REPLACE /
 * soft-delete SQL) instead of calling `SyncManager`. To keep the lane rule
 * "tests must go through the production entry", this port replaces only that
 * harness step: both devices are real F3 `StorageService` instances with the
 * production migrations applied, and changes move via
 * `getPendingChanges` -> `enrichChangesWithData` -> `applyDownloadedChanges`.
 *
 * Scenario setup, timestamps and final-state assertions are unchanged.
 * S.16+ (chat/mistakes/hierarchy/field-merge) stay pending; the field-merge
 * group additionally needs the unpublished `field_merge` module.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import review from '../../review/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';
import { VFS_TABLES, clearBusinessTables } from './realistic_sync_harness.ts';

const DEVICE_A = 'device_a_001';
const DEVICE_B = 'device_b_001';
let root: string;
let storageA: StorageService;
let storageB: StorageService;
let host: TestHost;

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

function vfsA(): DatabaseHandle { return storageA.database('vfs'); }
function vfsB(): DatabaseHandle { return storageB.database('vfs'); }

function nowIso(): string { return new Date().toISOString(); }
function nowMs(): number { return Date.now(); }

function resource(db: DatabaseHandle, id: string, type: string, data: string, hash: string): void {
  db.run(
    `INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode)
     VALUES (?1,?2,?3,?4,1,?5,?5,'inline')`,
    [id, hash, type, data, nowMs()],
  );
}

function note(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
     VALUES (?1,?2,?3,'[]',0,?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function examSheet(db: DatabaseHandle, id: string, examName: string, resourceId: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json,
       preview_json, created_at, updated_at, is_favorite)
     VALUES (?1,?2,?3,'completed',?4,'{}','{}',?5,?5,0)`,
    [id, resourceId, examName, `tmp_${id}`, ts],
  );
}

function question(db: DatabaseHandle, id: string, examId: string, content: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO questions (id, exam_id, content, question_type, tags, status, created_at, updated_at)
     VALUES (?1,?2,?3,'choice','[]','new',?4,?4)`,
    [id, examId, content, ts],
  );
}

function reviewPlan(db: DatabaseHandle, id: string, questionId: string, examId: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO review_plans (id, question_id, exam_id, next_review_date, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,'new',?5,?5)`,
    [id, questionId, examId, ts, ts],
  );
}

function folder(db: DatabaseHandle, id: string, parentId: string | null, title: string): void {
  const ts = nowMs();
  db.run(
    `INSERT INTO folders (id, parent_id, title, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,0,?4,?4)`,
    [id, parentId, title, ts],
  );
}

function folderItem(
  db: DatabaseHandle, id: string, folderId: string, itemType: string, itemId: string,
): void {
  const ts = nowMs();
  db.run(
    `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,?4,0,?5,?5)`,
    [id, folderId, itemType, itemId, ts],
  );
}

function todoList(db: DatabaseHandle, id: string, title: string): void {
  // The F3 production schema for todo_lists has no resource_id column
  // (unlike the Rust V20260308 fixture); the scenario only asserts the
  // todo item, so the resource link is omitted here.
  const ts = nowIso();
  db.run(
    `INSERT INTO todo_lists (id, title, sort_order, created_at, updated_at)
     VALUES (?1,?2,0,?3,?3)`,
    [id, title, ts],
  );
}

function todoItem(
  db: DatabaseHandle, id: string, todoListId: string, title: string, parentId: string | null,
): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO todo_items (id, todo_list_id, title, parent_id, status, priority,
       tags_json, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,?4,'pending','none','[]',0,?5,?5)`,
    [id, todoListId, title, parentId, ts],
  );
}

function pomodoroRecord(db: DatabaseHandle, id: string, todoItemId: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO pomodoro_records (id, todo_item_id, start_time, duration, actual_duration,
       type, status, created_at)
     VALUES (?1,?2,?3,1500,1500,'work','completed',?3)`,
    [id, todoItemId, ts],
  );
}

function essay(
  db: DatabaseHandle, id: string, resourceId: string, title: string, score: number | null,
): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO essays (id, resource_id, title, score, round_number, created_at, updated_at)
     VALUES (?1,?2,?3,?4,1,?5,?5)`,
    [id, resourceId, title, score, ts],
  );
}

function translation(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO translations (id, resource_id, src_lang, tgt_lang, title, created_at, updated_at)
     VALUES (?1,?2,'en','zh',?3,?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function mindmap(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = nowIso();
  db.run(
    `INSERT INTO mindmaps (id, resource_id, title, settings, created_at, updated_at)
     VALUES (?1,?2,?3,'{}',?4,?4)`,
    [id, resourceId, title, ts],
  );
}

/**
 * Rust `full_sync_cycle` for one database: take the source's pending rows,
 * apply them to the target through the published engine, then mark the source
 * entries synced. The engine suppresses change-log echoes, so the reverse
 * direction has nothing to do unless the target wrote locally.
 */
function fullSyncCycle(from: DatabaseHandle, to: DatabaseHandle, deviceId: string): number {
  const pending = host.ctx.sync.getPendingChanges(from, null, null);
  if (pending.total_count === 0) return 0;
  const changes = host.ctx.sync.enrichChangesWithData(from, pending.entries, null);
  for (const change of changes) {
    change.database_name = 'vfs';
    change.suppress_change_log = true;
  }
  const applied = host.ctx.sync.applyDownloadedChanges(to, changes, { deviceId });
  const ids = pending.entries.map(entry => entry.id);
  host.ctx.sync.markSyncedWithTimestamp(from, ids);
  return applied.success_count;
}

function column(db: DatabaseHandle, table: string, id: string, columnName: string): string | null {
  return db.pluck<string | null>(
    `SELECT "${columnName}" FROM "${table}" WHERE id=?1`, [id],
  ) ?? null;
}

function rowCount(db: DatabaseHandle, table: string): number {
  return Number(db.pluck<number>(`SELECT COUNT(*) FROM "${table}"`) ?? 0);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'l23-realistic-sync-'));
  storageA = createStorageService({ baseDir: join(root, 'a'), dataLocalDir: join(root, 'a') });
  storageB = createStorageService({ baseDir: join(root, 'b'), dataLocalDir: join(root, 'b') });
  await storageA.migrations.runAll();
  await storageB.migrations.runAll();

  host = await createTestHost();
  host.ctx.provide('storage', storageA);
  host.ctx.provide('paths', {
    deviceId: async () => DEVICE_A,
    dataSpaceDeviceId: async () => DEVICE_A,
  });
  host.ctx.provide('secrets', { backup: createBackupCrypto() });
  host.ctx.provide('nativeCompression', compression);
  host.ctx.provide('backup', unused('backup'));
  host.ctx.provide('syncProvider', unused('syncProvider'));
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  await host.install(vfsRepos);
  await host.install(notes);
  await host.install(syncSupport);
  await host.install(review);
  await host.install(sync);
}, 180_000);

beforeEach(() => {
  for (const db of [vfsA(), vfsB()]) clearBusinessTables(db, VFS_TABLES);
});

afterAll(async () => {
  await host?.dispose();
  (storageA as StorageService & { dispose(): void } | undefined)?.dispose();
  (storageB as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('sync realistic scenarios S.01-S.06: notes and resources', () => {
  it('s01_single_device_creates_note_syncs_other_receives', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_001', 'note', 'Hello', 'hash_001');
    note(a, 'note_001', 'res_001', 'My First Note');
    const applied = fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'notes', 'note_001', 'title')).toBe('My First Note');
    expect(applied).toBeGreaterThan(0);
  });

  it('s02_update_note_title_sync_propagates', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_002', 'note', 'base', 'hash_002');
    note(a, 'note_002', 'res_002', 'Original');
    fullSyncCycle(a, b, DEVICE_B);
    a.run(
      "UPDATE notes SET title = 'Updated', updated_at = ?1 WHERE id = 'note_002'",
      [nowIso()],
    );
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'notes', 'note_002', 'title')).toBe('Updated');
  });

  it('s03_delete_note_tombstone_sync_propagates', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_003', 'note', 'del', 'hash_003');
    note(a, 'note_003', 'res_003', 'Delete Me');
    fullSyncCycle(a, b, DEVICE_B);
    const ts = nowIso();
    a.run(
      'UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2',
      [ts, 'note_003'],
    );
    fullSyncCycle(a, b, DEVICE_B);
    const deleted = column(b, 'notes', 'note_003', 'deleted_at');
    expect(deleted).not.toBeNull();
    expect(deleted).not.toBe('');
  });

  it('s04_create_50_notes_bulk_sync', () => {
    const a = vfsA();
    const b = vfsB();
    for (let i = 0; i < 50; i += 1) {
      const suffix = String(i).padStart(3, '0');
      resource(a, `res_${suffix}`, 'note', 'data', `h_${suffix}`);
      note(a, `note_${suffix}`, `res_${suffix}`, `Note ${i}`);
    }
    fullSyncCycle(a, b, DEVICE_B);
    expect(rowCount(b, 'notes')).toBe(50);
  }, 60_000);

  it('s05_create_resource_then_note_fk_order', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_005', 'note', 'FK test', 'hash_005');
    note(a, 'note_005', 'res_005', 'FK Note');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'notes', 'note_005', 'resource_id')).toBe('res_005');
  });

  it('s06_update_resource_data_verify_note_sees_new_data', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_006', 'note', 'old', 'hash_006');
    note(a, 'note_006', 'res_006', 'Note');
    fullSyncCycle(a, b, DEVICE_B);
    // The Rust harness has no LWW step; the production engine compares row
    // timestamps, so the local edit must bump updated_at like the real app.
    a.run("UPDATE resources SET data = 'new', updated_at = ?1 WHERE id = 'res_006'", [nowMs()]);
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'resources', 'res_006', 'data')).toBe('new');
  });
});

describe('sync realistic scenarios S.07-S.10: exam, folder and todo hierarchies', () => {
  it('s07_create_question_linked_to_exam_sync_both', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_007', 'exam', 'ed', 'hash_007');
    examSheet(a, 'exam_007', 'Math', 'res_007');
    question(a, 'q_007', 'exam_007', '2+2?');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'questions', 'q_007', 'content')).toBe('2+2?');
  });

  it('s08_create_review_plan_for_question_sync', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_008', 'exam', 'd', 'hash_008');
    examSheet(a, 'exam_008', 'Phys', 'res_008');
    question(a, 'q_008', 'exam_008', 'F=ma');
    reviewPlan(a, 'rp_008', 'q_008', 'exam_008');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'review_plans', 'rp_008', 'question_id')).toBe('q_008');
  });

  it('s09_create_folder_add_items_sync_tree', () => {
    const a = vfsA();
    const b = vfsB();
    folder(a, 'fld_009', null, 'Root');
    resource(a, 'res_009', 'note', 'x', 'hash_009');
    note(a, 'note_009', 'res_009', 'Nested');
    folderItem(a, 'fi_009', 'fld_009', 'note', 'note_009');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'folder_items', 'fi_009', 'item_type')).toBe('note');
  });

  it('s10_create_todo_list_with_items_sync_hierarchy', () => {
    const a = vfsA();
    const b = vfsB();
    todoList(a, 'tdl_010', 'My Todo');
    todoItem(a, 'ti_010', 'tdl_010', 'Task 1', null);
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'todo_items', 'ti_010', 'title')).toBe('Task 1');
  });

  it('s11_create_pomodoro_record_linked_to_todo_item_sync', () => {
    const a = vfsA();
    const b = vfsB();
    todoList(a, 'tdl_011', 'Work');
    todoItem(a, 'ti_011', 'tdl_011', 'Focus', null);
    pomodoroRecord(a, 'pd_011', 'ti_011');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'pomodoro_records', 'pd_011', 'todo_item_id')).toBe('ti_011');
  });

  it('s12_create_essay_sync_with_grading', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_012', 'essay', 'essay', 'hash_012');
    essay(a, 'essay_012', 'res_012', 'Great Essay', 85);
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'essays', 'essay_012', 'title')).toBe('Great Essay');
  });

  it('s13_create_translation_sync_with_metadata', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_013', 'translation', 'hi', 'hash_013');
    translation(a, 'tr_013', 'res_013', 'EN-ZH');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'translations', 'tr_013', 'title')).toBe('EN-ZH');
  });

  it('s14_create_mindmap_sync_with_settings', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_014', 'note', 'mm', 'hash_014');
    mindmap(a, 'mm_014', 'res_014', 'KM');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'mindmaps', 'mm_014', 'title')).toBe('KM');
  });

  it('s15_create_exam_sheet_sync_with_preview', () => {
    const a = vfsA();
    const b = vfsB();
    resource(a, 'res_015', 'exam', 'ed', 'hash_015');
    examSheet(a, 'exam_015', 'Chem', 'res_015');
    fullSyncCycle(a, b, DEVICE_B);
    expect(column(b, 'exam_sheets', 'exam_015', 'exam_name')).toBe('Chem');
  });
});
