import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

function settings() {
  return { get: () => null, save: () => undefined };
}

const testPaths = { appDataDir: process.cwd() };

function database(
  dir: string,
  query: (sql: string) => string | null | undefined,
): VfsDatabase {
  return {
    getConnSafe: () => ({ pluck: (sql: string) => query(sql) }) as unknown as SqlExecutor,
    blobsDir: () => dir,
  } as unknown as VfsDatabase;
}

function failingDatabase(detail: string): VfsDatabase {
  return {
    getConnSafe: () => { throw new Error(detail); },
    blobsDir: () => '/nonexistent',
  } as unknown as VfsDatabase;
}

it('vfs_get_file_blob_path returns the on-disk blob for a files row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-vfs-blob-'));
  const blobsDir = join(dir, 'vfs_blobs');
  mkdirSync(join(blobsDir, 'ab'), { recursive: true });
  writeFileSync(join(blobsDir, 'ab', 'abcdef.pdf'), 'pdf');
  const vfsDatabase = database(blobsDir, sql =>
    sql.includes('FROM files') ? 'abcdef' : 'ab/abcdef.pdf');
  const host = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase } });
  try {
    expect(await host.invoke('vfs_get_file_blob_path', { id: 'file-1' }))
      .toBe(join(blobsDir, 'ab', 'abcdef.pdf'));
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('vfs_get_file_blob_path returns null for missing rows, hashes and files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-vfs-blob-'));
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: database(dir, sql =>
      sql.includes('FROM files') ? null : undefined) },
  });
  try {
    expect(await host.invoke('vfs_get_file_blob_path', { id: 'missing' })).toBeNull();
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }

  const nullHash = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: database(dir, () => null) },
  });
  try {
    expect(await nullHash.invoke('vfs_get_file_blob_path', { id: 'file-1' })).toBeNull();
  } finally { await nullHash.dispose(); }

  const missingBlobRow = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: database(dir, sql =>
      sql.includes('FROM files') ? 'abcdef' : undefined) },
  });
  try {
    expect(await missingBlobRow.invoke('vfs_get_file_blob_path', { id: 'file-1' })).toBeNull();
  } finally { await missingBlobRow.dispose(); }

  // blob 行存在但磁盘文件已被清理。
  const missingFile = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: database(dir, sql =>
      sql.includes('FROM files') ? 'abcdef' : 'ab/abcdef.pdf') },
  });
  try {
    expect(await missingFile.invoke('vfs_get_file_blob_path', { id: 'file-1' })).toBeNull();
  } finally {
    await missingFile.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('vfs_get_file_blob_path maps VFS configuration and query failures', async () => {
  const noDatabase = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings: settings(), paths: testPaths } });
  try {
    await expect(noDatabase.invoke('vfs_get_file_blob_path', { id: 'file-1' })).rejects.toEqual({
      error_type: 'Configuration', message: 'VFS database not configured', details: null,
    });
  } finally { await noDatabase.dispose(); }

  const noConn = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: failingDatabase('boom') },
  });
  try {
    await expect(noConn.invoke('vfs_get_file_blob_path', { id: 'file-1' })).rejects.toEqual({
      error_type: 'Database', message: '获取 VFS 连接失败: boom', details: null,
    });
  } finally { await noConn.dispose(); }

  const fileQuery = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(), paths: testPaths,
      vfsDatabase: {
        getConnSafe: () => ({
          pluck: () => { throw new Error('files broken'); },
        }) as unknown as SqlExecutor,
        blobsDir: () => '/nonexistent',
      } as unknown as VfsDatabase,
    },
  });
  try {
    await expect(fileQuery.invoke('vfs_get_file_blob_path', { id: 'file-1' })).rejects.toEqual({
      error_type: 'Database', message: '查询 blob_hash 失败: files broken', details: null,
    });
  } finally { await fileQuery.dispose(); }

  const blobQuery = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: settings(), paths: testPaths,
      vfsDatabase: {
        getConnSafe: () => ({
          pluck: (sql: string) => {
            if (sql.includes('FROM files')) return 'abcdef';
            throw new Error('blobs broken');
          },
        }) as unknown as SqlExecutor,
        blobsDir: () => '/nonexistent',
      } as unknown as VfsDatabase,
    },
  });
  try {
    await expect(blobQuery.invoke('vfs_get_file_blob_path', { id: 'file-1' })).rejects.toEqual({
      error_type: 'Database', message: '查询 blob 路径失败: blobs broken', details: null,
    });
  } finally { await blobQuery.dispose(); }
});

it('RF-W04-blob-relative-path-escape: vfs_get_file_blob_path never hands out a path outside vfs_blobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-vfs-blob-'));
  const blobsDir = join(dir, 'vfs_blobs');
  mkdirSync(join(blobsDir, 'ab'), { recursive: true });
  const outside = join(dir, 'outside.pdf');
  writeFileSync(outside, 'secret');
  const relativePaths = ['../outside.pdf', outside];
  if (process.platform !== 'win32') {
    symlinkSync(outside, join(blobsDir, 'ab', 'link.pdf'));
    relativePaths.push('ab/link.pdf');
  }
  try {
    for (const relativePath of relativePaths) {
      const host = await createTestHost({
        plugins: [media],
        provide: { storage: unusedStorage(), settings: settings(), paths: testPaths, vfsDatabase: database(blobsDir, sql =>
          sql.includes('FROM files') ? 'abcdef' : relativePath) },
      });
      try {
        expect(await host.invoke('vfs_get_file_blob_path', { id: 'file-1' }), relativePath).toBeNull();
      } finally { await host.dispose(); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
