/**
 * useHaptics — 轻量触觉反馈 hook（navigator.vibrate 分档封装）。
 *
 * 行为：
 * - 平台支持 `navigator.vibrate`（多数 Android WebView）时触发轻震；
 *   不支持（iOS WKWebView / 桌面）时静默 no-op，调用方无需做能力判断；
 * - `impact('light' | 'medium')`：交互确认档（10ms / 20ms）；
 * - `notification('success' | 'error')`：结果通知档（success 单次 15ms，
 *   error 双脉冲 [30, 60, 30]）；
 * - 尊重 prefers-reduced-motion：用户偏好减少动态时全部 no-op。
 *
 * 后续 Tauri 原生接入点（本轮不做，src-tauri 不碰）：
 * 在 `vibrate()` 内部优先探测 Tauri 原生 haptics command（如
 * `invoke('plugin:haptics|impact')` 或社区插件 @tauri-apps/plugin-haptics），
 * 存在则走原生（iOS 可用 UIImpactFeedbackGenerator），否则回落
 * navigator.vibrate。API 形状（impact/notification 分档）已按该插件对齐，
 * 接入时调用方零改动。
 *
 * 接入示例：
 * ```tsx
 * const haptics = useHaptics();
 * const longPress = useLongPress({
 *   onLongPress: (point) => {
 *     haptics.impact('light');
 *     openContextMenu(point);
 *   },
 * });
 * ```
 */

import { useMemo } from 'react';

export type HapticImpactStyle = 'light' | 'medium';
export type HapticNotificationType = 'success' | 'error';

export interface Haptics {
  /** 交互确认轻震（light: 10ms，medium: 20ms）。 */
  impact: (style?: HapticImpactStyle) => void;
  /** 结果通知震动（success: 15ms 单次，error: 双脉冲）。 */
  notification: (type: HapticNotificationType) => void;
  /** 当前平台是否真的会产生震动（false 时所有调用为 no-op）。 */
  isSupported: boolean;
}

const IMPACT_PATTERNS: Record<HapticImpactStyle, number> = {
  light: 10,
  medium: 20,
};

const NOTIFICATION_PATTERNS: Record<HapticNotificationType, number | number[]> = {
  success: 15,
  error: [30, 60, 30],
};

function canVibrate(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.vibrate === 'function' &&
    !(
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  );
}

function vibrate(pattern: number | number[]): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // 某些 WebView 声明了 vibrate 但调用抛错（权限/策略），静默忽略
  }
}

/**
 * 模块级单例实现：不依赖组件状态，也可在非组件上下文
 * （事件处理器、store action）直接使用。
 */
export const haptics: Haptics = {
  impact: (style = 'light') => vibrate(IMPACT_PATTERNS[style]),
  notification: (type) => vibrate(NOTIFICATION_PATTERNS[type]),
  get isSupported() {
    return canVibrate();
  },
};

/** React hook 形式（返回稳定引用，可安全放入依赖数组）。 */
export function useHaptics(): Haptics {
  return useMemo(() => haptics, []);
}

export default useHaptics;
