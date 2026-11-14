/**
 * sync_scenarios_tests.rs:1150-1231, via the production syncSupport plugin.
 * These two scenarios call tombstone helpers directly in Rust; no row-sync
 * engine or business-database migration is part of either scenario.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import files from '../../../platform/files/index.ts';
import notes from '../../notes/index.ts';
import syncSupport from '../../sync-support/index.ts';
import { adaptTombstoneStorage, type BlobTombstoneEntry } from '../../sync-support/api.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import { MemoryStorage } from './memory_storage.ts';

let host: TestHost;
let localStorage: StorageServiceImpl;
const dirs: string[] = [];

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'l23-tombstone-helpers-'));
  dirs.push(root);
  host = await createTestHost({ app: { dataDir: root } });
  localStorage = createStorageService({ baseDir: root, dataLocalDir: root });
  host.ctx.provide('storage', localStorage);
  host.ctx.provide('paths', createPaths({ dataDir: root, platform: host.app.platform, env: { HOME: root } }));
  // Real owners; syncSupport initializes its own state tables. Neither test
  // reads a vfs/chat/mistakes row, so do not migrate chat/mistakes. vfs is
  // migrated only because notes clears its lease tables on startup.
  await localStorage.migrations.migrateSingle('vfs');
  await host.install(vfsRepos);
  await host.install(notes);
  // syncSupport 的 tombstone 本地文件删除走 `ctx.files` 端口（M2 b0fdc876）；生产上由平台 files 插件提供。
  await host.install(files);
  await host.install(syncSupport);
});
afterAll(async () => {
  await host?.dispose();
  localStorage?.dispose();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('sync scenarios: production tombstone helpers', () => {
  it('w39_tombstone_for_nonexistent_blob', async () => {
    // sync_weird_tests.rs:997-1046 calls the owner helper, not a file-sync manager.
    const blobsDir = await mkdtemp(join(tmpdir(), 'l23-w39-'));
    dirs.push(blobsDir);
    const hash = 'ab'.repeat(32);
    const deletedAt = toRfc3339();
    await expect(host.ctx.syncSupport.tombstones.applyBlobTombstones(
      adaptTombstoneStorage(new MemoryStorage()),
      { entries: { [hash]: { deleted_at: deletedAt, device_id: 'd1', size: 0n, relative_path: `ab/${hash}.bin` } }, updated_at: deletedAt },
      blobsDir,
      'blobs',
      true,
    )).resolves.toBeInstanceOf(Array); // Rust: assert!(r.is_ok()).
  });

  it('scenario_35_apply_blob_tombstones_removes_local_file', async () => {
    const blobsDir = await mkdtemp(join(tmpdir(), 'l23-scenario35-'));
    dirs.push(blobsDir);
    const payload = Buffer.from('fake pdf');
    const hash = createHash('sha256').update(payload).digest('hex');
    // Original write_content_addressed_blob helper assertions, :36-40.
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    const relativePath = `${hash.slice(0, 2)}/${hash}.pdf`;
    await mkdir(join(blobsDir, hash.slice(0, 2)), { recursive: true });
    const blobPath = join(blobsDir, relativePath);
    await writeFile(blobPath, payload);
    // Preserve Rust's ordering (file older than deletion). F3/Node mtime can
    // include fractional milliseconds whereas the owner's timestamp parser
    // returns integer milliseconds, so use a whole-second file timestamp.
    const fileTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 1000);
    await utimes(blobPath, fileTime, fileTime);
    expect(existsSync(blobPath)).toBe(true);

    const storage = new MemoryStorage(); // Rust uses MockCloudStorage here too.
    const cloudKey = `data_governance/blobs/${relativePath}`;
    await storage.put(cloudKey, payload);
    const deletedAt = toRfc3339();
    const affected = await host.ctx.syncSupport.tombstones.applyBlobTombstones(
      adaptTombstoneStorage(storage),
      {
        entries: {
          [hash]: { deleted_at: deletedAt, device_id: 'dev_a', size: 8n, relative_path: relativePath },
        },
        updated_at: deletedAt,
      },
      blobsDir,
      'data_governance/blobs',
      true,
    );
    expect(affected).toHaveLength(1);
    expect(existsSync(blobPath)).toBe(false);
    expect(await storage.get(cloudKey)).toBeNull();
  });

  it('scenario_36_tombstone_retained_without_authoritative_snapshot', () => {
    const now = Date.now();
    const entries = new Map<string, BlobTombstoneEntry>([
      ['old', { deleted_at: toRfc3339(BigInt(now - 120 * 86_400_000) * 1_000_000n), device_id: 'd', size: null, relative_path: null }],
      ['fresh', { deleted_at: toRfc3339(BigInt(now) * 1_000_000n), device_id: 'd', size: null, relative_path: null }],
    ]);
    const removed = host.ctx.syncSupport.tombstones.pruneTombstones(entries, 90, entry => entry.deleted_at);
    expect(removed).toBe(0);
    expect(entries.has('fresh')).toBe(true);
    expect(entries.has('old')).toBe(true);
  });
});
