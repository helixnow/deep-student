import React from 'react';
import { BaseEdge, EdgeProps } from '@xyflow/react';

// 计算阶梯路径（垂直布局用 - 支持向上和向下）
function getStepPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number = 4
): string {
  // 判断是向下还是向上
  const isDownward = targetY > sourceY;
  const midY = (sourceY + targetY) / 2;
  
  // 垂直对齐，直接直线
  if (Math.abs(targetX - sourceX) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  
  // 水平对齐，直接直线
  if (Math.abs(targetY - sourceY) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  
  const r = Math.min(
    cornerRadius, 
    Math.abs(targetX - sourceX) / 2, 
    Math.abs(midY - sourceY)
  );
  const dx = targetX > sourceX ? r : -r;
  
  if (isDownward) {
    // 向下布局：先下再横再下
    return `M ${sourceX} ${sourceY}
            L ${sourceX} ${midY - r}
            Q ${sourceX} ${midY} ${sourceX + dx} ${midY}
            L ${targetX - dx} ${midY}
            Q ${targetX} ${midY} ${targetX} ${midY + r}
            L ${targetX} ${targetY}`;
  } else {
    // 向上布局：先上再横再上
    return `M ${sourceX} ${sourceY}
            L ${sourceX} ${midY + r}
            Q ${sourceX} ${midY} ${sourceX + dx} ${midY}
            L ${targetX - dx} ${midY}
            Q ${targetX} ${midY} ${targetX} ${midY - r}
            L ${targetX} ${targetY}`;
  }
}

export const StepEdge: React.FC<EdgeProps> = ({
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
  const edgePath = getStepPath(sourceX, sourceY, targetX, targetY, 4);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className="step-edge"
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
