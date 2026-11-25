import './local-runtime-fixture.ts';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import { resolveRecordConflict, rollbackSyncSnapshotBatch } from '../src/conflict-commands.ts';
import { snapshotRecordWithData } from '../repository/history.ts';
import { getRecordData } from '../repository/record-data.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const suite = describe;

function storageFor(db: TestDatabase): StorageService {
  return {
    pathOf: (name: CoordinatedDatabaseName) => (name === 'vfs' || name === 'mistakes' ? '/tmp' : `/nonexistent/${name}.db`),
    openFile: () => db,
    close: () => undefined,
  } as unknown as StorageService;
}

function createDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE __sync_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('local','cloud')),
        data_json TEXT NOT NULL,
        data_hash TEXT NOT NULL DEFAULT '',
        winning_device_id TEXT,
        losing_device_id TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolution TEXT
    );
    CREATE TABLE __sync_record_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        existed INTEGER NOT NULL CHECK(existed IN (0,1)),
        data_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        rolled_back_at TEXT
    );
    CREATE UNIQUE INDEX idx__sync_record_history_dedup
        ON __sync_record_history(batch_id, table_name, record_id);
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT,
        updated_at TEXT,
        local_version INTEGER DEFAULT 0
    );
  `);
  return db;
}

function seedConflict(db: TestDatabase, local: unknown, cloud: unknown): number[] {
  const insert = db.run(
    `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
     VALUES ('notes', 'note-1', ?1, ?2)`,
    ['local', JSON.stringify(local)],
  );
  const localId = Number(insert.lastInsertRowid);
  const cloudInsert = db.run(
    `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
     VALUES ('notes', 'note-1', ?1, ?2)`,
    ['cloud', JSON.stringify(cloud)],
  );
  return [localId, Number(cloudInsert.lastInsertRowid)];
}

suite('conflict commands', () => {
  it('resolve_record_conflict_keep_cloud_writes_business_row_and_marks_resolved', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'local', '2026-01-01T00:00:00Z')",
    );
    db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('notes', 'note-1', 'UPDATE', 0)",
    );
    const ids = seedConflict(
      db,
      getRecordData(db, 'notes', 'note-1', 'id'),
      { id: 'note-1', title: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
    );

    resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, ids);

    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('cloud');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_record_history'))).toBe(1);
  });

  it('resolve_record_conflict_rejects_stale_generation', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const ids = seedConflict(db, getRecordData(db, 'notes', 'note-1', 'id'), { id: 'note-1', title: 'cloud' });

    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, [ids[1] as number]))
      .toThrow('冲突已在后台变化，旧决策未执行；请刷新后重新确认');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(2);
  });

  it('resolve_record_conflict_rejects_unknown_database', () => {
    const db = createDb();
    expect(() => resolveRecordConflict(storageFor(db), 'unknown', 'notes', 'note-1', 'keep_cloud', null, [1]))
      .toThrow('未知数据库: unknown');
  });

  it('resolve_record_conflict_requires_expected_ids', () => {
    const db = createDb();
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, []))
      .toThrow('缺少冲突版本标识，请刷新冲突列表后重试');
  });

  it('rollback_snapshot_batch_restores_snapshot_and_marks_batch', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'current', '2026-01-02T00:00:00Z')",
    );
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1',
      { id: 'note-1', title: 'snapshot', updated_at: '2026-01-01T00:00:00Z' });

    const outcome = rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(outcome.restored).toBe(1);
    expect(outcome.deleted).toBe(0);
    expect(outcome.skipped).toBe(0);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('snapshot');
    expect(db.pluck<string>('SELECT rolled_back_at FROM __sync_record_history WHERE batch_id = ?1', ['batch-1']))
      .not.toBeNull();
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_record_history WHERE reason = 'rollback_undo' AND batch_id = ?1",
      [outcome.undo_batch_id],
    ))).toBe(1);
  });

  it('rollback_snapshot_batch_rejects_second_rollback', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'current')");
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1', { id: 'note-1', title: 'snapshot' });
    rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1'))
      .toThrow(/已回退过/);
  });

  it('rollback_snapshot_batch_deletes_record_missing_at_snapshot', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'current')");
    snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'note-1', null);
    const outcome = rollbackSyncSnapshotBatch(storageFor(db), 'vfs', 'batch-1');
    expect(outcome.deleted).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM notes'))).toBe(0);
  });

  it('resolve_record_conflict_keep_local_restores_recorded_local_after_cloud_overwrite', () => {
    const db = createDb();
    db.run(
      "INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'cloud', '2026-01-02T00:00:00Z')",
    );
    const cloudRow = getRecordData(db, 'notes', 'note-1', 'id');
    db.run("UPDATE notes SET title = 'local', updated_at = '2026-01-01T00:00:00Z' WHERE id = 'note-1'");
    const localRow = getRecordData(db, 'notes', 'note-1', 'id');
    db.run("UPDATE notes SET title = 'cloud', updated_at = '2026-01-02T00:00:00Z' WHERE id = 'note-1'");
    const ids = seedConflict(db, localRow, cloudRow);
    resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_local', null, ids);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('local');
  });

  it('resolve_record_conflict_merged_requires_payload', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const ids = seedConflict(db, getRecordData(db, 'notes', 'note-1', 'id'), { id: 'note-1', title: 'cloud' });
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'merged', null, ids))
      .toThrow("resolution='merged' 时必须提供 merged_data_json");
  });

  it('resolve_record_conflict_without_cloud_side_reports_actionable_error', () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title) VALUES ('note-1', 'local')");
    const insert = db.run(
      `INSERT INTO __sync_conflicts (table_name, record_id, side, data_json)
       VALUES ('notes', 'note-1', 'local', ?1)`,
      [JSON.stringify(getRecordData(db, 'notes', 'note-1', 'id'))],
    );
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_cloud', null, [Number(insert.lastInsertRowid)]))
      .toThrow('找不到该冲突的 cloud side 数据');
  });

  it('rollback_snapshot_batch_unknown_database_uses_rust_error', () => {
    const db = createDb();
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'nope', 'batch-1')).toThrow(CommandError);
    expect(() => rollbackSyncSnapshotBatch(storageFor(db), 'nope', 'batch-1')).toThrow('未知数据库: nope');
  });

  it('resolve_record_conflict_keep_both_applies_cloud_and_creates_labeled_local_copy_with_changelog', () => {
    const db = createDb();
    db.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'note',
        source_id TEXT,
        source_table TEXT,
        storage_mode TEXT DEFAULT 'inline',
        data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE TABLE folder_items (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      ALTER TABLE notes ADD COLUMN resource_id TEXT;
      ALTER TABLE notes ADD COLUMN created_at TEXT;
      ALTER TABLE notes ADD COLUMN deleted_at TEXT;
    `);
    db.run(
      "INSERT INTO resources (id, hash, type, source_id, source_table, data, created_at, updated_at) VALUES ('res-1', 'h-local', 'note', 'note-1', 'notes', 'Local Body', 1700000000000, 1700000000000)",
    );
    db.run(
      "INSERT INTO notes (id, resource_id, title, created_at, updated_at) VALUES ('note-1', 'res-1', 'Linear Algebra', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    db.run(
      "INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at, updated_at) VALUES ('fi-1', 'folder-math', 'note', 'note-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    );
    const localNote = {
      ...(getRecordData(db, 'notes', 'note-1', 'id') as Record<string, unknown>),
      content_md: 'Local Body',
    };
    const cloudNote = {
      ...(getRecordData(db, 'notes', 'note-1', 'id') as Record<string, unknown>),
      title: 'Linear Algebra (Cloud)',
      updated_at: '2026-01-02T00:00:00Z',
      content_md: 'Cloud Body',
    };
    const ids = seedConflict(db, localNote, cloudNote);

    resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-1', 'keep_both', null, ids);

    // Original note receives cloud title & cloud body
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('Linear Algebra (Cloud)');
    expect(db.pluck<string>('SELECT data FROM resources WHERE id = ?1', ['res-1'])).toBe('Cloud Body');
    expect(db.pluck<string>('SELECT typeof(updated_at) FROM resources WHERE id = ?1', ['res-1'])).toBe('integer');

    // Local copy is created with labeled title, fresh resource, folder mount, and pending INSERT changelog
    const allNotes = db.all<{ id: string; title: string; resource_id: string }>('SELECT id, title, resource_id FROM notes ORDER BY id');
    expect(allNotes).toHaveLength(2);
    const clone = allNotes.find((n) => n.id !== 'note-1')!;
    expect(clone.title).toMatch(/^Linear Algebra \(本地冲突副本 \d{4}-\d{2}-\d{2}\)$/);
    expect(clone.resource_id).not.toBe('res-1');
    expect(db.pluck<string>('SELECT data FROM resources WHERE id = ?1', [clone.resource_id])).toBe('Local Body');
    expect(db.pluck<string>('SELECT typeof(updated_at) FROM resources WHERE id = ?1', [clone.resource_id])).toBe('integer');

    // Folder mount cloned so conflict copy is visible in the same folder
    const clonedMount = db.get<{ folder_id: string }>('SELECT folder_id FROM folder_items WHERE item_id = ?1', [clone.id]);
    expect(clonedMount?.folder_id).toBe('folder-math');

    // Pending __change_log entries created for both original UPDATE and cloned INSERTs
    const pendingInserts = db.all<{ table_name: string; record_id: string }>(
      "SELECT table_name, record_id FROM __change_log WHERE operation = 'INSERT' AND sync_version = 0",
    );
    expect(pendingInserts.some((r) => r.table_name === 'notes' && r.record_id === clone.id)).toBe(true);
    expect(pendingInserts.some((r) => r.table_name === 'resources' && r.record_id === clone.resource_id)).toBe(true);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts WHERE resolved_at IS NULL'))).toBe(0);
    expect(db.pluck<string>('SELECT resolution FROM __sync_conflicts LIMIT 1')).toBe('keep_both');
  });

  it('resolve_record_conflict_keep_both_handles_resources_anki_cards_questions_mistakes_and_rejects_null', () => {
    const db = createDb();
    db.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL DEFAULT 'note',
        source_id TEXT,
        source_table TEXT,
        data TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      ALTER TABLE notes ADD COLUMN resource_id TEXT;
      CREATE TABLE anki_cards (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT NOT NULL DEFAULT '',
        front TEXT NOT NULL DEFAULT '',
        back TEXT NOT NULL DEFAULT '',
        text TEXT,
        is_error_card INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE UNIQUE INDEX idx_anki_cards_dedup_unique ON anki_cards(
        source_type,
        source_id,
        CASE WHEN source_type='apkg_import' THEN id
             WHEN text IS NOT NULL AND length(text)>0 THEN text
             ELSE printf('%d:%s|%s', length(front), front, back) END
      ) WHERE is_error_card=0 AND deleted_at IS NULL;
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        exam_id TEXT NOT NULL,
        source_key TEXT,
        question_label TEXT,
        content TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE UNIQUE INDEX idx_questions_source_slot ON questions(exam_id, source_key) WHERE source_key IS NOT NULL;
    `);

    // 1) resources conflict linked to note (cloud already on disk -> desiredState path!)
    db.run("INSERT INTO resources (id, hash, type, source_id, source_table, data, created_at, updated_at) VALUES ('res-link', 'h-cloud', 'note', 'note-link', 'notes', 'Cloud Resource Body', 1700000000000, 1700000002000)");
    db.run("INSERT INTO notes (id, resource_id, title, updated_at) VALUES ('note-link', 'res-link', 'Body Only Conflict Note', '2026-01-02T00:00:00Z')");
    const cloudRes = getRecordData(db, 'resources', 'res-link', 'id');
    const localRes = { ...(cloudRes as Record<string, unknown>), hash: 'h-local', data: 'Local Resource Body', updated_at: 1700000001000 };
    const rLocalId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-link', 'local', ?1)", [JSON.stringify(localRes)]).lastInsertRowid);
    const rCloudId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('resources', 'res-link', 'cloud', ?1)", [JSON.stringify(cloudRes)]).lastInsertRowid);
    resolveRecordConflict(storageFor(db), 'vfs', 'resources', 'res-link', 'keep_both', null, [rLocalId, rCloudId]);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM notes'))).toBe(2);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM resources'))).toBe(2);

    // 2) anki_cards conflict in mistakes DB (must satisfy idx_anki_cards_dedup_unique)
    db.run("INSERT INTO anki_cards (id, source_type, source_id, front, back, updated_at) VALUES ('card-1', 'manual', 'deck-1', 'What is ATP?', 'Energy currency', '2026-01-01T00:00:00Z')");
    const localCard = getRecordData(db, 'anki_cards', 'card-1', 'id');
    const cloudCard = { ...(localCard as Record<string, unknown>), back: 'Cloud Answer', updated_at: '2026-01-02T00:00:00Z' };
    const cLocalId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('anki_cards', 'card-1', 'local', ?1)", [JSON.stringify(localCard)]).lastInsertRowid);
    const cCloudId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('anki_cards', 'card-1', 'cloud', ?1)", [JSON.stringify(cloudCard)]).lastInsertRowid);
    resolveRecordConflict(storageFor(db), 'mistakes', 'anki_cards', 'card-1', 'keep_both', null, [cLocalId, cCloudId]);
    const cards = db.all<{ id: string; front: string; back: string }>('SELECT id, front, back FROM anki_cards');
    expect(cards).toHaveLength(2);
    expect(cards.find((c) => c.id === 'card-1')?.back).toBe('Cloud Answer');
    expect(cards.find((c) => c.id !== 'card-1')?.front).toContain('本地冲突副本');

    // 3) questions conflict (must clear source_key to satisfy idx_questions_source_slot)
    db.run("INSERT INTO questions (id, exam_id, source_key, question_label, content, updated_at) VALUES ('q-1', 'exam-1', 'slot-1', 'Q1', 'Local Q', '2026-01-01T00:00:00Z')");
    const localQ = getRecordData(db, 'questions', 'q-1', 'id');
    const cloudQ = { ...(localQ as Record<string, unknown>), content: 'Cloud Q', updated_at: '2026-01-02T00:00:00Z' };
    const qLocalId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('questions', 'q-1', 'local', ?1)", [JSON.stringify(localQ)]).lastInsertRowid);
    const qCloudId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('questions', 'q-1', 'cloud', ?1)", [JSON.stringify(cloudQ)]).lastInsertRowid);
    resolveRecordConflict(storageFor(db), 'vfs', 'questions', 'q-1', 'keep_both', null, [qLocalId, qCloudId]);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM questions'))).toBe(2);

    // 4) cloud-only null delete conflict rejects keep_both cleanly
    const delId = Number(db.run("INSERT INTO __sync_conflicts (table_name, record_id, side, data_json) VALUES ('notes', 'note-link', 'cloud', 'null')").lastInsertRowid);
    expect(() => resolveRecordConflict(storageFor(db), 'vfs', 'notes', 'note-link', 'keep_both', null, [delId]))
      .toThrow('仅当本地与云端均存在记录内容时才支持保留两者');
  });

  it('resolve_record_conflict_keep_both_localizes_conflict_copy_title_for_en_US_and_zh_CN', () => {
    // 1) en-US via explicit options.locale -> "(Conflict copy YYYY-MM-DD)"
    const enDb = createDb();
    enDb.run("INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'Calculus Notes', '2026-01-01T00:00:00Z')");
    const enLocal = getRecordData(enDb, 'notes', 'note-1', 'id') as Record<string, unknown>;
    const enIds = seedConflict(
      enDb,
      enLocal,
      { ...enLocal, title: 'Calculus Notes (Cloud)', updated_at: '2026-01-02T00:00:00Z' },
    );
    resolveRecordConflict(storageFor(enDb), 'vfs', 'notes', 'note-1', 'keep_both', null, enIds, { locale: 'en-US' });
    const enNotes = enDb.all<{ id: string; title: string }>('SELECT id, title FROM notes');
    expect(enNotes).toHaveLength(2);
    const enClone = enNotes.find((n) => n.id !== 'note-1')!;
    expect(enClone.title).toMatch(/^Calculus Notes \(Conflict copy \d{4}-\d{2}-\d{2}\)$/);
    expect(enClone.title).not.toContain('本地冲突副本');

    // 2) en-US via settings table in DB (no options passed) -> "(Conflict copy YYYY-MM-DD)"
    const settingsDb = createDb();
    settingsDb.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    settingsDb.run("INSERT INTO settings (key, value, updated_at) VALUES ('language', 'en-US', '2026-01-01T00:00:00Z')");
    settingsDb.run("INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'Physics Lab', '2026-01-01T00:00:00Z')");
    const settingsLocal = getRecordData(settingsDb, 'notes', 'note-1', 'id') as Record<string, unknown>;
    const settingsIds = seedConflict(
      settingsDb,
      settingsLocal,
      { ...settingsLocal, title: 'Physics Lab (Cloud)', updated_at: '2026-01-02T00:00:00Z' },
    );
    resolveRecordConflict(storageFor(settingsDb), 'vfs', 'notes', 'note-1', 'keep_both', null, settingsIds);
    const settingsClone = settingsDb.all<{ id: string; title: string }>('SELECT id, title FROM notes').find((n) => n.id !== 'note-1')!;
    expect(settingsClone.title).toMatch(/^Physics Lab \(Conflict copy \d{4}-\d{2}-\d{2}\)$/);

    // 3) zh-CN via explicit options.locale -> "(本地冲突副本 YYYY-MM-DD)"
    const zhDb = createDb();
    zhDb.run("INSERT INTO notes (id, title, updated_at) VALUES ('note-1', '高等数学', '2026-01-01T00:00:00Z')");
    const zhLocal = getRecordData(zhDb, 'notes', 'note-1', 'id') as Record<string, unknown>;
    const zhIds = seedConflict(
      zhDb,
      zhLocal,
      { ...zhLocal, title: '高等数学（云端）', updated_at: '2026-01-02T00:00:00Z' },
    );
    resolveRecordConflict(storageFor(zhDb), 'vfs', 'notes', 'note-1', 'keep_both', null, zhIds, { locale: 'zh-CN' });
    const zhClone = zhDb.all<{ id: string; title: string }>('SELECT id, title FROM notes').find((n) => n.id !== 'note-1')!;
    expect(zhClone.title).toMatch(/^高等数学 \(本地冲突副本 \d{4}-\d{2}-\d{2}\)$/);
  });
});
