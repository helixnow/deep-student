/** 画布节点拖放落点解析：最近邻 + 垂直三分 + 可选滞回 */

export type DropMode = 'child' | 'sibling-before' | 'sibling-after';

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

/** 相对目标垂直位置 → 落点模式；对当前模式做滞回，减少边界闪烁 */
export function resolveDropMode(
  dragCenterY: number,
  target: DropCandidate,
  previousMode: DropMode,
  modeBandRatio = DROP_MODE_BAND_RATIO,
  modeHysteresisRatio = DROP_MODE_HYSTERESIS_RATIO,
): DropMode {
  const targetH = target.height || 36;
  const targetCenterY = target.y + targetH / 2;
  const relY = dragCenterY - targetCenterY;
  const band = targetH * modeBandRatio;
  const hyst = targetH * modeHysteresisRatio;

  if (previousMode === 'sibling-before') {
    if (relY < -band + hyst) return 'sibling-before';
    if (relY > band + hyst) return 'sibling-after';
    return 'child';
  }
  if (previousMode === 'sibling-after') {
    if (relY > band - hyst) return 'sibling-after';
    if (relY < -band - hyst) return 'sibling-before';
    return 'child';
  }
  // child：离开中带需越过更远一点
  if (relY < -band - hyst) return 'sibling-before';
  if (relY > band + hyst) return 'sibling-after';
  return 'child';
}

export function resolveDropTarget(input: ResolveDropTargetInput): ResolveDropTargetResult {
  const {
    dragCenterX,
    dragCenterY,
    candidates,
    previousTargetId,
    previousMode,
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
  const mode = resolveDropMode(
    dragCenterY,
    target,
    modePrev,
    modeBandRatio,
    modeHysteresisRatio,
  );

  return { targetId, mode, dist };
}
