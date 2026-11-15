import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { exportBackupToZip, importBackupFromZip } from '../../../plugins/backup/src/zip.ts';
import { createStorageService } from '../../storage/service.ts';
import { createBackupCrypto } from '../../secrets/backup-crypto.ts';
import { expect, it, vi } from 'vitest';
import { createWebCrypto } from '../../crypto/web.ts';
import { createNodeFiles } from '../../files/index.ts';
import { MobileBackupService, type MobileBackupContext } from '../backup.ts';

function openFixture(bytes: Uint8Array) {
  const db = new Database(Buffer.from(bytes));
  return {
    close: () => db.close(),
    exec: (sql: string) => db.exec(sql),
    prepare(sql: string) {
      const rows = db.prepare(sql).raw().iterate() as IterableIterator<unknown[]>;
      let current: unknown[] = [];
      return {
        step: () => { const row = rows.next(); current = row.value ?? []; return !row.done; },
        get: (column: number) => current[column],
        finalize: () => rows.return?.(),
      };
    },
  };
}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

it('exports a password-protected desktop-format ZIP and restores SQLite, attachments and the API key after password validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dstu-mobile-backup-'));
  const active = join(root, 'active');
  const store = createNodeFiles({ roots: [{ name: 'appData', path: root }], backupRoot: join(root, 'backups') });
  const dbs = new Map<string, Uint8Array>();
  const names = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'];
  for (const name of names) {
    const path = join(root, `original-${name}.db`);
    const db = new Database(path);
    db.exec("CREATE TABLE probe (message TEXT); INSERT INTO probe VALUES ('old message')");
    if (name === 'vfs') {
      db.exec(`CREATE TABLE blobs (hash TEXT, relative_path TEXT, size INTEGER, ref_count INTEGER);
        CREATE TABLE files (blob_hash TEXT, compressed_blob_hash TEXT, preview_json TEXT)`);
      // The file FK is enough to require the blob even with stale ref_count = 0.
      db.prepare('INSERT INTO blobs VALUES (?, ?, ?, 0)').run(hash('original PDF'), 'file.pdf', 12);
      db.prepare('INSERT INTO files (blob_hash) VALUES (?)').run(hash('original PDF'));
    }
    db.close();
    dbs.set(name, new Uint8Array(await readFile(path)));
  }
  const original = dbs.get('chat_v2')!.slice();
  const key = 'eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHg=';
  await store.writeAtomic(join(root, '.master_key'), key);
  await store.writeAtomic(join(active, 'vfs_blobs', 'file.pdf'), 'original PDF', { createParents: true });
  const backup = new MobileBackupService({
    ctx: { app: { version: '0.20.0' }, crypto: createWebCrypto(), logger: () => ({ info() {}, warn() {} }) },
    files: store,
    storage: {
      locations: { baseDir: root, activeDir: active },
      pathOf: (name: string) => name,
      migrations: { currentVersion: () => 0 },
      database: (name: string) => ({ backupTo: async (target: string) => { dbs.set(target, dbs.get(name)!.slice()); } }),
      enterMaintenance: async () => ({ release() {} }),
    },
    runtime: {
      exists: (path: string) => dbs.has(path),
      open: (path: string) => openFixture(dbs.get(path)!),
      exportFile: (path: string) => dbs.get(path)!,
      unlink: (path: string) => dbs.delete(path),
      importDb: async (path: string, bytes: Uint8Array) => { dbs.set(path, bytes.slice()); return bytes.length; },
    },
  } as unknown as MobileBackupContext);
  const full = await backup.exportBackup('before');
  expect((await backup.verifyBackup('before')).base.is_valid).toBe(true);
  const attachment = join(active, 'vfs_blobs', 'file.pdf');
  await store.rename(attachment, `${attachment}.tmp`);
  await store.mkdir(attachment);
  await expect(backup.exportBackup('bad-source')).rejects.toThrow(/缺少 VFS 附件/);
  expect(await backup.existingZip('bad-source')).toBeNull();
  await store.rename(attachment, join(active, 'collision-directory'));
  await store.rename(`${attachment}.tmp`, attachment);
  await store.writeAtomic(attachment, 'corrupt body'); // Same length; manifest alone cannot diagnose this.
  await expect(backup.exportBackup('bad-source')).rejects.toThrow(/VFS 附件内容损坏/);
  await store.writeAtomic(attachment, 'original PDF');

  // Legacy archives can faithfully hash every included file while omitting a blob referenced by SQLite.
  const tampered = await JSZip.loadAsync(await store.readBytes(full.zipPath));
  const tamperedManifest = JSON.parse(await tampered.file('manifest.json')!.async('string'));
  const archiveAsset = 'assets/vfs_blobs/file.pdf';
  tamperedManifest.backup_id = 'old-corrupt';
  tamperedManifest.assets.files[0].checksum = hash('corrupt body');
  tampered.file(archiveAsset, 'corrupt body');
  tampered.file('manifest.json', JSON.stringify(tamperedManifest));
  const tamperedPath = join(root, 'backups', 'old-corrupt.zip');
  await store.writeAtomic(tamperedPath, await tampered.generateAsync({ type: 'uint8array' }));
  expect((await backup.verifyBackup('old-corrupt')).base).toMatchObject({ is_valid: false, errors: [expect.stringMatching(/VFS 附件内容损坏/)] });
  await expect(backup.exportPortable(tamperedPath, join(root, 'blocked.zip'), 'password-for-test')).rejects.toThrow(/VFS 附件内容损坏/);
  await expect(backup.importArchive(tamperedPath, 'blocked', undefined, true)).rejects.toThrow(/VFS 附件内容损坏/);
  expect(await store.exists(join(root, 'backups', 'imports', 'blocked', 'manifest.json'))).toBe(false);
  tampered.remove(archiveAsset);
  tamperedManifest.assets.files = [];
  tamperedManifest.backup_id = 'old-missing';
  // A ZIP that lists only a temporary file still cannot satisfy the canonical SQLite path.
  tamperedManifest.assets.files.push({ relative_path: `${archiveAsset}.tmp`, original_path: 'vfs_blobs/file.pdf.tmp',
    asset_type: 'vfs_blobs', size: 12, is_directory: false, checksum: hash('original PDF') });
  for (const domain of Object.values(tamperedManifest.coverage.domains) as Array<{ paths?: string[] }>) {
    if (domain.paths) domain.paths = domain.paths.map(path => path === archiveAsset ? `${archiveAsset}.tmp` : path);
  }
  tampered.file(`${archiveAsset}.tmp`, 'original PDF');
  tampered.file('manifest.json', JSON.stringify(tamperedManifest));
  const missingPath = join(root, 'backups', 'old-missing.zip');
  await store.writeAtomic(missingPath, await tampered.generateAsync({ type: 'uint8array' }));
  expect((await backup.verifyBackup('old-missing')).base).toMatchObject({ is_valid: false, errors: [expect.stringMatching(/缺少 VFS 附件/)] });
  await expect(backup.importArchive(missingPath, 'blocked-missing', undefined, true)).rejects.toThrow(/缺少 VFS 附件/);
  const portable = join(root, 'portable.zip');
  await backup.exportPortable(full.zipPath, portable);
  expect(await backup.importArchive(portable, 'plain')).toMatchObject({ restorable: false, blobCount: 1 });
  await expect(backup.restoreArchive('plain')).rejects.toThrow(/部分归档/);
  const protectedZip = join(root, 'encrypted.zip');
  await backup.exportPortable(full.zipPath, protectedZip, 'password-for-test');
  const desktopFiles = await JSZip.loadAsync(await store.readBytes(full.zipPath));
  const desktopSource = join(root, 'desktop-source');
  await Promise.all(Object.values(desktopFiles.files).filter(file => !file.dir).map(async file => {
    const output = join(desktopSource, file.name);
    await mkdir(join(output, '..'), { recursive: true });
    await writeFile(output, await file.async('nodebuffer'));
  }));
  const desktopStorage = createStorageService({ baseDir: root, dataLocalDir: root });
  const desktopContext = {
    app: { dataDir: root },
    get: () => store,
    logger: () => ({ info() {}, warn() {} }),
    storage: desktopStorage,
    secrets: { backup: createBackupCrypto() },
  } as unknown as MobileBackupContext['ctx'];
  const desktopZip = join(root, 'desktop-output.zip');
  await exportBackupToZip(desktopContext, desktopSource, { compressionLevel: 6, includeChecksums: true,
    outputPath: desktopZip, encryptionPassword: 'password-for-test' }, () => undefined, () => false);
  const output = join(root, 'desktop-import');
  try {
    await importBackupFromZip(desktopContext, protectedZip, output, {
      password: 'password-for-test', skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
    });
  } finally { desktopStorage.dispose(); }
  expect(await readFile(join(output, 'crypto', '.master_key'), 'utf8')).toBe(key);
  expect(await readFile(join(output, 'assets', 'vfs_blobs', 'file.pdf'), 'utf8')).toBe('original PDF');
  const encrypted = await store.readBytes(protectedZip);
  expect(new TextDecoder().decode(encrypted)).not.toContain(key);
  await expect(backup.importArchive(protectedZip, 'missing')).rejects.toThrow(/SEALED_PASSWORD_REQUIRED/);
  await expect(backup.importArchive(protectedZip, 'wrong', 'wrong-password')).rejects.toThrow(/SEALED_DECRYPT_FAILED/);
  const staging = await backup.importArchive(desktopZip, 'good', 'password-for-test');
  expect(staging).toMatchObject({ restorable: true, blobCount: 1, databaseCount: 4 });
  dbs.set('chat_v2', dbs.get('mistakes')!.slice());
  dbs.get('chat_v2')![200] = dbs.get('chat_v2')![200]! ^ 1;
  await store.writeAtomic(join(root, '.master_key'), 'new fake key');
  await store.writeAtomic(join(active, 'vfs_blobs', 'new.pdf'), 'new PDF');
  const snapshot = vi.spyOn(backup, 'exportBackup').mockRejectedValueOnce(new Error('storage full'));
  await expect(backup.restoreArchive(staging.backupId)).rejects.toThrow(/storage full/);
  expect(await store.readText(join(active, 'vfs_blobs', 'new.pdf'))).toBe('new PDF');
  expect(dbs.get('chat_v2')).not.toEqual(original);
  snapshot.mockRestore();
  await backup.restoreArchive(staging.backupId);
  expect(dbs.get('chat_v2')).toEqual(original);
  expect(await store.readText(join(root, '.master_key'))).toBe(key);
  expect(await store.readText(join(active, 'vfs_blobs', 'file.pdf'))).toBe('original PDF');

  // Simulate a process exit after the recovery intent and only some writes were published.
  await store.writeAtomic(join(root, 'recovery', 'pending-mobile-restore.json'), '{"id":"good"}', { createParents: true });
  await store.writeAtomic(join(active, 'vfs_blobs', 'file.pdf'), 'partially written');
  dbs.get('chat_v2')![200] = dbs.get('chat_v2')![200]! ^ 1;
  await expect(backup.recoverPendingRestore()).resolves.toMatchObject({ id: 'good', reason: null });
  expect(dbs.get('chat_v2')).toEqual(original);
  expect(await store.readText(join(active, 'vfs_blobs', 'file.pdf'))).toBe('original PDF');
  expect(await store.exists(join(root, 'recovery', 'pending-mobile-restore.json'))).toBe(false);

  // Corrupt a late database without changing its size or SQLite header. An earlier, otherwise
  // restorable database must not be overwritten before the damage is detected.
  const stageChat = join(staging.stageDir, 'chat_v2.db');
  const damaged = await store.readBytes(stageChat);
  damaged[200] = damaged[200]! ^ 1;
  await store.writeAtomic(stageChat, damaged);
  const beforeActivation = dbs.get('vfs')!.slice();
  beforeActivation[200] = beforeActivation[200]! ^ 1;
  dbs.set('vfs', beforeActivation);
  const intent = join(root, 'recovery', 'pending-mobile-restore.json');
  await store.writeAtomic(intent, JSON.stringify({ id: 'good', previousBackupId: 'before' }));
  for (let startup = 0; startup < 2; startup++) {
    await expect(backup.recoverPendingRestore()).resolves.toMatchObject({ id: 'good', reason: expect.stringMatching(/SHA-256.*chat_v2/), previousBackupId: 'before' });
    expect(dbs.get('vfs')).toEqual(beforeActivation);
    expect(await store.exists(intent)).toBe(true);
  }
  await backup.replacePendingRestore('before', 'before', () => undefined);
  expect(dbs.get('vfs')).not.toEqual(beforeActivation);
  expect(dbs.get('chat_v2')).toEqual(original);
  expect(await store.exists(intent)).toBe(false);
  expect(await store.exists(full.zipPath)).toBe(true);
}, 30_000);
