/**
 * Windows 上 deny 不认 NTFS 流写法：`plugins::$INDEX_ALLOCATION` 就是目录 `plugins`（Git CVE-2019-1352 的 `.git::$INDEX_ALLOCATION`），
 * `plugins:x` 是它的一个流。Windows 文件名里不可能有 `:`，macOS / Linux 上 `:` 是普通字符。文件系统经 `ScopeFileSystem` 注入。
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope, stripNtfsStreams } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const macAppData = '/Users/heli/Library/Application Support/com.deepstudent.app';
const linuxAppData = '/home/heli/.local/share/com.deepstudent.app';

function appDataScope(platform: ShellPlatform, lib: typeof posix | typeof win32, appData: string, entries: readonly string[]): FsScope {
  const scope = new FsScope({ platform, fs: fakeScopeFs({ platform, entries }) });
  scope.allowPattern(lib.join(appData, '**'));
  scope.forbidPattern(lib.join(appData, 'plugins'));
  scope.forbidPattern(lib.join(appData, 'plugins', '**'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles'));
  scope.forbidPattern(lib.join(appData, 'slots', '*', 'browser-profiles', '**'));
  return scope;
}

describe('fs scope deny and NTFS stream names', () => {
  it('RF-W23-fs-deny-ntfs-stream-suffix: the stream part of every component after the root is dropped, the root is kept', () => {
    expect(stripNtfsStreams('C:\\a\\plugins::$INDEX_ALLOCATION\\x')).toBe('C:\\a\\plugins\\x');
    expect(stripNtfsStreams('C:\\a\\plugins:$I30:$INDEX_ALLOCATION\\x:zone')).toBe('C:\\a\\plugins\\x');
    expect(stripNtfsStreams('\\\\?\\C:\\a\\plugins:s/x')).toBe('\\\\?\\C:\\a\\plugins/x');
    expect(stripNtfsStreams('\\\\?\\UNC\\srv\\share\\plugins::$DATA')).toBe('\\\\?\\UNC\\srv\\share\\plugins');
    expect(stripNtfsStreams('\\\\srv\\share\\a:b\\c')).toBe('\\\\srv\\share\\a\\c');
    expect(stripNtfsStreams('C:\\a\\b')).toBe('C:\\a\\b');
  });

  it('RF-W23-fs-deny-ntfs-stream-suffix: on Windows a stream spelling of plugins / browser-profiles is denied whether the directory exists or not', () => {
    const missing = [win32.join(winAppData, 'notes.txt')];
    const present = [...missing, win32.join(winAppData, 'plugins', 'user.profile.json'), win32.join(winAppData, 'slots', 'a', 'browser-profiles', 'Default', 'Cookies')];
    for (const entries of [missing, present]) {
      const scope = appDataScope('win32', win32, winAppData, entries);
      for (const request of [
        'plugins::$INDEX_ALLOCATION',
        'plugins::$INDEX_ALLOCATION\\user.profile.json',
        'Plugins:$I30:$INDEX_ALLOCATION\\community\\evil.js',
        'plugins:hidden',
        'PLUGINS::$INDEX_ALLOCATION/user.profile.json',
        'slots\\a\\browser-profiles::$INDEX_ALLOCATION\\Default\\Cookies',
        'slots/a/Browser-Profiles:$I30:$INDEX_ALLOCATION/Default/Cookies',
      ]) {
        const path = win32.join(winAppData, request);
        expect(scope.isAllowed(path), `${entries.length} ${request}`).toBe(false);
        expect(scope.isForbidden(path), `${entries.length} ${request}`).toBe(true);
        expect(scope.isAllowed(`\\\\?\\${path}`), `verbatim ${request}`).toBe(false);
      }
      // A stream on an allowed file stays allowed (Tauri compares it literally against appData/**).
      expect(scope.isAllowed(win32.join(winAppData, 'notes.txt:Zone.Identifier'))).toBe(true);
      expect(scope.isAllowed(win32.join(winAppData, 'plugins-notes::$DATA'))).toBe(true);
    }
  });

  it('RF-W23-fs-deny-ntfs-stream-suffix: on macOS and Linux a colon is an ordinary character, plugins:x is another entry', () => {
    for (const [platform, appData] of [['darwin', macAppData], ['linux', linuxAppData]] as const) {
      const scope = appDataScope(platform, posix, appData, [posix.join(appData, 'notes.txt')]);
      expect(scope.isAllowed(posix.join(appData, 'plugins::$INDEX_ALLOCATION', 'x')), platform).toBe(true);
      expect(scope.isAllowed(posix.join(appData, 'plugins:x')), platform).toBe(true);
      expect(scope.isAllowed(posix.join(appData, 'plugins', 'x')), platform).toBe(false);
    }
  });
});
