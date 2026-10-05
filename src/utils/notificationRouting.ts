/**
 * 系统通知「点了直达」：发通知时带 target（如 'review:cards'），点开后由注册的处理器打开对应界面。
 * - 手机（Android / iOS）：通知插件的 actionPerformed 回调带回 notification.extra.target
 * - 桌面：插件走 notify-rust，没有点击回调；点通知会把应用带回前台——发通知时应用在后台、
 *   CLICK_WINDOW_MS 内第一次回到前台，按「点了通知」处理，之后再回前台不跳转
 */
import { addTypedEventListener } from '@/events';
import { isMobilePlatform } from './platform';
import { isTauriRuntime } from './shared';

export type NotificationTargetHandler = (target: string) => void;

export const NOTIFICATION_CLICK_WINDOW_MS = 3 * 60 * 1000;

let pending: { target: string; sentAt: number } | null = null;
let handler: NotificationTargetHandler | null = null;

/** 发出带 target 的通知后调用（仅当时应用在后台才有意义，由调用方判断） */
export function rememberNotificationTarget(target: string, now: number = Date.now()): void {
  pending = { target, sentAt: now };
}

export function extractNotificationTarget(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { notification?: { extra?: { target?: unknown } }; extra?: { target?: unknown } };
  const target = record.notification?.extra?.target ?? record.extra?.target;
  return typeof target === 'string' && target ? target : null;
}

function onReturnToForeground(): void {
  if (document.visibilityState !== 'visible') return;
  const current = pending;
  pending = null;
  if (current && Date.now() - current.sentAt <= NOTIFICATION_CLICK_WINDOW_MS) handler?.(current.target);
}

/** 应用根部启动一次；返回停止函数 */
export function initNotificationRouting(onTarget: NotificationTargetHandler): () => void {
  handler = onTarget;
  const disposers: Array<() => void> = [];
  if (isMobilePlatform()) {
    if (isTauriRuntime) {
      let stopped = false;
      void import('@tauri-apps/plugin-notification')
        .then(({ onAction }) => onAction((payload) => {
          const target = extractNotificationTarget(payload);
          if (target) handler?.(target);
        }))
        .then((listener) => {
          if (stopped) void listener.unregister();
          else disposers.push(() => { void listener.unregister(); });
        })
        .catch(() => { /* 旧插件 / 非移动运行时：点通知只回到应用 */ });
      disposers.push(() => { stopped = true; });
    }
  } else {
    disposers.push(
      addTypedEventListener('focus', onReturnToForeground),
      addTypedEventListener('visibilitychange', onReturnToForeground, undefined, 'document'),
    );
  }
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
    handler = null;
    pending = null;
  };
}
