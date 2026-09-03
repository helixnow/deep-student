/**
 * P2 / L5 — core/snapZones.ts 命中矩阵测试
 */
import { describe, it, expect } from 'vitest';
import {
  hitTestSnapZone,
  snapCornerThreshold,
  SNAP_EDGE_THRESHOLD,
  SNAP_CORNER_THRESHOLD,
  SNAP_CORNER_WIDTH_RATIO,
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
    // 底缘中段（角区之外）→ 下半屏
    ['底缘中部', 800, 995, 'bottom-half'],
    ['底缘边界', 800, 976, 'bottom-half'],
    ['底缘外一像素', 800, 975, null],
    // 桌面外不吸附
    ['左外', -5, 500, null],
    ['右外', 1700, 500, null],
    ['上外', 800, -1, null],
    ['下外', 800, 1001, null],
  ];

  it.each(matrix)('%s (%i,%i) → %s', (_name, x, y, expected) => {
    expect(hitTestSnapZone({ x, y }, D)).toBe(expected);
  });

  it('角区重叠时仍返回确定结果（左上优先序）', () => {
    // 1600×100 桌面：角区 64 在纵向重叠（nearTop 与 nearBottom 同时成立），
    // 按 tl→tr→bl→br 判定顺序取 tl
    expect(hitTestSnapZone({ x: 40, y: 50 }, { w: 1600, h: 100 })).toBe('tl');
  });

  it('阈值常量对齐 Tahoe 复刻建议（边 24 / 角上限 64 / 滞回 14 / 角占比 5%）', () => {
    expect(SNAP_EDGE_THRESHOLD).toBe(24);
    expect(SNAP_CORNER_THRESHOLD).toBe(64);
    expect(SNAP_ZONE_HYSTERESIS).toBe(14);
    expect(SNAP_CORNER_WIDTH_RATIO).toBe(0.05);
  });
});

describe('hitTestSnapZone — 角热区按桌面宽度比例化', () => {
  it('snapCornerThreshold = min(64, width × 0.05)', () => {
    expect(snapCornerThreshold(1600)).toBe(64); // 80 封顶 64
    expect(snapCornerThreshold(1280)).toBe(64); // 恰为 64
    expect(snapCornerThreshold(640)).toBe(32);
    expect(snapCornerThreshold(0)).toBe(0);
  });

  it('窄桌面角区收缩：64px 处不再命中角，边缘热区仍生效', () => {
    const small = { w: 640, h: 400 }; // corner = 32
    expect(hitTestSnapZone({ x: 40, y: 40 }, small)).toBeNull();
    expect(hitTestSnapZone({ x: 30, y: 30 }, small)).toBe('tl');
    // 角区之外的左缘竖条仍是 left（edge 24 不随宽度缩放）
    expect(hitTestSnapZone({ x: 10, y: 200 }, small)).toBe('left');
  });
});

describe('hitTestSnapZone — 上/下半屏热区', () => {
  it('普通拖顶缘 = top-maximize；⌥ 拖顶缘 = top-half', () => {
    expect(hitTestSnapZone({ x: 800, y: 10 }, D)).toBe('top-maximize');
    expect(hitTestSnapZone({ x: 800, y: 10 }, D, null, { altKey: true })).toBe('top-half');
  });

  it('⌥ 顶缘热区同样扩大（edge × SNAP_ALT_EDGE_SCALE）', () => {
    const altEdge = Math.round(SNAP_EDGE_THRESHOLD * SNAP_ALT_EDGE_SCALE);
    expect(hitTestSnapZone({ x: 800, y: altEdge }, D, null, { altKey: true })).toBe('top-half');
    expect(
      hitTestSnapZone({ x: 800, y: altEdge + 1 }, D, null, { altKey: true }),
    ).toBeNull();
  });

  it('底缘中段命中 bottom-half；底角仍归四分屏', () => {
    expect(hitTestSnapZone({ x: 800, y: 990 }, D)).toBe('bottom-half');
    expect(hitTestSnapZone({ x: 10, y: 990 }, D)).toBe('bl');
    expect(hitTestSnapZone({ x: 1590, y: 990 }, D)).toBe('br');
  });

  it('bottom-half 滞回：脱离热区但在滞回带内保持命中', () => {
    // 热区 y ≥ 976，滞回 +14 → 保持到 y ≥ 962
    expect(hitTestSnapZone({ x: 800, y: 965 }, D, 'bottom-half')).toBe('bottom-half');
    expect(hitTestSnapZone({ x: 800, y: 961 }, D, 'bottom-half')).toBeNull();
  });

  it('⌥ 中途松开：top-half 立即切回 top-maximize（raw 命中优先于滞回）', () => {
    expect(hitTestSnapZone({ x: 800, y: 10 }, D, 'top-half')).toBe('top-maximize');
  });

  it('修饰键在顶缘滞回带内切换时同步切换语义，不粘住旧 zone', () => {
    // 普通 edge=24、hysteresis=14：松开 ⌥ 后 y=30 仍在 Fill 滞回带内。
    expect(hitTestSnapZone({ x: 800, y: 30 }, D, 'top-half')).toBe('top-maximize');
    expect(hitTestSnapZone({ x: 800, y: 39 }, D, 'top-half')).toBeNull();

    // ⌥ edge=48、hysteresis=14：即使刚脱离基础热区，也应切成 top-half。
    expect(
      hitTestSnapZone({ x: 800, y: 50 }, D, 'top-maximize', { altKey: true }),
    ).toBe('top-half');
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
