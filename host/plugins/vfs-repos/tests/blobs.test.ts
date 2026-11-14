import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import { buildBlobPath, computeBlobHash } from '../repository/blobs.ts';

let root: string;
let blobsDir: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-blob-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const repo = () => host.ctx.vfsRepo.blobs;

describe('blob_repo.rs', { timeout: 120_000 }, () => {
  it('test_store_blob', () => {
    const data = Buffer.from('Hello, VFS Blob!');
    const blob = repo().storeBlob(db, blobsDir, data, 'text/plain', 'txt');
    expect(blob.hash.length).toBeGreaterThan(0);
    expect(blob.size).toBe(data.length);
    expect(blob.mimeType).toBe('text/plain');
    expect(blob.refCount).toBe(1);

    const filePath = join(blobsDir, blob.relativePath);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(data)).toBe(true);
  });

  it('test_blob_dedup', () => {
    const data = Buffer.from('Same content');
    const blob1 = repo().storeBlob(db, blobsDir, data, null, null);
    expect(blob1.refCount).toBe(1);
    const blob2 = repo().storeBlob(db, blobsDir, data, null, null);
    expect(blob1.hash).toBe(blob2.hash);
    expect(blob2.refCount).toBe(2);
  });

  it('test_blob_dedup_different_extension_no_orphan', () => {
    const data = Buffer.from('Same content, different extension');
    const blob1 = repo().storeBlob(db, blobsDir, data, null, 'pdf');
    const blob2 = repo().storeBlob(db, blobsDir, data, null, 'bin');
    expect(blob1.hash).toBe(blob2.hash);
    expect(blob1.relativePath).toBe(blob2.relativePath);
    expect(blob2.refCount).toBe(2);

    const prefixDir = join(blobsDir, blob1.hash.slice(0, 2));
    const count = readdirSync(prefixDir).filter(name => name.startsWith(blob1.hash)).length;
    expect(count).toBe(1);
  });

  it('test_get_blob_path', () => {
    const data = Buffer.from('Test data');
    const blob = repo().storeBlob(db, blobsDir, data, null, 'dat');
    const path = repo().getBlobPath(db, blobsDir, blob.hash);
    expect(path).not.toBeNull();
    expect(path!.startsWith(blobsDir)).toBe(true);
    expect(existsSync(path!)).toBe(true);
  });

  it('test_ref_count_operations', () => {
    const blob = repo().storeBlob(db, blobsDir, Buffer.from('Test data'), null, null);
    expect(blob.refCount).toBe(1);
    expect(repo().incrementRef(db, blob.hash)).toBe(2);
    expect(repo().decrementRef(db, blob.hash)).toBe(1);
    expect(repo().decrementRef(db, blob.hash)).toBe(0);
    expect(repo().decrementRef(db, blob.hash)).toBe(0);
  });

  it('test_compute_hash', () => {
    const hash1 = computeBlobHash(Buffer.from('test'));
    const hash2 = computeBlobHash(Buffer.from('test'));
    const hash3 = computeBlobHash(Buffer.from('different'));
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });

  it('test_blob_path_structure', () => {
    const [relative, absolute] = buildBlobPath('/tmp/vfs_blobs', 'abcdef1234567890', 'pdf');
    expect(relative).toBe('ab/abcdef1234567890.pdf');
    expect(absolute).toBe(join('/tmp/vfs_blobs', 'ab/abcdef1234567890.pdf'));
  });

  it('deletion_prepare_failure_keeps_blob_metadata_and_file', () => {
    const blob = repo().storeBlob(db, blobsDir, Buffer.from('prepare failure'), null, null);
    repo().decrementRef(db, blob.hash);
    db.exec(`CREATE TRIGGER fail_blob_prepare
      BEFORE INSERT ON __file_deletion_journal
      WHEN NEW.target_kind = 'blob'
      BEGIN
        SELECT RAISE(FAIL, 'injected blob prepare failure');
      END;`);

    let message = '';
    try { repo().cleanupBlob(db, blobsDir, blob.hash); }
    catch (error) { message = String(error); }
    expect(message).toContain('injected blob prepare failure');
    expect(repo().blobExists(db, blob.hash)).toBe(true);
    expect(existsSync(join(blobsDir, blob.relativePath))).toBe(true);
  });

  it('recovers_blob_crash_after_prepare', () => {
    const blob = repo().storeBlob(db, blobsDir, Buffer.from('prepared crash'), null, null);
    repo().decrementRef(db, blob.hash);
    const current = repo().getBlob(db, blob.hash)!;
    const intent = repo().prepareBlobDeletion(db, blobsDir, current)!;

    expect(repo().blobExists(db, blob.hash)).toBe(false);
    expect(existsSync(join(blobsDir, blob.relativePath))).toBe(true);
    expect(repo().recoverPreparedBlobDeletions(db, blobsDir)).toBe(1);
    expect(existsSync(join(blobsDir, blob.relativePath))).toBe(false);
    const state = db.pluck<string>('SELECT state FROM __file_deletion_journal WHERE operation_id = ?1', [intent.operationId]);
    expect(state).toBe('ready');
  });

  it('blob_ready_outbox_failure_is_visible_and_recoverable', () => {
    const blob = repo().storeBlob(db, blobsDir, Buffer.from('outbox failure'), null, null);
    repo().decrementRef(db, blob.hash);
    db.exec(`CREATE TRIGGER fail_blob_outbox
      BEFORE INSERT ON __blob_deletion_queue
      BEGIN
        SELECT RAISE(FAIL, 'injected blob outbox failure');
      END;`);

    let message = '';
    try { repo().cleanupBlob(db, blobsDir, blob.hash); }
    catch (error) { message = String(error); }
    expect(message).toContain('injected blob outbox failure');
    expect(repo().blobExists(db, blob.hash)).toBe(false);
    expect(existsSync(join(blobsDir, blob.relativePath))).toBe(false);
    let state = db.pluck<string>(
      "SELECT state FROM __file_deletion_journal WHERE target_kind = 'blob' AND entity_key = ?1", [blob.hash]);
    expect(state).toBe('prepared');

    db.exec('DROP TRIGGER fail_blob_outbox');
    expect(repo().recoverPreparedBlobDeletions(db, blobsDir)).toBe(1);
    db.run('DELETE FROM __blob_deletion_queue WHERE hash = ?1', [blob.hash]);
    state = db.pluck<string>(
      "SELECT state FROM __file_deletion_journal WHERE target_kind = 'blob' AND entity_key = ?1", [blob.hash]);
    expect(state).toBe('published');
  });

  // X6-LP-0291: blob_repo.rs:330-341 rename failure has its own error log/message and removes the temp file.
  it('store_blob reports a failed final rename separately and leaves no temp file', () => {
    const data = Buffer.from('rename-collision');
    const hash = createHash('sha256').update(data).digest('hex');
    const finalPath = join(blobsDir, hash.slice(0, 2), `${hash}.txt`);
    mkdirSync(finalPath, { recursive: true });
    writeFileSync(join(finalPath, 'occupant'), 'x');
    expect(() => repo().storeBlob(db, blobsDir, data, 'text/plain', 'txt'))
      .toThrow('IO error: Failed to rename temp blob to final path:');
    expect(readdirSync(join(blobsDir, hash.slice(0, 2))).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(repo().getBlob(db, hash)).toBeNull();
  });
});

describe('RF-W10-blob-path-containment', { timeout: 120_000 }, () => {
  const seedBlob = (hash: string, relativePath: string, refCount = 1) => db.run(
    `INSERT INTO blobs (hash, relative_path, size, mime_type, ref_count, created_at)
     VALUES (?1, ?2, 6, NULL, ?3, 1)`, [hash, relativePath, refCount]);
  const linkedDir = () => {
    const target = join(root, 'outside-dir');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'x.bin'), 'secret');
    mkdirSync(blobsDir, { recursive: true });
    symlinkSync(target, join(blobsDir, 'ln'), 'dir');
    return target;
  };

  it('getBlobPath does not resolve a synced relative_path that leaves vfs_blobs', () => {
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(join(blobsDir, '..', 'outside.txt'), 'secret');
    const absolute = join(root, 'absolute.txt');
    writeFileSync(absolute, 'secret');
    linkedDir();
    const unsafe: Array<[string, string]> = [
      ['up', '../outside.txt'],
      ['nested-up', 'ab/../../outside.txt'],
      ['backslash-up', '..\\outside.txt'],
      ['absolute', absolute],
      ['drive', 'C:\\Windows\\win.ini'],
      ['unc', '\\\\server\\share\\x.bin'],
      ['linked-parent', 'ln/x.bin'],
    ];
    for (const [hash, relativePath] of unsafe) seedBlob(hash, relativePath);
    for (const [hash] of unsafe) expect(repo().getBlobPath(db, blobsDir, hash), hash).toBeNull();

    const blob = repo().storeBlob(db, blobsDir, Buffer.from('inside'), null, 'bin');
    expect(repo().getBlobPath(db, blobsDir, blob.hash)).toBe(join(blobsDir, blob.relativePath));
  });

  it('storeBlob refuses to write through an escaping or symlinked relative_path from an existing row', () => {
    const target = linkedDir();
    const escaping = Buffer.from('escaping payload');
    const escapingHash = computeBlobHash(escaping);
    seedBlob(escapingHash, '../escaped.bin');
    expect(() => repo().storeBlob(db, blobsDir, escaping, null, 'bin'))
      .toThrow("Failed to parse path '../escaped.bin'");
    expect(existsSync(join(blobsDir, '..', 'escaped.bin'))).toBe(false);

    const linked = Buffer.from('linked payload');
    const linkedHash = computeBlobHash(linked);
    seedBlob(linkedHash, 'ln/payload.bin');
    expect(() => repo().storeBlob(db, blobsDir, linked, null, 'bin'))
      .toThrow("Failed to parse path 'ln/payload.bin'");
    expect(readdirSync(target)).toEqual(['x.bin']);
    expect(repo().getBlob(db, escapingHash)!.refCount).toBe(1);
    expect(repo().getBlob(db, linkedHash)!.refCount).toBe(1);
  });

  it('cleanupBlob does not delete through a symlinked directory under vfs_blobs', () => {
    const target = linkedDir();
    seedBlob('linked', 'ln/x.bin', 0);
    expect(() => repo().cleanupBlob(db, blobsDir, 'linked')).toThrow("Failed to parse path 'ln/x.bin'");
    expect(readFileSync(join(target, 'x.bin'), 'utf8')).toBe('secret');
    expect(repo().blobExists(db, 'linked')).toBe(true);
  });

  it('a final path component that is a symlink must resolve inside vfs_blobs', () => {
    const outside = join(root, 'outside-leaf.bin');
    writeFileSync(outside, 'secret');
    mkdirSync(join(blobsDir, 'ab'), { recursive: true });
    symlinkSync(outside, join(blobsDir, 'ab', 'leaf.bin'), 'file');
    symlinkSync(join(root, 'missing-leaf.bin'), join(blobsDir, 'ab', 'dangling.bin'), 'file');
    writeFileSync(join(blobsDir, 'ab', 'real.bin'), 'inside');
    symlinkSync(join(blobsDir, 'ab', 'real.bin'), join(blobsDir, 'ab', 'alias.bin'), 'file');
    seedBlob('leaf', 'ab/leaf.bin');
    seedBlob('dangling', 'ab/dangling.bin');
    seedBlob('alias', 'ab/alias.bin');

    expect(repo().getBlobPath(db, blobsDir, 'leaf')).toBeNull();
    expect(repo().resolveBlobPath(blobsDir, 'ab/leaf.bin')).toBeNull();
    expect(repo().getBlobPath(db, blobsDir, 'dangling')).toBeNull();
    expect(repo().getBlobPath(db, blobsDir, 'alias')).toBe(join(blobsDir, 'ab', 'alias.bin'));
    expect(repo().resolveBlobPath(blobsDir, 'ab/not-yet.bin')).toBe(join(blobsDir, 'ab', 'not-yet.bin'));

    const payload = Buffer.from('secret');
    const payloadHash = computeBlobHash(payload);
    seedBlob(payloadHash, 'ab/leaf.bin');
    expect(() => repo().storeBlob(db, blobsDir, payload, null, 'bin'))
      .toThrow("Failed to parse path 'ab/leaf.bin'");
    expect(repo().getBlob(db, payloadHash)!.refCount).toBe(1);

    db.run('UPDATE blobs SET ref_count = 0 WHERE hash = ?1', ['leaf']);
    expect(() => repo().cleanupBlob(db, blobsDir, 'leaf')).toThrow("Failed to parse path 'ab/leaf.bin'");
    expect(readFileSync(outside, 'utf8')).toBe('secret');
    expect(fs.lstatSync(join(blobsDir, 'ab', 'leaf.bin')).isSymbolicLink()).toBe(true);
    expect(repo().blobExists(db, 'leaf')).toBe(true);
  });
});

describe('blob renames go through the W07 retry helper (RF-W07-windows-rename-retry)', { timeout: 120_000 }, () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: platform, configurable: true, enumerable: true, writable: false });
  /** The first `failures` renames throw `code`, later ones rename for real. */
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

  it('on win32 a briefly held target no longer fails storeBlob, storeStagedBlob or cleanupBlob', () => {
    setPlatform('win32');
    let calls = flakyRename('EPERM', 2);
    const bytes = repo().storeBlob(db, blobsDir, Buffer.from('held temp target'), null, 'bin');
    expect(calls()).toBe(3);
    expect(readFileSync(join(blobsDir, bytes.relativePath), 'utf8')).toBe('held temp target');
    vi.restoreAllMocks();

    const staged = repo().stageStream(blobsDir, [Buffer.from('held staged target')], 1024);
    calls = flakyRename('EBUSY', 1);
    const fromStage = repo().storeStagedBlob(db, blobsDir, staged, null, 'bin');
    expect(calls()).toBe(2);
    expect(readFileSync(join(blobsDir, fromStage.relativePath), 'utf8')).toBe('held staged target');
    vi.restoreAllMocks();

    repo().decrementRef(db, bytes.hash);
    calls = flakyRename('EACCES', 1);
    expect(repo().cleanupBlob(db, blobsDir, bytes.hash)).toBe(true);
    expect(calls()).toBe(2);
    expect(existsSync(join(blobsDir, bytes.relativePath))).toBe(false);
  });

  it('elsewhere a rename error still fails on the first attempt, like Rust', () => {
    setPlatform('linux');
    const calls = flakyRename('EPERM', 1);
    expect(() => repo().storeBlob(db, blobsDir, Buffer.from('linux temp target'), null, 'bin'))
      .toThrow('Failed to rename temp blob to final path');
    expect(calls()).toBe(1);
  });
});
