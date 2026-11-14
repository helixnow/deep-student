/**
 * `BuiltinAcl`（electron/shell/capabilities.ts）：Tauri 2.11.5 `authority.rs` 的判定与报错、内置插件命令的归属、
 * 随包 capability 的解析，以及 renderer 消息校验与 browser-content 原生事件标记。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_SHORTCUT_TRIGGERED, type Capability } from '../../host/kernel/api.ts';
import { checkRendererMessage, MAX_DRAG_DROP_PATHS, MAX_LOCAL_INVOKE_PAYLOAD, MAX_SCRIPT_ERROR_LENGTH } from '../shell/bridge-messages.ts';
import { nativeBrowserContentEvent } from '../shell/browser-content-events.ts';
import { BuiltinAcl } from '../shell/capabilities.ts';
import { imagePlugin } from '../shell/images.ts';
import { dialogPlugin } from '../shell/plugins/dialog.ts';
import { eventPlugin } from '../shell/plugins/event.ts';
import { fsPlugin } from '../shell/plugins/fs.ts';
import { httpPlugin } from '../shell/plugins/http.ts';
import { appPlugin, pathPlugin, resourcesPlugin } from '../shell/plugins/path-app.ts';
import {
  clipboardPlugin, forwardShortcutToHost, globalShortcutPlugin, notificationPlugin, openerPlugin, processPlugin, updaterPlugin, type ProcessHooks,
} from '../shell/plugins/system.ts';
import type { PluginAclManifest } from '../shell/plugins/tauri-acl-manifest.ts';
import { webviewPlugin, windowPlugin } from '../shell/plugins/window.ts';
import type { HostSupervisor } from '../shell/host.ts';
import { PathResolver } from '../shell/paths.ts';
import { ShellRuntime } from '../shell/runtime.ts';
import { FsScope } from '../shell/scope.ts';

const CAPABILITIES = join(import.meta.dirname, '..', '..', 'resources/app', 'capabilities');

const capability = (identifier: string, permissions: Capability['permissions'], extra: Partial<Capability> = {}): Capability => ({
  identifier, description: '', local: true, remote: null, windows: [], webviews: [], permissions, platforms: null, ...extra,
});

const MANIFESTS: Record<string, PluginAclManifest> = {
  'core:window': { commands: ['close', 'show'], default: ['allow-close'], sets: {}, permissions: {} },
  demo: {
    commands: [],
    default: [],
    sets: { 'read-only': ['allow-peek'] },
    permissions: { 'allow-peek': { allow: ['peek'] }, 'allow-run': { allow: ['run'] }, 'deny-peek': { deny: ['peek'] }, 'allow-all': { allow: ['run', 'peek'] } },
  },
};

const MAIN = { window: 'main', webview: 'main' };

describe('BuiltinAcl authorization and denial text (tauri 2.11.5 authority.rs)', () => {
  it('allows only matching window/webview globs on a matching origin, and any deny entry wins', () => {
    const acl = new BuiltinAcl([
      capability('main', ['core:window:default', 'demo:allow-run'], { webviews: ['main'] }),
      capability('tools', ['demo:allow-run'], { windows: ['tool-*'] }),
      capability('remote', ['demo:read-only'], { local: false, remote: { urls: ['https://docs.example/*'] }, webviews: ['viewer'] }),
      capability('deny', ['demo:deny-peek'], { windows: ['nobody'] }),
    ], 'linux', MANIFESTS);
    expect(acl.authorize('plugin:window|close', MAIN)).not.toBeNull();
    expect(acl.authorize('plugin:window|show', MAIN)).toBeNull();
    expect(acl.authorize('plugin:demo|run', { window: 'tool-1', webview: 'tool-1' })).not.toBeNull();
    expect(acl.authorize('plugin:demo|run', { window: 'other', webview: 'main' })).not.toBeNull();
    expect(acl.authorize('plugin:demo|run', { ...MAIN, origin: 'https://evil.example' })).toBeNull();
    expect(acl.authorize('plugin:demo|run', { window: 'other', webview: 'other' })).toBeNull();
    expect(acl.authorize('plugin:demo|peek', { window: 'main', webview: 'viewer', origin: 'https://docs.example' })).toBeNull();
    expect(acl.authorize('plugin:unknown|x', MAIN)).toBeNull();
    expect(acl.grantedCommands(MAIN)).toEqual(['plugin:demo|run', 'plugin:window|close']);
  });

  it('formats debug denials like resolve_access_message and release denials like webview/mod.rs', () => {
    const acl = new BuiltinAcl([
      capability('main-cap', ['core:window:allow-close', 'demo:allow-run'], { windows: ['main'] }),
      capability('deny-cap', ['demo:deny-peek'], { windows: ['*'] }),
      capability('remote-cap', ['demo:allow-run'], { local: false, remote: { urls: ['https://docs.example/*'] }, webviews: ['viewer'] }),
    ], 'linux', MANIFESTS);
    const other = { window: 'other', webview: 'other' };
    expect(acl.denial('plugin:window|close', other, true)).toBe(
      'window.close not allowed on window "other", webview "other", URL: local\n\nallowed on: [windows: "main", URL: local]\n\nreferenced by: capability: main-cap, permission: allow-close',
    );
    expect(acl.denial('plugin:demo|run', { ...other, origin: 'https://evil.example' }, true)).toBe(
      'demo.run not allowed on window "other", webview "other", URL: https://evil.example\n\n'
        + 'allowed on: [windows: "main", URL: local], [webviews: "viewer", URL: https://docs.example/*]\n\n'
        + 'referenced by: capability: main-cap, permission: allow-run || capability: remote-cap, permission: allow-run',
    );
    expect(acl.denial('plugin:demo|peek', MAIN, true)).toBe('demo.peek explicitly denied on origin local\n\nreferenced by: capability: deny-cap, permission: deny-peek');
    expect(acl.denial('plugin:window|show', MAIN, true)).toBe('window.show not allowed. Permissions associated with this command: core:window:allow-show');
    expect(new BuiltinAcl([], 'linux', MANIFESTS).denial('plugin:demo|peek', MAIN, true)).toBe(
      'demo.peek not allowed. Permissions associated with this command: demo:allow-all, demo:allow-peek, demo:read-only',
    );
    expect(acl.denial('plugin:window|nope', MAIN, true)).toBe('window.nope not allowed. Command not found');
    expect(acl.denial('plugin:nope|x', MAIN, true)).toBe('nope.x not allowed. Plugin not found');
    expect(acl.denial('plugin:window|show', MAIN, false)).toBe('Command plugin:window|show not allowed by ACL');
  });

  it('fails loudly on permissions the manifests do not know', () => {
    expect(() => new BuiltinAcl([capability('x', ['demo:allow-nothing'], { windows: ['main'] })], 'linux', MANIFESTS)).toThrow('unknown permission `allow-nothing` for plugin `demo`');
    expect(() => new BuiltinAcl([capability('x', ['ghost:default'], { windows: ['main'] })], 'linux', MANIFESTS)).toThrow('unknown plugin manifest `ghost`');
  });

  it('RF-W23-fs-read-write-scope-split: scope-only set members bind to the set commands; standalone scope permissions stay global', () => {
    const acl = new BuiltinAcl([
      capability('main', [
        'fs:allow-desktop-read-recursive',
        'fs:allow-document-write-recursive',
        { identifier: 'fs:scope', allow: [{ path: '$HOME/shared/**' }], deny: [{ path: '$HOME/shared/secret' }] },
      ], { webviews: ['main'] }),
    ], 'linux');
    const paths = (cmd: string) => {
      const scope = acl.scopeFor(cmd, MAIN);
      return { allow: scope.allow.map((entry) => (entry as { path: string }).path), deny: scope.deny.map((entry) => (entry as { path: string }).path) };
    };
    expect(paths('plugin:fs|read_file').allow).toEqual(expect.arrayContaining(['$DESKTOP/**', '$HOME/shared/**']));
    expect(paths('plugin:fs|write_file').allow).toEqual(expect.arrayContaining(['$DOCUMENT/**', '$HOME/shared/**']));
    expect(paths('plugin:fs|write_file').allow).not.toContain('$DESKTOP/**');
    expect(paths('plugin:fs|write_file').deny).toContain('$HOME/shared/secret');
    expect(acl.everyScopeOf('fs').allow).toEqual(expect.arrayContaining([{ path: '$DESKTOP/**' }, { path: '$DOCUMENT/**' }]));
  });

  it('RF-W23-fs-deny-host-plugin-dir: the Host plugin directory is denied to every fs command on every platform, whatever the capabilities grant', () => {
    const pluginDir = [{ path: '$APPDATA/plugins' }, { path: '$APPDATA/plugins/**' }];
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const shipped = BuiltinAcl.fromDirectory(CAPABILITIES, platform);
      for (const cmd of ['plugin:fs|write_file', 'plugin:fs|read_file', 'plugin:fs|mkdir', 'plugin:fs|remove', 'plugin:fs|rename', 'plugin:fs|copy_file']) {
        expect(shipped.authorize(cmd, MAIN)?.deny).toEqual(expect.arrayContaining(pluginDir));
      }
      expect(shipped.everyScopeOf('fs').deny).toEqual(expect.arrayContaining(pluginDir));
      const granted = new BuiltinAcl([capability('main', [{ identifier: 'fs:allow-write-file', allow: [{ path: '$APPDATA/**' }, { path: '$APPDATA/plugins/**' }], deny: null }], { webviews: ['main'] })], platform);
      expect(granted.authorize('plugin:fs|write_file', MAIN)?.deny).toEqual(expect.arrayContaining(pluginDir));
    }
    expect(new BuiltinAcl([], 'linux', MANIFESTS).everyScopeOf('fs').deny).toEqual([]);
  });
});

describe('the shipped capabilities and the registered built-in plugins', () => {
  it('every command of every built-in plugin registered by electron/main.ts has an owner in the Tauri permission manifests', () => {
    const fsScope = new FsScope({ platform: 'linux' });
    const plugins = {
      event: eventPlugin(),
      window: windowPlugin(),
      webview: webviewPlugin(),
      path: pathPlugin(),
      app: appPlugin(),
      resources: resourcesPlugin(),
      dialog: dialogPlugin(),
      fs: fsPlugin({ global: fsScope, runtime: fsScope }),
      http: httpPlugin({ allow: [], deny: [] }),
      'clipboard-manager': clipboardPlugin(),
      image: imagePlugin(),
      opener: openerPlugin({ urlAllow: [], paths: fsScope, pathApps: [] }, 'linux'),
      notification: notificationPlugin(),
      process: processPlugin({} as ProcessHooks),
      updater: updaterPlugin({ appName: 'x', execPath: '/x', argv: [], env: {}, exit: () => undefined }),
      'global-shortcut': globalShortcutPlugin('linux', { pressed: () => undefined }),
    };
    const acl = new BuiltinAcl([], 'linux');
    expect(Object.values(plugins).reduce((count, table) => count + Object.keys(table).length, 0)).toBeGreaterThanOrEqual(180);
    const orphans = Object.entries(plugins).flatMap(([name, table]) => Object.keys(table).filter((command) => !acl.hasOwner(name, command)).map((command) => `${name}|${command}`));
    expect(orphans).toEqual([]);
  });

  it('loads on every desktop platform; browser-content gets nothing, main a superset of the small windows', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const acl = BuiltinAcl.fromDirectory(CAPABILITIES, platform);
      const main = acl.grantedCommands(MAIN);
      expect(main.length).toBeGreaterThan(100);
      expect(acl.grantedCommands({ window: 'main', webview: 'browser-content', origin: 'https://example.com' })).toEqual([]);
      expect(acl.grantedCommands({ window: 'main', webview: 'browser-content', origin: 'null' })).toEqual([]);
      expect(acl.grantedCommands({ ...MAIN, origin: 'https://example.com' })).toEqual([]);
      for (const label of ['quick-assistant', 'pomodoro-mini']) {
        const small = acl.grantedCommands({ window: label, webview: label });
        expect(small.filter((cmd) => cmd.startsWith('plugin:fs|') || cmd.startsWith('plugin:http|') || cmd.startsWith('plugin:opener|') || cmd.startsWith('plugin:updater|') || cmd.startsWith('plugin:process|'))).toEqual([]);
      }
      expect(acl.grantedCommands({ window: 'unknown', webview: 'unknown' })).toEqual([]);
    }
  });
});

describe('renderer message validation (main entry)', () => {
  it('drag-drop, drag-end and script-error messages are checked and copied', () => {
    expect(checkRendererMessage({ type: 'drag-drop', phase: 'drop', paths: ['/a', '/b'], position: { x: 1, y: 2 }, extra: true }, MAX_LOCAL_INVOKE_PAYLOAD))
      .toEqual({ ok: true, message: { type: 'drag-drop', phase: 'drop', paths: ['/a', '/b'], position: { x: 1, y: 2 } } });
    expect(checkRendererMessage({ type: 'window-drag-end', junk: 1 }, MAX_LOCAL_INVOKE_PAYLOAD)).toEqual({ ok: true, message: { type: 'window-drag-end' } });
    const long = checkRendererMessage({ type: 'script-error', message: 'x'.repeat(MAX_SCRIPT_ERROR_LENGTH + 10) }, MAX_LOCAL_INVOKE_PAYLOAD);
    expect(long.ok && long.message.type === 'script-error' && long.message.message.length).toBe(MAX_SCRIPT_ERROR_LENGTH);
    for (const bad of [
      null, 7, [], { type: 'nope' }, { type: 'drag-drop', phase: 'fly' },
      { type: 'drag-drop', phase: 'drop', paths: '/etc/passwd' },
      { type: 'drag-drop', phase: 'drop', paths: [1] },
      { type: 'drag-drop', phase: 'drop', paths: ['a\0b'] },
      { type: 'drag-drop', phase: 'drop', paths: Array.from({ length: MAX_DRAG_DROP_PATHS + 1 }, (_, i) => `/f${i}`) },
      { type: 'drag-drop', phase: 'over', position: { x: 'a', y: 1 } },
      { type: 'drag-drop', phase: 'over', position: { x: Number.NaN, y: 1 } },
      { type: 'script-error', message: { toString: () => 'x' } },
    ]) {
      expect(checkRendererMessage(bad, MAX_LOCAL_INVOKE_PAYLOAD)).toMatchObject({ ok: false, reply: null });
    }
  });
});

describe('SEC-E05 browser-content native events', () => {
  it('dstu-browser:// events built by main carry the main-only native marker and the trusted source', () => {
    expect(nativeBrowserContentEvent({ window: 'main', webview: 'browser-content', origin: 'https://ignored.example' }, 'dstu-browser://page-finished', { url: 'https://a.example/' })).toEqual({
      kind: 'frontend-event',
      event: 'dstu-browser://page-finished',
      payload: { url: 'https://a.example/' },
      target: { kind: 'App' },
      source: { window: 'main', webview: 'browser-content' },
      native: true,
    });
  });

  it('the global shortcut handler (Rust with_handler) reaches the Host as a main-native event from the main webview', () => {
    const runtime = new ShellRuntime({
      platform: 'linux',
      debug: false,
      config: {
        productName: 'SEC-E05', version: '0.0.0', identifier: 'test', devUrl: '', frontendDist: '', windows: [],
        assetScope: { allow: [], deny: [] }, assetProtocolEnabled: false, csp: null, macOSPrivateApi: false,
      },
      paths: new PathResolver({ platform: 'linux', env: {}, fallbackHome: '/tmp', identifier: 'test', tempDir: '/tmp', resourceDir: null }),
      assetScope: new FsScope({ platform: 'linux' }),
      fsScope: new FsScope({ platform: 'linux' }),
      appVersion: '0.0.0',
      localOrigin: 'tauri://localhost',
      log: () => undefined,
      acl: new BuiltinAcl([], 'linux', {}),
    });
    const toHost: unknown[] = [];
    runtime.host = { sendMessage: (message: unknown) => { toHost.push(message); } } as unknown as HostSupervisor;
    const event = { shortcut: 'CommandOrControl+Shift+Space', id: 7, state: 'Pressed' as const };
    forwardShortcutToHost(runtime)(event);
    expect(toHost).toEqual([{
      kind: 'frontend-event',
      event: GLOBAL_SHORTCUT_TRIGGERED,
      payload: event,
      target: { kind: 'App' },
      source: { window: 'main', webview: 'main' },
      native: true,
    }]);
  });
});
