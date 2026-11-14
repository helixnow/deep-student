/**
 * Windows 卷 GUID 路径 `\\?\Volume{…}\`、`\\.\Volume{…}\` 与 NT 设备路径 `\\?\GLOBALROOT\Device\HarddiskVolumeN\`、
 * `\\.\GLOBALROOT\…`：它们和 `C:\` 指向同一个卷，受保护目录换这种写法仍被 deny（A14 复核 W23-28d9d042 交付后跟进第 3 条）。
 * 用假文件系统（`volumes` 把卷名映射到 `C:`）。
 */
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const VOLUME = 'Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}';
const DEVICE = 'GLOBALROOT\\Device\\HarddiskVolume3';

function scopes() {
  const fs = fakeScopeFs({
    platform: 'win32',
    entries: [win32.join(winAppData, 'notes.txt'), win32.join(winAppData, 'plugins', 'user.profile.json'), win32.join(winAppData, 'slots', 'a', 'browser-profiles', 'Default', 'Cookies')],
    volumes: { [VOLUME]: 'C:', [DEVICE]: 'C:' },
  });
  const global = new FsScope({ platform: 'win32', fs });
  global.allowPattern(winAppData);
  global.allowPattern(win32.join(winAppData, '**'));
  global.forbidPattern(win32.join(winAppData, 'plugins'));
  global.forbidPattern(win32.join(winAppData, 'plugins', '**'));
  global.forbidPattern(win32.join(winAppData, 'slots', '*', 'browser-profiles'));
  global.forbidPattern(win32.join(winAppData, 'slots', '*', 'browser-profiles', '**'));
  const runtime = new FsScope({ platform: 'win32', fs });
  runtime.allowDirectory('C:\\', true);
  /** `plugins/fs.ts` `resolvePath`: deny of either scope first, then the runtime allow. */
  const allowed = (path: string) => !runtime.isForbidden(path) && !global.isForbidden(path) && runtime.isAllowed(path);
  return { fs, global, allowed };
}

const spellings = (path: string) => [
  path.replace(/^C:/, `\\\\?\\${VOLUME}`),
  path.replace(/^C:/, `\\\\.\\${VOLUME}`),
  path.replace(/^C:/, `\\\\?\\${DEVICE}`),
  path.replace(/^C:/, `\\\\.\\${DEVICE}`),
];

describe('Windows volume GUID and GLOBALROOT device paths', () => {
  it('the fake file system resolves them to the drive like libuv realpath', () => {
    const { fs } = scopes();
    for (const request of spellings(win32.join(winAppData, 'notes.txt'))) {
      expect(fs.realpath(request), request).toBe(win32.join(winAppData, 'notes.txt'));
    }
  });

  it('protected directories stay denied under every volume spelling, existing or not', () => {
    const { global, allowed } = scopes();
    for (const target of [
      win32.join(winAppData, 'plugins'),
      win32.join(winAppData, 'plugins', 'user.profile.json'),
      win32.join(winAppData, 'plugins', 'new.mjs'),
      win32.join(winAppData, 'slots', 'a', 'browser-profiles', 'Default', 'Cookies'),
      win32.join(winAppData, 'slots', 'b', 'browser-profiles', 'Default', 'Cookies'),
    ]) {
      for (const request of spellings(target)) {
        expect(global.isForbidden(request), request).toBe(true);
        expect(allowed(request), request).toBe(false);
      }
    }
  });

  it('other files under the same spellings are still allowed', () => {
    const { allowed } = scopes();
    for (const target of [win32.join(winAppData, 'notes.txt'), win32.join(winAppData, 'new-notes.txt')]) {
      for (const request of spellings(target)) expect(allowed(request), request).toBe(true);
    }
  });
});
