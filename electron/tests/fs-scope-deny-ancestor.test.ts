/**
 * `FsScope.forbidsBelow`：deny 能否匹配给定路径之下的路径。fs 插件的 rename（两端）与递归 remove 用它挡住
 * “改名或删掉受保护目录的上级”。文件系统经 `ScopeFileSystem` 注入，任何宿主上都按三个平台的语义运行。
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope, mayMatchBelow, type ScopeFileSystem } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const winLocalAppData = 'C:\\Users\\heli\\AppData\\Local\\com.deepstudent.app';
const macAppData = '/Users/heli/Library/Application Support/com.deepstudent.app';
const linuxAppData = '/home/heli/.local/share/com.deepstudent.app';

/** `capabilities.ts` 的 deny：Host 插件目录、各槽位的 browser-profiles、userData；Windows 另有 `$APPLOCALDATA/EBWebView/**`。 */
function appDataScope(platform: ShellPlatform, appData: string, fs: ScopeFileSystem): FsScope {
  const lib = platform === 'win32' ? win32 : posix;
  const scope = new FsScope({ platform, fs });
  scope.allowPattern(appData);
  scope.allowPattern(lib.join(appData, '**'));
  scope.forbidPattern(lib.join(appData, 'plugins'));
  scope.forbidPattern(lib.join(appData, 'plugins', '**'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles', '**'));
  scope.forbidDirectory(`${appData}.electron`, true);
  if (platform === 'win32') {
    scope.allowPattern(winLocalAppData);
    scope.allowPattern(win32.join(winLocalAppData, '**'));
    scope.forbidPattern(win32.join(winLocalAppData, 'EBWebView', '**'));
  }
  return scope;
}

const PLATFORMS = [['darwin', posix, macAppData], ['win32', win32, winAppData], ['linux', posix, linuxAppData]] as const;

describe('deny below a path (rename / recursive remove of an ancestor)', () => {
  it('RF-W23-fs-deny-protected-ancestor: mayMatchBelow compares component by component; * stays in one component, ** reaches everything', () => {
    const options = { requireLiteralSeparator: true, requireLiteralLeadingDot: true, windows: false };
    const below = (pattern: string, path: string) => mayMatchBelow(pattern, path, 'linux', options);
    expect(below('/a/slots/*/browser-profiles', '/a/slots')).toBe(true);
    expect(below('/a/slots/*/browser-profiles', '/a/slots/x')).toBe(true);
    expect(below('/a/slots/*/browser-profiles', '/a')).toBe(true);
    expect(below('/a/slots/*/browser-profiles', '/')).toBe(true);
    expect(below('/a/slots/*/browser-profiles', '/a/slots/x/browser-profiles')).toBe(false);
    expect(below('/a/slots/*/browser-profiles/**', '/a/slots/x/browser-profiles')).toBe(true);
    expect(below('/a/slots/*/browser-profiles', '/a/slots/x/notes')).toBe(false);
    expect(below('/a/slots/*/browser-profiles', '/a/slots/x/browser-profiles-backup')).toBe(false);
    expect(below('/a/slots/*/browser-profiles', '/a/slotz')).toBe(false);
    expect(below('/a/slots/*/browser-profiles', '/a/slots/.hidden')).toBe(false);
    expect(below('/a/plugins', '/a/plugins')).toBe(false);
    expect(below('/a/**', '/b')).toBe(false);
    expect(below('/a/**', '/a/b/c')).toBe(true);
    expect(mayMatchBelow('C:\\a\\EBWebView\\**', 'c:/a/EBWebView', 'win32', { ...options, windows: true })).toBe(false);
    expect(mayMatchBelow('C:\\a\\EBWebView\\**', 'C:/a/EBWebView', 'win32', { ...options, windows: true })).toBe(true);
    // A character class split by a separator is no pattern on its own: counted as a match.
    expect(below('/a/[/]x/b', '/a/q')).toBe(true);
  });

  it('RF-W23-fs-deny-protected-ancestor: $APPDATA, slots and each slot hold a protected directory; files and other folders do not', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const fs = fakeScopeFs({ platform, entries: [lib.join(appData, 'slots', 'a', 'browser-profiles', 'default', 'Cookies'), lib.join(appData, 'slots', 'a', 'chat_v2.db'), lib.join(appData, 'notes', 'x.md')] });
      const scope = appDataScope(platform, appData, fs);
      for (const request of [appData, lib.join(appData, 'slots'), lib.join(appData, 'slots', 'a'), lib.join(appData, 'slots', 'new'), lib.dirname(appData), lib.parse(appData).root]) {
        expect(scope.forbidsBelow(request), `${platform} ${request}`).toBe(true);
      }
      for (const request of ['slots/a/chat_v2.db', 'slots/a/notes', 'slots/a/browser-profiles-backup', 'notes', 'notes/x.md', 'slotz', 'plugins-notes.txt', 'tmp_apkg_import', 'workbench-wallpapers']) {
        expect(scope.forbidsBelow(lib.join(appData, request)), `${platform} ${request}`).toBe(false);
        expect(scope.isAllowed(lib.join(appData, request)), `${platform} ${request}`).toBe(true);
      }
      // The userData sibling `<appData>.electron` is denied as a directory: its holder is an ancestor, the app data folder is not.
      expect(scope.forbidsBelow(lib.dirname(appData)), platform).toBe(true);
    }
  });

  it('RF-W23-fs-deny-protected-ancestor: on Windows the EBWebView folder itself and $APPLOCALDATA hold the denied webview data', () => {
    const fs = fakeScopeFs({ platform: 'win32', entries: [winAppData, win32.join(winLocalAppData, 'EBWebView', 'Default', 'Cookies'), win32.join(winLocalAppData, 'cache', 'x')] });
    const scope = appDataScope('win32', winAppData, fs);
    expect(scope.isForbidden(win32.join(winLocalAppData, 'EBWebView'))).toBe(false);
    expect(scope.forbidsBelow(win32.join(winLocalAppData, 'EBWebView'))).toBe(true);
    expect(scope.forbidsBelow(winLocalAppData)).toBe(true);
    expect(scope.forbidsBelow(win32.join(winLocalAppData, 'cache'))).toBe(false);
  });

  it('RF-W23-fs-deny-protected-ancestor: other spellings of an ancestor count on macOS and Windows (case, \\\\.\\ trailing dots, NTFS streams), not on Linux', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const fs = fakeScopeFs({ platform, entries: [lib.join(appData, 'slots', 'a', 'chat_v2.db')] });
      const scope = appDataScope(platform, appData, fs);
      for (const request of ['Slots', 'SLOTS/a', 'slot\u017f/a']) {
        expect(scope.forbidsBelow(lib.join(appData, request)), `${platform} ${request}`).toBe(platform !== 'linux');
      }
    }
    const fs = fakeScopeFs({ platform: 'win32', entries: [win32.join(winAppData, 'notes')] });
    const scope = appDataScope('win32', winAppData, fs);
    for (const request of [`\\\\.\\${winAppData}\\slots.`, `\\\\.\\${winAppData}\\slots \\a`, `${winAppData}\\slots::$INDEX_ALLOCATION`, `\\\\.\\${winAppData}.`, `${winAppData}\\SLOTS.\\new`]) {
      expect(scope.forbidsBelow(request), request).toBe(true);
    }
    expect(scope.forbidsBelow(`${winAppData}\\slots.txt`)).toBe(false);
  });

  it('RF-W23-fs-deny-protected-ancestor: an ancestor reached through a symbolic link or junction is judged at its real location', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const home = lib.dirname(lib.dirname(appData));
      const fs = fakeScopeFs({
        platform,
        entries: [lib.join(appData, 'slots', 'a', 'browser-profiles', 'default', 'Cookies'), lib.join(home, 'Documents')],
        links: { [lib.join(home, 'Documents', 'shortcut')]: lib.join(appData, 'slots') },
      });
      const scope = appDataScope(platform, appData, fs);
      expect(scope.forbidsBelow(lib.join(home, 'Documents', 'shortcut', 'a')), platform).toBe(true);
      expect(scope.forbidsBelow(lib.join(home, 'Documents')), platform).toBe(false);
    }
  });
});
