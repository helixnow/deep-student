import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from './host-fixture.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import backup from '../../backup/index.ts';
import provider from '../../sync-providers/index.ts';
import workspace from '../../agent-workspace/index.ts';
import sync from '../index.ts';
import type { SyncExecutionResponse, UnsyncedItemsReport } from '../api.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

// Test transport only: production WebDAV, backup permit/SSOT, F4 crypto and L20b
// tombstone owner execute normally through the registered kernel commands.
async function fixture(encryptionPassword?: string) {
  const objects = new Map<string, Buffer>();
  const writes: string[] = [];
  const server = createServer(async (request, response) => {
    const path = decodeURI(new URL(request.url!, 'http://localhost').pathname);
    if (request.method === 'MKCOL') { response.writeHead(201).end(); return; }
    if (request.method === 'PUT') {
      if (request.headers['if-none-match'] === '*' && objects.has(path)) { response.writeHead(412).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(path, Buffer.concat(chunks)); writes.push(path); response.writeHead(201).end(); return;
    }
    if (request.method === 'DELETE') { objects.delete(path); response.writeHead(204).end(); return; }
    if (request.method === 'PROPFIND') {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const entries = [...objects].filter(([key]) => key === path || key.startsWith(prefix));
      response.writeHead(207, { 'Content-Type': 'application/xml' });
      const self = objects.has(path) ? '' : `<d:response><d:href>${encodeURI(prefix)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${self}${entries.map(([key, bytes]) =>
        `<d:response><d:href>${encodeURI(key)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${bytes.length}</d:getcontentlength><d:getlastmodified>Wed, 04 Nov 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`);
      return;
    }
    const bytes = objects.get(path);
    if (!bytes) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('missing loopback port');
  const root = mkdtempSync(join(tmpdir(), 'sync-tombstone-ipc-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const config = { provider: 'webdav', webdav: { endpoint: `http://127.0.0.1:${address.port}/dav/`, username: 'user' }, root: 'cloud' };
  const host = await createTestHost({ app: { dataDir: root }, plugins: [backup, provider, workspace, sync], provide: {
    storage, backup: undefined, syncProvider: undefined,
    settings: { get: () => JSON.stringify(config), listByPrefix: () => [] }, paths: { deviceId: async () => 'ipc-device' },
    secrets: { backup: createBackupCrypto(), openStore: () => ({ getCloudCredentials: async () => ({ webdavPassword: 'password', encryptionPassword }) }) },
  } });
  cleanups.push(async () => {
    await host.dispose(); storage.dispose(); rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { host, storage, objects, writes };
}

it('registered deletion commands use the real owner, share the backup permit, and roundtrip tombstone bytes', async () => {
  const { host, objects } = await fixture();
  const args = { cloudConfig: {}, hash: 'a'.repeat(64), relativePath: 'aa/a.bin', size: 42 };
  const held = host.ctx.backup.tryAcquireOperation('backup');
  try {
    await expect(host.invoke('data_governance_mark_blob_deleted', args)).rejects.toBe(
      '[E_DG_TOMBSTONE_LIMITER_BUSY] 另一个数据治理任务（同步/备份/恢复/删除标记）正在进行中，请稍后再试。');
    expect(objects.size).toBe(0);
  } finally { held.release(); }
  await expect(host.invoke('data_governance_mark_blob_deleted', args)).resolves.toBeNull();
  await expect(host.invoke('data_governance_mark_asset_deleted', { cloudConfig: {}, key: 'active/images/a.png', size: 43 })).resolves.toBeNull();
  const blobs = [...objects].filter(([key]) => key.includes('tombstones/blobs/') && key.endsWith('.json'));
  const assets = [...objects].filter(([key]) => key.includes('tombstones/assets/') && key.endsWith('.json'));
  expect(blobs.length).toBeGreaterThan(0); expect(assets.length).toBeGreaterThan(0);
  expect(blobs.some(([, bytes]) => bytes.toString().includes(args.hash))).toBe(true);
  expect(assets.some(([, bytes]) => bytes.toString().includes('active/images/a.png'))).toBe(true);
  const next = host.ctx.backup.tryAcquireOperation('restore'); next.release();
});

it('registered unsynced inspection consumes real tombstones and remains read-only', async () => {
  const { host, writes } = await fixture();
  const report = await host.invoke<UnsyncedItemsReport>('data_governance_list_unsynced_items', { cloudConfig: {} });
  expect(report).toMatchObject({ items: [], itemsTruncated: false, totalUnsynced: 0,
    blobEntriesTotal: 0, assetEntriesTotal: 0, encryptionEnabled: false });
  expect(writes).toEqual([]);
  expect(report.generatedAt).toMatch(/Z$/);
});

it('registered deletion and inspection roundtrip the real asynchronous DSBK tombstone codec', async () => {
  const { host, objects } = await fixture('sync-ipc-encryption-password');
  await host.invoke('data_governance_mark_blob_deleted', { cloudConfig: {}, hash: 'b'.repeat(64), size: 64 });
  const manifest = [...objects].find(([key]) => key.includes('tombstones/blobs/') && key.endsWith('.json'));
  expect(manifest).toBeDefined();
  expect(manifest![1].subarray(0, 4).toString()).toBe('DSBK');
  expect(manifest![1].includes(Buffer.from('b'.repeat(64)))).toBe(false);
  const report = await host.invoke<UnsyncedItemsReport>('data_governance_list_unsynced_items', { cloudConfig: {} });
  expect(report).toMatchObject({ items: [], encryptionEnabled: true });
  const held = host.ctx.backup.tryAcquireOperation('restore'); held.release();
});

it('both registered sync commands execute against real storage, provider, permits and workspace owner', async () => {
  const { host, storage } = await fixture();
  await storage.migrations.runAll();
  for (const command of ['data_governance_run_sync', 'data_governance_run_sync_with_progress']) {
    const result = await host.invoke<SyncExecutionResponse>(command, { direction: 'download' });
    expect(result).toMatchObject({ success: true, direction: 'download', changes_downloaded: 0,
      changes_uploaded: 0, device_id: 'ipc-device', error_message: null });
    const held = host.ctx.backup.tryAcquireOperation('backup'); held.release();
  }
  const events = host.eventsNamed('data-governance-sync-progress');
  expect(events.at(-1)).toMatchObject({ phase: 'completed', outcome: 'succeeded', percent: 100 });
  await expect(host.invoke('data_governance_cancel_sync')).resolves.toBe(false);
});
