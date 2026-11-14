/**
 * fs / asset 作用域的 deny 在大小写不敏感的文件系统（macOS APFS、Windows NTFS）上按折叠后的写法匹配，
 * allow 仍是 Tauri 的逐字 glob。文件系统经 `ScopeFileSystem` 注入，Linux 上也能跑。
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope, foldForDeny, type ScopeFileSystem } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs, type FakeScopeFsOptions } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const winLocalAppData = 'C:\\Users\\heli\\AppData\\Local\\com.deepstudent.app';
const macAppData = '/Users/heli/Library/Application Support/com.deepstudent.app';
const linuxAppData = '/home/heli/.local/share/com.deepstudent.app';

/** 作用域建好之后磁盘内容还会变（fs 插件按命令首次使用时建作用域，之后页面才建出目录）。 */
function changingFs(platform: ShellPlatform, entries: readonly string[], aliases?: FakeScopeFsOptions['aliases']) {
  let current = fakeScopeFs({ platform, entries, ...(aliases === undefined ? {} : { aliases }) });
  const fs: ScopeFileSystem = {
    isSymbolicLink: (path) => current.isSymbolicLink(path),
    readlink: (path) => current.readlink(path),
    exists: (path) => current.exists(path),
    realpath: (path) => current.realpath(path),
  };
  return {
    fs,
    become: (next: readonly string[]) => {
      current = fakeScopeFs({ platform, entries: next, ...(aliases === undefined ? {} : { aliases }) });
    },
  };
}

/** `capabilities.ts` 的 `$APPDATA/plugins`、`$APPDATA/plugins/**` 与 `$APPDATA/slots/x/browser-profiles/**`。 */
function appDataScope(platform: ShellPlatform, lib: typeof posix | typeof win32, appData: string, fs: ScopeFileSystem): FsScope {
  const scope = new FsScope({ platform, fs });
  scope.allowPattern(lib.join(appData, '**'));
  scope.forbidPattern(lib.join(appData, 'plugins'));
  scope.forbidPattern(lib.join(appData, 'plugins', '**'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles', '**'));
  return scope;
}

describe('fs scope deny on case-insensitive file systems', () => {
  it('RF-W23-fs-deny-case-insensitive: the fold names what APFS and NTFS treat as one entry', () => {
    for (const [a, b] of [
      ['Plugins', 'plugins'], ['PLUGINS', 'plugins'], ['plugin\u017f', 'plugins'], ['\u212Adir', 'kdir'],
      ['\u00dffi', 'ssfi'], ['\u1e9efi', 'ssfi'], ['ss\ufb01', 'ssfi'], ['CAF\u00c9', 'cafe\u0301'], ['caf\u00e9', 'CAFE\u0301'],
      ['\u0131', 'I'], ['\u03c2', '\u03a3'],
    ]) {
      expect(foldForDeny(a as string), `${a} ~ ${b}`).toBe(foldForDeny(b as string));
    }
    // glob syntax and separators survive the fold.
    expect(foldForDeny('C:\\Users\\X\\[*]\\?\\**')).toBe('c:\\users\\x\\[*]\\?\\**');
    expect(foldForDeny('/Users/X/slots/*/Browser-Profiles/**')).toBe('/users/x/slots/*/browser-profiles/**');
  });

  it('RF-W23-fs-deny-case-insensitive: while plugins / browser-profiles do not exist, no other spelling of them is allowed on macOS and Windows', () => {
    const cases: Array<[ShellPlatform, typeof posix | typeof win32, string, string[]]> = [
      ['darwin', posix, macAppData, ['Plugins', 'PLUGINS/community/evil.js', 'plugin\u017f/user.profile.json', 'Plugin\u017F', 'slots/a/Browser-Profiles', 'slots/a/BROWSER-PROFILES/default/Cookies', 'slots/a/browser-profile\u017f/x']],
      ['win32', win32, winAppData, ['Plugins', 'PLUGINS\\community\\evil.js', 'plugin\u017f\\user.profile.json', 'Plugins/user.profile.json', 'slots\\a\\Browser-Profiles', 'slots/a/BROWSER-PROFILES/default/Cookies']],
    ];
    for (const [platform, lib, appData, requests] of cases) {
      const { fs } = changingFs(platform, [lib.join(appData, 'slots', 'a', 'chat_v2.db')]);
      const scope = appDataScope(platform, lib, appData, fs);
      for (const request of requests) {
        expect(scope.isAllowed(lib.join(appData, request)), `${platform} ${request}`).toBe(false);
        expect(scope.isForbidden(lib.join(appData, request)), `${platform} ${request}`).toBe(true);
      }
      for (const fine of ['Plugins-notes.txt', 'pluginsx', 'slots/a/Browser-Profiles-backup', 'slots/a/chat_v2.db']) {
        expect(scope.isAllowed(lib.join(appData, fine)), `${platform} ${fine}`).toBe(true);
      }
    }
  });

  it('RF-W23-fs-deny-case-insensitive: once the directory exists under another case (created after the scope was built), every spelling inside it stays denied', () => {
    const cases: Array<[ShellPlatform, typeof posix | typeof win32, string]> = [['darwin', posix, macAppData], ['win32', win32, winAppData]];
    for (const [platform, lib, appData] of cases) {
      const before = [lib.join(appData, 'notes')];
      const disk = changingFs(platform, before, platform === 'win32' ? { [win32.join(appData, 'PLUGIN~1')]: win32.join(appData, 'Plugins') } : undefined);
      const scope = appDataScope(platform, lib, appData, disk.fs);
      disk.become([...before, lib.join(appData, 'Plugins', 'user.profile.json'), lib.join(appData, 'slots', 'a', 'Browser-Profiles', 'default', 'Cookies')]);
      const requests = ['Plugins', 'plugins/user.profile.json', 'Plugins/user.profile.json', 'PLUGINS/new.js', 'slots/a/browser-profiles/default/Cookies', 'slots/a/Browser-Profiles/default/Cookies'];
      if (platform === 'win32') requests.push('PLUGIN~1\\user.profile.json');
      for (const request of requests) {
        expect(scope.isAllowed(lib.join(appData, request)), `${platform} ${request}`).toBe(false);
      }
      expect(scope.isAllowed(lib.join(appData, 'notes', 'new.md'))).toBe(true);
    }
  });

  it('RF-W23-fs-deny-case-insensitive: Windows spellings of a denied directory (drive letter, separators, verbatim prefix) are denied', () => {
    const { fs } = changingFs('win32', [winAppData, win32.join(winLocalAppData, 'cache')]);
    const scope = new FsScope({ platform: 'win32', fs });
    scope.allowPattern(win32.join(winLocalAppData, '**'));
    scope.forbidPattern(win32.join(winLocalAppData, 'EBWebView', '**'));
    for (const request of [
      'c:\\users\\heli\\appdata\\local\\com.deepstudent.app\\ebwebview\\Default\\Cookies',
      'C:/Users/heli/AppData/Local/com.deepstudent.app/EBWEBVIEW/Default/Cookies',
      '\\\\?\\C:\\Users\\heli\\AppData\\Local\\com.deepstudent.app\\EbWebView\\x',
    ]) {
      expect(scope.isAllowed(request), request).toBe(false);
    }
    expect(scope.isAllowed(win32.join(winLocalAppData, 'cache', 'x'))).toBe(true);
  });

  it('RF-W23-fs-deny-case-insensitive: Linux keeps exact matching (Plugins is another directory there, the Host reads plugins)', () => {
    const { fs } = changingFs('linux', [linuxAppData]);
    const scope = appDataScope('linux', posix, linuxAppData, fs);
    expect(scope.isAllowed(posix.join(linuxAppData, 'plugins', 'user.profile.json'))).toBe(false);
    expect(scope.isAllowed(posix.join(linuxAppData, 'Plugins', 'user.profile.json'))).toBe(true);
    expect(scope.isAllowed(posix.join(linuxAppData, 'slots', 'a', 'Browser-Profiles', 'x'))).toBe(true);
  });

  it('RF-W23-fs-deny-case-insensitive: allow keeps Tauri\'s exact glob on every platform (only deny is folded)', () => {
    for (const [platform, lib, root] of [['darwin', posix, '/Users/heli'], ['win32', win32, 'C:\\Users\\heli']] as const) {
      const { fs } = changingFs(platform, [root]);
      const scope = new FsScope({ platform, fs });
      scope.allowPattern(lib.join(root, 'Docs', '**'));
      expect(scope.isAllowed(lib.join(root, 'Docs', 'a.md')), platform).toBe(true);
      expect(scope.isAllowed(lib.join(root, 'DOCS', 'a.md')), platform).toBe(false);
    }
  });
});
