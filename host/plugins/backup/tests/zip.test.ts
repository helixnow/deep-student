import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import {
  archivePolicyLimits, compressionRatio, copyWithActualSizeBudget, exportBackupToZip,
  importBackupFromZip, isPortableExcludedRelativePath, isUnsafeArchivePath, validateSecretsArchive,
  zipContainsEncryptedSecrets,
} from '../src/zip.ts';
import { ENCRYPTED_SECRETS_ENTRY, SEALED_BACKUP_DECRYPT_FAILED_CODE, SEALED_BACKUP_PASSWORD_REQUIRED_CODE } from '../src/zip-codes.ts';
import { loadManifest, saveManifest, updateCoverage, validateForSlotRestore } from '../src/manifest.ts';
import {
  createBackupHost, createDatabaseFile, createRealStorage, fullBackupFiles, fullManifest, hostBackupRoot,
  partialManifest, sha256, writeBackup,
} from './helpers.ts';

const hosts: Array<{ host: TestHost; secrets: unknown }> = [];
afterEach(async () => { for (const entry of hosts.splice(0)) await entry.host.dispose(); });

async function setup() {
  const created = await createBackupHost({ secrets: true });
  hosts.push(created);
  return created;
}

const FILES = {
  'persistent/webview_settings.json': '{"theme":"dark"}',
  'persistent/custom_grading_modes.json': '{"modes":[]}',
};

function makeBackup(host: TestHost, id = 'backup-test', extraFiles: Record<string, string> = {}) {
  const root = hostBackupRoot(host);
  const files = { ...FILES, ...extraFiles };
  const manifest = partialManifest(id, { files });
  writeBackup(root, manifest, files);
  return { root, manifest, dir: join(root, id) };
}

/** Rust zip_export.rs:2268-2314：四个真实 SQLite 库、完整清单、其余域 absent。 */
function makeFullSqliteBackup(host: TestHost, id: string) {
  const manifest = fullManifest(id);
  const dir = join(hostBackupRoot(host), manifest.backup_id);
  mkdirSync(dir, { recursive: true });
  for (const file of manifest.files) {
    const path = join(dir, file.path);
    createDatabaseFile(path, `CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO test_data(value) VALUES ('portable-backup-test')`);
    const bytes = readFileSync(path);
    file.size = bytes.length;
    file.sha256 = sha256(bytes);
    updateCoverage(manifest, `database:${file.database_id}`, 'complete', [file.path]);
  }
  saveManifest(join(dir, 'manifest.json'), manifest);
  return { manifest, dir };
}


async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => { throw new Error('expected rejection'); },
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

it('test_export_default_options', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  expect(existsSync(result.zipPath)).toBe(true);
  expect(result.fileCount).toBeGreaterThan(0);
  expect(result.totalSize).toBeGreaterThan(0);
  expect(result.zipChecksum).toMatch(/^[0-9a-f]{64}$/);
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  expect(Object.keys(zip.files)).toEqual(expect.arrayContaining([
    'manifest.json', 'persistent/webview_settings.json', 'checksums.sha256',
  ]));
});

it('test_export_with_custom_output_path', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const output = join(host.app.dataDir, 'out', 'custom_backup.zip');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: output,
  }, () => undefined, () => false);
  expect(result.zipPath).toBe(output);
  expect(existsSync(output)).toBe(true);
});

it('test_export_excludes_crypto_secrets', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  mkdirSync(join(dir, 'crypto', '.secure'), { recursive: true });
  writeFileSync(join(dir, 'crypto', '.secure', '.key_seed'), 'seed');
  writeFileSync(join(dir, 'crypto', '.master_key'), 'master');
  writeFileSync(join(dir, '.master_key'), 'master');
  writeFileSync(join(dir, '.key_seed'), 'seed');
  mkdirSync(join(dir, '.secure'), { recursive: true });
  writeFileSync(join(dir, '.secure', 'credential.enc'), 'credential');
  mkdirSync(join(dir, 'Crypto'), { recursive: true });
  writeFileSync(join(dir, 'Crypto', 'upper.key'), 'secret');
  mkdirSync(join(dir, '.SECURE'), { recursive: true });
  writeFileSync(join(dir, '.SECURE', 'upper.enc'), 'secret');

  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  const names = Object.keys(zip.files);
  expect(names).toContain('manifest.json');
  for (const name of names) {
    expect(name.toLowerCase()).not.toBe('.master_key');
    expect(name.toLowerCase()).not.toBe('.key_seed');
    expect(name.toLowerCase().startsWith('crypto/')).toBe(false);
    expect(name.toLowerCase().startsWith('.secure/')).toBe(false);
  }
  // Rust zip_export.rs:2392-2398：排除敏感条目是导出策略，不能删除或移动源文件。
  for (const path of [
    'crypto/.secure/.key_seed', 'crypto/.master_key', '.secure/credential.enc',
    '.master_key', '.key_seed', 'Crypto/upper.key', '.SECURE/upper.enc',
  ]) {
    expect(statSync(join(dir, path)).isFile(), path).toBe(true);
  }
});

it('test_unencrypted_export_excludes_user_skills', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  mkdirSync(join(dir, 'persistent', 'user_skills'), { recursive: true });
  writeFileSync(join(dir, 'persistent', 'user_skills', 'skill.md'), '# skill');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  expect(Object.keys(zip.files).some(name => name.startsWith('persistent/user_skills'))).toBe(false);
  // Rust zip_export.rs:2429-2432：导出不得改动源备份。
  expect(statSync(join(dir, 'persistent', 'user_skills', 'skill.md')).isFile()).toBe(true);
});

it('test_export_rejects_output_inside_source_without_overwriting_it', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const output = join(dir, 'inside.zip');
  writeFileSync(output, 'keep-me');
  await expect(exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: output,
  }, () => undefined, () => false)).rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  expect(readFileSync(output, 'utf8')).toBe('keep-me');
});

// Rust zip_export.rs:717-741 用 canonicalize 解析源目录、输出父目录和已存在的输出，符号链接别名不能绕过。
it('test_export_rejects_output_inside_source_through_symlinked_parent', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const alias = join(host.app.dataDir, 'alias-of-source');
  symlinkSync(dir, alias, 'dir');
  const options = { compressionLevel: 6, includeChecksums: true };
  await expect(exportBackupToZip(host.ctx, dir, { ...options, outputPath: join(alias, 'via-link.zip') },
    () => undefined, () => false)).rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  await expect(exportBackupToZip(host.ctx, dir, { ...options, outputPath: join(alias, 'nested', 'via-link.zip') },
    () => undefined, () => false)).rejects.toThrow('ZIP 输出路径不能位于备份源目录内');
  expect(existsSync(join(dir, 'via-link.zip'))).toBe(false);
  expect(existsSync(join(dir, 'nested'))).toBe(false);
});

it('test_export_rejects_existing_output_symlink_into_source', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  writeFileSync(join(dir, 'target.zip'), 'keep-me');
  const output = join(host.app.dataDir, 'link.zip');
  symlinkSync(join(dir, 'target.zip'), output);
  await expect(exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: output,
  }, () => undefined, () => false)).rejects.toThrow('ZIP 输出路径不能指向备份源目录内');
  expect(readFileSync(join(dir, 'target.zip'), 'utf8')).toBe('keep-me');
});

it('test_export_store_only', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 0, includeChecksums: true,
  }, () => undefined, () => false);
  expect(result.compressedSize).toBeGreaterThanOrEqual(result.totalSize);
});

it('test_compression_ratio', () => {
  expect(compressionRatio({ totalSize: 100, compressedSize: 25 })).toBe(0.75);
  expect(compressionRatio({ totalSize: 0, compressedSize: 0 })).toBe(0);
});

it('test_export_nonexistent_dir', async () => {
  const { host } = await setup();
  await expect(exportBackupToZip(host.ctx, join(host.app.dataDir, 'missing'), {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false)).rejects.toThrow('Backup directory not found');
});

it('test_invalid_compression_level', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  await expect(exportBackupToZip(host.ctx, dir, {
    compressionLevel: 10, includeChecksums: true,
  }, () => undefined, () => false)).rejects.toThrow('Invalid compression level: 10 (must be 0-9)');
});

it('test_import_from_zip', async () => {
  // Rust zip_export.rs:2268-2314 的同形夹具：四个真实 SQLite 库、完整 manifest、其余域 absent。
  const created = await createBackupHost({
    secrets: true,
    storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
  });
  hosts.push(created);
  const { host } = created;
  const { dir } = makeFullSqliteBackup(host, 'import-flat');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const archive = await JSZip.loadAsync(readFileSync(result.zipPath));
  const target = join(host.app.dataDir, 'import-flat-target');
  const count = await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });

  // Rust :2622-2626：导入数量与归档条目数一致，且清单、VFS 库和 checksums 全部存在。
  expect(count).toBeGreaterThan(0);
  expect(count).toBe(Object.keys(archive.files).length);
  expect(existsSync(join(target, 'manifest.json'))).toBe(true);
  expect(existsSync(join(target, 'vfs.db'))).toBe(true);
  expect(existsSync(join(target, 'checksums.sha256'))).toBe(true);
  const imported = loadManifest(join(target, 'manifest.json'));
  // Rust :2629-2662：便携 ZIP 可导入检查，但不能替换槽，也不包含密钥/可执行技能。
  expect(imported.snapshot_kind).toBe('partial_overlay');
  expect(imported.key_policy).toBe('excluded_portable');
  expect(() => validateForSlotRestore(imported)).toThrow();
  expect(imported.coverage!.domains.crypto!.status).toBe('excluded');
  expect(imported.coverage!.domains['user-skills']!.status).toBe('excluded');
});

it('portable_import_preserves_settings_bytes', async () => {
  // 保留原 TS 用例的设置文件往返断言，Rust 测试名上方改用同形四库夹具。
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'restore-target');
  const count = await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(count).toBeGreaterThan(0);
  expect(readFileSync(join(target, 'persistent', 'webview_settings.json'), 'utf8')).toBe(FILES['persistent/webview_settings.json']);
});

it('test_resumable_import_unencrypted_zip_rejects_password', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'reject-password');
  await expect(importBackupFromZip(host.ctx, result.zipPath, target, {
    password: 'explicit-password', skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow('不是加密全保真备份');
  expect(existsSync(target)).toBe(false);
});

it('zip_contains_encrypted_secrets_distinguishes_portable_and_sealed', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const plain = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  expect(await zipContainsEncryptedSecrets(host.ctx, plain.zipPath)).toBe(false);

  const sealed = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
  }, () => undefined, () => false);
  expect(await zipContainsEncryptedSecrets(host.ctx, sealed.zipPath)).toBe(true);
});

it('sealed export stores seed plaintext and imports as full-fidelity manifest', async () => {
  const { host } = await setup();
  const seed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.secure/.key_seed': seed };
  const manifest = partialManifest('sealed-backup', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const dir = join(root, 'sealed-backup');

  const sealed = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
  }, () => undefined, () => false);
  const outer = await JSZip.loadAsync(readFileSync(sealed.zipPath));
  expect(Object.keys(outer.files)).toContain(ENCRYPTED_SECRETS_ENTRY);

  const target = join(host.app.dataDir, 'sealed-import');
  await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(readFileSync(join(target, 'crypto', '.secure', '.key_seed'), 'utf8')).toBe(seed);
  const imported = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { key_policy: string };
  expect(imported.key_policy).toBe('included_local');
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(false);
});

it('test_non_resumable_import_encrypted_zip_fails_early_without_password', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value' };
  const manifest = partialManifest('sealed-missing', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-missing'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-missing-target');
  const message = await rejectionMessage(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  }));
  // Rust zip_export.rs:3069-3076。
  expect(message).toContain('请提供导出时设置的备份密码后重试导入');
  expect(message).toContain(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
  expect(existsSync(target)).toBe(false);
});

it('test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct', async () => {
  const created = await createBackupHost({
    secrets: true,
    storageFactory: (dataDir, activeDir) => createRealStorage(activeDir, dataDir),
  });
  hosts.push(created);
  const { host } = created;
  // Rust :2963 使用完整四库备份；partial 夹具无法证明重试后可作完整恢复点。
  const { manifest, dir } = makeFullSqliteBackup(host, 'sealed-wrong');
  const seedPath = 'crypto/.secure/.key_seed';
  mkdirSync(join(dir, 'crypto', '.secure'), { recursive: true });
  writeFileSync(join(dir, seedPath), 'seed-value');
  const seed = readFileSync(join(dir, seedPath));
  manifest.files.push({ path: seedPath, size: seed.length, sha256: sha256(seed) });
  manifest.key_policy = 'included_local';
  updateCoverage(manifest, 'crypto', 'complete', [seedPath]);
  saveManifest(join(dir, 'manifest.json'), manifest);
  const sealed = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-wrong-target');
  const message = await rejectionMessage(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'wrong-password', skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  }));
  // Rust :2976-2989：拒绝文案/稳定码，并保留外层密文以便原地续传。
  expect(message).toContain('解封加密备份失败');
  expect(message).toContain(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  expect(statSync(join(target, ENCRYPTED_SECRETS_ENTRY)).isFile()).toBe(true);
  let sawSkip = false;
  const count = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: true,
    onProgress: progress => { if (progress.message.includes('跳过已存在')) sawSkip = true; },
    isCancelled: () => false,
  });
  // Rust :3006-3010：跳过完整外层条目、成功解封后删除载荷、恢复完整清单。
  expect(count).toBeGreaterThan(0);
  expect(sawSkip).toBe(true);
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(false);
  expect(() => validateForSlotRestore(loadManifest(join(target, 'manifest.json')))).not.toThrow();
  expect(readFileSync(join(target, 'crypto', '.secure', '.key_seed'), 'utf8')).toBe('seed-value');
});

it('test_export_cancel_token_set_midway_stops_export', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  let cancelled = false;
  let sawCompress = false;
  const output = join(host.app.dataDir, 'cancelled.zip');
  const error = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, outputPath: output,
  }, progress => {
    if (progress.phase === 'compress') { sawCompress = true; cancelled = true; }
  }, () => cancelled).then(() => null, (caught: unknown) => caught);
  // Rust zip_export.rs:3178-3198：真的进入压缩阶段，返回 IO(Interrupted)，不发布 ZIP。
  expect(sawCompress).toBe(true);
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('code', 'EINTR');
  expect(error).toHaveProperty('message', 'IO error: 用户取消导出');
  expect(existsSync(output)).toBe(false);
});

it('test_export_encrypted_cancelled_before_encrypt_skips_password_derivation', async () => {
  const { host, secrets } = await setup();
  const { dir } = makeBackup(host);
  const tempDir = join(host.app.dataDir, 'temp_zip_export');
  const outputPath = join(host.app.dataDir, 'cancel-before-encrypt.zip');
  let cancelled = false;
  // Rust :339-348：内层 ZIP 完成后才置取消位，不能退化成 scan 起点的预取消测试。
  const error = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1', outputPath,
  }, () => undefined, () => {
    if (existsSync(tempDir) && readdirSync(tempDir).some(name => name.startsWith('zip-seal-inner-'))) {
      cancelled = true;
    }
    return cancelled;
  }).then(() => null, (caught: unknown) => caught);

  expect(cancelled).toBe(true);
  expect(error).toMatchObject({ code: 'EINTR', message: 'IO error: 用户取消导出' });
  // 只观测 F4 加密接口的调用，不替换 ZIP 被测流程或自行实现加密。
  expect(secrets!.encrypted).toEqual([]);
  expect(readdirSync(tempDir)).toEqual([]);
  expect(existsSync(outputPath)).toBe(false);
});

it('test_export_progress_reports_all_phases_monotonically', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const phases: string[] = [];
  const progresses: number[] = [];
  await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, progress => { phases.push(progress.phase); progresses.push(progress.progress); }, () => false);
  expect(phases[0]).toBe('scan');
  expect(phases).toContain('compress');
  expect(phases).toContain('finalize');
  expect(phases[phases.length - 1]).toBe('completed');
  for (let index = 1; index < progresses.length; index++) {
    expect(progresses[index]!).toBeGreaterThanOrEqual(progresses[index - 1]!);
  }
});

it('test_import_cancelled_before_scan_leaves_target_untouched', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host);
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'cancelled-import');
  const phases: string[] = [];
  await expect(importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false,
    onProgress: progress => phases.push(progress.phase),
    isCancelled: () => true,
  })).rejects.toThrow('用户取消导入');
  expect(phases).toEqual(['scan']);
  expect(existsSync(target)).toBe(false);
});

it('test_import_cancel_midway_extract_leaves_no_partial_files', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'backup-cancel', {
    'persistent/extra-a.json': 'a',
    'persistent/extra-b.json': 'b',
  });
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const archive = await JSZip.loadAsync(readFileSync(result.zipPath));
  const entrySizes = new Map<string, number>();
  for (const [name, entry] of Object.entries(archive.files)) {
    if (!entry.dir) entrySizes.set(name, (await entry.async('uint8array')).length);
  }
  // Rust zip_export.rs:3468-3471：必须是多条目的归档，中途取消才有意义。
  expect(entrySizes.size).toBeGreaterThanOrEqual(2);
  const target = join(host.app.dataDir, 'midway-cancel');
  let cancelled = false;
  const error = await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false,
    onProgress: progress => {
      if (progress.phase === 'extract') cancelled = true;
    },
    isCancelled: () => cancelled,
  }).then(() => null, (caught: unknown) => caught);
  // Rust assert_import_cancelled :3319-3331：取消带 Interrupted 类型和用户取消标记。
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('code', 'EINTR');
  expect(error).toHaveProperty('message', 'IO error: 用户取消导入');
  const files: Array<{ name: string; path: string; size: number }> = [];
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else {
        files.push({ name: entry.name, path: relative(target, path).replace(/\\/g, '/'), size: statSync(path).size });
      }
    }
  }
  // Rust :3495-3515：至少完整写入一个条目但未写完全部，不能靠“目录不存在”空通过。
  expect(files.length).toBeGreaterThan(0);
  expect(files.length).toBeLessThan(entrySizes.size);
  for (const file of files) {
    expect(file.name.startsWith('.tmp')).toBe(false);
    expect(file.name.endsWith('.tmp')).toBe(false);
    expect(file.size).toBe(entrySizes.get(file.path));
  }
});

it('test_import_cancel_midway_then_resumable_retry_completes', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'backup-resume', {
    'persistent/extra-a.json': 'a',
    'persistent/extra-b.json': 'b',
  });
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'resume-target');
  let cancelled = false;
  await expect(importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: true,
    onProgress: progress => {
      if (progress.phase === 'extract' && progress.processedFiles >= 2) cancelled = true;
    },
    isCancelled: () => cancelled,
  })).rejects.toThrow('用户取消导入');
  const count = await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(count).toBeGreaterThan(0);
  expect(readFileSync(join(target, 'persistent', 'extra-a.json'), 'utf8')).toBe('a');
  expect(readFileSync(join(target, 'persistent', 'extra-b.json'), 'utf8')).toBe('b');
});

it('test_resumable_import_never_skips_manifest_json', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'backup-manifest');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'manifest-target');
  mkdirSync(target, { recursive: true });
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  const expectedManifest = await zip.file('manifest.json')!.async('string');
  writeFileSync(join(target, 'manifest.json'), 'x'.repeat(Buffer.byteLength(expectedManifest)));
  await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe(expectedManifest);
});

it('test_export_excludes_encrypted_user_skills_domain', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'persistent/user_skills/example/SKILL.md': '# executable user skill' };
  const manifest = partialManifest('backup-user-skills', { files });
  updateCoverage(manifest, 'user-skills', 'complete', ['persistent/user_skills/example/SKILL.md']);
  writeBackup(root, manifest, files);
  const result = await exportBackupToZip(host.ctx, join(root, 'backup-user-skills'), {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'user-skills.zip'),
  }, () => undefined, () => false);
  const zip = await JSZip.loadAsync(readFileSync(result.zipPath));
  expect(Object.keys(zip.files).some(name => name.startsWith('persistent/user_skills/'))).toBe(false);

  const target = join(host.app.dataDir, 'user-skills-import');
  await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  const portable = loadManifest(join(target, 'manifest.json'));
  expect(portable.coverage?.domains['user-skills']?.status).toBe('excluded');
});

it('test_import_rejects_symlinked_destination_parent', async () => {
  const { host } = await setup();
  const zip = new JSZip();
  zip.file('manifest.json', '{}');
  zip.file('linked/payload.bin', 'payload');
  const archivePath = join(host.app.dataDir, 'symlink-target.zip');
  writeFileSync(archivePath, await zip.generateAsync({ type: 'nodebuffer' }));

  const target = join(host.app.dataDir, 'symlink-import');
  const external = join(host.app.dataDir, 'symlink-external');
  mkdirSync(target, { recursive: true });
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(target, 'linked'));

  await expect(importBackupFromZip(host.ctx, archivePath, target, {
    password: null, skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  })).rejects.toThrow('ZIP 解压目标路径不允许包含符号链接');
  expect(existsSync(join(external, 'payload.bin'))).toBe(false);
});

it('test_sealed_payload_stores_key_seed_as_plaintext', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const seed = 'ab'.repeat(32);
  const files = { ...FILES, 'crypto/.secure/.key_seed': seed };
  const manifest = partialManifest('sealed-seed', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-seed'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-seed.zip'),
  }, () => undefined, () => false);

  const outer = await JSZip.loadAsync(readFileSync(sealed.zipPath));
  const payload = await outer.file(ENCRYPTED_SECRETS_ENTRY)!.async('nodebuffer');
  const payloadPath = join(host.app.dataDir, 'payload.dsbk');
  const innerPath = join(host.app.dataDir, 'payload-inner.zip');
  writeFileSync(payloadPath, payload);
  const secrets = (host.ctx as unknown as {
    secrets: { backup: { decryptBackupFile(input: string, output: string, password: string): Promise<void> } };
  }).secrets;
  await secrets.backup.decryptBackupFile(payloadPath, innerPath, 'portable-secret-1');
  const inner = await JSZip.loadAsync(readFileSync(innerPath));
  expect(await inner.file('crypto/.secure/.key_seed')!.async('string')).toBe(seed);
});

it('test_encrypted_export_imports_after_seed_manifest_sync', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const seed = 'ab'.repeat(32);
  const files = { ...FILES, 'crypto/.secure/.key_seed': seed };
  const manifest = partialManifest('sealed-sync', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  const seedRecord = manifest.files.find(file => file.path === 'crypto/.secure/.key_seed')!;
  seedRecord.size = seed.length + 335;
  seedRecord.sha256 = '0'.repeat(64);
  // 同步账本，使清单在加载时自洽；导出侧仍需把种子记录改回明文大小/哈希。
  manifest.coverage!.domains.crypto!.total_size = seedRecord.size;
  writeBackup(root, manifest, files);

  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-sync'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-sync.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-sync-import');
  await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(readFileSync(join(target, 'crypto', '.secure', '.key_seed'), 'utf8')).toBe(seed);
});

it('test_resumable_import_unencrypted_zip_succeeds_without_password', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'plain-resumable');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'plain-resumable.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'plain-resumable-target');
  const fileCount = await importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(fileCount).toBeGreaterThan(0);
  expect(existsSync(join(target, 'manifest.json'))).toBe(true);
});

it('test_resumable_import_encrypted_zip_requires_password_before_touching_target', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value' };
  const manifest = partialManifest('sealed-resume-missing', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-resume-missing'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-resume-missing.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-resume-missing-target');
  const message = await rejectionMessage(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: null, skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  }));
  // Rust zip_export.rs:2915-2920。
  expect(message).toContain('备份密码');
  expect(message).toContain(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
  expect(existsSync(target)).toBe(false);
});

it('test_resumable_import_encrypted_zip_with_password_restores_full_snapshot', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const manifest = fullManifest('sealed-full');
  writeBackup(root, manifest, fullBackupFiles(manifest));
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-full'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-full.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-full-target');
  const fileCount = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(fileCount).toBeGreaterThan(0);
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(false);
  expect(existsSync(join(target, 'checksums.sha256'))).toBe(false);
  const imported = loadManifest(join(target, 'manifest.json'));
  expect(imported.snapshot_kind).toBe('full');
  expect(imported.key_policy).toBe('not_present');
  expect(() => validateForSlotRestore(imported)).not.toThrow();
});

it('test_resumable_import_unseal_failure_cleans_partial_plaintext', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.master_key': 'master' };
  const manifest = partialManifest('sealed-cleanup', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.master_key'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-cleanup'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-cleanup.zip'),
  }, () => undefined, () => false);

  const target = join(host.app.dataDir, 'sealed-cleanup-target');
  const external = join(host.app.dataDir, 'sealed-cleanup-external');
  mkdirSync(target, { recursive: true });
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(target, 'crypto'));

  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: true, onProgress: () => undefined, isCancelled: () => false,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain('解封敏感数据中断');
  expect(error.message).toContain('已清理');
  expect(existsSync(join(external, '.master_key'))).toBe(false);
  expect(existsSync(join(target, 'manifest.json'))).toBe(false);
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(true);
});

it('test_non_resumable_progress_import_encrypted_zip_fails_early_without_password', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value' };
  const manifest = partialManifest('sealed-progress', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-progress'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-progress.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-progress-target');
  const phases: string[] = [];
  const message = await rejectionMessage(importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: null, skipExisting: false,
    onProgress: progress => phases.push(progress.phase), isCancelled: () => false,
  }));
  // Rust zip_export.rs:3112-3119。
  expect(message).toContain('请提供导出时设置的备份密码后重试导入');
  expect(message).toContain(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
  expect(phases).not.toContain('extract');
  expect(existsSync(target)).toBe(false);
});

it('test_non_resumable_import_encrypted_zip_with_password_still_succeeds', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const manifest = fullManifest('sealed-password-full');
  writeBackup(root, manifest, fullBackupFiles(manifest));
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-password-full'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-password-full.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-password-full-target');
  const fileCount = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: false, onProgress: () => undefined, isCancelled: () => false,
  });
  expect(fileCount).toBeGreaterThan(0);
  expect(() => validateForSlotRestore(loadManifest(join(target, 'manifest.json')))).not.toThrow();
});

it('test_export_encrypted_cancel_token_set_midway_stops_export', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'sealed-cancel');
  let cancelled = false;
  const output = join(host.app.dataDir, 'cancelled-encrypted.zip');
  await expect(exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: output,
  }, progress => {
    if (progress.phase === 'compress') cancelled = true;
  }, () => cancelled)).rejects.toThrow('用户取消导出');
  expect(existsSync(output)).toBe(false);
});

it('test_import_cancelled_after_scan_validation_extracts_nothing', async () => {
  const { host } = await setup();
  const { dir } = makeBackup(host, 'scan-cancel');
  const result = await exportBackupToZip(host.ctx, dir, {
    compressionLevel: 6, includeChecksums: true,
    outputPath: join(host.app.dataDir, 'scan-cancel.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'scan-cancel-target');
  let cancelled = false;
  const phases: string[] = [];
  await expect(importBackupFromZip(host.ctx, result.zipPath, target, {
    password: null, skipExisting: false,
    onProgress: progress => {
      phases.push(progress.phase);
      if (progress.phase === 'scan' && progress.totalFiles > 0) cancelled = true;
    },
    isCancelled: () => cancelled,
  })).rejects.toThrow('用户取消导入');
  expect(phases).not.toContain('extract');
  expect(existsSync(target)).toBe(false);
});

it('test_import_encrypted_cancelled_before_verify_keeps_sealed_payload', async () => {
  const { host } = await setup();
  const root = hostBackupRoot(host);
  const files = { ...FILES, 'crypto/.secure/.key_seed': 'seed-value' };
  const manifest = partialManifest('sealed-cancel-verify', {
    files, keyPolicy: 'included_local', cryptoPaths: ['crypto/.secure/.key_seed'],
  });
  writeBackup(root, manifest, files);
  const sealed = await exportBackupToZip(host.ctx, join(root, 'sealed-cancel-verify'), {
    compressionLevel: 6, includeChecksums: true, encryptionPassword: 'portable-secret-1',
    outputPath: join(host.app.dataDir, 'sealed-cancel-verify.zip'),
  }, () => undefined, () => false);
  const target = join(host.app.dataDir, 'sealed-cancel-verify-target');
  let cancelled = false;
  const error = await importBackupFromZip(host.ctx, sealed.zipPath, target, {
    password: 'portable-secret-1', skipExisting: false,
    onProgress: progress => { if (progress.phase === 'verify') cancelled = true; },
    isCancelled: () => cancelled,
  }).catch((cause: unknown) => cause as Error) as Error;
  expect(error.message).toContain('用户取消导入');
  expect(error.message).not.toContain(SEALED_BACKUP_PASSWORD_REQUIRED_CODE);
  expect(error.message).not.toContain(SEALED_BACKUP_DECRYPT_FAILED_CODE);
  expect(existsSync(join(target, ENCRYPTED_SECRETS_ENTRY))).toBe(true);
});

it('portable_exclusion_and_archive_policy_are_explicit', () => {
  for (const path of ['crypto/.secure/.key_seed', '.secure/a.enc', '.master_key', '.key_seed', 'databases/audit.db', 'persistent/user_skills/a.md']) {
    expect(isPortableExcludedRelativePath(path)).toBe(true);
  }
  expect(isPortableExcludedRelativePath('persistent/webview_settings.json')).toBe(false);
  expect(archivePolicyLimits()).toEqual({
    maxFiles: 100_000,
    maxUncompressedBytes: 20n * 1024n * 1024n * 1024n,
    maxCompressionRatio: 200,
  });
});

it('test_actual_copy_budget_rejects_more_bytes_than_declared_budget', () => {
  let total = 0n;
  expect(() => { total = copyWithActualSizeBudget(11n, total, 10n); }).toThrow(/实际解压总量超限/);
  expect(total).toBe(0n);
});

it('archive entry names follow Rust enclosed_name on POSIX: NUL and escaping names are out of bounds, a drive prefix is a plain name', () => {
  // zip 0.6.6 types.rs:383-398：含 NUL、根目录或 `..` 越过顶层时为 None（Rust 报「ZIP 包含越界或空路径」）。
  for (const name of ['a\0b', '/etc/passwd', '..', '../x', 'a/../../x']) expect(isUnsafeArchivePath(name), name).toBe(true);
  // 本端另外拒绝任何 `.`、`..`、空分量（Rust 解压时以「ZIP 包含不安全路径」拒绝）。
  for (const name of ['a/../b', './a', 'a//b', '']) expect(isUnsafeArchivePath(name), name).toBe(true);
  // POSIX 上 `C:` 只是普通文件名，与 Rust 相同。
  for (const name of ['C:/x', 'persistent/a.json']) expect(isUnsafeArchivePath(name), name).toBe(false);

  const info = (name: string) => ({ name, isDirectory: false, size: 2, compressedSize: 2, entry: {} as never });
  expect(() => validateSecretsArchive([info('manifest.json'), info('crypto/\0.master_key')]))
    .toThrow('密封载荷包含越界或空路径: crypto/\0.master_key');
  expect(() => validateSecretsArchive([info('manifest.json'), info('..')])).toThrow('密封载荷包含越界或空路径: ..');
});
