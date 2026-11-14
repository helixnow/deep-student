import './local-runtime-fixture.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { drainDeletionQueue } from '../src/deletion-queues.ts';
import { createPayloadCodec } from '../src/payload.ts';
import type { AsyncTombstoneWriter } from '../src/tombstone-needs.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(['blob', 'asset', 'workspace'] as const)('deletion_queues_never_permanently_abandon_failed_entries: %s', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'sync-queue-')); roots.push(root);
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const db = storage.database(kind === 'workspace' ? 'chat_v2' : 'vfs');
  const idColumn = kind === 'blob' ? 'hash' : kind === 'asset' ? 'key' : 'workspace_id';
  const table = `__${kind}_deletion_queue`;
  db.exec(`CREATE TABLE ${table} (${idColumn} TEXT PRIMARY KEY, relative_path TEXT, size INTEGER, deleted_at TEXT, retry_count INTEGER)`);
  db.run(`INSERT INTO ${table} VALUES ('item', NULL, -1, '2026-01-01T00:00:00Z', 999)`);
  const publish = vi.fn(async () => { throw new Error('offline'); });
  const writer = {
    DEFAULT_TOMBSTONE_RETENTION_DAYS: 90, pruneTombstones: () => 0,
    downloadBlobTombstonesForDevice: async () => ({ entries: {}, updated_at: '' }),
    downloadAssetTombstonesForDevice: async () => ({ entries: {}, updated_at: '' }),
    downloadWorkspaceTombstonesForDevice: async () => ({ entries: {}, updated_at: '' }),
    uploadBlobTombstones: publish, uploadAssetTombstones: publish, uploadWorkspaceTombstones: publish,
  } as unknown as AsyncTombstoneWriter;
  const cloud = { get: async () => Buffer.from('{"format_version":4,"min_client":4}'), listOutcome: async () => ({ files: [], truncated: false }) } as unknown as CloudStorage;
  const codec = await createPayloadCodec(undefined, null);
  const options = { deviceId: 'device', codec, tombstones: writer, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  try {
    await expect(drainDeletionQueue(storage, cloud, kind, options)).rejects.toThrow(`批量传播 ${kind} 删除失败（将重试 1 条）`);
    expect(db.pluck(`SELECT retry_count FROM ${table}`)).toBe(1000);
    expect(publish).toHaveBeenCalledTimes(1);
    publish.mockImplementation(async () => undefined as never);
    expect(await drainDeletionQueue(storage, cloud, kind, options)).toBe(1);
    expect(db.pluck(`SELECT COUNT(*) FROM ${table}`)).toBe(0);
    expect(publish).toHaveBeenCalledTimes(2);
  } finally { codec.dispose(); storage.dispose(); }
});
