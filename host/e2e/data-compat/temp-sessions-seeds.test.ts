// boundary-allow native-import: X3 seed 验收直接读真实 SQLite typeof/原文，并在隔离副本上执行 Rust upsert SQL 验证触发器；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDatabase, cleanup, DATABASES, ROOT, sqlMigrations, tempDir } from './__fixtures__/fixtures.ts';
import { compareDatabaseStates, enumerateDatabases, snapshotDatabase, snapshotDirectory, type Cell, type DirectoryState } from './__fixtures__/database-state.ts';
import { copySeed, createSeed, resolveSeed, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';
import { readTempSessionsSql, TEMP_SESSIONS_SEED_SQL } from './__fixtures__/temp-sessions-seeds.ts';

const NAME = 'l22-temp-sessions-w0';
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const MISTAKES = `${SLOT}/mistakes.db`;
const DBS = [`${SLOT}/browser.db`, `${SLOT}/chat_v2.db`, `${SLOT}/databases/vfs.db`, `${SLOT}/llm_usage.db`, MISTAKES];
// Written out from the L22 SQL by hand (binary string order), independent of the builder.
const TEMP_IDS = ['tmp_bad_blob', 'tmp_bad_created_at', 'tmp_bad_dup_field', 'tmp_bad_empty_obj', 'tmp_bad_lone_surrogate',
  'tmp_bad_negative_usize', 'tmp_bad_not_json', 'tmp_bad_state', 'tmp_bad_usize_overflow', 'tmp_evict_1', 'tmp_evict_2',
  'tmp_evict_3', 'tmp_evict_4', 'tmp_evict_5', 'tmp_evict_6', 'tmp_evict_7', 'tmp_evict_8', 'tmp_evict_9', 'tmp_f32_overflow',
  'tmp_full', 'tmp_min', 'tmp_mismatch_outer', 'tmp_pinned', 'tmp_readonly'];
const TRIGGER_SQL = "CREATE TRIGGER w0_temp_sessions_readonly BEFORE UPDATE ON temp_sessions\nWHEN OLD.temp_id = 'tmp_readonly'\n"
  + "BEGIN SELECT RAISE(ABORT, 'w0 seed: temp_sessions row is read-only'); END";
// dstu-storage/src/database/mod.rs:4177-4183, verbatim.
const UPSERT = `INSERT INTO temp_sessions (temp_id, session_data, stream_state, created_at, updated_at, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(temp_id) DO UPDATE SET
                session_data=excluded.session_data,
                stream_state=excluded.stream_state,
                updated_at=excluded.updated_at,
                last_error=excluded.last_error`;

const BUILD_TIME_COLUMNS = ['slots/slotA/databases/vfs.db#memory_config.updated_at',
  'slots/slotA/databases/vfs.db#vfs_indexing_config.updated_at', 'slots/slotA/mistakes.db#__change_log.changed_at'];
const text = (value: string): Cell => ({ storageClass: 'text', value });
const NULL: Cell = { storageClass: 'null', value: null };
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${path}/`, ...files(directory, path)] : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).filter(f => !f.endsWith('/')).map(f => [f, sha256(join(directory, f))]));
function rowsOf(seed: SeedDirectory, table: string, key: string): Record<string, Record<string, Cell>> {
  return Object.fromEntries(snapshotDatabase(join(seed.directory, MISTAKES)).tables[table]!.rows.map(r => [String(r.values[key]!.value), r.values]));
}

let root: string, catalog: string, source: SeedDirectory, copies: SeedDirectory[], sql: string;
let sourceDigest: Record<string, string>, sourceState: DirectoryState;
beforeAll(() => {
  root = tempDir();
  catalog = join(root, 'catalog');
  sql = execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', TEMP_SESSIONS_SEED_SQL.blob]).toString('utf8');
  source = createSeed(NAME, catalog);
  sourceDigest = digest(source.directory);
  sourceState = snapshotDirectory(source.directory);
  copies = ['A1', 'A2', 'B'].map(side => copySeed(NAME, catalog, join(root, 'run', side)));
}, 120_000);
afterAll(() => { if (root) cleanup(root); });

describe('WP-115 l22-temp-sessions-w0 seed', () => {
  it('consumes the pinned L22 SQL read-only and rejects any other bytes', () => {
    // Independent of the module: git itself resolves the commit path to the pinned blob.
    expect(execFileSync('git', ['-C', ROOT, 'rev-parse', `${TEMP_SESSIONS_SEED_SQL.commit}:${TEMP_SESSIONS_SEED_SQL.path}`]).toString().trim())
      .toBe(TEMP_SESSIONS_SEED_SQL.blob);
    const loaded = readTempSessionsSql();
    expect(loaded.sql).toBe(sql);
    expect(sql.match(/^INSERT INTO temp_sessions\b/gm)).toHaveLength(24);
    expect(sql.match(/^INSERT INTO settings\b/gm)).toHaveLength(2);
    expect(sql.match(/^CREATE TRIGGER\b/gm)).toHaveLength(1);

    const fake = join(root, 'fake-root'), file = join(fake, TEMP_SESSIONS_SEED_SQL.path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, sql);
    expect(readTempSessionsSql(fake)).toEqual({ sql, from: 'worktree' });
    writeFileSync(file, `${sql}\n`);
    expect(() => readTempSessionsSql(fake)).toThrow(`!= pinned ${TEMP_SESSIONS_SEED_SQL.blob}`);
  });

  it('builds once with SQL-constructed provenance and the app-data slot layout', () => {
    expect(resolveSeed(NAME, catalog)).toEqual(source);
    expect(source).toMatchObject({ name: NAME, provenance: 'sql-constructed' });
    expect(readdirSync(source.directory).sort()).toEqual(['app-data', 'local-data']);
    expect(readdirSync(source.dataLocalDir)).toEqual([]);
    expect(enumerateDatabases(source.directory)).toEqual(DBS);
    expect(Object.keys(sourceDigest)).toEqual(DBS);
    for (const copy of copies) {
      expect(copy).toMatchObject({ name: NAME, provenance: 'sql-constructed', dataDir: join(copy.directory, 'app-data'),
        dataLocalDir: join(copy.directory, 'local-data') });
      expect(files(copy.directory)).toEqual(files(source.directory));
      expect(digest(copy.directory)).toEqual(sourceDigest);
    }
    expect(new Set(copies.map(c => c.dataDir)).size).toBe(3);
  });

  it('keeps 24 temp_sessions rows, session_data literals byte-for-byte and the BLOB row', () => {
    for (const seed of [source, ...copies]) {
      const rows = rowsOf(seed, 'temp_sessions', 'temp_id');
      expect(Object.keys(rows).sort()).toEqual(TEMP_IDS);
      for (const [id, row] of Object.entries(rows)) {
        expect(Object.keys(row).sort()).toEqual(['created_at', 'last_error', 'session_data', 'stream_state', 'temp_id', 'updated_at']);
        for (const column of ['temp_id', 'stream_state', 'created_at', 'updated_at']) expect(row[column]!.storageClass, `${id}.${column}`).toBe('text');
        const data = row.session_data!;
        if (id === 'tmp_bad_blob') { expect(data).toEqual({ storageClass: 'blob', value: '7b7d' }); continue; }
        expect(data.storageClass, id).toBe('text');
        // The stored TEXT is exactly the SQL string literal (only '' unescaped); no JSON round-trip.
        expect(sql.includes(`'${data.value!.replaceAll("'", "''")}'`), id).toBe(true);
      }
      const full = rows.tmp_full!.session_data!.value!;
      for (const lexeme of ['"n":0.1000000000000000055511151231257827', '"big":123456789012345678901234567890', '"neg0":-0.0',
        '"exp":1E400', '"tiny":5e-324', '"dup":1,"dup":2', '"size_bytes":18446744073709551615', '"chunk_index":4294967296',
        '"f":1.0e+2', '"y":[1,2.000]', '"score":1e-46', '"timestamp":"2026-01-02T03:04:05.123456789+08:00"',
        '"user_question":"it\'s \\"quoted\\" \\\\ back\\nline \\u0001 \\u2028 中文🙂"']) expect(full, lexeme).toContain(lexeme);
      expect(rows.tmp_bad_usize_overflow!.session_data!.value).toContain('"size_bytes":18446744073709551616');
      expect(rows.tmp_bad_lone_surrogate!.session_data!.value).toContain('"user_question":"\\ud800"');
      expect(rows.tmp_bad_dup_field!.session_data!.value).toContain('"user_question":"a","user_question":"b"');
      expect(rows.tmp_bad_empty_obj!.session_data).toEqual(text('{}'));
      expect(rows.tmp_bad_not_json!.session_data).toEqual(text('not json'));
      expect(rows.tmp_full).toMatchObject({ stream_state: text('completed'), created_at: text('2026-01-01T19:04:05.000000001+00:00'),
        updated_at: text('2026-01-01T19:04:05+00:00'), last_error: text('上一次错误') });
      expect(rows.tmp_min).toMatchObject({ stream_state: text('failed'), created_at: text('2000-01-01T00:00:00Z'), last_error: text('stale column error') });
      expect(rows.tmp_bad_state!.stream_state).toEqual(text('paused'));
      expect(rows.tmp_pinned!.last_error).toEqual(NULL);
      expect(rows.tmp_evict_1!.created_at).toEqual(rows.tmp_evict_2!.created_at);
    }
  });

  it('keeps the two settings rows, the single trigger and exact integer refinery history', () => {
    const migrations = sqlMigrations('mistakes');
    for (const seed of [source, ...copies]) {
      expect(rowsOf(seed, 'settings', 'key')).toEqual({
        'pinned_images:tmp_pinned': { key: text('pinned_images:tmp_pinned'), value: text('["P1","P2"]'), updated_at: text('2026-01-01T00:00:00+00:00') },
        'pinned_images:tmp_readonly': { key: text('pinned_images:tmp_readonly'), value: text('["R"]'), updated_at: text('2026-01-01T00:00:00+00:00') },
      });
      const state = snapshotDatabase(join(seed.directory, MISTAKES));
      expect(state.schema.filter(o => o.type === 'trigger' && ['temp_sessions', 'settings'].includes(o.tbl_name)))
        .toEqual([{ type: 'trigger', name: 'w0_temp_sessions_readonly', tbl_name: 'temp_sessions', sql: TRIGGER_SQL }]);
      expect(state.tables.refinery_schema_history!.rows.map(r => [r.values.version, r.values.name, r.values.checksum]))
        .toEqual(migrations.map(m => [{ storageClass: 'integer', value: String(m.version) }, text(m.name), text(m.checksum)]));
    }
  });

  it('differs from a pristine migration replay only by the L22 rows and trigger', () => {
    const pristine = join(root, 'pristine');
    for (const db of DATABASES) buildDatabase(join(pristine, 'slots/slotA'), db, false, {});
    const reference = snapshotDirectory(pristine);
    const seeded: DirectoryState = { version: 0, databases: Object.fromEntries(Object.entries(sourceState.databases)
      .map(([file, state]) => [file.replace(/^app-data\/com\.deepstudent\.differential\//, ''), state])) };
    const all = compareDatabaseStates(reference, seeded);
    // Migration default rows stamped by SQLite datetime('now') at replay time; two pristine replays differ the same way.
    const buildTime = all.filter(d => d.kind === 'value' && BUILD_TIME_COLUMNS.includes(`${d.db}#${d.table}.${d.column}`));
    for (const d of buildTime) expect((d.after as Cell).storageClass).toBe((d.before as Cell).storageClass);
    const differences = all.filter(d => !buildTime.includes(d));
    expect(differences.map(d => [d.db, d.kind, d.table])).toEqual([
      ['slots/slotA/mistakes.db', 'schema', null],
      ...Array.from({ length: 2 }, () => ['slots/slotA/mistakes.db', 'row', 'settings']),
      ...Array.from({ length: 24 }, () => ['slots/slotA/mistakes.db', 'row', 'temp_sessions']),
    ]);
    expect(differences.slice(1).every(d => d.before === null)).toBe(true);
  });

  it('trigger aborts Rust upsert on tmp_readonly only, in a scratch copy; source and A1/A2/B unchanged', () => {
    const scratch = copySeed(NAME, catalog, join(root, 'scratch'));
    const conn = new Database(join(scratch.directory, MISTAKES));
    try {
      const statement = conn.prepare(UPSERT);
      const upsert = (...values: (string | null)[]) => statement.run(Object.fromEntries(values.map((v, i) => [i + 1, v])));
      const row = (id: string) => conn.prepare('SELECT * FROM temp_sessions WHERE temp_id = ?').get(id);
      const before = row('tmp_readonly');
      expect(() => upsert('tmp_readonly', '{"x":1}', 'in_progress', '2026-01-01T00:00:00+00:00', 'now', null))
        .toThrow('w0 seed: temp_sessions row is read-only');
      expect(row('tmp_readonly')).toEqual(before);
      upsert('tmp_min', '{"y":2}', 'in_progress', '2026-01-01T00:00:00+00:00', 'now', null);
      expect(row('tmp_min')).toEqual({ temp_id: 'tmp_min', session_data: '{"y":2}', stream_state: 'in_progress',
        created_at: '2000-01-01T00:00:00Z', updated_at: 'now', last_error: null });
      upsert('tmp_mismatch_inner', '{}', 'in_progress', '2026-01-01T00:00:00+00:00', 'now', null);
      expect(conn.prepare('SELECT count(*) AS n FROM temp_sessions').get()).toEqual({ n: 25 });
    } finally { conn.close(); }
    expect(digest(source.directory)).toEqual(sourceDigest);
    expect(compareDatabaseStates(sourceState, snapshotDirectory(source.directory))).toEqual([]);
    for (const copy of copies) expect(digest(copy.directory)).toEqual(sourceDigest);
  });
});
