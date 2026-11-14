import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { getContentByType } from '../api.ts';
import { storeBlobWithConn } from '../repository/create.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';

describe('RF-W10-blob-path-containment: vfs blob reads and writes stay inside vfs_blobs', { timeout: 30_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let blobsDir: string;
  let template: string;

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-blob-path-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-blob-path-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    conn = host.ctx.vfsDatabase.getConn();
    blobsDir = host.ctx.vfsDatabase.blobsDir();
    fs.mkdirSync(blobsDir, { recursive: true });
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const seedBlob = (hash: string, relativePath: string) => conn.run(
    `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
     VALUES (?1, ?2, 6, NULL, 1, 1)`, [hash, relativePath]);
  const seedImage = (id: string, sha256: string) => conn.run(
    `INSERT INTO files (id, sha256, file_name, size, type, mime_type, tags_json, bookmarks_json, status,
                        created_at, updated_at)
     VALUES (?1, ?2, 'x.png', 6, 'image', 'image/png', '[]', '[]', 'active', ?3, ?3)`,
    [id, sha256, '2026-01-01T00:00:00.000Z']);
  const imageContent = (id: string) => getContentByType({ database: host.ctx.vfsDatabase }, 'images', id);

  it('image content does not read a blob whose relative_path leaves vfs_blobs', () => {
    fs.writeFileSync(path.join(blobsDir, '..', 'outside.txt'), 'secret');
    const absolute = path.join(root, 'absolute.txt');
    fs.writeFileSync(absolute, 'secret');
    const linked = path.join(root, 'outside-dir');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'x.bin'), 'secret');
    fs.symlinkSync(linked, path.join(blobsDir, 'ln'), 'dir');
    const unsafe: Array<[string, string]> = [
      ['img_up', '../outside.txt'],
      ['img_abs', absolute],
      ['img_link', 'ln/x.bin'],
    ];
    for (const [id, relativePath] of unsafe) {
      seedBlob(`sha_${id}`, relativePath);
      seedImage(id, `sha_${id}`);
    }
    for (const [id] of unsafe) expect(() => imageContent(id), id).toThrow(`Resource not found: ${id}`);

    const inside = storeBlobWithConn(conn, blobsDir, Buffer.from('inside'), 'image/png', 'png');
    seedImage('img_inside', inside.hash);
    expect(imageContent('img_inside')).toBe(Buffer.from('inside').toString('base64'));
  });

  it('storeBlobWithConn refuses to write through an escaping relative_path from an existing row', () => {
    const data = Buffer.from('escaping payload');
    seedBlob(createHash('sha256').update(data).digest('hex'), '../escaped.bin');
    expect(() => storeBlobWithConn(conn, blobsDir, data, null, 'bin'))
      .toThrow("Failed to parse path '../escaped.bin'");
    expect(fs.existsSync(path.join(blobsDir, '..', 'escaped.bin'))).toBe(false);
  });

  describe('storeBlobWithConn renames through the W07 retry helper (RF-W07-windows-rename-retry)', () => {
    const realPlatform = process.platform;
    const setPlatform = (platform: NodeJS.Platform) =>
      Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false });
    const flakyRename = (code: string, failures: number) => {
      const real = fs.renameSync;
      let calls = 0;
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        calls += 1;
        if (calls <= failures) throw Object.assign(new Error(`${code}: rename`), { code, syscall: 'rename' });
        real(from, to);
      });
      return () => calls;
    };
    afterEach(() => {
      setPlatform(realPlatform);
      vi.restoreAllMocks();
    });

    it('on win32 a briefly held target is retried; elsewhere the first error fails like Rust', () => {
      setPlatform('win32');
      let calls = flakyRename('EPERM', 2);
      const held = storeBlobWithConn(conn, blobsDir, Buffer.from('held target'), null, 'bin');
      expect(calls()).toBe(3);
      expect(fs.readFileSync(path.join(blobsDir, held.relativePath), 'utf8')).toBe('held target');
      vi.restoreAllMocks();

      setPlatform('linux');
      calls = flakyRename('EPERM', 1);
      expect(() => storeBlobWithConn(conn, blobsDir, Buffer.from('linux target'), null, 'bin'))
        .toThrow('Failed to rename temp blob to final path');
      expect(calls()).toBe(1);
    });
  });
});
