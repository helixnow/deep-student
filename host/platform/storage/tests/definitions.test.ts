/**
 * 移植 dstu-storage/src/migration/{mod,vfs,chat_v2,mistakes,llm_usage}.rs 中的 #[test]。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import type { MigrationDef } from '../migration/definitions.ts';
import { ALL_MIGRATION_SET_ORDER, DATABASE_COUNT, DEFAULT_MIGRATIONS_DIR, getMigrationSet, loadMigrationSets } from '../migration/definitions/index.ts';
import * as chat from '../migration/definitions/chat_v2.ts';
import * as llm from '../migration/definitions/llm_usage.ts';
import * as mistakes from '../migration/definitions/mistakes.ts';
import * as vfs from '../migration/definitions/vfs.ts';
import { parseMigrationName } from '../migration/refinery.ts';

const sets = loadMigrationSets(DEFAULT_MIGRATIONS_DIR);
const memory = () => new Connection(':memory:', { label: 'test', profile: PROFILES.plain });
const def = (db: keyof typeof sets, version: number): MigrationDef => {
  const m = sets[db].get(version);
  expect(m, `${db} V${version}`).toBeDefined();
  return m!;
};
const hasColumn = (m: MigrationDef, t: string, c: string) => m.expectedColumns.some(([a, b]) => a === t && b === c);

describe('migration/mod.rs', () => {
  it('test_all_migration_sets_count', () => {
    expect(ALL_MIGRATION_SET_ORDER.length).toBe(DATABASE_COUNT);
  });
  it('test_all_migration_sets_names', () => {
    const names = ALL_MIGRATION_SET_ORDER.map((n) => sets[n].databaseName);
    for (const n of ['vfs', 'chat_v2', 'mistakes', 'llm_usage']) expect(names).toContain(n);
  });
  it('test_get_migration_set', () => {
    for (const n of ['vfs', 'chat_v2', 'mistakes', 'llm_usage']) expect(getMigrationSet(sets, n)).toBeDefined();
    expect(getMigrationSet(sets, 'unknown')).toBeUndefined();
  });
  it('test_all_sets_have_migrations', () => {
    for (const n of ALL_MIGRATION_SET_ORDER) expect(sets[n].migrations.length, n).toBeGreaterThan(0);
  });
  it('test_all_sets_have_valid_versions', () => {
    for (const n of ALL_MIGRATION_SET_ORDER) expect(sets[n].latestVersion(), n).toBeGreaterThan(0);
  });
  it('every migration file has exactly one spec with the same version/name and vice versa', () => {
    // Rust 契约中这两处名称与文件名（add_ 前缀）不一致（MigrationDef.name 仅作本地辅助，refinery 以文件名为准）。
    const mismatches: string[] = [];
    for (const n of ALL_MIGRATION_SET_ORDER) {
      const files = fs
        .readdirSync(path.join(DEFAULT_MIGRATIONS_DIR, n))
        .filter((f) => f.endsWith('.sql'))
        .map((f) => parseMigrationName(path.basename(f, '.sql')));
      const specs = sets[n].migrations;
      expect(specs.length, n).toBe(files.length);
      for (const f of files) {
        const matches = specs.filter((s) => s.refineryVersion === f.version);
        expect(matches.length, `${n} V${f.version}`).toBe(1);
        if (matches[0]!.name !== f.name) mismatches.push(`${n}:${f.version}:${matches[0]!.name}`);
      }
    }
    expect(mismatches).toEqual(['chat_v2:20260207:active_skill_ids_json', 'chat_v2:20260306:skill_state_json']);
  });
});

describe('migration/vfs.rs', () => {
  const set = sets.vfs;
  it('test_vfs_migration_set_structure', () => {
    expect(set.databaseName).toBe('vfs');
    expect(set.count()).toBe(vfs.VFS_MIGRATIONS.length);
    expect(set.migrations.map((m) => m.refineryVersion)).toEqual(vfs.VFS_MIGRATIONS.map((m) => m.refineryVersion));
    for (let i = 1; i < vfs.VFS_MIGRATIONS.length; i++) {
      expect(vfs.VFS_MIGRATIONS[i - 1]!.refineryVersion).toBeLessThan(vfs.VFS_MIGRATIONS[i]!.refineryVersion);
    }
  });
  it('test_v20260130_migration_def', () => {
    const m = def('vfs', 20260130);
    expect(m.name).toBe('init');
    expect(m.idempotent).toBe(true);
    expect(m.expectedTables.length).toBe(25);
    expect(m.expectedQueries.length).toBe(2);
  });
  it('test_note_history_is_registered_as_vfs_schema_head', () => {
    expect(vfs.VFS_SCHEMA_VERSION).toBe(20261111);
    expect(vfs.V20260912_QBANK_GENERATION_TASKS.expectedTables).toEqual(['qbank_generation_tasks']);
    expect(vfs.VFS_MIGRATIONS[vfs.VFS_MIGRATIONS.length - 1]!.name).toBe('study_space_profiles_and_mounts');
    expect(vfs.V20261006_STUDY_TIME.expectedTables).toEqual(['study_time_daily']);
    expect(vfs.V20261023_QUESTION_AUTHORING_V2.expectedTables).toEqual([
      'qbank_sources',
      'qbank_materials',
      'qbank_groups',
      'qbank_group_materials',
      'qbank_import_jobs',
    ]);
    expect(vfs.V20260907_INSIGHT_CARDS.expectedTables).toContain('insights');
    expect(vfs.V20260908_INSIGHT_FTS.expectedTables).toContain('insight_fts');
  });
  it('test_v001_expected_tables_count', () => {
    expect(vfs.VFS_V001_TABLES.length).toBe(25);
  });
  it('test_v001_sql_not_empty', () => {
    const sql = def('vfs', 20260130).sql;
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toContain('CREATE TABLE');
  });
  it('test_notes_versions_create_then_drop_is_declared', () => {
    expect(def('vfs', 20260130).sql).toContain('CREATE TABLE IF NOT EXISTS notes_versions');
    expect(def('vfs', vfs.V20260214_DROP_NOTES_VERSIONS.refineryVersion).sql).toContain('DROP TABLE IF EXISTS notes_versions');
  });
  it('test_all_table_names_completeness', () => {
    expect(vfs.VFS_ALL_TABLE_NAMES.length).toBe(vfs.VFS_TABLE_COUNT + vfs.VFS_FTS_TABLE_COUNT);
  });
  it('test_key_tables_present', () => {
    for (const t of ['resources', 'notes', 'files', 'questions', 'folders']) expect(vfs.VFS_V001_TABLES).toContain(t);
  });
  it('test_key_indexes_present', () => {
    for (const i of ['idx_resources_hash', 'idx_questions_exam_id', 'idx_folders_parent']) expect(vfs.VFS_V001_KEY_INDEXES).toContain(i);
  });
  it('test_migration_set_get', () => {
    expect(set.get(20260130)?.refineryVersion).toBe(20260130);
    expect(set.get(20260525)?.refineryVersion).toBe(20260525);
    expect(set.get(1)).toBeUndefined();
  });
  it('test_latest_version', () => {
    expect(set.latestVersion()).toBe(vfs.VFS_SCHEMA_VERSION);
  });
  it('vector_profile_migration_backfills_legacy_image_as_multimodal_deterministically', () => {
    const conn = memory();
    conn.exec(`CREATE TABLE vfs_embedding_dims (
                dimension INTEGER NOT NULL, modality TEXT NOT NULL,
                lance_table_name TEXT NOT NULL, record_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
                model_config_id TEXT, model_name TEXT,
                PRIMARY KEY (dimension, modality));
             CREATE TABLE vfs_index_units (
                id TEXT PRIMARY KEY, text_embedding_dim INTEGER, mm_embedding_dim INTEGER,
                text_required INTEGER NOT NULL DEFAULT 0, text_state TEXT NOT NULL DEFAULT 'disabled',
                text_error TEXT, mm_required INTEGER NOT NULL DEFAULT 0,
                mm_state TEXT NOT NULL DEFAULT 'disabled', mm_error TEXT);
             CREATE TABLE vfs_index_segments (
                id TEXT PRIMARY KEY, embedding_dim INTEGER NOT NULL, modality TEXT NOT NULL);
             CREATE TABLE resources (
                id TEXT PRIMARY KEY, index_state TEXT, index_error TEXT,
                index_retry_count INTEGER DEFAULT 0, mm_index_state TEXT,
                mm_index_error TEXT, mm_index_retry_count INTEGER DEFAULT 0);
             CREATE TABLE __lance_orphan_queue (
                lance_row_id TEXT PRIMARY KEY, enqueued_at INTEGER NOT NULL DEFAULT 0);
             INSERT INTO vfs_embedding_dims VALUES
                (512, 'image', 'legacy_image_512', 1, 1, 1, 'cfg-image', 'image-model'),
                (1024, 'image', 'legacy_image_1024', 1, 1, 1, 'cfg-image', 'image-model'),
                (1024, 'multimodal', 'legacy_mm_1024', 1, 1, 1, 'cfg-mm', 'mm-model');
             INSERT INTO vfs_index_units
                (id, mm_embedding_dim, mm_required, mm_state)
             VALUES ('unit-image-only', 512, 1, 'indexed'),
                    ('unit-both', 1024, 1, 'indexed');`);
    conn.exec(def('vfs', 20260714).sql);
    expect(conn.pluck("SELECT embedding_protocol FROM vfs_embedding_dims WHERE dimension = 512 AND modality = 'image'")).toBe(
      'multimodal-embedding-v1',
    );
    expect(conn.pluck("SELECT mm_profile_id FROM vfs_index_units WHERE id = 'unit-image-only'")).toBe('profile_legacy_image_512');
    expect(conn.pluck("SELECT mm_profile_id FROM vfs_index_units WHERE id = 'unit-both'")).toBe('profile_legacy_multimodal_1024');
    conn.close();
  });
});

describe('migration/chat_v2.rs', () => {
  const set = sets.chat_v2;
  it('test_migration_set_structure', () => {
    expect(set.databaseName).toBe('chat_v2');
    expect(set.count()).toBe(30);
  });
  it('test_v20260130_migration', () => {
    const m = def('chat_v2', 20260130);
    expect(m.name).toBe('init');
    expect(m.expectedTables.length).toBe(11);
    expect(m.expectedIndexes.length).toBe(38);
    expect(m.idempotent).toBe(true);
  });
  it('test_expected_tables_count', () => {
    expect(chat.V001_EXPECTED_TABLES.length).toBe(11);
  });
  it('test_expected_indexes_count', () => {
    expect(chat.V001_EXPECTED_INDEXES.length).toBe(38);
  });
  it('test_latest_version', () => {
    expect(set.latestVersion()).toBe(chat.CHAT_V2_SCHEMA_VERSION);
  });
  it('test_v20260528_rebuild_removes_type_check_and_preserves_data', () => {
    const conn = memory();
    conn.exec(`CREATE TABLE __change_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 table_name TEXT NOT NULL,
                 record_id TEXT NOT NULL,
                 operation TEXT NOT NULL,
                 field_deltas_json TEXT
             );
             CREATE TABLE resources (
                 id TEXT PRIMARY KEY,
                 hash TEXT NOT NULL UNIQUE,
                 type TEXT NOT NULL CHECK(type IN ('image','file','note','card','retrieval')),
                 source_id TEXT,
                 data TEXT,
                 metadata_json TEXT,
                 ref_count INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 device_id TEXT,
                 local_version INTEGER DEFAULT 0,
                 updated_at TEXT,
                 deleted_at TEXT
             );
             INSERT INTO resources (id, hash, type, data, created_at)
             VALUES ('existing', 'hash-existing', 'image', 'payload', 1);`);
    const sql = def('chat_v2', 20260528).sql;
    conn.exec(sql);
    conn.run(`INSERT INTO resources (id, hash, type, data, created_at)
             VALUES ('new-type', 'hash-new-type', 'folder', 'folder payload', 2)`);
    expect(conn.pluck("SELECT data FROM resources WHERE id = 'existing'")).toBe('payload');
    const resourcesSql = conn.pluck<string>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'")!;
    expect(resourcesSql.toUpperCase()).not.toContain('CHECK');
    conn.exec(sql);
    expect(conn.pluck('SELECT COUNT(*) FROM resources')).toBe(2);
    conn.close();
  });
  it('test_v20260711_session_tags_emit_unambiguous_composite_keys', () => {
    const conn = memory();
    conn.exec(`CREATE TABLE __change_log (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 table_name TEXT NOT NULL,
                 record_id TEXT NOT NULL,
                 operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE'))
             );
             CREATE TABLE chat_v2_session_tags (
                 session_id TEXT NOT NULL,
                 tag TEXT NOT NULL,
                 tag_type TEXT NOT NULL DEFAULT 'auto',
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 PRIMARY KEY (session_id, tag)
             );`);
    const sql = def('chat_v2', 20260711).sql;
    conn.exec(sql);
    conn.exec(sql);
    conn.run('INSERT INTO chat_v2_session_tags (session_id, tag) VALUES (?1, ?2)', ['session:one', 'tag:"quoted"']);
    conn.run("UPDATE chat_v2_session_tags SET tag_type = 'manual' WHERE session_id = ?1 AND tag = ?2", ['session:one', 'tag:"quoted"']);
    conn.run('UPDATE chat_v2_session_tags SET tag = ?1 WHERE session_id = ?2 AND tag = ?3', ['renamed:tag', 'session:one', 'tag:"quoted"']);
    conn.run('DELETE FROM chat_v2_session_tags WHERE session_id = ?1 AND tag = ?2', ['session:one', 'renamed:tag']);
    const changes = conn
      .all<{ operation: string; record_id: string }>(
        "SELECT operation, record_id FROM __change_log WHERE table_name = 'chat_v2_session_tags' ORDER BY id",
      )
      .map((r) => [r.operation, JSON.parse(r.record_id)] as const);
    expect(changes.map((c) => c[0])).toEqual(['INSERT', 'UPDATE', 'DELETE', 'INSERT', 'DELETE']);
    const first = { session_id: 'session:one', tag: 'tag:"quoted"' };
    const renamed = { session_id: 'session:one', tag: 'renamed:tag' };
    expect(changes[0]![1]).toEqual(first);
    expect(changes[1]![1]).toEqual(first);
    expect(changes[2]![1]).toEqual(first);
    expect(changes[3]![1]).toEqual(renamed);
    expect(changes[4]![1]).toEqual(renamed);
    conn.close();
  });
  it('test_pending_migrations', () => {
    const expected = [
      20260130, 20260131, 20260201, 20260202, 20260203, 20260204, 20260207, 20260221, 20260301, 20260302, 20260306, 20260502,
      20260510, 20260516, 20260523, 20260524, 20260527, 20260528, 20260711, 20260717, 20260719, 20260720, 20260721, 20260806,
      20260905, 20260907, 20260908, 20260909, 20260910, 20261111,
    ];
    expect(set.pending(0).map((m) => m.refineryVersion)).toEqual(expected);
    expected.forEach((v, i) => expect(set.pending(v).length).toBe(expected.length - i - 1));
    expect(set.pending(20260910).length).toBe(1);
    expect(set.pending(20261111).length).toBe(0);
  });
  it('test_get_compaction_migration', () => {
    expect(def('chat_v2', 20260510).name).toBe('add_compaction');
  });
  it('test_v20260910_revocation_epochs_and_budget_idempotent', () => {
    const conn = memory();
    const sql = def('chat_v2', 20260910).sql;
    conn.exec(sql);
    conn.exec(sql);
    conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('global', '', 1, 't0')");
    conn.run(
      "INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('task', 'child-a', 2, 't0'), ('task', 'child-b', 5, 't0')",
    );
    expect(() => conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('global', '', 9, 't1')")).toThrow();
    expect(() => conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('task', 'child-a', 9, 't1')")).toThrow();
    expect(() => conn.run("INSERT INTO revocation_epochs (kind, task_id, epoch, updated_at) VALUES ('bogus', '', 1, 't1')")).toThrow();
    expect(conn.pluck("SELECT COUNT(*) FROM revocation_epochs WHERE kind = 'task'")).toBe(2);
    conn.run("INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at) VALUES ('root-1', '{}', '{}', 't0')");
    expect(() =>
      conn.run("INSERT INTO budget_snapshots (root_id, limits_json, usage_json, updated_at) VALUES ('root-1', '{}', '{}', 't1')"),
    ).toThrow();
    conn.close();
  });
  it('test_v20261111_session_group_root_folder_backfills_deterministically', () => {
    const conn = memory();
    conn.exec(`CREATE TABLE chat_v2_session_groups (
                 id TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 pinned_resource_ids_json TEXT NOT NULL DEFAULT '[]',
                 deleted_at TEXT
               );
               INSERT INTO chat_v2_session_groups (id, name, pinned_resource_ids_json) VALUES
                 ('g1', 'With Folder', '["res_1","fld_topic_42","fld_other"]'),
                 ('g2', 'No Folder', '["res_1","res_2"]'),
                 ('g3', 'Empty', '[]'),
                 ('g4', 'Malformed', 'not-valid-json'),
                 ('g5', 'ScalarJson', '123');`);
    conn.exec(def('chat_v2', 20261111).sql);
    expect(conn.pluck("SELECT root_folder_id FROM chat_v2_session_groups WHERE id = 'g1'")).toBe('fld_topic_42');
    expect(conn.pluck("SELECT root_folder_id FROM chat_v2_session_groups WHERE id = 'g2'")).toBeNull();
    expect(conn.pluck("SELECT root_folder_id FROM chat_v2_session_groups WHERE id = 'g3'")).toBeNull();
    expect(conn.pluck("SELECT root_folder_id FROM chat_v2_session_groups WHERE id = 'g4'")).toBeNull();
    expect(conn.pluck("SELECT root_folder_id FROM chat_v2_session_groups WHERE id = 'g5'")).toBeNull();
    conn.close();
  });
});

describe('migration/mistakes.rs', () => {
  const set = sets.mistakes;
  it('test_migration_set_structure', () => {
    expect(set.databaseName).toBe('mistakes');
    expect(set.count()).toBeGreaterThanOrEqual(4);
  });
  it('test_v20260130_migration', () => {
    const m = def('mistakes', 20260130);
    expect(m.refineryVersion).toBe(20260130);
    expect(m.name).toBe('init');
    expect(m.idempotent).toBe(true);
    expect(hasColumn(m, 'anki_cards', 'text')).toBe(true);
    expect(m.expectedQueries.some((q) => q.includes('SELECT id, text FROM anki_cards'))).toBe(true);
  });
  it('test_expected_tables_count', () => {
    expect(mistakes.V001_EXPECTED_TABLES.length).toBe(18);
  });
  it('test_expected_indexes_count', () => {
    expect(mistakes.V001_EXPECTED_INDEXES.length).toBe(19);
  });
  it('test_sql_content_not_empty', () => {
    const sql = def('mistakes', 20260130).sql;
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toContain('CREATE TABLE');
  });
  it('test_latest_version', () => {
    expect(set.latestVersion()).toBeGreaterThanOrEqual(20260207);
  });
  it('test_get_migration', () => {
    for (const m of set.migrations) expect(set.get(m.refineryVersion)).toBeDefined();
    expect(set.get(1)).toBeUndefined();
  });
  it('test_recent_sync_migrations_are_registered', () => {
    const check = (v: number, name: string, idem: boolean | undefined) => {
      const m = def('mistakes', v);
      expect(m.name).toBe(name);
      if (idem !== undefined) expect(m.idempotent).toBe(idem);
      return m;
    };
    check(20260523, 'add_missing_sync_coverage', true);
    check(20260524, 'add_change_log_field_deltas', true);
    check(20260705, 'add_document_tasks_source_session_id', true);
    expect(check(20260709, 'flashcard_fsrs', true).expectedTables).toContain('fsrs_card_states');
    expect(hasColumn(check(20260710, 'anki_export_receipt', true), 'anki_cards', 'anki_note_id')).toBe(true);
    const fsrsSync = check(20260711, 'fsrs_sync_coverage', true);
    expect(hasColumn(fsrsSync, 'fsrs_review_logs', 'deleted_at')).toBe(true);
    expect(fsrsSync.sql).toContain('trg_fsrs_cleanup_before_anki_card_delete');
    const undo = check(20260712, 'fsrs_undo_snapshot', true);
    expect(hasColumn(undo, 'fsrs_review_logs', 'state_before_json')).toBe(true);
    expect(undo.expectedIndexes).toContain('idx_fsrs_logs_state_active');
    expect(check(20260713, 'apkg_card_identity', true).sql).toContain("WHEN source_type = 'apkg_import'");
    expect(check(20260714, 'automation_scheduler', true).expectedTables).toContain('automation_runs');
    expect(hasColumn(check(20260720, 'fsrs_mastery_outbox', undefined), 'fsrs_review_logs', 'mastery_synced_at')).toBe(true);
    const sched = check(20260722, 'fsrs_scheduler_hardening', true);
    expect(hasColumn(sched, 'fsrs_card_states', 'leech')).toBe(true);
    expect(hasColumn(sched, 'fsrs_card_states', 'buried_until_ms')).toBe(true);
    const tpl = check(20260723, 'template_user_state', true);
    expect(hasColumn(tpl, 'custom_anki_templates', 'user_modified')).toBe(true);
    expect(hasColumn(tpl, 'custom_anki_templates', 'user_deleted')).toBe(true);
    check(20260724, 'anki_dedup_index_exclude_deleted', true);
    expect(check(20260824, 'normalize_anki_card_optional_json', true).sql).toContain('WHERE extra_fields_json IS NULL');
    expect(hasColumn(check(20261005, 'fsrs_learning_step', true), 'fsrs_card_states', 'learning_step')).toBe(true);
    expect(set.latestVersion()).toBe(20261005);
  });
});

describe('migration/llm_usage.rs', () => {
  const set = sets.llm_usage;
  it('test_migration_set_structure', () => {
    expect(set.databaseName).toBe('llm_usage');
    expect(set.count()).toBe(8);
  });
  it('test_v20260130_migration', () => {
    const m = def('llm_usage', 20260130);
    expect(m.name).toBe('init');
    expect(m.expectedTables.length).toBe(2);
    expect(m.expectedIndexes.length).toBe(17);
    expect(m.idempotent).toBe(true);
  });
  it('test_expected_tables_count', () => {
    expect(llm.V001_EXPECTED_TABLES.length).toBe(llm.LLM_USAGE_TABLE_COUNT);
  });
  it('test_sql_content_not_empty', () => {
    const sql = def('llm_usage', 20260130).sql;
    expect(sql.length).toBeGreaterThan(0);
    expect(sql).toContain('CREATE TABLE');
  });
  it('test_latest_version', () => {
    expect(set.latestVersion()).toBe(20260826);
  });
  it('test_pending_migrations', () => {
    const v = (from: number) => set.pending(from).map((m) => m.refineryVersion);
    expect(v(0).length).toBe(8);
    expect(v(20260130).length).toBe(7);
    expect(v(20260131).length).toBe(6);
    expect(v(20260201).length).toBe(5);
    expect(v(20260202)).toEqual([20260524, 20260525, 20260824, 20260826]);
    expect(v(20260524)).toEqual([20260525, 20260824, 20260826]);
    expect(v(20260525)).toEqual([20260824, 20260826]);
    expect(v(20260824)).toEqual([20260826]);
    expect(v(20260826)).toEqual([]);
  });
});

describe('contract consistency (TS-only)', () => {
  it('a fresh database migrated with every file satisfies every contract', () => {
    for (const n of ALL_MIGRATION_SET_ORDER) {
      const conn = memory();
      for (const m of sets[n].migrations) conn.exec(m.sql);
      for (const m of sets[n].migrations) {
        for (const t of m.expectedTables) {
          expect(conn.pluck("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", [t]), `${n} V${m.refineryVersion} table ${t}`).toBe(1);
        }
      }
      conn.close();
    }
  });
});
