import React from 'react';
import { BaseEdge, EdgeProps, Position } from '@xyflow/react';
import { getEdgeEmphasis, emphasizedEdgeStyle, withEmphasisClass } from './edgeEmphasis';
import './edges.css';

// 计算直角折线路径（支持水平和垂直主轴方向）
function getOrthogonalPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number = 8,
  verticalFirst: boolean = false
): string {
  // 直线情况
  if (Math.abs(targetX - sourceX) < 1 || Math.abs(targetY - sourceY) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  if (verticalFirst) {
    // 垂直布局（上下方向）：先竖再横再竖
    const midY = (sourceY + targetY) / 2;
    const maxRadius = Math.min(
      Math.abs(targetX - sourceX) / 2,
      Math.abs(midY - sourceY),
      Math.abs(targetY - midY)
    );
    const r = Math.min(cornerRadius, maxRadius);
    const dySign = targetY > sourceY ? 1 : -1;
    const dx = targetX > sourceX ? r : -r;
    return `M ${sourceX} ${sourceY} 
            L ${sourceX} ${midY - dySign * r} 
            Q ${sourceX} ${midY} ${sourceX + dx} ${midY}
            L ${targetX - dx} ${midY}
            Q ${targetX} ${midY} ${targetX} ${midY + dySign * r}
            L ${targetX} ${targetY}`;
  }

  const midX = (sourceX + targetX) / 2;

  // 计算圆角半径（不超过可用空间的一半）
  const maxRadius = Math.min(
    Math.abs(targetY - sourceY) / 2,
    Math.abs(midX - sourceX),
    Math.abs(targetX - midX)
  );
  const r = Math.min(cornerRadius, maxRadius);

  // 水平方向：先横再竖再横
  const dxSign = targetX > sourceX ? 1 : -1;
  const dy = targetY > sourceY ? r : -r;
  return `M ${sourceX} ${sourceY} 
          L ${midX - dxSign * r} ${sourceY} 
          Q ${midX} ${sourceY} ${midX} ${sourceY + dy}
          L ${midX} ${targetY - dy}
          Q ${midX} ${targetY} ${midX + dxSign * r} ${targetY}
          L ${targetX} ${targetY}`;
}

export const OrthogonalEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  id,
  data,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  // 源 Handle 在上/下边 ⇒ 垂直布局，折线主轴应为竖向
  const verticalFirst = sourcePosition === Position.Top || sourcePosition === Position.Bottom;
  const edgePath = getOrthogonalPath(sourceX, sourceY, targetX, targetY, 8, verticalFirst);

  const emphasized = getEdgeEmphasis(data);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className={withEmphasisClass('orthogonal-edge mm-tree-edge', emphasized)}
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
