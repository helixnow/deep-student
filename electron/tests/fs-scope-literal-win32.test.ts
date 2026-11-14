/**
 * Windows：不存在的路径的字面形态按 Node 实际交给系统的写法（`path.win32.normalize`）取，设备前缀或 UNC 前缀后多一个
 * 分隔符（`\\.\\C:\…`、`\\srv\\share\…`）不会被压成无盘符的根路径 `\C:\…`（A14 复核 W23-28d9d042 交付后跟进第 1 条）。
 */
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';

function scopes() {
  const fs = fakeScopeFs({ platform: 'win32', entries: [win32.join(winAppData, 'notes.txt'), win32.join(winAppData, 'slots', 'a', 'chat_v2.db')] });
  const global = new FsScope({ platform: 'win32', fs });
  global.allowPattern(winAppData);
  global.allowPattern(win32.join(winAppData, '**'));
  global.forbidPattern(win32.join(winAppData, 'plugins'));
  global.forbidPattern(win32.join(winAppData, 'plugins', '**'));
  global.forbidPattern(win32.join(winAppData, 'slots', '*', 'browser-profiles'));
  global.forbidPattern(win32.join(winAppData, 'slots', '*', 'browser-profiles', '**'));
  // The user dropped the C: drive into the window (main.ts allowDirectory(path, true)) or picked it in a directory dialog.
  const runtime = new FsScope({ platform: 'win32', fs });
  runtime.allowDirectory('C:\\', true);
  /** `plugins/fs.ts` `resolvePath`: deny of either scope first, then the runtime allow. */
  const allowed = (path: string) => !runtime.isForbidden(path) && !global.isForbidden(path) && runtime.isAllowed(path);
  return { global, runtime, allowed };
}

describe('Windows literal form of a missing path', () => {
  it('RF-W23-fs-scope-literal-win32-normalize: an extra separator after the \\\\.\\ device prefix keeps the drive, so the deny still matches', () => {
    const { global, allowed } = scopes();
    const device = winAppData.replace(/^C:/, '\\\\.\\\\C:');
    for (const request of [
      `${device}\\plugins`,
      `${device}\\plugins\\user.profile.json`,
      `${device.replace('\\\\.\\\\', '\\\\.\\\\\\')}\\plugins.`,
      `${device}\\slots\\a\\browser-profiles\\Default\\Cookies`,
      `${device.replace('\\\\.\\\\', '//.//')}/plugins/user.profile.json`,
    ]) {
      expect(global.isForbidden(request), request).toBe(true);
      expect(allowed(request), request).toBe(false);
    }
    expect(allowed(`${device}\\notes.txt`)).toBe(true);
    expect(allowed(`${device}\\new.md`)).toBe(true);
  });

  it('RF-W23-fs-scope-literal-win32-normalize: an extra separator after a UNC server name stays a UNC path (not C:\\<server>\\…)', () => {
    const { allowed } = scopes();
    for (const request of [`\\\\localhost\\\\C$${winAppData.slice(2)}\\plugins`, `\\\\localhost\\\\C$${winAppData.slice(2)}\\plugins\\user.profile.json`]) {
      expect(allowed(request), request).toBe(false);
    }
  });
});
