/**
 * 连接器节点组件
 * 
 * 用于组织结构图的连接线分支，是一个微小的不可见点节点
 * 所有子节点的边都从这个连接器节点出发
 */

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

interface ConnectorNodeData {
  /** 布局方向 */
  direction?: 'up' | 'down' | 'left' | 'right';
  /** 子节点数量 */
  childCount?: number;
}

// 连接器尺寸（必须 > 0 才能让 ReactFlow 正确计算 Handle 位置）
const CONNECTOR_SIZE = 2;

/**
 * 连接器节点
 * 一个微小的不可见节点，用于组织结构图的连接线分支
 */
export const ConnectorNode: React.FC<NodeProps> = ({ data }) => {
  const nodeData = data as ConnectorNodeData | undefined;
  const direction = nodeData?.direction || 'down';
  
  // 根据方向确定 Handle 位置
  let targetPosition: Position;
  let sourcePosition: Position;
  
  switch (direction) {
    case 'up':
      targetPosition = Position.Bottom;
      sourcePosition = Position.Top;
      break;
    case 'down':
      targetPosition = Position.Top;
      sourcePosition = Position.Bottom;
      break;
    case 'left':
      targetPosition = Position.Right;
      sourcePosition = Position.Left;
      break;
    case 'right':
      targetPosition = Position.Left;
      sourcePosition = Position.Right;
      break;
    default:
      targetPosition = Position.Top;
      sourcePosition = Position.Bottom;
  }
  
  // Handle 样式：微小但存在
  const handleStyle: React.CSSProperties = {
    width: 1,
    height: 1,
    minWidth: 1,
    minHeight: 1,
    background: 'transparent',
    border: 'none',
  };
  
  return (
    <div 
      className="connector-node" 
      style={{ 
        width: CONNECTOR_SIZE, 
        height: CONNECTOR_SIZE,
        opacity: 0,
        pointerEvents: 'none',
      }}
    >
      {/* Target handle - 连接到父节点 */}
      <Handle
        type="target"
        position={targetPosition}
        style={handleStyle}
        isConnectable={false}
      />
      {/* Source handle - 连接到子节点 */}
      <Handle
        type="source"
        position={sourcePosition}
        style={handleStyle}
        isConnectable={false}
      />
    </div>
  );
};
