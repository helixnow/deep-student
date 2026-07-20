/** 画布节点拖放落点解析：最近邻 + 沿兄弟排列轴三分 + 可选滞回 */

import type { LayoutDirection } from '../types';

export type DropMode = 'child' | 'sibling-before' | 'sibling-after';

/**
 * 兄弟节点的排列轴：
 * - vertical：兄弟沿 Y 轴上下排列（left/right/both/radial 等水平生长布局，默认）
 * - horizontal：兄弟沿 X 轴左右排列（up/down 垂直生长布局，如组织结构图）
 *
 * sibling-before/after 沿该轴判定：vertical 用上下三分，horizontal 用左右三分。
 */
export type DropOrientation = 'vertical' | 'horizontal';

/** 由当前布局方向推导兄弟排列轴（生长轴的垂直方向） */
export function dropOrientationForDirection(
  direction: LayoutDirection | string | undefined,
): DropOrientation {
  return direction === 'up' || direction === 'down' ? 'horizontal' : 'vertical';
}

export const DROP_TARGET_RADIUS = 150;
/** 已命中目标相对新 closest 的距离余量内保持不变，减少目标跳动 */
export const DROP_CLOSEST_HYSTERESIS = 24;
/** 相对目标高度的上下带（约垂直三分） */
export const DROP_MODE_BAND_RATIO = 0.3;
/** 模式切换滞回（相对目标高度），避免在边界附近闪烁 */
export const DROP_MODE_HYSTERESIS_RATIO = 0.08;

export interface DropCandidate {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolveDropTargetInput {
  dragCenterX: number;
  dragCenterY: number;
  candidates: DropCandidate[];
  previousTargetId: string | null;
  previousMode: DropMode;
  /** 兄弟排列轴，默认 vertical（保持旧行为） */
  orientation?: DropOrientation;
  radius?: number;
  closestHysteresis?: number;
  modeBandRatio?: number;
  modeHysteresisRatio?: number;
}

export interface ResolveDropTargetResult {
  targetId: string | null;
  mode: DropMode;
  dist: number;
}

function candidateDist(
  dragCenterX: number,
  dragCenterY: number,
  c: DropCandidate,
): number {
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  return Math.hypot(dragCenterX - cx, dragCenterY - cy);
}

/** 在半径内找最近候选；若上一目标仍在半径内且距离不差于 closest+滞回，则保持上一目标 */
export function pickClosestDropTarget(
  dragCenterX: number,
  dragCenterY: number,
  candidates: DropCandidate[],
  previousTargetId: string | null,
  radius = DROP_TARGET_RADIUS,
  closestHysteresis = DROP_CLOSEST_HYSTERESIS,
): { targetId: string | null; dist: number } {
  let closestId: string | null = null;
  let closestDist = Infinity;

  for (const c of candidates) {
    const dist = candidateDist(dragCenterX, dragCenterY, c);
    if (dist < closestDist && dist < radius) {
      closestDist = dist;
      closestId = c.id;
    }
  }

  if (!closestId) {
    return { targetId: null, dist: Infinity };
  }

  if (previousTargetId && previousTargetId !== closestId) {
    const prev = candidates.find(c => c.id === previousTargetId);
    if (prev) {
      const prevDist = candidateDist(dragCenterX, dragCenterY, prev);
      if (prevDist < radius && prevDist <= closestDist + closestHysteresis) {
        return { targetId: previousTargetId, dist: prevDist };
      }
    }
  }

  return { targetId: closestId, dist: closestDist };
}

/** 沿排列轴的相对位移 → 落点模式；对当前模式做滞回，减少边界闪烁（轴无关核心） */
function resolveDropModeAlongAxis(
  rel: number,
  extent: number,
  previousMode: DropMode,
  modeBandRatio: number,
  modeHysteresisRatio: number,
): DropMode {
  const band = extent * modeBandRatio;
  const hyst = extent * modeHysteresisRatio;

  if (previousMode === 'sibling-before') {
    if (rel < -band + hyst) return 'sibling-before';
    if (rel > band + hyst) return 'sibling-after';
    return 'child';
  }
  if (previousMode === 'sibling-after') {
    if (rel > band - hyst) return 'sibling-after';
    if (rel < -band - hyst) return 'sibling-before';
    return 'child';
  }
  // child：离开中带需越过更远一点
  if (rel < -band - hyst) return 'sibling-before';
  if (rel > band + hyst) return 'sibling-after';
  return 'child';
}

/** 相对目标垂直位置 → 落点模式（vertical 轴便捷入口，保持既有 API） */
export function resolveDropMode(
  dragCenterY: number,
  target: DropCandidate,
  previousMode: DropMode,
  modeBandRatio = DROP_MODE_BAND_RATIO,
  modeHysteresisRatio = DROP_MODE_HYSTERESIS_RATIO,
): DropMode {
  const targetH = target.height || 36;
  const targetCenterY = target.y + targetH / 2;
  return resolveDropModeAlongAxis(
    dragCenterY - targetCenterY,
    targetH,
    previousMode,
    modeBandRatio,
    modeHysteresisRatio,
  );
}

/** 相对目标水平位置 → 落点模式（horizontal 轴：up/down 布局的左右三分） */
export function resolveDropModeHorizontal(
  dragCenterX: number,
  target: DropCandidate,
  previousMode: DropMode,
  modeBandRatio = DROP_MODE_BAND_RATIO,
  modeHysteresisRatio = DROP_MODE_HYSTERESIS_RATIO,
): DropMode {
  const targetW = target.width || 100;
  const targetCenterX = target.x + targetW / 2;
  return resolveDropModeAlongAxis(
    dragCenterX - targetCenterX,
    targetW,
    previousMode,
    modeBandRatio,
    modeHysteresisRatio,
  );
}

export function resolveDropTarget(input: ResolveDropTargetInput): ResolveDropTargetResult {
  const {
    dragCenterX,
    dragCenterY,
    candidates,
    previousTargetId,
    previousMode,
    orientation = 'vertical',
    radius = DROP_TARGET_RADIUS,
    closestHysteresis = DROP_CLOSEST_HYSTERESIS,
    modeBandRatio = DROP_MODE_BAND_RATIO,
    modeHysteresisRatio = DROP_MODE_HYSTERESIS_RATIO,
  } = input;

  const { targetId, dist } = pickClosestDropTarget(
    dragCenterX,
    dragCenterY,
    candidates,
    previousTargetId,
    radius,
    closestHysteresis,
  );

  if (!targetId) {
    return { targetId: null, mode: 'child', dist };
  }

  const target = candidates.find(c => c.id === targetId);
  if (!target) {
    return { targetId: null, mode: 'child', dist: Infinity };
  }

  // 换目标时用无滞回的三分，避免继承上一目标的 mode 粘性
  const modePrev = targetId === previousTargetId ? previousMode : 'child';
  const mode = orientation === 'horizontal'
    ? resolveDropModeHorizontal(
        dragCenterX,
        target,
        modePrev,
        modeBandRatio,
        modeHysteresisRatio,
      )
    : resolveDropMode(
        dragCenterY,
        target,
        modePrev,
        modeBandRatio,
        modeHysteresisRatio,
      );

  return { targetId, mode, dist };
}

/**
 * 候选预筛：中心距超出半径的候选永远选不中（pick 与滞回均要求 dist < radius），
 * 用轴向包围盒先剔除，避免大图拖拽时每帧为全量节点构造候选对象。
 */
export function isWithinDropRadius(
  dragCenterX: number,
  dragCenterY: number,
  c: DropCandidate,
  radius = DROP_TARGET_RADIUS,
): boolean {
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  return Math.abs(dragCenterX - cx) <= radius && Math.abs(dragCenterY - cy) <= radius;
}
