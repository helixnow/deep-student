// boundary-allow native-import: G3 slot seed 验收在隔离临时目录里重放 Rust 迁移并执行 owner SQL 作对照；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDatabase, cleanup, DATABASES, dbPath, ROOT, tempDir, type FixtureDb } from './__fixtures__/fixtures.ts';
import { compareDatabaseStates, enumerateDatabases, snapshotDirectory, type Cell, type DatabaseDifference } from './__fixtures__/database-state.ts';
import { appDataRoot, copySeed, createSeed, resolveSeed, SEED_NAMES, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';

const APP = 'app-data/com.deepstudent.differential';
const SLOT_DBS = (slot: string) => ['browser.db', 'chat_v2.db', 'databases/vfs.db', 'llm_usage.db', 'mistakes.db'].map(f => `${slot}/${f}`);
// Written at replay time by migrations or triggers (datetime('now')); storage class is still compared.
const BUILD_TIME_COLUMNS = ['databases/vfs.db#memory_config.updated_at', 'databases/vfs.db#vfs_indexing_config.updated_at',
  'mistakes.db#__change_log.changed_at', 'chat_v2.db#__change_log.changed_at', 'llm_usage.db#__change_log.changed_at'];

const OWNER: { name: string; db: FixtureDb; sql: string; rows: Record<string, number> }[] = [
  { name: 'f3-llm-usage-rows-w0', db: 'llm_usage', sql: 'host/platform/storage/equivalence/f3-llm-usage-rows-w0.sql', rows: { llm_usage_logs: 5 } },
  { name: 'l16-pending-memory-w0', db: 'mistakes', sql: 'host/plugins/anki/equivalence/l16-pending-memory-w0.sql', rows: { pending_memory_candidates: 10 } },
  { name: 'wp227-legacy-chat-w0', db: 'mistakes', sql: 'host/plugins/chat-pipeline/equivalence/wp227-legacy-chat-w0.sql', rows: { mistakes: 3, chat_messages: 6 } },
  { name: 'l04-wp226-goal-todo', db: 'chat_v2', sql: 'host/plugins/chat/equivalence/l04-wp226-goal-todo.sql', rows: { chat_v2_goals: 9, chat_v2_todo_lists: 5 } },
];
const LAYOUT = ['f3-inactive-slot-data-w0', 'f3-startup-recovery-incident-w0'];

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [`${path}/`, ...files(directory, path)] : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).filter(f => !f.endsWith('/')).map(f => [f, sha256(join(directory, f))]));
const slotKey = (d: DatabaseDifference) => `${d.db.replace(/^slots\/slot[AB]\//, '')}#${d.table}.${d.column}`;
const meaningful = (differences: DatabaseDifference[]) => differences.filter(d => {
  if (d.kind !== 'value' || !BUILD_TIME_COLUMNS.includes(slotKey(d))) return true;
  expect((d.after as Cell).storageClass, slotKey(d)).toBe((d.before as Cell).storageClass);
  return false;
});
function replay(directory: string, slot: string, dbs: readonly FixtureDb[] = DATABASES) {
  for (const db of dbs) buildDatabase(join(directory, slot), db, false, {});
}
const count = (file: string, table: string) => {
  const conn = new Database(file, { readonly: true });
  try { return (conn.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n; } finally { conn.close(); }
};

let root: string, catalog: string;
const seeds = new Map<string, { source: SeedDirectory; copies: SeedDirectory[] }>();
beforeAll(() => {
  root = tempDir();
  catalog = join(root, 'catalog');
  for (const name of [...OWNER.map(o => o.name), ...LAYOUT]) {
    const source = createSeed(name, catalog);
    seeds.set(name, { source, copies: ['A', 'B'].map(side => copySeed(name, catalog, join(root, 'run', name, side))) });
  }
}, 240_000);
afterAll(() => { if (root) cleanup(root); });

describe('G3 slot seeds', () => {
  it('are registered scenario seeds whose A/B copies are byte-identical, with nothing in the OS local-data dir', () => {
    for (const [name, { source, copies }] of seeds) {
      expect(SEED_NAMES).toContain(name);
      expect(resolveSeed(name, catalog)).toEqual(source);
      expect(source).toMatchObject({ name, provenance: 'sql-constructed' });
      expect(appDataRoot(source)).toBe(join(source.directory, APP));
      expect(readdirSync(source.directory).sort()).toEqual(['app-data', 'local-data']);
      expect(readdirSync(source.dataLocalDir)).toEqual([]);
      for (const copy of copies) expect(digest(copy.directory)).toEqual(digest(source.directory));
    }
  });

  describe.each(OWNER)('$name', ({ name, db, sql, rows }) => {
    it('is the five migration-replayed slotA databases and nothing else under the app root', () => {
      const { source } = seeds.get(name)!;
      expect(readdirSync(source.dataDir)).toEqual(['com.deepstudent.differential']);
      expect(enumerateDatabases(source.directory)).toEqual(SLOT_DBS(`${APP}/slots/slotA`));
      expect(files(appDataRoot(source)).filter(f => !f.endsWith('/'))).toEqual(SLOT_DBS('slots/slotA').sort());
    });

    it('equals a fresh migration replay plus the owner SQL file executed verbatim, only in its owner database', () => {
      const { source } = seeds.get(name)!;
      const pristine = join(root, 'pristine', name), expected = join(root, 'expected', name);
      replay(pristine, 'slots/slotA');
      replay(expected, 'slots/slotA');
      const conn = new Database(dbPath(join(expected, 'slots/slotA'), db));
      try {
        conn.pragma('foreign_keys = ON');
        conn.exec(readFileSync(join(ROOT, sql), 'utf8'));
        expect(conn.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { conn.close(); }
      const seeded = snapshotDirectory(appDataRoot(source));
      expect(meaningful(compareDatabaseStates(snapshotDirectory(expected), seeded))).toEqual([]);
      const added = meaningful(compareDatabaseStates(snapshotDirectory(pristine), seeded));
      expect(added.length).toBeGreaterThan(0);
      expect([...new Set(added.map(d => d.db))]).toEqual([`slots/slotA/${dbPath('', db).replace(/^\//, '')}`]);
      for (const [table, n] of Object.entries(rows)) expect(count(dbPath(join(appDataRoot(source), 'slots/slotA'), db), table), table).toBe(n);
    });
  });

  it('f3-inactive-slot-data-w0: started once on slotA, slotB holds data, state.json as serde_json pretty, legacy migration marked complete', () => {
    const { source } = seeds.get('f3-inactive-slot-data-w0')!;
    const app = appDataRoot(source);
    expect(files(app).filter(f => !f.endsWith('/'))).toEqual(
      [...SLOT_DBS('slots/slotA'), ...SLOT_DBS('slots/slotB'), 'slots/.legacy_migration_complete', 'slots/state.json'].sort());
    expect(readFileSync(join(app, 'slots/state.json'), 'utf8')).toBe('{\n  "active": "slotA",\n  "pending": null\n}');
    expect(readFileSync(join(app, 'slots/.legacy_migration_complete'), 'utf8')).toBe('1');
    const pristine = join(root, 'pristine-inactive');
    replay(pristine, 'slots/slotA');
    replay(pristine, 'slots/slotB');
    expect(meaningful(compareDatabaseStates(snapshotDirectory(pristine), snapshotDirectory(app)))).toEqual([]);
  });

  it('f3-startup-recovery-incident-w0: pre-slot root databases beside non-empty slotA/slotB, no legacy-migration marker', () => {
    const { source } = seeds.get('f3-startup-recovery-incident-w0')!;
    const app = appDataRoot(source);
    const legacy = ['chat_v2.db', 'databases/vfs.db', 'llm_usage.db', 'mistakes.db'];
    expect(files(app).filter(f => !f.endsWith('/'))).toEqual(
      [...legacy, ...SLOT_DBS('slots/slotA'), ...SLOT_DBS('slots/slotB'), 'slots/state.json'].sort());
    // Root names Rust treats as legacy entries (data_space.rs: everything except slots/logs/recovery/.purge_on_next_start).
    expect(readdirSync(app).sort()).toEqual(['chat_v2.db', 'databases', 'llm_usage.db', 'mistakes.db', 'slots']);
    expect(readdirSync(join(app, 'slots')).sort()).toEqual(['slotA', 'slotB', 'state.json']);
    expect(readFileSync(join(app, 'slots/state.json'), 'utf8')).toBe('{\n  "active": "slotA",\n  "pending": null\n}');
    const pristine = join(root, 'pristine-recovery');
    replay(pristine, '', DATABASES.filter(db => db !== 'browser'));
    replay(pristine, 'slots/slotA');
    replay(pristine, 'slots/slotB');
    expect(meaningful(compareDatabaseStates(snapshotDirectory(pristine), snapshotDirectory(app)))).toEqual([]);
  });
});
