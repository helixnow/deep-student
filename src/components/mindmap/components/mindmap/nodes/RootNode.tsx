import React, { useCallback, useState, useMemo, useLayoutEffect, useRef } from 'react';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Plus } from 'lucide-react';
import { NodeContent } from './NodeContent';
import { useMindMapStore } from '../../../store';
import { StyleRegistry } from '../../../registry';
import type { NodeStyle, BlankRange, MindMapNodeRef } from '../../../types';

export interface RootNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  refs?: MindMapNodeRef[];
  nodeId: string;
  completed: boolean;
  hasChildren: boolean;
  childCount: number;
  style?: NodeStyle;
  blankedRanges?: BlankRange[];
  // Handle 位置
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom' | 'both';
}

export const RootNode: React.FC<NodeProps<Node<RootNodeData>>> = ({
  data,
  selected,
}) => {
  const [showActions, setShowActions] = useState(false);
  
  const updateNode = useMindMapStore(state => state.updateNode);
  const addNode = useMindMapStore(state => state.addNode);
  const setFocusedNodeId = useMindMapStore(state => state.setFocusedNodeId);
  const editingNodeId = useMindMapStore(state => state.editingNodeId);
  const setEditingNodeId = useMindMapStore(state => state.setEditingNodeId);
  const editingNoteNodeId = useMindMapStore(state => state.editingNoteNodeId);
  const setEditingNoteNodeId = useMindMapStore(state => state.setEditingNoteNodeId);
  const styleId = useMindMapStore(state => state.styleId);
  const setMeasuredNodeHeight = useMindMapStore(state => state.setMeasuredNodeHeight);
  const reciteMode = useMindMapStore(state => state.reciteMode);
  const revealedBlanks = useMindMapStore(state => state.revealedBlanks);
  const revealBlank = useMindMapStore(state => state.revealBlank);
  const addBlankRange = useMindMapStore(state => state.addBlankRange);
  const removeBlankRange = useMindMapStore(state => state.removeBlankRange);
  const removeNodeRef = useMindMapStore(state => state.removeNodeRef);
  const nodeRef = useRef<HTMLDivElement>(null);
  
  const isEditing = editingNodeId === data.nodeId;
  const isEditingNote = editingNoteNodeId === data.nodeId;

  // 从 StyleRegistry 获取主题配置
  const theme = useMemo(() => StyleRegistry.get(styleId) || StyleRegistry.getDefault(), [styleId]);

  const handleTextChange = useCallback((text: string) => {
    updateNode(data.nodeId, { text });
  }, [data.nodeId, updateNode]);

  const handleStartEdit = useCallback(() => {
    setEditingNodeId(data.nodeId);
  }, [data.nodeId, setEditingNodeId]);

  const handleEndEdit = useCallback(() => {
    setEditingNodeId(null);
  }, [setEditingNodeId]);

  const handleAddChild = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const newId = addNode(data.nodeId, 0);
    if (newId) setFocusedNodeId(newId);
  }, [data.nodeId, addNode, setFocusedNodeId]);

  // 记录节点实测高度，避免布局重叠
  // ★ 2026-02 优化：embed 模式下跳过测量，防止小容器的测量值覆盖主编辑器
  const isEmbed = !!(data as Record<string, unknown>).isEmbed;
  useLayoutEffect(() => {
    if (isEmbed) return;
    const element = nodeRef.current;
    if (!element || !data.nodeId) {
      return;
    }
    const updateHeight = () => {
      const height = element.offsetHeight;
      if (height > 0) {
        setMeasuredNodeHeight(data.nodeId, height);
      }
    };
    updateHeight();
    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [data.nodeId, setMeasuredNodeHeight, isEmbed]);

  // 主题样式 - 从 theme.node.root 获取
  const rootTheme = theme?.node?.root;
  
  // 自定义样式（来自 data.style）优先级高于主题样式
  const customStyle = {
    backgroundColor: data.style?.bgColor,
    color: data.style?.textColor,
    fontWeight: data.style?.fontWeight,
    fontSize: data.style?.fontSize ? `${data.style.fontSize}px` : undefined,
  };

  // 合并主题样式和自定义样式，自定义样式优先级更高
  // ★ 修复：正确应用全局主题的所有属性
  const themeStyle: React.CSSProperties = {
    background: rootTheme?.background || '#ffffff',
    color: rootTheme?.foreground || 'var(--mm-text)',
    border: rootTheme?.border || '2px solid var(--mm-text)',
    borderRadius: rootTheme?.borderRadius ? `${rootTheme.borderRadius}px` : '6px',
    fontSize: rootTheme?.fontSize ? `${rootTheme.fontSize}px` : '18px',
    fontWeight: rootTheme?.fontWeight || 600,
    padding: rootTheme?.padding || '12px 24px',
    boxShadow: rootTheme?.shadow || '0 4px 12px -2px rgba(0, 0, 0, 0.12), 0 2px 6px -1px rgba(0, 0, 0, 0.08)',
    whiteSpace: 'nowrap', // 防止文字竖排
    // 自定义样式优先级更高
    ...customStyle,
  };

  return (
    <div
      ref={nodeRef}
      className={cn(
        "mm-root-node group relative flex items-center justify-center",
        selected && "selected",
        data.completed && "mm-completed"
      )}
      style={themeStyle}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Handled by ReactFlow onNodeDoubleClick
      }}
    >
      <NodeContent
        text={data.label}
        note={data.note}
        refs={data.refs}
        isRoot
        isCompleted={data.completed}
        isEditing={isEditing}
        isEditingNote={isEditingNote}
        blankedRanges={data.blankedRanges}
        revealedIndices={revealedBlanks[data.nodeId]}
        reciteMode={reciteMode}
        onTextChange={handleTextChange}
        onNoteChange={(note) => updateNode(data.nodeId, { note })}
        onStartEdit={reciteMode ? undefined : handleStartEdit}
        onEndEdit={handleEndEdit}
        onEndEditNote={() => setEditingNoteNodeId(null)}
        onRevealBlank={(rangeIndex) => revealBlank(data.nodeId, rangeIndex)}
        onAddBlank={(range) => addBlankRange(data.nodeId, range)}
        onRemoveBlank={(rangeIndex) => removeBlankRange(data.nodeId, rangeIndex)}
        onRemoveRef={isEmbed ? undefined : (sourceId) => removeNodeRef(data.nodeId, sourceId)}
        onClickRef={isEmbed ? undefined : (sourceId) => {
          const dstuPath = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;
          window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
            detail: { view: 'learning-hub', openResource: dstuPath },
          }));
        }}
      />

      {/* Action Buttons Container - hidden in recite mode */}
      {!reciteMode && (
      <div
        className={cn(
          "absolute flex items-center",
          "transition-opacity duration-200 ease-out",
          showActions && !isEditing ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ right: '-32px', top: '50%', marginTop: '-12px' }}
      >
        <NotionButton variant="ghost"
          onClick={handleAddChild}
          className="mm-collapse-btn bg-[var(--mm-bg-elevated)] shadow-sm border border-[var(--mm-border)] w-6 h-6 hover:bg-[var(--mm-bg-hover)]"
          aria-label="Add Child"
        >
          <Plus className="w-3.5 h-3.5 text-[var(--mm-text-secondary)]" />
        </NotionButton>
      </div>
      )}

      {/* 动态渲染 Source Handle */}
      {(() => {
        const sourcePos = data.sourcePosition || 'right';
        
        if (sourcePos === 'both') {
          return (
            <>
              <Handle
                type="source"
                position={Position.Left}
                id="left"
                className="!w-1 !h-1 !bg-transparent !border-0"
                isConnectable={false}
              />
              <Handle
                type="source"
                position={Position.Right}
                id="right"
                className="!w-1 !h-1 !bg-transparent !border-0"
                isConnectable={false}
              />
            </>
          );
        }
        
        const positionMap: Record<string, Position> = {
          left: Position.Left,
          right: Position.Right,
          top: Position.Top,
          bottom: Position.Bottom,
        };
        
        return (
          <Handle
            type="source"
            position={positionMap[sourcePos] || Position.Right}
            className="!w-1 !h-1 !bg-transparent !border-0"
            isConnectable={false}
          />
        );
      })()}
    </div>
  );
};
