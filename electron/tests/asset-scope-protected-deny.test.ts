/**
 * asset 协议作用域加上 fs 插件同一份受保护 deny（`capabilities.ts` `PROTECTED_FS_DENY` / `withProtectedDeny`）：
 * tauri.conf.json 的 `$APPDATA/**`、`$APPLOCALDATA/**` 覆盖内置浏览器会话与 WebView 数据，fs 插件挡住了，asset: 没挡。
 * 文件都是临时目录里自造的假文件。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetResponse } from '../shell/asset-protocol.ts';
import { deriveScopes, PROTECTED_FS_DENY, withProtectedDeny } from '../shell/capabilities.ts';
import { PathResolver } from '../shell/paths.ts';
import { fsScopeFromPatterns } from '../shell/scope.ts';
import { loadTauriConfig, type ShellPlatform } from '../shell/tauri-config.ts';

const TAURI_DIR = join(import.meta.dirname, '..', '..', 'resources/app');
const CAPABILITIES = join(TAURI_DIR, 'capabilities');
const ID = 'com.example.ds';
const ORIGIN = 'tauri://localhost';
const platform: ShellPlatform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'asset-deny-')));
  temps.push(home);
  const configHome = join(home, '.config');
  const paths = new PathResolver({
    platform, env: { HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: join(home, '.local', 'share') }, fallbackHome: home, identifier: ID, tempDir: join(home, 'tmp'), resourceDir: null,
    windowsKnownFolders: { profile: home, roamingAppData: join(home, 'AppData', 'Roaming'), localAppData: join(home, 'AppData', 'Local') },
  });
  const appData = paths.appDataDir()!;
  const appLocalData = paths.parseVariablePath('$APPLOCALDATA');
  const userData = join(home, 'user-data', `${ID}.electron`);
  const files = {
    cookies: join(appData, 'slots', 'a', 'browser-profiles', 'Default', 'Cookies'),
    wallpaper: join(appData, 'workbench-wallpapers', 'a.png'),
    slotDb: join(appData, 'slots', 'a', 'chat_v2.db'),
    pluginProfile: join(appData, 'plugins', 'user.profile.json'),
    webView2: join(appLocalData, 'EBWebView', 'Default', 'Network', 'Cookies'),
    userDataCookies: join(userData, 'Cookies'),
  };
  for (const file of Object.values(files)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'SQLite format 3\0fake-session');
  }
  const { assetScope } = loadTauriConfig(TAURI_DIR, platform);
  return { paths, files, userData, assetScope };
}

async function status(scope: ReturnType<typeof fsScopeFromPatterns>, path: string): Promise<number> {
  const response = await assetResponse({ url: `asset://localhost/${encodeURIComponent(path)}`, method: 'GET', headers: {} }, scope, ORIGIN, platform);
  if (response.body instanceof ReadableStream) await response.body.cancel();
  return response.status;
}

describe('RF-W23-asset-scope-protected-deny: asset: carries the fs plugin protected deny', () => {
  it('RF-W23-asset-scope-protected-deny: the shared list is exactly what fs denies on every platform, so the two cannot drift', () => {
    expect(PROTECTED_FS_DENY).toEqual(expect.arrayContaining([
      '$APPDATA/plugins', '$APPDATA/plugins/**',
      '$APPDATA/slots/*/browser-profiles', '$APPDATA/slots/*/browser-profiles/**',
      '$APPLOCALDATA/EBWebView/**', '$ELECTRON_USERDATA/**',
    ]));
    for (const p of ['linux', 'darwin', 'win32'] as const) {
      expect(deriveScopes(CAPABILITIES, p).fsDeny).toEqual(expect.arrayContaining([...PROTECTED_FS_DENY]));
    }
    expect(withProtectedDeny(['$TEMP/x/**'])).toEqual(['$TEMP/x/**', ...PROTECTED_FS_DENY]);
    expect(withProtectedDeny(['$APPDATA/plugins'])).toEqual(['$APPDATA/plugins', ...PROTECTED_FS_DENY.filter((p) => p !== '$APPDATA/plugins')]);
  });

  it('RF-W23-asset-scope-protected-deny: <appData>/slots/a/browser-profiles/Default/Cookies is refused (403), <appData>/workbench-wallpapers/a.png still served (200)', async () => {
    const { paths, files, userData, assetScope } = fixture();
    const scope = fsScopeFromPatterns(paths, platform, assetScope.allow, withProtectedDeny(assetScope.deny), userData);
    expect(scope.isAllowed(files.cookies)).toBe(false);
    expect(scope.isAllowed(files.wallpaper)).toBe(true);
    expect(await status(scope, files.cookies)).toBe(403);
    expect(await status(scope, files.wallpaper)).toBe(200);
    expect(await status(scope, files.slotDb)).toBe(200);
    for (const path of [files.pluginProfile, files.webView2, files.userDataCookies]) expect(await status(scope, path)).toBe(403);
  });

  it('RF-W23-asset-scope-protected-deny: without the shared deny the tauri.conf.json asset scope serves the session cookies (what Rust and main.ts:199 do today)', async () => {
    const { paths, files, userData, assetScope } = fixture();
    expect(assetScope.deny).toEqual([]);
    const scope = fsScopeFromPatterns(paths, platform, assetScope.allow, assetScope.deny, userData);
    expect(await status(scope, files.cookies)).toBe(200);
    expect(await status(scope, files.webView2)).toBe(200);
  });
});
