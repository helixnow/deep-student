/**
 * fs / asset 作用域在 Windows 与 Linux 路径语义下与 Tauri `Scope`（tauri-2.11.5 `src/scope/fs.rs`）逐项对照。
 * 文件系统用 `__fixtures__/scope-fs.ts` 注入，路径用 `path.win32` / `path.posix` 拼。
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import { fakeScopeFs, type FakeScopeFsOptions } from './__fixtures__/scope-fs.ts';

const windowsScope = (fs: Omit<FakeScopeFsOptions, 'platform'>) => new FsScope({ platform: 'win32', fs: fakeScopeFs({ platform: 'win32', ...fs }) });
const linuxScope = (fs: Omit<FakeScopeFsOptions, 'platform'>) => new FsScope({ platform: 'linux', fs: fakeScopeFs({ platform: 'linux', ...fs }) });

describe('Windows: Tauri windows_root_paths (src/scope/fs.rs:632-696)', () => {
  const entries = ['\\\\localhost\\c$\\Windows', 'C:\\Windows\\system.ini'];

  it('UNC network path', () => {
    const scope = windowsScope({ entries });
    scope.allowDirectory('\\\\localhost\\c$', true);
    expect(scope.isAllowed('\\\\localhost\\c$')).toBe(true);
    expect(scope.isAllowed('\\\\localhost\\c$\\Windows')).toBe(true);
    expect(scope.isAllowed('\\\\localhost\\c$\\NonExistentFile')).toBe(true);
    expect(scope.isAllowed('\\\\localhost\\d$')).toBe(false);
    expect(scope.isAllowed('\\\\OtherServer\\Share')).toBe(false);
  });

  it('verbatim UNC network path', () => {
    const scope = windowsScope({ entries });
    scope.allowDirectory('\\\\?\\UNC\\localhost\\c$', true);
    expect(scope.isAllowed('\\\\localhost\\c$')).toBe(true);
    expect(scope.isAllowed('\\\\localhost\\c$\\Windows')).toBe(true);
    expect(scope.isAllowed('\\\\?\\UNC\\localhost\\c$\\Windows\\NonExistentFile')).toBe(true);
    // Tauri 这里断言 `\\localhost\c$\Windows\NonExistentFile` 为 false，见 fs-scope-missing-path.test.ts（RF-W23-fs-scope-missing-path-canonical-ancestor）。
    expect(scope.isAllowed('\\\\localhost\\d$')).toBe(false);
    expect(scope.isAllowed('\\\\OtherServer\\Share')).toBe(false);
  });

  it('device namespace', () => {
    const scope = windowsScope({ entries });
    scope.allowFile('\\\\.\\COM1');
    expect(scope.isAllowed('\\\\.\\COM1')).toBe(true);
    expect(scope.isAllowed('\\\\.\\COM2')).toBe(false);
  });

  it('disk root and verbatim disk root', () => {
    for (const root of ['C:\\', '\\\\?\\C:\\']) {
      const scope = windowsScope({ entries });
      scope.allowDirectory(root, true);
      expect(scope.isAllowed('C:\\Windows')).toBe(true);
      expect(scope.isAllowed('C:\\Windows\\system.ini')).toBe(true);
      expect(scope.isAllowed('C:\\NonExistentFile')).toBe(true);
      expect(scope.isAllowed('D:\\home')).toBe(false);
    }
  });

  it('verbatim path', () => {
    const scope = windowsScope({ entries });
    scope.allowFile('\\\\?\\anyfile');
    expect(scope.isAllowed('\\\\?\\anyfile')).toBe(true);
    expect(scope.isAllowed('\\\\?\\otherfile')).toBe(false);
  });

  it('push_pattern_generated_paths: the canonical form is the verbatim one, as Rust canonicalize returns it', () => {
    const scope = windowsScope({ entries: ['C:\\'] });
    scope.allowPattern('C:\\path\\to\\dir');
    scope.allowPattern('C:\\path\\to\\dir\\**');
    expect(scope.allowedPatterns()).toEqual(expect.arrayContaining([
      'C:\\path\\to\\dir',
      'C:\\path\\to\\dir\\**',
      '\\\\?\\C:\\path\\to\\dir',
      '\\\\?\\C:\\path\\to\\dir\\**',
    ]));
  });
});

describe('Windows path forms', () => {
  const appData = win32.join('C:\\Users\\heli\\AppData\\Roaming', 'com.deepstudent.app');
  const note = win32.join(appData, 'notes', 'a.md');
  const plugin = win32.join(appData, 'plugins', 'p', 'index.js');

  it('drive letter and component case: existing paths match through their canonical form, in both directions', () => {
    const scope = windowsScope({ entries: [note, plugin] });
    scope.allowPattern(win32.join(appData, '**'));
    scope.forbidPattern(win32.join(appData, 'plugins', '**'));
    expect(scope.isAllowed('c:\\users\\HELI\\appdata\\roaming\\COM.DEEPSTUDENT.APP\\notes\\A.MD')).toBe(true);
    expect(scope.isAllowed('C:\\USERS\\heli\\appdata\\Roaming\\com.deepstudent.app\\Plugins\\P\\INDEX.JS')).toBe(false);
    expect(scope.isForbidden('c:\\users\\heli\\appdata\\roaming\\com.deepstudent.app\\PLUGINS\\p\\index.js')).toBe(true);
  });

  it('a pattern configured in another case still matches the on-disk directory', () => {
    const scope = windowsScope({ entries: [note] });
    scope.allowPattern('c:\\USERS\\Heli\\appdata\\roaming\\com.deepstudent.app\\**');
    expect(scope.isAllowed(note)).toBe(true);
    expect(scope.allowedPatterns()).toContain(`\\\\?\\${appData}\\**`);
  });

  it('`/` and `\\` are the same separator, in patterns and in requests; `*` crosses neither', () => {
    const scope = windowsScope({ entries: [note] });
    scope.allowPattern('C:/Users/heli/AppData/Roaming/com.deepstudent.app/**');
    expect(scope.allowedPatterns()).toContain(win32.join(appData, '**'));
    expect(scope.isAllowed('C:/Users/heli/AppData/Roaming/com.deepstudent.app/notes/a.md')).toBe(true);
    expect(scope.isAllowed(win32.join(appData, 'new.md'))).toBe(true);
    expect(scope.isAllowed('C:/Users/heli/AppData/Roaming/com.deepstudent.app/new.md')).toBe(true);

    const flat = windowsScope({ entries: [note] });
    flat.allowDirectory(appData, false);
    expect(flat.isAllowed(win32.join(appData, 'notes'))).toBe(true);
    expect(flat.isAllowed(note)).toBe(false);
    expect(flat.isAllowed('C:/Users/heli/AppData/Roaming/com.deepstudent.app/notes/a.md')).toBe(false);
  });

  it('a verbatim request for a file not yet created matches like the drive form (Rust canonical patterns are verbatim)', () => {
    const scope = windowsScope({ entries: [note] });
    scope.allowPattern(win32.join(appData, '**'));
    expect(scope.isAllowed(`\\\\?\\${win32.join(appData, 'notes', 'new.md')}`)).toBe(true);
    expect(scope.isAllowed(`\\\\?\\${note}`)).toBe(true);
    expect(scope.isAllowed('\\\\?\\C:\\Users\\heli\\AppData\\Roaming\\other\\new.md')).toBe(false);
  });

  it('8.3 short names: existing paths resolve to the long name, whichever form the pattern or the request uses', () => {
    const temp = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
    const resources = 'C:\\Program Files\\Deep Student\\resources';
    const fs = {
      entries: [win32.join(temp, 'x.txt'), win32.join(resources, 'app.asar')],
      aliases: { 'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin', 'C:\\PROGRA~1': 'C:\\Program Files', 'C:\\Program Files\\DEEPST~1': 'C:\\Program Files\\Deep Student' },
    };
    const shortPattern = windowsScope(fs);
    shortPattern.allowPattern('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\**');
    expect(shortPattern.isAllowed(win32.join(temp, 'x.txt'))).toBe(true);
    expect(shortPattern.isAllowed('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x.txt')).toBe(true);

    const longPattern = windowsScope(fs);
    longPattern.allowPattern('C:\\**');
    longPattern.forbidPattern(win32.join(resources, '**'));
    expect(longPattern.isAllowed('C:\\PROGRA~1\\DEEPST~1\\resources\\app.asar')).toBe(false);
    expect(longPattern.isForbidden('c:\\progra~1\\deepst~1\\RESOURCES\\APP.ASAR')).toBe(true);
    expect(longPattern.isAllowed('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\x.txt')).toBe(true);
  });

  it('a leading dot is not literal on Windows (Tauri default require_literal_leading_dot: false)', () => {
    const scope = windowsScope({ entries: [note] });
    scope.allowPattern(win32.join(appData, '**'));
    expect(scope.isAllowed(win32.join(appData, '.hidden', 'x'))).toBe(true);
  });
});

describe('Linux path forms', () => {
  const appData = posix.join('/home/u/.local/share', 'com.deepstudent.app');
  const note = posix.join(appData, 'notes', 'a.md');
  const plugin = posix.join(appData, 'plugins', 'p', 'index.js');

  it('matching is case-sensitive, like the filesystem: another case is another path', () => {
    const scope = linuxScope({ entries: [note, plugin, posix.join(appData, 'Plugins', 'readme.md')] });
    scope.allowPattern(posix.join(appData, '**'));
    scope.forbidPattern(posix.join(appData, 'plugins', '**'));
    expect(scope.isAllowed(plugin)).toBe(false);
    expect(scope.isAllowed(posix.join(appData, 'Plugins', 'readme.md'))).toBe(true);
    expect(scope.isAllowed('/home/u/.local/share/COM.DEEPSTUDENT.APP/notes/a.md')).toBe(false);
    expect(scope.isAllowed(note)).toBe(true);
  });

  it('`\\` is an ordinary character, not a separator', () => {
    const scope = linuxScope({ entries: [note] });
    scope.allowDirectory(appData, false);
    expect(scope.isAllowed(posix.join(appData, 'notes\\a.md'))).toBe(true);
    expect(scope.isAllowed(note)).toBe(false);
  });

  it('a leading dot is literal on Unix (Tauri default require_literal_leading_dot: true)', () => {
    const scope = linuxScope({ entries: [note] });
    scope.allowPattern(posix.join(appData, '**'));
    expect(scope.isAllowed(posix.join(appData, '.hidden', 'x'))).toBe(false);
    expect(scope.isAllowed(note)).toBe(true);
  });
});
