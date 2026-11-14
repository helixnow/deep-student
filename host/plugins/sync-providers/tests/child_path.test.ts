import { posix, win32 } from 'node:path';
import { expect, it } from 'vitest';
import { childPath } from '../index.ts';

it('childPath matches Path::join / node:path join for normalized app data dirs', () => {
  for (const dir of ['/', '/Users/ann/Library/Application Support/deep-student', '/data/app/']) {
    expect(childPath(dir, '.cloud-encrypted-roots.json')).toBe(posix.join(dir, '.cloud-encrypted-roots.json'));
  }
  for (const dir of ['C:\\', 'C:\\Users\\ann\\AppData\\Roaming\\deep-student', 'D:\\data\\', '\\\\server\\share\\ds']) {
    expect(childPath(dir, '.cloud-encrypted-roots.json')).toBe(win32.join(dir, '.cloud-encrypted-roots.json'));
  }
});
