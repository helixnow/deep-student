/**
 * N-9/DND-1: dnd-kit 统一传感器配置（触屏友好）
 *
 * - 鼠标：移动 distance 像素后激活（保持桌面手感，避免与点击冲突）
 * - 触摸：长按 250ms 激活、容差 8px（沿用会话列表迁移前 @hello-pangea/dnd
 *   的长按语义；delay 内滑动超过容差则放行原生滚动）
 * - 键盘：可访问性排序
 */

import { KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

export const TOUCH_DRAG_DELAY_MS = 250;
export const TOUCH_DRAG_TOLERANCE_PX = 8;

/**
 * DND-2: dnd-kit 自动滚动的外壳保护配置（传给 `<DndContext autoScroll={...}>`）。
 *
 * dnd-kit 的 AutoScroller 会无条件把 document.scrollingElement 当作可滚动目标
 * （不检查其 overflow 样式）。本应用是桌面壳布局，html/body/#root 全部
 * overflow:hidden、内容恰好一屏，但 overflow:hidden 的元素依然可以被程序化
 * 滚动——拖拽靠近窗口边缘时 AutoScroller 会直接滚动整个文档，表现为
 * 「整页/OS 区滚走、fixed 元素留在原地、渲染断成两半」。
 * 这里禁止对文档根做自动滚动，其余（overflow:auto/scroll 的列表容器）不受影响。
 */
export const SHELL_SAFE_AUTO_SCROLL = {
  canScroll: (element: Element): boolean => {
    const doc = element.ownerDocument ?? document;
    return (
      element !== doc.scrollingElement &&
      element !== doc.documentElement &&
      element !== doc.body
    );
  },
};

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
