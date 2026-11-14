/**
 * `systemNotification` 服务：把 Rust `dstu_agent::system_notification` + Tauri notification 的
 * Host 可调用面发布给业务插件。策略键/默认档与 Rust 一致；投递结果显式区分
 * `policy` / `window-active` 抑制与原生 `show()` 失败，调用方不得在失败时写送达回执。
 */
import {
  SYSTEM_NOTIFICATION_POLICY_KEY,
  type SystemNotificationOutcome,
  type SystemNotificationPolicy,
  type SystemNotificationRequest,
  type SystemNotificationService,
} from './api.ts';

export interface SettingsReader {
  get(key: string): string | null;
}

export interface SystemNotificationDeps {
  /** 读取 F4 `ctx.settings`；缺失/抛错按默认档，与 Rust `current_policy` 一致。 */
  settings(): SettingsReader | null;
  /** Rust `main_window_is_active`：focused && visible && !minimized。 */
  mainWindowActive(): Promise<boolean>;
  /** 原生投递（main 的 `plugin:notification|notify`）；reject 表示未送达。 */
  show(options: {
    id?: number;
    title: string;
    body: string;
    silent?: boolean;
    icon?: string;
  }): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeSystemNotificationPolicy(raw: string | null | undefined): SystemNotificationPolicy {
  return raw === 'always' ? 'always' : raw === 'never' ? 'never' : 'background';
}

export function createSystemNotificationService(deps: SystemNotificationDeps): SystemNotificationService {
  const policy = (): SystemNotificationPolicy => {
    let raw: string | null = null;
    try {
      raw = deps.settings()?.get(SYSTEM_NOTIFICATION_POLICY_KEY) ?? null;
    } catch {
      raw = null;
    }
    return normalizeSystemNotificationPolicy(raw);
  };

  return {
    policy,
    notificationsDisabled: () => policy() === 'never',
    async notify(request: SystemNotificationRequest): Promise<SystemNotificationOutcome> {
      if (policy() === 'never') return { delivered: false, suppressed: 'policy', error: null };
      if (request.suppressIfWindowActive === true) {
        let active: boolean;
        try {
          active = await deps.mainWindowActive();
        } catch (error) {
          return {
            delivered: false,
            suppressed: null,
            error: `failed to query main window activity: ${message(error)}`,
          };
        }
        if (active) return { delivered: false, suppressed: 'window-active', error: null };
      }
      try {
        await deps.show({
          ...(request.id === undefined ? {} : { id: request.id }),
          title: request.title,
          body: request.body,
          ...(request.silent === true ? { silent: true } : {}),
          ...(request.icon === undefined ? {} : { icon: request.icon }),
        });
        return { delivered: true, suppressed: null, error: null };
      } catch (error) {
        return { delivered: false, suppressed: null, error: message(error) };
      }
    },
  };
}
