import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import notes from '../../notes/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { plainCodec, type AssetTombstones } from '../api.ts';
import { SqliteSyncStateStore } from '../src/state.ts';
import { MemoryStorage } from './memory-storage.ts';
import { migratedVfsTemplate } from './service-host.ts';

const SYNC_STATE_TABLES = [
  'consume_cursor', 'device_history', 'instance_binding', 'legacy_processed_key',
  'tombstone_event_publish', 'tombstone_watermark', 'upload_seq',
];

it('X7 G2: installed sync-support opens <dataLocal>/deep-student/sync/sync_state.db only on first state read/write', async () => {
  const dataLocal = mkdtempSync(join(tmpdir(), 'sync-support-lazy-state-'));
  const storage = createStorageService({ baseDir: dataLocal, dataLocalDir: dataLocal });
  const host = await createTestHost({
    provide: {
      storage,
      paths: { deviceId: async () => 'lazy-state', dataSpaceDeviceId: async () => 'lazy-state' },
    },
  });
  try {
    const vfs = storage.pathOf('vfs');
    mkdirSync(dirname(vfs), { recursive: true });
    copyFileSync(migratedVfsTemplate, vfs);
    const file = join(dataLocal, 'deep-student', 'sync', 'sync_state.db');
    expect(storage.pathOf('sync_state')).toBe(file);

    await host.install(vfsRepos, notes, plugin);
    const service = host.ctx.syncSupport;
    expect(service.state).toBeDefined();
    expect(existsSync(file)).toBe(false);

    // Production consumer path: tombstone upload reserves an event seq in sync_state.
    const cloud = new MemoryStorage();
    const manifest: AssetTombstones = {
      entries: { 'active/images/lazy.png': { deleted_at: '2026-11-06T00:00:00Z', device_id: 'lazy-state', size: 3 } },
      updated_at: '',
    };
    await service.tombstones.uploadAssetTombstones(cloud, plainCodec, 'lazy-state', manifest);
    expect(existsSync(file)).toBe(true);

    const db = storage.database('sync_state');
    expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map(row => row.name)).toEqual(SYNC_STATE_TABLES);
    expect(db.pluck<number>('SELECT COUNT(*) FROM tombstone_event_publish')).toBe(1);
  } finally {
    try { await host.dispose(); }
    finally {
      storage.dispose();
      rmSync(dataLocal, { recursive: true, force: true });
    }
  }
});

it('lazy open failure maps to open_default context and retries on the next call', () => {
  let attempts = 0;
  const db = new SqliteDatabase({ name: 'sync_state', path: ':memory:', profile: {} });
  try {
    const store = new SqliteSyncStateStore(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('unable to open database file');
      return db;
    });
    expect(attempts).toBe(0);
    expect(() => store.getCursor('i', 'd')).toThrow('Database error: 打开 sync_state.db 失败: unable to open database file');
    store.setCursor('i', 'd', 4n);
    expect(store.getCursor('i', 'd')).toBe(4n);
    expect(attempts).toBe(2);
  } finally { db.close(); }
});
