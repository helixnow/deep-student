import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// boundary-allow cross-plugin-impl: L22 集成测试用 L20 生产 get_pending_changes 验证迁移写入可被上传路径看到
import { getPendingChanges } from '../../sync/repository/change-log.ts';
import { openTestDatabase, type TestDatabase } from './sync-fixture.ts';

/**
 * `sync_r13_migration_change_log_propagation.rs` 的 TS 行为级移植。
 *
 * 用真实迁移 SQL 文件建库/回放，验证迁移里的数据规范化 UPDATE 是否经
 * `trg__change_log_*` 触发器进入 pending change_log，并被上传路径看到。
 */
const suite = it;
const read = (path: string): string => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

function pendingRowsForTable(db: TestDatabase, table: string): Array<{ record_id: string; operation: string }> {
  return db.all<{ record_id: string; operation: string }>(
    `SELECT record_id, operation FROM __change_log
     WHERE sync_version = 0 AND table_name = ?1 ORDER BY id`,
    [table],
  );
}

function markAllChangeLogSynced(db: TestDatabase): void {
  db.run("UPDATE __change_log SET sync_version = strftime('%s', 'now') WHERE sync_version = 0");
}

function changeLogMaxId(db: TestDatabase): number {
  return Number(db.pluck<number>('SELECT COALESCE(MAX(id), 0) FROM __change_log') ?? 0);
}

describe('sync_r13_migration_change_log_propagation.rs', () => {
  suite('v20260824_normalization_updates_enter_change_log_as_pending', () => {
    const db = openTestDatabase();
    db.exec(read('resources/app/migrations/mistakes/V20260130__init.sql'));
    db.exec(read('resources/app/migrations/mistakes/V20260201__add_sync_fields.sql'));
    db.exec(read('resources/app/migrations/mistakes/V20260131__add_change_log.sql'));

    db.run(
      `INSERT INTO document_tasks
         (id, document_id, original_document_name, segment_index, content_segment,
          status, anki_generation_options_json)
       VALUES ('task-1', 'doc-1', 'doc.md', 0, 'segment', 'Completed', '{}')`,
    );
    db.run(
      `INSERT INTO anki_cards
         (id, task_id, front, back, tags_json, images_json, extra_fields_json, updated_at)
       VALUES ('card-dirty', 'task-1', 'dirty front', 'dirty back', NULL, '', '  ',
               '2026-08-10T00:00:00.000Z')`,
    );
    db.run(
      `INSERT INTO anki_cards
         (id, task_id, front, back, tags_json, images_json, extra_fields_json)
       VALUES ('card-clean', 'task-1', 'clean front', 'clean back', '[]', '[]', '{}')`,
    );
    markAllChangeLogSynced(db);

    db.exec(read('resources/app/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql'));

    const normalized = db.get<{
      tags_json: string;
      images_json: string;
      extra_fields_json: string;
      updated_at: string;
    }>('SELECT tags_json, images_json, extra_fields_json, updated_at FROM anki_cards WHERE id = ?1', ['card-dirty']);
    expect(normalized?.tags_json).toBe('[]');
    expect(normalized?.images_json).toBe('[]');
    expect(normalized?.extra_fields_json).toBe('{}');
    expect(normalized?.updated_at).toBe('2026-08-10T00:00:00.000Z');

    const pending = pendingRowsForTable(db, 'anki_cards');
    expect(pending.some(row => row.record_id === 'card-dirty' && row.operation === 'UPDATE')).toBe(true);
    expect(pending.every(row => row.record_id !== 'card-clean')).toBe(true);

    const visible = getPendingChanges(db, 'anki_cards', null);
    expect(visible.entries.some(entry => entry.table_name === 'anki_cards' && entry.record_id === 'card-dirty')).toBe(true);

    const maxIdBefore = changeLogMaxId(db);
    db.exec(read('resources/app/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql'));
    expect(Number(db.pluck<number>(
      'SELECT COUNT(*) FROM __change_log WHERE id > ?1',
      [maxIdBefore],
    ))).toBe(0);
  });

  suite('v20260824_null_source_tombstone_sweep_enters_change_log', () => {
    const db = openTestDatabase();
    db.exec(read('resources/app/migrations/mistakes/V20260130__init.sql'));
    db.exec(`
      DROP TABLE anki_cards;
      CREATE TABLE anki_cards (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          front TEXT NOT NULL,
          back TEXT NOT NULL,
          tags_json TEXT,
          images_json TEXT,
          is_error_card INTEGER NOT NULL DEFAULT 0,
          error_content TEXT,
          card_order_in_task INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          extra_fields_json TEXT,
          template_id TEXT,
          source_type TEXT,
          source_id TEXT,
          text TEXT,
          device_id TEXT,
          local_version INTEGER DEFAULT 0,
          deleted_at TEXT
      );
    `);
    db.exec(read('resources/app/migrations/mistakes/V20260131__add_change_log.sql'));
    db.exec(read('resources/app/migrations/mistakes/V20260724__anki_dedup_index_exclude_deleted.sql'));
    db.exec(`
      INSERT INTO anki_cards (id, front, back, updated_at, created_at)
      VALUES ('legacy-old', 'F', 'B', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
      INSERT INTO anki_cards (id, front, back, updated_at, created_at)
      VALUES ('legacy-new', 'F', 'B', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    `);
    markAllChangeLogSynced(db);

    db.exec(read('resources/app/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql'));

    const winner = db.get<{ deleted_at: string | null; source_type: string }>(
      'SELECT deleted_at, source_type FROM anki_cards WHERE id = ?1',
      ['legacy-new'],
    );
    expect(winner?.deleted_at).toBeNull();
    expect(winner?.source_type).toBe('');
    const loser = db.get<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM anki_cards WHERE id = ?1',
      ['legacy-old'],
    );
    expect(loser?.deleted_at).not.toBeNull();

    const pending = pendingRowsForTable(db, 'anki_cards');
    for (const id of ['legacy-old', 'legacy-new']) {
      expect(pending.some(row => row.record_id === id && row.operation === 'UPDATE')).toBe(true);
    }
    const visible = getPendingChanges(db, 'anki_cards', null);
    expect(visible.entries.some(entry => entry.record_id === 'legacy-old')).toBe(true);
  });

  suite('gap_v20260302_folder_items_normalization_never_entered_change_log', () => {
    const db = openTestDatabase();
    db.exec(read('resources/app/migrations/vfs/V20260130__init.sql'));
    db.exec(read('resources/app/migrations/vfs/V20260131__add_change_log.sql'));
    db.run(
      `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at)
       VALUES ('fi_legacy0001', NULL, 'note', 'note-1', 0,
               '2026-02-14T08:00:00Z', '2026-02-14T09:00:00Z')`,
    );

    db.exec(read('resources/app/migrations/vfs/V20260302__normalize_folder_items_timestamps.sql'));

    const types = db.get<{ created_type: string; updated_type: string }>(
      `SELECT typeof(created_at) AS created_type, typeof(updated_at) AS updated_type
       FROM folder_items WHERE id = ?1`,
      ['fi_legacy0001'],
    );
    expect(types?.created_type).toBe('integer');
    expect(types?.updated_type).toBe('integer');
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __change_log WHERE table_name = 'folder_items'",
    ))).toBe(0);
  });
});
