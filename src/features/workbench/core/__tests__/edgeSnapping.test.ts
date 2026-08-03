/**
 * 邻窗边缘磁吸（Sequoia 拖窗对齐）纯几何单测。
 *
 * 覆盖：候选线收集（其他窗口四边 + 桌面四边、去重）、边对边相邻贴合、
 * 边对齐、桌面边缘吸附、阈值边界与脱离、最近候选优先、双轴独立、
 * 滞回（已吸附线在扩张带内保持、更近命中立即切换）。
 */
import { describe, expect, it } from 'vitest';
import {
  collectEdgeSnapCandidates,
  computeEdgeSnap,
  EDGE_SNAP_HYSTERESIS,
  EDGE_SNAP_THRESHOLD,
  type EdgeSnapCandidates,
} from '../edgeSnapping';
import type { Frame, Size } from '../types';

const DESKTOP: Size = { w: 1600, h: 900 };

function candidatesOf(...frames: Frame[]): EdgeSnapCandidates {
  return collectEdgeSnapCandidates(frames, DESKTOP);
}

describe('edgeSnapping — collectEdgeSnapCandidates', () => {
  it('收集其他窗口四边 + 桌面四边，并去重', () => {
    const c = candidatesOf(
      { x: 100, y: 50, w: 300, h: 200 },
      // 与上一窗共享右边线 400、上边线 50
      { x: 400, y: 50, w: 200, h: 400 },
    );
    expect([...c.vertical].sort((a, b) => a - b)).toEqual([0, 100, 400, 600, 1600]);
    expect([...c.horizontal].sort((a, b) => a - b)).toEqual([0, 50, 250, 450, 900]);
  });

  it('无候选窗口时只剩桌面四边', () => {
    const c = collectEdgeSnapCandidates([], DESKTOP);
    expect([...c.vertical].sort((a, b) => a - b)).toEqual([0, 1600]);
    expect([...c.horizontal].sort((a, b) => a - b)).toEqual([0, 900]);
  });
});

describe('edgeSnapping — computeEdgeSnap 基本吸附', () => {
  // 邻窗：x ∈ [500, 800]，y ∈ [200, 500]
  const neighbor: Frame = { x: 500, y: 200, w: 300, h: 300 };
  const c = candidatesOf(neighbor);

  it('边对边相邻贴合：我的右边贴邻窗左边（右对左）', () => {
    const r = computeEdgeSnap({ x: 294, y: 700, w: 200, h: 100 }, c);
    // 右边 494 → 候选线 500，修正 +6
    expect(r.dx).toBe(6);
    expect(r.x).toMatchObject({ line: 500, side: 'end' });
  });

  it('边对边相邻贴合：我的左边贴邻窗右边（左对右）', () => {
    const r = computeEdgeSnap({ x: 805, y: 700, w: 200, h: 100 }, c);
    expect(r.dx).toBe(-5);
    expect(r.x).toMatchObject({ line: 800, side: 'start' });
  });

  it('边对齐：左对左 / 上对上', () => {
    const r = computeEdgeSnap({ x: 503, y: 196, w: 200, h: 100 }, c);
    expect(r.dx).toBe(-3);
    expect(r.x).toMatchObject({ line: 500, side: 'start' });
    expect(r.dy).toBe(4);
    expect(r.y).toMatchObject({ line: 200, side: 'start' });
  });

  it('边对边相邻贴合：我的上边贴邻窗下边（上对下）', () => {
    const r = computeEdgeSnap({ x: 1000, y: 507, w: 200, h: 100 }, c);
    expect(r.dy).toBe(-7);
    expect(r.y).toMatchObject({ line: 500, side: 'start' });
  });

  it('桌面边缘：左缘 0 与下缘 h 都吸', () => {
    const r = computeEdgeSnap({ x: 5, y: 795, w: 200, h: 100 }, candidatesOf());
    expect(r.dx).toBe(-5); // 左边 5 → 0
    expect(r.dy).toBe(5); // 下边 895 → 900
  });

  it('两轴独立：仅一轴在阈值内时另一轴不动', () => {
    const r = computeEdgeSnap({ x: 494, y: 700, w: 200, h: 100 }, c);
    expect(r.dx).toBe(6);
    expect(r.dy).toBe(0);
    expect(r.y).toBeNull();
  });
});

describe('edgeSnapping — 阈值与脱离', () => {
  const c = candidatesOf({ x: 500, y: 200, w: 300, h: 300 });

  it('恰好等于阈值时吸附', () => {
    const r = computeEdgeSnap(
      { x: 500 - 200 - EDGE_SNAP_THRESHOLD, y: 700, w: 200, h: 100 },
      c,
    );
    expect(r.dx).toBe(EDGE_SNAP_THRESHOLD);
  });

  it('超过阈值不吸附（base 拖过阈值即脱离）', () => {
    const r = computeEdgeSnap(
      { x: 500 - 200 - EDGE_SNAP_THRESHOLD - 1, y: 700, w: 200, h: 100 },
      c,
    );
    expect(r.dx).toBe(0);
    expect(r.x).toBeNull();
  });

  it('多候选取修正量最小者', () => {
    // 垂直线 100 与 104：左边 103 → 距 104 更近（+1 vs −3）
    const c2 = candidatesOf(
      { x: 100, y: 0, w: 4, h: 100 },
    );
    const r = computeEdgeSnap({ x: 103, y: 400, w: 50, h: 50 }, c2);
    expect(r.dx).toBe(1);
    expect(r.x).toMatchObject({ line: 104, side: 'start' });
  });
});

describe('edgeSnapping — 滞回', () => {
  const c = candidatesOf({ x: 500, y: 200, w: 300, h: 300 });

  it('已吸附的线在 threshold + hysteresis 内保持吸附', () => {
    // 第一帧：右边 494 → 吸到 500
    const first = computeEdgeSnap({ x: 294, y: 700, w: 200, h: 100 }, c);
    expect(first.x).toMatchObject({ line: 500, side: 'end' });
    // 第二帧：base 拖远到距线 threshold+hysteresis（超出普通阈值但在滞回带内）
    const d = EDGE_SNAP_THRESHOLD + EDGE_SNAP_HYSTERESIS;
    const held = computeEdgeSnap(
      { x: 500 - 200 - d, y: 700, w: 200, h: 100 },
      c,
      { x: first.x, y: first.y },
    );
    expect(held.dx).toBe(d);
    expect(held.x).toMatchObject({ line: 500, side: 'end' });
  });

  it('拖出滞回带即释放', () => {
    const first = computeEdgeSnap({ x: 294, y: 700, w: 200, h: 100 }, c);
    const d = EDGE_SNAP_THRESHOLD + EDGE_SNAP_HYSTERESIS + 1;
    const released = computeEdgeSnap(
      { x: 500 - 200 - d, y: 700, w: 200, h: 100 },
      c,
      { x: first.x, y: first.y },
    );
    expect(released.dx).toBe(0);
    expect(released.x).toBeNull();
  });

  it('旧线仍在滞回带内但出现严格更近的新命中时立即切换', () => {
    // 两条相近垂直线：500（邻窗左边）与 505（另一窗左边）
    const c2 = candidatesOf(
      { x: 500, y: 200, w: 300, h: 300 },
      { x: 505, y: 600, w: 100, h: 100 },
    );
    // 上一帧：右边 496 → 吸在 500（距 505 为 9 > 阈值）
    const prev = computeEdgeSnap({ x: 296, y: 700, w: 200, h: 100 }, c2);
    expect(prev.x).toMatchObject({ line: 500, side: 'end' });
    // 本帧：右边 504——旧线 500 仍在滞回带内（|−4| ≤ 12），
    // 但 505 严格更近（|1| < |−4|）→ 切换
    const switched = computeEdgeSnap(
      { x: 304, y: 700, w: 200, h: 100 },
      c2,
      { x: prev.x, y: prev.y },
    );
    expect(switched.dx).toBe(1);
    expect(switched.x).toMatchObject({ line: 505, side: 'end' });
  });

  it('无 previous（首帧 / 引擎重置）与显式 null 等价', () => {
    const frame: Frame = { x: 294, y: 700, w: 200, h: 100 };
    expect(computeEdgeSnap(frame, c)).toEqual(computeEdgeSnap(frame, c, null));
  });
});
