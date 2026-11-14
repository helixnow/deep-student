/**
 * `fs:default` 的 `deny-default`（`electron/shell/capabilities.ts` 的 Electron 补充作用域）在三个平台上 deny 的目录：
 * Electron 的 userData（`$ELECTRON_USERDATA`），Windows 另有 Tauri 版 WebView2 留下的 `$APPLOCALDATA/EBWebView`；
 * 以及 `$ELECTRON_USERDATA` 的展开（`scope.ts` `fsScopeFromPatterns`）和 `ShellRuntime` 的默认 userData。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuiltinAcl } from '../shell/capabilities.ts';
import { PathResolver, type PathEnvironment } from '../shell/paths.ts';
import { ShellRuntime } from '../shell/runtime.ts';
import { ELECTRON_USER_DATA_VARIABLE, FsScope, fsScopeFromPatterns } from '../shell/scope.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';

const CAPABILITIES = join(import.meta.dirname, '..', '..', 'resources/app', 'capabilities');
const MAIN = { window: 'main', webview: 'main' };
const ID = 'com.example.ds';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resolver(platform: ShellPlatform, env: Partial<PathEnvironment> = {}): PathResolver {
  return new PathResolver({ platform, env: {}, fallbackHome: '/home/u', identifier: ID, tempDir: '/tmp', resourceDir: null, ...env });
}

const WINDOWS_FOLDERS = {
  profile: 'C:\\Users\\u',
  roamingAppData: 'C:\\Users\\u\\AppData\\Roaming',
  localAppData: 'C:\\Users\\u\\AppData\\Local',
};

function runtime(platform: ShellPlatform, paths: PathResolver, userDataDir?: string): ShellRuntime {
  return new ShellRuntime({
    platform,
    debug: false,
    config: {
      productName: 'webview data test', version: '0.0.0', identifier: ID, devUrl: '', frontendDist: '', windows: [],
      assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
    },
    paths,
    assetScope: new FsScope({ platform }),
    fsScope: new FsScope({ platform }),
    appVersion: '0.0.0',
    localOrigin: 'tauri://localhost',
    log: () => undefined,
    acl: new BuiltinAcl([], platform),
    ...(userDataDir === undefined ? {} : { userDataDir }),
  });
}

/** main 的 fs 命令可用的 deny 条目（路径字符串）。 */
function mainFsDeny(platform: ShellPlatform, cmd = 'plugin:fs|read_file'): string[] {
  return BuiltinAcl.fromDirectory(CAPABILITIES, platform).scopeFor(cmd, MAIN).deny.map((entry) => (entry as { path: string }).path);
}

describe('RF-W23-fs-deny-webview-data-user-data: deny-default targets', () => {
  it('RF-W23-fs-deny-webview-data-user-data: every platform denies userData; only Windows keeps the legacy WebView2 profile; nowhere the whole $APPLOCALDATA', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      for (const cmd of ['plugin:fs|read_file', 'plugin:fs|write_file', 'plugin:fs|read_dir', 'plugin:fs|exists']) {
        const deny = mainFsDeny(platform, cmd);
        expect(deny).toContain(`${ELECTRON_USER_DATA_VARIABLE}/**`);
        expect(deny).toContain('$APPLOCALDATA/EBWebView/**');
        expect(deny).not.toContain('$APPLOCALDATA/**');
      }
    }
  });

  it('RF-W23-fs-deny-webview-data-user-data: on Windows, $APPLOCALDATA stays usable except EBWebView, and userData under Roaming is refused', () => {
    const paths = resolver('win32', { windowsKnownFolders: WINDOWS_FOLDERS });
    const shell = runtime('win32', paths);
    expect(shell.userDataDir).toBe('C:\\Users\\u\\AppData\\Roaming\\com.example.ds.electron');
    const acl = BuiltinAcl.fromDirectory(CAPABILITIES, 'win32').scopeFor('plugin:fs|read_file', MAIN);
    const strings = (entries: readonly unknown[]) => entries.map((entry) => (entry as { path: string }).path);
    const scope = fsScopeFromPatterns(paths, 'win32', strings(acl.allow), strings(acl.deny), shell.userDataDir);
    expect(scope.isAllowed('C:\\Users\\u\\AppData\\Local\\com.example.ds\\logs\\app.log')).toBe(true);
    expect(scope.isAllowed('C:\\Users\\u\\AppData\\Roaming\\com.example.ds\\workbench-wallpapers\\w.png')).toBe(true);
    expect(scope.isForbidden('C:\\Users\\u\\AppData\\Local\\com.example.ds\\EBWebView\\Default\\Network\\Cookies')).toBe(true);
    expect(scope.isForbidden('C:\\Users\\u\\AppData\\Local\\com.example.ds\\EBWebView\\Default\\Local Storage\\leveldb\\000003.log')).toBe(true);
    expect(scope.isForbidden('C:\\Users\\u\\AppData\\Roaming\\com.example.ds.electron\\Network\\Cookies')).toBe(true);
    expect(scope.isForbidden('C:\\Users\\u\\AppData\\Roaming\\com.example.ds.electron')).toBe(true);
    expect(scope.isForbidden('C:\\Users\\u\\AppData\\Local\\com.example.ds\\logs\\app.log')).toBe(false);
  });
});

describe('RF-W23-fs-deny-browser-profiles: the in-app browser sessions', () => {
  it('RF-W23-fs-deny-browser-profiles: every platform denies $APPDATA/slots/*/browser-profiles and everything below it, and only that', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(mainFsDeny(platform)).toEqual(expect.arrayContaining(['$APPDATA/slots/*/browser-profiles', '$APPDATA/slots/*/browser-profiles/**']));
    }
    const paths = resolver('linux', { env: { HOME: '/home/u' } });
    const scope = fsScopeFromPatterns(paths, 'linux', ['$APPDATA/**'], mainFsDeny('linux'), '/home/u/.config/com.example.ds.electron');
    const appData = '/home/u/.local/share/com.example.ds';
    for (const slot of ['slotA', 'slotB', 'slotC', 'slotD']) {
      expect(scope.isForbidden(`${appData}/slots/${slot}/browser-profiles`)).toBe(true);
      expect(scope.isForbidden(`${appData}/slots/${slot}/browser-profiles/default/Network/Cookies`)).toBe(true);
      expect(scope.isAllowed(`${appData}/slots/${slot}/chat_v2.db`)).toBe(true);
    }
    expect(scope.isAllowed(`${appData}/browser-profiles/notes.txt`)).toBe(true);
    expect(scope.isAllowed(`${appData}/slots/slotA/exports/browser-profiles.md`)).toBe(true);
  });
});

describe('RF-W23-fs-deny-webview-data-user-data: the userData directory', () => {
  it('RF-W23-fs-deny-webview-data-user-data: ShellRuntime defaults to main\'s <appData>/<identifier>.electron and takes the path main passes in', () => {
    expect(runtime('darwin', resolver('darwin', { env: { HOME: '/Users/u' } })).userDataDir).toBe('/Users/u/Library/Application Support/com.example.ds.electron');
    expect(runtime('linux', resolver('linux', { env: { HOME: '/home/u' } })).userDataDir).toBe('/home/u/.config/com.example.ds.electron');
    expect(runtime('linux', resolver('linux', { env: { HOME: '/home/u', XDG_CONFIG_HOME: '/xdg/config' } })).userDataDir).toBe('/xdg/config/com.example.ds.electron');
    expect(runtime('linux', resolver('linux'), '/tmp/smoke/electron-user-data').userDataDir).toBe('/tmp/smoke/electron-user-data');
    expect(runtime('win32', resolver('win32')).userDataDir).toBeNull();
  });

  it('RF-W23-fs-deny-webview-data-user-data: the directory is matched literally, with and without glob metacharacters, including the directory itself', () => {
    const base = mkdtempSync(join(tmpdir(), 'webview-data-'));
    temps.push(base);
    const userData = join(base, 'u[1]*?', 'ds.electron');
    const lookalike = join(base, 'u1xy', 'ds.electron');
    for (const dir of [userData, lookalike]) mkdirSync(dir, { recursive: true });
    const paths = resolver(process.platform === 'darwin' ? 'darwin' : 'linux', { env: { HOME: base } });
    const platform: ShellPlatform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const scope = fsScopeFromPatterns(paths, platform, [`${base}/**`], [`${ELECTRON_USER_DATA_VARIABLE}/**`], userData);
    expect(scope.isForbidden(userData)).toBe(true);
    expect(scope.isForbidden(join(userData, 'Cookies'))).toBe(true);
    expect(scope.isForbidden(join(userData, 'Local Storage', 'leveldb', '000003.log'))).toBe(true);
    expect(scope.isAllowed(join(lookalike, 'Cookies'))).toBe(true);
    expect(scope.isAllowed(join(base, 'u[1]*?', 'ds.electron-other', 'x'))).toBe(true);
  });

  it('RF-W23-fs-deny-webview-data-user-data: an unknown userData is skipped like an unresolvable variable; other spellings are rejected instead of dropped', () => {
    const paths = resolver('linux', { env: { HOME: '/home/u' } });
    const unknown = fsScopeFromPatterns(paths, 'linux', ['/srv/ds/**'], [`${ELECTRON_USER_DATA_VARIABLE}/**`], null);
    expect(unknown.isAllowed('/srv/ds/ud/Cookies')).toBe(true);
    expect(fsScopeFromPatterns(paths, 'linux', ['/srv/ds/**'], [`${ELECTRON_USER_DATA_VARIABLE}/**`], '/srv/ds/ud').isAllowed('/srv/ds/ud/Cookies')).toBe(false);
    for (const pattern of [ELECTRON_USER_DATA_VARIABLE, `${ELECTRON_USER_DATA_VARIABLE}/Cookies`, `${ELECTRON_USER_DATA_VARIABLE}/*`, `${ELECTRON_USER_DATA_VARIABLE}/**/x`]) {
      expect(() => fsScopeFromPatterns(paths, 'linux', [], [pattern], '/ud')).toThrow(/unsupported scope pattern/);
    }
    expect(fsScopeFromPatterns(paths, 'linux', [], [`${ELECTRON_USER_DATA_VARIABLE}//**/`], '/ud').isForbidden('/ud/x')).toBe(true);
  });
});
