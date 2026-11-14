/**
 * Windows 上 deny 不认 Win32 名称规范化：`\\.\` 设备路径不经 Node 加 `\\?\`，交给系统时按 Win32 规则去掉组件末尾的点和空格，
 * `\\.\C:\…\plugins.`、`…\plugins ` 打开的就是 `plugins`。`plugins` 还不存在时规范形态与字面形态都带着尾点，逐字 glob 不命中。
 * 文件系统经 `ScopeFileSystem` 注入（`fakeScopeFs` 按 Win32 规则规范化 `\\.\` 路径），所有平台都跑。
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope, trimWin32Trailing } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const macAppData = '/Users/heli/Library/Application Support/com.deepstudent.app';
const linuxAppData = '/home/heli/.local/share/com.deepstudent.app';

const missing = [win32.join(winAppData, 'notes.txt'), win32.join(winAppData, 'slots', 'a', 'chat_v2.db')];
const present = [...missing, win32.join(winAppData, 'plugins', 'user.profile.json'), win32.join(winAppData, 'slots', 'a', 'browser-profiles', 'Default', 'Cookies')];

/** `capabilities.ts` 的 `$APPDATA/plugins`、`$APPDATA/plugins/**` 与 `$APPDATA/slots/x/browser-profiles/**`。 */
function appDataScope(platform: ShellPlatform, lib: typeof posix | typeof win32, appData: string, entries: readonly string[]): FsScope {
  const scope = new FsScope({ platform, fs: fakeScopeFs({ platform, entries }) });
  scope.allowPattern(lib.join(appData, '**'));
  scope.forbidPattern(lib.join(appData, 'plugins'));
  scope.forbidPattern(lib.join(appData, 'plugins', '**'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles', '**'));
  return scope;
}

const device = (request: string) => `\\\\.\\${win32.join(winAppData, request)}`;

describe('fs scope deny and Win32 trailing dots / spaces', () => {
  it('the fake file system resolves \\\\.\\ device paths the way Win32 does', () => {
    const fs = fakeScopeFs({ platform: 'win32', entries: present });
    expect(fs.realpath(device('plugins.'))).toBe(win32.join(winAppData, 'plugins'));
    expect(fs.realpath(device('Plugins. .'))).toBe(win32.join(winAppData, 'plugins'));
    expect(fs.realpath(device('plugins.\\user.profile.json '))).toBe(win32.join(winAppData, 'plugins', 'user.profile.json'));
    expect(fs.realpath(`//./${win32.join(winAppData, 'slots.', 'a', 'browser-profiles ').replace(/\\/g, '/')}`)).toBe(win32.join(winAppData, 'slots', 'a', 'browser-profiles'));
    expect(fs.exists(`\\\\?\\${win32.join(winAppData, 'plugins.')}`)).toBe(false);
    expect(fs.exists(win32.join(winAppData, 'plugins '))).toBe(false);
  });

  it('RF-W23-fs-deny-ntfs-stream-suffix: trailing dots and spaces of every component after the root are dropped, the root is kept', () => {
    expect(trimWin32Trailing('\\\\.\\C:\\a\\plugins.')).toBe('\\\\.\\C:\\a\\plugins');
    expect(trimWin32Trailing('\\\\.\\C:\\a\\Plugins. .')).toBe('\\\\.\\C:\\a\\Plugins');
    expect(trimWin32Trailing('\\\\.\\C:\\a\\slots. \\b\\browser-profiles .\\x')).toBe('\\\\.\\C:\\a\\slots\\b\\browser-profiles\\x');
    expect(trimWin32Trailing('\\\\?\\C:\\a\\plugins\\. \\...')).toBe('\\\\?\\C:\\a\\plugins');
    expect(trimWin32Trailing('\\\\.\\UNC\\srv\\share\\plugins ')).toBe('\\\\.\\UNC\\srv\\share\\plugins');
    expect(trimWin32Trailing('C:\\a.b\\notes.txt')).toBe('C:\\a.b\\notes.txt');
    expect(trimWin32Trailing('C:\\')).toBe('C:\\');
  });

  it('RF-W23-fs-deny-ntfs-stream-suffix: on Windows a \\\\.\\ path with trailing dots or spaces on plugins / browser-profiles is denied whether the directory exists or not', () => {
    const requests = [
      device('plugins.'),
      device('plugins '),
      device('Plugins. .'),
      device('plugins.\\user.profile.json'),
      device('plugins.\\community\\evil.js'),
      device('plugins::$INDEX_ALLOCATION.'),
      device('slots\\a\\browser-profiles.'),
      device('slots\\a\\browser-profiles.\\Default\\Cookies'),
      device('slots.\\a\\browser-profiles'),
      `\\\\.\\${win32.join(winAppData, 'PLUGINS...').toLowerCase()}`,
      `//./${win32.join(winAppData, 'plugins.').replace(/\\/g, '/')}`,
      `\\\\.\\C:\\Users\\\\heli\\AppData\\Roaming\\com.deepstudent.app\\\\plugins. `,
    ];
    for (const [state, entries] of [['missing', missing], ['present', present]] as const) {
      const scope = appDataScope('win32', win32, winAppData, entries);
      for (const request of requests) {
        expect(scope.isForbidden(request), `${state} ${request}`).toBe(true);
        expect(scope.isAllowed(request), `${state} ${request}`).toBe(false);
      }
      for (const fine of ['notes.txt', 'plugins.txt', 'plugins-notes\\x.md', 'slots\\a\\chat_v2.db', 'slots\\a\\browser-profiles-backup']) {
        expect(scope.isAllowed(device(fine)), `${state} ${fine}`).toBe(true);
      }
    }
  });

  it('RF-W23-fs-deny-ntfs-stream-suffix: on macOS and Linux a trailing dot or space names another entry, plugins. stays allowed', () => {
    for (const [platform, appData] of [['darwin', macAppData], ['linux', linuxAppData]] as const) {
      const scope = appDataScope(platform, posix, appData, [posix.join(appData, 'notes.txt')]);
      expect(scope.isAllowed(posix.join(appData, 'plugins.')), platform).toBe(true);
      expect(scope.isAllowed(posix.join(appData, 'plugins ', 'x')), platform).toBe(true);
      expect(scope.isAllowed(posix.join(appData, 'plugins', 'x')), platform).toBe(false);
    }
  });
});
