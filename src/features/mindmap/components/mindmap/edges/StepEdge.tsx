import React from 'react';
import { BaseEdge, EdgeProps, Position } from '@xyflow/react';
import { getEdgeEmphasis, emphasizedEdgeStyle, withEmphasisClass } from './edgeEmphasis';
import './edges.css';

// 计算阶梯路径（按主轴方向适配：垂直布局先竖、水平布局先横）
function getStepPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  cornerRadius: number = 4,
  horizontalFirst: boolean = false
): string {
  // 垂直或水平对齐，直接直线
  if (Math.abs(targetX - sourceX) < 1 || Math.abs(targetY - sourceY) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  if (horizontalFirst) {
    // 水平布局（源 Handle 在左/右）：先横再竖再横
    const midX = (sourceX + targetX) / 2;
    const r = Math.min(
      cornerRadius,
      Math.abs(targetY - sourceY) / 2,
      Math.abs(midX - sourceX)
    );
    const dxSign = targetX > sourceX ? 1 : -1;
    const dy = targetY > sourceY ? r : -r;
    return `M ${sourceX} ${sourceY}
            L ${midX - dxSign * r} ${sourceY}
            Q ${midX} ${sourceY} ${midX} ${sourceY + dy}
            L ${midX} ${targetY - dy}
            Q ${midX} ${targetY} ${midX + dxSign * r} ${targetY}
            L ${targetX} ${targetY}`;
  }

  // 垂直布局：先竖再横再竖（支持向上和向下）
  const isDownward = targetY > sourceY;
  const midY = (sourceY + targetY) / 2;

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
  sourcePosition,
  id,
  data,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  // 源 Handle 在左/右边 ⇒ 水平布局，阶梯主轴应为横向
  const horizontalFirst =
    sourcePosition === Position.Left || sourcePosition === Position.Right;
  const edgePath = getStepPath(sourceX, sourceY, targetX, targetY, 4, horizontalFirst);

  const emphasized = getEdgeEmphasis(data);

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className={withEmphasisClass('step-edge mm-tree-edge', emphasized)}
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
