/**
 * 受保护目录里的符号链接：deny 也比较目录项本身的位置（请求的字面形态、父目录规范化后拼回最后一个组件），不只比较链接目标；
 * 相对链接目标按链接所在目录解析，不按进程 cwd。文件系统经 `ScopeFileSystem` 注入，任何宿主上都按三个平台的语义运行；
 * 真实文件系统上的一例只在 macOS / Linux 运行（Windows 建符号链接要特权）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsScope, type ScopeFileSystem } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import { fakeScopeFs } from './__fixtures__/scope-fs.ts';

const PLATFORMS = [
  ['darwin', posix, '/Users/heli/Library/Application Support/com.deepstudent.app'],
  ['win32', win32, 'C:\\Users\\heli\\AppData\\Roaming\\com.deepstudent.app'],
  ['linux', posix, '/home/heli/.local/share/com.deepstudent.app'],
] as const;

function appDataScope(platform: ShellPlatform, appData: string, fs?: ScopeFileSystem): FsScope {
  const lib = platform === 'win32' ? win32 : posix;
  const scope = new FsScope({ platform, ...(fs === undefined ? {} : { fs }) });
  scope.allowPattern(appData);
  scope.allowPattern(lib.join(appData, '**'));
  scope.forbidPattern(lib.join(appData, 'plugins'));
  scope.forbidPattern(lib.join(appData, 'plugins', '**'));
  return scope;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('symbolic links inside a denied directory', () => {
  it('RF-W23-fs-deny-symlink-entry: a link inside plugins pointing at an allowed file is denied by where the link sits', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const profile = lib.join(appData, 'plugins', 'user.profile.json');
      const fs = fakeScopeFs({ platform, entries: [lib.join(appData, 'profile-source.json'), lib.join(appData, 'plugins')], links: { [profile]: lib.join(appData, 'profile-source.json') } });
      const scope = appDataScope(platform, appData, fs);
      expect(scope.isForbidden(profile), platform).toBe(true);
      expect(scope.isAllowed(profile), platform).toBe(false);
      // The target itself stays reachable under its own name (the user exposed it; see the RF's userVisible).
      expect(scope.isAllowed(lib.join(appData, 'profile-source.json')), platform).toBe(true);
    }
  });

  it('RF-W23-fs-deny-symlink-entry: the link is judged at its real location when its parent is reached through another link', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const home = lib.dirname(appData);
      const alias = lib.join(lib.dirname(home), 'alias');
      const profile = lib.join(appData, 'plugins', 'user.profile.json');
      const fs = fakeScopeFs({
        platform,
        entries: [lib.join(appData, 'profile-source.json'), lib.join(appData, 'plugins')],
        links: { [profile]: lib.join(appData, 'profile-source.json'), [alias]: home },
      });
      const scope = appDataScope(platform, appData, fs);
      const viaAlias = lib.join(alias, lib.basename(appData), 'plugins', 'user.profile.json');
      expect(scope.isForbidden(viaAlias), `${platform} ${viaAlias}`).toBe(true);
    }
  });

  it('RF-W23-fs-deny-symlink-entry: a relative link target is resolved from the directory holding the link, not from the process cwd', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const docs = lib.join(lib.dirname(appData), 'Documents');
      const fs = fakeScopeFs({
        platform,
        entries: [lib.join(docs, 'notes', 'a.md'), lib.join(appData, 'plugins', 'user.profile.json')],
        links: { [lib.join(docs, 'rel.md')]: lib.join('notes', 'a.md'), [lib.join(docs, 'sneaky.json')]: lib.relative(docs, lib.join(appData, 'plugins', 'user.profile.json')) },
      });
      const scope = appDataScope(platform, appData, fs);
      scope.allowPattern(lib.join(docs, '**'));
      expect(scope.isAllowed(lib.join(docs, 'rel.md')), platform).toBe(true);
      expect(scope.isForbidden(lib.join(docs, 'sneaky.json')), platform).toBe(true);
    }
  });

  it('RF-W23-fs-deny-symlink-entry: other paths keep their verdicts (plain files, missing files, links out of plugins)', () => {
    for (const [platform, lib, appData] of PLATFORMS) {
      const fs = fakeScopeFs({ platform, entries: [lib.join(appData, 'notes', 'a.md'), lib.join(appData, 'plugins', 'x.mjs')], links: { [lib.join(appData, 'notes', 'link.md')]: lib.join(appData, 'notes', 'a.md') } });
      const scope = appDataScope(platform, appData, fs);
      for (const fine of ['notes/a.md', 'notes/new.md', 'notes/link.md', 'plugins-notes.txt']) expect(scope.isAllowed(lib.join(appData, fine)), `${platform} ${fine}`).toBe(true);
      for (const denied of ['plugins', 'plugins/x.mjs', 'plugins/new.mjs']) expect(scope.isForbidden(lib.join(appData, denied)), `${platform} ${denied}`).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')('RF-W23-fs-deny-symlink-entry: on the real file system a link inside plugins is denied however it is spelled, and a relative link resolves next to itself', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'w23-link-')));
    roots.push(root);
    const appData = join(root, 'appdata');
    mkdirSync(join(appData, 'plugins'), { recursive: true });
    mkdirSync(join(root, 'docs', 'notes'), { recursive: true });
    writeFileSync(join(appData, 'profile-source.json'), '{}');
    writeFileSync(join(root, 'docs', 'notes', 'a.md'), 'A');
    symlinkSync(join(appData, 'profile-source.json'), join(appData, 'plugins', 'user.profile.json'));
    symlinkSync(join('notes', 'a.md'), join(root, 'docs', 'rel.md'));
    symlinkSync(root, join(root, 'alias'));
    const platform: ShellPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const scope = appDataScope(platform, appData);
    scope.allowPattern(join(root, 'docs', '**'));
    expect(scope.isForbidden(join(appData, 'plugins', 'user.profile.json'))).toBe(true);
    expect(scope.isForbidden(join(root, 'alias', 'appdata', 'plugins', 'user.profile.json'))).toBe(true);
    expect(scope.isAllowed(join(appData, 'profile-source.json'))).toBe(true);
    expect(scope.isAllowed(join(root, 'docs', 'rel.md'))).toBe(true);
  });
});
