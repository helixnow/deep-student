import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost } from './host-fixture.ts';
import plugin from '../index.ts';
import { parseJsonLossless, stringifyJsonLossless, dbJsonEquals, cloneDbJson, JsonFloat, isJsonObject, sqliteValueToJson, type EngineChange, type DbJson } from '../api.ts';
import * as syncApi from '../api.ts';
import * as losslessJson from '../../../platform/util/lossless-json.ts';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';

it('sync/api.ts re-exports the platform lossless JSON values by identity, and that leaf loads no Node module', () => {
  for (const name of ['JsonFloat', 'isJsonFloat', 'isJsonObject', 'parseJsonLossless', 'stringifyJsonLossless', 'dbJsonEquals', 'cloneDbJson'] as const) {
    expect(syncApi[name], name).toBe(losslessJson[name]);
  }
  expect(syncApi.isJsonFloat(losslessJson.parseJsonLossless('1.0'))).toBe(true);
  const parsed = syncApi.parseJsonLossless('[2.50]');
  expect(Array.isArray(parsed) && losslessJson.isJsonFloat(parsed[0])).toBe(true);
  expect(checkModulesClosure(fileURLToPath(new URL('../../../../', import.meta.url)), ['host/platform/util/lossless-json.ts'])).toEqual([]);
});

it('R4 S03: native source access preserves adjacent integers inside JSON text and nested values', () => {
  let observed: string | undefined;
  JSON.parse('9007199254740993', ((_key: string, value: unknown, context?: { source?: string }) => { observed = context?.source; return value; }) as never);
  expect(observed).toBe('9007199254740993');
  const a = parseJsonLossless('{"props_json":{"nested":[9007199254740992,{"n":9007199254740993}]}}');
  const b = parseJsonLossless('{"props_json":{"nested":[9007199254740993,{"n":9007199254740993}]}}');
  expect(dbJsonEquals(a, b)).toBe(false);
  expect(stringifyJsonLossless(a)).toBe('{"props_json":{"nested":[9007199254740992,{"n":9007199254740993}]}}');
  expect(dbJsonEquals(a, cloneDbJson(a))).toBe(true);
});
it('serde arbitrary_precision retains integer/float and decimal representations', () => {
  expect(dbJsonEquals(parseJsonLossless('1'), parseJsonLossless('1.0'))).toBe(false);
  expect(dbJsonEquals(parseJsonLossless('1.0'), parseJsonLossless('1.00'))).toBe(false);
  expect(dbJsonEquals(parseJsonLossless('0.123456789012345678901'), parseJsonLossless('0.123456789012345678902'))).toBe(false);
  const value = parseJsonLossless('[1E20,1.00,1e9999]');
  expect(stringifyJsonLossless(cloneDbJson(value))).toBe('[1e+20,1.00,1e+9999]');
  expect(dbJsonEquals(parseJsonLossless('1.0'), new JsonFloat(1))).toBe(true);
  expect(dbJsonEquals(sqliteValueToJson('integer', 1n), parseJsonLossless('1'))).toBe(true);
});
it('numeric parsing refuses a runtime that does not provide source access', () => {
  const native = JSON.parse;
  const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => native(text, function (key, value) {
    return reviver ? reviver.call(this, key, value) : value;
  }));
  try { expect(() => parseJsonLossless('{"n":9007199254740993}')).toThrow('JSON.parse source access'); }
  finally { spy.mockRestore(); }
});
it('SQL INTEGER conversion refuses already rounded Number input', () => {
  expect(() => sqliteValueToJson('integer', 9007199254740992)).toThrow('safeIntegers');
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-json-public-')); const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.openFile(join(root, 'records.db'));
  db.exec(`CREATE TABLE test_records(id TEXT PRIMARY KEY, counter INTEGER, actual REAL, props_json TEXT, updated_at TEXT);
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT, sync_version INTEGER DEFAULT 0);`);
  const host = await createTestHost({ plugins: [plugin], provide: { storage, paths: {} } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { db, sync: host.ctx.sync };
}
it('R4 S03: real SQLite INTEGER and REAL retain types through the published record API', async () => {
  const { db, sync } = await fixture();
  db.run("INSERT INTO test_records VALUES('a',?1,1.0,?2,'2026-01-01T00:00:00Z')", [9007199254740992n, '{"n":9007199254740992}']);
  const a = sync.getRecordData(db, 'test_records', 'a', 'id');
  db.run("UPDATE test_records SET counter=?1, props_json=?2 WHERE id='a'", [9007199254740993n, '{"n":9007199254740993}']);
  const b = sync.getRecordData(db, 'test_records', 'a', 'id');
  expect(isJsonObject(a) && a.counter).toBe(9007199254740992n);
  expect(isJsonObject(b) && b.counter).toBe(9007199254740993n);
  expect(isJsonObject(a) && a.actual).toBeInstanceOf(JsonFloat);
  expect(dbJsonEquals(a, b)).toBe(false);
});
it.each(['props_json', 'counter'] as const)('R4 S03: %s differences create distinct cloud conflicts rather than deduplicating', async field => {
  const { db, sync } = await fixture();
  db.run("INSERT INTO test_records VALUES('a',0,1.0,'{}','2026-01-01T00:00:00Z')");
  db.run("INSERT INTO __change_log VALUES(1,'test_records','a','UPDATE','2026-01-01T00:00:00Z',0)");
  for (const integer of ['9007199254740992', '9007199254740993']) {
    const data: Record<string, DbJson> = field === 'props_json' ? { props_json: `{"nested":{"n":${integer}}}` } : { counter: BigInt(integer) };
    const change: EngineChange = { table_name: 'test_records', record_id: 'a', operation: 'Update',
      data: { ...data, id: 'a', updated_at: '2026-01-01T00:00:00Z' }, changed_at: '2026-01-01T00:00:00Z' };
    const result = sync.applyDownloadedChangesWithConflictGuard(db, [change], { deviceId: 'local', allowSyncTestFixtureTables: true }, { policy: 'KeepLocal' });
    expect(result.apply.failure_count).toBe(0);
  }
  expect(db.pluck("SELECT COUNT(*) FROM __sync_conflicts WHERE side='cloud'")).toBe(2);
  expect(db.pluck("SELECT COUNT(DISTINCT data_hash) FROM __sync_conflicts WHERE side='cloud'")).toBe(2);
});
