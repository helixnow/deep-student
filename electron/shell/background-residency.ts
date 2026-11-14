/**
 * 关闭主窗口后的后台驻留，对应 Rust：
 * - `src-tauri/src/lib.rs:1714-1783`：主窗口 `CloseRequested` 时，有已启用的定时任务、Super 会话或快速助手后台常驻
 *   任一条件成立，就 `prevent_close` + `hide`，并在通知策略不是 never 时弹「Deep Student 正在后台运行」；
 *   都不成立时，macOS 标记退出后 `app.exit(0)`，Windows / Linux 照常关闭（最后一个窗口关闭即退出）。
 * - `lib.rs:3249-3252`：`ExitRequested`（显式退出）先 `mark_automation_app_exiting()`，此后关窗不再拦截。
 * - `lib.rs:3270-3285`：macOS `Reopen`（点 Dock 图标等）`show` + `set_focus` + 激活应用。
 * - `lib.rs:695-701`：第二实例启动时 `show` + `unminimize` + `set_focus` 主窗口。
 * Rust 没有托盘图标；全局快捷键只切换快速助手小窗，不唤回主窗口（`quick_assistant::toggle`）。
 *
 * 条件由 Host 判定（{@link queryResidencyState}）。关窗时先把窗口藏起来再异步询问：三种结果（驻留、关闭、退出）
 * 在用户看来都是窗口立即消失，Host 慢或不可用时也不会卡住关闭。
 */
import { rustTrim } from '../../host/platform/util/text.ts';
import { SYSTEM_NOTIFICATION_POLICY_KEY } from '../api.ts';
import { electronNotificationHooks, type NotificationHooks } from './plugins/system.ts';
import type { ShellPlatform } from './tauri-config.ts';

/** `quick_assistant.background_enabled`（`lib.rs:1725-1730`，只有 `"true"` 才算开启）。 */
export const QUICK_ASSISTANT_BACKGROUND_KEY = 'quick_assistant.background_enabled';
/** `AUTOMATION_BACKGROUND_KEY`（`automations.rs:43`，缺省开启，只有 `"false"` 才关闭）。 */
export const AUTOMATION_BACKGROUND_KEY = 'chat_v2.automation_background_enabled';
/** `super_session::state::SETTING_ENABLED`（`state.rs:36`，trim 后为 `"true"` 或 `"1"`）。 */
export const SUPER_AGENT_ENABLED_KEY = 'super_agent.enabled';

export const BACKGROUND_NOTICE_TITLE = 'Deep Student 正在后台运行';
/** `lib.rs:1751-1760`：按定时任务、Super 会话、快速助手的顺序以「；」连接，末尾加「。」。 */
export const BACKGROUND_NOTICE_REASONS = {
  automation: '已启用的定时任务会继续按计划执行',
  superAgent: 'Super-agent 会话的后台任务会继续运行',
  quickAssistant: '快速助手保持可用',
} as const;

/**
 * Host 判定的驻留条件与通知策略（交接 W02 的 Host 入口返回同一形状）：
 * - `automation`：`should_keep_automation_background`（`automations.rs:4779-4792`）；
 * - `superAgent`：`super_session::is_enabled`（`state.rs:226-236,267-271`）；
 * - `quickAssistant`：`quick_assistant.background_enabled == "true"`；
 * - `notificationsDisabled`：`system_notification::notifications_disabled`（策略为 `never`）。
 */
export interface BackgroundResidencyState {
  automation: boolean;
  superAgent: boolean;
  quickAssistant: boolean;
  notificationsDisabled: boolean;
}

/** 读不到时的取值，与 Rust 各项读取失败的缺省一致：三个条件都不成立，策略按缺省档 background。 */
export const UNREADABLE_RESIDENCY_STATE: Readonly<BackgroundResidencyState> = Object.freeze({
  automation: false,
  superAgent: false,
  quickAssistant: false,
  notificationsDisabled: false,
});

export interface BackgroundNotice {
  title: string;
  body: string;
}

export type MainCloseDecision =
  /** 不拦截，关闭照常进行（Rust 两个分支都不进入）。 */
  | { kind: 'proceed' }
  /** `prevent_close` + `hide`；`notice` 为 null 时不弹通知。 */
  | { kind: 'hide'; notice: BackgroundNotice | null }
  /** macOS：`mark_automation_app_exiting()` + `app.exit(0)`。 */
  | { kind: 'quit' };

export function keepsBackground(state: BackgroundResidencyState): boolean {
  return state.automation || state.superAgent || state.quickAssistant;
}

/** 驻留时弹的通知；不驻留或策略为 never 时为 null。 */
export function backgroundNotice(state: BackgroundResidencyState): BackgroundNotice | null {
  if (!keepsBackground(state) || state.notificationsDisabled) return null;
  const reasons: string[] = [];
  if (state.automation) reasons.push(BACKGROUND_NOTICE_REASONS.automation);
  if (state.superAgent) reasons.push(BACKGROUND_NOTICE_REASONS.superAgent);
  if (state.quickAssistant) reasons.push(BACKGROUND_NOTICE_REASONS.quickAssistant);
  return { title: BACKGROUND_NOTICE_TITLE, body: `${reasons.join('；')}。` };
}

/** `lib.rs:1739-1780` 的分支。`exiting` 为 `automation_app_is_exiting()`。 */
export function decideMainWindowClose(state: BackgroundResidencyState, platform: ShellPlatform, exiting: boolean): MainCloseDecision {
  if (exiting) return { kind: 'proceed' };
  if (keepsBackground(state)) return { kind: 'hide', notice: backgroundNotice(state) };
  return platform === 'darwin' ? { kind: 'quit' } : { kind: 'proceed' };
}

// ------------------------------------------------------------ Host 查询

/** main 以 `main` 窗口身份调用 Host 命令：成功给出返回值，失败 reject。 */
export type HostInvoke = (cmd: string, args: unknown) => Promise<unknown>;

/**
 * Host 入口（W02 `host/plugins/agent-orchestration`）：`plugin:host|call` 调用 `agentAutomation.backgroundResidency()`，返回
 * {@link BackgroundResidencyState}，方法在插件 `meta.remote.agentAutomation` 中声明。Host 还没有这个方法
 * （或返回形状不对）时改用 {@link residencyStateFromCommands}。
 */
export const RESIDENCY_HOST_CALL = {
  command: 'plugin:host|call',
  /**
   * 提供 `agentAutomation` 的插件 id（`host/profiles/desktop.json`）。内核只放行调用方自己提供的服务，
   * `require` 模式下不带 `caller` 的调用直接拒绝（SEC-E06，`host/kernel/runtime.ts` `hostCall`）。
   */
  caller: 'dstu.agent-orchestration',
  service: 'agentAutomation',
  method: 'backgroundResidency',
} as const;

/** 关窗时等 Host 回答的上限。超时按 {@link UNREADABLE_RESIDENCY_STATE} 处理（窗口此时已经藏起来）。 */
export const RESIDENCY_QUERY_TIMEOUT_MS = 5000;

export function parseResidencyState(value: unknown): BackgroundResidencyState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const { automation, superAgent, quickAssistant, notificationsDisabled } = v;
  if (typeof automation !== 'boolean' || typeof superAgent !== 'boolean' || typeof quickAssistant !== 'boolean'
    || typeof notificationsDisabled !== 'boolean') return null;
  return { automation, superAgent, quickAssistant, notificationsDisabled };
}

async function readSetting(invoke: HostInvoke, key: string): Promise<{ ok: true; value: string | null } | { ok: false }> {
  try {
    const value = await invoke('get_setting', { key });
    return { ok: true, value: typeof value === 'string' ? value : null };
  } catch {
    return { ok: false };
  }
}

async function anyEnabledAutomation(invoke: HostInvoke): Promise<boolean> {
  try {
    const list = await invoke('chat_v2_automation_list', {});
    const automations = (list as { automations?: unknown } | null)?.automations;
    // load_automations 失败（含任何一行解析失败）→ false（`automations.rs:4789-4791`）。
    if (!Array.isArray(automations)) return false;
    return automations.some((item) => (item as { enabled?: unknown } | null)?.enabled === true);
  } catch {
    return false;
  }
}

/**
 * 降级判定：用前端也在调用的 `get_setting` 与 `chat_v2_automation_list`，逐项按 Rust 的口径与读取失败缺省：
 * 快速助手、Super 读取失败为 false；`automation_background_enabled` 读取失败为 true，自动化列表读取失败为 false；
 * 策略读取失败按 background（不拦截通知）。
 */
export async function residencyStateFromCommands(invoke: HostInvoke): Promise<BackgroundResidencyState> {
  const [quick, superAgent, background, policy, anyEnabled] = await Promise.all([
    readSetting(invoke, QUICK_ASSISTANT_BACKGROUND_KEY),
    readSetting(invoke, SUPER_AGENT_ENABLED_KEY),
    readSetting(invoke, AUTOMATION_BACKGROUND_KEY),
    readSetting(invoke, SYSTEM_NOTIFICATION_POLICY_KEY),
    anyEnabledAutomation(invoke),
  ]);
  const superValue = superAgent.ok && superAgent.value !== null ? rustTrim(superAgent.value) : null;
  const backgroundEnabled = background.ok ? background.value !== 'false' : true;
  return {
    automation: backgroundEnabled && anyEnabled,
    superAgent: superValue === 'true' || superValue === '1',
    quickAssistant: quick.ok && quick.value === 'true',
    notificationsDisabled: policy.ok && policy.value === 'never',
  };
}

/** 先问 Host 入口（{@link RESIDENCY_HOST_CALL}），没有可用回答时用 {@link residencyStateFromCommands}。 */
export async function queryResidencyState(invoke: HostInvoke, log: (message: string) => void): Promise<BackgroundResidencyState> {
  let reason: string;
  try {
    const value = await invoke(RESIDENCY_HOST_CALL.command, {
      caller: RESIDENCY_HOST_CALL.caller,
      service: RESIDENCY_HOST_CALL.service,
      method: RESIDENCY_HOST_CALL.method,
      args: [],
    });
    const state = parseResidencyState(value);
    if (state !== null) return state;
    reason = `unexpected result ${JSON.stringify(value) ?? String(value)}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  // RUST-FIX(RF-W23-residency-host-unavailable-closes): Rust 在进程内读设置，没有“Host 不可用”；这里 Host 不可用时各项按读取失败的缺省（全不成立）。
  log(`[residency] ${RESIDENCY_HOST_CALL.service}.${RESIDENCY_HOST_CALL.method} unavailable (${reason}); reading the settings through get_setting / chat_v2_automation_list`);
  return residencyStateFromCommands(invoke);
}

// ------------------------------------------------------------ 关窗控制

/** 主窗口上用到的 BrowserWindow 方法与事件（Electron `BrowserWindow` 满足）。 */
export interface ResidencyBrowserWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  show(): void;
  hide(): void;
  restore(): void;
  focus(): void;
  close(): void;
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: 'closed' | 'session-end', listener: () => void): unknown;
}

/**
 * `windows.ts` 的 `ShellWindow`。`destroying` 由 WindowManager 维护：它自己的 `close` 监听先运行，没有页面拦截时
 * 置为 true（之后的 close 不再发 `tauri://close-requested`）；有页面监听 `close-requested` 时保持 false。
 */
export interface ResidencyMainWindow {
  readonly browserWindow: ResidencyBrowserWindow;
  destroying: boolean;
}

export interface ResidencyApp {
  on(event: 'before-quit' | 'activate', listener: () => void): unknown;
  focus(options?: { steal: boolean }): void;
}

export interface ResidencyPowerMonitor {
  on(event: 'shutdown', listener: () => void): unknown;
}

/** 用户还看得到的窗口数（可见或最小化）；main 传 `BrowserWindow.getAllWindows()`。 */
export function countShownWindows(windows: Iterable<{ isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean }>): number {
  let count = 0;
  for (const win of windows) if (!win.isDestroyed() && (win.isVisible() || win.isMinimized())) count++;
  return count;
}

export interface BackgroundResidencyOptions {
  platform: ShellPlatform;
  /** 通常是 `() => queryResidencyState(invoke, log)`。 */
  queryState(): Promise<BackgroundResidencyState>;
  /** macOS 不驻留时的退出（main 的有序退出 `shutdown.quit(0)`）。 */
  quit(): void;
  log(message: string): void;
  /**
   * 主窗口关闭后其余窗口里用户还看得到的个数（通常是 `() => countShownWindows(BrowserWindow.getAllWindows())`）。
   * 不提供时不做这项检查。
   */
  shownWindowCount?(): number;
  /** 缺省为 Electron Notification（与 `plugin:notification|notify` 相同的投递面）。 */
  notification?: NotificationHooks;
  queryTimeoutMs?: number;
}

export class BackgroundResidency {
  private readonly options: BackgroundResidencyOptions;
  private readonly notification: NotificationHooks;
  private app: ResidencyApp | null = null;
  private main: ResidencyMainWindow | null = null;
  private exitingFlag = false;
  /** 每次关窗请求、唤回与退出都加一；只有最新一次关窗请求的判定会被执行。 */
  private generation = 0;
  /** 放行关闭后再次调用 `close()` 期间为 true，此时不再拦截。 */
  private releasing = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: BackgroundResidencyOptions) {
    this.options = options;
    this.notification = options.notification ?? electronNotificationHooks;
  }

  /** `automation_app_is_exiting()`。 */
  get exiting(): boolean {
    return this.exitingFlag;
  }

  /**
   * 显式退出：`before-quit`（菜单退出、Cmd+Q、`app.quit()`、macOS 注销与关机）、Windows `session-end`、
   * Linux / macOS `powerMonitor` 的 `shutdown`，以及 main 的有序退出（`process` 插件 exit / restart）。之后关窗不拦截。
   */
  markExiting(): void {
    this.exitingFlag = true;
    this.generation++;
  }

  /** app 级事件。必须在 `app.whenReady()` 之后调用（`powerMonitor` 的要求）。 */
  install(app: ResidencyApp, powerMonitor?: ResidencyPowerMonitor): void {
    this.app = app;
    app.on('before-quit', () => this.markExiting());
    if (this.options.platform === 'darwin') app.on('activate', () => this.showFromReopen());
    powerMonitor?.on('shutdown', () => this.markExiting());
  }

  /** 主窗口创建后调用，且必须在 WindowManager 注册它自己的 `close` 监听之后（`afterCreate` 满足）。 */
  attachMainWindow(main: ResidencyMainWindow): void {
    this.main = main;
    this.releasing = false;
    const win = main.browserWindow;
    win.on('close', (event) => this.onCloseRequested(main, event));
    if (this.options.platform === 'win32') win.on('session-end', () => this.markExiting());
    win.on('closed', () => {
      if (this.main === main) this.main = null;
      // RUST-FIX(RF-W23-close-main-quits-with-only-hidden-windows): Rust 在 Windows / Linux 上靠“最后一个窗口关闭即退出”，曾呼出过的快速助手小窗只是隐藏，进程会无窗口残留且再次启动没有反应。
      const shown = this.options.shownWindowCount;
      if (this.releasing && !this.exitingFlag && this.options.platform !== 'darwin' && shown !== undefined && shown() === 0) {
        this.markExiting();
        this.options.quit();
      }
    });
  }

  /** 第二实例启动（`lib.rs:695-701`）：show、取消最小化、聚焦。 */
  showFromSecondInstance(): void {
    const win = this.cancelPendingClose();
    if (win === null) return;
    win.show();
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /** macOS Reopen（`lib.rs:3270-3285`）：show、聚焦，并像 `activateIgnoringOtherApps(YES)` 那样激活应用。 */
  showFromReopen(): void {
    const win = this.cancelPendingClose();
    if (win === null) return;
    win.show();
    win.focus();
    this.app?.focus({ steal: true });
  }

  /** 最近一次关窗判定执行完（测试用）。 */
  whenSettled(): Promise<void> {
    return this.pending;
  }

  private liveMain(): ResidencyMainWindow | null {
    const main = this.main;
    return main !== null && !main.browserWindow.isDestroyed() ? main : null;
  }

  private cancelPendingClose(): ResidencyBrowserWindow | null {
    this.generation++;
    const main = this.liveMain();
    if (main === null) return null;
    if (this.releasing) {
      // 放行的关闭没有完成（例如被页面的 beforeunload 取消），窗口仍在：恢复为可拦截的状态。
      this.releasing = false;
      main.destroying = false;
    }
    return main.browserWindow;
  }

  private onCloseRequested(main: ResidencyMainWindow, event: { preventDefault(): void }): void {
    if (this.exitingFlag || this.releasing) return;
    const win = main.browserWindow;
    // 有页面监听 close-requested 时由页面决定是否 destroy（Tauri 对有 JS 监听的窗口同样先阻止关闭）。
    const pageOwnsClose = !main.destroying;
    event.preventDefault();
    main.destroying = false;
    if (!pageOwnsClose) win.hide();
    const generation = ++this.generation;
    this.pending = this.decide().then((decision) => {
      if (generation !== this.generation || win.isDestroyed()) return;
      this.apply(main, decision, pageOwnsClose);
    }, (error: unknown) => {
      this.options.log(`[residency] close decision failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async decide(): Promise<MainCloseDecision> {
    const timeoutMs = this.options.queryTimeoutMs ?? RESIDENCY_QUERY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    });
    let state: BackgroundResidencyState;
    try {
      state = await Promise.race([this.options.queryState(), timeout]);
    } catch (error) {
      this.options.log(`[residency] background conditions unreadable, treating them as off: ${error instanceof Error ? error.message : String(error)}`);
      state = UNREADABLE_RESIDENCY_STATE;
    } finally {
      clearTimeout(timer);
    }
    return decideMainWindowClose(state, this.options.platform, this.exitingFlag);
  }

  private apply(main: ResidencyMainWindow, decision: MainCloseDecision, pageOwnsClose: boolean): void {
    const win = main.browserWindow;
    switch (decision.kind) {
      case 'hide':
        win.hide();
        if (decision.notice !== null) this.showNotice(decision.notice);
        return;
      case 'quit':
        this.markExiting();
        win.hide();
        this.options.quit();
        return;
      case 'proceed':
        if (pageOwnsClose) return;
        this.releasing = true;
        main.destroying = true;
        win.close();
    }
  }

  private showNotice(notice: BackgroundNotice): void {
    // Rust `let _ = ….show()`：投递失败不影响驻留。
    try {
      if (!this.notification.isSupported()) return;
      this.notification.show({ title: notice.title, body: notice.body, silent: false });
    } catch (error) {
      this.options.log(`[residency] background notice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
