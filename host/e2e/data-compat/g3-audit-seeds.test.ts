// boundary-allow native-import: L21 审计种子验收只读隔离临时目录里的夹具库；不写业务或用户数据库。
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir, type SeedRow } from './__fixtures__/fixtures.ts';
import { readProvenance } from './__fixtures__/a-produced-seeds.ts';
import { AUDIT_DB, AUDIT_SEED_NAMES, AUDIT_STATUSES, AUDIT_TYPES, auditShapeMismatches, CORRUPT_OPERATION_TYPES, FUTURE_ROWS,
  ROWS_PER_COMBINATION, TIED_ROWS } from './__fixtures__/audit-seeds.ts';
import { snapshotDirectory } from './__fixtures__/database-state.ts';
import { seedFingerprintDifferences, timedBuild, type TimedBuild } from './__fixtures__/seed-determinism.ts';
import { appDataRoot, copySeed, createSeed, resolveSeed, SEED_NAMES, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(directory, path) : [path];
  }).sort();
}
const digest = (directory: string) => Object.fromEntries(files(directory).map(f => [f, sha256(readFileSync(join(directory, f)))]));

let root: string;
const seeds = new Map<string, SeedDirectory>();
const builds = new Map<string, TimedBuild>();
function rows(name: string): SeedRow[] {
  const db = new Database(join(appDataRoot(seeds.get(name)!), 'slots/slotA', AUDIT_DB), { readonly: true });
  try { return db.prepare('SELECT * FROM __audit_log ORDER BY timestamp DESC, id').all() as SeedRow[]; } finally { db.close(); }
}
beforeAll(() => {
  root = tempDir();
  for (const name of AUDIT_SEED_NAMES) {
    builds.set(name, timedBuild(() => { const seed = createSeed(name, join(root, 'catalog')); seeds.set(name, seed); return seed.directory; }));
  }
}, 240_000);
afterAll(() => { if (root) cleanup(root); });

describe('L21 audit seeds', () => {
  it('are registered, rebuild to the same G3 fingerprint (audit.db byte-identical), copy byte-identically, and snapshot as SQLite', async () => {
    await new Promise(resolve => { setTimeout(resolve, 1_100); });
    for (const [name, source] of seeds) {
      expect(SEED_NAMES).toContain(name);
      expect(resolveSeed(name, join(root, 'catalog'))).toEqual(source);
      expect(source.provenance).toBe('sql-constructed');
      const again = timedBuild(() => createSeed(name, join(root, 'again')).directory);
      expect(seedFingerprintDifferences(builds.get(name)!, again)).toEqual([]);
      const audit = `app-data/com.deepstudent.differential/slots/slotA/${AUDIT_DB}`;
      expect(digest(again.directory)[audit]).toBe(digest(source.directory)[audit]);
      expect(digest(copySeed(name, join(root, 'catalog'), join(root, 'copy', name)).directory)).toEqual(digest(source.directory));
      expect(Object.keys(snapshotDirectory(appDataRoot(source)).databases)).toContain(`slots/slotA/${AUDIT_DB}`);
    }
  });

  it('history: 8 rows per type x status, Rust serde operation_data, 16 future rows and one timestamp tie', () => {
    const history = rows('l21-audit-history-v1');
    expect(history).toHaveLength(AUDIT_TYPES.length * AUDIT_STATUSES.length * ROWS_PER_COMBINATION);
    for (const type of AUDIT_TYPES) for (const status of AUDIT_STATUSES) {
      expect(history.filter(r => r.operation_type === type && r.status === status), `${type}/${status}`).toHaveLength(ROWS_PER_COMBINATION);
    }
    for (const row of history) {
      expect(JSON.parse(row.operation_data as string).type).toBe(row.operation_type);
      expect(row.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+00:00$/);
      if (row.details !== null) JSON.parse(row.details as string);
      expect(row.duration_ms === null || (row.duration_ms as number) >= 0).toBe(true);
    }
    expect(history.filter(r => (r.timestamp as string) > '2099')).toHaveLength(FUTURE_ROWS);
    expect(history.filter(r => (r.timestamp as string) < '2026')).toHaveLength(history.length - FUTURE_ROWS);
    const tied = history.filter(r => (TIED_ROWS as readonly unknown[]).includes(r.id));
    expect(tied).toHaveLength(2);
    expect(tied[0]!.timestamp).toBe(tied[1]!.timestamp);
    expect(new Set(history.map(r => r.timestamp)).size).toBe(history.length - 1);
    // ORDER BY timestamp (TEXT) is chronological because every row uses the same to_rfc3339 shape.
    const instants = history.map(r => Date.parse(r.timestamp as string));
    expect(instants).toEqual([...instants].sort((a, b) => b - a));
  });

  it('corrupt rows: history plus one row per row_to_audit_log failure branch', () => {
    const corrupt = rows('l21-audit-corrupt-rows-v1');
    const history = rows('l21-audit-history-v1');
    expect(corrupt.filter(r => !(CORRUPT_OPERATION_TYPES as readonly unknown[]).includes(r.operation_type))).toEqual(history);
    const byType = Object.fromEntries(corrupt.filter(r => (CORRUPT_OPERATION_TYPES as readonly unknown[]).includes(r.operation_type))
      .map(r => [r.operation_type, r]));
    expect(Object.keys(byType).sort()).toEqual([...CORRUPT_OPERATION_TYPES].sort());
    expect(byType.CorruptTimestamp!.timestamp).toBe('2025/12/31 00:00:00');
    expect(() => JSON.parse(byType.CorruptOperationData!.operation_data as string)).toThrow();
    expect(byType.NegativeDuration!.duration_ms).toBe(-1);
    expect(() => JSON.parse(byType.CorruptDetails!.details as string)).toThrow();
    expect(byType.UnknownStatus!.status).toBe('Weird');
  });

  it('encoding check flags rows that A would encode differently', () => {
    const row = { status: 'Completed', details: 'null', timestamp: '2026-11-07T03:01:36.848481445+00:00' };
    expect(auditShapeMismatches([{ ...row, operation_type: 'Backup', operation_data: '{"type":"Backup","backup_type":"Full","file_count":5,"total_size":4169728}' },
      { ...row, operation_type: 'Migration', operation_data: '{"type":"Migration","from_version":0,"to_version":20261027,"applied_count":71}' }])).toEqual([]);
    expect(auditShapeMismatches([{ ...row, operation_type: 'Backup', operation_data: '{"type":"Backup","file_count":5,"backup_type":"Full","total_size":1}' },
      { ...row, operation_type: 'Restore', operation_data: '{"type":"Restore","backup_path":"x"}', timestamp: '2026-11-07T03:01:36Z', status: 'Done' },
      { ...row, operation_type: 'Other', operation_data: '{}', details: 'not json' }])).toEqual([
      'Backup/Completed: operation_data type:string,file_count:number,backup_type:string,total_size:number vs type:string,backup_type:string,file_count:number,total_size:number',
      'Restore/Done: timestamp 2026-11-07T03:01:36Z', 'Restore/Done: status', 'Other/Completed: details not JSON', 'Other/Completed: operation_type not constructed']);
  });

  it.skipIf(!readProvenance()?.a)('constructed encoding matches the audit rows A wrote in the a-produced run', () => {
    expect(readProvenance()!.audit!.rows.length).toBeGreaterThan(0);
    expect(readProvenance()!.audit!.mismatches).toEqual([]);
  });
});
