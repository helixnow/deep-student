/**
 * 邻窗边缘磁吸（macOS Sequoia 拖窗对齐）— 纯几何模块
 *
 * 拖动窗口时对「其他可见窗口的四边 + 桌面四边」做 ±EDGE_SNAP_THRESHOLD px
 * 对齐吸附。统一用「候选线」模型：
 * - 每个候选窗口贡献两条垂直线（x、x+w）与两条水平线（y、y+h）；
 * - 桌面贡献 x∈{0, W}、y∈{0, H}；
 * - 被拖窗口的左/右边（start/end）各自尝试贴到垂直线上，上/下边贴水平线。
 *   这一个模型同时覆盖「边对边相邻贴合」（我的左边贴你的右边 = start 贴
 *   x+w 线）与「边对齐」（左对左 = start 贴 x 线）。
 *
 * 渲染纪律：本模块只做纯计算，由 pointerEngine 在拖拽 rAF 帧内调用；
 * 候选线在手势开始时快照一次（collectEdgeSnapCandidates），拖拽期间
 * 不查询 DOM / store。
 *
 * 脱离手感：吸附修正来自「未吸附的 base frame」与候选线的距离，指针继续
 * 拖过阈值后修正自然消失（标准磁吸）。另加滞回：已吸附的线在
 * threshold + EDGE_SNAP_HYSTERESIS 内保持吸附（除非出现严格更近的新命中），
 * 消除阈值边界抖动——与 snapZones 的 SNAP_ZONE_HYSTERESIS 同一思路。
 */
import type { Frame, Size } from './types';

/** 边缘磁吸吸附阈值（px）：base 边距候选线 ≤ 此值即吸附 */
export const EDGE_SNAP_THRESHOLD = 8;
/** 滞回扩张（px）：已吸附的线在 threshold + 此值内保持，防边界抖动 */
export const EDGE_SNAP_HYSTERESIS = 4;

/** 候选吸附线集合（手势开始时快照一次，desktop 坐标系） */
export interface EdgeSnapCandidates {
  /** 垂直线的 x 坐标：其他窗口左/右边 + 桌面左右缘（去重） */
  vertical: number[];
  /** 水平线的 y 坐标：其他窗口上/下边 + 桌面上下缘（去重） */
  horizontal: number[];
}

/** 被拖窗口参与吸附的边：start = 左/上边，end = 右/下边 */
export type EdgeSnapSide = 'start' | 'end';

/** 单轴吸附命中（供下一帧滞回判定） */
export interface AxisSnap {
  /** 吸附到的候选线坐标 */
  line: number;
  /** 被拖窗口用哪条边贴上去 */
  side: EdgeSnapSide;
  /** 本帧修正量（line − 对应边坐标） */
  delta: number;
}

export interface EdgeSnapResult {
  /** 应叠加到 base frame 上的修正（未命中为 0） */
  dx: number;
  dy: number;
  /** 两轴命中详情（null = 未吸附）；原样传回下一帧作滞回状态 */
  x: AxisSnap | null;
  y: AxisSnap | null;
}

const EMPTY_SNAP_STATE: { x: AxisSnap | null; y: AxisSnap | null } = { x: null, y: null };

/**
 * 收集候选吸附线：frames 应为「其他可见窗口」的 frame
 * （调用方负责排除被拖窗口自身与 minimized 窗口），外加桌面四边。
 */
export function collectEdgeSnapCandidates(
  frames: readonly Frame[],
  desktop: Size,
): EdgeSnapCandidates {
  const vertical = new Set<number>([0, desktop.w]);
  const horizontal = new Set<number>([0, desktop.h]);
  for (const f of frames) {
    vertical.add(f.x);
    vertical.add(f.x + f.w);
    horizontal.add(f.y);
    horizontal.add(f.y + f.h);
  }
  return { vertical: [...vertical], horizontal: [...horizontal] };
}

/**
 * 单轴求解：在候选线中找 |修正量| 最小且 ≤ threshold 的命中；
 * 上一帧命中的线享受滞回带（threshold + hysteresis），
 * 但出现严格更近的新命中时立即切换（对齐 snapZones 的滞回语义）。
 */
function solveAxis(
  start: number,
  size: number,
  lines: readonly number[],
  prev: AxisSnap | null,
  threshold: number,
  hysteresis: number,
): AxisSnap | null {
  let best: AxisSnap | null = null;
  for (const line of lines) {
    const dStart = line - start;
    if (Math.abs(dStart) <= threshold && (!best || Math.abs(dStart) < Math.abs(best.delta))) {
      best = { line, side: 'start', delta: dStart };
    }
    const dEnd = line - (start + size);
    if (Math.abs(dEnd) <= threshold && (!best || Math.abs(dEnd) < Math.abs(best.delta))) {
      best = { line, side: 'end', delta: dEnd };
    }
  }
  if (prev) {
    const d = prev.side === 'start' ? prev.line - start : prev.line - (start + size);
    if (Math.abs(d) <= threshold + hysteresis && (!best || Math.abs(best.delta) >= Math.abs(d))) {
      return { line: prev.line, side: prev.side, delta: d };
    }
  }
  return best;
}

/**
 * 给定候选线集合与当前（未吸附的）base frame，输出吸附修正。
 * 两轴独立求解；previous 传上一帧的 { x, y } 命中即获得滞回。
 */
export function computeEdgeSnap(
  frame: Frame,
  candidates: EdgeSnapCandidates,
  previous: { x: AxisSnap | null; y: AxisSnap | null } | null = EMPTY_SNAP_STATE,
  threshold: number = EDGE_SNAP_THRESHOLD,
  hysteresis: number = EDGE_SNAP_HYSTERESIS,
): EdgeSnapResult {
  const prev = previous ?? EMPTY_SNAP_STATE;
  const x = solveAxis(frame.x, frame.w, candidates.vertical, prev.x, threshold, hysteresis);
  const y = solveAxis(frame.y, frame.h, candidates.horizontal, prev.y, threshold, hysteresis);
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, x, y };
}
