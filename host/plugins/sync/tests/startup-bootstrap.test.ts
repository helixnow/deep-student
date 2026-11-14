import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import secrets from '../../../platform/secrets/index.ts';
import storage from '../../../platform/storage/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { syncStateDatabasePath } from '../../../platform/storage/node.ts';
import { SYNC_STATE_SCHEMA } from '../repository/state.ts';
import startup from '../startup.ts';

let root: string;
let appDir: string;
let dataLocalDir: string;
let host: Awaited<ReturnType<typeof createTestHost>> | undefined;
const dispose: Array<() => Promise<void>> = [];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-sync-startup-'));
  appDir = path.join(root, 'app');
  dataLocalDir = path.join(root, 'local');
});
afterEach(async () => {
  for (const run of dispose.splice(0)) await run();
  host = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Open the same file through F3's public ad-hoc handle (no direct native driver import). */
function withState<T>(fn: (db: DatabaseHandle) => T): T {
  const service = createStorageService({ baseDir: dataLocalDir, dataLocalDir });
  const db = service.openFile(syncStateDatabasePath(dataLocalDir), { profile: 'plain', label: 'sync-state-test' });
  try {
    return fn(db);
  } finally {
    service.close(db);
    service.dispose();
  }
}

function seedSyncState(options: { populated: boolean; failDeviceHistory?: boolean }): string {
  withState(db => {
    db.exec(SYNC_STATE_SCHEMA);
    if (options.populated) {
      db.exec(`
        INSERT INTO consume_cursor VALUES ('default', 'peer', 9, 'now');
        INSERT INTO legacy_processed_key VALUES ('default', 'legacy-key', 'now');
        INSERT INTO tombstone_watermark VALUES ('default', 'peer', 'assets', 7, 'now');
        INSERT INTO instance_binding VALUES ('default', 'memory', 'test', 'now');
        INSERT INTO device_history VALUES ('old', 'device', 'now', 'test');
        INSERT INTO upload_seq VALUES ('default', 'device', 41, 'now');
      `);
    }
    if (options.failDeviceHistory === true) {
      db.exec("CREATE TRIGGER stop_purge BEFORE DELETE ON device_history BEGIN SELECT RAISE(ABORT, 'reset denied'); END;");
    }
  });
  return syncStateDatabasePath(dataLocalDir);
}

function paths() {
  return {
    os: { home: root, data: dataLocalDir, dataLocal: dataLocalDir, config: root, cache: root, temp: root, download: null },
    syncStateDatabase: syncStateDatabasePath(dataLocalDir),
    deviceId: async () => 'device',
    dataSpaceDeviceId: async () => 'device',
  };
}

async function startStorage(): Promise<void> {
  host = await createTestHost({
    app: { dataDir: appDir },
    plugins: [secrets, startup, [storage, { dataLocalDir }]],
    provide: {
      paths: paths(),
      log: { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    },
    shell: () => null,
  });
  dispose.push(async () => { await host?.dispose(); });
}

it('pre-storage provider injects only paths and runs before storage publishes', () => {
  expect(startup.meta.provides).toContain('storageStartupSync');
  expect(startup.inject).toEqual(['paths']);
});

it('purge clears consumed sync state before storage opens while preserving upload_seq', async () => {
  fs.mkdirSync(path.join(appDir, 'slots/slotA'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'slots/slotA/mistakes.db'), 'stale-database');
  fs.writeFileSync(path.join(appDir, '.purge_on_next_start'), '1');
  seedSyncState({ populated: true });

  await startStorage();

  expect(fs.existsSync(path.join(appDir, '.purge_on_next_start'))).toBe(false);
  expect(host!.ctx.storageStartupSync).toBeDefined();
  expect(host!.ctx.storage.database('mistakes')).toBeDefined();

  withState(db => {
    for (const table of ['consume_cursor', 'legacy_processed_key', 'tombstone_watermark', 'instance_binding', 'device_history']) {
      expect(Number(db.pluck<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0)).toBe(0);
    }
    expect(Number(db.pluck<number>('SELECT last_seq FROM upload_seq') ?? 0)).toBe(41);
  });
});

it('reset failure keeps the purge marker, rolls back state and blocks business databases', async () => {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '.purge_on_next_start'), '1');
  seedSyncState({ populated: true, failDeviceHistory: true });

  await startStorage();

  expect(fs.existsSync(path.join(appDir, '.purge_on_next_start'))).toBe(true);
  expect(() => host!.ctx.storage.database('vfs')).toThrow('业务数据库保持关闭');

  withState(db => {
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM consume_cursor') ?? 0)).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM device_history') ?? 0)).toBe(1);
  });
});
