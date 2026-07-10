/**
 * P2 / L5 — core/snapZones.ts 命中矩阵测试
 */
import { describe, it, expect } from 'vitest';
import {
  hitTestSnapZone,
  SNAP_EDGE_THRESHOLD,
  SNAP_CORNER_THRESHOLD,
  SNAP_ZONE_HYSTERESIS,
  SNAP_ALT_EDGE_SCALE,
  SNAP_ALT_CORNER_SCALE,
} from '@/features/workbench/core/snapZones';
import type { SnapZone } from '@/features/workbench/core/types';

const D = { w: 1600, h: 1000 };

describe('hitTestSnapZone — 命中矩阵', () => {
  const matrix: Array<[string, number, number, SnapZone]> = [
    // 四角 SNAP_CORNER_THRESHOLD（优先级最高）
    ['左上角', 10, 10, 'tl'],
    ['左上角边界', 64, 64, 'tl'],
    ['右上角', 1590, 10, 'tr'],
    ['右上角边界', 1536, 64, 'tr'],
    ['左下角', 10, 990, 'bl'],
    ['左下角边界', 64, 936, 'bl'],
    ['右下角', 1590, 990, 'br'],
    ['右下角边界', 1536, 936, 'br'],
    // 左右边缘 SNAP_EDGE_THRESHOLD → 半屏
    ['左边缘', 0, 500, 'left'],
    ['左边缘边界', 24, 500, 'left'],
    ['左边缘外一像素', 25, 500, null],
    ['右边缘', 1600, 500, 'right'],
    ['右边缘边界', 1576, 500, 'right'],
    ['右边缘外一像素', 1575, 500, null],
    // 顶缘 → maximize
    ['顶缘中部', 800, 0, 'top-maximize'],
    ['顶缘边界', 800, 24, 'top-maximize'],
    ['顶缘外一像素', 800, 25, null],
    // 角区外但边缘内：角优先规则的反向验证
    ['左缘但纵向超出角区', 5, 200, 'left'],
    ['顶缘但横向超出角区', 400, 5, 'top-maximize'],
    // 桌面中部
    ['中部', 800, 500, null],
    ['刚好脱离所有热区', 65, 65, null],
    // 底缘（非角区）无吸附
    ['底缘中部', 800, 995, null],
    // 桌面外不吸附
    ['左外', -5, 500, null],
    ['右外', 1700, 500, null],
    ['上外', 800, -1, null],
    ['下外', 800, 1001, null],
  ];

  it.each(matrix)('%s (%i,%i) → %s', (_name, x, y, expected) => {
    expect(hitTestSnapZone({ x, y }, D)).toBe(expected);
  });

  it('小桌面下角区重叠时仍返回确定结果（左上优先序）', () => {
    // 80×80 桌面：中心点落在多个角区内，按 tl→tr→bl→br 判定顺序
    expect(hitTestSnapZone({ x: 40, y: 40 }, { w: 80, h: 80 })).toBe('tl');
  });

  it('阈值常量对齐 Tahoe 复刻建议（边 24 / 角 64 / 滞回 14）', () => {
    expect(SNAP_EDGE_THRESHOLD).toBe(24);
    expect(SNAP_CORNER_THRESHOLD).toBe(64);
    expect(SNAP_ZONE_HYSTERESIS).toBe(14);
  });
});

describe('hitTestSnapZone — 滞回', () => {
  it('已命中左缘后，滑出热区但仍在滞回带内 → 保持 left', () => {
    // 热区 24，滞回 +14 → 保持到 38
    expect(hitTestSnapZone({ x: 30, y: 500 }, D, 'left')).toBe('left');
    expect(hitTestSnapZone({ x: 38, y: 500 }, D, 'left')).toBe('left');
    expect(hitTestSnapZone({ x: 39, y: 500 }, D, 'left')).toBeNull();
  });

  it('raw 命中另一区时立即切换，不做粘滞', () => {
    expect(hitTestSnapZone({ x: 10, y: 10 }, D, 'left')).toBe('tl');
  });
});

describe('hitTestSnapZone — ⌥ 加速平铺', () => {
  const altEdge = Math.round(SNAP_EDGE_THRESHOLD * SNAP_ALT_EDGE_SCALE);
  const altCorner = Math.round(SNAP_CORNER_THRESHOLD * SNAP_ALT_CORNER_SCALE);

  it('⌥ 扩大边缘热区：默认未命中处可命中 left', () => {
    const x = SNAP_EDGE_THRESHOLD + 1; // 25：默认 null
    expect(hitTestSnapZone({ x, y: 500 }, D)).toBeNull();
    expect(hitTestSnapZone({ x, y: 500 }, D, null, { altKey: true })).toBe('left');
    expect(hitTestSnapZone({ x: altEdge, y: 500 }, D, null, { altKey: true })).toBe('left');
    expect(hitTestSnapZone({ x: altEdge + 1, y: 500 }, D, null, { altKey: true })).toBeNull();
  });

  it('⌥ 扩大角区：默认未命中处可命中 tl', () => {
    const p = { x: SNAP_CORNER_THRESHOLD + 1, y: SNAP_CORNER_THRESHOLD + 1 }; // 65,65
    expect(hitTestSnapZone(p, D)).toBeNull();
    expect(hitTestSnapZone(p, D, null, { altKey: true })).toBe('tl');
    expect(
      hitTestSnapZone({ x: altCorner, y: altCorner }, D, null, { altKey: true }),
    ).toBe('tl');
  });
});
