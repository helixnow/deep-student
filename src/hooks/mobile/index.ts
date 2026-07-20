/**
 * 移动端手势 / 反馈 hooks 桶导出。
 *
 * ```tsx
 * import { useLongPress, useSwipeGesture, usePressable, useHaptics } from '@/hooks/mobile';
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

export {
  usePressable,
  type PressableBind,
  type UsePressableOptions,
  type UsePressableResult,
} from './usePressable';

export {
  useHaptics,
  haptics,
  type Haptics,
  type HapticImpactStyle,
  type HapticNotificationType,
} from './useHaptics';
