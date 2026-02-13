import React, { useCallback, useMemo, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Plus, Trash2, MoreHorizontal } from 'lucide-react';
import { NodeContent } from './NodeContent';
import { NotionButton } from '@/components/ui/NotionButton';
import { useMindMapStore } from '../../../store';
import { StyleRegistry } from '../../../registry';
import type { NodeStyle, BlankRange } from '../../../types';

export interface BranchNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  nodeId: string;
  level: number;
  collapsed: boolean;
  completed: boolean;
  hasChildren: boolean;
  childCount: number;
  style?: NodeStyle;
  blankedRanges?: BlankRange[];
  // Handle 位置
  sourcePosition?: 'left' | 'right' | 'top' | 'bottom';
  targetPosition?: 'left' | 'right' | 'top' | 'bottom';
  side?: 'left' | 'right' | 'center';  // 节点所在侧
  branchColor?: string;
  onOpenMenu?: (nodeId: string, position: { x: number; y: number }) => void;
}

export const BranchNode: React.FC<NodeProps<Node<BranchNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation('mindmap');
  const updateNode = useMindMapStore(state => state.updateNode);
  const addNode = useMindMapStore(state => state.addNode);
  const deleteNode = useMindMapStore(state => state.deleteNode);
  const toggleCollapse = useMindMapStore(state => state.toggleCollapse);
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
  const nodeRef = useRef<HTMLDivElement>(null);

  const isEditing = editingNodeId === data.nodeId;
  const isEditingNote = editingNoteNodeId === data.nodeId;
  
  const hasChildren = data.hasChildren;
  const isCollapsed = data.collapsed;
  
  // Handle 位置
  const targetPos = data.targetPosition || 'left';
  const sourcePos = data.sourcePosition || 'right';
  
  // 获取 Position 枚举值
  const getPosition = (pos: string): Position => {
    switch(pos) {
      case 'left': return Position.Left;
      case 'right': return Position.Right;
      case 'top': return Position.Top;
      case 'bottom': return Position.Bottom;
      default: return Position.Left;
    }
  };
  
  // 根据 sourcePosition 计算折叠按钮位置（折叠按钮在子节点方向）
  // 使用 margin 而非 translate 避免文字模糊
  const getCollapseButtonStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
    switch(sourcePos) {
      case 'left':
        return { ...baseStyle, left: '-20px', top: '50%', marginTop: '-10px' };
      case 'right':
        return { ...baseStyle, right: '-20px', top: '50%', marginTop: '-10px' };
      case 'top':
        return { ...baseStyle, top: '-20px', left: '50%', marginLeft: '-10px' };
      case 'bottom':
        return { ...baseStyle, bottom: '-20px', left: '50%', marginLeft: '-10px' };
      default:
        return { ...baseStyle, right: '-20px', top: '50%', marginTop: '-10px' };
    }
  };

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
    if (newId) {
      setFocusedNodeId(newId);
    }
  }, [data.nodeId, addNode, setFocusedNodeId]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    deleteNode(data.nodeId);
  }, [data.nodeId, deleteNode]);

  const handleOpenMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!data.onOpenMenu) return;
    const rect = e.currentTarget.getBoundingClientRect();
    data.onOpenMenu(data.nodeId, {
      x: rect.left + rect.width / 2,
      y: rect.bottom + 6,
    });
  }, [data]);

  const handleToggleCollapse = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    toggleCollapse(data.nodeId);
  }, [data.nodeId, toggleCollapse]);

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

  // 根据节点是否有子节点决定使用 branch 还是 leaf 样式
  const nodeTheme = hasChildren ? theme?.node?.branch : theme?.node?.leaf;
  
  // 判断是否为下划线风格节点 (Level >= 2)
  const isUnderlineNode = data.level >= 2;
  const branchColor = data.branchColor;
  
  // 自定义样式（来自 data.style）优先级高于主题样式
  const customStyle = {
    backgroundColor: data.style?.bgColor,
    color: data.style?.textColor,
    fontWeight: data.style?.fontWeight,
    fontSize: data.style?.fontSize ? `${data.style.fontSize}px` : undefined,
  };

  // 合并主题样式和自定义样式
  // ★ 修复：正确应用全局主题的所有属性
  const themeStyle: React.CSSProperties = isUnderlineNode ? {
    // 下划线节点忽略大部分主题背景样式
    color: nodeTheme?.foreground || 'var(--mm-text)',
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : undefined,
    // 自定义样式优先级更高
    ...customStyle,
    // 仅在没有自定义背景色时才透明；有高亮色时使用半透明背景
    backgroundColor: data.style?.bgColor ? `${data.style.bgColor}40` : 'transparent',
    border: 'none',
    boxShadow: 'none',
    padding: '2px 4px', // 紧凑一点
    whiteSpace: 'nowrap', // 防止文字竖排
    // 如果有彩虹分支色，覆盖底边颜色
    borderBottomColor: branchColor,
  } : {
    backgroundColor: nodeTheme?.background || 'var(--mm-bg-elevated)',
    color: nodeTheme?.foreground || 'var(--mm-text)',
    border: nodeTheme?.border || '1px solid var(--mm-border)',
    borderRadius: nodeTheme?.borderRadius ? `${nodeTheme.borderRadius}px` : '4px',
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : '14px',
    padding: nodeTheme?.padding || '6px 12px',
    boxShadow: nodeTheme?.shadow,
    whiteSpace: 'nowrap', // 防止文字竖排
    // 自定义样式优先级更高
    ...customStyle,
    // 如果有彩虹分支色，且是 Level 1，覆盖边框色
    ...(branchColor && data.level === 1 ? { borderColor: branchColor } : {}),
  };

  // 下划线节点：Target Handle 和 Source Handle 需各自定位到底部对应侧
  const baseHandleStyle: React.CSSProperties = isUnderlineNode
    ? { top: 'auto', bottom: '-1.5px', transform: 'none', width: '4px', height: '4px', background: 'transparent' }
    : {};

  const targetHandleStyle: React.CSSProperties = isUnderlineNode
    ? {
        ...baseHandleStyle,
        left: targetPos === 'left' ? 0 : 'auto',
        right: targetPos === 'right' ? 0 : 'auto',
        marginLeft: targetPos === 'left' ? '-2px' : 0,
        marginRight: targetPos === 'right' ? '-2px' : 0,
      }
    : {};

  const sourceHandleStyle: React.CSSProperties = isUnderlineNode
    ? {
        ...baseHandleStyle,
        left: sourcePos === 'left' ? 0 : 'auto',
        right: sourcePos === 'right' ? 0 : 'auto',
        marginLeft: sourcePos === 'left' ? '-2px' : 0,
        marginRight: sourcePos === 'right' ? '-2px' : 0,
      }
    : {};

  const handleClassName = cn(
    '!w-2 !h-2 !border !border-[var(--mm-border)] !bg-[var(--mm-bg-elevated)] transition-opacity',
    selected ? '!opacity-100' : '!opacity-0 group-hover:!opacity-100'
  );

  return (
    <div
      ref={nodeRef}
      className={cn(
        isUnderlineNode ? "mindmap-node-underline" : "mm-branch-node",
        "group flex items-center justify-center gap-1",
        selected && "selected",
        isEditing && "editing",
        data.completed && "mm-completed"
      )}
      style={themeStyle}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Handled by ReactFlow onNodeDoubleClick
      }}
    >
      {/* Collapse/Expand Toggle - 位置根据 targetPosition 或 side 调整 */}
      {hasChildren && (
        <div 
          className={cn(
            "w-5 h-5 z-20 transition-opacity duration-200",
            !selected && !isCollapsed ? "opacity-0 group-hover:opacity-100" : "opacity-100"
          )}
          style={getCollapseButtonStyle()}
        >
          <NotionButton variant="ghost"
            onClick={handleToggleCollapse}
            aria-label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
            className={cn(
              "mm-collapse-btn w-5 h-5 shadow-sm border border-[var(--mm-border)]",
              isCollapsed 
                ? "bg-[var(--mm-bg-elevated)] hover:bg-[var(--mm-bg-hover)]" 
                : "bg-transparent hover:bg-[var(--mm-bg-hover)] border-transparent hover:border-[var(--mm-border)]"
            )}
          >
            {isCollapsed ? (
              <span className="flex items-center justify-center text-[10px] font-bold w-full h-full text-[var(--mm-text-muted)] rounded-full">{data.childCount}</span>
            ) : (
               <div className="w-1.5 h-1.5 rounded-full bg-[var(--mm-border-strong)] group-hover:bg-[var(--mm-text-secondary)] transition-colors" />
            )}
          </NotionButton>
        </div>
      )}

      <Handle
        type="target"
        position={getPosition(targetPos)}
        className={handleClassName}
        isConnectable={true}
        style={targetHandleStyle}
      />

      <div className="flex items-center min-w-0">
        <NodeContent
          text={data.label}
          note={data.note}
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
        />
      </div>

      {/* Action Buttons (Right side) - hidden in recite mode */}
      {!reciteMode && (
      <div
        className={cn(
          "mm-node-actions",
          selected && !isEditing ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ left: '100%', marginLeft: '8px' }}
      >
        <NotionButton variant="ghost"
          onClick={handleAddChild}
          className="mm-action-btn"
          aria-label={t('actions.addChild')}
          title={t('node.addChildShortcut')}
        >
          <Plus className="w-3.5 h-3.5" />
        </NotionButton>
        <NotionButton variant="ghost"
          onClick={handleOpenMenu}
          className="mm-action-btn"
          aria-label={t('node.openMenu')}
          title={t('node.moreActions')}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </NotionButton>
        <NotionButton variant="ghost"
          onClick={handleDelete}
          className="mm-action-btn hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          aria-label={t('actions.delete')}
          title={t('node.deleteShortcut')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </NotionButton>
      </div>
      )}

      <Handle
        type="source"
        position={getPosition(sourcePos)}
        className={handleClassName}
        isConnectable={true}
        style={sourceHandleStyle}
      />
    </div>
  );
};
