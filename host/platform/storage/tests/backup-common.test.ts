import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, expect, it } from 'vitest';
import type { AppError } from '../../errors/api.ts';
import {
  ZipSecurityCheck,
  MAX_FILE_COUNT,
  MAX_UNCOMPRESSED_SIZE,
  acquireProcessOperationLockAt,
  calculateBytesHash,
  calculateFileHash,
  checkDiskSpace,
  checkPathNotSymlink,
  checkZipSecurity,
  copyDirectorySafe,
  getAvailableDiskSpace,
  isCryptoSecretBackupRelativePath,
  isSymlink,
  logAndSkipEntryErr,
  stripCryptoSecretsFromBackupDir,
  stripCryptoSecretsFromBackupDirWith,
} from '../backup-common.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-backup-common-'));
  dirs.push(dir);
  return dir;
}
function caught(fn: () => void): AppError {
  try { fn(); }
  catch (error) { return error as AppError; }
  throw new Error('expected function to throw');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('process_operation_lock_blocks_a_second_holder', () => {
  const dir = tmp();
  const lockPath = path.join(dir, 'operation.lock');
  const firstSnapshot = { operation_id: 'first', kind: 'backup' as const, started_at: new Date().toISOString(), process_id: process.pid };
  const secondSnapshot = { operation_id: 'second', kind: 'restore' as const, started_at: new Date().toISOString(), process_id: process.pid };

  const first = acquireProcessOperationLockAt(lockPath, firstSnapshot);
  const error = caught(() => acquireProcessOperationLockAt(lockPath, secondSnapshot));
  expect(error.message).toContain('另一个客户端进程');
  expect(error.message).toContain('"operation_id":"first"');

  first.release();
  const second = acquireProcessOperationLockAt(lockPath, secondSnapshot);
  second.release();
});

it('test_calculate_file_hash_known_content', () => {
  const file = path.join(tmp(), 'hash.txt');
  fs.writeFileSync(file, 'hello world');
  expect(calculateFileHash(file)).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});

it('test_calculate_file_hash_empty_file', () => {
  const file = path.join(tmp(), 'empty.txt');
  fs.writeFileSync(file, '');
  expect(calculateFileHash(file)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

it('test_calculate_file_hash_nonexistent_file', () => {
  const error = caught(() => calculateFileHash('/tmp/__nonexistent_file_for_test_12345__'));
  expect(error.message).toContain('打开文件计算哈希失败');
});

it('test_calculate_bytes_hash', () => {
  expect(calculateBytesHash(Buffer.from('hello world'))).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
});

it('test_strip_crypto_secrets_removes_all_sensitive_entries', () => {
  const backupDir = tmp();
  fs.mkdirSync(path.join(backupDir, 'crypto/.secure'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, '.secure'), { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'crypto/.master_key'), 'secret');
  fs.writeFileSync(path.join(backupDir, '.secure/credential.enc'), 'secret');
  fs.writeFileSync(path.join(backupDir, '.master_key'), 'secret');
  fs.writeFileSync(path.join(backupDir, '.key_seed'), 'secret');
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), '{}');

  expect(stripCryptoSecretsFromBackupDir(backupDir)).toBe(4);
  for (const name of ['crypto', '.secure', '.master_key', '.key_seed']) {
    expect(fs.existsSync(path.join(backupDir, name))).toBe(false);
  }
  expect(fs.statSync(path.join(backupDir, 'manifest.json')).isFile()).toBe(true);
});

it('test_strip_crypto_secrets_fails_closed_on_removal_error', () => {
  const backupDir = tmp();
  fs.mkdirSync(path.join(backupDir, 'crypto'));
  const error = caught(() => stripCryptoSecretsFromBackupDirWith(backupDir, () => { throw new Error('forced removal failure'); }));
  expect(error.message).toContain('剥离备份敏感条目失败');
  expect(fs.statSync(path.join(backupDir, 'crypto')).isDirectory()).toBe(true);
});

it('test_strip_crypto_secrets_fails_closed_when_entry_remains', () => {
  const backupDir = tmp();
  fs.writeFileSync(path.join(backupDir, '.master_key'), 'secret');
  const error = caught(() => stripCryptoSecretsFromBackupDirWith(backupDir, () => {}));
  expect(error.message).toContain('备份敏感条目删除后仍然存在');
  expect(fs.statSync(path.join(backupDir, '.master_key')).isFile()).toBe(true);
});

it('test_crypto_secret_relative_path_matching_is_component_scoped', () => {
  for (const relative of ['crypto', 'crypto/.secure/.key_seed', '.secure/credential.enc', '.master_key', '.key_seed']) {
    expect(isCryptoSecretBackupRelativePath(relative)).toBe(true);
  }
  for (const relative of ['crypto-not-secret/file.bin', 'assets/crypto/file.bin', 'assets/.master_key']) {
    expect(isCryptoSecretBackupRelativePath(relative)).toBe(false);
  }
});

it('test_strip_crypto_secrets_matches_ascii_case_variants', () => {
  const backupDir = tmp();
  fs.mkdirSync(path.join(backupDir, 'CRYPTO'));
  fs.writeFileSync(path.join(backupDir, 'CRYPTO/key.bin'), 'secret');

  expect(stripCryptoSecretsFromBackupDir(backupDir)).toBe(1);
  expect(fs.existsSync(path.join(backupDir, 'CRYPTO'))).toBe(false);
});

it('test_strip_crypto_secrets_removes_symlink_without_touching_target', () => {
  const backupDir = tmp();
  const targetDir = tmp();
  fs.writeFileSync(path.join(targetDir, 'keep.txt'), 'keep');
  fs.symlinkSync(targetDir, path.join(backupDir, '.secure'));

  expect(stripCryptoSecretsFromBackupDir(backupDir)).toBe(1);
  expect(fs.existsSync(path.join(backupDir, '.secure'))).toBe(false);
  expect(fs.statSync(path.join(targetDir, 'keep.txt')).isFile()).toBe(true);
});

it('test_strip_crypto_secrets_rejects_symlinked_backup_root', () => {
  const parent = tmp();
  const target = tmp();
  fs.mkdirSync(path.join(target, 'crypto'));
  const linkedRoot = path.join(parent, 'linked-backup');
  fs.symlinkSync(target, linkedRoot);

  const error = caught(() => stripCryptoSecretsFromBackupDir(linkedRoot));
  expect(error.message).toContain('备份目录必须是普通目录');
  expect(fs.statSync(path.join(target, 'crypto')).isDirectory()).toBe(true);
});

it('test_check_zip_security_normal_zip', async () => {
  const file = path.join(tmp(), 'normal.zip');
  const zip = new JSZip();
  zip.file('test.txt', 'hello zip content');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  fs.writeFileSync(file, bytes);

  const check = await checkZipSecurity(file);
  check.validate();
  expect(check.file_count).toBe(1);
  expect(check.total_uncompressed_size).toBe(17);
  expect(check.total_compressed_size).toBe(bytes.length);
  expect(check.compression_ratio).toBe(17 / bytes.length);
  expect(check.largest_file_size).toBe(17);
  expect(check.largest_file_name).toBe('test.txt');
});

it('test_check_zip_security_deflate_entry_reports_uncompressed_size', async () => {
  const file = path.join(tmp(), 'deflate.zip');
  const zip = new JSZip();
  zip.file('a.txt', 'a'.repeat(1024));
  zip.file('b.txt', 'hello');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

  const check = await checkZipSecurity(file);
  expect(check.file_count).toBe(2);
  expect(check.total_uncompressed_size).toBe(1029);
  expect(check.largest_file_size).toBe(1024);
  expect(check.largest_file_name).toBe('a.txt');
});

it('test_check_zip_security_rejects_oversized_file', () => {
  const check = new ZipSecurityCheck({
    total_uncompressed_size: MAX_UNCOMPRESSED_SIZE + 1,
    total_compressed_size: 1024,
    file_count: 1,
    compression_ratio: (MAX_UNCOMPRESSED_SIZE + 1) / 1024,
    largest_file_size: MAX_UNCOMPRESSED_SIZE + 1,
    largest_file_name: 'bomb.bin',
  });
  expect(caught(() => check.validate()).message).toContain('ZIP 文件解压后大小');
});

it('test_check_zip_security_rejects_extreme_ratio', () => {
  const check = new ZipSecurityCheck({
    total_uncompressed_size: 100_000_000,
    total_compressed_size: 100,
    file_count: 1,
    compression_ratio: 1_000_000,
    largest_file_size: 100_000_000,
    largest_file_name: 'bomb.bin',
  });
  expect(caught(() => check.validate()).message).toContain('ZIP 炸弹检测');
});

it('test_check_zip_security_rejects_too_many_files', () => {
  const check = new ZipSecurityCheck({
    total_uncompressed_size: 1024,
    total_compressed_size: 512,
    file_count: MAX_FILE_COUNT + 1,
    compression_ratio: 2.0,
    largest_file_size: 1024,
    largest_file_name: 'file.txt',
  });
  expect(caught(() => check.validate()).message).toContain('超过最大限制');
});

it('test_is_symlink_regular_file', () => {
  const file = path.join(tmp(), 'regular.txt');
  fs.writeFileSync(file, 'x');
  expect(isSymlink(file)).toBe(false);
});

it('test_is_symlink_actual_symlink', () => {
  const dir = tmp();
  const target = path.join(dir, 'target.txt');
  fs.writeFileSync(target, 'target content');
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(target, link);
  expect(isSymlink(link)).toBe(true);
  expect(isSymlink(target)).toBe(false);
});

it('test_get_available_disk_space_current_dir', () => {
  expect(getAvailableDiskSpace('.')).toBeGreaterThan(0);
});

it('check_disk_space_adds_twenty_percent_margin_and_reports_gb', () => {
  const available = getAvailableDiskSpace('.');
  expect(() => checkDiskSpace('.', Math.floor(available / 2))).not.toThrow();
  const error = caught(() => checkDiskSpace('.', available));
  expect(error.message).toContain('磁盘空间不足');
  expect(error.message).toMatch(/需要 \d+\.\d{2} GB，可用 \d+\.\d{2} GB/);
});

it('check_disk_space_fails_closed_on_budget_overflow', () => {
  const error = caught(() => checkDiskSpace('.', Number.MAX_SAFE_INTEGER));
  expect(error.message).toBe('磁盘空间预算溢出');
});

it('test_log_and_skip_entry_err_ok_value', () => {
  expect(logAndSkipEntryErr({ ok: true, value: 42 })).toBe(42);
});

it('test_log_and_skip_entry_err_err_value', () => {
  expect(logAndSkipEntryErr({ ok: false, error: 'some error' })).toBeUndefined();
});

it('test_copy_directory_safe_basic', () => {
  const srcDir = tmp();
  const dstDir = tmp();
  fs.writeFileSync(path.join(srcDir, 'hello.txt'), 'hello copy');
  fs.mkdirSync(path.join(srcDir, 'subdir'));
  fs.writeFileSync(path.join(srcDir, 'subdir/nested.txt'), 'nested content');

  const bytes = copyDirectorySafe(srcDir, dstDir);
  expect(bytes).toBeGreaterThan(0);
  const dirName = path.basename(srcDir);
  expect(fs.existsSync(path.join(dstDir, dirName, 'hello.txt'))).toBe(true);
  expect(fs.existsSync(path.join(dstDir, dirName, 'subdir/nested.txt'))).toBe(true);
});

it('test_copy_directory_safe_skips_symlinks', () => {
  const srcDir = tmp();
  const dstDir = tmp();
  fs.writeFileSync(path.join(srcDir, 'normal.txt'), 'normal');
  fs.symlinkSync(path.join(srcDir, 'normal.txt'), path.join(srcDir, 'link.txt'));

  expect(copyDirectorySafe(srcDir, dstDir)).toBeGreaterThan(0);
  const dirName = path.basename(srcDir);
  expect(fs.existsSync(path.join(dstDir, dirName, 'normal.txt'))).toBe(true);
  expect(fs.existsSync(path.join(dstDir, dirName, 'link.txt'))).toBe(false);
});

it('test_check_path_not_symlink_regular_file', () => {
  const file = path.join(tmp(), 'regular.txt');
  fs.writeFileSync(file, 'x');
  expect(() => checkPathNotSymlink(file)).not.toThrow();
});

it('test_check_path_not_symlink_rejects_symlink', () => {
  const dir = tmp();
  const target = path.join(dir, 'target.txt');
  fs.writeFileSync(target, 'content');
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(target, link);
  expect(caught(() => checkPathNotSymlink(link)).message).toContain('是符号链接');
});
