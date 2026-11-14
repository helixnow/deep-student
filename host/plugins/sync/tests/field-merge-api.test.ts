import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost } from './host-fixture.ts';
import plugin from '../index.ts';
import { mergeField as internalMergeField } from '../src/field-merge.ts';
import { mergeField, type DbJson, type LearnerProfileMerger, type MergeResult } from '../api.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-field-merge-api-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database('vfs');
  db.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY, tags TEXT, is_favorite INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE __change_log(id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
      operation TEXT NOT NULL, changed_at TEXT NOT NULL DEFAULT (datetime('now')), sync_version INTEGER DEFAULT 0);`);
  const host = await createTestHost({ plugins: [plugin], provide: { storage, paths: { deviceId: async () => 'device-local' } } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { db, sync: host.ctx.sync };
}

it('merge_field: api.ts publishes the production implementation, not a copy', () => {
  expect(mergeField).toBe(internalMergeField);
});

it('merge_field: api.ts import returns the original [value, wasMerged, isConflict] triple', () => {
  const conflict: MergeResult = mergeField('resources', 'ref_count', 5, 3);
  expect(conflict).toEqual([3, false, true]);
  expect(mergeField('notes', 'tags', ['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual([['a', 'b', 'c', 'd'], true, false]);
  expect(mergeField('notes', 'tags', ['a', 'b'], ['a', 'b'])).toEqual([['a', 'b'], false, false]);
  expect(mergeField('notes', 'tags', [], [])).toEqual([[], false, false]);
  expect(mergeField('notes', 'title', undefined, undefined)).toEqual([null, false, false]);
  expect(mergeField('notes', 'title', 'local', undefined)).toEqual(['local', false, false]);
  expect(mergeField('notes', 'title', undefined, 'remote')).toEqual(['remote', false, false]);
});

it('merge_field: optional LearnerProfileMerger is forwarded through the public export', () => {
  const calls: Array<[string, string]> = [];
  const merger: LearnerProfileMerger = {
    mergeProfileJsonForSync: (local, remote) => { calls.push([local, remote]); return '{"merged":true}'; },
  };
  expect(mergeField('resources', 'data', '{"l":1}', '{"r":1}', merger)).toEqual(['{"merged":true}', true, false]);
  expect(calls).toEqual([['{"l":1}', '{"r":1}']]);
  expect(mergeField('resources', 'data', '{"l":1}', '{"r":1}')).toEqual(['{"r":1}', false, true]);
});

it('merge_field: plugin applyDownloadedChanges writes the public mergeField result (index -> apply-batch -> apply-record)', async () => {
  const { db, sync } = await fixture();
  db.run("INSERT INTO notes(id, tags, updated_at) VALUES('n1', '[\"local\",\"shared\"]', '2026-02-09T00:00:00Z')");
  db.run("INSERT INTO __change_log(table_name, record_id, operation, sync_version) VALUES('notes', 'n1', 'UPDATE', 0)");
  const remote: DbJson = ['remote', 'shared'];
  const [expected, wasMerged, isConflict] = mergeField('notes', 'tags', '["local","shared"]', remote);
  expect([wasMerged, isConflict]).toEqual([true, false]);

  const result = sync.applyDownloadedChanges(db, [{
    table_name: 'notes', record_id: 'n1', operation: 'Update', database_name: 'vfs', suppress_change_log: true,
    data: { id: 'n1', tags: remote, updated_at: '2026-02-10T00:00:00Z' }, changed_at: '2026-02-10T00:00:00Z',
  }], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

  expect(result.failure_count, JSON.stringify(result.failures)).toBe(0);
  expect(db.pluck<string>("SELECT tags FROM notes WHERE id='n1'")).toBe(JSON.stringify(expected));
});

it('merge_field: plugin conflict guard folds the public mergeField result (index -> apply-guard)', async () => {
  const { db, sync } = await fixture();
  db.run("INSERT INTO notes(id, tags, is_favorite, updated_at) VALUES('n2', '[\"local\"]', 0, '2026-02-09T00:00:00Z')");
  db.run("INSERT INTO __change_log(table_name, record_id, operation, sync_version) VALUES('notes', 'n2', 'UPDATE', 0)");
  const [expectedTags] = mergeField('notes', 'tags', '["local"]', ['remote']);
  const [expectedFavorite, favoriteMerged] = mergeField('notes', 'is_favorite', 0, 1);
  expect(favoriteMerged).toBe(true);

  const result = sync.applyDownloadedChangesWithConflictGuard(db, [{
    table_name: 'notes', record_id: 'n2', operation: 'Update', database_name: 'vfs', suppress_change_log: true,
    source_device_id: 'device-cloud',
    data: { id: 'n2', tags: ['remote'], is_favorite: 1, updated_at: '2026-02-10T00:00:00Z' }, changed_at: '2026-02-10T00:00:00Z',
  }], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
    policy: 'KeepLatest', cloudDeviceId: 'device-cloud', localDeviceId: 'device-local',
  });

  expect(result.apply.failure_count, JSON.stringify(result.apply.failures)).toBe(0);
  expect(db.pluck<string>("SELECT tags FROM notes WHERE id='n2'")).toBe(JSON.stringify(expectedTags));
  expect(Number(db.pluck<number>("SELECT is_favorite FROM notes WHERE id='n2'"))).toBe(Number(expectedFavorite));
});
