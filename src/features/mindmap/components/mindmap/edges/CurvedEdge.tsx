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

  // 该端出线方向上的张力：主轴距离决定曲率（近直远曲）；
  // 主轴距离趋近 0 时用副轴补一点最小张力，避免 S 形塌成硬折线
  const tensionFor = (pos: Position): number => {
    const isHorizontal = pos === Position.Left || pos === Position.Right;
    const main = isHorizontal ? dx : dy;
    const cross = isHorizontal ? dy : dx;
    const curvature = main < 100 ? 0.3 : 0.4;
    return Math.max(main * curvature, Math.min(cross * 0.25, 32));
  };

  let controlX1 = sourceX;
  let controlY1 = sourceY;
  let controlX2 = targetX;
  let controlY2 = targetY;

  switch (sourcePosition) {
    case Position.Left:
      controlX1 = sourceX - tensionFor(sourcePosition);
      break;
    case Position.Right:
      controlX1 = sourceX + tensionFor(sourcePosition);
      break;
    case Position.Top:
      controlY1 = sourceY - tensionFor(sourcePosition);
      break;
    case Position.Bottom:
      controlY1 = sourceY + tensionFor(sourcePosition);
      break;
  }

  switch (targetPosition) {
    case Position.Left:
      controlX2 = targetX - tensionFor(targetPosition);
      break;
    case Position.Right:
      controlX2 = targetX + tensionFor(targetPosition);
      break;
    case Position.Top:
      controlY2 = targetY - tensionFor(targetPosition);
      break;
    case Position.Bottom:
      controlY2 = targetY + tensionFor(targetPosition);
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

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className={withEmphasisClass('tree-edge mm-tree-edge', emphasized)}
      style={{ 
        strokeWidth: 1.5,
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
