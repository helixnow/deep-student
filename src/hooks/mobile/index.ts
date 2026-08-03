/**
 * 移动端手势 / 反馈 hooks 桶导出。
 *
 * ```tsx
 * import { useLongPress, useSwipeGesture, useHaptics } from '@/hooks/mobile';
 * ```
 */

export {
  useLongPress,
  type LongPressPoint,
  type LongPressBind,
  type UseLongPressOptions,
  type UseLongPressResult,
} from './useLongPress';

export {
  useSwipeGesture,
  type SwipeAxis,
  type SwipeEndInfo,
  type UseSwipeGestureOptions,
  type UseSwipeGestureResult,
} from './useSwipeGesture';

// ★ 2026-07 收尾清理：usePressable 全仓库零消费已移除（按压反馈由 .ui-press CSS 类承担）

export {
  useHaptics,
  haptics,
  type Haptics,
  type HapticImpactStyle,
  type HapticNotificationType,
} from './useHaptics';
