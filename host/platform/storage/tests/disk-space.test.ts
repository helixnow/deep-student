import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../errors/api.ts';
import * as backupCommon from '../backup-common.ts';
import * as dataSpaceFiles from '../data-space-files.ts';
import { availableDiskSpace, type DiskSpaceSystem } from '../disk-space.ts';
import { setStorageLogger, type StorageLogLevel } from '../logging.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-disk-space-'));
  dirs.push(dir);
  return dir;
}

let lines: { target: string; level: StorageLogLevel; message: string }[] = [];
function captureLogs(): void {
  lines = [];
  setStorageLogger((target) => {
    const at = (level: StorageLogLevel) => (message: string) => { lines.push({ target, level, message }); };
    return { target, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') };
  });
}
afterEach(() => {
  setStorageLogger(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory, statfs'), { code: 'ENOENT', errno: -2, syscall: 'statfs' });
}
const failingStatfs: DiskSpaceSystem['statfs'] = () => { throw enoent(); };

/** 真实目录存在性 + 注入的系统调用与命令输出。 */
function probe(target: string, system: Partial<DiskSpaceSystem>): number {
  return availableDiskSpace(target, {
    platform: 'linux',
    env: {},
    exists: (file) => fs.existsSync(file),
    statfs: failingStatfs,
    run: () => ({ status: 1, stdout: '' }),
    ...system,
  });
}

function recordingRun(stdout: string, status: number | null = 0) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: DiskSpaceSystem['run'] = (command, args) => {
    calls.push({ command, args });
    return { status, stdout };
  };
  return { calls, run };
}

const DF_OUTPUT = 'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1      102400000 51200000  12345678  51% /\n';

describe('backup_common::get_available_disk_space', () => {
  it('the backup plugin and the migration preflight share the Node implementation', () => {
    expect(backupCommon.getAvailableDiskSpace).toBe(dataSpaceFiles.getAvailableDiskSpace);
    expect(dataSpaceFiles.getAvailableDiskSpace(tmp())).toBeGreaterThan(0);
  });

  it('returns f_bavail × block size from the system call and logs it like statvfs', () => {
    const dir = tmp();
    captureLogs();
    const { calls, run } = recordingRun(DF_OUTPUT);
    const available = probe(dir, { platform: 'linux', env: {}, statfs: () => ({ bavail: 3n, bsize: 4096n }), run });
    expect(available).toBe(12288);
    expect(calls).toEqual([]);
    expect(lines).toEqual([{
      target: 'dstu_storage::backup_common',
      level: 'debug',
      message: `[BackupCommon] statvfs 成功: path=${dir}, available=12288 bytes (0.00 GB)`,
    }]);
  });

  it('probes the parent when the target does not exist yet', () => {
    const dir = tmp();
    const seen: string[] = [];
    probe(path.join(dir, 'not-yet'), { platform: 'linux', env: {}, statfs: (p) => { seen.push(p); return { bavail: 1, bsize: 1 }; } });
    expect(seen).toEqual([dir]);
  });

  it('falls back to `df -k` on POSIX when statvfs fails, with the Rust warning text', () => {
    const dir = tmp();
    captureLogs();
    const { calls, run } = recordingRun(DF_OUTPUT);
    expect(probe(dir, { platform: 'linux', env: {}, statfs: failingStatfs, run })).toBe(12345678 * 1024);
    expect(calls).toEqual([{ command: 'df', args: ['-k', dir] }]);
    expect(lines.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: 'warn',
        message: `[BackupCommon] statvfs 调用失败，回退到 df 命令解析: statvfs 调用失败 (path=${JSON.stringify(dir)}): No such file or directory (os error 2)`,
      },
      { level: 'debug', message: '[BackupCommon] df 回退成功: available=12345678 KB' },
    ]);
  });

  it('falls back to wmic for the drive on Windows when GetDiskFreeSpaceExW fails', () => {
    captureLogs();
    const { calls, run } = recordingRun('FreeSpace      \r\n987654321      \r\n\r\n');
    const missing = path.join(tmp(), 'gone', 'deeper');
    const available = probe(missing, { platform: 'win32', env: {}, statfs: failingStatfs, run });
    expect(available).toBe(987654321);
    expect(calls).toEqual([{ command: 'wmic', args: ['logicaldisk', 'where', "DeviceID='C:'", 'get', 'FreeSpace'] }]);
    expect(lines.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: 'warn',
        message: '[BackupCommon] GetDiskFreeSpaceExW 调用失败，回退到命令行解析: GetDiskFreeSpaceExW 调用失败 (path="C:\\\\"): ENOENT: no such file or directory, statfs',
      },
      { level: 'debug', message: '[BackupCommon] wmic 回退成功: available=987654321 bytes' },
    ]);
  });

  it.each([
    ['a non-zero df exit', DF_OUTPUT, 1],
    ['a df that never ran', DF_OUTPUT, null],
    ['a single-line df output', 'Filesystem 1K-blocks Used Available Use% Mounted on\n', 0],
    ['a short data row', 'Filesystem 1K-blocks Used Available\n/dev/sda1 1 2\n', 0],
    ['a signed number', 'h\n/dev/sda1 1 2 -5 1% /\n', 0],
    ['an exponent', 'h\n/dev/sda1 1 2 1e3 1% /\n', 0],
    ['a hex number', 'h\n/dev/sda1 1 2 0x10 1% /\n', 0],
    ['a fraction', 'h\n/dev/sda1 1 2 1.5 1% /\n', 0],
  ] as const)('refuses to guess after %s unless BACKUP_ALLOW_UNKNOWN_DISK_SPACE is set', (_label, stdout, status) => {
    const dir = tmp();
    captureLogs();
    const { run } = recordingRun(stdout, status);
    let caught: unknown;
    try { probe(dir, { platform: 'darwin', env: {}, statfs: failingStatfs, run }); }
    catch (error) { caught = error; }
    expect(caught).toEqual(AppError.validation('无法获取磁盘可用空间。请检查文件系统权限，或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以使用保守估计值。'));
    expect(lines.at(-1)).toEqual({
      target: 'dstu_storage::backup_common',
      level: 'error',
      message: '无法获取磁盘可用空间，为确保数据安全，操作已中止。请检查文件系统权限或设置 BACKUP_ALLOW_UNKNOWN_DISK_SPACE=1 环境变量以启用回退模式。',
    });
  });

  it('accepts a leading plus like Rust u64 parsing', () => {
    const { run } = recordingRun('h\n/dev/sda1 1 2 +7 1% /\n');
    expect(probe(tmp(), { platform: 'linux', env: {}, statfs: failingStatfs, run })).toBe(7 * 1024);
  });

  it.each(['1', 'true', 'TRUE'])('uses the 1GB estimate when BACKUP_ALLOW_UNKNOWN_DISK_SPACE=%s', (value) => {
    captureLogs();
    const { run } = recordingRun('', 1);
    expect(probe(tmp(), { platform: 'linux', env: { BACKUP_ALLOW_UNKNOWN_DISK_SPACE: value }, statfs: failingStatfs, run }))
      .toBe(1024 * 1024 * 1024);
    expect(lines.at(-1)).toMatchObject({
      level: 'warn',
      message: '无法获取磁盘可用空间，使用保守估计值 1GB（已通过环境变量启用回退模式）。如果操作失败，请确保磁盘有足够空间后重试。',
    });
  });

  it('ignores other BACKUP_ALLOW_UNKNOWN_DISK_SPACE values', () => {
    const { run } = recordingRun('', 1);
    let caught: unknown;
    try { probe(tmp(), { platform: 'linux', env: { BACKUP_ALLOW_UNKNOWN_DISK_SPACE: 'yes' }, statfs: failingStatfs, run }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ error_type: 'Validation' });
  });
});
