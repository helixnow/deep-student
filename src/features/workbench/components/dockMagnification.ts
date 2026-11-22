/**
 * dockMagnification — macOS 26/27 Liquid Glass Dock 连续波浪放大纯物理计算模块
 *
 * 设计特点：
 * - 纯函数、零 React / DOM 依赖，可被 rAF 循环与单测直接消费；
 * - 采用 C¹ 连续升余弦钟形曲线（raised cosine bell）：中心处平滑达峰、
 *   边缘（d >= radius）平滑归零且导数为 0，杜绝截断高斯造成的边界跳变；
 * - 同步输出每个图标的连续 `scale`、向上抬升 `liftY`（负值）、水平弹性推开
 *   `offsetX`（以指针为中心向外平滑推开、远端归零不溢出玻璃托盘）及顶边总抬升
 *   `topLiftPx`（供 0ms Tooltip 会话实时避让放大后的图标顶边）。
 */

export const DEFAULT_MAG_RADIUS_PX = 136;
export const DEFAULT_MAG_MAX_SCALE = 1.38;
export const MIN_MAG_MAX_SCALE = 1.0;
export const MAX_MAG_MAX_SCALE = 1.75;
export const DEFAULT_MAG_ICON_SIZE_PX = 44;
export const DEFAULT_MAG_LIFT_RATIO = 0.28;
export const DEFAULT_MAG_PUSH_RATIO = 0.96;
const PUSH_RADIUS_MULTIPLIER = 1.5;

export interface DockMagnificationConfig {
  /** 波浪影响半径（px），默认 136 */
  radius?: number;
  /** 最大放大倍率（[1.0, 1.75]），默认 1.38 */
  maxScale?: number;
  /** 单个图标基准边长（px，可按 dockScale 缩放），默认 44 */
  iconSize?: number;
  /** 附加抬升系数（叠加在 transform-origin: 50% 100% 自然增高之上），默认 0.28 */
  liftRatio?: number;
  /** 邻近图标水平推开系数，默认 0.96 */
  pushRatio?: number;
}

export interface DockItemMagnification {
  /** 连续缩放倍率（>= 1） */
  scale: number;
  /** 向上抬升位移（px，<= 0） */
  liftY: number;
  /** 水平弹性推开位移（px；指针左侧为负，右侧为正，正下方与远端为 0） */
  offsetX: number;
  /** 归一化波浪权重 [0, 1]，供接触阴影扩散与层级提升消费 */
  weight: number;
  /** 图标顶边相对静止状态的总抬升距离（px，>= 0），供 Tooltip 避让 */
  topLiftPx: number;
}

const NEUTRAL_ITEM: DockItemMagnification = Object.freeze({
  scale: 1,
  liftY: 0,
  offsetX: 0,
  weight: 0,
  topLiftPx: 0,
});

export function clampMagnificationScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_MAG_MAX_SCALE;
  return Math.max(MIN_MAG_MAX_SCALE, Math.min(MAX_MAG_MAX_SCALE, scale));
}

/**
 * 升余弦钟形权重：distance === 0 时为 1，distance >= radius 时平滑归 0。
 */
export function computeMagnificationWeight(distancePx: number, radiusPx: number): number {
  if (!Number.isFinite(distancePx) || !Number.isFinite(radiusPx) || radiusPx <= 0) return 0;
  const absDist = Math.abs(distancePx);
  if (absDist >= radiusPx) return 0;
  const t = absDist / radiusPx;
  return 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * 计算 Dock 中每个图标在给定指针 X 下的连续放大、抬升与水平推开参数。
 */
export function computeDockMagnification(
  pointerX: number | null,
  itemCentersX: readonly number[],
  config?: DockMagnificationConfig,
): DockItemMagnification[] {
  const count = itemCentersX.length;
  if (count === 0) return [];

  const radius = config?.radius ?? DEFAULT_MAG_RADIUS_PX;
  const maxScale = clampMagnificationScale(config?.maxScale ?? DEFAULT_MAG_MAX_SCALE);
  const iconSize = config?.iconSize ?? DEFAULT_MAG_ICON_SIZE_PX;
  const liftRatio = config?.liftRatio ?? DEFAULT_MAG_LIFT_RATIO;
  const pushRatio = config?.pushRatio ?? DEFAULT_MAG_PUSH_RATIO;

  if (
    pointerX === null ||
    !Number.isFinite(pointerX) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    !Number.isFinite(iconSize) ||
    iconSize <= 0 ||
    maxScale <= MIN_MAG_MAX_SCALE
  ) {
    return itemCentersX.map(() => ({ ...NEUTRAL_ITEM }));
  }

  const maxDeltaScale = maxScale - 1;
  const pushRadius = radius * PUSH_RADIUS_MULTIPLIER;
  const pushAmplitude = maxDeltaScale * iconSize * pushRatio;

  return itemCentersX.map((centerX) => {
    if (!Number.isFinite(centerX)) return { ...NEUTRAL_ITEM };
    const delta = centerX - pointerX;
    const absDelta = Math.abs(delta);
    const weight = computeMagnificationWeight(absDelta, radius);
    const scale = 1 + maxDeltaScale * weight;
    const extraHeight = (scale - 1) * iconSize;
    const liftY = extraHeight > 0 ? -(extraHeight * liftRatio) : 0;
    const topLiftPx = extraHeight + Math.abs(liftY);

    let offsetX = 0;
    if (absDelta > 0 && absDelta < pushRadius) {
      const u = absDelta / pushRadius;
      // 非对称平滑波包：紧邻指针处迅速建立避让间距，远端平滑归零不溢出 Dock 边缘
      const pushEnvelope = Math.sin(Math.PI * Math.pow(u, 0.78));
      offsetX = Math.sign(delta) * pushAmplitude * pushEnvelope;
    }

    return {
      scale,
      liftY,
      offsetX,
      weight,
      topLiftPx,
    };
  });
}

/**
 * 将视口指针 X 归一化为 Dock 内部横向百分比（0..100），供 `--wb-dock-cursor-x` 扫光消费。
 */
export function computeDockCursorPercent(
  pointerX: number | null,
  dockLeft: number,
  dockWidth: number,
): number | null {
  if (
    pointerX === null ||
    !Number.isFinite(pointerX) ||
    !Number.isFinite(dockLeft) ||
    !Number.isFinite(dockWidth) ||
    dockWidth <= 0
  ) {
    return null;
  }
  const ratio = (pointerX - dockLeft) / dockWidth;
  return Math.max(0, Math.min(100, ratio * 100));
}
