/**
 * 启动恢复外壳里的 IO 错误文案：Rust `set_failure(op, &e)` / `record_startup_recovery_error` 写入
 * `io::Error::to_string()`（`<strerror> (os error N)`，不带路径和 syscall），Node 原文是
 * `EEXIST: file already exists, mkdir '<abs>'`。G3 比对 `recovery_error`，前端恢复页也直接展示它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { errorText } from '../data-space-files.ts';
import { DataSpace } from '../locations.ts';
import { DataSpaceStartup } from '../startup.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-startup-io-text-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

it.skipIf(!posix)('recovery/backups being a regular file fails data_space_init with the Rust io::Error text', async () => {
  // backup 种子 l21-backups-path-is-file：数据空间已完成旧版迁移，recovery/backups 是普通文件。
  const space = new DataSpace(base);
  fs.mkdirSync(space.slotDir('slotA'), { recursive: true });
  fs.writeFileSync(path.join(space.slotDir('slotA'), 'mistakes.db'), 'a');
  space.writeState({ active: 'slotA', pending: null });
  fs.writeFileSync(path.join(space.slotsDir, '.legacy_migration_complete'), '1');
  fs.mkdirSync(path.join(base, 'recovery'));
  fs.writeFileSync(path.join(base, 'recovery/backups'), 'not a directory\n');

  const startup = new DataSpaceStartup(base, { recover: async () => {} } as never);
  await startup.start();

  const status = startup.status();
  expect(status.recovery_required).toBe(true);
  // data_space.rs:1212 `fs::create_dir_all(&destination_root)?` → lib.rs:969 `set_failure("data_space_init", &e)`.
  expect(status.incident?.failed_operation).toBe('data_space_init');
  expect(status.incident?.recovery_error).toBe('File exists (os error 17)');
  expect(status.incident?.retry_requires_restart).toBe(true);
});

it.skipIf(!posix)('errorText renders Node fs errors as Rust io::Error Display and leaves other errors untouched', () => {
  let caught: unknown;
  try { fs.readFileSync(path.join(base, 'missing.json')); } catch (error) { caught = error; }
  expect(errorText(caught)).toBe('No such file or directory (os error 2)');
  expect(errorText(new Error('数据迁移失败 (1 个错误): x'))).toBe('数据迁移失败 (1 个错误): x');
  expect(errorText('启动阶段数据清理不完整')).toBe('启动阶段数据清理不完整');
});
