/**
 * dockGestures — Dock 手势容差（长按 vs 拖拽重排），按指针类型差异化。
 *
 * 鼠标 / 触控笔（精确指点）：两者同为 5px，与既有手感保持一致。
 *
 * 触屏：手指静按的自然抖动普遍在 6–10px。若沿用 5px 双阈值，长按会被
 * 抖动提前取消，同时固定区拖拽重排被同一抖动误触发——想开窗口列表的
 * 用户手一紧图标就飞了。差异化规则：
 * - 长按移动容差 10px：抖动范围内长按计时不被取消；
 * - 拖拽启动阈值 14px（**必须 > 长按容差**）：意图为长按的手指永远不会
 *   先触发重排；真正横向拖动越过 14px 时，长按已先在 >10px 处被取消，
 *   两条手势之间不存在同时武装的重叠窗口。
 *
 * 不变量（有测试锚定）：DOCK_DRAG_THRESHOLD_TOUCH_PX > DOCK_LONGPRESS_TOLERANCE_TOUCH_PX。
 */

export const DOCK_DRAG_THRESHOLD_PX = 5;
export const DOCK_DRAG_THRESHOLD_TOUCH_PX = 14;
export const DOCK_LONGPRESS_MOVE_TOLERANCE_PX = 5;
export const DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX = 10;

/** 固定区拖拽重排的启动阈值（px），按 PointerEvent.pointerType 取档 */
export function dockDragThresholdPx(pointerType: string | undefined): number {
  return pointerType === 'touch' ? DOCK_DRAG_THRESHOLD_TOUCH_PX : DOCK_DRAG_THRESHOLD_PX;
}

/** 长按判定期间允许的移动容差（px），按 PointerEvent.pointerType 取档 */
export function dockLongPressTolerancePx(pointerType: string | undefined): number {
  return pointerType === 'touch'
    ? DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX
    : DOCK_LONGPRESS_MOVE_TOLERANCE_PX;
}
