import React from 'react';
import { BaseEdge, EdgeProps, Position } from '@xyflow/react';

/**
 * 获取更紧致的思维导图专用贝塞尔路径
 * 
 * 相比默认的 getBezierPath，这个实现：
 * 1. 减少了控制点的曲率，使线条看起来更“有力”。
 * 2. 避免了“懒惰”的大弧线。
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
  // const dy = Math.abs(targetY - sourceY);

  // 动态曲率系数：距离越近，曲率越小，线条越直
  // 默认 ReactFlow 是 0.5
  let curvature = 0.4;
  
  if (dx < 100) {
    curvature = 0.3;
  }
  
  // 计算控制点
  // 假设主要是水平布局 (Left/Right)
  // 如果是垂直布局，逻辑需要反转 (这里简化处理，因为 Tree 主要用于水平)
  
  let controlX1 = sourceX;
  let controlY1 = sourceY;
  let controlX2 = targetX;
  let controlY2 = targetY;

  switch (sourcePosition) {
    case Position.Left:
      controlX1 = sourceX - dx * curvature;
      break;
    case Position.Right:
      controlX1 = sourceX + dx * curvature;
      break;
    case Position.Top:
      controlY1 = sourceY - dx * curvature; // 使用 dx 保持张力
      break;
    case Position.Bottom:
      controlY1 = sourceY + dx * curvature;
      break;
  }

  switch (targetPosition) {
    case Position.Left:
      controlX2 = targetX - dx * curvature;
      break;
    case Position.Right:
      controlX2 = targetX + dx * curvature;
      break;
    case Position.Top:
      controlY2 = targetY - dx * curvature;
      break;
    case Position.Bottom:
      controlY2 = targetY + dx * curvature;
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

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className="tree-edge"
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
