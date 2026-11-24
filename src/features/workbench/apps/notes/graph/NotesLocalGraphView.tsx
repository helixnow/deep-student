/**
 * 局部图谱的 ReactFlow 渲染层。@xyflow/react 体积大，本文件只经
 * NotesGraphTab 的 React.lazy 引入 —— 不展示图谱页时不进启动 chunk
 *（与 NotesWorkspaceApp 里导图视图的懒加载策略一致）。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Background,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  layoutLocalGraph,
  type LocalGraphData,
  type LocalGraphNodeDatum,
} from './localGraph';
import './NotesLocalGraph.css';

interface GraphNodeData extends Record<string, unknown> {
  title: string;
  degree: 0 | 1 | 2;
  exists: boolean;
  currentBadge: string;
}

type GraphFlowNode = Node<GraphNodeData, 'localGraphNode'>;

const GraphNodeView: React.FC<NodeProps<GraphFlowNode>> = ({ data }) => {
  const isActive = data.degree === 0;
  return (
    <button
      type="button"
      className="notes-graph-node"
      data-degree={data.degree}
      data-active={isActive ? 'true' : undefined}
      data-ghost={data.exists ? undefined : 'true'}
      aria-current={isActive ? 'page' : undefined}
      aria-label={isActive ? `${data.title} (${data.currentBadge})` : data.title}
      title={data.title}
    >
      {/* 隐形连接柄：仅为让边有锚点，视觉上不存在 */}
      <Handle type="target" position={Position.Top} className="notes-graph-handle" isConnectable={false} />
      <span className="notes-graph-node-dot" aria-hidden="true" />
      <span className="notes-graph-node-label">{data.title}</span>
      {isActive && <span className="notes-graph-node-badge">{data.currentBadge}</span>}
      <Handle type="source" position={Position.Bottom} className="notes-graph-handle" isConnectable={false} />
    </button>
  );
};

const nodeTypes = { localGraphNode: GraphNodeView };

export interface NotesLocalGraphViewProps {
  data: LocalGraphData;
  /** 点击可打开的真实笔记节点（幽灵节点不回调） */
  onOpenNode: (node: LocalGraphNodeDatum) => void;
  ariaLabel: string;
}

export const NotesLocalGraphView: React.FC<NotesLocalGraphViewProps> = ({
  data,
  onOpenNode,
  ariaLabel,
}) => {
  const { t } = useTranslation('notes');
  const currentBadge = t('workspace.graphCurrentNode', { defaultValue: '当前' });
  const wikilinkLabel = t('workspace.graphEdgeWikilink', { defaultValue: '双链' });
  const noterefLabel = t('workspace.graphEdgeNoteref', { defaultValue: '引用' });

  const { nodes, edges } = useMemo(() => {
    const positioned = layoutLocalGraph(data);
    const flowNodes: GraphFlowNode[] = positioned.map((node) => ({
      id: node.id,
      type: 'localGraphNode',
      position: { x: node.x, y: node.y },
      data: { title: node.title, degree: node.degree, exists: node.exists, currentBadge },
      // 节点以中心点定位（同心圆坐标即节点中心）
      origin: [0.5, 0.5] as [number, number],
      draggable: true,
      connectable: false,
      focusable: true,
      ariaLabel: node.title,
    }));
    const flowEdges: Edge[] = data.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'straight',
      focusable: false,
      label: edge.kind === 'noteref' ? noterefLabel : wikilinkLabel,
      labelStyle: { fontSize: 9.5, fill: 'hsl(var(--muted-foreground))' },
      labelBgStyle: { fill: 'hsl(var(--background) / 86%)' },
      labelBgPadding: [4, 1.5] as [number, number],
      labelBgBorderRadius: 4,
      // 按链接类型分色（RemNote 图谱心智）：unknown 与 wikilink 共用中性样式
      className: `notes-graph-edge notes-graph-edge-${edge.kind}`,
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [currentBadge, data, noterefLabel, wikilinkLabel]);

  const onNodeClick: NodeMouseHandler<GraphFlowNode> = (_event, node) => {
    if (!node.data.exists) return;
    onOpenNode({
      id: node.id,
      title: node.data.title,
      degree: node.data.degree,
      exists: node.data.exists,
    });
  };

  return (
    <div className="notes-graph-canvas" role="application" aria-label={ariaLabel}>
      <ReactFlow<GraphFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        edgesFocusable={false}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
      </ReactFlow>
    </div>
  );
};

export default NotesLocalGraphView;
