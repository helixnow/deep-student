/**
 * 统一系统通知管线（8.1）
 *
 * 所有系统级通知（番茄钟、todo 提醒、制卡完成、同步、索引等）统一经此发送，
 * 受全局三档策略控制（借鉴 Codex 通知策略，默认仅后台时通知）：
 * - background：仅当应用在后台/失焦时发系统通知（默认；前台时由应用内 UI 承担反馈）
 * - always：总是发系统通知
 * - never：从不发系统通知
 *
 * 非 Tauri 环境 / 权限缺失时静默退化。
 */

export type SystemNotificationPolicy = 'background' | 'always' | 'never';

const POLICY_STORAGE_KEY = 'system-notification-policy';
const VALID_POLICIES: SystemNotificationPolicy[] = ['background', 'always', 'never'];

export function getSystemNotificationPolicy(): SystemNotificationPolicy {
  try {
    const raw = localStorage.getItem(POLICY_STORAGE_KEY);
    return VALID_POLICIES.includes(raw as SystemNotificationPolicy)
      ? (raw as SystemNotificationPolicy)
      : 'background';
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
}

/** 应用是否处于"后台"（页面隐藏或窗口失焦） */
function isAppInBackground(): boolean {
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
  if (policy === 'background' && !options?.force && !isAppInBackground()) {
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
