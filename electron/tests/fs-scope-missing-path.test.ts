/**
 * fs / asset 作用域对尚不存在的路径（新建文件、mkdir 的目标）的判定：经最近的已存在祖先 canonicalize 后再匹配。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsScope } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs, type FakeScopeFsOptions } from './__fixtures__/scope-fs.ts';

const scopeOn = (platform: ShellPlatform, fs: Omit<FakeScopeFsOptions, 'platform'>) => new FsScope({ platform, fs: fakeScopeFs({ platform, ...fs }) });

const winAppData = 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app';
const macAppData = '/Users/heli/Library/Application Support/com.deepstudent.app';
const linuxAppData = '/home/heli/.local/share/com.deepstudent.app';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fs scope: paths that do not exist yet', () => {
  it('RF-W23-fs-scope-missing-path-canonical-ancestor: on a case-insensitive filesystem (Windows, macOS) a new file under a denied directory is denied in any case', () => {
    const cases: Array<[ShellPlatform, typeof win32 | typeof posix, string, string[]]> = [
      ['win32', win32, winAppData, ['PLUGINS\\community\\evil\\index.js', 'Plugins\\new.js', 'plugins\\NEW.js']],
      ['darwin', posix, macAppData, ['PLUGINS/community/evil/index.js', 'Plugins/new.js', 'plugins/NEW.js']],
    ];
    for (const [platform, lib, appData, requests] of cases) {
      const scope = scopeOn(platform, { entries: [lib.join(appData, 'plugins', 'community'), lib.join(appData, 'notes')] });
      scope.allowPattern(lib.join(appData, '**'));
      scope.forbidPattern(lib.join(appData, 'plugins'));
      scope.forbidPattern(lib.join(appData, 'plugins', '**'));
      for (const request of requests) {
        expect(scope.isAllowed(lib.join(appData, request)), `${platform} ${request}`).toBe(false);
        expect(scope.isForbidden(lib.join(appData, request)), `${platform} ${request}`).toBe(true);
      }
      expect(scope.isAllowed(lib.join(appData, 'notes', 'new.md'))).toBe(true);
    }
  });

  it('RF-W23-fs-scope-missing-path-canonical-ancestor: an 8.3 short name or a forbidden directory spelled in another case does not reopen it on Windows', () => {
    const resources = 'C:\\Program Files\\Deep Student\\resources';
    const scope = scopeOn('win32', {
      entries: [win32.join(resources, 'app.asar')],
      aliases: { 'C:\\PROGRA~1': 'C:\\Program Files', 'C:\\Program Files\\DEEPST~1': 'C:\\Program Files\\Deep Student' },
    });
    scope.allowPattern('C:\\**');
    scope.forbidDirectory(resources, true);
    expect(scope.isAllowed('C:\\PROGRA~1\\DEEPST~1\\resources\\injected.dll')).toBe(false);
    expect(scope.isAllowed('c:\\program files\\deep student\\RESOURCES\\injected.dll')).toBe(false);
    expect(scope.isAllowed('C:\\Program Files\\Deep Student\\new.txt')).toBe(true);
  });

  it('RF-W23-fs-scope-missing-path-canonical-ancestor: a new file behind a symlink or junction is judged where it would land', () => {
    const linux = scopeOn('linux', { entries: [posix.join(linuxAppData, 'notes'), '/etc/cron.d'], links: { [posix.join(linuxAppData, 'escape')]: '/etc' } });
    linux.allowPattern(posix.join(linuxAppData, '**'));
    expect(linux.isAllowed(posix.join(linuxAppData, 'escape', 'cron.d', 'job'))).toBe(false);
    expect(linux.isAllowed(posix.join(linuxAppData, 'notes', 'new.md'))).toBe(true);

    const windows = scopeOn('win32', { entries: [win32.join(winAppData, 'notes'), 'C:\\Windows\\System32'], links: { [win32.join(winAppData, 'junction')]: 'C:\\Windows' } });
    windows.allowPattern(win32.join(winAppData, '**'));
    expect(windows.isAllowed(win32.join(winAppData, 'junction', 'System32', 'evil.dll'))).toBe(false);
    expect(windows.isAllowed(win32.join(winAppData, 'notes', 'new.md'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('RF-W23-fs-scope-missing-path-canonical-ancestor: on the real filesystem a new file behind a symlink out of the allowed directory is denied', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scope-missing-')));
    temporary.push(root);
    mkdirSync(join(root, 'allowed'));
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, 'allowed', 'link'));
    const scope = new FsScope({ platform: process.platform === 'darwin' ? 'darwin' : 'linux' });
    scope.allowPattern(join(root, 'allowed', '**'));
    expect(scope.isAllowed(join(root, 'allowed', 'link', 'new.txt'))).toBe(false);
    expect(scope.isAllowed(join(root, 'allowed', 'new.txt'))).toBe(true);
  });

  it('RF-W23-fs-scope-missing-path-canonical-ancestor: a new file under an allowed directory is allowed in any spelling the filesystem resolves there', () => {
    const scope = scopeOn('win32', { entries: [win32.join(winAppData, 'notes'), '\\\\localhost\\c$\\Windows'] });
    scope.allowPattern(win32.join(winAppData, '**'));
    // Tauri: false（不存在的路径按字面匹配，盘符与目录大小写不同即不匹配）。
    expect(scope.isAllowed('c:\\users\\HELI\\appdata\\roaming\\com.deepstudent.app\\notes\\new.md')).toBe(true);
    expect(scope.isAllowed('c:\\users\\heli\\appdata\\roaming\\other\\new.md')).toBe(false);
    expect(scope.isAllowed('Q:\\no-such-drive\\new.md')).toBe(false);

    const unc = scopeOn('win32', { entries: ['\\\\localhost\\c$\\Windows'] });
    unc.allowDirectory('\\\\?\\UNC\\localhost\\c$', true);
    // Tauri windows_root_paths: false（"A non-existent file cannot be canonicalized to a verbatim UNC path"）。
    expect(unc.isAllowed('\\\\localhost\\c$\\Windows\\NonExistentFile')).toBe(true);
    expect(unc.isAllowed('\\\\localhost\\d$\\NonExistentFile')).toBe(false);
  });

  it('RF-W23-fs-scope-missing-path-canonical-ancestor: never forbids less than Tauri: the literal request is still checked against deny after a symlink appears under it', () => {
    const before = fakeScopeFs({ platform: 'linux', entries: [linuxAppData, '/srv/shared'] });
    const after = fakeScopeFs({ platform: 'linux', entries: [linuxAppData, '/srv/shared'], links: { [posix.join(linuxAppData, 'locked')]: '/srv/shared' } });
    let linked = false;
    const current = () => (linked ? after : before);
    const scope = new FsScope({
      platform: 'linux',
      fs: { isSymbolicLink: (p) => current().isSymbolicLink(p), readlink: (p) => current().readlink(p), exists: (p) => current().exists(p), realpath: (p) => current().realpath(p) },
    });
    scope.allowPattern('/**');
    scope.forbidPattern(posix.join(linuxAppData, 'locked', '**'));
    linked = true;
    expect(scope.isForbidden(posix.join(linuxAppData, 'locked', 'new'))).toBe(true);
    expect(scope.isAllowed(posix.join(linuxAppData, 'locked', 'new'))).toBe(false);
    expect(scope.isAllowed('/srv/shared/new')).toBe(true);
  });
});
