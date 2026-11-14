import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupOldBackups,
  createAutoBackupLock,
  createAutoBackupStagingDir,
  defaultBackupConfig,
  defaultRecoveryBackupDir,
  effectiveBackupDirectory,
  getEffectiveBackupDir,
  logAndSkipEntryErr,
  parseBackupConfig,
  serializeBackupConfig,
  type BackupConfig,
} from './backup-config.ts';

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dstu-backup-config-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it('test_backup_config_default_values', () => {
  const config = defaultBackupConfig();
  expect(config.backupDirectory).toBeNull();
  expect(config.autoBackupEnabled).toBe(false);
  expect(config.autoBackupIntervalHours).toBe(24);
  expect(config.maxBackupCount).toBe(5);
  expect(config.slimBackup).toBe(false);
  expect(config.backupTiers).toBeUndefined();
});

it('test_backup_config_serialization_roundtrip', () => {
  const config: BackupConfig = {
    backupDirectory: '/custom/path',
    autoBackupEnabled: true,
    autoBackupIntervalHours: 12,
    maxBackupCount: 10,
    slimBackup: true,
  };
  const parsed = parseBackupConfig(serializeBackupConfig(config));
  expect(parsed.backupDirectory).toBe(config.backupDirectory);
  expect(parsed.autoBackupEnabled).toBe(config.autoBackupEnabled);
  expect(parsed.autoBackupIntervalHours).toBe(config.autoBackupIntervalHours);
  expect(parsed.maxBackupCount).toBe(config.maxBackupCount);
  expect(parsed.slimBackup).toBe(config.slimBackup);
});

it('test_backup_config_deserialize_with_defaults', () => {
  const parsed = parseBackupConfig('{"autoBackupEnabled": false, "autoBackupIntervalHours": 48}');
  expect(parsed.autoBackupEnabled).toBe(false);
  expect(parsed.autoBackupIntervalHours).toBe(48);
  expect(parsed.backupDirectory).toBeNull();
  expect(parsed.maxBackupCount).toBeNull();
  expect(parsed.slimBackup).toBe(false);
  expect(parsed.backupTiers).toBeUndefined();
});

it('test_backup_config_camel_case_serialization', () => {
  const json = serializeBackupConfig(defaultBackupConfig());
  expect(json).toContain('autoBackupEnabled');
  expect(json).toContain('autoBackupIntervalHours');
  expect(json).toContain('maxBackupCount');
});

it('test_auto_backup_running_compare_exchange', () => {
  const lock = createAutoBackupLock();
  expect(lock.tryAcquire()).toBe(true);
  expect(lock.isRunning()).toBe(true);
  expect(lock.tryAcquire()).toBe(false);
  lock.release();
  expect(lock.tryAcquire()).toBe(true);
  lock.release();
});

it('test_get_effective_backup_dir_no_custom', async () => {
  const result = await getEffectiveBackupDir(defaultBackupConfig(), '/tmp/test_root');
  expect(result).toBe(join('/tmp/test_root', 'recovery', 'backups'));
});

it('test_default_backup_dir_escapes_runtime_slot', () => {
  expect(defaultRecoveryBackupDir('/tmp/app/slots/slotA')).toBe('/tmp/app/recovery/backups');
});

it('test_get_effective_backup_dir_custom_exists', async () => {
  const custom = await tempDir();
  const config: BackupConfig = { ...defaultBackupConfig(), backupDirectory: custom };
  expect(await getEffectiveBackupDir(config, '/tmp/test_root')).toBe(custom);
});

it('test_get_effective_backup_dir_custom_not_exists', async () => {
  const config: BackupConfig = { ...defaultBackupConfig(), backupDirectory: '/tmp/__nonexistent_custom_backup_dir_12345__' };
  await expect(getEffectiveBackupDir(config, '/tmp/test_root')).rejects.toMatchObject({
    appError: { error_type: 'FileSystem', message: '自定义备份目录不可用: /tmp/__nonexistent_custom_backup_dir_12345__。为避免误导，未回退到默认目录' },
  });
});

it('test_auto_backup_staging_is_under_app_data_not_custom_destination', async () => {
  const parent = await tempDir();
  const appDataRoot = join(parent, 'app-data');
  const customDestination = await tempDir();
  const config: BackupConfig = { ...defaultBackupConfig(), backupDirectory: customDestination };
  const effectiveDestination = await getEffectiveBackupDir(config, appDataRoot);
  const staging = await createAutoBackupStagingDir(appDataRoot);
  try {
    expect(effectiveDestination).toBe(customDestination);
    expect(staging.path.startsWith(appDataRoot)).toBe(true);
    expect(staging.path.startsWith(effectiveDestination)).toBe(false);
    expect(basename(staging.path).startsWith('auto-backup-staging-')).toBe(true);
  } finally {
    await staging.cleanup();
  }
});

it('test_cleanup_old_backups_removes_oldest', async () => {
  const backupDir = await tempDir();
  for (let i = 0; i < 5; i++) {
    await writeFile(join(backupDir, `auto-backup-2026-01-0${i + 1}.zip`), `backup content ${i}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await cleanupOldBackups(backupDir, 2);
  const remaining = (await readdir(backupDir)).filter(name => name.startsWith('auto-backup-') && name.endsWith('.zip'));
  expect(remaining).toHaveLength(2);
});

it('test_cleanup_old_backups_no_op_when_under_limit', async () => {
  const backupDir = await tempDir();
  for (let i = 0; i < 2; i++) await writeFile(join(backupDir, `auto-backup-2026-02-0${i + 1}.zip`), 'content');
  await cleanupOldBackups(backupDir, 5);
  expect(await readdir(backupDir)).toHaveLength(2);
});

it('test_cleanup_old_backups_ignores_non_auto_backups', async () => {
  const backupDir = await tempDir();
  await writeFile(join(backupDir, 'auto-backup-001.zip'), 'auto1');
  await writeFile(join(backupDir, 'auto-backup-002.zip'), 'auto2');
  await writeFile(join(backupDir, 'manual-backup-001.zip'), 'manual');
  await writeFile(join(backupDir, 'some-other-file.txt'), 'other');
  // 同一目录内连续写入的两个文件在部分文件系统（如 Linux ext4）上 mtime 相同，
  // 而 cleanup_old_backups 只按 mtime 排序；显式错开时间以确定"最旧"的是 001。
  await utimes(join(backupDir, 'auto-backup-001.zip'), 1_700_000_000, 1_700_000_000);
  await utimes(join(backupDir, 'auto-backup-002.zip'), 1_700_000_100, 1_700_000_100);
  await cleanupOldBackups(backupDir, 1);
  expect((await readdir(backupDir)).sort()).toEqual(['auto-backup-002.zip', 'manual-backup-001.zip', 'some-other-file.txt']);
});

it('test_log_and_skip_entry_err_ok', () => {
  expect(logAndSkipEntryErr({ ok: true, value: 'value' }, () => undefined)).toBe('value');
});

it('test_log_and_skip_entry_err_err', () => {
  let logged: unknown = null;
  expect(logAndSkipEntryErr({ ok: false, error: 'fail' }, error => { logged = error; })).toBeNull();
  expect(logged).toBe('fail');
});

it('test_effective_backup_directory_none', () => {
  expect(effectiveBackupDirectory(defaultBackupConfig())).toBeNull();
});

it('test_effective_backup_directory_existing', async () => {
  const dir = await tempDir();
  expect(effectiveBackupDirectory({ ...defaultBackupConfig(), backupDirectory: dir })).toBe(dir);
});

it('test_effective_backup_directory_nonexistent', () => {
  expect(effectiveBackupDirectory({ ...defaultBackupConfig(), backupDirectory: '/tmp/__nonexistent_dir_99999__' })).toBeNull();
});
