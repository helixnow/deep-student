/**
 * Electron shell built-in plugins (`electron/shell/plugins/*`) against the Tauri capability files.
 *
 * Tauri resolves every `plugin:*` command through the ACL of the calling webview: `browser-content`
 * (remote pages) holds only `allow-browser-content-user-input`, `quick-assistant` / `pomodoro-mini`
 * hold a short list, and `fs:allow-desktop-read-recursive` grants no write commands. The Electron
 * shell checks every page-issued built-in command against the same capability files
 * (`electron/shell/capabilities.ts` `BuiltinAcl`, consulted by `electron/shell/runtime.ts` before
 * `runBuiltin`); these tests drive the real runtime and plugins with scopes derived from
 * `src-tauri/capabilities`.
 *
 * Issue ids refer to `reviews/ELECTRON-SHELL-SECURITY.md`.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assetResponse } from '../../../electron/shell/asset-protocol.ts';
import { deriveScopes, withProtectedDeny } from '../../../electron/shell/capabilities.ts';
import type { MainToRenderer } from '../../../electron/shell/bridge-messages.ts';
import type { HostSupervisor } from '../../../electron/shell/host.ts';
import { PathResolver, UnknownPathError } from '../../../electron/shell/paths.ts';
import { eventPlugin } from '../../../electron/shell/plugins/event.ts';
import { fsPlugin } from '../../../electron/shell/plugins/fs.ts';
import { ShellRuntime, type BrowserWebview } from '../../../electron/shell/runtime.ts';
import { FsScope, fsScopeFromPatterns } from '../../../electron/shell/scope.ts';
import { loadTauriConfig, type ShellPlatform } from '../../../electron/shell/tauri-config.ts';
import type { ShellWindow, WindowManager } from '../../../electron/shell/windows.ts';

const CAPABILITIES = join(import.meta.dirname, '../../../resources/app/capabilities');
const platform: ShellPlatform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
const IDENTIFIER = 'sec.shell.test';
type WebContents = Parameters<ShellRuntime['handleBrowserInvoke']>[0];

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** `electron/main.ts` `scopeFrom`: capability patterns expanded by the PathResolver, unknown variables skipped. */
function scopeFrom(paths: PathResolver, allow: readonly string[], deny: readonly string[]): FsScope {
  const scope = new FsScope({ platform });
  const expand = (pattern: string): string | null => {
    try { return paths.parseVariablePath(pattern); } catch (error) {
      if (error instanceof UnknownPathError) return null;
      throw error;
    }
  };
  for (const pattern of allow) { const p = expand(pattern); if (p !== null) scope.allowPattern(p); }
  for (const pattern of deny) { const p = expand(pattern); if (p !== null) scope.forbidPattern(p); }
  return scope;
}

interface Sent { label: string; message: MainToRenderer }

function harness(options: { userDataDir?: (home: string) => string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'sec-shell-'));
  homes.push(home);
  const configHome = join(home, '.config');
  mkdirSync(configHome, { recursive: true });
  writeFileSync(join(configHome, 'user-dirs.dirs'), 'XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Documents"\n');
  const desktop = join(home, 'Desktop');
  const documents = join(home, 'Documents');
  const roamingAppData = join(home, 'AppData', 'Roaming');
  const paths = new PathResolver({
    platform, env: { HOME: home, XDG_CONFIG_HOME: configHome }, fallbackHome: home, identifier: IDENTIFIER, tempDir: join(home, 'tmp'), resourceDir: null,
    windowsKnownFolders: { profile: home, roamingAppData, localAppData: join(home, 'AppData', 'Local'), desktop, documents },
  });
  const appData = paths.appDataDir()!;
  /** `electron/main.ts` 的默认 userData：`app.getPath('appData')`（macOS `~/Library/Application Support`，Windows `%APPDATA%`，Linux `$XDG_CONFIG_HOME`）下的 `<identifier>.electron`。 */
  const defaultUserData = join(platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? roamingAppData : configHome, `${IDENTIFIER}.electron`);
  const explicitUserData = options.userDataDir?.(home);
  const userData = explicitUserData ?? defaultUserData;
  for (const dir of [appData, desktop, documents, join(userData, 'Local Storage', 'leveldb')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(userData, 'Cookies'), 'SQLite format 3\0session=secret');
  writeFileSync(join(userData, 'Local Storage', 'leveldb', '000003.log'), 'token');

  const derived = deriveScopes(CAPABILITIES, platform);
  const fsGlobal = scopeFrom(paths, derived.fsAllow, derived.fsDeny);
  const fsRuntime = new FsScope({ platform });
  const logs: string[] = [];
  const runtime = new ShellRuntime({
    platform, debug: false,
    config: {
      productName: 'security test', version: '0.0.0', identifier: IDENTIFIER, devUrl: '', frontendDist: '', windows: [],
      assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
    },
    paths, assetScope: new FsScope({ platform }), fsScope: fsGlobal, appVersion: '0.0.0', localOrigin: 'tauri://localhost', log: (line) => { logs.push(line); },
    ...(explicitUserData === undefined ? {} : { userDataDir: explicitUserData }),
  });
  runtime.registerPlugin('fs', fsPlugin({ global: fsGlobal, runtime: fsRuntime }));
  runtime.registerPlugin('event', eventPlugin());

  const sent: Sent[] = [];
  const contentsFor = (label: string) => ({ isDestroyed: () => false, send: (_channel: string, message: MainToRenderer) => sent.push({ label, message }) });
  const windows = new Map<string, { label: string; webContents: ReturnType<typeof contentsFor> }>();
  for (const label of ['main', 'quick-assistant', 'pomodoro-mini']) windows.set(label, { label, webContents: contentsFor(label) });
  runtime.windows = { get: (label: string) => windows.get(label), labels: () => [...windows.keys()] } as unknown as WindowManager;

  const toHost: unknown[] = [];
  runtime.host = {
    sendMessage: (message: unknown) => { toHost.push(message); },
    invoke: (request: unknown, sink: { resolve(result: unknown): void }) => {
      toHost.push(request);
      sink.resolve({ ok: false, error: 'host not attached in this test' });
    },
    abandonWebview: () => undefined,
  } as unknown as HostSupervisor;

  const browserContents = contentsFor('browser-content') as unknown as WebContents;
  const browser: BrowserWebview = { label: 'browser-content', windowLabel: 'main', webContents: browserContents, initializationScript: '' };

  type Caller = { kind: 'browser'; pageUrl: string } | { kind: 'window'; label: string; pageUrl: string };
  let callbackId = 10;
  const invoke = async (caller: Caller, cmd: unknown, json: unknown, headers: Record<string, string> = {}) => {
    const callback = (callbackId += 2);
    const message = { type: 'invoke' as const, cmd: cmd as string, callback, error: callback + 1, payload: { contentType: 'application/json' as const, data: JSON.stringify(json) }, headers };
    if (caller.kind === 'browser') runtime.handleBrowserInvoke(browserContents, browser, message, caller.pageUrl);
    else runtime.handleInvoke(windows.get(caller.label) as unknown as ShellWindow, message, caller.pageUrl);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const reply = sent.find(entry => entry.message.type === 'result' && (entry.message.callbackId === callback || entry.message.callbackId === callback + 1));
      if (reply !== undefined && reply.message.type === 'result') {
        const body = reply.message.body;
        return { ok: reply.message.callbackId === callback, value: body.kind === 'json' ? JSON.parse(body.data) as unknown : body.data };
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return { ok: false, value: 'no reply' };
  };
  /** Delivers an arbitrary renderer value; returns the replies sent for it (none when it could not be answered). */
  const post = async (caller: Caller, message: unknown) => {
    const before = sent.length;
    if (caller.kind === 'browser') runtime.handleBrowserInvoke(browserContents, browser, message as never, caller.pageUrl);
    else runtime.handleInvoke(windows.get(caller.label) as unknown as ShellWindow, message as never, caller.pageUrl);
    await new Promise(resolve => setTimeout(resolve, 20));
    return sent.slice(before).map(entry => entry.message);
  };
  const remotePage = { kind: 'browser' as const, pageUrl: 'https://attacker.example/landing' };
  return { runtime, invoke, post, remotePage, paths, appData, desktop, documents, home, userData, toHost, sent, browser, browserContents, fsRuntime, logs };
}

const MAIN = { kind: 'window' as const, label: 'main', pageUrl: 'tauri://localhost/index.html' };
const QUICK = { kind: 'window' as const, label: 'quick-assistant', pageUrl: 'tauri://localhost/quick-assistant.html' };
const POMODORO = { kind: 'window' as const, label: 'pomodoro-mini', pageUrl: 'tauri://localhost/pomodoro-mini.html' };
const errorText = (message: MainToRenderer | undefined) =>
  message?.type === 'result' && message.body.kind === 'json' ? JSON.parse(message.body.data) as unknown : undefined;

const denied = (reply: { ok: boolean; value: unknown }) => !reply.ok && typeof reply.value === 'string' && /not allowed/i.test(reply.value);

const MAIN_ASSET_SCOPE_LINE = readFileSync(join(import.meta.dirname, '../../../electron/main.ts'), 'utf8')
  .split('\n').find((line) => /\bassetScope: fsScopeFromPatterns\(/.test(line));
const MAIN_ASSET_SCOPE_WIRED = MAIN_ASSET_SCOPE_LINE?.includes('withProtectedDeny(config.assetScope.deny)') === true;

/** The temp directory (where the harness puts its home) treats `a` and `A` as the same name (default APFS, NTFS). */
function caseInsensitiveTmp(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'sec-case-'));
  try {
    writeFileSync(join(dir, 'probe'), '');
    return existsSync(join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SEC-E01 [W06] browser-content remote pages and the shell built-in plugins', () => {
  it('SEC-E01 [W06] a remote page in browser-content cannot read the user documents through plugin:fs (Tauri grants it only allow-browser-content-user-input)', async () => {
    const h = harness();
    const secret = join(h.documents, 'thesis.md');
    writeFileSync(secret, 'unpublished draft');
    const reply = await h.invoke(h.remotePage, 'plugin:fs|read_text_file', { path: secret });
    expect(reply.ok).toBe(false);
  });

  it('SEC-E01 [W06] a remote page in browser-content cannot write into the user documents through plugin:fs', async () => {
    const h = harness();
    const target = join(h.documents, 'invoice.html');
    await h.invoke(h.remotePage, 'plugin:fs|write_file', Array.from(Buffer.from('<script>')), { path: encodeURIComponent(target) });
    expect(existsSync(target)).toBe(false);
  });


  it('SEC-E05 [W06] a remote page in browser-content cannot forge dstu-browser:// content events (plugin:event|emit carries the trusted browser-content source)', async () => {
    const h = harness();
    const reply = await h.invoke(h.remotePage, 'plugin:event|emit', { event: 'dstu-browser://page-finished', payload: { url: 'https://bank.example/account' } });
    expect(denied(reply)).toBe(true);
    expect(h.toHost.some(message => (message as { event?: string }).event === 'dstu-browser://page-finished')).toBe(false);
  });

  it('SEC-E05 [W23] a page emit never reaches the Host with the native marker, however the page phrases it; only main-generated events carry native: true', async () => {
    const h = harness();
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['plugin:event|emit', { event: 'dstu-browser://page-finished', payload: { url: 'https://bank.example/' }, native: true }],
      ['plugin:event|emit', { event: 'dstu-browser://title-changed', payload: { native: true, title: 'Bank', url: 'https://bank.example/' }, source: { window: 'main', webview: 'browser-content', native: true } }],
      ['plugin:event|emit_to', { target: { kind: 'Any' }, event: 'dstu-browser://navigation-blocked', payload: null, native: true, kind: 'frontend-event' }],
      ['plugin:event|emit_to', { target: { kind: 'App', native: true }, event: 'global-shortcut://triggered', payload: { state: 'Pressed' }, native: 'true' }],
      ['plugin:event|emit', JSON.parse('{"event":"dstu-browser://page-finished","payload":null,"__proto__":{"native":true}}') as Record<string, unknown>],
    ];
    for (const caller of [MAIN, QUICK, POMODORO]) {
      for (const [cmd, args] of attempts) {
        const before = h.toHost.length;
        expect(await h.invoke(caller, cmd, args), `${caller.label} ${cmd}`).toEqual({ ok: true, value: null });
        const forwarded = h.toHost.slice(before) as Array<Record<string, unknown>>;
        expect(forwarded).toHaveLength(1);
        const message = forwarded[0]!;
        expect(Object.keys(message).sort()).toEqual(['event', 'kind', 'payload', 'source', 'target']);
        expect(message.native).toBeUndefined();
        expect(message.source).toEqual({ window: caller.label, webview: caller.label });
        expect(Object.keys(message.target as object).every(key => key === 'kind' || key === 'label')).toBe(true);
      }
    }

    h.runtime.sendNativeEvent('dstu-browser://page-finished', { url: 'https://example.org/' }, { window: 'main', webview: 'browser-content', origin: 'https://ignored.example' });
    expect(h.toHost.at(-1)).toEqual({
      kind: 'frontend-event', event: 'dstu-browser://page-finished', payload: { url: 'https://example.org/' },
      target: { kind: 'App' }, source: { window: 'main', webview: 'browser-content' }, native: true,
    });
  });

  it('SEC-E01 [W06] Host-bound commands from browser-content carry the remote origin so the kernel ACL can refuse them', async () => {
    const h = harness();
    await h.invoke(h.remotePage, 'get_settings', {});
    expect(h.toHost).toContainEqual(expect.objectContaining({
      cmd: 'get_settings', source: { window: 'main', webview: 'browser-content', origin: 'https://attacker.example' },
    }));
  });

  it('SEC-E01 [W06] a browser-content page parked on a local-looking URL is still treated as remote', async () => {
    const h = harness();
    await h.invoke({ kind: 'browser', pageUrl: 'tauri://localhost/index.html' }, 'get_settings', {});
    expect(h.toHost).toContainEqual(expect.objectContaining({ source: expect.objectContaining({ origin: 'null' }) }));
  });

  it('SEC-E01 [W23] browser-content holds no built-in plugin command at all, on any URL', async () => {
    const h = harness();
    for (const origin of ['https://attacker.example', 'null']) {
      expect(h.runtime.acl.grantedCommands({ window: 'main', webview: 'browser-content', origin })).toEqual([]);
    }
    for (const [cmd, args] of [
      ['plugin:event|listen', { event: 'tauri://focus', target: { kind: 'Any' }, handler: 1 }],
      ['plugin:event|emit_to', { target: { kind: 'Any' }, event: 'x', payload: null }],
      ['plugin:fs|exists', { path: h.documents }],
      ['plugin:fs|read_dir', { path: h.documents }],
    ] as const) {
      expect(denied(await h.invoke(h.remotePage, cmd, args))).toBe(true);
      expect(denied(await h.invoke({ kind: 'browser', pageUrl: 'about:blank' }, cmd, args))).toBe(true);
    }
    expect(h.toHost).toEqual([]);
  });

  it('SEC-E01 [W23] the main window loses its built-in plugins once its frame is a remote page', async () => {
    const h = harness();
    writeFileSync(join(h.documents, 'thesis.md'), 'draft');
    const reply = await h.invoke({ kind: 'window', label: 'main', pageUrl: 'https://attacker.example/' }, 'plugin:fs|read_text_file', { path: join(h.documents, 'thesis.md') });
    expect(reply).toEqual({ ok: false, value: 'Command plugin:fs|read_text_file not allowed by ACL' });
  });

  it('SEC-E01 [W23] unregistered and unknown commands are refused by default, with the Tauri release text', async () => {
    const h = harness();
    expect(await h.invoke(MAIN, 'plugin:fs|nope', {})).toEqual({ ok: false, value: 'Command plugin:fs|nope not allowed by ACL' });
    expect(await h.invoke(MAIN, 'plugin:fs|size', { path: h.documents })).toEqual({ ok: false, value: 'Command plugin:fs|size not allowed by ACL' });
  });

  it('SEC-E01 [W23] commands the ACL grants but no desktop build implements answer like Tauri, after the ACL check', async () => {
    const h = harness();
    for (const command of ['watch', 'unwatch', 'scope-app-index']) {
      expect(await h.invoke(MAIN, `plugin:fs|${command}`, { paths: [h.documents], options: {} })).toEqual({ ok: false, value: `Command ${command} not found` });
      expect(await h.invoke(h.remotePage, `plugin:fs|${command}`, {})).toEqual({ ok: false, value: `Command plugin:fs|${command} not allowed by ACL` });
      expect(await h.invoke(QUICK, `plugin:fs|${command}`, {})).toEqual({ ok: false, value: `Command plugin:fs|${command} not allowed by ACL` });
    }
    expect(h.toHost).toEqual([]);
  });
});

describe('SEC-E01 [W23] the local main window keeps its normal built-in plugins', () => {
  it('SEC-E01 [W23] main reads and writes the granted directories and emits events to the Host', async () => {
    const h = harness();
    writeFileSync(join(h.documents, 'a.txt'), 'A');
    expect(await h.invoke(MAIN, 'plugin:fs|read_text_file', { path: join(h.documents, 'a.txt') })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|exists', { path: join(h.documents, 'a.txt') })).toEqual({ ok: true, value: true });
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.documents, 'sub'), options: { recursive: true } })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|read_dir', { path: h.documents })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:event|emit', { event: 'main-ping', payload: { n: 1 } })).toEqual({ ok: true, value: null });
    const forwarded = h.toHost.find(message => (message as { event?: string }).event === 'main-ping') as Record<string, unknown> | undefined;
    expect(forwarded).toMatchObject({ kind: 'frontend-event', source: { window: 'main', webview: 'main' } });
    expect(forwarded).not.toHaveProperty('native');
  });

  it('SEC-E01 [W23] each window command set covers what its frontend calls (src/** audit of @tauri-apps plugin and window APIs)', () => {
    const h = harness();
    const granted = new Set(h.runtime.acl.grantedCommands({ window: 'main', webview: 'main' }));
    const used = [
      'plugin:clipboard-manager|read_text', 'plugin:clipboard-manager|write_text',
      'plugin:dialog|confirm', 'plugin:dialog|open', 'plugin:dialog|save', 'plugin:event|emit', 'plugin:event|emit_to',
      'plugin:event|listen', 'plugin:event|unlisten', 'plugin:fs|copy_file', 'plugin:fs|mkdir', 'plugin:fs|open', 'plugin:fs|read',
      'plugin:fs|read_dir', 'plugin:fs|read_file', 'plugin:fs|read_text_file', 'plugin:fs|remove', 'plugin:fs|write', 'plugin:fs|write_file',
      'plugin:global-shortcut|is_registered', 'plugin:global-shortcut|register', 'plugin:global-shortcut|unregister',
      'plugin:http|fetch', 'plugin:http|fetch_cancel', 'plugin:http|fetch_read_body', 'plugin:http|fetch_send',
      'plugin:notification|is_permission_granted', 'plugin:notification|notify', 'plugin:notification|request_permission',
      'plugin:opener|open_path', 'plugin:opener|open_url', 'plugin:opener|reveal_item_in_dir', 'plugin:path|join',
      'plugin:path|resolve_directory', 'plugin:process|restart', 'plugin:resources|close', 'plugin:updater|check',
      'plugin:updater|download_and_install', 'plugin:webview|create_webview_window', 'plugin:webview|set_webview_zoom',
      'plugin:window|close', 'plugin:window|get_all_windows', 'plugin:window|is_focused', 'plugin:window|is_fullscreen',
      'plugin:window|is_maximized', 'plugin:window|maximize', 'plugin:window|minimize', 'plugin:window|start_dragging',
      'plugin:window|unmaximize',
    ];
    expect(used.filter(cmd => !granted.has(cmd))).toEqual([]);
    const quick = new Set(h.runtime.acl.grantedCommands({ window: 'quick-assistant', webview: 'quick-assistant' }));
    const quickUsed = ['plugin:clipboard-manager|read_text', 'plugin:clipboard-manager|write_text', 'plugin:event|emit_to', 'plugin:event|listen', 'plugin:event|unlisten', 'plugin:window|get_all_windows', 'plugin:window|hide'];
    expect(quickUsed.filter(cmd => !quick.has(cmd))).toEqual([]);
    const pomodoro = new Set(h.runtime.acl.grantedCommands({ window: 'pomodoro-mini', webview: 'pomodoro-mini' }));
    expect(['plugin:event|listen', 'plugin:event|unlisten', 'plugin:window|close'].filter(cmd => !pomodoro.has(cmd))).toEqual([]);
  });
});

describe('SEC-E03 [W06] built-in plugin scopes per window and per permission', () => {
  it('SEC-E03 [W06] the quick-assistant window cannot use plugin:fs (its capability lists no fs permission)', async () => {
    const h = harness();
    const file = join(h.documents, 'notes.txt');
    writeFileSync(file, 'private');
    const reply = await h.invoke({ kind: 'window', label: 'quick-assistant', pageUrl: 'tauri://localhost/quick-assistant.html' }, 'plugin:fs|read_text_file', { path: file });
    expect(reply.ok).toBe(false);
  });

  it('SEC-E04 [W06] the main window cannot write to $DESKTOP (default.json grants fs:allow-desktop-read-recursive only)', async () => {
    const h = harness();
    const target = join(h.desktop, 'dropped.command');
    await h.invoke({ kind: 'window', label: 'main', pageUrl: 'tauri://localhost/index.html' }, 'plugin:fs|write_file', Array.from(Buffer.from('#!/bin/sh\n')), { path: encodeURIComponent(target) });
    expect(existsSync(target)).toBe(false);
  });

  it('SEC-E04 [W06] the main window can still read $DESKTOP and write $DOCUMENT as Tauri allows', async () => {
    const h = harness();
    writeFileSync(join(h.desktop, 'read-me.txt'), 'desktop text');
    const main = { kind: 'window' as const, label: 'main', pageUrl: 'tauri://localhost/index.html' };
    expect(await h.invoke(main, 'plugin:fs|read_text_file', { path: join(h.desktop, 'read-me.txt') })).toMatchObject({ ok: true });
    await h.invoke(main, 'plugin:fs|write_file', Array.from(Buffer.from('ok')), { path: encodeURIComponent(join(h.documents, 'out.txt')) });
    expect(readFileSync(join(h.documents, 'out.txt'), 'utf8')).toBe('ok');
  });

  it('SEC-E04 [W06] fs:default deny-default keeps the Electron userData directory (the webview data) out of plugin:fs, even when the runtime scope covers it', async () => {
    const h = harness();
    h.fsRuntime.allowDirectory(h.userData, true);
    const main = { kind: 'window' as const, label: 'main', pageUrl: 'tauri://localhost/index.html' };
    expect(await h.invoke(main, 'plugin:fs|read_text_file', { path: join(h.userData, 'Cookies') })).toMatchObject({ ok: false, value: expect.stringContaining('forbidden path') });
  });

  it('RF-W23-fs-deny-webview-data-user-data: userData is refused to every fs command, at the default location and at the one main passes in', async () => {
    for (const h of [harness(), harness({ userDataDir: home => join(home, 'isolated', 'electron-user-data') })]) {
      // Only the deny can refuse these: the runtime scope (a dialog pick, a dropped folder) covers userData and a sibling picked the same way stays reachable.
      const sibling = join(dirname(h.userData), 'picked');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'a.txt'), 'A');
      h.fsRuntime.allowDirectory(h.userData, true);
      h.fsRuntime.allowDirectory(sibling, true);
      expect(await h.invoke(MAIN, 'plugin:fs|read_text_file', { path: join(sibling, 'a.txt') })).toMatchObject({ ok: true });
      const cookies = join(h.userData, 'Cookies');
      const refused = { ok: false, value: expect.stringContaining('forbidden path') };
      for (const [cmd, args] of [
        ['plugin:fs|read_text_file', { path: cookies }],
        ['plugin:fs|read_file', { path: join(h.userData, 'Local Storage', 'leveldb', '000003.log') }],
        ['plugin:fs|exists', { path: cookies }],
        ['plugin:fs|stat', { path: cookies }],
        ['plugin:fs|read_dir', { path: h.userData }],
        ['plugin:fs|open', { path: cookies, options: { read: true } }],
        ['plugin:fs|mkdir', { path: join(h.userData, 'Extensions'), options: { recursive: true } }],
        ['plugin:fs|remove', { path: cookies }],
        ['plugin:fs|copy_file', { fromPath: cookies, toPath: join(h.documents, 'cookies.db') }],
      ] as const) {
        expect(await h.invoke(MAIN, cmd, args)).toMatchObject(refused);
      }
      expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('x')), { path: encodeURIComponent(cookies) })).toMatchObject(refused);
      expect(readFileSync(cookies, 'utf8')).toBe('SQLite format 3\0session=secret');
      expect(existsSync(join(h.userData, 'Extensions'))).toBe(false);
      expect(existsSync(join(h.documents, 'cookies.db'))).toBe(false);
    }
  });

  it.skipIf(process.platform === 'win32')('RF-W23-fs-deny-webview-data-user-data: where $APPLOCALDATA equals $APPDATA, main reaches the AppData files the frontend keeps there (wallpaper library, PDF asset cache, apkg staging)', async () => {
    const h = harness();
    const wallpaper = join(h.appData, 'workbench-wallpapers', 'wallpaper-1.png');
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.appData, 'workbench-wallpapers'), options: { recursive: true } })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('png')), { path: encodeURIComponent(wallpaper) })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|read_dir', { path: join(h.appData, 'workbench-wallpapers') })).toMatchObject({ ok: true, value: [expect.objectContaining({ name: 'wallpaper-1.png' })] });
    expect(await h.invoke(MAIN, 'plugin:fs|read_text_file', { path: 'workbench-wallpapers/wallpaper-1.png', options: { baseDir: 15 } })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|remove', { path: wallpaper })).toMatchObject({ ok: true });
    expect(existsSync(wallpaper)).toBe(false);

    const font = 'pdfjs-assets/standard_fonts/FoxitSans.pfb';
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: 'pdfjs-assets/standard_fonts', options: { baseDir: 14, recursive: true } })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('font')), { path: encodeURIComponent(font), options: JSON.stringify({ baseDir: 14 }) })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|read_file', { path: font, options: { baseDir: 14 } })).toMatchObject({ ok: true });
    expect(readFileSync(join(h.appData, font), 'utf8')).toBe('font');

    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.appData, 'tmp_apkg_import'), options: { recursive: true } })).toMatchObject({ ok: true });
    for (const caller of [QUICK, POMODORO, h.remotePage]) {
      expect(denied(await h.invoke(caller, 'plugin:fs|read_file', { path: font, options: { baseDir: 14 } }))).toBe(true);
    }
  });

  it('SEC-E03 [W23] quick-assistant and pomodoro-mini hold only the commands their capabilities list', async () => {
    const h = harness();
    expect(h.runtime.acl.grantedCommands({ window: 'quick-assistant', webview: 'quick-assistant' })).toEqual(QUICK_ASSISTANT_COMMANDS);
    expect(h.runtime.acl.grantedCommands({ window: 'pomodoro-mini', webview: 'pomodoro-mini' })).toEqual(POMODORO_MINI_COMMANDS);
    writeFileSync(join(h.documents, 'notes.txt'), 'private');
    for (const caller of [QUICK, POMODORO]) {
      expect(denied(await h.invoke(caller, 'plugin:fs|read_text_file', { path: join(h.documents, 'notes.txt') }))).toBe(true);
      expect(denied(await h.invoke(caller, 'plugin:fs|exists', { path: join(h.documents, 'notes.txt') }))).toBe(true);
      expect(await h.invoke(caller, 'plugin:event|emit', { event: `${caller.label}-ping`, payload: null })).toEqual({ ok: true, value: null });
    }
  });

  it('RF-W23-fs-read-write-scope-split: a read-only grant ($DESKTOP) cannot be turned into a write through open, rename, remove, mkdir or write_text_file (SEC-E04)', async () => {
    const h = harness();
    const existing = join(h.desktop, 'report.txt');
    writeFileSync(existing, 'original');
    for (const options of [{ write: true }, { append: true }, { write: true, create: true, truncate: true }, { createNew: true, write: true }]) {
      expect(await h.invoke(MAIN, 'plugin:fs|open', { path: join(h.desktop, 'x.command'), options })).toMatchObject({ ok: false, value: expect.stringContaining('forbidden path') });
    }
    expect(existsSync(join(h.desktop, 'x.command'))).toBe(false);
    expect(await h.invoke(MAIN, 'plugin:fs|open', { path: existing, options: { read: true } })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: existing, newPath: join(h.documents, 'moved.txt') })).toMatchObject({ ok: false });
    expect(await h.invoke(MAIN, 'plugin:fs|remove', { path: existing })).toMatchObject({ ok: false });
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.desktop, 'new-dir') })).toMatchObject({ ok: false });
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', Array.from(Buffer.from('x')), { path: encodeURIComponent(existing) })).toMatchObject({ ok: false });
    expect(readFileSync(existing, 'utf8')).toBe('original');
    expect(existsSync(join(h.desktop, 'new-dir'))).toBe(false);
  });

  it('RF-W23-fs-read-write-scope-split: copying out of the read-only directory and writing to user-picked paths keep working (SEC-E04)', async () => {
    const h = harness();
    writeFileSync(join(h.desktop, 'photo.png'), 'png');
    expect(await h.invoke(MAIN, 'plugin:fs|copy_file', { fromPath: join(h.desktop, 'photo.png'), toPath: join(h.documents, 'photo.png') })).toMatchObject({ ok: true });
    expect(readFileSync(join(h.documents, 'photo.png'), 'utf8')).toBe('png');
    const picked = join(h.desktop, 'export.md');
    h.fsRuntime.allowFile(picked);
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('saved')), { path: encodeURIComponent(picked) })).toMatchObject({ ok: true });
    expect(readFileSync(picked, 'utf8')).toBe('saved');
  });

  it('RF-W23-fs-deny-host-plugin-dir: main cannot plant or read a Host plugin profile or module under $APPDATA/plugins; the rest of AppData stays writable', async () => {
    const h = harness();
    const plugins = join(h.appData, 'plugins');
    const profile = join(plugins, 'user.profile.json');
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: plugins, options: { recursive: true } })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', Array.from(Buffer.from('{"extends":"official","plugins":["./evil.mjs"]}')), { path: encodeURIComponent(profile) })).toMatchObject(refused);
    expect(existsSync(plugins)).toBe(false);

    mkdirSync(join(plugins, 'community.demo'), { recursive: true });
    writeFileSync(profile, '{"extends":"official"}');
    writeFileSync(join(plugins, 'community.demo', 'index.mjs'), 'export default {}');
    writeFileSync(join(h.documents, 'evil.mjs'), 'import("node:child_process")');
    // A dialog pick or a dropped folder covering the directory does not reopen it.
    h.fsRuntime.allowDirectory(plugins, true);
    for (const [cmd, args] of [
      ['plugin:fs|read_text_file', { path: profile }],
      ['plugin:fs|read_dir', { path: plugins }],
      ['plugin:fs|exists', { path: profile }],
      ['plugin:fs|open', { path: profile, options: { write: true, truncate: true } }],
      ['plugin:fs|mkdir', { path: join(plugins, 'evil'), options: { recursive: true } }],
      ['plugin:fs|remove', { path: plugins, options: { recursive: true } }],
      ['plugin:fs|rename', { oldPath: plugins, newPath: join(h.appData, 'plugins.disabled') }],
      ['plugin:fs|copy_file', { fromPath: join(h.documents, 'evil.mjs'), toPath: join(plugins, 'community.demo', 'index.mjs') }],
    ] as const) {
      expect(await h.invoke(MAIN, cmd, args)).toMatchObject(refused);
    }
    for (const headers of [{ path: encodeURIComponent(profile) }, { path: encodeURIComponent('plugins/user.profile.json'), options: JSON.stringify({ baseDir: 14 }) }] as Record<string, string>[]) {
      expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('{}')), headers)).toMatchObject(refused);
    }
    expect(readFileSync(profile, 'utf8')).toBe('{"extends":"official"}');
    expect(readFileSync(join(plugins, 'community.demo', 'index.mjs'), 'utf8')).toBe('export default {}');
    expect(existsSync(join(plugins, 'evil'))).toBe(false);

    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('ok')), { path: encodeURIComponent(join(h.appData, 'plugins-notes.txt')) })).toMatchObject({ ok: true });
    expect(readFileSync(join(h.appData, 'plugins-notes.txt'), 'utf8')).toBe('ok');
  });

  // APFS and NTFS name one entry by every spelling equal under case (APFS also under full case folding, ſ → s, ß / ẞ → ss,
  // Kelvin sign → k, and Unicode normalization); canonicalize returns the spelling the directory was created with.
  const caseInsensitive = platform !== 'linux' && caseInsensitiveTmp();
  const pluginsBody = Array.from(Buffer.from('{"extends":"official","plugins":["data:text/javascript,"]}'));

  it.runIf(caseInsensitive)('S01-r3 M2: the $APPDATA/plugins deny holds for a differently-cased spelling on a case-insensitive file system', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const profile = join(h.appData, 'plugins', 'user.profile.json');
    mkdirSync(join(h.appData, 'plugins'), { recursive: true });
    const aliased = join(h.appData, 'Plugins', 'user.profile.json');
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', Array.from(Buffer.from('{"extends":"official","plugins":["data:text/javascript,"]}')), { path: encodeURIComponent(aliased) })).toMatchObject(refused);
    expect(existsSync(profile)).toBe(false);
  });

  it.runIf(caseInsensitive)('RF-W23-fs-deny-case-insensitive: while $APPDATA/plugins does not exist, no other spelling of it can be created (it would be the directory the Host loads from)', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    for (const name of ['Plugins', 'PLUGINS', 'plugin\u017f', 'Plugin\u017F']) {
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.appData, name), options: { recursive: true } }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.appData, name, 'community.evil'), options: { recursive: true } }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: `${name}/x`, options: { recursive: true, baseDir: 14 } }), name).toMatchObject(refused);
    }
    expect(readdirSync(h.appData)).toEqual([]);
    // A prepared directory renamed into place in one step.
    const staging = join(h.appData, 'staging');
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: staging })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', pluginsBody, { path: encodeURIComponent(join(staging, 'user.profile.json')) })).toMatchObject({ ok: true });
    for (const name of ['Plugins', 'PLUGINS', 'plugin\u017f']) {
      expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: staging, newPath: join(h.appData, name) }), name).toMatchObject(refused);
    }
    expect(readdirSync(h.appData)).toEqual(['staging']);
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('ok')), { path: encodeURIComponent(join(h.appData, 'Plugins-notes.txt')) })).toMatchObject({ ok: true });
  });

  it.runIf(caseInsensitive)('RF-W23-fs-deny-case-insensitive: when the plugins directory exists under another case, no spelling can plant the profile in it', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    // The page has used these commands before the directory appears (fs builds each command's scope on first use and
    // canonicalizes the deny patterns then; a directory created later is not in that snapshot).
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', Array.from(Buffer.from('a')), { path: encodeURIComponent(join(h.appData, 'a.txt')) })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('b')), { path: encodeURIComponent('b.txt'), options: JSON.stringify({ baseDir: 14 }) })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|read_dir', { path: h.appData })).toMatchObject({ ok: true });
    mkdirSync(join(h.appData, 'Plugins'));
    for (const name of ['Plugins', 'plugins', 'PLUGINS', 'plugin\u017f']) {
      expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', pluginsBody, { path: encodeURIComponent(join(h.appData, name, 'user.profile.json')) }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|write_file', pluginsBody, { path: encodeURIComponent(`${name}/user.profile.json`), options: JSON.stringify({ baseDir: 14 }) }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|read_dir', { path: join(h.appData, name) }), name).toMatchObject(refused);
    }
    expect(readdirSync(join(h.appData, 'Plugins'))).toEqual([]);
  });

  it.runIf(caseInsensitive)('RF-W23-fs-deny-case-insensitive: a slot\'s browser-profiles cannot be pre-created or read under another spelling', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const slot = join(h.appData, 'slots', 'slotA');
    mkdirSync(slot, { recursive: true });
    for (const name of ['Browser-Profiles', 'BROWSER-PROFILES', 'browser-profile\u017f']) {
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(slot, name, 'default'), options: { recursive: true } }), name).toMatchObject(refused);
    }
    expect(readdirSync(slot)).toEqual([]);
    mkdirSync(join(slot, 'Browser-Profiles', 'default'), { recursive: true });
    writeFileSync(join(slot, 'Browser-Profiles', 'default', 'Cookies'), 'SQLite format 3\0bank-session');
    expect(await h.invoke(MAIN, 'plugin:fs|read_file', { path: join(slot, 'browser-profiles', 'default', 'Cookies') })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|read_file', { path: join(slot, 'Browser-Profiles', 'default', 'Cookies') })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(slot, 'Browser-Profiles-backup'), options: { recursive: true } })).toMatchObject({ ok: true });
  });

  // Node passes `\\.\` paths to Windows unprefixed, so Win32 normalization drops trailing dots and spaces (drive-letter
  // paths get `\\?\` and keep them); NTFS opens `<dir>::$INDEX_ALLOCATION` as the directory itself.
  it.runIf(platform === 'win32')('RF-W23-fs-deny-ntfs-stream-suffix: while $APPDATA/plugins and a slot\'s browser-profiles do not exist, a \\\\.\\ path with a trailing dot or space cannot create them', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const staging = join(h.appData, 'staging');
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: staging })).toMatchObject({ ok: true });
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', pluginsBody, { path: encodeURIComponent(join(staging, 'user.profile.json')) })).toMatchObject({ ok: true });
    for (const name of ['plugins.', 'plugins ', 'Plugins. .']) {
      const device = `\\\\.\\${join(h.appData, name)}`;
      expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: staging, newPath: device }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: device }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: `\\\\.\\${join(h.appData, name, 'community.evil')}`, options: { recursive: true } }), name).toMatchObject(refused);
    }
    expect(readdirSync(h.appData)).toEqual(['staging']);
    const slot = join(h.appData, 'slots', 'slotA');
    mkdirSync(slot, { recursive: true });
    for (const name of ['browser-profiles.', 'browser-profiles ']) {
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: `\\\\.\\${join(slot, name, 'default')}`, options: { recursive: true } }), name).toMatchObject(refused);
    }
    expect(readdirSync(slot)).toEqual([]);
    expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('ok')), { path: encodeURIComponent(join(h.appData, 'plugins-notes.txt')) })).toMatchObject({ ok: true });
  });

  it.runIf(platform === 'win32')('RF-W23-fs-deny-ntfs-stream-suffix: an NTFS stream spelling cannot create, fill or rename into $APPDATA/plugins', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const staging = join(h.appData, 'staging');
    expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: staging })).toMatchObject({ ok: true });
    for (const name of ['plugins::$INDEX_ALLOCATION', 'Plugins:$I30:$INDEX_ALLOCATION']) {
      expect(await h.invoke(MAIN, 'plugin:fs|mkdir', { path: join(h.appData, name) }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', pluginsBody, { path: encodeURIComponent(join(h.appData, name, 'user.profile.json')) }), name).toMatchObject(refused);
      expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: staging, newPath: join(h.appData, name) }), name).toMatchObject(refused);
    }
    expect(readdirSync(h.appData)).toEqual(['staging']);
  });

  it('RF-W23-fs-deny-browser-profiles: main cannot read, copy out or delete the in-app browser session (cookies) in any slot; the rest of the slot stays reachable', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    for (const slot of ['slotA', 'slotB']) {
      const profiles = join(h.appData, 'slots', slot, 'browser-profiles');
      const cookies = join(profiles, 'default', 'Cookies');
      mkdirSync(join(profiles, 'default'), { recursive: true });
      writeFileSync(cookies, 'SQLite format 3\0bank-session');
      writeFileSync(join(h.appData, 'slots', slot, 'chat_v2.db'), 'db');
      for (const [cmd, args] of [
        ['plugin:fs|read_file', { path: cookies }],
        ['plugin:fs|read_file', { path: `slots/${slot}/browser-profiles/default/Cookies`, options: { baseDir: 14 } }],
        ['plugin:fs|exists', { path: cookies }],
        ['plugin:fs|read_dir', { path: profiles }],
        ['plugin:fs|read_dir', { path: join(profiles, 'default') }],
        ['plugin:fs|copy_file', { fromPath: cookies, toPath: join(h.documents, 'cookies.db') }],
        ['plugin:fs|rename', { oldPath: profiles, newPath: join(h.appData, 'slots', slot, 'moved') }],
        ['plugin:fs|remove', { path: profiles, options: { recursive: true } }],
      ] as const) {
        expect(await h.invoke(MAIN, cmd, args)).toMatchObject(refused);
      }
      expect(await h.invoke(MAIN, 'plugin:fs|write_file', Array.from(Buffer.from('x')), { path: encodeURIComponent(cookies) })).toMatchObject(refused);
      expect(readFileSync(cookies, 'utf8')).toBe('SQLite format 3\0bank-session');
      expect(existsSync(join(h.documents, 'cookies.db'))).toBe(false);
      expect(await h.invoke(MAIN, 'plugin:fs|exists', { path: join(h.appData, 'slots', slot, 'chat_v2.db') })).toEqual({ ok: true, value: true });
    }
  });

  it('RF-W23-asset-scope-protected-deny: electron/main.ts builds the asset scope with fsScopeFromPatterns on one line (the line the next case mirrors)', () => {
    expect(MAIN_ASSET_SCOPE_LINE).toMatch(/fsScopeFromPatterns\(paths, platform, config\.assetScope\.allow, .*config\.assetScope\.deny\)?, userDataDir\)/);
  });

  /**
   * The asset scope is built the way `electron/main.ts` builds it: `fsScopeFromPatterns` over tauri.conf.json's
   * `assetProtocol.scope`, with `withProtectedDeny` only once main.ts applies it to `config.assetScope.deny`.
   * `it.fails` while `electron/main.ts:199` is not wired (W06, `.reports/W23-handoffs/W06-asset-scope-deny.md`): main.ts
   * still serves the cookies. Once the wiring lands it runs as `it`, so landing it does not turn this red.
   */
  (MAIN_ASSET_SCOPE_WIRED ? it : it.fails)('RF-W23-asset-scope-protected-deny: main cannot read the in-app browser cookies through asset: (403), the wallpaper library stays readable', async () => {
    const h = harness();
    const cookies = join(h.appData, 'slots', 'slotA', 'browser-profiles', 'Default', 'Cookies');
    const wallpaper = join(h.appData, 'workbench-wallpapers', 'a.png');
    for (const file of [cookies, wallpaper]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'SQLite format 3\0bank-session');
    }
    const config = loadTauriConfig(dirname(CAPABILITIES), platform).assetScope;
    const scope = fsScopeFromPatterns(h.paths, platform, config.allow, MAIN_ASSET_SCOPE_WIRED ? withProtectedDeny(config.deny) : config.deny, h.userData);
    const get = async (path: string) => {
      const response = await assetResponse({ url: `asset://localhost/${encodeURIComponent(path)}`, method: 'GET', headers: {} }, scope, new URL(MAIN.pageUrl).origin, platform);
      if (response.body instanceof ReadableStream) await response.body.cancel();
      return response.status;
    };
    expect(await get(wallpaper)).toBe(200);
    expect(await get(cookies)).toBe(403);
  });

  it('RF-W23-fs-deny-protected-ancestor: main cannot carry a protected directory off by renaming or recursively removing a directory above it', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const slot = join(h.appData, 'slots', 'slotA');
    const cookies = join(slot, 'browser-profiles', 'default', 'Cookies');
    const profile = join(h.appData, 'plugins', 'user.profile.json');
    mkdirSync(dirname(cookies), { recursive: true });
    writeFileSync(cookies, 'SQLite format 3\0bank-session');
    writeFileSync(join(slot, 'chat_v2.db'), 'db');
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(profile, '{"extends":"official"}');
    for (const [cmd, args] of [
      ['plugin:fs|rename', { oldPath: join(h.appData, 'slots'), newPath: join(h.appData, 'slotz') }],
      ['plugin:fs|rename', { oldPath: slot, newPath: join(h.appData, 'slots', 'moved') }],
      ['plugin:fs|rename', { oldPath: slot, newPath: join(h.documents, 'slotA') }],
      ['plugin:fs|rename', { oldPath: 'slots/slotA', newPath: 'exported', options: { oldPathBaseDir: 14, newPathBaseDir: 6 } }],
      ['plugin:fs|rename', { oldPath: h.appData, newPath: join(h.documents, 'old-appdata') }],
      ['plugin:fs|remove', { path: slot, options: { recursive: true } }],
      ['plugin:fs|remove', { path: join(h.appData, 'slots'), options: { recursive: true } }],
      ['plugin:fs|remove', { path: h.appData, options: { recursive: true } }],
    ] as const) {
      expect(await h.invoke(MAIN, cmd, args), `${cmd} ${JSON.stringify(args)}`).toMatchObject(refused);
    }
    expect(readFileSync(cookies, 'utf8')).toBe('SQLite format 3\0bank-session');
    expect(readFileSync(profile, 'utf8')).toBe('{"extends":"official"}');
    expect(readdirSync(h.appData).sort()).toEqual(['plugins', 'slots']);
    expect(readdirSync(h.documents)).toEqual([]);
  });

  it('RF-W23-fs-deny-protected-ancestor: main cannot plant a prepared browser-profiles or plugins directory by renaming a whole directory onto a new slot or onto $APPDATA', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const stagedSlot = join(h.appData, 'staging');
    mkdirSync(join(stagedSlot, 'browser-profiles', 'default'), { recursive: true });
    writeFileSync(join(stagedSlot, 'browser-profiles', 'default', 'Cookies'), 'SQLite format 3\0attacker-session');
    mkdirSync(join(h.appData, 'slots'), { recursive: true });
    expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: stagedSlot, newPath: join(h.appData, 'slots', 'slotB') })).toMatchObject(refused);
    expect(readdirSync(join(h.appData, 'slots'))).toEqual([]);

    const stagedAppData = join(h.documents, 'stage');
    mkdirSync(join(stagedAppData, 'plugins'), { recursive: true });
    writeFileSync(join(stagedAppData, 'plugins', 'user.profile.json'), '{"extends":"official","plugins":["./evil.mjs"]}');
    // The first half of the swap ($APPDATA moved away) is refused above; here $APPDATA is gone for another reason.
    rmSync(h.appData, { recursive: true, force: true });
    expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: stagedAppData, newPath: h.appData })).toMatchObject(refused);
    expect(existsSync(join(h.appData, 'plugins'))).toBe(false);
  });

  it('RF-W23-fs-deny-protected-ancestor: a folder the user picked that holds the webview data cannot be renamed to read it under another path', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    h.fsRuntime.allowDirectory(h.home, true);
    const holder = dirname(h.userData);
    expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: holder, newPath: join(h.home, 'moved') })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|remove', { path: holder, options: { recursive: true } })).toMatchObject(refused);
    expect(readFileSync(join(h.userData, 'Cookies'), 'utf8')).toBe('SQLite format 3\0session=secret');
    expect(existsSync(join(h.home, 'moved'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('RF-W23-fs-deny-symlink-entry: a link the user put in $APPDATA/plugins cannot be replaced, removed or written through, even when it points into AppData', async () => {
    const h = harness();
    const refused = { ok: false, value: expect.stringContaining('forbidden path') };
    const source = join(h.appData, 'profile-source.json');
    const profile = join(h.appData, 'plugins', 'user.profile.json');
    mkdirSync(dirname(profile), { recursive: true });
    writeFileSync(source, '{"extends":"official"}');
    symlinkSync(source, profile);
    writeFileSync(join(h.appData, 'evil.json'), '{"extends":"official","plugins":["./evil.mjs"]}');
    expect(await h.invoke(MAIN, 'plugin:fs|rename', { oldPath: join(h.appData, 'evil.json'), newPath: profile })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|remove', { path: profile })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|read_text_file', { path: profile })).toMatchObject(refused);
    expect(await h.invoke(MAIN, 'plugin:fs|write_text_file', Array.from(Buffer.from('{}')), { path: encodeURIComponent(profile) })).toMatchObject(refused);
    expect(lstatSync(profile).isSymbolicLink()).toBe(true);
    expect(readFileSync(source, 'utf8')).toBe('{"extends":"official"}');
  });

  it('RF-W23-fs-deny-protected-ancestor: renames and removals that carry no protected directory keep working (apkg staging, wallpaper library, files and folders inside a slot)', async () => {
    const h = harness();
    const ok = { ok: true };
    const slot = join(h.appData, 'slots', 'slotA');
    mkdirSync(join(slot, 'browser-profiles', 'default'), { recursive: true });
    mkdirSync(join(slot, 'browser-profiles-backup'), { recursive: true });
    mkdirSync(join(slot, 'notes', 'images'), { recursive: true });
    writeFileSync(join(slot, 'chat_v2.db'), 'db');
    for (const dir of ['tmp_apkg_import', 'workbench-wallpapers']) mkdirSync(join(h.appData, dir), { recursive: true });
    writeFileSync(join(h.appData, 'tmp_apkg_import', 'deck.apkg'), 'PK');
    writeFileSync(join(h.appData, 'workbench-wallpapers', 'a.png'), 'png');
    mkdirSync(join(h.documents, 'project', 'sub'), { recursive: true });
    for (const [cmd, args] of [
      ['plugin:fs|remove', { path: join(h.appData, 'tmp_apkg_import', 'deck.apkg') }],
      ['plugin:fs|remove', { path: join(h.appData, 'tmp_apkg_import'), options: { recursive: true } }],
      ['plugin:fs|remove', { path: join(h.appData, 'workbench-wallpapers', 'a.png') }],
      ['plugin:fs|rename', { oldPath: join(slot, 'chat_v2.db'), newPath: join(slot, 'chat_v2.db.bak') }],
      ['plugin:fs|rename', { oldPath: join(slot, 'notes'), newPath: join(slot, 'notes-old') }],
      ['plugin:fs|remove', { path: join(slot, 'notes-old'), options: { recursive: true } }],
      ['plugin:fs|remove', { path: join(slot, 'browser-profiles-backup'), options: { recursive: true } }],
      ['plugin:fs|rename', { oldPath: join(h.documents, 'project'), newPath: join(h.documents, 'project-2') }],
      ['plugin:fs|remove', { path: join(h.documents, 'project-2'), options: { recursive: true } }],
    ] as const) {
      expect(await h.invoke(MAIN, cmd, args), `${cmd} ${JSON.stringify(args)}`).toMatchObject(ok);
    }
    expect(readdirSync(h.appData).sort()).toEqual(['slots', 'workbench-wallpapers']);
    expect(readdirSync(slot).sort()).toEqual(['browser-profiles', 'chat_v2.db.bak']);
    expect(readdirSync(h.documents)).toEqual([]);
  });

  it('SEC-E04 [W06] fs scope refuses parent traversal and dotfiles outside the granted directories', async () => {
    const h = harness();
    const main = { kind: 'window' as const, label: 'main', pageUrl: 'tauri://localhost/index.html' };
    mkdirSync(join(h.home, '.ssh'), { recursive: true });
    writeFileSync(join(h.home, '.ssh', 'id_ed25519'), 'key');
    expect(await h.invoke(main, 'plugin:fs|read_text_file', { path: join(h.documents, '..', '.ssh', 'id_ed25519') })).toMatchObject({ ok: false });
    expect(await h.invoke(main, 'plugin:fs|read_text_file', { path: join(h.home, '.ssh', 'id_ed25519') })).toMatchObject({ ok: false });
  });
});

describe('SEC-E07 [W06] renderer message validation', () => {
  it('SEC-E07 [W06] a non-string cmd from a page is answered with an error instead of throwing in the main process', async () => {
    const h = harness();
    const message = { type: 'invoke' as const, cmd: { toString: 'x' } as unknown as string, callback: 1, error: 2, payload: { contentType: 'application/json' as const, data: '{}' }, headers: {} };
    expect(() => h.runtime.handleBrowserInvoke(h.browserContents, h.browser, message, 'https://attacker.example/')).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.sent.some(entry => entry.message.type === 'result' && entry.message.callbackId === 2)).toBe(true);
  });

  it('SEC-E07 [W23] malformed renderer values never throw; answerable ones get an error reply, the rest are dropped and logged', async () => {
    const h = harness();
    const base = { type: 'invoke', cmd: 'plugin:event|emit', callback: 5, error: 6, payload: { contentType: 'application/json', data: '{"event":"x"}' }, headers: {} };
    for (const value of [null, 'invoke', [], { ...base, callback: 'abc' }, { ...base, error: -1 }, { ...base, callback: 2 ** 32 }]) {
      for (const caller of [MAIN, h.remotePage]) {
        let replies: MainToRenderer[] = [];
        await expect((async () => { replies = await h.post(caller, value); })()).resolves.toBeUndefined();
        expect(replies).toEqual([]);
      }
    }
    expect(h.logs.filter(line => line.includes('rejected a malformed message')).length).toBe(12);
    const answered: Array<[unknown, RegExp]> = [
      [{ ...base, type: 'drag-drop' }, /type must be "invoke"/],
      [{ ...base, cmd: 42 }, /cmd must be a non-empty string/],
      [{ ...base, cmd: '' }, /cmd must be a non-empty string/],
      [{ ...base, cmd: 'x'.repeat(2000) }, /cmd is longer than 1024/],
      [{ ...base, payload: null }, /payload must be an object/],
      [{ ...base, payload: { contentType: 'application/json', data: { event: 'x' } } }, /payload data must be a string/],
      [{ ...base, payload: { contentType: 'application/octet-stream', data: [1, 2] } }, /payload data must be a Uint8Array/],
      [{ ...base, payload: { contentType: 'text/plain', data: 'x' } }, /payload contentType/],
      [{ ...base, payload: { contentType: 'application/json', data: '{"event":' } }, /payload is not valid JSON/],
      [{ ...base, headers: { path: 7 } }, /header "path" must be a string/],
      [{ ...base, headers: null }, /headers must be an object/],
    ];
    for (const [value, reason] of answered) {
      const replies = await h.post(MAIN, value);
      expect(replies).toEqual([expect.objectContaining({ type: 'result', callbackId: 6, otherId: 5 })]);
      expect(errorText(replies[0])).toMatch(reason);
    }
  });

  it('SEC-E07 [W23] the payload cap is tight for remote pages and leaves room for large local payloads', async () => {
    const h = harness();
    const big = JSON.stringify({ base64Content: 'A'.repeat(2 * 1024 * 1024) });
    const message = (data: string, callback: number) => ({ type: 'invoke', cmd: 'vfs_upload_attachment', callback, error: callback + 1, payload: { contentType: 'application/json', data }, headers: {} });
    const remote = await h.post(h.remotePage, message(big, 40));
    expect(errorText(remote[0])).toMatch(/payload size \d+ exceeds the limit of 1048576/);
    expect(h.toHost).toEqual([]);
    await h.post(MAIN, message(big, 50));
    expect(h.toHost).toContainEqual(expect.objectContaining({ cmd: 'vfs_upload_attachment', argsJson: big }));
    const binary = await h.post(h.remotePage, { ...message('', 60), payload: { contentType: 'application/octet-stream', data: new Uint8Array(1024 * 1024 + 1) } });
    expect(errorText(binary[0])).toMatch(/exceeds the limit of 1048576/);
  });
});

describe('RF-W23-menu-tray-js-api-unprovided: the menu and tray JS APIs granted by core:default', () => {
  it('RF-W23-menu-tray-js-api-unprovided: app windows get an explicit unsupported error from the shell, never a Host round trip; other callers still get the ACL denial', async () => {
    const h = harness();
    for (const caller of [MAIN, QUICK, POMODORO]) {
      expect(await h.invoke(caller, 'plugin:menu|new', { kind: 'Menu', options: {} })).toEqual({
        ok: false, value: '[electron-shell] menu.new is not supported: the native menu is built by the Electron main process',
      });
      expect(await h.invoke(caller, 'plugin:tray|new', { options: {} })).toEqual({ ok: false, value: '[electron-shell] tray.new is not supported: the app has no tray icon' });
    }
    expect(await h.invoke(h.remotePage, 'plugin:menu|popup', {})).toEqual({ ok: false, value: 'Command plugin:menu|popup not allowed by ACL' });
    expect(await h.invoke({ kind: 'window', label: 'main', pageUrl: 'https://attacker.example/' }, 'plugin:tray|new', {})).toEqual({ ok: false, value: 'Command plugin:tray|new not allowed by ACL' });
    expect(await h.invoke(MAIN, 'plugin:menu|nope', {})).toEqual({ ok: false, value: 'Command plugin:menu|nope not allowed by ACL' });
    expect(h.toHost).toEqual([]);
  });

  it('RF-W23-menu-tray-js-api-unprovided: no frontend code calls the Tauri menu or tray JS API', () => {
    const root = join(import.meta.dirname, '../../../src');
    const callers = (readdirSync(root, { recursive: true }) as string[])
      .filter(file => /\.(?:[cm]?[jt]sx?|vue)$/.test(file))
      .filter(file => /@tauri-apps\/api\/(?:menu|tray)|plugin:(?:menu|tray)\|/.test(readFileSync(join(root, file), 'utf8')));
    expect(callers).toEqual([]);
  });
});

/** `src-tauri/capabilities/quick-assistant.json` resolved against the Tauri 2.11.5 core permission sets. */
const QUICK_ASSISTANT_COMMANDS = [
  'plugin:app|bundle_type', 'plugin:app|identifier', 'plugin:app|name', 'plugin:app|register_listener', 'plugin:app|remove_listener',
  'plugin:app|supports_multiple_windows', 'plugin:app|tauri_version', 'plugin:app|version',
  'plugin:clipboard-manager|read_text', 'plugin:clipboard-manager|write_text',
  'plugin:event|emit', 'plugin:event|emit_to', 'plugin:event|listen', 'plugin:event|unlisten',
  'plugin:image|from_bytes', 'plugin:image|from_path', 'plugin:image|new', 'plugin:image|rgba', 'plugin:image|size',
  'plugin:menu|append', 'plugin:menu|create_default', 'plugin:menu|get', 'plugin:menu|insert', 'plugin:menu|is_checked',
  'plugin:menu|is_enabled', 'plugin:menu|items', 'plugin:menu|new', 'plugin:menu|popup', 'plugin:menu|prepend', 'plugin:menu|remove',
  'plugin:menu|remove_at', 'plugin:menu|set_accelerator', 'plugin:menu|set_as_app_menu', 'plugin:menu|set_as_help_menu_for_nsapp',
  'plugin:menu|set_as_window_menu', 'plugin:menu|set_as_windows_menu_for_nsapp', 'plugin:menu|set_checked', 'plugin:menu|set_enabled',
  'plugin:menu|set_icon', 'plugin:menu|set_text', 'plugin:menu|text',
  'plugin:path|basename', 'plugin:path|dirname', 'plugin:path|extname', 'plugin:path|is_absolute', 'plugin:path|join',
  'plugin:path|normalize', 'plugin:path|resolve', 'plugin:path|resolve_directory',
  'plugin:resources|close',
  'plugin:tray|get_by_id', 'plugin:tray|new', 'plugin:tray|remove_by_id', 'plugin:tray|set_icon', 'plugin:tray|set_icon_as_template',
  'plugin:tray|set_icon_with_as_template', 'plugin:tray|set_menu', 'plugin:tray|set_show_menu_on_left_click', 'plugin:tray|set_temp_dir_path',
  'plugin:tray|set_title', 'plugin:tray|set_tooltip', 'plugin:tray|set_visible',
  'plugin:webview|get_all_webviews', 'plugin:webview|internal_toggle_devtools', 'plugin:webview|webview_position', 'plugin:webview|webview_size',
  'plugin:window|activity_name', 'plugin:window|available_monitors', 'plugin:window|close', 'plugin:window|current_monitor',
  'plugin:window|cursor_position', 'plugin:window|get_all_windows', 'plugin:window|hide', 'plugin:window|inner_position',
  'plugin:window|inner_size', 'plugin:window|internal_toggle_maximize', 'plugin:window|is_always_on_top', 'plugin:window|is_closable',
  'plugin:window|is_decorated', 'plugin:window|is_enabled', 'plugin:window|is_focused', 'plugin:window|is_fullscreen',
  'plugin:window|is_maximizable', 'plugin:window|is_maximized', 'plugin:window|is_minimizable', 'plugin:window|is_minimized',
  'plugin:window|is_resizable', 'plugin:window|is_visible', 'plugin:window|monitor_from_point', 'plugin:window|outer_position',
  'plugin:window|outer_size', 'plugin:window|primary_monitor', 'plugin:window|scale_factor', 'plugin:window|scene_identifier',
  'plugin:window|set_always_on_top', 'plugin:window|start_dragging', 'plugin:window|theme', 'plugin:window|title',
];

/** `src-tauri/capabilities/pomodoro-mini.json`: `core:default` plus close / start_dragging / set_always_on_top. */
const POMODORO_MINI_COMMANDS = QUICK_ASSISTANT_COMMANDS.filter(cmd => !['plugin:clipboard-manager|read_text', 'plugin:clipboard-manager|write_text', 'plugin:window|hide'].includes(cmd));
