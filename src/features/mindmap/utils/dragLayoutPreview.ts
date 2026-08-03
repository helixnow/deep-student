/**
 * 拖拽落点插槽预览（ghost 插入线）几何计算
 *
 * 拖拽中根据当前落点目标 + 模式 + 布局方向，算出一条与布局方向一致的
 * 插入指示线（sibling）或「成为子节点」连接短线（child）的 flow 坐标矩形，
 * 由画布经 ViewportPortal 渲染。纯函数，不依赖 ReactFlow 实例。
 */

import type { LayoutDirection } from '../types';
import type { DropMode, DropOrientation } from './dropTarget';

export interface DropPreviewRect {
  /** flow 坐标系下的绝对定位矩形 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** insert：兄弟插入线；child-link：指向目标的「成为子节点」短线 */
  kind: 'insert' | 'child-link';
  /** 线的走向（水平线 / 垂直线），用于选取 CSS 变体 */
  axis: 'h' | 'v';
}

export interface ComputeDropPreviewInput {
  target: { x: number; y: number; width: number; height: number };
  mode: DropMode;
  /** 兄弟排列轴（dropOrientationForDirection 的结果） */
  orientation: DropOrientation;
  /** 当前布局方向，用于 child 模式判断子节点生长侧 */
  layoutDirection: LayoutDirection | string;
  /** 拖拽中节点中心，用于 both/radial 布局判断左右侧 */
  dragCenterX: number;
  dragCenterY: number;
}

/** 插入线粗细（px，flow 坐标） */
export const DROP_PREVIEW_THICKNESS = 3;
/** 插入线距目标节点边缘的间隙 */
export const DROP_PREVIEW_GAP = 6;
/** 插入线相对目标节点在排列轴垂直方向上的外延 */
export const DROP_PREVIEW_OVERHANG = 10;
/** child 连接短线长度 */
export const DROP_PREVIEW_CHILD_LINK_LENGTH = 22;

/** child 模式下子节点的生长侧：right/left/down/up；both/radial 按拖拽位置就近取左右 */
export function resolveChildGrowthSide(
  layoutDirection: LayoutDirection | string,
  target: { x: number; y: number; width: number; height: number },
  dragCenterX: number,
): 'left' | 'right' | 'up' | 'down' {
  switch (layoutDirection) {
    case 'left':
      return 'left';
    case 'up':
      return 'up';
    case 'down':
      return 'down';
    case 'both':
    case 'radial': {
      const targetCenterX = target.x + target.width / 2;
      return dragCenterX < targetCenterX ? 'left' : 'right';
    }
    case 'right':
    default:
      return 'right';
  }
}

export function computeDropPreview(input: ComputeDropPreviewInput): DropPreviewRect | null {
  const { target, mode, orientation, layoutDirection, dragCenterX } = input;

  if (mode === 'child') {
    // 「成为子节点」：从目标节点子侧边缘中点向外画一条短线，指示挂接方向
    const side = resolveChildGrowthSide(layoutDirection, target, dragCenterX);
    const midY = target.y + target.height / 2 - DROP_PREVIEW_THICKNESS / 2;
    const midX = target.x + target.width / 2 - DROP_PREVIEW_THICKNESS / 2;
    switch (side) {
      case 'left':
        return {
          left: target.x - DROP_PREVIEW_GAP - DROP_PREVIEW_CHILD_LINK_LENGTH,
          top: midY,
          width: DROP_PREVIEW_CHILD_LINK_LENGTH,
          height: DROP_PREVIEW_THICKNESS,
          kind: 'child-link',
          axis: 'h',
        };
      case 'up':
        return {
          left: midX,
          top: target.y - DROP_PREVIEW_GAP - DROP_PREVIEW_CHILD_LINK_LENGTH,
          width: DROP_PREVIEW_THICKNESS,
          height: DROP_PREVIEW_CHILD_LINK_LENGTH,
          kind: 'child-link',
          axis: 'v',
        };
      case 'down':
        return {
          left: midX,
          top: target.y + target.height + DROP_PREVIEW_GAP,
          width: DROP_PREVIEW_THICKNESS,
          height: DROP_PREVIEW_CHILD_LINK_LENGTH,
          kind: 'child-link',
          axis: 'v',
        };
      case 'right':
      default:
        return {
          left: target.x + target.width + DROP_PREVIEW_GAP,
          top: midY,
          width: DROP_PREVIEW_CHILD_LINK_LENGTH,
          height: DROP_PREVIEW_THICKNESS,
          kind: 'child-link',
          axis: 'h',
        };
    }
  }

  const before = mode === 'sibling-before';
  if (orientation === 'horizontal') {
    // up/down 布局：兄弟左右排列 → 垂直插入线（before=左侧，after=右侧）
    const left = before
      ? target.x - DROP_PREVIEW_GAP - DROP_PREVIEW_THICKNESS
      : target.x + target.width + DROP_PREVIEW_GAP;
    return {
      left,
      top: target.y - DROP_PREVIEW_OVERHANG,
      width: DROP_PREVIEW_THICKNESS,
      height: target.height + DROP_PREVIEW_OVERHANG * 2,
      kind: 'insert',
      axis: 'v',
    };
  }

  // left/right/both 布局：兄弟上下排列 → 水平插入线（before=上方，after=下方）
  const top = before
    ? target.y - DROP_PREVIEW_GAP - DROP_PREVIEW_THICKNESS
    : target.y + target.height + DROP_PREVIEW_GAP;
  return {
    left: target.x - DROP_PREVIEW_OVERHANG,
    top,
    width: target.width + DROP_PREVIEW_OVERHANG * 2,
    height: DROP_PREVIEW_THICKNESS,
    kind: 'insert',
    axis: 'h',
  };
}

/** 浅比较两个预览矩形，避免拖拽中每帧 setState */
export function dropPreviewEquals(a: DropPreviewRect | null, b: DropPreviewRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.kind === b.kind &&
    a.axis === b.axis
  );
}
