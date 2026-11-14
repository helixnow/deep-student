import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { defineQuery } from '../../../platform/storage/api.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';
import { mergeField } from '../src/field-merge.ts';
import { JsonFloat } from '../api.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { ensureQuarantineTable } from '../repository/quarantine.ts';
import { ensureConflictTable } from '../repository/conflict-resolver.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-internal-i64-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'device' } } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { host, db };
}
it('R4-SYNC-02: max i64 retains adjacent integers and wasMerged', () => {
  expect(mergeField('review_plans', 'total_reviews', 9007199254740993n, 9007199254740992n)).toEqual([9007199254740993n, true, false]);
  expect(mergeField('review_plans', 'total_reviews', -9007199254740993n, -9007199254740994n)).toEqual([-9007199254740993n, true, false]);
  expect(mergeField('review_plans', 'total_reviews', 9223372036854775808n, 7)).toEqual([7, true, false]);
  expect(mergeField('review_plans', 'total_reviews', new JsonFloat(10), 7)).toEqual([7, true, false]);
  expect(mergeField('notes', 'is_favorite', 9223372036854775808n, false)).toEqual([false, false, false]);
  expect(mergeField('notes', 'tags', ['_hits:9007199254740993'], ['_hits:999'])).toEqual([['_hits:9007199254740993'], true, false]);
});
it('R4-SYNC-02: production apply max merge preserves SQLite i64', async () => {
  const { host, db } = await fixture();
  db.exec(`CREATE TABLE review_plans(id TEXT PRIMARY KEY,question_id TEXT,total_reviews INTEGER,updated_at TEXT);
    CREATE UNIQUE INDEX review_plan_question ON review_plans(question_id) WHERE question_id IS NOT NULL;
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER);
    INSERT INTO __change_log VALUES(1,'review_plans','p','UPDATE','2026-01-01',0);`);
  db.run("INSERT INTO review_plans VALUES('p','q',?1,'2026-01-01T00:00:00Z')", [9007199254740993n]);
  const result = host.ctx.sync.applyDownloadedChanges(db, [{ table_name: 'review_plans', record_id: 'p', operation: 'Update', database_name: 'vfs',
    data: { id: 'p', question_id: 'q', total_reviews: 9007199254740992n, updated_at: '2026-01-02T00:00:00Z' }, changed_at: '2026-01-02T00:00:00Z',
  }], { deviceId: 'device' });
  expect(result.failure_count, JSON.stringify(result.failures)).toBe(0);
  expect(db.get(defineQuery<[], { n: bigint }>('SELECT total_reviews AS n FROM review_plans', { options: { safeIntegers: true } }), [])!.n).toBe(9007199254740993n);
});
it('R4-SYNC-02: production echo suppression does not acknowledge an older adjacent i64 log ID', async () => {
  const { host, db } = await fixture();
  db.exec(`CREATE TABLE test_records(id TEXT PRIMARY KEY, content TEXT);
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY AUTOINCREMENT,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER);
    INSERT INTO __change_log VALUES(9007199254740993,'test_records','p','UPDATE','2026-01-01',0);
    CREATE TRIGGER record_echo AFTER INSERT ON test_records BEGIN
      INSERT INTO __change_log(table_name,record_id,operation,changed_at,sync_version)
      VALUES('test_records',NEW.id,'INSERT','2026-01-02',0);
    END;`);
  const result = host.ctx.sync.applyDownloadedChanges(db, [{ table_name: 'test_records', record_id: 'p', operation: 'Insert',
    data: { id: 'p', content: 'remote' }, changed_at: '2026-01-02T00:00:00Z', suppress_change_log: true,
  }], { deviceId: 'device', allowSyncTestFixtureTables: true });
  expect(result.failure_count, JSON.stringify(result.failures)).toBe(0);
  const rows = db.all(defineQuery<[], { id: bigint; sync_version: bigint }>(
    'SELECT id,sync_version FROM __change_log ORDER BY id', { options: { safeIntegers: true } }), []);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ id: 9007199254740993n, sync_version: 0n });
  expect(rows[1]!.id).toBe(9007199254740994n);
  expect(rows[1]!.sync_version).toBeGreaterThan(0n);
});
it('R4-SYNC-02: quarantine and conflict pagination compare IDs before IPC number conversion', async () => {
  const { host, db } = await fixture(); ensureQuarantineTable(db); ensureConflictTable(db);
  for (const [id, label] of [[9007199254740992n, 'lower'], [9007199254740993n, 'higher']] as const) {
    db.run(`INSERT INTO __sync_quarantine(id,source_device_id,source_seq,table_name,record_id,operation,error,first_seen,last_attempt)
      VALUES(?1,'peer',1,'notes',?2,'UPDATE','bad','same','same')`, [id, label]);
    db.run(`INSERT INTO __sync_conflicts(id,table_name,record_id,side,data_json,data_hash,detected_at)
      VALUES(?1,'notes',?2,'cloud','{}',?2,'same')`, [id, label]);
  }
  const quarantined = await host.invoke<Array<{ record_id: string }>>('data_governance_list_quarantine', { limit: 1 });
  expect(quarantined.map(row => row.record_id)).toEqual(['higher']);
  const conflicts = await host.invoke<Array<{ record_id: string }>>('data_governance_list_record_conflicts', { limit: 1 });
  expect(conflicts.map(row => row.record_id)).toEqual(['higher']);
});
it('R4-SYNC-02: retry-all updates each exact quarantine ID instead of the rounded neighbor', async () => {
  const { host, db } = await fixture(); ensureQuarantineTable(db);
  for (const id of [9007199254740992n, 9007199254740993n]) {
    db.run(`INSERT INTO __sync_quarantine(id,source_device_id,source_seq,table_name,record_id,operation,payload_json,payload_hash,error)
      VALUES(?1,'peer',?1,'notes',?2,'UPDATE','{}','bad-hash','bad')`, [id, String(id)]);
  }
  const result = await host.invoke<{ success: number; failed: number; errors: string[] }>('data_governance_retry_all_quarantine');
  expect(result.success).toBe(0); expect(result.failed).toBe(2);
  expect(result.errors[0]).toContain('9007199254740992'); expect(result.errors[1]).toContain('9007199254740993');
  expect(db.all(defineQuery<[], { id: bigint; attempts: bigint }>('SELECT id,attempts FROM __sync_quarantine ORDER BY id', { options: { safeIntegers: true } }), []))
    .toEqual([{ id: 9007199254740992n, attempts: 2n }, { id: 9007199254740993n, attempts: 2n }]);
});

it('R4-SYNC-02/X6-UD-0072: pending metadata stays exact through public enrich and acknowledgement', async () => {
  const { host, db } = await fixture();
  db.exec(`CREATE TABLE test_records(id TEXT PRIMARY KEY,content TEXT);
    INSERT INTO test_records VALUES('lower','local lower'),('higher','local higher');
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY,table_name TEXT,record_id TEXT,operation TEXT,changed_at TEXT,sync_version INTEGER,field_deltas_json TEXT);
    INSERT INTO __change_log VALUES(9007199254740992,'test_records','lower','UPDATE','2026-01-01',0,NULL);
    INSERT INTO __change_log VALUES(9007199254740993,'test_records','higher','UPDATE','2026-01-02',0,'{"counter":9007199254740993,"real":1.0}');`);
  const pending = host.ctx.sync.getPendingChanges(db);
  expect(pending.entries.map(entry => entry.id)).toEqual([9007199254740992n, 9007199254740993n]);
  const filtered = host.ctx.sync.getPendingChanges(db, 'test_records', 2);
  expect(filtered.entries).toEqual(pending.entries);
  const enriched = host.ctx.sync.enrichChangesWithData(db, pending.entries);
  const payload = serializeSyncChange(enriched[1]!);
  expect(payload).toContain('"change_log_id":9007199254740993');
  expect(payload).toContain('"counter":9007199254740993');
  expect(payload).toContain('"real":1.0');
  expect(host.ctx.sync.markSyncedWithTimestamp(db, [pending.entries[1]!.id])).toBe(1);
  expect(host.ctx.sync.getPendingChanges(db).entries.map(entry => entry.record_id)).toEqual(['lower']);
});
