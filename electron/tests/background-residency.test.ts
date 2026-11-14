/**
 * 关闭主窗口后的后台驻留（`electron/shell/background-residency.ts`），逐条对照 Rust：
 * `src-tauri/src/lib.rs:1714-1783`（主窗口 CloseRequested）、`:3249-3252`（ExitRequested）、`:3270-3285`（macOS Reopen）、
 * `:695-701`（single-instance）；`automations.rs:4779-4792`；`super_session/state.rs:226-236`；`system_notification.rs:28-45`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { App, PowerMonitor } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '../../host/kernel/api.ts';
import { DEFAULT_HOST_CALL_CALLER_MODE } from '../../host/kernel/runtime.ts';
import { createTestHost, type TestHost } from '../../host/kernel/testing.ts';
import { SYSTEM_NOTIFICATION_POLICY_KEY } from '../api.ts';
import {
  AUTOMATION_BACKGROUND_KEY,
  BACKGROUND_NOTICE_TITLE,
  BackgroundResidency,
  countShownWindows,
  decideMainWindowClose,
  QUICK_ASSISTANT_BACKGROUND_KEY,
  queryResidencyState,
  residencyStateFromCommands,
  RESIDENCY_HOST_CALL,
  SUPER_AGENT_ENABLED_KEY,
  UNREADABLE_RESIDENCY_STATE,
  type BackgroundResidencyState,
  type HostInvoke,
  type ResidencyApp,
  type ResidencyMainWindow,
  type ResidencyPowerMonitor,
} from '../shell/background-residency.ts';
import type { NotificationHooks } from '../shell/plugins/system.ts';
import type { ShellPlatform } from '../shell/tauri-config.ts';
import type { ShellWindow } from '../shell/windows.ts';

// main.ts 传入的真实对象必须满足模块的接口。
type Assignable<T, U extends T> = U;
export type ElectronObjectsFit = [Assignable<ResidencyMainWindow, ShellWindow>, Assignable<ResidencyApp, App>, Assignable<ResidencyPowerMonitor, PowerMonitor>];

const PLATFORMS: ShellPlatform[] = ['darwin', 'win32', 'linux'];
const OFF: BackgroundResidencyState = { automation: false, superAgent: false, quickAssistant: false, notificationsDisabled: false };
const state = (patch: Partial<BackgroundResidencyState>): BackgroundResidencyState => ({ ...OFF, ...patch });

type Listener = (event?: { preventDefault(): void }) => void;

/** BrowserWindow 替身：`close()` 发 `close`，没人阻止就销毁并发 `closed`。 */
class FakeWindow {
  visible = true;
  destroyed = false;
  minimized = false;
  readonly calls: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: (event: { preventDefault(): void }) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as Listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, arg?: { preventDefault(): void }): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(arg);
  }

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  show(): void { this.calls.push('show'); this.visible = true; }
  hide(): void { this.calls.push('hide'); this.visible = false; }
  restore(): void { this.calls.push('restore'); this.minimized = false; }
  focus(): void { this.calls.push('focus'); }
  close(): void {
    this.calls.push('close');
    if (this.destroyed) return;
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}

interface FakeMain extends ResidencyMainWindow {
  readonly browserWindow: FakeWindow;
  closeRequested: number;
}

/** WindowManager 的 `close` 监听（`windows.ts:197-205`），先于驻留模块注册。 */
function shellWindow(pageListensForCloseRequested = false): FakeMain {
  const win = new FakeWindow();
  const main: FakeMain = { browserWindow: win, destroying: false, closeRequested: 0 };
  win.on('close', (event) => {
    if (main.destroying) return;
    if (pageListensForCloseRequested) event.preventDefault();
    main.closeRequested++;
    if (!pageListensForCloseRequested) main.destroying = true;
  });
  return main;
}

class FakeApp {
  readonly focusCalls: unknown[] = [];
  private readonly listeners = new Map<string, Array<() => void>>();
  on(event: string, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener(); }
  has(event: string): boolean { return (this.listeners.get(event) ?? []).length > 0; }
  focus(options?: { steal: boolean }): void { this.focusCalls.push(options); }
}

interface Harness {
  residency: BackgroundResidency;
  main: FakeMain;
  app: FakeApp;
  power: FakeApp;
  notices: Array<{ title: string; body: string; silent: boolean }>;
  quits: number[];
  queries: number[];
  logs: string[];
}

function harness(options: {
  platform: ShellPlatform;
  query?: () => Promise<BackgroundResidencyState>;
  pageListens?: boolean;
  notification?: NotificationHooks;
  timeoutMs?: number;
  otherWindows?: Array<{ isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }>;
}): Harness {
  const notices: Harness['notices'] = [];
  const quits: number[] = [];
  const queries: number[] = [];
  const logs: string[] = [];
  const query = options.query ?? (async () => OFF);
  const residency = new BackgroundResidency({
    platform: options.platform,
    queryState: () => {
      queries.push(queries.length + 1);
      return query();
    },
    quit: () => quits.push(quits.length + 1),
    log: (message) => logs.push(message),
    notification: options.notification ?? { isSupported: () => true, show: (notice) => notices.push(notice) },
    ...(options.timeoutMs === undefined ? {} : { queryTimeoutMs: options.timeoutMs }),
    ...(options.otherWindows === undefined ? {} : { shownWindowCount: () => countShownWindows(options.otherWindows ?? []) }),
  });
  const app = new FakeApp();
  const power = new FakeApp();
  residency.install(app, power);
  const main = shellWindow(options.pageListens ?? false);
  residency.attachMainWindow(main);
  return { residency, main, app, power, notices, quits, queries, logs };
}

async function closeMain(h: Harness): Promise<void> {
  h.main.browserWindow.close();
  await h.residency.whenSettled();
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the close decision (lib.rs:1739-1780)', () => {
  it('each condition alone keeps the app in the background on every platform, with Rust\'s notice text', () => {
    const cases: Array<[Partial<BackgroundResidencyState>, string]> = [
      [{ automation: true }, '已启用的定时任务会继续按计划执行。'],
      [{ superAgent: true }, 'Super-agent 会话的后台任务会继续运行。'],
      [{ quickAssistant: true }, '快速助手保持可用。'],
    ];
    for (const platform of PLATFORMS) {
      for (const [patch, body] of cases) {
        expect(decideMainWindowClose(state(patch), platform, false)).toEqual({ kind: 'hide', notice: { title: 'Deep Student 正在后台运行', body } });
      }
    }
  });

  it('joins several reasons with "；" in the order scheduled tasks, Super-agent, quick assistant', () => {
    const decision = decideMainWindowClose(state({ quickAssistant: true, automation: true, superAgent: true }), 'linux', false);
    expect(decision).toEqual({
      kind: 'hide',
      notice: { title: BACKGROUND_NOTICE_TITLE, body: '已启用的定时任务会继续按计划执行；Super-agent 会话的后台任务会继续运行；快速助手保持可用。' },
    });
  });

  it('with no condition, macOS quits and Windows / Linux let the close proceed', () => {
    expect(decideMainWindowClose(OFF, 'darwin', false)).toEqual({ kind: 'quit' });
    expect(decideMainWindowClose(OFF, 'win32', false)).toEqual({ kind: 'proceed' });
    expect(decideMainWindowClose(OFF, 'linux', false)).toEqual({ kind: 'proceed' });
  });

  it('never intercepts once the app is exiting', () => {
    for (const platform of PLATFORMS) {
      expect(decideMainWindowClose(state({ automation: true, superAgent: true, quickAssistant: true }), platform, true)).toEqual({ kind: 'proceed' });
      expect(decideMainWindowClose(OFF, platform, true)).toEqual({ kind: 'proceed' });
    }
  });

  it('the "never" notification policy hides without a notice; background and always still notify', () => {
    expect(decideMainWindowClose(state({ automation: true, notificationsDisabled: true }), 'win32', false)).toEqual({ kind: 'hide', notice: null });
  });
});

/** Host 命令替身：按命令与 key 回答，`Error` 表示命令失败。 */
function commands(answers: Record<string, unknown>): HostInvoke & { calls: string[] } {
  const calls: string[] = [];
  const invoke = async (cmd: string, args: unknown) => {
    const key = cmd === 'get_setting' ? `get_setting:${(args as { key: string }).key}` : cmd;
    calls.push(key);
    const answer = Object.hasOwn(answers, key) ? answers[key] : cmd === 'get_setting' ? null : new Error(`${cmd} not found`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return Object.assign(invoke, { calls });
}

const automations = (...enabled: boolean[]) => ({ count: enabled.length, max: 50, automations: enabled.map((value, index) => ({ id: `a${index}`, enabled: value })) });

describe('reading the conditions through existing Host commands (Rust semantics)', () => {
  it('quick assistant: only exactly "true" counts (lib.rs:1725-1730)', async () => {
    for (const [value, expected] of [['true', true], ['TRUE', false], [' true', false], ['1', false], [null, false]] as const) {
      expect((await residencyStateFromCommands(commands({ 'get_setting:quick_assistant.background_enabled': value }))).quickAssistant).toBe(expected);
    }
    expect((await residencyStateFromCommands(commands({ 'get_setting:quick_assistant.background_enabled': new Error('db') }))).quickAssistant).toBe(false);
  });

  it('Super-agent: Rust trim, then "true" or "1"; unreadable is off (state.rs:226-236,267-271)', async () => {
    const cases: Array<[string | null | Error, boolean]> = [
      ['true', true], ['1', true], [' true\n', true], ['\u0085true', true], ['\u3000' + '1', true],
      ['\uFEFFtrue', false], ['yes', false], ['True', false], [null, false], [new Error('db'), false],
    ];
    for (const [value, expected] of cases) {
      expect((await residencyStateFromCommands(commands({ 'get_setting:super_agent.enabled': value }))).superAgent, JSON.stringify(String(value))).toBe(expected);
    }
  });

  it('scheduled tasks: background switch defaults on (only "false" turns it off) and needs an enabled automation (automations.rs:4779-4792)', async () => {
    const run = async (background: string | null | Error, list: unknown) =>
      (await residencyStateFromCommands(commands({ 'get_setting:chat_v2.automation_background_enabled': background, chat_v2_automation_list: list }))).automation;
    expect(await run(null, automations(false, true))).toBe(true);
    expect(await run('true', automations(true))).toBe(true);
    expect(await run('anything', automations(true))).toBe(true);
    expect(await run(new Error('settings table missing'), automations(true))).toBe(true);
    expect(await run('false', automations(true))).toBe(false);
    expect(await run(null, automations(false, false))).toBe(false);
    expect(await run(null, automations())).toBe(false);
    // load_automations 失败（Host 的 loadAutomations 对任何一行解析失败都抛错）→ false。
    expect(await run(null, new Error('Failed to load automations'))).toBe(false);
    expect(await run(null, { unexpected: true })).toBe(false);
  });

  it('notification policy: only "never" disables; unknown, missing or unreadable falls back to background (system_notification.rs:28-45)', async () => {
    for (const [value, expected] of [['never', true], ['always', false], ['background', false], ['sometimes', false], [null, false], [new Error('db'), false]] as const) {
      expect((await residencyStateFromCommands(commands({ 'get_setting:system-notification-policy': value }))).notificationsDisabled).toBe(expected);
    }
  });

  it('uses the Host entry when it answers with the state, without reading settings', async () => {
    const answer = { automation: true, superAgent: false, quickAssistant: true, notificationsDisabled: true };
    const invoke = commands({ [RESIDENCY_HOST_CALL.command]: answer });
    const logs: string[] = [];
    expect(await queryResidencyState(invoke, (message) => logs.push(message))).toEqual(answer);
    expect(invoke.calls).toEqual([RESIDENCY_HOST_CALL.command]);
    expect(logs).toEqual([]);
  });

  it('falls back to the commands when the Host entry is missing or answers with another shape', async () => {
    const settings = {
      'get_setting:quick_assistant.background_enabled': 'true',
      chat_v2_automation_list: automations(true),
    };
    for (const entry of [new Error('service "agentAutomation" does not expose "backgroundResidency" to UI (declare it in meta.remote)'), true, { automation: 'yes' }]) {
      const invoke = commands({ ...settings, [RESIDENCY_HOST_CALL.command]: entry });
      const logs: string[] = [];
      expect(await queryResidencyState(invoke, (message) => logs.push(message))).toEqual({ automation: true, superAgent: false, quickAssistant: true, notificationsDisabled: false });
      expect(invoke.calls[0]).toBe(RESIDENCY_HOST_CALL.command);
      expect(logs).toHaveLength(1);
    }
  });
});

describe('the Host entry agentAutomation.backgroundResidency (W02 37847c93)', () => {
  const answer: BackgroundResidencyState = { automation: false, superAgent: true, quickAssistant: false, notificationsDisabled: true };
  /** 与 main.ts `invokeHostCommand` 相同：以 main 身份调用，Host 的错误值包成 Error。 */
  const asMain = (host: TestHost): HostInvoke => (cmd, args) =>
    host.invoke(cmd, args).catch((error: unknown) => {
      throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
    });
  /** 与 W02 的插件同 id、同 `meta.remote`，服务只回 {@link answer}。 */
  const stubOrchestration = (id: string) => definePlugin({
    meta: { id, lane: 'W23-fixture', provides: ['agentAutomation'], remote: { agentAutomation: ['backgroundResidency'] } },
    apply(ctx) {
      ctx.provide('agentAutomation', { backgroundResidency: () => answer, shouldKeepBackground: () => true });
    },
  });

  it('names the plugin that provides agentAutomation in the desktop profile as the caller', () => {
    const profile = JSON.parse(readFileSync(new URL('../../host/profiles/desktop.json', import.meta.url), 'utf8')) as { plugins: Array<{ id: string; module: string }> };
    expect(profile.plugins.find((entry) => entry.module === '../plugins/agent-orchestration/index.ts')?.id).toBe(RESIDENCY_HOST_CALL.caller);
  });

  it('sends { caller, service, method, args: [] } as main', async () => {
    const seen: unknown[] = [];
    const invoke: HostInvoke = async (cmd, args) => {
      seen.push([cmd, args]);
      return answer;
    };
    expect(await queryResidencyState(invoke, () => undefined)).toEqual(answer);
    expect(seen).toEqual([['plugin:host|call', { caller: 'dstu.agent-orchestration', service: 'agentAutomation', method: 'backgroundResidency', args: [] }]]);
  });

  it('gets the Host answer from the real kernel both while callerless calls are only warned about and once they are refused (SEC-E06)', async () => {
    for (const hostCallCaller of ['warn', 'require'] as const) {
      const host = await createTestHost({ contracts: { only: [] }, hostCallCaller, plugins: [stubOrchestration(RESIDENCY_HOST_CALL.caller)] });
      try {
        const logs: string[] = [];
        expect(await queryResidencyState(asMain(host), (message) => logs.push(message)), hostCallCaller).toEqual(answer);
        expect(logs, hostCallCaller).toEqual([]);
        expect(host.runtime.hostCallsWithoutCaller(), hostCallCaller).toEqual({});
        if (hostCallCaller === 'require') {
          // 不带 caller 的同一调用在 require 模式下被拒：上面的结果确实走的是带 caller 的路径。
          await expect(host.invoke('plugin:host|call', { service: 'agentAutomation', method: 'backgroundResidency', args: [] }))
            .rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('requires "caller"') });
        }
      } finally {
        await host.dispose();
      }
    }
  });

  it('gets the Host answer under the kernel default caller mode (W01 412c9fef makes the default require)', async () => {
    const host = await createTestHost({ contracts: { only: [] }, plugins: [stubOrchestration(RESIDENCY_HOST_CALL.caller)] });
    try {
      expect(host.runtime.hostCallCaller).toBe(DEFAULT_HOST_CALL_CALLER_MODE);
      const logs: string[] = [];
      expect(await queryResidencyState(asMain(host), (message) => logs.push(message))).toEqual(answer);
      expect(logs).toEqual([]);
      expect(host.runtime.hostCallsWithoutCaller()).toEqual({});
    } finally {
      await host.dispose();
    }
  });

  it('the residency query is the only plugin:host|call in the Electron main process sources (each one must carry caller, SEC-E06 K2)', () => {
    const root = new URL('../', import.meta.url);
    // Dot directories hold build output (electron/.gitignore: `.build/`), not sources.
    const sites = (readdirSync(root, { recursive: true }) as string[])
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => /\.[cm]?[jt]s$/.test(file) && !/(?:^|\/)(?:tests|__tests__|node_modules|\.[^/]+)\//.test(file))
      .filter((file) => /plugin:host\|call|HOST_CALL_COMMAND/.test(readFileSync(new URL(file, root), 'utf8')));
    expect(sites, 'a new plugin:host|call from main needs caller (the id of the Host plugin providing the service) and a test like the ones above').toEqual(['shell/background-residency.ts']);
  });

  it('falls back to the settings commands when another plugin provides agentAutomation (the kernel refuses a foreign caller)', async () => {
    const host = await createTestHost({ contracts: { only: [] }, hostCallCaller: 'require', plugins: [stubOrchestration('dstu.not-orchestration')] });
    try {
      const logs: string[] = [];
      expect(await queryResidencyState(asMain(host), (message) => logs.push(message))).toEqual(UNREADABLE_RESIDENCY_STATE);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('a UI half may only call its own Host half');
    } finally {
      await host.dispose();
    }
  });
});

describe('closing the main window', () => {
  it('each condition alone hides the window, keeps the process, and notifies once', async () => {
    for (const platform of PLATFORMS) {
      for (const patch of [{ automation: true }, { superAgent: true }, { quickAssistant: true }]) {
        const h = harness({ platform, query: async () => state(patch) });
        await closeMain(h);
        expect(h.main.browserWindow.destroyed).toBe(false);
        expect(h.main.browserWindow.visible).toBe(false);
        expect(h.quits).toEqual([]);
        expect(h.notices).toEqual([{ title: BACKGROUND_NOTICE_TITLE, body: expect.any(String), silent: false }]);
        expect(h.main.closeRequested).toBe(1);
      }
    }
  });

  it('with no condition, Windows and Linux really close the window; close-requested is sent once', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      const h = harness({ platform });
      await closeMain(h);
      expect(h.main.browserWindow.destroyed).toBe(true);
      expect(h.main.closeRequested).toBe(1);
      expect(h.notices).toEqual([]);
      expect(h.quits).toEqual([]);
    }
  });

  it('with no condition, macOS marks the app as exiting and quits', async () => {
    const h = harness({ platform: 'darwin' });
    await closeMain(h);
    expect(h.quits).toEqual([1]);
    expect(h.residency.exiting).toBe(true);
    expect(h.main.browserWindow.visible).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it('an explicit exit (before-quit) is never intercepted, and the Host is not asked', async () => {
    for (const platform of PLATFORMS) {
      const h = harness({ platform, query: async () => state({ automation: true }) });
      h.app.emit('before-quit');
      h.main.browserWindow.close();
      expect(h.main.browserWindow.destroyed).toBe(true);
      expect(h.queries).toEqual([]);
      expect(h.notices).toEqual([]);
    }
  });

  it('system shutdown is never intercepted: powerMonitor "shutdown" (Linux / macOS) and the window\'s "session-end" (Windows)', async () => {
    const linux = harness({ platform: 'linux', query: async () => state({ superAgent: true }) });
    linux.power.emit('shutdown');
    linux.main.browserWindow.close();
    expect(linux.main.browserWindow.destroyed).toBe(true);

    const windows = harness({ platform: 'win32', query: async () => state({ superAgent: true }) });
    windows.main.browserWindow.emit('session-end');
    windows.main.browserWindow.close();
    expect(windows.main.browserWindow.destroyed).toBe(true);
    expect(windows.queries).toEqual([]);
  });

  it('a pending decision is dropped when the app starts exiting', async () => {
    const answer = deferred<BackgroundResidencyState>();
    const h = harness({ platform: 'linux', query: () => answer.promise });
    h.main.browserWindow.close();
    h.app.emit('before-quit');
    answer.resolve(state({ automation: true }));
    await h.residency.whenSettled();
    expect(h.notices).toEqual([]);
    expect(h.main.browserWindow.calls).toEqual(['close', 'hide']);
  });

  it('the "never" policy hides without a notice', async () => {
    const h = harness({ platform: 'win32', query: async () => state({ quickAssistant: true, notificationsDisabled: true }) });
    await closeMain(h);
    expect(h.main.browserWindow.visible).toBe(false);
    expect(h.main.browserWindow.destroyed).toBe(false);
    expect(h.notices).toEqual([]);
  });

  it('notifies once per close that goes to the background, again after the window is brought back (Rust has no first-time-only rule)', async () => {
    const h = harness({ platform: 'linux', query: async () => state({ automation: true, quickAssistant: true }) });
    await closeMain(h);
    h.residency.showFromSecondInstance();
    expect(h.main.browserWindow.visible).toBe(true);
    await closeMain(h);
    expect(h.notices.map((notice) => notice.body)).toEqual([
      '已启用的定时任务会继续按计划执行；快速助手保持可用。',
      '已启用的定时任务会继续按计划执行；快速助手保持可用。',
    ]);
    // 每次关窗请求页面都收到一次 tauri://close-requested（Tauri 每次 CloseRequested 都发射）。
    expect(h.main.closeRequested).toBe(2);
  });

  it('two close requests before the Host answers apply one decision and one notice', async () => {
    const answers = [deferred<BackgroundResidencyState>(), deferred<BackgroundResidencyState>()];
    let next = 0;
    const h = harness({ platform: 'win32', query: () => answers[next++]!.promise });
    h.main.browserWindow.close();
    h.main.browserWindow.close();
    answers[0]!.resolve(state({ superAgent: true }));
    answers[1]!.resolve(state({ superAgent: true }));
    await h.residency.whenSettled();
    await Promise.resolve();
    expect(h.notices).toHaveLength(1);
    expect(h.main.browserWindow.destroyed).toBe(false);
  });

  it('bringing the window back while the Host is still deciding keeps it open', async () => {
    const answer = deferred<BackgroundResidencyState>();
    const h = harness({ platform: 'linux', query: () => answer.promise });
    h.main.browserWindow.close();
    expect(h.main.browserWindow.visible).toBe(false);
    h.residency.showFromSecondInstance();
    answer.resolve(OFF);
    await h.residency.whenSettled();
    expect(h.main.browserWindow.destroyed).toBe(false);
    expect(h.main.browserWindow.visible).toBe(true);
    // 恢复为可拦截：下一次关窗照常询问并发 close-requested。
    await closeMain(h);
    expect(h.main.closeRequested).toBe(2);
    expect(h.main.browserWindow.destroyed).toBe(true);
  });

  it('a Host that does not answer in time counts as unreadable (all conditions off)', async () => {
    vi.useFakeTimers();
    const linux = harness({ platform: 'linux', query: () => new Promise(() => undefined), timeoutMs: 5000 });
    linux.main.browserWindow.close();
    await vi.advanceTimersByTimeAsync(4999);
    expect(linux.main.browserWindow.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await linux.residency.whenSettled();
    expect(linux.main.browserWindow.destroyed).toBe(true);
    expect(linux.logs.join('\n')).toContain('no answer within 5000 ms');

    const mac = harness({ platform: 'darwin', query: () => Promise.reject(new Error('Host unavailable')) });
    await closeMain(mac);
    expect(mac.quits).toEqual([1]);
  });

  it('RF-W23-residency-host-unavailable-closes: with the Host down the close falls back to the settings reads, logs the warning, and closes like Rust does when every read fails', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const calls: string[] = [];
      const down: HostInvoke = async (cmd, args) => {
        calls.push(cmd === 'get_setting' ? `get_setting:${(args as { key: string }).key}` : cmd);
        throw new Error('Host process is not running');
      };
      const queryLogs: string[] = [];
      const h = harness({ platform, query: () => queryResidencyState(down, (message) => queryLogs.push(message)) });
      await closeMain(h);
      expect(calls[0]).toBe(RESIDENCY_HOST_CALL.command);
      expect(calls.slice(1).sort()).toEqual([
        'chat_v2_automation_list',
        `get_setting:${AUTOMATION_BACKGROUND_KEY}`,
        `get_setting:${QUICK_ASSISTANT_BACKGROUND_KEY}`,
        `get_setting:${SUPER_AGENT_ENABLED_KEY}`,
        `get_setting:${SYSTEM_NOTIFICATION_POLICY_KEY}`,
      ].sort());
      expect(queryLogs).toEqual([
        '[residency] agentAutomation.backgroundResidency unavailable (Host process is not running); reading the settings through get_setting / chat_v2_automation_list',
      ]);
      expect(h.notices).toEqual([]);
      if (platform === 'darwin') {
        expect(h.quits).toEqual([1]);
      } else {
        expect(h.main.browserWindow.destroyed).toBe(true);
        expect(h.quits).toEqual([]);
      }
    }
  });

  it('when the page itself listens for close-requested, the page decides unless the app stays in the background', async () => {
    const off = harness({ platform: 'linux', pageListens: true });
    await closeMain(off);
    expect(off.main.browserWindow.visible).toBe(true);
    expect(off.main.browserWindow.destroyed).toBe(false);
    expect(off.main.browserWindow.calls).toEqual(['close']);

    const keep = harness({ platform: 'win32', pageListens: true, query: async () => state({ automation: true }) });
    await closeMain(keep);
    expect(keep.main.browserWindow.visible).toBe(false);
    expect(keep.notices).toHaveLength(1);
  });

  it('a notification that cannot be shown does not undo the residency', async () => {
    for (const notification of [
      { isSupported: () => false, show: () => { throw new Error('unreachable'); } },
      { isSupported: () => true, show: () => { throw new Error('no notification daemon'); } },
    ]) {
      const h = harness({ platform: 'linux', notification, query: async () => state({ automation: true }) });
      await closeMain(h);
      expect(h.main.browserWindow.visible).toBe(false);
      expect(h.main.browserWindow.destroyed).toBe(false);
    }
  });
});

const otherWindow = (shown: 'visible' | 'minimized' | 'hidden' | 'destroyed') => ({
  isDestroyed: () => shown === 'destroyed',
  isVisible: () => shown === 'visible',
  isMinimized: () => shown === 'minimized',
});

describe('RF-W23-close-main-quits-with-only-hidden-windows', () => {
  it('RF-W23-close-main-quits-with-only-hidden-windows: on Windows / Linux, closing the main window with no background condition quits when only hidden windows remain', async () => {
    // Rust 在这里不退出：曾呼出过的快速助手小窗只是 hide（quick_assistant.rs:196-226），进程无窗口残留，
    // 全局快捷键和自动化调度器继续运行，再次启动时 single-instance 回调找不到 main（lib.rs:695-701），应用看起来打不开。
    for (const platform of ['win32', 'linux'] as const) {
      for (const others of [[otherWindow('hidden')], [otherWindow('hidden'), otherWindow('destroyed')], []]) {
        const h = harness({ platform, otherWindows: others });
        await closeMain(h);
        expect(h.main.browserWindow.destroyed).toBe(true);
        expect(h.quits).toEqual([1]);
        expect(h.residency.exiting).toBe(true);
      }
    }
  });

  it('RF-W23-close-main-quits-with-only-hidden-windows: a window the user still sees (visible or minimized) keeps the process, as in Rust', async () => {
    for (const platform of ['win32', 'linux'] as const) {
      for (const shown of ['visible', 'minimized'] as const) {
        const h = harness({ platform, otherWindows: [otherWindow('hidden'), otherWindow(shown)] });
        await closeMain(h);
        expect(h.main.browserWindow.destroyed).toBe(true);
        expect(h.quits).toEqual([]);
        expect(h.residency.exiting).toBe(false);
      }
    }
  });

  it('RF-W23-close-main-quits-with-only-hidden-windows: residency, a page that owns the close, explicit exit and macOS are unchanged', async () => {
    const keep = harness({ platform: 'linux', otherWindows: [], query: async () => state({ automation: true }) });
    await closeMain(keep);
    expect(keep.quits).toEqual([]);

    const page = harness({ platform: 'win32', otherWindows: [], pageListens: true });
    await closeMain(page);
    page.main.browserWindow.destroyed = true;
    page.main.browserWindow.emit('closed');
    expect(page.quits).toEqual([]);

    const exiting = harness({ platform: 'linux', otherWindows: [] });
    exiting.app.emit('before-quit');
    await closeMain(exiting);
    expect(exiting.quits).toEqual([]);

    const mac = harness({ platform: 'darwin', otherWindows: [otherWindow('visible')] });
    await closeMain(mac);
    expect(mac.quits).toEqual([1]);
  });
});

describe('bringing the main window back', () => {
  it('a second instance shows, unminimizes and focuses it (lib.rs:695-701)', async () => {
    const h = harness({ platform: 'win32', query: async () => state({ automation: true }) });
    await closeMain(h);
    h.main.browserWindow.minimized = true;
    h.main.browserWindow.calls.length = 0;
    h.residency.showFromSecondInstance();
    expect(h.main.browserWindow.calls).toEqual(['show', 'restore', 'focus']);
  });

  it('macOS Reopen (activate) shows, focuses and activates the app (lib.rs:3270-3285); other platforms do not listen', async () => {
    const mac = harness({ platform: 'darwin', query: async () => state({ quickAssistant: true }) });
    await closeMain(mac);
    mac.main.browserWindow.calls.length = 0;
    mac.app.emit('activate');
    expect(mac.main.browserWindow.calls).toEqual(['show', 'focus']);
    expect(mac.app.focusCalls).toEqual([{ steal: true }]);
    expect(harness({ platform: 'linux' }).app.has('activate')).toBe(false);
    expect(harness({ platform: 'win32' }).app.has('activate')).toBe(false);
  });

  it('does nothing once the main window is gone', async () => {
    const h = harness({ platform: 'linux' });
    await closeMain(h);
    h.main.browserWindow.calls.length = 0;
    h.residency.showFromSecondInstance();
    expect(h.main.browserWindow.calls).toEqual([]);
  });
});
