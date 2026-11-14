import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSurfaceLike } from '../shell/browser-protocol.ts';
import { ShellCommandError } from '../shell/errors.ts';
import { BaseDirectory, UnknownPathError } from '../shell/paths.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import type { ShellWindow } from '../shell/windows.ts';
import { handleShellRequest, type ShellRequestDeps } from '../shell-requests.ts';

const native = vi.hoisted(() => ({
  setWindowAppearance: vi.fn(),
  syncTitlebarSidebarMaterial: vi.fn(),
}));
vi.mock('../shell/native-window.ts', () => native);

interface FakeBrowserWindow {
  destroyed: boolean;
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  vibrancy: Array<string | null>;
}

function fakeWindow(label: string, state: Partial<FakeBrowserWindow> = {}): ShellWindow & { fake: FakeBrowserWindow } {
  const fake: FakeBrowserWindow = { destroyed: false, focused: true, visible: true, minimized: false, vibrancy: [], ...state };
  const browserWindow = {
    isDestroyed: () => fake.destroyed,
    isFocused: () => fake.focused,
    isVisible: () => fake.visible,
    isMinimized: () => fake.minimized,
    setVibrancy: (value: string | null) => { fake.vibrancy.push(value); },
  };
  return { label, browserWindow, fake } as unknown as ShellWindow & { fake: FakeBrowserWindow };
}

interface Setup {
  platform?: ShellPlatform;
  windows?: Array<ShellWindow & { fake: FakeBrowserWindow }>;
  osDirs?: ShellRequestDeps['osDirs'];
  directories?: Record<number, string | Error>;
  runBuiltin?: ShellRequestDeps['runBuiltin'];
}

const ROOT = join('/', 'r');

function deps(setup: Setup = {}): ShellRequestDeps & { builtinCalls: Array<[string, Record<string, unknown>, string]> } {
  const windows = new Map((setup.windows ?? []).map((win) => [win.label, win]));
  const builtinCalls: Array<[string, Record<string, unknown>, string]> = [];
  return {
    builtinCalls,
    platform: setup.platform ?? 'darwin',
    identifier: 'com.example.app',
    appDataDir: join(ROOT, 'data', 'com.example.app'),
    osDirs: setup.osDirs ?? { dataLocal: join(ROOT, 'local'), cache: join(ROOT, 'cache') },
    migrationsDir: join(ROOT, 'migrations'),
    fullVersion: () => '1.2.3+20000',
    windows: {
      get: (label: string) => windows.get(label),
      listWindows: () => [{ label: 'listed' }] as never,
      getMainWindow: () => ({ label: 'main-snapshot' }) as never,
    },
    paths: {
      resolveDirectory: (directory: number) => {
        const value = setup.directories?.[directory];
        if (value === undefined) throw new UnknownPathError();
        if (value instanceof Error) throw value;
        return value;
      },
    },
    browserSurface: { destroyContentWindow: async () => true } as unknown as BrowserSurfaceLike,
    runBuiltin: setup.runBuiltin ?? ((command, args, windowLabel) => {
      builtinCalls.push([command, args, windowLabel]);
      return command === 'plugin:window|show' || command === 'plugin:process|restart' ? Promise.resolve('ran') : undefined;
    }),
  };
}

beforeEach(() => {
  native.setWindowAppearance.mockReset();
  native.syncTitlebarSidebarMaterial.mockReset();
});

describe('main-owned queries', () => {
  it('answers version, migrations dir and the window catalog', async () => {
    const d = deps();
    await expect(handleShellRequest(d, { op: 'app.fullVersion', args: undefined })).resolves.toBe('1.2.3+20000');
    await expect(handleShellRequest(d, { op: 'app.migrationsDir', args: {} })).resolves.toBe(join(ROOT, 'migrations'));
    await expect(handleShellRequest(d, { op: 'window.listWindows', args: {} })).resolves.toEqual([{ label: 'listed' }]);
    await expect(handleShellRequest(d, { op: 'window.getMainWindow', args: {} })).resolves.toEqual({ label: 'main-snapshot' });
  });

  it('app.startupReady records Host readiness and returns null', async () => {
    const onStartupReady = vi.fn();
    await expect(handleShellRequest({ ...deps(), onStartupReady }, { op: 'app.startupReady', args: {} })).resolves.toBeNull();
    expect(onStartupReady).toHaveBeenCalledTimes(1);
    expect(deps().builtinCalls).toEqual([]);
  });

  it('routes browser.* to the browser surface, including its unknown-op error', async () => {
    const d = deps();
    await expect(handleShellRequest(d, { op: 'browser.destroyContentWindow', args: {} })).resolves.toBe(true);
    await expect(handleShellRequest(d, { op: 'browser.nope', args: {} })).rejects.toThrow('unknown shell op: browser.nope');
    expect(d.builtinCalls).toEqual([]);
  });

  it('app.dataDirs: app data dir as handed to the Host, identifier-suffixed local data / cache, raw data_local_dir', async () => {
    await expect(handleShellRequest(deps(), { op: 'app.dataDirs', args: {} })).resolves.toEqual({
      data: join(ROOT, 'data', 'com.example.app'),
      localData: join(ROOT, 'local', 'com.example.app'),
      cache: join(ROOT, 'cache', 'com.example.app'),
      dataLocalDir: join(ROOT, 'local'),
    });
    await expect(handleShellRequest(deps({ osDirs: { dataLocal: null, cache: null } }), { op: 'app.dataDirs', args: {} })).resolves.toEqual({
      data: join(ROOT, 'data', 'com.example.app'), localData: null, cache: null, dataLocalDir: null,
    });
  });

  it('app.pdfStreamAllowedDirs: app dirs then known user dirs, deduplicated, unknown dirs skipped, other errors surface', async () => {
    const directories = {
      [BaseDirectory.Document]: join(ROOT, 'docs'),
      [BaseDirectory.Download]: join(ROOT, 'docs'),
      [BaseDirectory.Temp]: '',
      [BaseDirectory.Resource]: join(ROOT, 'res'),
      [BaseDirectory.Picture]: join(ROOT, 'pics'),
    };
    await expect(handleShellRequest(deps({ directories }), { op: 'app.pdfStreamAllowedDirs', args: {} })).resolves.toEqual([
      join(ROOT, 'data', 'com.example.app'),
      join(ROOT, 'local', 'com.example.app'),
      join(ROOT, 'cache', 'com.example.app'),
      join(ROOT, 'docs'),
      join(ROOT, 'res'),
      join(ROOT, 'pics'),
    ]);
    await expect(handleShellRequest(deps({ osDirs: { dataLocal: null, cache: null } }), { op: 'app.pdfStreamAllowedDirs', args: {} }))
      .resolves.toEqual([join(ROOT, 'data', 'com.example.app')]);
    const broken = deps({ directories: { [BaseDirectory.Desktop]: new Error('home unreadable') } });
    await expect(handleShellRequest(broken, { op: 'app.pdfStreamAllowedDirs', args: {} })).rejects.toThrow('home unreadable');
  });
});

describe('app.mainWindowActive (Rust automations.rs main_window_is_active)', () => {
  it.each([
    ['focused, visible, not minimized', {}, true],
    ['not focused', { focused: false }, false],
    ['hidden (background residency)', { visible: false }, false],
    ['minimized', { minimized: true }, false],
    ['destroyed', { destroyed: true }, false],
  ])('%s', async (_name, state, expected) => {
    await expect(handleShellRequest(deps({ windows: [fakeWindow('main', state)] }), { op: 'app.mainWindowActive', args: {} })).resolves.toBe(expected);
  });

  it('no main window: false, whatever other windows do', async () => {
    await expect(handleShellRequest(deps({ windows: [fakeWindow('quick-assistant')] }), { op: 'app.mainWindowActive', args: {} })).resolves.toBe(false);
  });
});

describe('macOS window material requests', () => {
  it('window.setVibrancy: `label` beats `__window`; sidebar on, null off; other platforms report false without touching the window', async () => {
    const main = fakeWindow('main');
    const other = fakeWindow('other');
    const d = deps({ windows: [main, other] });
    await expect(handleShellRequest(d, { op: 'window.setVibrancy', args: { label: 'other', __window: 'main', enabled: true } })).resolves.toBe(true);
    await expect(handleShellRequest(d, { op: 'window.setVibrancy', args: { __window: 'main', enabled: 'yes' } })).resolves.toBe(false);
    expect(other.fake.vibrancy).toEqual(['sidebar']);
    expect(main.fake.vibrancy).toEqual([null]);

    const linuxMain = fakeWindow('main');
    await expect(handleShellRequest(deps({ platform: 'linux', windows: [linuxMain] }), { op: 'window.setVibrancy', args: { enabled: true } })).resolves.toBe(false);
    expect(linuxMain.fake.vibrancy).toEqual([]);
    await expect(handleShellRequest(deps({ platform: 'linux' }), { op: 'window.setVibrancy', args: { label: 'gone' } })).rejects.toThrow('window not found');
  });

  it('window.setAppearance / window.syncTitlebarSidebarMaterial act on the caller window (default main), only on macOS', async () => {
    const main = fakeWindow('main');
    const quick = fakeWindow('quick-assistant');
    const d = deps({ windows: [main, quick] });
    await expect(handleShellRequest(d, { op: 'window.setAppearance', args: { dark: true } })).resolves.toBeNull();
    await expect(handleShellRequest(d, { op: 'window.setAppearance', args: { __window: 'quick-assistant', dark: 'yes' } })).resolves.toBeNull();
    expect(native.setWindowAppearance.mock.calls).toEqual([[main.browserWindow, true], [quick.browserWindow, false]]);
    await expect(handleShellRequest(d, { op: 'window.syncTitlebarSidebarMaterial', args: { enabled: true, width: 240 } })).resolves.toBeNull();
    await expect(handleShellRequest(d, { op: 'window.syncTitlebarSidebarMaterial', args: { enabled: true, width: '240' } })).resolves.toBeNull();
    expect(native.syncTitlebarSidebarMaterial.mock.calls).toEqual([[main.browserWindow, true, 240], [main.browserWindow, true, 0]]);

    for (const platform of ['win32', 'linux'] as const) {
      const p = deps({ platform, windows: [fakeWindow('main')] });
      await expect(handleShellRequest(p, { op: 'window.setAppearance', args: { dark: true } })).resolves.toBeNull();
      await expect(handleShellRequest(p, { op: 'window.syncTitlebarSidebarMaterial', args: { enabled: true } })).resolves.toBeNull();
    }
    expect(native.setWindowAppearance).toHaveBeenCalledTimes(2);
    expect(native.syncTitlebarSidebarMaterial).toHaveBeenCalledTimes(2);
    await expect(handleShellRequest(deps({ platform: 'linux' }), { op: 'window.setAppearance', args: {} })).rejects.toThrow('window not found');
    await expect(handleShellRequest(deps({ platform: 'linux' }), { op: 'window.syncTitlebarSidebarMaterial', args: {} })).rejects.toThrow('window not found');
  });
});

describe('builtin plugin commands', () => {
  it('runs the command as the `__window` caller (default main) with the full args, mapping process:restart', async () => {
    const d = deps();
    await expect(handleShellRequest(d, { op: 'plugin:window|show', args: { label: 'main', __window: 'quick-assistant' } })).resolves.toBe('ran');
    await expect(handleShellRequest(d, { op: 'process:restart', args: undefined })).resolves.toBe('ran');
    expect(d.builtinCalls).toEqual([
      ['plugin:window|show', { label: 'main', __window: 'quick-assistant' }, 'quick-assistant'],
      ['plugin:process|restart', {}, 'main'],
    ]);
  });

  it('an op that is neither main-owned nor a builtin command is rejected by name', async () => {
    await expect(handleShellRequest(deps(), { op: 'plugin:nope|nothing', args: {} })).rejects.toThrow('unknown shell op: plugin:nope|nothing');
  });

  it('a command error reaches the Host as its plain value (string as is, others as JSON); other errors pass through', async () => {
    const failing = (error: unknown) => deps({ runBuiltin: () => Promise.reject(error) });
    const stringError = await handleShellRequest(failing(new ShellCommandError('window not found')), { op: 'plugin:window|show', args: {} }).catch((e: unknown) => e);
    expect(stringError).toBeInstanceOf(Error);
    expect(stringError).not.toBeInstanceOf(ShellCommandError);
    expect((stringError as Error).message).toBe('window not found');
    await expect(handleShellRequest(failing(new ShellCommandError({ kind: 'Io', message: 'denied' })), { op: 'plugin:fs|read_file', args: {} }))
      .rejects.toThrow('{"kind":"Io","message":"denied"}');
    const other = new TypeError('boom');
    await expect(handleShellRequest(failing(other), { op: 'plugin:window|show', args: {} })).rejects.toBe(other);
  });
});
