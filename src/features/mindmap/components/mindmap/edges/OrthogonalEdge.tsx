import React from 'react';
import { BaseEdge, EdgeProps } from '@xyflow/react';

// 计算直角折线路径（支持水平和垂直方向）
function getOrthogonalPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number = 8
): string {
  // 直线情况
  if (Math.abs(targetX - sourceX) < 1 || Math.abs(targetY - sourceY) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
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
  if (targetX > sourceX) {
    // 向右
    const dy = targetY > sourceY ? r : -r;
    return `M ${sourceX} ${sourceY} 
            L ${midX - r} ${sourceY} 
            Q ${midX} ${sourceY} ${midX} ${sourceY + dy}
            L ${midX} ${targetY - dy}
            Q ${midX} ${targetY} ${midX + r} ${targetY}
            L ${targetX} ${targetY}`;
  } else {
    // 向左
    const dy = targetY > sourceY ? r : -r;
    return `M ${sourceX} ${sourceY} 
            L ${midX + r} ${sourceY} 
            Q ${midX} ${sourceY} ${midX} ${sourceY + dy}
            L ${midX} ${targetY - dy}
            Q ${midX} ${targetY} ${midX - r} ${targetY}
            L ${targetX} ${targetY}`;
  }
}

export const OrthogonalEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  id,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  const edgePath = getOrthogonalPath(sourceX, sourceY, targetX, targetY, 8);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className="orthogonal-edge"
      style={{
        strokeWidth: 1.5,
        stroke: 'var(--mm-edge)',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
        ...style,
      }}
    />
  );
};
