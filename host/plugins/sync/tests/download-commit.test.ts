import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import plugin from '../index.ts';
import { createPayloadCodec } from '../api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';

it('download acknowledgement binds the current instance and stops at the first failed cursor without processing legacy keys', async () => {
  const calls: string[] = [];
  const state = { bindInstance: () => calls.push('bind'),
    setCursor: vi.fn((instance: string, device: string, seq: bigint) => { calls.push(`${instance}:${device}:${seq}`); if (device === 'b') throw new Error('busy'); }),
    markLegacyProcessed: vi.fn(),
  };
  const host = await createTestHost({ plugins: [plugin], provide: { storage: {}, paths: {}, syncSupport: { state } } });
  const codec = await createPayloadCodec(undefined, null);
  const storage = { providerName: () => 'memory', instanceBindingHint: () => 'ack',
    get: async (key: string) => key.endsWith('format.json') ? Buffer.from('{"format_version":4,"min_client":4}') : Buffer.from('{"instance_id":"current"}'),
  } as unknown as CloudStorage;
  try {
    const result = { changes: [], decode_failures: [], cursor_advancements: new Map([['a', 9007199254740993n], ['b', 2n]]), legacy_processed_keys: ['legacy'] };
    await expect(host.ctx.sync.commitDownloadProgress(storage, result, { deviceId: 'reader', codec })).rejects.toThrow('busy');
    expect(calls).toEqual(['bind', 'current:a:9007199254740993', 'current:b:2']);
    expect(state.markLegacyProcessed).not.toHaveBeenCalled();
    state.setCursor.mockImplementation(() => undefined);
    await host.ctx.sync.commitDownloadProgress(storage, result, { deviceId: 'reader', codec });
    expect(state.markLegacyProcessed).toHaveBeenCalledWith('current', 'legacy');
  } finally { codec.dispose(); await host.dispose(); }
});

it('DELETE versions survive old change-log cleanup and retain the newest local delete', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-delete-archive-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.openFile(join(root, 'archive.db'));
  const host = await createTestHost({ plugins: [plugin], provide: { storage, paths: {} } });
  try {
    db.exec(`CREATE TABLE __change_log(id INTEGER, table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT, sync_version INTEGER);
      INSERT INTO __change_log VALUES (1,'notes','a','DELETE','2025-02-01T00:00:00Z',1),
      (2,'notes','a','delete','2025-01-01T00:00:00Z',1),(3,'notes','b','UPDATE','2025-01-01T00:00:00Z',1);`);
    host.ctx.sync.prepareDeleteVersionsForCleanup(db, 'local');
    expect(host.ctx.sync.cleanupSyncedChanges(db, '2026-01-01T00:00:00Z')).toBe(3);
    expect(db.all('SELECT table_name,record_id,changed_at,source_device_id FROM __sync_delete_versions')).toEqual([
      { table_name: 'notes', record_id: 'a', changed_at: '2025-02-01T00:00:00Z', source_device_id: 'local' },
    ]);
  } finally { await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true }); }
});
