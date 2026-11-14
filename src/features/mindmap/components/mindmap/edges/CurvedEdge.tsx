import React from 'react';
import { BaseEdge, EdgeProps, Position } from '@xyflow/react';
import { getEdgeEmphasis, emphasizedEdgeStyle, withEmphasisClass } from './edgeEmphasis';
import './edges.css';

/**
 * 获取更紧致的思维导图专用贝塞尔路径
 * 
 * 相比默认的 getBezierPath，这个实现：
 * 1. 减少了控制点的曲率，使线条看起来更“有力”。
 * 2. 避免了“懒惰”的大弧线。
 * 3. 按 Handle 的 Position 分轴计算张力：水平布局用 dx、垂直布局用 dy，
 *    上下布局（top/bottom）不再套用水平公式导致曲率粗糙。
 */
function getMindMapPath({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
}: {
  sourceX: number;
  sourceY: number;
  sourcePosition: Position;
  targetX: number;
  targetY: number;
  targetPosition: Position;
}): string {
  const dx = Math.abs(targetX - sourceX);
  const dy = Math.abs(targetY - sourceY);

  // 该端出线方向上的张力：平滑连续的非对称 S 型张力公式（消除 main < 100 的阶跃折角突变）；
  // 出线端（isSource=true）张力略饱满、入线端（isSource=false）张力轻盈顺滑，
  // 主轴距离趋近 0 时用副轴补一点最小张力，避免 S 形塌成硬折线
  const tensionFor = (pos: Position, isSource: boolean): number => {
    const isHorizontal = pos === Position.Left || pos === Position.Right;
    const main = isHorizontal ? dx : dy;
    const cross = isHorizontal ? dy : dx;
    const smoothRatio = Math.min(1, main / 160);
    const baseCurvature = 0.32 + smoothRatio * 0.08;
    const roleFactor = isSource ? 1.06 : 0.92;
    const crossSupport = Math.min(cross * 0.22, 28);
    return Math.max(main * baseCurvature * roleFactor, crossSupport, 12);
  };

  let controlX1 = sourceX;
  let controlY1 = sourceY;
  let controlX2 = targetX;
  let controlY2 = targetY;

  switch (sourcePosition) {
    case Position.Left:
      controlX1 = sourceX - tensionFor(sourcePosition, true);
      break;
    case Position.Right:
      controlX1 = sourceX + tensionFor(sourcePosition, true);
      break;
    case Position.Top:
      controlY1 = sourceY - tensionFor(sourcePosition, true);
      break;
    case Position.Bottom:
      controlY1 = sourceY + tensionFor(sourcePosition, true);
      break;
  }

  switch (targetPosition) {
    case Position.Left:
      controlX2 = targetX - tensionFor(targetPosition, false);
      break;
    case Position.Right:
      controlX2 = targetX + tensionFor(targetPosition, false);
      break;
    case Position.Top:
      controlY2 = targetY - tensionFor(targetPosition, false);
      break;
    case Position.Bottom:
      controlY2 = targetY + tensionFor(targetPosition, false);
      break;
  }

  return `M${sourceX},${sourceY} C${controlX1},${controlY1} ${controlX2},${controlY2} ${targetX},${targetY}`;
}

export const CurvedEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  id,
  data,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  const edgePath = getMindMapPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const emphasized = getEdgeEmphasis(data);
  const sourceLevel = (data as { sourceLevel?: number } | undefined)?.sourceLevel;
  const taperedStrokeWidth =
    sourceLevel === 0 ? 1.8 : sourceLevel === 1 ? 1.35 : sourceLevel != null ? 1.05 : 1.5;
  const taperedOpacity =
    sourceLevel === 0 ? 0.92 : sourceLevel === 1 ? 0.78 : sourceLevel != null ? 0.65 : 1;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className={withEmphasisClass('tree-edge mm-tree-edge', emphasized)}
      style={{ 
        strokeWidth: taperedStrokeWidth,
        opacity: taperedOpacity,
        stroke: 'var(--mm-edge)',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
        ...style,
        ...emphasizedEdgeStyle(emphasized),
      }}
    />
  );
};
