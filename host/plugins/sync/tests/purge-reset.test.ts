import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import sync from '../index.ts';
import startup from '../startup.ts';
import support from '../../sync-support/index.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-purge-reset-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const paths = {
    os: { dataLocal: root },
    deviceId: async () => 'sync-test-owner',
    dataSpaceDeviceId: async () => 'sync-test-owner',
    syncStateDatabase: join(root, 'deep-student', 'sync', 'sync_state.db'),
  };
  const host = await createTestHost({ plugins: [support, startup, sync], provide: { storage, paths, syncSupport: undefined } });
  cleanups.push(async () => { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); });
  const state = host.ctx.syncSupport.state;
  state.bindInstance('instance', 'memory', 'test');
  state.recordDeviceRotation('old', 'device', 'test');
  state.setCursor('instance', 'peer', 9n);
  state.markLegacyProcessed('instance', 'legacy-key');
  state.setTombstoneWatermark('instance', 'peer', 'assets', 7n);
  const seq = state.nextUploadSeq('instance', 'device', 40n);
  state.markPublishedSeq('instance', 'device', seq);
  const event = state.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation', 10n);
  return { host, state, db: storage.database('sync_state'), seq, event };
}
const clearedTables = ['consume_cursor', 'legacy_processed_key', 'tombstone_watermark', 'instance_binding', 'device_history'];
it('X4 W13: public purge reset clears consumed state only, preserving both upload sequence domains', async () => {
  const { host, state, db, seq, event } = await fixture();
  for (const table of clearedTables) expect(db.pluck<number>(`SELECT COUNT(*) FROM ${table}`)).toBeGreaterThan(0);
  await host.ctx.storageStartupSync.resetDefaultAfterLocalPurge();
  for (const table of clearedTables) expect(db.pluck<number>(`SELECT COUNT(*) FROM ${table}`)).toBe(0);
  expect(state.publishedMaxSeq('instance', 'device')).toBe(seq);
  expect(state.nextUploadSeq('instance', 'device', 0n)).toBe(seq + 1n);
  // state.rs:312-331 only computes the candidate; publication at :335 persists it.
  state.markPublishedSeq('instance', 'device', seq + 1n);
  expect(state.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation', 99n)).toBe(event);
  // Same business operation through the sync public API; no second implementation.
  state.setCursor('instance', 'peer', 3n);
  await host.ctx.sync.resetDefaultAfterLocalPurge();
  expect(state.getCursor('instance', 'peer')).toBe(0n);
  expect(state.nextUploadSeq('instance', 'device', 0n)).toBe(seq + 2n);
});
it('X4 W13: state owner reset failure propagates and rolls back every consumed table', async () => {
  const { host, state, db, seq } = await fixture();
  db.exec("CREATE TRIGGER stop_purge BEFORE DELETE ON device_history BEGIN SELECT RAISE(ABORT, 'reset denied'); END;");
  expect(() => host.ctx.storageStartupSync.resetDefaultAfterLocalPurge()).toThrow('清空同步状态表 device_history 失败: reset denied');
  for (const table of clearedTables) expect(db.pluck<number>(`SELECT COUNT(*) FROM ${table}`)).toBeGreaterThan(0);
  expect(state.getCursor('instance', 'peer')).toBe(9n);
  expect(state.publishedMaxSeq('instance', 'device')).toBe(seq);
});
