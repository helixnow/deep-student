/**
 * dockGestures — 触屏 Dock 长按 vs 拖拽重排容差差异化（2026-08）。
 *
 * 关键不变量：触屏拖拽启动阈值必须严格大于触屏长按移动容差，
 * 否则想长按开窗口列表的手指抖动会先误启动重排（图标飞走）。
 */
import { describe, expect, it } from 'vitest';

import {
  DOCK_DRAG_THRESHOLD_PX,
  DOCK_DRAG_THRESHOLD_TOUCH_PX,
  DOCK_LONGPRESS_MOVE_TOLERANCE_PX,
  DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX,
  dockDragThresholdPx,
  dockLongPressTolerancePx,
} from '../dockGestures';

describe('dockGestures 容差档位', () => {
  it('鼠标 / 触控笔 / 未知指针走精确档（5px，与既有手感一致）', () => {
    for (const type of ['mouse', 'pen', undefined, '']) {
      expect(dockDragThresholdPx(type)).toBe(DOCK_DRAG_THRESHOLD_PX);
      expect(dockLongPressTolerancePx(type)).toBe(DOCK_LONGPRESS_MOVE_TOLERANCE_PX);
    }
  });

  it('触屏走放宽档（长按容差 10px / 拖拽阈值 14px）', () => {
    expect(dockDragThresholdPx('touch')).toBe(DOCK_DRAG_THRESHOLD_TOUCH_PX);
    expect(dockLongPressTolerancePx('touch')).toBe(DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX);
    expect(DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX).toBeGreaterThan(
      DOCK_LONGPRESS_MOVE_TOLERANCE_PX,
    );
  });

  it('不变量：触屏拖拽阈值 > 触屏长按容差（两手势无同时武装的重叠窗口）', () => {
    expect(DOCK_DRAG_THRESHOLD_TOUCH_PX).toBeGreaterThan(
      DOCK_LONGPRESS_MOVE_TOLERANCE_TOUCH_PX,
    );
    // 鼠标档两者相等可接受（拖拽启动即取消长按的顺序由调用方保证）
    expect(DOCK_DRAG_THRESHOLD_PX).toBeGreaterThanOrEqual(
      DOCK_LONGPRESS_MOVE_TOLERANCE_PX,
    );
  });
});
