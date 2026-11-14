import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { getPersistentAppDataDir, getTempAppDataDir, getWritableAppDataDir } from '../file-manager.ts';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-persist-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

function thrownBy(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error('expected a throw');
}

const rootIgnoresModes = process.getuid?.() === 0 || process.platform === 'win32';

it('RF-W07-persistent-app-data-no-silent-relocation: an unusable active slot is an error for persistent data, never a relocation', () => {
  const osData = path.join(base, 'os-data');
  const temp = path.join(base, 'os-temp');
  const blocked = path.join(base, 'slot-is-a-file');
  fs.writeFileSync(blocked, 'not a directory');

  expect(thrownBy(() => getPersistentAppDataDir(blocked))).toMatchObject({
    error_type: 'FileSystem', message: expect.stringContaining(`持久数据目录不可用（创建目录失败）: ${blocked} (`),
  });
  expect(fs.existsSync(path.join(osData, 'DeepStudent'))).toBe(false);
  expect(fs.existsSync(path.join(temp, 'deep_student_data'))).toBe(false);

  expect(getTempAppDataDir(blocked, osData, temp)).toBe(path.join(osData, 'DeepStudent'));

  if (rootIgnoresModes) return;
  const readOnly = path.join(base, 'slot-ro');
  fs.mkdirSync(readOnly, { mode: 0o555 });
  try {
    expect(thrownBy(() => getPersistentAppDataDir(readOnly))).toMatchObject({
      error_type: 'FileSystem', message: expect.stringContaining(`持久数据目录不可用（目录不可写）: ${readOnly} (`),
    });
  } finally {
    fs.chmodSync(readOnly, 0o755);
  }
});

it('RF-W07-persistent-app-data-no-silent-relocation: a writable slot is returned unchanged and the probe is removed', () => {
  const slot = path.join(base, 'slots', 'slotA');
  expect(getPersistentAppDataDir(slot)).toBe(slot);
  expect(fs.statSync(slot).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(slot, '.write_test'))).toBe(false);
});

it('RF-W07-persistent-app-data-no-silent-relocation: temp callers and the deprecated getWritableAppDataDir keep the Rust fallback chain', () => {
  const osData = path.join(base, 'os-data');
  const temp = path.join(base, 'os-temp');
  const blocked = path.join(base, 'slot-is-a-file');
  fs.writeFileSync(blocked, 'x');
  fs.mkdirSync(osData, { recursive: true });
  fs.writeFileSync(path.join(osData, 'DeepStudent'), 'x');
  expect(getTempAppDataDir(blocked, osData, temp)).toBe(path.join(temp, 'deep_student_data'));
  expect(getWritableAppDataDir(blocked, osData, temp)).toBe(path.join(temp, 'deep_student_data'));
  expect(getWritableAppDataDir(blocked, null, temp)).toBe(path.join(temp, 'deep_student_data'));
});
