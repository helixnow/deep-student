/**
 * 节点组件聚合导出
 */

import type { NodeTypes } from '@xyflow/react';
import { RootNode, type RootNodeData } from './RootNode';
import { BranchNode, type BranchNodeData } from './BranchNode';
import { ConnectorNode } from './ConnectorNode';

// 导出组件
export { NodeContent, type NodeContentProps } from './NodeContent';
export { RootNode, type RootNodeData } from './RootNode';
export { BranchNode, type BranchNodeData } from './BranchNode';
export { ConnectorNode } from './ConnectorNode';

// 节点类型注册（默认节点类型）
export const nodeTypes: NodeTypes = {
  rootNode: RootNode as any,
  branchNode: BranchNode as any,
  connectorNode: ConnectorNode as any,
};

