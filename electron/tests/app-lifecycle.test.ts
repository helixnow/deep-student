/**
 * main 的进程生命周期装配（`electron/app-lifecycle.ts`）：真实的 WindowManager、BackgroundResidency、queryResidencyState
 * 与有序退出连在一起，BrowserWindow / app / powerMonitor / Host 用替身。对照 Rust：
 * `src-tauri/src/lib.rs:1714-1783`（主窗口 CloseRequested）、`:3249-3268`（ExitRequested）、`:3270-3285`（macOS Reopen）、
 * `:695-701`（single-instance）。真实 Electron 下的接线见 `background-residency-wiring-host.test.ts`。
 */
import { EventEmitter } from 'node:events';
import type { App, PowerMonitor } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundResidencyState, HostInvoke } from '../shell/background-residency.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';

const fake = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  let nextId = 1;
  class FakeWebContents extends Emitter {
    readonly id = nextId++;
    destroyed = false;
    isDestroyed(): boolean { return this.destroyed; }
    executeJavaScript = vi.fn(async (_script: string): Promise<unknown> => undefined);
  }
  /** `close()` 发 `close`，没人阻止就销毁并发 `closed`；最后一个窗口销毁时调 {@link FakeBrowserWindow.onAllClosed}。 */
  class FakeBrowserWindow extends Emitter {
    static readonly all = new Set<FakeBrowserWindow>();
    static onAllClosed: () => void = () => undefined;
    static getAllWindows(): FakeBrowserWindow[] { return [...FakeBrowserWindow.all]; }
    readonly webContents = new FakeWebContents();
    readonly calls: string[] = [];
    visible = false;
    minimized = false;
    destroyed = false;
    constructor() {
      super();
      FakeBrowserWindow.all.add(this);
    }
    isDestroyed(): boolean { return this.destroyed; }
    isVisible(): boolean { return this.visible; }
    isMinimized(): boolean { return this.minimized; }
    isFocused(): boolean { return false; }
    show(): void { this.calls.push('show'); this.visible = true; }
    showInactive(): void { this.show(); }
    hide(): void { this.calls.push('hide'); this.visible = false; }
    minimize(): void { this.minimized = true; }
    restore(): void { this.calls.push('restore'); this.minimized = false; }
    focus(): void { this.calls.push('focus'); }
    maximize(): void {}
    setContentProtection(): void {}
    loadURL(): Promise<void> { return Promise.resolve(); }
    close(): void {
      if (this.destroyed) return;
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.webContents.destroyed = true;
      FakeBrowserWindow.all.delete(this);
      this.emit('closed');
      if (FakeBrowserWindow.all.size === 0) FakeBrowserWindow.onAllClosed();
    }
  }
  return { FakeBrowserWindow };
});

vi.mock('electron', () => ({
  BrowserWindow: fake.FakeBrowserWindow,
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
}));

const { createAppLifecycle, SNAPSHOT_QUIT_BUDGET_MS } = await import('../app-lifecycle.ts');
const { WindowManager } = await import('../shell/windows.ts');
const { BACKGROUND_NOTICE_TITLE, BACKGROUND_NOTICE_REASONS } = await import('../shell/background-residency.ts');
const { HOST_QUIT_DEADLINE_MS, HOST_SHUTDOWN_BUDGET_MS } = await import('../shell/host.ts');
type LifecycleApp = import('../app-lifecycle.ts').LifecycleApp;
type FakeBrowserWindow = InstanceType<typeof fake.FakeBrowserWindow>;

// main.ts 传入的真实 Electron 对象必须满足这里的接口。
type Assignable<T, U extends T> = U;
export type ElectronObjectsFit = [Assignable<LifecycleApp, App>, Assignable<Parameters<typeof createAppLifecycle>[0]['powerMonitor'], PowerMonitor>];

/**
 * Electron `app` 替身：`quit()` 先发可取消的 `before-quit`；没被取消时关闭全部窗口后直接结束进程
 * （Electron 文档：这种情况下不发 `window-all-closed`，Host 不会经有序关停）。
 */
class FakeApp extends EventEmitter {
  exitCode: number | null = null;
  readonly exits: number[] = [];
  /** 没经 main 的有序退出、由 Electron 自己结束了进程。 */
  quitUnordered = false;
  relaunched = false;
  readonly focusCalls: unknown[] = [];
  focus(options?: { steal: boolean }): void { this.focusCalls.push(options); }
  relaunch(): void { this.relaunched = true; }
  exit(code = 0): void { this.exitCode = code; this.exits.push(code); }
  quit(): void {
    let prevented = false;
    this.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    const onAllClosed = fake.FakeBrowserWindow.onAllClosed;
    fake.FakeBrowserWindow.onAllClosed = () => undefined;
    for (const win of fake.FakeBrowserWindow.getAllWindows()) win.close();
    fake.FakeBrowserWindow.onAllClosed = onAllClosed;
    if (fake.FakeBrowserWindow.all.size === 0) this.quitUnordered = true;
  }
}

interface HostSetup {
  /** `get_setting` 的值（没有的键回 null，与 Rust `Option<String>` 一致）。 */
  settings?: Record<string, string>;
  automations?: Array<{ enabled: boolean }>;
  /** W02 的 `agentAutomation.backgroundResidency()` 已上线时的回答；不给则 Host 以“未在 meta.remote 声明”拒绝。 */
  entry?: BackgroundResidencyState;
  /** Host 不可用：所有调用都失败。 */
  unavailable?: boolean;
  /** Host 关停卡住：`shutdownHost()` 永不完成（不理 shutdown，也不理 kill 发的 SIGTERM）。 */
  shutdownHangs?: boolean;
  beforeExit?: () => void;
}

function launch(platform: ShellPlatform, host: HostSetup = {}, page: { listensForClose?: boolean } = {}) {
  fake.FakeBrowserWindow.all.clear();
  const app = new FakeApp();
  const powerMonitor = new EventEmitter();
  fake.FakeBrowserWindow.onAllClosed = () => app.emit('window-all-closed');
  const hostCalls: string[] = [];
  const invokeHost: HostInvoke = async (cmd, args) => {
    const a = args as { key?: string; service?: string; method?: string };
    hostCalls.push(cmd === 'plugin:host|call' ? `${a.service}.${a.method}` : cmd === 'get_setting' ? `get_setting ${a.key}` : cmd);
    if (host.unavailable) throw new Error('Desktop Host is not running');
    if (cmd === 'plugin:host|call') {
      if (host.entry) return host.entry;
      throw new Error('service "agentAutomation" does not expose "backgroundResidency" to UI (declare it in meta.remote)');
    }
    if (cmd === 'get_setting') return host.settings?.[a.key ?? ''] ?? null;
    if (cmd === 'chat_v2_automation_list') return { automations: host.automations ?? [] };
    throw new Error(`unexpected command ${cmd}`);
  };
  let hostShutdowns = 0;
  /** 每次强制结束 Host 时 app 是否已经退出（应当还没有）。 */
  const hostKills: Array<number | null> = [];
  const notices: Array<{ title: string; body: string }> = [];
  const logs: string[] = [];
  const lifecycle = createAppLifecycle({
    ...{ beforeExit: host.beforeExit },
    platform,
    app,
    powerMonitor,
    invokeHost,
    shutdownHost: async () => {
      hostShutdowns++;
      if (host.shutdownHangs) await new Promise<never>(() => undefined);
    },
    killHost: () => { hostKills.push(app.exitCode); },
    allWindows: () => fake.FakeBrowserWindow.getAllWindows(),
    log: (message) => logs.push(message),
    notification: { isSupported: () => true, show: ({ title, body }) => { notices.push({ title, body }); } },
  });
  const emitted: string[] = [];
  const windows = new WindowManager({
    platform,
    debug: false,
    preloadPath: '/preload.cjs',
    resolveUrl: () => 'tauri://localhost/index.html',
    emit: (event) => emitted.push(event),
    hasJsListener: (event) => event === 'tauri://close-requested' && page.listensForClose === true,
    lifecycle: () => undefined,
    webviewGone: () => undefined,
    afterCreate: (win) => lifecycle.windowCreated(win),
    log: (message) => logs.push(message),
  });
  lifecycle.install();
  const main = windows.create({ label: 'main' });
  const mainWindow = main.browserWindow as unknown as FakeBrowserWindow;
  const settle = async () => {
    await lifecycle.residency.whenSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    app, powerMonitor, lifecycle, windows, main, mainWindow, hostCalls, notices, logs, emitted, settle,
    hostShutdowns: () => hostShutdowns,
    hostKills,
    /** 用户点关闭按钮（或 `plugin:window|close`）。 */
    closeMain: async () => {
      mainWindow.close();
      await settle();
    },
  };
}

const PLATFORMS: ShellPlatform[] = ['darwin', 'win32', 'linux'];
const QUICK = { settings: { 'quick_assistant.background_enabled': 'true' } } satisfies HostSetup;
const NONE = {} satisfies HostSetup;

describe('closing the main window with a background condition keeps the app resident (lib.rs:1739-1769)', () => {
  const conditions: Array<[string, HostSetup, string]> = [
    ['quick_assistant.background_enabled = "true"', QUICK, BACKGROUND_NOTICE_REASONS.quickAssistant],
    ['an enabled automation, chat_v2.automation_background_enabled unset (defaults on)', { automations: [{ enabled: false }, { enabled: true }] }, BACKGROUND_NOTICE_REASONS.automation],
    ['an enabled automation, chat_v2.automation_background_enabled = "true"', { settings: { 'chat_v2.automation_background_enabled': 'true' }, automations: [{ enabled: true }] }, BACKGROUND_NOTICE_REASONS.automation],
    ['super_agent.enabled = " 1 " (Rust trims)', { settings: { 'super_agent.enabled': ' 1 ' } }, BACKGROUND_NOTICE_REASONS.superAgent],
    ['super_agent.enabled = "true"', { settings: { 'super_agent.enabled': 'true' } }, BACKGROUND_NOTICE_REASONS.superAgent],
  ];
  for (const platform of PLATFORMS) {
    for (const [name, host, reason] of conditions) {
      it(`${platform}: ${name} hides the window, keeps the Host running and notifies once`, async () => {
        const run = launch(platform, host);
        await run.closeMain();
        expect(run.mainWindow.destroyed).toBe(false);
        expect(run.mainWindow.visible).toBe(false);
        expect(run.windows.get('main')).toBe(run.main);
        expect(run.hostShutdowns()).toBe(0);
        expect(run.app.exitCode).toBeNull();
        expect(run.notices).toEqual([{ title: BACKGROUND_NOTICE_TITLE, body: `${reason}。` }]);
        // 没有页面监听时 close-requested 只发一次（WindowManager 自己的监听在驻留判定之前）。
        expect(run.emitted.filter((event) => event === 'tauri://close-requested')).toHaveLength(1);
        // 当前 INT 上 Host 还没有 W02 的入口：先问入口，被拒后按 Rust 口径读设置与自动化列表。
        expect(run.hostCalls[0]).toBe('agentAutomation.backgroundResidency');
        expect(run.hostCalls).toContain('chat_v2_automation_list');
      });
    }
  }

  it('several conditions are listed in Rust\'s order in one notice', async () => {
    const run = launch('linux', {
      settings: { 'quick_assistant.background_enabled': 'true', 'super_agent.enabled': 'true' },
      automations: [{ enabled: true }],
    });
    await run.closeMain();
    expect(run.notices).toEqual([{
      title: BACKGROUND_NOTICE_TITLE,
      body: `${BACKGROUND_NOTICE_REASONS.automation}；${BACKGROUND_NOTICE_REASONS.superAgent}；${BACKGROUND_NOTICE_REASONS.quickAssistant}。`,
    }]);
  });

  it('once W02\'s Host entry answers, its state is used as is and no setting is read (no change in main needed)', async () => {
    const run = launch('win32', { entry: { automation: false, superAgent: true, quickAssistant: false, notificationsDisabled: false } });
    await run.closeMain();
    expect(run.hostCalls).toEqual(['agentAutomation.backgroundResidency']);
    expect(run.mainWindow.visible).toBe(false);
    expect(run.notices).toEqual([{ title: BACKGROUND_NOTICE_TITLE, body: `${BACKGROUND_NOTICE_REASONS.superAgent}。` }]);
    expect(run.logs.some((line) => line.includes('unavailable'))).toBe(false);
  });

  it('the "never" notification policy hides without a notice (lib.rs:1748-1750)', async () => {
    const run = launch('darwin', { settings: { 'quick_assistant.background_enabled': 'true', 'system-notification-policy': 'never' } });
    await run.closeMain();
    expect(run.mainWindow.visible).toBe(false);
    expect(run.mainWindow.destroyed).toBe(false);
    expect(run.notices).toEqual([]);
  });

  it('a double click on the close button before the Host answers gives one decision and one notice', async () => {
    const run = launch('linux', QUICK);
    run.mainWindow.close();
    run.mainWindow.close();
    await run.settle();
    expect(run.notices).toHaveLength(1);
    expect(run.mainWindow.calls.filter((call) => call === 'hide').length).toBeGreaterThanOrEqual(1);
    expect(run.mainWindow.destroyed).toBe(false);
  });

  it('every close that goes to the background notifies again, as in Rust (no first-time-only rule)', async () => {
    const run = launch('win32', QUICK);
    await run.closeMain();
    run.app.emit('second-instance');
    await run.closeMain();
    expect(run.notices).toHaveLength(2);
  });

  it('a second instance brings the hidden window back: show, unminimize, focus (lib.rs:695-701)', async () => {
    const run = launch('linux', QUICK);
    run.mainWindow.minimize();
    await run.closeMain();
    run.mainWindow.calls.length = 0;
    run.app.emit('second-instance');
    expect(run.mainWindow.calls).toEqual(['show', 'restore', 'focus']);
    expect(run.mainWindow.visible).toBe(true);
  });

  it('a second instance during the Host query keeps the window open', async () => {
    const run = launch('linux', NONE);
    run.mainWindow.close();
    run.app.emit('second-instance');
    await run.settle();
    expect(run.mainWindow.destroyed).toBe(false);
    expect(run.mainWindow.visible).toBe(true);
    expect(run.hostShutdowns()).toBe(0);
  });

  it('macOS Reopen (activate) shows, focuses and activates the app (lib.rs:3270-3285)', async () => {
    const run = launch('darwin', QUICK);
    await run.closeMain();
    run.mainWindow.calls.length = 0;
    run.app.emit('activate');
    expect(run.mainWindow.calls).toEqual(['show', 'focus']);
    expect(run.app.focusCalls).toEqual([{ steal: true }]);
  });

  it('a page listening for close-requested still gets it; residency then hides the window', async () => {
    const run = launch('win32', QUICK, { listensForClose: true });
    await run.closeMain();
    expect(run.emitted.filter((event) => event === 'tauri://close-requested')).toHaveLength(1);
    expect(run.mainWindow.visible).toBe(false);
    expect(run.mainWindow.destroyed).toBe(false);
  });
});

describe('closing the main window without a background condition (lib.rs:1770-1780)', () => {
  for (const platform of ['win32', 'linux'] as const) {
    it(`${platform}: the window really closes and the app quits through the ordered shutdown`, async () => {
      const run = launch(platform, NONE);
      await run.closeMain();
      expect(run.mainWindow.destroyed).toBe(true);
      expect(run.windows.get('main')).toBeUndefined();
      expect(run.hostShutdowns()).toBe(1);
      expect(run.app.exitCode).toBe(0);
      expect(run.notices).toEqual([]);
    });
  }

  it('macOS: marks the app as exiting, hides and quits through the ordered shutdown (Host first, then app.exit(0))', async () => {
    const run = launch('darwin', NONE);
    await run.closeMain();
    expect(run.lifecycle.residency.exiting).toBe(true);
    expect(run.mainWindow.visible).toBe(false);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exitCode).toBe(0);
    expect(run.notices).toEqual([]);
  });

  it('the automation background switch "false" turns scheduled tasks off (automations.rs:4779-4792)', async () => {
    const run = launch('linux', { settings: { 'chat_v2.automation_background_enabled': 'false' }, automations: [{ enabled: true }] });
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(true);
    expect(run.app.exitCode).toBe(0);
  });

  it('values Rust does not accept do not count ("TRUE", "yes", disabled automations)', async () => {
    const run = launch('linux', {
      settings: { 'quick_assistant.background_enabled': 'TRUE', 'super_agent.enabled': 'yes' },
      automations: [{ enabled: false }],
    });
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(true);
    expect(run.app.exitCode).toBe(0);
  });

  it('an unavailable Host counts as no condition: the close is not held up', async () => {
    const run = launch('win32', { unavailable: true });
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(true);
    expect(run.app.exitCode).toBe(0);
  });

  it('a page listening for close-requested decides itself (the window is not destroyed behind its back)', async () => {
    const run = launch('linux', NONE, { listensForClose: true });
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(false);
    expect(run.mainWindow.visible).toBe(true);
    expect(run.app.exitCode).toBeNull();
  });
});

describe('explicit exit and system shutdown are never intercepted (lib.rs:3249-3252)', () => {
  it('app.quit (menu Quit, Cmd+Q): ordered shutdown, and a close during it is not turned into residency', async () => {
    const run = launch('linux', QUICK);
    run.app.quit();
    expect(run.lifecycle.residency.exiting).toBe(true);
    expect(run.lifecycle.isQuitting()).toBe(true);
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(false);
    expect(run.hostCalls).toEqual([]);
    expect(run.notices).toEqual([]);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exitCode).toBe(0);
    expect(run.app.quitUnordered).toBe(false);
  });

  it('a second app.quit while the Host is shutting down does not let Electron end the process first', async () => {
    const run = launch('darwin', NONE);
    run.app.quit();
    run.app.quit();
    expect(run.app.quitUnordered).toBe(false);
    expect(run.mainWindow.destroyed).toBe(false);
    await run.settle();
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exitCode).toBe(0);
  });

  it('process plugin exit (plugin:process|exit) marks the app as exiting before the Host shuts down', async () => {
    const run = launch('win32', QUICK);
    run.lifecycle.processHooks.exit(3);
    expect(run.lifecycle.residency.exiting).toBe(true);
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(false);
    expect(run.hostCalls).toEqual([]);
    expect(run.app.exitCode).toBe(3);
  });

  it('process plugin restart relaunches after the Host has shut down', async () => {
    const run = launch('darwin', QUICK);
    run.lifecycle.processHooks.restart();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.relaunched).toBe(true);
    expect(run.app.exitCode).toBe(0);
  });

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform}: powerMonitor "shutdown" marks the app as exiting, so the system closing the window is not intercepted`, async () => {
      const run = launch(platform, QUICK);
      run.powerMonitor.emit('shutdown');
      await run.closeMain();
      expect(run.mainWindow.destroyed).toBe(true);
      expect(run.hostCalls).toEqual([]);
      expect(run.notices).toEqual([]);
    });
  }

  it('win32: the window\'s "session-end" (logoff / shutdown) is not intercepted either', async () => {
    const run = launch('win32', QUICK);
    run.mainWindow.emit('session-end');
    await run.closeMain();
    expect(run.mainWindow.destroyed).toBe(true);
    expect(run.hostCalls).toEqual([]);
  });

  it('an exit that starts while the Host is still deciding drops the pending residency', async () => {
    const run = launch('linux', QUICK);
    run.mainWindow.close();
    run.app.quit();
    await run.settle();
    expect(run.notices).toEqual([]);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exitCode).toBe(0);
  });
});

describe('the last window going away quits (Tauri exits the event loop when the last window closes)', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: plugin:window|destroy of the only window goes through the ordered shutdown`, async () => {
      const run = launch(platform, QUICK);
      run.windows.destroy('main');
      await run.settle();
      expect(run.hostCalls).toEqual([]);
      expect(run.hostShutdowns()).toBe(1);
      expect(run.app.exitCode).toBe(0);
    });
  }
});

describe('windows other than main', () => {
  it('closing another window is never intercepted and does not ask the Host', async () => {
    const run = launch('linux', QUICK);
    const other = run.windows.create({ label: 'pomodoro-mini' }).browserWindow as unknown as FakeBrowserWindow;
    other.close();
    await run.settle();
    expect(other.destroyed).toBe(true);
    expect(run.hostCalls).toEqual([]);
    expect(run.app.exitCode).toBeNull();
  });

  it('on Linux a hidden quick-assistant window does not keep a windowless process alive (RF-W23-close-main-quits-with-only-hidden-windows)', async () => {
    const run = launch('linux', NONE);
    const quick = run.windows.create({ label: 'quick-assistant', visible: false }).browserWindow as unknown as FakeBrowserWindow;
    await run.closeMain();
    expect(quick.destroyed).toBe(false);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exitCode).toBe(0);
  });
});

describe('a Host that hangs while shutting down cannot keep the app from exiting', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('B4 hard deadline finishes the ledger before app.exit even with shutdown pending', async () => {
    vi.useFakeTimers();
    let cleaned = false;
    const h = launch('darwin', { shutdownHangs: true, beforeExit: () => { cleaned = true; } });
    h.app.exit = () => { expect(cleaned).toBe(true); };
    h.app.quit();
    await vi.advanceTimersByTimeAsync(HOST_QUIT_DEADLINE_MS);
    expect(cleaned).toBe(true);
    vi.useRealTimers();
  });

  it('RF-W06-quit-hard-deadline: the deadline leaves the kill at the shutdown budget room to work first', () => {
    expect(HOST_QUIT_DEADLINE_MS).toBeGreaterThan(HOST_SHUTDOWN_BUDGET_MS);
  });

  it('RF-W06-quit-hard-deadline: Cmd+Q waits for the Host up to the deadline, a second Cmd+Q is still held, then the Host is killed and the app exits', async () => {
    vi.useFakeTimers();
    const run = launch('darwin', { shutdownHangs: true });
    run.app.quit();
    await vi.advanceTimersByTimeAsync(HOST_QUIT_DEADLINE_MS - 1);
    expect(run.app.exits).toEqual([]);
    expect(run.hostKills).toEqual([]);
    run.app.quit();
    expect(run.app.quitUnordered).toBe(false);
    expect(run.mainWindow.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.hostKills).toEqual([null]);
    expect(run.app.exits).toEqual([0]);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.logs).toContain(`[lifecycle] Host shutdown did not finish within ${HOST_QUIT_DEADLINE_MS}ms, exiting anyway`);
  });

  it('RF-W06-quit-hard-deadline: plugin:process exit and restart keep their exit code and relaunch at the deadline', async () => {
    vi.useFakeTimers();
    const exiting = launch('win32', { shutdownHangs: true });
    exiting.lifecycle.processHooks.exit(3);
    await vi.advanceTimersByTimeAsync(HOST_QUIT_DEADLINE_MS);
    expect(exiting.app.exits).toEqual([3]);
    expect(exiting.app.relaunched).toBe(false);
    const restarting = launch('linux', { shutdownHangs: true });
    restarting.lifecycle.processHooks.restart();
    await vi.advanceTimersByTimeAsync(HOST_QUIT_DEADLINE_MS);
    expect(restarting.hostKills).toEqual([null]);
    expect(restarting.app.relaunched).toBe(true);
    expect(restarting.app.exits).toEqual([0]);
  });

  it('RF-W06-quit-hard-deadline: a Host that shuts down in time is not killed and the app exits exactly once', async () => {
    vi.useFakeTimers();
    const run = launch('darwin', NONE);
    run.app.quit();
    await vi.advanceTimersByTimeAsync(HOST_QUIT_DEADLINE_MS * 2);
    expect(run.app.exits).toEqual([0]);
    expect(run.hostKills).toEqual([]);
    expect(run.logs.filter((line) => line.startsWith('[lifecycle]'))).toEqual([]);
  });
});

describe('snapshot persistence precedes Host shutdown', () => {
  afterEach(() => vi.useRealTimers());

  for (const trigger of ['quit', 'restart', 'close'] as const) {
    it(`${trigger}: keeps the renderer and Host alive until the snapshot is saved`, async () => {
      const run = launch('linux', NONE);
      let saved!: () => void;
      run.mainWindow.webContents.executeJavaScript.mockImplementation(() => new Promise<void>((resolve) => { saved = resolve; }));
      if (trigger === 'quit') run.app.quit();
      else if (trigger === 'restart') run.lifecycle.processHooks.restart();
      else run.mainWindow.close();
      await run.settle();
      expect(run.mainWindow.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(run.hostShutdowns()).toBe(0);
      expect(run.mainWindow.destroyed).toBe(false);
      expect(run.app.exitCode).toBeNull();
      if (trigger !== 'close') {
        run.app.quit();
        run.mainWindow.close();
        expect(run.mainWindow.destroyed).toBe(false);
      }
      saved();
      await run.settle();
      expect(run.hostShutdowns()).toBe(1);
      expect(run.app.exits).toEqual([0]);
      expect(run.app.relaunched).toBe(trigger === 'restart');
    });
  }

  it('a hung renderer has a bounded flush budget, then the Host still gets orderly shutdown', async () => {
    vi.useFakeTimers();
    const run = launch('darwin', NONE);
    run.mainWindow.webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
    run.app.quit();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_QUIT_BUDGET_MS - 1);
    expect(run.hostShutdowns()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exits).toEqual([0]);
    expect(run.logs.some((line) => line.includes('snapshot flush timed out'))).toBe(true);
  });

  it('renderer failure is logged but does not bypass Host shutdown', async () => {
    const run = launch('darwin', NONE);
    run.mainWindow.webContents.executeJavaScript.mockRejectedValue(new Error('renderer gone'));
    run.app.quit();
    await run.settle();
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exits).toEqual([0]);
    expect(run.logs.some((line) => line.includes('renderer gone'))).toBe(true);
  });

  it('a failed auxiliary renderer does not abandon the main snapshot still being saved', async () => {
    const run = launch('darwin', NONE);
    const other = run.windows.create({ label: 'quick-assistant' }).browserWindow as unknown as FakeBrowserWindow;
    other.webContents.executeJavaScript.mockRejectedValue(new Error('auxiliary gone'));
    let saved!: () => void;
    run.mainWindow.webContents.executeJavaScript.mockImplementation(() => new Promise<void>((resolve) => { saved = resolve; }));
    run.app.quit();
    await run.settle();
    expect(run.hostShutdowns()).toBe(0);
    saved();
    await run.settle();
    expect(run.hostShutdowns()).toBe(1);
    expect(run.app.exits).toEqual([0]);
  });
});
