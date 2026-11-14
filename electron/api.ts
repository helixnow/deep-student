/** F2 Host-facing contracts. Durations are milliseconds (Rust Duration). */
export const STARTUP_READY_WAIT = 120_000;

/** 与 Rust `dstu_agent::system_notification::POLICY_SETTING_KEY` / 前端 localStorage 共用的设置键。 */
export const SYSTEM_NOTIFICATION_POLICY_KEY = 'system-notification-policy';

/** Rust `SystemNotificationPolicy`；缺失/非法值按 `background`（与 Rust/前端一致）。 */
export type SystemNotificationPolicy = 'background' | 'always' | 'never';

export interface SystemNotificationRequest {
  /** Rust `NotificationBuilder::id(i32)`；自动化用 run_id 的 32 位哈希做系统级去重。 */
  id?: number;
  title: string;
  body: string;
  silent?: boolean;
  icon?: string;
  /**
   * Rust `deliver_run_notification(suppress_if_window_active=true)`：主窗口可见且聚焦时抑制
   * OS 通知，由前端 in-app toast 兜底。`notify` 类到点提醒应传 false/省略。
   */
  suppressIfWindowActive?: boolean;
}

export type SystemNotificationOutcome =
  | { delivered: true; suppressed: null; error: null }
  | { delivered: false; suppressed: 'policy' | 'window-active'; error: null }
  | { delivered: false; suppressed: null; error: string };

/**
 * 自动化/业务 lane 可调用的 OS 通知服务（Rust `dstu_agent::system_notification` +
 * `app.notification().show()` 的 Host 侧等价面）。
 *
 * 策略与回执边界：服务只读取策略并投递；`notification` 回执、`notification_pending` 重试
 * 由 L06 的自动化仓储负责。只有 `delivered:true` 才能写回执。
 */
export interface SystemNotificationService {
  policy(): SystemNotificationPolicy;
  notificationsDisabled(): boolean;
  notify(request: SystemNotificationRequest): Promise<SystemNotificationOutcome>;
}

export interface StartupGate {
  markStartupReady(): void;
  isStartupReady(): boolean;
  waitStartupReady(timeout: number): Promise<boolean>;
  guard(): Disposable;
}

/** Additive wire extension; F1 must expose this on CallContext for raw-body handlers. */
declare module '../host/kernel/protocol.ts' {
  interface InvokeRequest {
    headers?: Record<string, string>;
  }
}

export interface ShellWindowSnapshot {
  label: string;
  isMain: boolean;
  focused: boolean;
}

export interface ShellWindowsService {
  /** Current live application webview windows, including those opened before this plugin started.
   * Like Manager::webview_windows(), ordering is not a semantic guarantee. */
  listWindows(): Promise<ShellWindowSnapshot[]>;
  /** The live window labelled `main`, or null. Does not pick a fallback window. */
  getMainWindow(): Promise<ShellWindowSnapshot | null>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    startupGate: StartupGate;
    systemNotification: SystemNotificationService;
    shellWindows: ShellWindowsService;
  }
}
