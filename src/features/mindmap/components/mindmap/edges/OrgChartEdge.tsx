/**
 * 组织结构图专用边组件
 * 
 * 支持两种模式：
 * 1. 从父节点到连接器节点的主干线（垂直或水平）
 * 2. 从连接器节点到子节点的分支线（L形或带圆角）
 */

import React from 'react';
import { BaseEdge, type EdgeProps } from '@xyflow/react';

interface OrgChartEdgeData {
  /** 边类型: trunk=主干线, branch=分支线 */
  edgeMode?: 'trunk' | 'branch';
  /** 布局方向 */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** 从 source handle 到 rail（分叉轨道）的固定偏移量，确保同父兄弟节点的 rail 对齐 */
  railOffset?: number;
}

/**
 * 计算主干线路径（父节点到连接器）
 * 强制画直线（垂直或水平）
 */
function getTrunkPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  direction: string
): string {
  const isVertical = direction === 'up' || direction === 'down';
  
  if (isVertical) {
    // 垂直布局：画垂直线（使用 sourceX）
    return `M ${sourceX} ${sourceY} L ${sourceX} ${targetY}`;
  } else {
    // 水平布局：画水平线（使用 sourceY）
    return `M ${sourceX} ${sourceY} L ${targetX} ${sourceY}`;
  }
}

/**
 * 计算分支线路径（父节点到子节点）
 *
 * 使用 3 段阶梯形路径（trunk → rail → drop）。
 * - 分叉处（trunk→rail，多条边共享）：直角，确保重叠处平整
 * - 非分叉处（rail→drop，各自独立）：圆角，视觉更柔和
 *
 * 垂直布局 (up/down)：竖直 → 水平 → 竖直
 * 水平布局 (left/right)：水平 → 竖直 → 水平
 */
function getBranchPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  direction: string,
  railOffset?: number,
  cornerRadius: number = 6
): string {
  const isVertical = direction === 'up' || direction === 'down';

  // 完全对齐时直接画直线
  if (isVertical && Math.abs(targetX - sourceX) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }
  if (!isVertical && Math.abs(targetY - sourceY) < 1) {
    return `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
  }

  if (isVertical) {
    // ── 垂直布局（up/down）──
    const goingDown = targetY > sourceY;
    // railOffset 确保同父兄弟的 rail 位置一致；无则退化为中点
    const midY = railOffset != null
      ? sourceY + (goingDown ? railOffset : -railOffset)
      : (sourceY + targetY) / 2;
    const goingRight = targetX > sourceX;

    // 圆角仅用于 corner 2（rail→drop，非分叉处）
    const railLen = Math.abs(targetX - sourceX);
    const dropLen = Math.abs(targetY - midY);
    const r = Math.max(0, Math.min(cornerRadius, railLen / 2, dropLen / 2));

    if (r < 1) {
      return `M ${sourceX} ${sourceY} L ${sourceX} ${midY} L ${targetX} ${midY} L ${targetX} ${targetY}`;
    }

    const c2dx = goingRight ? -r : r;
    const c2dy = goingDown ? r : -r;

    return `M ${sourceX} ${sourceY}
            L ${sourceX} ${midY}
            L ${targetX + c2dx} ${midY}
            Q ${targetX} ${midY} ${targetX} ${midY + c2dy}
            L ${targetX} ${targetY}`;
  } else {
    // ── 水平布局（left/right）──
    const goingRight = targetX > sourceX;
    // railOffset 确保同父兄弟的 rail 位置一致；无则退化为中点
    const midX = railOffset != null
      ? sourceX + (goingRight ? railOffset : -railOffset)
      : (sourceX + targetX) / 2;
    const goingDown = targetY > sourceY;

    // 圆角仅用于 corner 2（rail→branch，非分叉处）
    const railLen = Math.abs(targetY - sourceY);
    const branchLen = Math.abs(targetX - midX);
    const r = Math.max(0, Math.min(cornerRadius, railLen / 2, branchLen / 2));

    if (r < 1) {
      return `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`;
    }

    const c2dy = goingDown ? -r : r;
    const c2dx = goingRight ? r : -r;

    return `M ${sourceX} ${sourceY}
            L ${midX} ${sourceY}
            L ${midX} ${targetY + c2dy}
            Q ${midX} ${targetY} ${midX + c2dx} ${targetY}
            L ${targetX} ${targetY}`;
  }
}

export const OrgChartEdge: React.FC<EdgeProps> = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  id,
  data,
  markerEnd,
  markerStart,
  interactionWidth,
  style,
}) => {
  const edgeData = data as OrgChartEdgeData | undefined;
  const edgeMode = edgeData?.edgeMode || 'branch';
  const direction = edgeData?.direction || 'down';
  const railOffset = edgeData?.railOffset;
  
  let edgePath: string;
  
  if (edgeMode === 'trunk') {
    edgePath = getTrunkPath(sourceX, sourceY, targetX, targetY, direction);
  } else {
    edgePath = getBranchPath(sourceX, sourceY, targetX, targetY, direction, railOffset);
  }

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      markerStart={markerStart}
      interactionWidth={interactionWidth}
      className="orgchart-edge"
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

/**
 * 水平组织结构图专用边
 * 与 OrgChartEdge 相同，但默认方向为 right
 */
export const OrgChartHorizontalEdge: React.FC<EdgeProps> = (props) => {
  const edgeData = props.data as OrgChartEdgeData | undefined;
  const newData: Record<string, unknown> = {
    ...edgeData,
    direction: edgeData?.direction || 'right',
  };
  return <OrgChartEdge {...props} data={newData} />;
};
