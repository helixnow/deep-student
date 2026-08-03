/**
 * 统一系统通知管线（8.1）
 *
 * 所有系统级通知（番茄钟、todo 提醒、制卡完成、同步、索引等）统一经此发送，
 * 受全局三档策略控制（默认仅后台时通知）：
 * - background：仅当应用在后台/失焦时发系统通知（默认；前台时由应用内 UI 承担反馈）
 * - always：总是发系统通知
 * - never：从不发系统通知
 *
 * 策略持久化为双写：localStorage 是同步快取（同源多窗口共享），同时写入后端
 * settings 表（同一键）。Rust 侧的通知发送方（自动化运行通知、紧急停止、
 * 后台驻留提示）读取 settings 表里的同一键，保证「从不」档全局生效；
 * 启动时经 syncSystemNotificationPolicyFromBackend 对齐两份存储
 * （备份恢复/云同步改动 settings 表后本地快取随之生效）。
 *
 * 非 Tauri 环境 / 权限缺失时静默退化。
 */

import { getSetting, saveSetting } from './settingsApi';
import { isTauriRuntime } from './shared';

export type SystemNotificationPolicy = 'background' | 'always' | 'never';

/** 与 Rust 侧 system_notification::POLICY_SETTING_KEY 共用的策略键 */
const POLICY_STORAGE_KEY = 'system-notification-policy';
const VALID_POLICIES: SystemNotificationPolicy[] = ['background', 'always', 'never'];

function normalizePolicy(raw: string | null | undefined): SystemNotificationPolicy | null {
  return VALID_POLICIES.includes(raw as SystemNotificationPolicy)
    ? (raw as SystemNotificationPolicy)
    : null;
}

export function getSystemNotificationPolicy(): SystemNotificationPolicy {
  try {
    return normalizePolicy(localStorage.getItem(POLICY_STORAGE_KEY)) ?? 'background';
  } catch {
    return 'background';
  }
}

export function setSystemNotificationPolicy(policy: SystemNotificationPolicy): void {
  try {
    localStorage.setItem(POLICY_STORAGE_KEY, policy);
  } catch {
    // localStorage 不可用时静默（当次会话默认值生效）
  }
  // 异步同步到后端 settings 表（Rust 侧发通知前读取同一键）；
  // 失败不阻塞——下次启动 syncSystemNotificationPolicyFromBackend 会再对齐。
  if (isTauriRuntime) {
    void saveSetting(POLICY_STORAGE_KEY, policy).catch((e) => {
      console.warn('[SystemNotification] Failed to persist policy to backend:', e);
    });
  }
}

/**
 * 启动时对齐 localStorage 快取与后端 settings 表：
 * - settings 表有值 → 以它为准（备份恢复/多设备同步后生效）；
 * - settings 表无值但本地有值 → 迁移写入（旧版本只写 localStorage，
 *   补齐后 Rust 侧策略拦截才能生效）。
 */
export async function syncSystemNotificationPolicyFromBackend(): Promise<void> {
  if (!isTauriRuntime) return;
  try {
    const backendPolicy = normalizePolicy(await getSetting(POLICY_STORAGE_KEY));
    let localPolicy: SystemNotificationPolicy | null = null;
    try {
      localPolicy = normalizePolicy(localStorage.getItem(POLICY_STORAGE_KEY));
    } catch {
      // localStorage 不可用时仅依赖 settings 表
    }
    if (backendPolicy) {
      if (backendPolicy !== localPolicy) {
        try {
          localStorage.setItem(POLICY_STORAGE_KEY, backendPolicy);
        } catch {
          // ignore
        }
      }
    } else if (localPolicy) {
      await saveSetting(POLICY_STORAGE_KEY, localPolicy);
    }
  } catch (e) {
    console.warn('[SystemNotification] Failed to sync policy from backend:', e);
  }
}

/**
 * 应用是否处于"后台"。
 *
 * 当前 webview 可见且聚焦即前台（单窗口/移动端的可靠快路径）。当前 webview
 * 未聚焦时不能直接判后台——多窗口形态下（番茄钟小窗、快速助手）可能是别的
 * 应用窗口聚焦，需询问 Tauri 全部窗口的聚焦状态；查询失败回退按后台处理
 * （与旧版 document.hasFocus() 口径一致）。
 */
async function isAppInBackground(): Promise<boolean> {
  try {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      document.hasFocus()
    ) {
      return false;
    }
  } catch {
    // 继续走窗口级判断
  }
  if (isTauriRuntime) {
    try {
      const { getAllWindows } = await import('@tauri-apps/api/window');
      const windows = await getAllWindows();
      const focusFlags = await Promise.all(
        windows.map(async (win) => {
          try {
            return await win.isFocused();
          } catch {
            return false;
          }
        }),
      );
      return !focusFlags.some(Boolean);
    } catch {
      // 窗口 API 不可用（如移动端）时回退 document 口径
    }
  }
  try {
    if (typeof document === 'undefined') return false;
    if (document.visibilityState === 'hidden') return true;
    return !document.hasFocus();
  } catch {
    return false;
  }
}

export interface SystemNotificationOptions {
  /**
   * 用户主动订阅的提醒（如 todo 到点提醒）设为 true：
   * 在 background 策略下即使应用在前台也发送（never 策略仍然禁止）。
   */
  force?: boolean;
}

export type SystemNotificationPermissionState =
  | 'granted'
  | 'prompt'
  | 'denied'
  | 'unavailable';

/** 查询系统通知权限；优先读取 WebView 暴露的三态结果，再回退到插件查询。 */
export async function getSystemNotificationPermissionState(): Promise<SystemNotificationPermissionState> {
  try {
    if (typeof window !== 'undefined' && window.Notification) {
      if (window.Notification.permission === 'granted') return 'granted';
      if (window.Notification.permission === 'denied') return 'denied';
    }
    const { isPermissionGranted } = await import('@tauri-apps/plugin-notification');
    return (await isPermissionGranted()) ? 'granted' : 'prompt';
  } catch {
    return 'unavailable';
  }
}

/** 由明确的用户操作触发系统通知授权。 */
export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermissionState> {
  try {
    const { requestPermission } = await import('@tauri-apps/plugin-notification');
    const state = String(await requestPermission());
    if (state === 'granted') return 'granted';
    if (state === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unavailable';
  }
}

/**
 * 确保已获系统通知权限：已授予直接返回，未授予则弹系统请求框。
 *
 * 在用户"订阅通知"的当下（设置 todo 提醒、把策略切到 background/always）
 * 调用——首个通知若在应用后台才触发权限请求，请求框根本不会被看到，
 * 通知会被系统静默丢弃。
 */
export async function ensureSystemNotificationPermission(): Promise<SystemNotificationPermissionState> {
  const current = await getSystemNotificationPermissionState();
  if (current !== 'prompt') return current;
  return await requestSystemNotificationPermission();
}

/**
 * 发送系统通知（经统一策略管线）。
 *
 * @returns 是否实际发送了系统通知（被策略拦截/权限缺失/非 Tauri 环境返回 false）
 */
export async function sendSystemNotification(
  title: string,
  body: string,
  options?: SystemNotificationOptions
): Promise<boolean> {
  const policy = getSystemNotificationPolicy();
  if (policy === 'never') return false;
  if (policy === 'background' && !options?.force && !(await isAppInBackground())) {
    return false;
  }

  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === 'granted';
    }
    if (!granted) return false;
    sendNotification({ title, body });
    return true;
  } catch (e) {
    console.warn('[SystemNotification] Failed to send:', e);
    return false;
  }
}
