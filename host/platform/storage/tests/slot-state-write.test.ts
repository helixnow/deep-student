/**
 * `atomic_write_state_file`（data_space.rs:1571-1595）：临时文件 fsync + persist 后，父目录 fsync 是尽力而为，
 * `File::open` 与 `sync_all` 的错误都被忽略（不支持目录 fsync 的外置盘、网络盘）。替换已经完成，
 * 不能因为目录 fsync 失败就把一次成功的切槽 / 启动写入报成失败。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DataSpace } from '../locations.ts';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-slot-state-write-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function failDirectorySync(dir: string, failOpen: boolean): { attempts: () => number } {
  const realOpen = fs.openSync, realSync = fs.fsyncSync;
  const dirFds = new Set<number>();
  let attempts = 0;
  vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
    if (file === dir) {
      attempts++;
      if (failOpen) throw Object.assign(new Error(`EACCES: permission denied, open '${dir}'`), { code: 'EACCES', errno: -13 });
      const fd = realOpen(file, flags ?? 'r', mode);
      dirFds.add(fd);
      return fd;
    }
    return realOpen(file, flags ?? 'r', mode);
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
    if (dirFds.has(fd)) throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL', errno: -22 });
    realSync(fd);
  });
  return { attempts: () => attempts };
}

it.skipIf(process.platform === 'win32')('writeState succeeds when the slots directory cannot be fsynced, like Rust', () => {
  const space = new DataSpace(base);
  space.writeState({ active: 'slotA', pending: null });
  const probe = failDirectorySync(space.slotsDir, false);
  expect(() => space.writeState({ active: 'slotA', pending: 'slotB' })).not.toThrow();
  expect(probe.attempts()).toBe(1);
  vi.restoreAllMocks();
  expect(space.readState()).toEqual({ active: 'slotA', pending: 'slotB' });
  expect(fs.readdirSync(space.slotsDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

it.skipIf(process.platform === 'win32')('writeState succeeds when the slots directory cannot be opened for fsync, like Rust', () => {
  const space = new DataSpace(base);
  space.writeState({ active: 'slotA', pending: null });
  const probe = failDirectorySync(space.slotsDir, true);
  expect(() => space.writeState({ active: 'slotB', pending: null })).not.toThrow();
  expect(probe.attempts()).toBe(1);
  vi.restoreAllMocks();
  expect(space.readState()).toEqual({ active: 'slotB', pending: null });
});
