import React, { useCallback, useMemo, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider,
  Node,
  type NodeChange,
  type Connection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useMindMapStore } from '../../store';
import { LayoutRegistry, StyleRegistry } from '../../registry';
import { ensureInitialized } from '../../init';
import { DEFAULT_LAYOUT_CONFIG, REACTFLOW_CONFIG, ROOT_NODE_STYLE, calculateBaseNodeHeight } from '../../constants';
import { nodeTypes as defaultNodeTypes } from './nodes';
import { edgeTypes as defaultEdgeTypes } from './edges';
import { useMindMapKeyboard } from '../../hooks/useMindMapKeyboard';
import { useMindMapClipboard } from '../../hooks/useMindMapClipboard';
import { CanvasContextMenu } from './CanvasContextMenu';
import { MindMapResourcePicker } from './MindMapResourcePicker';
import { findNodeById, findParentNode, isDescendantOf } from '../../utils/node/find';
import { useTranslation } from 'react-i18next';
import type { LayoutDirection, MindMapNode } from '../../types';
import type { ILayoutEngine } from '../../registry/types';

type DropMode = 'child' | 'sibling-before' | 'sibling-after';
// 临时诊断开关：关闭所有与 hover 模糊相关的可疑动画/透明度联动。
const DISABLE_HOVER_BLUR_FACTORS = true;

const MindMapCanvasInner: React.FC = () => {
  ensureInitialized();
  const { t } = useTranslation('mindmap');

  const document = useMindMapStore(s => s.document);
  const setFocusedNodeId = useMindMapStore(s => s.setFocusedNodeId);
  const focusedNodeId = useMindMapStore(s => s.focusedNodeId);
  const selection = useMindMapStore(s => s.selection);
  const setSelection = useMindMapStore(s => s.setSelection);
  const layoutId = useMindMapStore(s => s.layoutId);
  const layoutDirection = useMindMapStore(s => s.layoutDirection);
  const edgeType = useMindMapStore(s => s.edgeType);
  const styleId = useMindMapStore(s => s.styleId);
  const measuredNodeHeights = useMindMapStore(s => s.measuredNodeHeights);
  const reciteMode = useMindMapStore(s => s.reciteMode);
  // M-078: 导出时禁用虚拟化，确保所有节点都被渲染
  const isExporting = useMindMapStore(s => s.isExporting);
  const reactFlowInstance = useReactFlow();
  const { fitView, setCenter, getNodes, getZoom } = reactFlowInstance;
  const hasFitView = useRef(false);
  const prevFocusedNodeId = useRef<string | null>(null);

  useMindMapKeyboard();
  useMindMapClipboard();

  // 注册 ReactFlow 实例到 store，供图片导出使用
  const setReactFlowGetter = useMindMapStore(s => s.setReactFlowGetter);
  useEffect(() => {
    const getter = () => reactFlowInstance;
    setReactFlowGetter(getter);
    return () => setReactFlowGetter(null);
  }, [reactFlowInstance, setReactFlowGetter]);

  const addNodeRef = useMindMapStore(s => s.addNodeRef);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    nodeId: string | null;
  }>({ isOpen: false, position: { x: 0, y: 0 }, nodeId: null });

  const [resourcePickerNodeId, setResourcePickerNodeId] = useState<string | null>(null);

  const handleResourcePickerSelect = useCallback((ref: import('../../types').MindMapNodeRef) => {
    if (resourcePickerNodeId) {
      addNodeRef(resourcePickerNodeId, ref);
    }
  }, [resourcePickerNodeId, addNodeRef]);

  const handleResourcePickerClose = useCallback(() => {
    setResourcePickerNodeId(null);
  }, []);

  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropMode, setDropMode] = useState<DropMode>('child');
  const [isDragging, setIsDragging] = useState(false);
  const dragNodeIdRef = useRef<string | null>(null);
  const [dragPositionOverride, setDragPositionOverride] = useState<Record<string, { x: number; y: number }>>({});
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  // 拖拽子树：记录所有后代节点相对于被拖节点的偏移
  const dragSubtreeOffsetsRef = useRef<Record<string, { dx: number; dy: number }>>({});

  // 获取当前布局引擎
  const layoutEngine = useMemo<ILayoutEngine | undefined>(() => {
    const engine = LayoutRegistry.get(layoutId);
    if (!engine) {
      return LayoutRegistry.get('tree');
    }
    return engine;
  }, [layoutId]);

  // 使用注册系统获取布局引擎并计算布局
  const { nodes: layoutNodes, edges } = useMemo(() => {
    if (!document?.root) {
      return { nodes: [], edges: [] };
    }

    if (!layoutEngine) {
      console.warn(`Layout engine "${layoutId}" not found and no default available`);
      return { nodes: [], edges: [] };
    }

    // 确保方向有效
    const validDirection = layoutEngine.directions.includes(layoutDirection as LayoutDirection)
      ? layoutDirection
      : layoutEngine.defaultDirection;

    const theme = StyleRegistry.get(styleId) || StyleRegistry.getDefault();
    const layoutConfig = {
      ...DEFAULT_LAYOUT_CONFIG,
      direction: validDirection as LayoutDirection,
      nodeHeight: Math.max(
        DEFAULT_LAYOUT_CONFIG.nodeHeight,
        calculateBaseNodeHeight(theme?.node?.branch, 15, '6px 12px'),
        calculateBaseNodeHeight(theme?.node?.leaf, 14, '4px 8px')
      ),
      rootNodeHeight: Math.max(
        DEFAULT_LAYOUT_CONFIG.rootNodeHeight,
        calculateBaseNodeHeight(ROOT_NODE_STYLE, 18, '12px 24px')
      ),
      measuredNodeHeights,
    };

    const layoutResult = layoutEngine.calculate(
      document.root,
      layoutConfig,
      validDirection as LayoutDirection
    );

    // ============================================================================
    // 彩虹分支颜色已禁用——节点和连线统一使用主题默认色，避免视觉干扰

    return layoutResult;
  }, [document, layoutId, layoutDirection, layoutEngine, styleId, measuredNodeHeights]);

  // 动态合并节点组件（默认 + 布局引擎自定义）
  const nodeTypes = useMemo(() => {
    if (!layoutEngine?.customNodeTypes) {
      return defaultNodeTypes;
    }
    return {
      ...defaultNodeTypes,
      ...layoutEngine.customNodeTypes,
    };
  }, [layoutEngine]);

  // 动态合并边组件（默认 + 布局引擎自定义）
  const edgeTypes = useMemo(() => {
    if (!layoutEngine?.customEdgeTypes) {
      return defaultEdgeTypes;
    }
    return {
      ...defaultEdgeTypes,
      ...layoutEngine.customEdgeTypes,
    };
  }, [layoutEngine]);

  const openNodeContextMenu = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setContextMenu({
      isOpen: true,
      position,
      nodeId,
    });
    // 右键菜单不触发视角居中：提前同步 prevFocusedNodeId 使居中 effect 跳过
    prevFocusedNodeId.current = nodeId;
    setFocusedNodeId(nodeId);
    setSelection([nodeId]);
  }, [setFocusedNodeId, setSelection]);

  // 将 focusedNodeId 同步到节点的 selected 属性
  const nodes = useMemo(() => {
    return layoutNodes.map(node => {
      const isBeingDragged = isDragging && node.id === dragNodeIdRef.current;
      const isSubtreeOfDragged = isDragging && node.id in dragSubtreeOffsetsRef.current;
      const isDropTarget = node.id === dropTargetId;
      let className: string | undefined;
      if (isDropTarget) {
        className = dropMode === 'child' ? 'mm-drop-target' :
          dropMode === 'sibling-before' ? 'mm-drop-sibling-before' :
            'mm-drop-sibling-after';
      } else if (isBeingDragged || isSubtreeOfDragged) {
        className = 'mm-dragging';
      }

      const posOverride = dragPositionOverride[node.id];

      return {
        ...node,
        ...(posOverride ? { position: posOverride } : {}),
        data: {
          ...node.data,
          onOpenMenu: (nodeId: string, position: { x: number; y: number }) =>
            openNodeContextMenu(nodeId, position),
        },
        selected: selection.includes(node.id) || (selection.length === 0 && node.id === focusedNodeId),
        // 拖拽期间后代节点不可单独拖拽
        draggable: node.id !== document.root.id && !isSubtreeOfDragged,
        className,
      };
    });
  }, [layoutNodes, focusedNodeId, selection, document.root.id, dropTargetId, dropMode, isDragging, dragPositionOverride, openNodeContextMenu]);

  // 根据 edgeType 设置默认边选项
  const defaultEdgeType = useMemo(() => {
    // 映射边类型到实际使用的类型
    // smoothstep 是 ReactFlow 内置类型，直接使用
    const edgeTypeMap: Record<string, string> = {
      bezier: 'curved',
      curved: 'curved',
      straight: 'straight',
      orthogonal: 'orthogonal',
      step: 'step',
      smoothstep: 'smoothstep', // ReactFlow 内置的圆角阶梯边
    };
    return edgeTypeMap[edgeType] || 'curved';
  }, [edgeType]);

  const styledEdges = useMemo(() => {
    if (DISABLE_HOVER_BLUR_FACTORS) {
      return edges.map(edge => ({
        ...edge,
        style: {
          ...edge.style,
          opacity: 1,
        },
      }));
    }

    if (!hoveredNodeId) return edges;
    return edges.map(edge => {
      const isConnected = edge.source === hoveredNodeId || edge.target === hoveredNodeId;
      if (isConnected) {
        return {
          ...edge,
          style: {
            ...edge.style,
            strokeWidth: 2.5,
            opacity: 1,
          },
          className: 'mm-edge-highlighted',
        };
      }
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: 0.25,
        },
      };
    });
  }, [edges, hoveredNodeId]);

  // 初始 fitView（修复: 添加 cleanup 防止内存泄漏）
  useEffect(() => {
    if (nodes.length === 0) return;
    if (!hasFitView.current) {
      hasFitView.current = true;
      const timer = setTimeout(() => {
        fitView({ padding: 0.2, duration: 0 });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [nodes.length, fitView]);

  // 当布局变化时重新适应视图（修复: 添加 cleanup 防止内存泄漏）
  useEffect(() => {
    if (nodes.length > 0 && hasFitView.current) {
      const timer = setTimeout(() => {
        fitView({ padding: 0.2, duration: 300 });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [layoutId, layoutDirection, fitView]);

  useEffect(() => {
    if (
      focusedNodeId &&
      focusedNodeId !== prevFocusedNodeId.current
    ) {
      const targetNode = getNodes().find(n => n.id === focusedNodeId);
      if (targetNode) {
        const nodeWidth = targetNode.measured?.width || 100;
        const nodeHeight = targetNode.measured?.height || 36;
        const centerX = targetNode.position.x + nodeWidth / 2;
        const centerY = targetNode.position.y + nodeHeight / 2;

        const currentZoom = getZoom();
        setCenter(centerX, centerY, {
          zoom: Math.max(currentZoom, 0.8),
          duration: 200
        });
      }
    }
    prevFocusedNodeId.current = focusedNodeId;
  }, [focusedNodeId, getNodes, setCenter, getZoom]);

  const setEditingNodeId = useMindMapStore(s => s.setEditingNodeId);
  const setEditingNoteNodeId = useMindMapStore(s => s.setEditingNoteNodeId);
  const moveNode = useMindMapStore(s => s.moveNode);

  const onConnect = useCallback((connection: Connection) => {
    const sourceId = connection.source;
    const targetId = connection.target;
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }

    const targetNode = findNodeById(document.root, targetId);
    if (!targetNode) {
      return;
    }

    moveNode(sourceId, targetId, targetNode.children.length);
    setSelection([sourceId]);
    setFocusedNodeId(sourceId);
  }, [document.root, moveNode, setFocusedNodeId, setSelection]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const isMultiSelect = event.metaKey || event.ctrlKey || event.shiftKey;
    if (isMultiSelect) {
      setSelection(
        selection.includes(node.id)
          ? selection.filter(id => id !== node.id)
          : [...selection, node.id]
      );
    } else {
      setSelection([node.id]);
    }
    setFocusedNodeId(node.id);
  }, [selection, setFocusedNodeId, setSelection]);

  const onNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (reciteMode) {
      // 背诵模式下双击不进入编辑
      return;
    }
    // 提前同步 prevFocusedNodeId，阻止居中 effect 触发动画。
    // 进入编辑会导致节点尺寸微变 → 布局重算 → 节点位置更新，
    // 如果此时居中动画正在进行，会被打断后重启导致严重卡顿。
    prevFocusedNodeId.current = node.id;
    setSelection([node.id]);
    setFocusedNodeId(node.id);
    setEditingNodeId(node.id);
  }, [setEditingNodeId, setFocusedNodeId, setSelection, reciteMode]);

  const onPaneClick = useCallback(() => {
    setFocusedNodeId(null);
    setSelection([]);
    setEditingNodeId(null);
    setEditingNoteNodeId(null);
    setContextMenu(prev => ({ ...prev, isOpen: false }));
  }, [setFocusedNodeId, setSelection, setEditingNodeId, setEditingNoteNodeId]);

  const onNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
    if (DISABLE_HOVER_BLUR_FACTORS) return;
    setHoveredNodeId(node.id);
  }, []);

  const onNodeMouseLeave = useCallback(() => {
    if (DISABLE_HOVER_BLUR_FACTORS) return;
    setHoveredNodeId(null);
  }, []);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    if (reciteMode) return; // 背诵模式下禁用右键菜单
    openNodeContextMenu(node.id, { x: event.clientX, y: event.clientY });
  }, [openNodeContextMenu, reciteMode]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
  }, []);

  const onNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id === document.root.id) return;
    setSelection([node.id]);
    setFocusedNodeId(node.id);
    dragNodeIdRef.current = node.id;
    setIsDragging(true);

    // 收集所有后代节点的相对偏移，使子树跟随拖拽
    const allNodes = getNodes();
    const offsets: Record<string, { dx: number; dy: number }> = {};
    const overrides: Record<string, { x: number; y: number }> = { [node.id]: node.position };

    const collectDescendants = (parentId: string) => {
      const mmNode = findNodeById(document.root, parentId);
      if (!mmNode?.children) return;
      for (const child of mmNode.children) {
        const layoutNode = allNodes.find(n => n.id === child.id);
        if (layoutNode) {
          offsets[child.id] = {
            dx: layoutNode.position.x - node.position.x,
            dy: layoutNode.position.y - node.position.y,
          };
          overrides[child.id] = layoutNode.position;
        }
        collectDescendants(child.id);
      }
    };
    collectDescendants(node.id);

    dragSubtreeOffsetsRef.current = offsets;
    setDragPositionOverride(overrides);
  }, [document.root, setFocusedNodeId, setSelection, getNodes]);

  const onNodesChange = useCallback((_changes: NodeChange[]) => {
    // 位置同步由 onNodeDrag 处理，此处无需操作
  }, []);

  const onNodeDrag = useCallback((_: React.MouseEvent, draggedNode: Node) => {
    if (!dragNodeIdRef.current) return;
    const dragId = dragNodeIdRef.current;
    const dragPos = draggedNode.position;
    const offsets = dragSubtreeOffsetsRef.current;

    // 同步更新父节点 + 所有后代节点的位置——flushSync 确保同帧渲染
    const next: Record<string, { x: number; y: number }> = { [dragId]: dragPos };
    for (const [childId, offset] of Object.entries(offsets)) {
      next[childId] = { x: dragPos.x + offset.dx, y: dragPos.y + offset.dy };
    }
    flushSync(() => { setDragPositionOverride(next); });

    // 寻找最近的放置目标
    const allNodes = getNodes();
    let closestId: string | null = null;
    let closestDist = Infinity;

    const dragW = draggedNode.measured?.width || 100;
    const dragH = draggedNode.measured?.height || 36;
    const dragCenterX = dragPos.x + dragW / 2;
    const dragCenterY = dragPos.y + dragH / 2;

    for (const n of allNodes) {
      if (n.id === dragId) continue;
      if (n.id in offsets) continue; // 跳过子树节点
      if (isDescendantOf(document.root, dragId, n.id)) continue;

      const nCenterX = n.position.x + (n.measured?.width || 100) / 2;
      const nCenterY = n.position.y + (n.measured?.height || 36) / 2;
      const dist = Math.hypot(dragCenterX - nCenterX, dragCenterY - nCenterY);

      if (dist < closestDist && dist < 150) {
        closestDist = dist;
        closestId = n.id;
      }
    }

    setDropTargetId(closestId);

    if (closestId) {
      const target = allNodes.find(n => n.id === closestId);
      if (target) {
        const targetH = target.measured?.height || 36;
        const targetCenterY = target.position.y + targetH / 2;
        const relY = dragCenterY - targetCenterY;
        const threshold = targetH * 0.3;

        if (relY < -threshold) {
          setDropMode('sibling-before');
        } else if (relY > threshold) {
          setDropMode('sibling-after');
        } else {
          setDropMode('child');
        }
      }
    }
  }, [document.root, getNodes]);

  const onNodeDragStop = useCallback((_: React.MouseEvent, _draggedNode: Node) => {
    const draggedId = dragNodeIdRef.current;
    dragNodeIdRef.current = null;
    dragSubtreeOffsetsRef.current = {};
    setIsDragging(false);
    setDragPositionOverride({});

    if (draggedId && dropTargetId && draggedId !== dropTargetId) {
      if (!isDescendantOf(document.root, draggedId, dropTargetId)) {
        if (dropMode === 'child') {
          moveNode(draggedId, dropTargetId, 0);
        } else {
          const parent = findParentNode(document.root, dropTargetId);
          if (parent) {
            const idx = parent.children.findIndex(c => c.id === dropTargetId);
            const insertIdx = dropMode === 'sibling-before' ? idx : idx + 1;
            moveNode(draggedId, parent.id, insertIdx);
          } else {
            moveNode(draggedId, dropTargetId, 0);
          }
        }
      }
    }

    setDropTargetId(null);
    setDropMode('child');
  }, [dropTargetId, dropMode, document.root, moveNode]);

  // Ctrl+0 / Cmd+0: 适应视图（注册在 document，stopPropagation 防止 global.zoom-reset 冲突）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return;

      if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        fitView({ padding: 0.2, duration: 300 });
      }
    };

    // 使用 window.document 避免与组件内 MindMapDocument 变量 shadowing
    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [fitView]);

  return (
    <div className={`w-full h-full bg-[var(--mm-bg)] ${DISABLE_HOVER_BLUR_FACTORS ? 'mm-blur-safety-mode' : ''}`}>
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        defaultEdgeOptions={{ type: defaultEdgeType }}
        fitView
        fitViewOptions={{ padding: REACTFLOW_CONFIG.fitViewPadding }}
        minZoom={REACTFLOW_CONFIG.minZoom}
        maxZoom={REACTFLOW_CONFIG.maxZoom}
        nodesDraggable={!reciteMode}
        nodesConnectable={REACTFLOW_CONFIG.nodesConnectable}
        elementsSelectable={REACTFLOW_CONFIG.elementsSelectable}
        panOnScroll={REACTFLOW_CONFIG.panOnScroll}
        zoomOnScroll={REACTFLOW_CONFIG.zoomOnScroll}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onlyRenderVisibleElements={!isExporting}
      >
        <Controls
          showInteractive={false}
          className="!shadow-[var(--mm-shadow)] !rounded-lg !border !border-[var(--mm-border)] !bg-[var(--mm-bg-elevated)]"
        />
        <MiniMap
          nodeColor={() => '#6b7280'}
          nodeStrokeWidth={3}
          maskColor="rgba(0, 0, 0, 0.15)"
          style={{ width: 120, height: 80, backgroundColor: 'var(--mm-bg-elevated)' }}
          className="!shadow-[var(--mm-shadow)] !rounded-lg !border !border-[var(--mm-border)]"
          pannable
          zoomable
        />
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--mm-text-muted)"
          style={{ opacity: 0.3 }}
        />
      </ReactFlow>

      <CanvasContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        nodeId={contextMenu.nodeId}
        onClose={() => setContextMenu(prev => ({ ...prev, isOpen: false }))}
        onOpenResourcePicker={(nid) => setResourcePickerNodeId(nid)}
      />
      <MindMapResourcePicker
        isOpen={!!resourcePickerNodeId}
        nodeId={resourcePickerNodeId || ''}
        existingRefs={resourcePickerNodeId ? findNodeById(document.root, resourcePickerNodeId)?.refs : undefined}
        onSelect={handleResourcePickerSelect}
        onClose={handleResourcePickerClose}
      />
      {document.root.children.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
          <div className="mt-24 flex flex-col items-center gap-4 max-w-[280px] text-center animate-in fade-in-0 slide-in-from-bottom-4 duration-500">
            <div className="w-12 h-12 rounded-2xl bg-[var(--mm-primary-soft)] flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--mm-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <line x1="12" y1="5" x2="12" y2="3" />
                <line x1="17" y1="7" x2="19" y2="5" />
                <line x1="19" y1="12" x2="21" y2="12" />
                <line x1="17" y1="17" x2="19" y2="19" />
                <line x1="12" y1="19" x2="12" y2="21" />
                <line x1="7" y1="17" x2="5" y2="19" />
                <line x1="5" y1="12" x2="3" y2="12" />
                <line x1="7" y1="7" x2="5" y2="5" />
              </svg>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-[var(--mm-text-secondary)]">{t('canvas.emptyTitle')}</p>
              <p className="text-xs text-[var(--mm-text-muted)] leading-relaxed">
                {t('canvas.emptyHintBefore')} <kbd className="px-1.5 py-0.5 mx-0.5 rounded bg-[var(--mm-bg-hover)] border border-[var(--mm-border)] text-[11px] font-mono">Tab</kbd> {t('canvas.emptyHintAfter')}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const MindMapCanvas: React.FC = () => (
  <ReactFlowProvider>
    <MindMapCanvasInner />
  </ReactFlowProvider>
);
