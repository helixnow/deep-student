import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { defineQuery, type SqlExecutor } from '../../../platform/storage/api.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';
import { listQuarantineIds, listQuarantineRows, listUnresolvedConflictRows } from '../repository/conflicts.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-query-decode-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
});
afterEach(() => { storage.dispose(); rmSync(root, { recursive: true, force: true }); });

it('R4-SYNC-04: quarantine rejects a bad typed row while conflict list flattens it', async () => {
  const db = storage.database('vfs');
  db.exec(`CREATE TABLE __sync_quarantine(id, source_device_id, source_seq, table_name, record_id, operation,
    payload_json, error, attempts, first_seen, last_attempt);
    INSERT INTO __sync_quarantine VALUES(1,'peer','bad seq','notes','n','UPDATE',NULL,'err',1,'now','now');
    CREATE TABLE __sync_conflicts(id, table_name, record_id, side, data_json, winning_device_id,
      losing_device_id, detected_at, resolved_at, resolution);
    INSERT INTO __sync_conflicts VALUES(1,'notes','ok','local','{}',NULL,NULL,'now',NULL,NULL);
    INSERT INTO __sync_conflicts VALUES(2,'notes','bad','cloud',X'01',NULL,NULL,'now',NULL,NULL);
    INSERT INTO __sync_conflicts VALUES(3,'notes','later','cloud','{}',NULL,NULL,'now',NULL,NULL);`);
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'd' } } });
  try {
    await expect(host.invoke('data_governance_list_quarantine')).rejects.toBe(
      '读取隔离记录失败: Invalid column type Text at index: 2, name: source_seq');
    const rows = await host.invoke<Array<{ record_id: string }>>('data_governance_list_record_conflicts');
    expect(rows.map(row => row.record_id)).toEqual(['later', 'ok']);
  } finally { await host.dispose(); }
});

it('R4-SYNC-04: malformed tables fail in prepare with the original command prefixes', async () => {
  storage.database('vfs').exec('CREATE TABLE __sync_quarantine(other); CREATE TABLE __sync_conflicts(other);');
  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'd' } } });
  try {
    await expect(host.invoke('data_governance_list_quarantine')).rejects.toBe('准备隔离区查询失败: no such column: id');
    await expect(host.invoke('data_governance_list_record_conflicts')).rejects.toBe('准备冲突查询失败: no such column: id');
    await expect(host.invoke('data_governance_retry_all_quarantine')).rejects.toBe('准备批量查询失败: no such column: id');
  } finally { await host.dispose(); }
});

it('R4-SYNC-04: retry-all filters malformed IDs before attempting valid exact IDs', () => {
  const db = storage.database('vfs');
  db.exec("CREATE TABLE __sync_quarantine(id); INSERT INTO __sync_quarantine VALUES(1),(1.5),('bad'),(9007199254740993),(NULL);");
  expect(listQuarantineIds(db)).toEqual([1n, 9007199254740993n]);
});

// Project deliberate SQL faults through the real F3 executor. No fabricated phase/errors:
// SQLite abs(i64::MIN) fails at step, while extra parameters fail at binding.
function faultExecutor(sql: string, params: [] | [number] = []): SqlExecutor {
  const db = storage.database('vfs');
  return new Proxy(db, { get(target, property) {
    if (property === 'iterate') return () => target.iterate(defineQuery<number[], Record<string, unknown>>(sql, { options: { safeIntegers: true } }), params);
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

it('R4-SYNC-04: first-step SQL errors are reads, not query/prepare failures', () => {
  const db = faultExecutor('SELECT abs(-9223372036854775808) AS id');
  expect(() => listQuarantineRows(db)).toThrow('读取隔离记录失败: integer overflow');
  expect(listUnresolvedConflictRows(db)).toEqual([]);
  expect(listQuarantineIds(db)).toEqual([]);
});

it('R4-SYNC-04: flatten keeps earlier rows when a later SQL step fails', () => {
  expect(listQuarantineIds(faultExecutor('SELECT 9007199254740993 AS id UNION ALL SELECT abs(-9223372036854775808)')))
    .toEqual([9007199254740993n]);
});

it('R4-SYNC-04: actual F3 binding failures use query-map prefixes', () => {
  const db = faultExecutor('SELECT 1 AS id', [1]);
  expect(() => listQuarantineRows(db)).toThrow(/^执行隔离区查询失败:/);
  expect(() => listUnresolvedConflictRows(db)).toThrow(/^执行冲突查询失败:/);
  expect(() => listQuarantineIds(db)).toThrow(/^执行批量查询失败:/);
});
