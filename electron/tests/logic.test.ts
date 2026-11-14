import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRange, sniffMime } from '../shell/asset-protocol.ts';
import { urlPatternMatches } from '../shell/capabilities.ts';
import { describeUnexpected, reqString } from '../shell/args.ts';
import { ShellCommandError } from '../shell/errors.ts';
import { emitToFilter, isEventNameValid, JsListenerRegistry, windowEventFilter } from '../shell/events.ts';
import { GlobPattern } from '../shell/glob.ts';
import { hotKeyToString, parseHotKey, toElectronAccelerator } from '../shell/hotkey.ts';
import * as ops from '../shell/path-ops.ts';
import { BaseDirectory, parseXdgUserDir, PathResolver } from '../shell/paths.ts';
import { FsScope } from '../shell/scope.ts';
import { mergePatch } from '../shell/tauri-config.ts';
import { windowsLocalhostRewrite } from '../shell/url-forms.ts';

describe('event target filtering (tauri manager emit_to / emit_js_filter)', () => {
  it('Any listeners always match; labeled filters follow filter_target', () => {
    const reg = new JsListenerRegistry();
    const any = reg.listen('main', 'e', { kind: 'Any' });
    const win = reg.listen('main', 'e', { kind: 'Window', label: 'main' });
    const other = reg.listen('mini', 'e', { kind: 'Window', label: 'mini' });
    const wv = reg.listen('mini', 'e', { kind: 'Webview', label: 'mini' });
    expect(any).toBe(0);
    expect(reg.collect('e', emitToFilter({ kind: 'AnyLabel', label: 'mini' }))).toEqual(
      new Map([
        ['main', [any]],
        ['mini', [other, wv]],
      ]),
    );
    expect(reg.collect('e', emitToFilter({ kind: 'Window', label: 'main' }))).toEqual(
      new Map([
        ['main', [any, win]],
        ['mini', []],
      ]),
    );
    expect(reg.collect('e', windowEventFilter('mini')).get('mini')).toEqual([other]);
    expect(reg.collect('e', emitToFilter({ kind: 'App' })).get('mini')).toEqual([]);
    expect(reg.hasListener('e', windowEventFilter('main'))).toBe(true);
    reg.unlisten('e', win);
    expect(reg.hasListener('e', windowEventFilter('main'))).toBe(false);
  });

  it('event name validation', () => {
    expect(isEventNameValid('tauri://drag-drop')).toBe(true);
    expect(isEventNameValid('中文_事件')).toBe(true);
    expect(isEventNameValid('bad name')).toBe(false);
  });
});

describe('arg errors', () => {
  it('missing key and type errors use Tauri text', () => {
    const input = { command: 'read_text', json: {}, raw: null, headers: {} };
    expect(() => reqString(input, 'path')).toThrow(ShellCommandError);
    try {
      reqString(input, 'path');
    } catch (e) {
      expect((e as ShellCommandError).value).toBe('invalid args `path` for command `read_text`: command read_text missing required key path');
    }
    expect(describeUnexpected(5)).toBe('integer `5`');
  });
});

describe('glob (glob 0.3 semantics)', () => {
  const opts = { requireLiteralSeparator: true, requireLiteralLeadingDot: true, windows: false };
  it('* does not cross separators, ** does, leading dot is literal', () => {
    expect(new GlobPattern('/a/*', false).matches('/a/b', opts)).toBe(true);
    expect(new GlobPattern('/a/*', false).matches('/a/b/c', opts)).toBe(false);
    expect(new GlobPattern('/a/**', false).matches('/a/b/c', opts)).toBe(true);
    expect(new GlobPattern('/a/**', false).matches('/a/.hidden/c', opts)).toBe(false);
    expect(new GlobPattern(GlobPattern.escape('/x[1]'), false).matches('/x[1]', opts)).toBe(true);
  });
});

describe('fs scope', () => {
  it('allow/deny with canonicalization', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scope-')));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'f.txt'), 'x');
    const scope = new FsScope({ platform: process.platform === 'win32' ? 'win32' : 'darwin' });
    scope.allowPattern(`${dir}/**`);
    expect(scope.isAllowed(join(dir, 'sub', 'f.txt'))).toBe(true);
    scope.forbidPattern(`${dir}/sub/**`);
    expect(scope.isAllowed(join(dir, 'sub', 'f.txt'))).toBe(false);
    const runtime = new FsScope({ platform: 'darwin' });
    runtime.allowFile(join(dir, 'sub', 'f.txt'));
    expect(runtime.isAllowed(join(dir, 'sub', 'f.txt'))).toBe(true);
    expect(runtime.isAllowed(join(dir, 'other'))).toBe(false);
  });
});

describe('app data dir (Tauri app_data_dir = dirs::data_dir()/identifier)', () => {
  const id = 'com.deepstudent.app';
  it('macOS', () => {
    const p = new PathResolver({ platform: 'darwin', env: { HOME: '/Users/u' }, fallbackHome: '', identifier: id, tempDir: '/tmp', resourceDir: null });
    expect(p.appDataDir()).toBe('/Users/u/Library/Application Support/com.deepstudent.app');
    expect(p.resolveDirectory(BaseDirectory.AppLog)).toBe('/Users/u/Library/Logs/com.deepstudent.app');
    expect(p.resolveDirectory(BaseDirectory.AppCache)).toBe('/Users/u/Library/Caches/com.deepstudent.app');
  });
  it('Linux honours absolute XDG_DATA_HOME only', () => {
    const mk = (env: Record<string, string>) =>
      new PathResolver({ platform: 'linux', env, fallbackHome: '/home/u', identifier: id, tempDir: '/tmp', resourceDir: null }, () => null);
    expect(mk({ HOME: '/home/u' }).appDataDir()).toBe('/home/u/.local/share/com.deepstudent.app');
    expect(mk({ HOME: '/home/u', XDG_DATA_HOME: '/data' }).appDataDir()).toBe('/data/com.deepstudent.app');
    expect(mk({ HOME: '/home/u', XDG_DATA_HOME: 'rel' }).appDataDir()).toBe('/home/u/.local/share/com.deepstudent.app');
    expect(() => mk({ HOME: '/home/u' }).resolveDirectory(BaseDirectory.Desktop)).toThrow('unknown path');
  });
  it('Windows uses FOLDERID_RoamingAppData', () => {
    const p = new PathResolver({
      platform: 'win32',
      env: {},
      fallbackHome: '',
      identifier: id,
      tempDir: 'C:\\Temp',
      resourceDir: null,
      windowsKnownFolders: { roamingAppData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'C:\\Users\\u\\AppData\\Local' },
    });
    expect(p.appDataDir()).toBe('C:\\Users\\u\\AppData\\Roaming\\com.deepstudent.app');
    expect(p.resolveDirectory(BaseDirectory.AppLog)).toBe('C:\\Users\\u\\AppData\\Local\\com.deepstudent.app\\logs');
  });
  it('data_local_dir / cache_dir follow dirs 6.0 on every platform (host storage aligns to these)', () => {
    const win = new PathResolver({
      platform: 'win32',
      env: { LOCALAPPDATA: 'D:\\ignored-env' },
      fallbackHome: '',
      identifier: id,
      tempDir: 'C:\\Temp',
      resourceDir: null,
      windowsKnownFolders: { roamingAppData: 'C:\\Users\\u\\AppData\\Roaming', localAppData: 'E:\\Redirected\\Local' },
    });
    // 只取 Known Folder 提供的值，不读进程环境变量。
    expect(win.localDataDir()).toBe('E:\\Redirected\\Local');
    expect(win.cacheDir()).toBe('E:\\Redirected\\Local');
    expect(new PathResolver({ platform: 'win32', env: {}, fallbackHome: '', identifier: id, tempDir: 'C:\\Temp', resourceDir: null }).localDataDir()).toBeNull();
    const mac = new PathResolver({ platform: 'darwin', env: { HOME: '/Users/u' }, fallbackHome: '', identifier: id, tempDir: '/tmp', resourceDir: null });
    expect(mac.localDataDir()).toBe('/Users/u/Library/Application Support');
    expect(mac.cacheDir()).toBe('/Users/u/Library/Caches');
    const linux = new PathResolver({ platform: 'linux', env: { HOME: '/home/u', XDG_DATA_HOME: '/data', XDG_CACHE_HOME: 'rel' }, fallbackHome: '/home/u', identifier: id, tempDir: '/tmp', resourceDir: null }, () => null);
    expect(linux.localDataDir()).toBe('/data');
    expect(linux.cacheDir()).toBe('/home/u/.cache');
  });
  it('xdg user-dirs parsing', () => {
    expect(parseXdgUserDir('/home/u', 'XDG_DESKTOP_DIR="$HOME/Desk top"\n', 'DESKTOP')).toBe('/home/u/Desk top');
  });
  it('variable patterns drop `..`', () => {
    const p = new PathResolver({ platform: 'darwin', env: { HOME: '/Users/u' }, fallbackHome: '', identifier: id, tempDir: '/tmp', resourceDir: null });
    expect(p.parseVariablePath('$APPDATA/**')).toBe('/Users/u/Library/Application Support/com.deepstudent.app/**');
  });
});

describe('path plugin pure ops (tauri path/plugin.rs)', () => {
  it('join / normalize / dirname / basename / extname', () => {
    expect(ops.join(['a', 'b', '../c'], 'darwin')).toBe('a/c');
    expect(ops.join(['/a', '', 'b'], 'darwin')).toBe('/a/b');
    expect(ops.join([], 'darwin')).toBe('.');
    expect(ops.normalize('/a/./b/../c/', 'darwin')).toBe('/a/c/');
    expect(ops.normalize('..', 'darwin')).toBe('..');
    expect(ops.dirname('/a/b', 'darwin')).toBe('/a');
    expect(() => ops.dirname('/', 'darwin')).toThrow(ops.NO_PARENT);
    expect(ops.basename('/p/f.json', '.json', 'darwin')).toBe('f');
    expect(ops.extname('/p/f.tar.gz', 'darwin')).toBe('gz');
    expect(() => ops.extname('/p/.bashrc', 'darwin')).toThrow(ops.NO_EXTENSION);
    expect(ops.isAbsolute('C:\\x', 'win32')).toBe(true);
    expect(ops.join(['C:\\a', 'b'], 'win32')).toBe('C:\\a\\b');
  });
});

describe('url forms and scopes', () => {
  it('windows *.localhost rewrite', () => {
    expect(windowsLocalhostRewrite('http://pdfstream.localhost/%2Fa.pdf?x=1')).toEqual({ scheme: 'pdfstream', url: 'pdfstream://localhost/%2Fa.pdf?x=1' });
    expect(windowsLocalhostRewrite('http://127.0.0.1:1422/')).toBeNull();
  });
  it('URLPattern subset', () => {
    expect(urlPatternMatches('https://*/*', new URL('https://api.x.com/v1'))).toBe(true);
    expect(urlPatternMatches('http://127.0.0.1:*/*', new URL('http://127.0.0.1:8080/a'))).toBe(true);
    expect(urlPatternMatches('https://*/*', new URL('http://a.com/'))).toBe(false);
    expect(urlPatternMatches('mailto:*', new URL('mailto:a@b.c'))).toBe(true);
  });
  it('asset range parsing and mime sniffing', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual([[0, 10]]);
    expect(parseRange('bytes=-10', 100)).toEqual([[90, 10]]);
    expect(parseRange('bytes=200-', 100)).toBeNull();
    expect(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'x.bin')).toBe('application/pdf');
    expect(sniffMime(new Uint8Array([]), 'a.mp4')).toBe('video/mp4');
  });
  it('JSON merge patch replaces arrays', () => {
    expect(mergePatch({ app: { windows: [1, 2], x: 1 } }, { app: { windows: [3] } })).toEqual({ app: { windows: [3], x: 1 } });
  });
});

describe('global-hotkey parsing (global-hotkey 0.8.0)', () => {
  it('id, normalized string and accelerator', () => {
    const mac = parseHotKey('CommandOrControl+Shift+Space', 'darwin');
    expect(hotKeyToString(mac)).toBe('shift+super+Space');
    expect(mac.id).toBe((((0x2000 | 0x200) << 16) | 62) >>> 0);
    expect(toElectronAccelerator(mac)).toBe('Shift+Super+Space');
    expect(hotKeyToString(parseHotKey('CmdOrCtrl+K', 'linux'))).toBe('control+KeyK');
    expect(() => parseHotKey('Ctrl+Nope', 'linux')).toThrow(/Couldn't recognize "Nope"/);
  });
});
