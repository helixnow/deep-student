import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { createStorageService, type StorageServiceImpl } from '../../../platform/storage/service.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSecretsService } from '../../../platform/secrets/index.ts';
import {
  classifyRecoveryKind, loadManifest, parseManifest, saveManifest, updateCoverage, validateForSlotRestore,
} from '../src/manifest.ts';
import { exportBackupToZip, importBackupFromZip, zipContainsEncryptedSecrets } from '../src/zip.ts';
import { resolveImportZipPassword, resolveZipEncryptionPassword } from '../src/zip-commands.ts';
import {
  ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE, SEALED_BACKUP_PASSWORD_REQUIRED_CODE,
} from '../src/zip-codes.ts';
import {
  createBackupHost, createDatabaseFile, createRealStorage, fullBackupFiles, fullManifest,
  hostBackupRoot, installSyncService, waitForJob, writeBackup,
} from './helpers.ts';
import { createBackup, deleteBackup } from '../src/backup-manager.ts';
import { DataSpaceManager } from '../../../platform/storage/data-space.ts';
import type { CryptoPublication, CryptoPublicationJournal } from '../../../platform/secrets/api.ts';

const ENCRYPTION_PASSWORD = 'test-backup-passphrase';
const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
const storages: StorageServiceImpl[] = [];
afterEach(async () => {
  for (const entry of hosts.splice(0)) await entry.host.dispose();
  for (const storage of storages.splice(0)) storage.dispose();
});

async function setup() {
  const created = await createBackupHost({ secrets: true });
  hosts.push(created);
  return created;
}

/** 这两条保真回归使用F4真实服务，不以FAKE-DSBK密码前缀实现验证解封。 */
async function setupRealSecrets() {
  let storage!: StorageServiceImpl;
  const created = await createBackupHost({ storageFactory: dataDir => {
    storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
    return storage;
  } });
  hosts.push(created);
  const { host } = created;
  host.ctx.effect(() => () => storage.dispose());
  const root = host.app.dataDir;
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), LOCALAPPDATA: root,
    APPDATA: join(root, 'config'), XDG_DATA_HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache') };
  const paths = createPaths({ dataDir: root, platform, env });
  const logger = host.ctx.logger('zip-real-secrets');
  // 同一正式Host先安装公开F7 native，再把真实ctx.nativeArgon2交给正式F4工厂；
  // 不另造bootstrap Host、假快KDF，也不改默认m/t/p与用例预算。
  await host.install(native);
  const secrets = createSecretsService({ os: paths.os, env, keystore: null,
    nativeArgon2: host.ctx.nativeArgon2, log: {
      target: 'zip-real-secrets', error: logger.error.bind(logger), warn: logger.warn.bind(logger),
      info: logger.info.bind(logger), debug: logger.debug.bind(logger), trace: logger.debug.bind(logger),
    } });
  // 替换本lane所建fixture的公开方法，保持同一注入对象；F4实现本身不修改。
  Object.assign(host.ctx.secrets, secrets);
  return created;
}

function makeSqliteFullBackup(host: TestHost, id: string) {
  const root = hostBackupRoot(host);
  const dir = join(root, id);
  const manifest = fullManifest(id);
  for (const file of manifest.files) {
    const path = join(dir, file.path);
    createDatabaseFile(path, `CREATE TABLE roundtrip_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO roundtrip_marker(value) VALUES ('${MARKER_VALUE}')`);
    const bytes = readFileSync(path);
    file.size = bytes.length;
    file.sha256 = createHash('sha256').update(bytes).digest('hex');
    updateCoverage(manifest, `database:${file.database_id!}`, 'complete', [file.path]);
  }
  saveManifest(join(dir, 'manifest.json'), manifest);
  return { root, manifest, dir };
}

async function makeFullBackup(host: TestHost, id: string) {
  const root = hostBackupRoot(host);
  const manifest = fullManifest(id);
  writeBackup(root, manifest, fullBackupFiles(manifest));
  return { root, manifest, dir: join(root, id) };
}

async function exportSealed(host: TestHost, dir: string, name: string) {
  return exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: ENCRYPTION_PASSWORD,
    outputPath: join(host.app.dataDir, `${name}.zip`),
  }, () => undefined, () => false);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function secretsOf(host: TestHost) {
  return (host.ctx as unknown as {
    secrets: {
      backup: {
        encryptBackupFile(input: string, output: string, password: string): Promise<void>;
        decryptBackupFile(input: string, output: string, password: string): Promise<void>;
      };
    };
  }).secrets;
}

it('encrypted_zip_import_without_password_returns_actionable_error', async () => {
  const { host } = await setup();
  const { dir } = await makeFullBackup(host, 'integration-needs-password');
  const sealed = await exportSealed(host, dir, 'integration-needs-password');
  const target = join(host.app.dataDir, 'integration-needs-password-target');
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain('备份密码');
  expect(error.message).toContain(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
});

it('encrypted_zip_import_with_wrong_password_fails', async () => {
  const { host } = await setup();
  const { dir } = await makeFullBackup(host, 'integration-wrong-password');
  const sealed = await exportSealed(host, dir, 'integration-wrong-password');
  const target = join(host.app.dataDir, 'integration-wrong-password-target');
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'totally-wrong-password', skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain('备份密码错误');
  expect(error.message).toContain(SEALED_BACKUP_DECRYPT_FAILED_CODE);
});

it.each(['clean', 'sealed-residue'] as const)('encrypted_zip_wrong_password_never_touches_target_slot (%s)', async scenario => {
  const { host } = await setupRealSecrets();
  const { dir } = makeSqliteFullBackup(host, 'integration-slot-guard');
  const sealed = await exportSealed(host, dir, 'integration-slot-guard');

  const slot = join(host.app.dataDir, 'slots', 'slotA');
  seedSlot(slot, 'pre-restore-data');
  const slotDatabases = [
    join(slot, 'databases', 'vfs.db'),
    join(slot, 'chat_v2.db'),
    join(slot, 'mistakes.db'),
    join(slot, 'llm_usage.db'),
  ];
  const before = slotDatabases.map(sha256);

  // Rust目标导入目录与源备份不同；不能把原始明文manifest当作错密码导入残留。
  const target = join(host.app.dataDir, 'recovery', 'backups', 'imported-slot-guard');
  mkdirSync(join(host.app.dataDir, 'recovery', 'backups'), { recursive: true });
  const leftoverPath = join(target, 'manifest.json');
  if (scenario === 'sealed-residue') {
    // 显式模拟可恢复的外层清单残留，确保Rust:504-523条件分支实际执行；取真实导出ZIP原文，不手造策略。
    const zip = await JSZip.loadAsync(readFileSync(sealed.zipPath));
    mkdirSync(target, { recursive: true });
    writeFileSync(leftoverPath, await zip.file('manifest.json')!.async('string'));
  }
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'totally-wrong-password', skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain('解封');

  if (existsSync(leftoverPath)) {
    const leftover = loadManifest(leftoverPath);
    expect(leftover.key_policy).toBe('included_encrypted');
    expect(() => validateForSlotRestore(leftover)).toThrow('密码加密封存');
    const started = await host.invoke<{ job_id: string }>('data_governance_restore_backup', {
      backupId: 'imported-slot-guard', restoreAssets: false,
    });
    const job = await waitForJob(host, started.job_id);
    expect(job.status).toBe('failed');
    expect(job.result).toMatchObject({ success: false, error: expect.stringContaining('密码加密封存') });
  }

  expect(slotDatabases.map(sha256)).toEqual(before);
  for (const path of slotDatabases) {
    const db = host.ctx.storage.openFile(path, { label: 'wrong-password-slot-marker', mustExist: true });
    try { expect(db.pluck<string>('SELECT value FROM roundtrip_marker LIMIT 1')).toBe('pre-restore-data'); }
    finally { host.ctx.storage.close(db); }
  }
});

it('unencrypted_portable_zip_is_honestly_partial', async () => {
  const { host } = await setup();
  const { dir } = await makeFullBackup(host, 'integration-portable');
  const portable = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'integration-portable.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'integration-portable-target');
  await importBackupFromZip(host.ctx, portable.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  const imported = loadManifest(join(target, 'manifest.json'));
  expect(imported.key_policy).toBe('excluded_portable');
  expect(imported.snapshot_kind).toBe('partial_overlay');
  expect(() => validateForSlotRestore(imported)).toThrow();
  expect(classifyRecoveryKind(imported)).toEqual({ kind: 'partial_archive', restorable: false });
});

it('imported_manifest_classification_matches_restore_gate', async () => {
  const { host } = await setup();
  const { dir } = await makeFullBackup(host, 'integration-classification');
  const portable = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'integration-classification.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'integration-classification-target');
  await importBackupFromZip(host.ctx, portable.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  const imported = loadManifest(join(target, 'manifest.json'));
  const classifiedRestorable = classifyRecoveryKind(imported).restorable;
  let gatePassed = true;
  try { validateForSlotRestore(imported); }
  catch { gatePassed = false; }
  expect(classifiedRestorable).toBe(gatePassed);
});

it('encrypted_zip_import_really_accepts_a_legacy_short_password', async () => {
  const { host } = await setup();
  const { dir } = await makeFullBackup(host, 'integration-legacy-short');
  const current = await exportSealed(host, dir, 'integration-legacy-short');
  const secrets = secretsOf(host);

  const source = await JSZip.loadAsync(readFileSync(current.zipPath));
  const legacy = new JSZip();
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir) { legacy.folder(name); continue; }
    if (name !== ENCRYPTED_SECRETS_ENTRY) {
      legacy.file(name, await entry.async('nodebuffer'));
      continue;
    }
    const oldPayload = join(host.app.dataDir, 'legacy-old.dsbk');
    const inner = join(host.app.dataDir, 'legacy-inner.zip');
    const newPayload = join(host.app.dataDir, 'legacy-new.dsbk');
    writeFileSync(oldPayload, await entry.async('nodebuffer'));
    await secrets.backup.decryptBackupFile(oldPayload, inner, ENCRYPTION_PASSWORD);
    await secrets.backup.encryptBackupFile(inner, newPayload, 'short6');
    legacy.file(name, readFileSync(newPayload));
  }
  const legacyPath = join(host.app.dataDir, 'legacy-short-password.zip');
  writeFileSync(legacyPath, await legacy.generateAsync({ type: 'nodebuffer' }));
  expect(await zipContainsEncryptedSecrets(host.ctx, legacyPath)).toBe(true);

  const resolved = resolveImportZipPassword('short6', false, null, true);
  expect(resolved).toBe('short6');
  const target = join(host.app.dataDir, 'legacy-short-target');
  await importBackupFromZip(host.ctx, legacyPath, target, {
    password: resolved, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(() => validateForSlotRestore(loadManifest(join(target, 'manifest.json')))).not.toThrow();
});

it('stored_password_resolution_selects_portable_or_encrypted_export', async () => {
  const { host } = await setupRealSecrets();
  const { dir } = makeSqliteFullBackup(host, 'integration-stored');

  expect(() => resolveZipEncryptionPassword(null, true, null)).toThrow();
  const portablePassword = resolveZipEncryptionPassword(null, false, null);
  expect(portablePassword).toBeNull();
  const portable = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
    encryptionPassword: portablePassword,
    outputPath: join(host.app.dataDir, 'resolved-portable.zip'),
  }, () => undefined, () => false);
  expect(await zipContainsEncryptedSecrets(host.ctx, portable.zipPath)).toBe(false);
  expect(resolveImportZipPassword(null, true, ENCRYPTION_PASSWORD, false)).toBeNull();

  const storedPassword = resolveZipEncryptionPassword(null, true, ENCRYPTION_PASSWORD);
  expect(storedPassword).toBe(ENCRYPTION_PASSWORD);
  const stored = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: storedPassword,
    outputPath: join(host.app.dataDir, 'resolved-stored.zip'),
  }, () => undefined, () => false);
  expect(await zipContainsEncryptedSecrets(host.ctx, stored.zipPath)).toBe(true);
  expect(resolveImportZipPassword(null, true, ENCRYPTION_PASSWORD, true)).toBe(ENCRYPTION_PASSWORD);
  const explicitPassword = resolveZipEncryptionPassword('explicit-password', true, ENCRYPTION_PASSWORD);
  expect(explicitPassword).toBe('explicit-password');
  const explicit = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: explicitPassword,
    outputPath: join(host.app.dataDir, 'resolved-explicit.zip'),
  }, () => undefined, () => false);
  expect(await zipContainsEncryptedSecrets(host.ctx, explicit.zipPath)).toBe(true);
  await expect(importBackupFromZip(host.ctx, explicit.zipPath, join(host.app.dataDir, 'explicit-import'), {
    password: explicitPassword, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  })).resolves.toBeGreaterThan(0);
  await expect(importBackupFromZip(host.ctx, explicit.zipPath, join(host.app.dataDir, 'stored-should-fail'), {
    password: ENCRYPTION_PASSWORD, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow('备份密码错误');
});

const MARKER_VALUE = 'p0-zip-roundtrip-marker';

function seedSlot(slot: string, value: string): void {
  for (const id of ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const) {
    const path = id === 'vfs' ? join(slot, 'databases', 'vfs.db') : join(slot, `${id}.db`);
    createDatabaseFile(path, `CREATE TABLE roundtrip_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO roundtrip_marker(value) VALUES ('${value}')`);
  }
}

it('zip_roundtrip_restore_succeeds_or_returns_actionable_error', async () => {
  const created = await createBackupHost({
    storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
  });
  hosts.push(created);
  const host = created.host;
  const appRoot = host.app.dataDir;
  const sourceSlot = join(appRoot, 'slots', 'slotA');
  seedSlot(sourceSlot, MARKER_VALUE);
  const root = hostBackupRoot(host);
  const manifest = await createBackup(
    { ctx: host.ctx, backupRoot: root, activeDir: sourceSlot, baseDir: appRoot },
    { includeAssets: true, backupIdSuffix: 'roundtrip' },
  );
  const backupSubdir = join(root, manifest.backup_id);
  let slotVerdict = true;
  try { validateForSlotRestore(manifest); } catch { slotVerdict = false; }
  expect(manifest.snapshot_kind === 'full').toBe(slotVerdict);

  const zipPath = join(appRoot, 'roundtrip.zip');
  const exported = await exportBackupToZip(host.ctx, backupSubdir, {
    compressionLevel: 6, includeChecksums: true, outputPath: zipPath,
  }, () => undefined, () => false);
  expect(exported.fileCount).toBeGreaterThan(0);

  const sourceHashes = new Map<string, string>();
  for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
    const relative = id === 'vfs' ? 'vfs.db' : `${id}.db`;
    sourceHashes.set(relative, sha256(join(backupSubdir, relative)));
  }
  await deleteBackup(root, manifest.backup_id);
  const importedFiles = await importBackupFromZip(host.ctx, zipPath, backupSubdir, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(importedFiles).toBeGreaterThan(0);
  for (const [relative, expected] of sourceHashes) {
    expect(sha256(join(backupSubdir, relative)), `${relative} 往返后字节不一致`).toBe(expected);
  }

  const imported = loadManifest(join(backupSubdir, 'manifest.json'));
  expect(imported.key_policy).toBe('excluded_portable');
  let classificationError: Error | null = null;
  try { validateForSlotRestore(imported); }
  catch (error) { classificationError = error as Error; }
  expect(classificationError).not.toBeNull();
  expect(classificationError!.message.trim()).not.toBe('');

  const inactive = join(appRoot, 'slots', 'slotB');
  seedSlot(inactive, 'pre-restore-data');
  const started = await host.invoke('data_governance_restore_backup', {
    backupId: imported.backup_id,
  }) as { job_id: string };
  const job = await waitForJob(host, started.job_id);
  expect(job.status).toBe('failed');
  expect(String(job.message ?? job.error ?? '')).toContain('PARTIAL_ARCHIVE_NOT_SLOTABLE');
  for (const id of ['chat_v2', 'mistakes', 'llm_usage'] as const) {
    const path = join(inactive, `${id}.db`);
    const conn = new (await import('../../../platform/storage/connection.ts')).Connection(path, {
      label: 'roundtrip-verify', profile: (await import('../../../platform/storage/profiles.ts')).PROFILES.plain,
      mustExist: true,
    });
    try {
      expect(conn.pluck<string>('SELECT value FROM roundtrip_marker LIMIT 1')).toBe('pre-restore-data');
    } finally { conn.close(); }
  }
}, 120_000);

it('encrypted_zip_roundtrip_restores_full_slot', async ({ signal }) => {
  const created = await createBackupHost({
    secrets: true,
    storageFactory: dataDir => {
      const storage = createStorageService({ baseDir: dataDir, dataLocalDir: dataDir });
      storages.push(storage);
      return storage;
    },
  });
  hosts.push(created);
  const host = created.host;
  // D7：恢复后的同步基线由 L20 `sync@1` 拥有。
  await installSyncService(host);
  const appRoot = host.app.dataDir;
  const sourceSlot = join(appRoot, 'slots', 'slotA');
  seedSlot(sourceSlot, MARKER_VALUE);
  const root = hostBackupRoot(host);
  const manifest = await createBackup(
    { ctx: host.ctx, backupRoot: root, activeDir: sourceSlot, baseDir: appRoot },
    { includeAssets: true, backupIdSuffix: 'encrypted-roundtrip' },
  );
  expect(() => validateForSlotRestore(manifest)).not.toThrow();
  const backupSubdir = join(root, manifest.backup_id);
  const zipPath = join(appRoot, 'encrypted-full-fidelity.zip');
  await exportBackupToZip(host.ctx, backupSubdir, {
    compressionLevel: 6, includeChecksums: true, outputPath: zipPath,
    encryptionPassword: ENCRYPTION_PASSWORD,
  }, () => undefined, () => false);

  const zip = await JSZip.loadAsync(readFileSync(zipPath));
  expect(Object.keys(zip.files)).toContain(ENCRYPTED_SECRETS_ENTRY);
  const outer = parseManifest(JSON.parse(await zip.file('manifest.json')!.async('string')));
  expect(outer.key_policy).toBe('included_encrypted');
  expect(outer.snapshot_kind).toBe('partial_overlay');
  let sealedError: Error | null = null;
  try { validateForSlotRestore(outer); }
  catch (error) { sealedError = error as Error; }
  expect(sealedError).not.toBeNull();
  expect(sealedError!.message).toContain('密码');

  const sourceHashes = new Map<string, string>();
  for (const id of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
    const relative = id === 'vfs' ? 'vfs.db' : `${id}.db`;
    sourceHashes.set(relative, sha256(join(backupSubdir, relative)));
  }
  await deleteBackup(root, manifest.backup_id);
  await importBackupFromZip(host.ctx, zipPath, backupSubdir, {
    password: ENCRYPTION_PASSWORD, skipExisting: false,
    onProgress: () => undefined, isCancelled: () => false,
  });
  expect(existsSync(join(backupSubdir, ENCRYPTED_SECRETS_ENTRY))).toBe(false);
  for (const [relative, expected] of sourceHashes) {
    expect(sha256(join(backupSubdir, relative)), `${relative} 加密往返后字节不一致`).toBe(expected);
  }
  const imported = loadManifest(join(backupSubdir, 'manifest.json'));
  expect(imported.snapshot_kind).toBe('full');
  expect(imported.key_policy).not.toBe('included_encrypted');
  expect(() => validateForSlotRestore(imported)).not.toThrow();

  const publication: CryptoPublication = {
    journalPath: app => join(app, '.crypto_restore_journal.json'),
    rollbackDir: app => join(app, '.crypto_restore_rollback'),
    async writeJournal(app: string, journal: CryptoPublicationJournal) {
      writeFileSync(join(app, '.crypto_restore_journal.json'), JSON.stringify(journal));
    },
    async removeJournal(app: string) {
      const path = join(app, '.crypto_restore_journal.json');
      if (existsSync(path)) rmSync(path, { force: true });
    },
    async recover() { return 'Clean'; },
  };
  (host.ctx.secrets as unknown as { publication: CryptoPublication }).publication = publication;
  const dataSpace = new DataSpaceManager(appRoot, publication);
  mkdirSync(dataSpace.slotDir('slotA'), { recursive: true });
  mkdirSync(dataSpace.slotDir('slotB'), { recursive: true });
  host.ctx.provide('dataSpace', dataSpace);

  const started = await host.invoke('data_governance_restore_backup', {
    backupId: imported.backup_id,
  }) as { job_id: string };
  const job = await waitForJob(host, started.job_id, signal);
  expect(job.status, String(job.message ?? job.error ?? '')).toBe('completed');
  const restoredSlot = dataSpace.slotDir('slotB');
  for (const id of ['chat_v2', 'mistakes', 'llm_usage'] as const) {
    const path = join(restoredSlot, `${id}.db`);
    const conn = new (await import('../../../platform/storage/connection.ts')).Connection(path, {
      label: 'encrypted-roundtrip-verify',
      profile: (await import('../../../platform/storage/profiles.ts')).PROFILES.plain,
      mustExist: true,
    });
    try {
      expect(conn.pluck<string>('SELECT value FROM roundtrip_marker LIMIT 1')).toBe(MARKER_VALUE);
    } finally { conn.close(); }
  }
}, 120_000);
