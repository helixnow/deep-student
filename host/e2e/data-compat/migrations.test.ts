import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageService } from '../../platform/storage/service.ts';
import { Connection } from '../../platform/storage/connection.ts';
import { loadSqlMigrations, Runner } from '../../platform/storage/migration/refinery.ts';
import { CHAT_V2_MIGRATIONS } from '../../platform/storage/migration/definitions/chat_v2.ts';
import { LLM_USAGE_MIGRATIONS } from '../../platform/storage/migration/definitions/llm_usage.ts';
import { MISTAKES_MIGRATIONS_LIST } from '../../platform/storage/migration/definitions/mistakes.ts';
import { VFS_MIGRATIONS } from '../../platform/storage/migration/definitions/vfs.ts';
import {
  APPLIED_ON, DATABASES, MIGRATIONS, ROOT, buildSlot, cleanup, dbPath, history, rawHistory, rawSnapshot,
  snapshot, sqlMigrations, tempDir,
} from './__fixtures__/fixtures.ts';

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0).reverse()) dispose(); });
function fixture(omitLast = false) {
  const base = tempDir();
  disposers.push(() => cleanup(base));
  const active = buildSlot(base, 'slotA', omitLast);
  writeFileSync(join(base, 'slots/state.json'), '{"active":"slotA","pending":null}');
  const storage = createStorageService({ baseDir: base, dataLocalDir: join(base, 'local') });
  disposers.push(() => storage.dispose());
  return { base, active, storage };
}

it('checksums match existing Rust-produced gold rows, independently of fixture execution', () => {
  const gold = JSON.parse(readFileSync(join(ROOT, 'host/platform/storage/migration/__fixtures__/rust-refinery-checksums.json'), 'utf8'));
  let compared = 0;
  for (const [db, rows] of Object.entries(gold.databases)) {
    const migrations = sqlMigrations(db as typeof DATABASES[number]);
    for (const row of rows as Array<{version: number; name: string; checksum: string}>) {
      const migration = migrations.find(m => m.version === row.version)!;
      expect(migration, `${db}/${row.version}`).toBeDefined();
      expect({ name: migration.name, checksum: migration.checksum }).toEqual({ name: row.name, checksum: row.checksum });
      compared++;
    }
  }
  expect(compared).toBe(129);
});

it('fixture file order is numeric and covers the Host MigrationDefSpec registrations', () => {
  const specs = { vfs: VFS_MIGRATIONS, chat_v2: CHAT_V2_MIGRATIONS, mistakes: MISTAKES_MIGRATIONS_LIST, llm_usage: LLM_USAGE_MIGRATIONS };
  for (const db of DATABASES) {
    const migrations = sqlMigrations(db);
    expect(new Set(migrations.map(m => m.version)).size).toBe(migrations.length);
    if (db === 'browser') continue; // standalone migration directory, no coordinator MigrationDefSpec.
    const registered = specs[db].map(spec => spec.file.split('/').pop()!);
    expect([...registered].sort(), db).toEqual(migrations.map(m => m.file).sort());
  }
});

it('strict refinery validation rejects a changed stored checksum (negative control before coordinator repair)', () => {
  const { active } = fixture();
  const conn = new Connection(dbPath(active, 'vfs'), { label: 'vfs', profile: {}, mustExist: true });
  try {
    conn.run('UPDATE refinery_schema_history SET checksum = ? WHERE version = ?', ['1', sqlMigrations('vfs')[0]!.version]);
    expect(() => new Runner(loadSqlMigrations(join(MIGRATIONS, 'vfs'))).run(conn)).toThrowError(/different than filesystem one/);
  } finally { conn.close(); }
});

describe('Rust SQL head → Host (no already-applied SQL may run)', () => {
  it('opens all five populated databases, validates checksums, and preserves every column and history row twice', async () => {
    const { active, storage } = fixture();
    const before = Object.fromEntries(DATABASES.map(db => [db, rawSnapshot(active, db)]));
    const histories = Object.fromEntries(DATABASES.map(db => [db, rawHistory(active, db)]));
    // Strict refinery validation BEFORE coordinator checksum repair can hide a mismatch.
    for (const db of DATABASES) {
      const conn = new Connection(dbPath(active, db), { label: db, profile: { foreignKeys: true }, mustExist: true });
      try { expect(new Runner(loadSqlMigrations(join(MIGRATIONS, db))).run(conn)).toEqual([]); }
      finally { conn.close(); }
    }
    for (let open = 0; open < 2; open++) {
      const report = await storage.migrations.runAll();
      expect(report.success, JSON.stringify(report)).toBe(true);
      expect(report.databases.map(r => r.appliedCount)).toEqual([0, 0, 0, 0]);
      for (const db of DATABASES) {
        const handle = storage.database(db);
        expect(snapshot(handle, db), `${db} data`).toEqual(before[db]);
        expect(history(handle), `${db} history`).toEqual(histories[db]);
        expect(handle.all('PRAGMA foreign_key_check'), db).toEqual([]);
        expect(handle.pluck('PRAGMA integrity_check'), db).toBe('ok');
      }
      storage.dispose(); // second pass really reopens files/connections.
    }
  });
});

it('previous migration head → Host appends exactly one migration per core database, then is idempotent', async () => {
  const { active, storage } = fixture(true);
  const histories = Object.fromEntries(DATABASES.map(db => [db, rawHistory(active, db)]));
  const before = Object.fromEntries(DATABASES.map(db => [db, rawSnapshot(active, db)]));
  const report = await storage.migrations.runAll();
  expect(report.success, JSON.stringify(report)).toBe(true);
  expect(report.databases.map(r => r.appliedCount)).toEqual([1, 1, 1, 1]);
  for (const db of DATABASES) {
    const handle = storage.database(db);
    const rows = history(handle);
    expect(rows.filter(r => r.applied_on === APPLIED_ON), db).toEqual(histories[db]);
    expect(rows.map(({ version, name, checksum }) => ({ version, name, checksum })), db).toEqual(
      sqlMigrations(db).map(({ version, name, checksum }) => ({ version, name, checksum })),
    );
    // New columns are allowed; ALL old columns and values must survive.
    const after = snapshot(handle, db);
    for (const [table, oldRows] of Object.entries(before[db]!)) {
      expect(after[table], `${db}.${table} row count`).toHaveLength(oldRows.length);
      for (const [i, row] of oldRows.entries()) expect(after[table]![i], `${db}.${table}[${i}]`).toMatchObject(row as object);
    }
  }
  storage.dispose();
  const again = await storage.migrations.runAll();
  expect(again.success, JSON.stringify(again)).toBe(true);
  expect(again.databases.map(r => r.appliedCount)).toEqual([0, 0, 0, 0]);
});
