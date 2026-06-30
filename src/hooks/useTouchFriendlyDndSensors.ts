/**
 * N-9/DND-1: dnd-kit 统一传感器配置（触屏友好）
 *
 * - 鼠标：移动 distance 像素后激活（保持桌面手感，避免与点击冲突）
 * - 触摸：长按 250ms 激活、容差 8px（与 @hello-pangea/dnd 会话列表的
 *   长按语义对齐；delay 内滑动超过容差则放行原生滚动）
 * - 键盘：可访问性排序
 */

import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export const TOUCH_DRAG_DELAY_MS = 250;
export const TOUCH_DRAG_TOLERANCE_PX = 8;

export function useTouchFriendlyDndSensors(options?: { mouseDistance?: number }) {
  const mouseDistance = options?.mouseDistance ?? 8;
  return useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: mouseDistance },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: TOUCH_DRAG_DELAY_MS, tolerance: TOUCH_DRAG_TOLERANCE_PX },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
}
