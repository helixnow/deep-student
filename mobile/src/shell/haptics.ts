/**
 * 移动端 `plugin:haptics|*` 处理：安全桥接到 `navigator.vibrate`，无震动能力时静默忽略，永不失败。
 */
import { parseJsonArgs, type MobilePluginHandler } from './plugin-args.ts';

const IMPACT_MS: Readonly<Record<string, number>> = {
  light: 10,
  medium: 20,
  heavy: 35,
};

const NOTIFICATION_PATTERN: Readonly<Record<string, number | number[]>> = {
  success: 15,
  warning: [15, 40, 15],
  error: [30, 60, 30],
};

function triggerVibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some WebViews expose navigator.vibrate but throw when blocked by policy.
  }
}

/** 创建供 `MobileShell` 使用的 `plugin:haptics|*` 处理器。 */
export function createMobileHapticsHandler(): MobilePluginHandler {
  return ({ command, payload }) => {
    const args = parseJsonArgs(payload, 'haptics');
    switch (command) {
      case 'impact': {
        const style = typeof args.style === 'string' ? args.style.toLowerCase() : 'light';
        triggerVibrate(IMPACT_MS[style] ?? 10);
        return null;
      }
      case 'notification': {
        const type = typeof args.type === 'string' ? args.type.toLowerCase() : 'success';
        triggerVibrate(NOTIFICATION_PATTERN[type] ?? 15);
        return null;
      }
      case 'selection_start':
      case 'selection_changed':
        triggerVibrate(5);
        return null;
      case 'selection_end':
        return null;
      case 'vibrate': {
        const duration = typeof args.duration === 'number' && Number.isFinite(args.duration) && args.duration >= 0
          ? Math.round(args.duration)
          : 20;
        triggerVibrate(duration);
        return null;
      }
      default:
        return null;
    }
  };
}
