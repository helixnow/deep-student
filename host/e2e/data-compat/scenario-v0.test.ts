// boundary-allow native-import: X3 比对器的真实 SQLite 负对照，只改隔离临时夹具，不写业务或用户数据库。
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanup, I64, JSON_TEXT, tempDir } from './__fixtures__/fixtures.ts';
import { copySeed, createSeed, resolveSeed } from './__fixtures__/scenario-seeds.ts';
import { compareDatabaseDirectories, compareDatabaseStates, enumerateDatabases, snapshotDatabase, snapshotDirectory } from './__fixtures__/database-state.ts';

let root: string, catalog: string;
beforeAll(() => {
  root = tempDir();
  catalog = join(root, 'catalog');
  createSeed('empty', catalog);
  createSeed('historical-wp013-v1', catalog);
}, 60_000);
afterAll(() => cleanup(root));
function pair(name: string, seed = 'historical-wp013-v1') {
  return {
    a: copySeed(seed, catalog, join(root, name, 'A1')),
    b: copySeed(seed, catalog, join(root, name, 'B')),
  };
}
function update(file: string, sql: string, params: unknown[] = []) {
  const db = new Database(file);
  try { if (params.length) db.prepare(sql).run(...params); else db.exec(sql); }
  finally { db.close(); }
}
const SLOT = 'app-data/com.deepstudent.differential/slots/slotA';
const vfs = `${SLOT}/databases/vfs.db`;
const workspace = `${SLOT}/workspaces/ws_ws_old.db`;

it('resolves exact seed names and copies empty into independent app/local roots', () => {
  const { a, b } = pair('empty', 'empty');
  expect(a.provenance).toBe('empty');
  expect(a.dataDir).not.toBe(b.dataDir);
  expect(a.dataLocalDir).not.toBe(b.dataLocalDir);
  expect(compareDatabaseDirectories(a.directory, b.directory)).toEqual({ equal: true,
    before: { version: 0, databases: {} }, after: { version: 0, databases: {} }, differences: [] });
  expect(() => resolveSeed('../historical-wp013-v1', catalog)).toThrow('Unknown scenario seed');
  expect(() => copySeed('empty', join(root, 'missing'), join(root, 'missing-copy'))).toThrow('Seed has not been created');
});

it('copies the same SQL-constructed historical seed byte-for-byte and compares every database/table', () => {
  const { a, b } = pair('identical');
  expect(a.provenance).toBe('sql-constructed');
  const paths = enumerateDatabases(a.directory);
  expect(paths).toEqual([
    `${SLOT}/browser.db`, `${SLOT}/chat_v2.db`,
    `${SLOT}/databases/audit.db`, vfs, `${SLOT}/llm_usage.db`,
    `${SLOT}/mistakes.db`, workspace, 'app-data/deep-student/sync/sync_state.db',
  ]);
  for (const path of paths) expect(readFileSync(join(a.directory, path)).equals(readFileSync(join(b.directory, path))), path).toBe(true);
  const result = compareDatabaseDirectories(a.directory, b.directory);
  expect(result.equal).toBe(true);
  expect(result.differences).toEqual([]);
  expect(result.before.databases[workspace]!.metadata.userVersion).toBe(1);
  expect(result.before.databases[workspace]!.tables.inbox!.rows[0]!.values.id).toEqual({ storageClass: 'integer', value: I64.toString() });
  for (const path of paths) {
    const db = result.before.databases[path]!;
    expect(Object.keys(db.tables).sort()).toEqual(db.schema.filter(o => o.type === 'table').map(o => o.name).sort());
    for (const table of Object.values(db.tables)) for (const row of table.rows) {
      expect(Object.keys(row.values)).toEqual(table.columns.map(c => c.name));
    }
  }
  expect(result.before.databases[workspace]!.tables).toHaveProperty('sqlite_sequence');
});

it('reports precisely db/table/primary key/column for one changed real business value, without mutating A1/A2', () => {
  const { a, b } = pair('business');
  const a2 = copySeed('historical-wp013-v1', catalog, join(root, 'business/A2'));
  const original = snapshotDirectory(a.directory);
  update(join(b.directory, workspace), 'UPDATE document SET title = ? WHERE id = ?', ['改动📚', 'document_old']);
  const result = compareDatabaseDirectories(a.directory, b.directory);
  expect(result.equal).toBe(false);
  expect(result.differences).toEqual([{ kind: 'value', db: workspace, table: 'document',
    key: { kind: 'primary', values: { id: { storageClass: 'text', value: 'document_old' } }, occurrence: 0 }, column: 'title',
    before: { storageClass: 'text', value: '旧文档📚' }, after: { storageClass: 'text', value: '改动📚' } }]);
  expect(result.before).toEqual(original);
  expect(compareDatabaseStates(original, snapshotDirectory(a2.directory))).toEqual([]);
  expect(compareDatabaseStates(original, snapshotDirectory(resolveSeed('historical-wp013-v1', catalog).directory))).toEqual([]);
});

it('retains every real notes UPDATE trigger side effect alongside the precise business-column diff', () => {
  const { a, b } = pair('triggers');
  update(join(b.directory, vfs), 'UPDATE notes SET title = ? WHERE id = ?', ['改动📚', 'note_old']);
  const changes = compareDatabaseDirectories(a.directory, b.directory).differences;
  // V20260131 change-log + V20260724 FTS triggers: one SQL update is not one changed cell.
  expect(changes.filter(c => c.table === 'notes')).toEqual([{ kind: 'value', db: vfs, table: 'notes',
    key: { kind: 'primary', values: { id: { storageClass: 'text', value: 'note_old' } }, occurrence: 0 }, column: 'title',
    before: { storageClass: 'text', value: '中文笔记📚' }, after: { storageClass: 'text', value: '改动📚' } }]);
  expect(changes.map(c => [c.table, c.kind, c.column]).sort()).toEqual([
    ['__change_log', 'row', null], ['notes', 'value', 'title'],
    ['notes_fts_data', 'value', 'block'], ['notes_fts_data', 'value', 'block'],
    ['notes_fts_data', 'row', null], ['notes_fts_data', 'row', null],
    ['notes_fts_docsize', 'value', 'origin'], ['notes_fts_docsize', 'value', 'sz'],
    ['notes_fts_idx', 'row', null], ['sqlite_sequence', 'value', 'seq'],
  ].sort());
});

it('detects a one-unit i64 change above 2^53 and preserves JSON u64 text plus SQL NULL', () => {
  const { a, b } = pair('exact');
  const path = `${SLOT}/databases/audit.db`;
  update(join(b.directory, path), 'UPDATE __audit_log SET duration_ms = ? WHERE id = ?', [I64 + 1n, 'audit_backup']);
  const result = compareDatabaseDirectories(a.directory, b.directory);
  expect(result.differences).toHaveLength(1);
  expect(result.differences[0]).toMatchObject({ db: path, table: '__audit_log', column: 'duration_ms',
    before: { storageClass: 'integer', value: '9007199254740993' }, after: { storageClass: 'integer', value: '9007199254740994' } });
  const rows = result.before.databases[path]!.tables.__audit_log!.rows;
  expect(rows[0]!.values.operation_data!.value).toContain('18446744073709551615');
  expect(rows[0]!.values.details).toEqual({ storageClass: 'text', value: JSON_TEXT });
  expect(rows[1]!.values.details).toEqual({ storageClass: 'text', value: 'null' });
  expect(rows[2]!.values.details).toEqual({ storageClass: 'null', value: null });
  expect(() => JSON.stringify(result)).not.toThrow();
});

it('does not depend on HashMap/object insertion order, while retaining raw JSON TEXT and array order', () => {
  const { a, b } = pair('object-order');
  update(join(a.directory, workspace), 'UPDATE sleep_block SET awaiting_agents = ?', ['[ "worker_old", "other" ]']);
  update(join(b.directory, workspace), 'UPDATE sleep_block SET awaiting_agents = ?', ['[ "other", "worker_old" ]']);
  const before = snapshotDirectory(a.directory), reordered = structuredClone(before);
  reordered.databases = Object.fromEntries(Object.entries(reordered.databases).reverse());
  for (const db of Object.values(reordered.databases)) {
    db.tables = Object.fromEntries(Object.entries(db.tables).reverse());
    for (const table of Object.values(db.tables)) for (const row of table.rows) {
      row.values = Object.fromEntries(Object.entries(row.values).reverse());
      if (row.key.kind === 'primary') row.key.values = Object.fromEntries(Object.entries(row.key.values).reverse());
    }
  }
  expect(compareDatabaseStates(before, reordered)).toEqual([]);
  const differences = compareDatabaseStates(before, snapshotDirectory(b.directory));
  expect(differences).toHaveLength(1);
  expect(differences[0]).toMatchObject({ table: 'sleep_block', column: 'awaiting_agents',
    before: { storageClass: 'text', value: '[ "worker_old", "other" ]' }, after: { storageClass: 'text', value: '[ "other", "worker_old" ]' } });
});

it('enumerates new/missing databases, empty tables, added columns and deleted rows instead of filtering to seed tables', () => {
  const { a, b } = pair('coverage');
  update(join(b.directory, vfs), 'CREATE TABLE new_empty (key TEXT PRIMARY KEY); ALTER TABLE notes ADD COLUMN new_column TEXT; DELETE FROM notes');
  rmSync(join(b.directory, `${SLOT}/browser.db`));
  update(join(b.directory, 'new.sqlite'), 'CREATE TABLE extra (id INTEGER PRIMARY KEY)');
  const changes = compareDatabaseDirectories(a.directory, b.directory).differences;
  expect(changes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'database', db: 'new.sqlite', before: null }),
    expect.objectContaining({ kind: 'database', db: `${SLOT}/browser.db`, after: null }),
    expect.objectContaining({ kind: 'table', db: vfs, table: 'new_empty', before: null }),
    expect.objectContaining({ kind: 'column', db: vfs, table: 'notes', column: 'new_column', before: null }),
    expect.objectContaining({ kind: 'row', db: vfs, table: 'notes', after: null }),
  ]));
});

it('pairs rows by primary key when inserts change row positions and sorts composite/i64 keys exactly', () => {
  const { a, b } = pair('keys', 'empty');
  const ddl = 'CREATE TABLE composite (group_id TEXT, seq INTEGER, value TEXT, PRIMARY KEY(group_id, seq)) WITHOUT ROWID;';
  for (const dir of [a.directory, b.directory]) {
    update(join(dir, 'keys.db'), ddl);
    update(join(dir, 'keys.db'), 'INSERT INTO composite VALUES (?, ?, ?)', ['g', 9007199254740993n, 'second']);
    update(join(dir, 'keys.db'), 'INSERT INTO composite VALUES (?, ?, ?)', ['g', 9n, 'first']);
  }
  update(join(b.directory, 'keys.db'), 'INSERT INTO composite VALUES (?, ?, ?)', ['g', 1n, 'inserted']);
  update(join(b.directory, 'keys.db'), 'UPDATE composite SET value = ? WHERE seq = ?', ['changed', 9007199254740993n]);
  const result = compareDatabaseDirectories(a.directory, b.directory);
  expect(result.before.databases['keys.db']!.tables.composite!.rows.map(r => r.values.seq!.value)).toEqual(['9', '9007199254740993']);
  expect(result.differences).toHaveLength(2);
  expect(result.differences).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'row', before: null }),
    expect.objectContaining({ kind: 'value', column: 'value', key: { kind: 'primary', occurrence: 0,
      values: { group_id: { storageClass: 'text', value: 'g' }, seq: { storageClass: 'integer', value: '9007199254740993' } } } }),
  ]));
});

it('compares storage classes even for numerically equal INTEGER/REAL, with exact BLOB bytes and REAL bits', () => {
  const { a, b } = pair('classes', 'empty');
  for (const dir of [a.directory, b.directory]) update(join(dir, 'types.db'),
    "CREATE TABLE typed (id INTEGER PRIMARY KEY, value, bytes BLOB, fraction REAL); INSERT INTO typed VALUES (1, 1, X'00ff80', 0.125)");
  update(join(b.directory, 'types.db'), 'UPDATE typed SET value = CAST(1 AS REAL), fraction = 0.12500000000000003');
  const result = compareDatabaseDirectories(a.directory, b.directory);
  expect(result.before.databases['types.db']!.tables.typed!.rows[0]!.values.bytes).toEqual({ storageClass: 'blob', value: '00ff80' });
  expect(result.differences).toHaveLength(2);
  expect(result.differences).toContainEqual(expect.objectContaining({ kind: 'storageClass', column: 'value',
    before: { storageClass: 'integer', value: '1' }, after: { storageClass: 'real', value: '3ff0000000000000' } }));
  expect(result.differences).toContainEqual(expect.objectContaining({ kind: 'value', column: 'fraction',
    before: { storageClass: 'real', value: '3fc0000000000000' }, after: { storageClass: 'real', value: '3fc0000000000001' } }));
});

it('compares no-PK rows as a sorted multiset, including duplicate count and generated columns', () => {
  const { a, b } = pair('multiset', 'empty');
  for (const dir of [a.directory, b.directory]) update(join(dir, 'rows.db'),
    'CREATE TABLE rows (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) VIRTUAL)');
  update(join(a.directory, 'rows.db'), 'INSERT INTO rows (value) VALUES (2), (1), (1)');
  update(join(b.directory, 'rows.db'), 'INSERT INTO rows (value) VALUES (1), (2), (1)');
  expect(compareDatabaseDirectories(a.directory, b.directory).equal).toBe(true);
  const state = snapshotDatabase(join(a.directory, 'rows.db')).tables.rows!;
  expect(state.rows.map(r => r.values.doubled!.value)).toEqual(['2', '2', '4']);
  expect(state.columns.find(c => c.name === 'doubled')!.hidden).toBe(2);
  update(join(b.directory, 'rows.db'), 'INSERT INTO rows (value) VALUES (2)');
  expect(compareDatabaseDirectories(a.directory, b.directory).differences).toEqual([
    expect.objectContaining({ kind: 'row', table: 'rows', key: { kind: 'ordinal', index: 3 }, before: null }),
  ]);
});

it('reads committed WAL data without checkpointing and discovers SQLite files without a DB extension', () => {
  const { a } = pair('wal', 'empty');
  mkdirSync(join(a.directory, 'nested'));
  const filename = join(a.directory, 'nested/database');
  const writer = new Database(filename);
  try {
    writer.pragma('journal_mode = WAL');
    writer.exec("CREATE TABLE data (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO data VALUES (1, 'committed')");
    const wal = readFileSync(`${filename}-wal`);
    expect(enumerateDatabases(a.directory)).toEqual(['nested/database']);
    expect(snapshotDirectory(a.directory).databases['nested/database']!.tables.data!.rows[0]!.values.value!.value).toBe('committed');
    expect(readFileSync(`${filename}-wal`)).toEqual(wal);
  } finally { writer.close(); }
});

it('retains unreadable DB evidence and refuses occupied/overlapping seed destinations', () => {
  const { a } = pair('invalid', 'empty');
  writeFileSync(join(a.directory, 'broken.db'), 'not SQLite');
  expect(snapshotDirectory(a.directory).files?.['broken.db']).toEqual({ kind: 'unreadable', size: 10, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(() => copySeed('empty', catalog, a.directory)).toThrow('Seed destination is not empty');
  const source = resolveSeed('empty', catalog);
  expect(() => copySeed('empty', catalog, join(source.directory, 'nested'))).toThrow('overlap');
});
