import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Plus } from '@phosphor-icons/react';
import { NodeContent } from './NodeContent';
import { useNodeHeightObserver } from './useNodeHeightObserver';
import { pickDefined } from './styleUtils';
import { useMindMapStore, useMindMapStoreApi } from '../../../store';
import { useMindMapTheme } from '../../../hooks/useMindMapTheme';
import { getThemeFontMetrics, MM_NODE_LINE_HEIGHT_RATIO } from '../../../styles/themes';
import { openNodeRef } from '../../../utils/openNodeRef';
import { getSearchResultIdSet } from '../../../utils/searchFilter';
import {
  selectNodeDecorationKey,
  parseNodeDecorations,
} from '../../../utils/nodeDecorations';
import type { NodeStyle, BlankRange, MindMapNodeRef } from '../../../types';
import './nodes.css';

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
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
  
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
  const searchResultIds = useMindMapStore(state => getSearchResultIdSet(state.searchResults));
  const currentSearchResultId = useMindMapStore(
    state => state.searchResults[state.currentSearchIndex] ?? null,
  );
  const revealedBlanks = useMindMapStore(state => state.revealedBlanks);
  const revealBlank = useMindMapStore(state => state.revealBlank);
  const addBlankRange = useMindMapStore(state => state.addBlankRange);
  const removeBlankRange = useMindMapStore(state => state.removeBlankRange);
  const removeNodeRef = useMindMapStore(state => state.removeNodeRef);
  // 装饰字段（priority/progress/href）：布局引擎未拷贝，经索引直接读 store（值稳定 key，无装饰不触发重渲染）
  const decorationKey = useMindMapStore(state =>
    selectNodeDecorationKey(state.document.root, data.nodeId),
  );
  const decorations = parseNodeDecorations(decorationKey);
  const nodeRef = useRef<HTMLDivElement>(null);
  
  const isEditing = editingNodeId === data.nodeId;
  const isEditingNote = editingNoteNodeId === data.nodeId;

  // 从 StyleRegistry 解析主题（订阅暗色模式切换与注册变更，见 useMindMapTheme）
  const theme = useMindMapTheme(styleId);

  const handleTextChange = useCallback((text: string) => {
    updateNode(data.nodeId, { text });
  }, [data.nodeId, updateNode]);

  const handleCommitLiveText = useCallback((text: string) => {
    updateNode(data.nodeId, { text }, { preserveBlankedRanges: true, skipHistory: true });
  }, [data.nodeId, updateNode]);

  const handleStartEdit = useCallback(() => {
    setEditingNodeId(data.nodeId);
  }, [data.nodeId, setEditingNodeId]);

  // 按 nodeId 守卫：连续建点时旧 textarea blur 不得清掉新节点的 editingNodeId
  const handleEndEdit = useCallback(() => {
    const { editingNodeId: current } = storeApi.getState();
    if (current === data.nodeId) {
      setEditingNodeId(null);
    }
  }, [data.nodeId, setEditingNodeId, storeApi]);

  const handleCommitAndCreateSibling = useCallback(() => {
    // 根节点 Enter → 子级（与非编辑快捷键一致）
    const newId = addNode(data.nodeId, 0);
    if (newId) {
      setFocusedNodeId(newId);
      setEditingNodeId(newId);
    }
  }, [data.nodeId, addNode, setFocusedNodeId, setEditingNodeId]);

  const handleCommitAndCreateChild = useCallback(() => {
    const newId = addNode(data.nodeId, 0);
    if (newId) {
      setFocusedNodeId(newId);
      setEditingNodeId(newId);
    }
  }, [data.nodeId, addNode, setFocusedNodeId, setEditingNodeId]);

  const handleAddChild = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleCommitAndCreateChild();
  }, [handleCommitAndCreateChild]);

  // 记录节点实测高度，避免布局重叠
  // ★ 2026-02 优化：embed 模式下跳过测量，防止小容器的测量值覆盖主编辑器
  const isEmbed = !!(data as Record<string, unknown>).isEmbed;
  useNodeHeightObserver(nodeRef, data.nodeId, setMeasuredNodeHeight, !isEmbed);

  // 主题样式 - 从 theme.node.root 获取；fallback 走主题度量单一数据源
  const rootTheme = theme?.node?.root;
  const rootMetrics = getThemeFontMetrics(theme, true);
  
  // 自定义样式（来自 data.style）优先级高于主题样式
  // ★ 修复：剔除 undefined 字段——直接展开会把主题样式同名键覆盖为 undefined，
  //   导致主题 foreground / fontWeight 等被静默丢弃
  const customStyle: React.CSSProperties = pickDefined({
    color: data.style?.textColor,
    fontWeight: data.style?.fontWeight,
    fontStyle: data.style?.fontStyle === 'italic' ? 'italic' : undefined,
    textDecoration: data.style?.textDecoration && data.style.textDecoration !== 'none' ? data.style.textDecoration : undefined,
    fontSize: data.style?.headingLevel === 'h1' ? '22px' : data.style?.headingLevel === 'h2' ? '18px' : data.style?.headingLevel === 'h3' ? '16px' : data.style?.fontSize ? `${data.style.fontSize}px` : undefined,
  });

  // 合并主题样式和自定义样式，自定义样式优先级更高
  // ★ 修复：正确应用全局主题的所有属性
  const themeStyle: React.CSSProperties = {
    background: rootTheme?.background || 'var(--mm-bg-elevated)',
    color: rootTheme?.foreground || 'var(--mm-text)',
    border: rootTheme?.border || '1px solid var(--mm-border)',
    borderRadius: rootTheme?.borderRadius ? `${rootTheme.borderRadius}px` : '4px',
    fontSize: rootTheme?.fontSize ? `${rootTheme.fontSize}px` : `${rootMetrics.fontSize}px`,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    fontWeight: rootTheme?.fontWeight || 600,
    padding: rootTheme?.padding || '10px 18px',
    boxShadow: rootTheme?.shadow || 'none',
    // 自定义样式优先级更高
    ...customStyle,
  };

  const isSearchMatch = searchResultIds.has(data.nodeId);
  const isCurrentSearchMatch = isSearchMatch && currentSearchResultId === data.nodeId;

  return (
    <div
      ref={nodeRef}
      className={cn(
        "mm-root-node group relative flex items-center justify-center",
        selected && "selected",
        isEditing && "editing",
        isSearchMatch && "search-match",
        isCurrentSearchMatch && "search-match-current",
        data.completed && "mm-completed"
      )}
      style={themeStyle}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Handled by ReactFlow onNodeDoubleClick
      }}
    >
      <NodeContent
        text={data.label}
        note={data.note}
        refs={data.refs}
        icon={data.style?.icon}
        bgColor={data.style?.bgColor}
        isRoot
        isCompleted={data.completed}
        isEditing={isEditing}
        isEditingNote={isEditingNote}
        blankedRanges={data.blankedRanges}
        revealedIndices={revealedBlanks[data.nodeId]}
        reciteMode={reciteMode}
        decorations={decorations}
        showCheckbox={data.style?.showCheckbox}
        onToggleCompleted={() => updateNode(data.nodeId, { completed: !data.completed })}
        onTextChange={handleTextChange}
        onCommitLiveText={handleCommitLiveText}
        onNoteChange={(note) => updateNode(data.nodeId, { note })}
        onStartEdit={reciteMode ? undefined : handleStartEdit}
        onEndEdit={handleEndEdit}
        onEndEditNote={() => setEditingNoteNodeId(null)}
        onCommitAndCreateSibling={reciteMode ? undefined : handleCommitAndCreateSibling}
        onCommitAndCreateChild={reciteMode ? undefined : handleCommitAndCreateChild}
        isBold={data.style?.fontWeight === 'bold'}
        onRevealBlank={(rangeIndex) => revealBlank(data.nodeId, rangeIndex)}
        onAddBlank={(range) => addBlankRange(data.nodeId, range)}
        onRemoveBlank={(rangeIndex) => removeBlankRange(data.nodeId, rangeIndex)}
        onToggleBold={() =>
          updateNode(data.nodeId, {
            style: {
              ...data.style,
              fontWeight: data.style?.fontWeight === 'bold' ? undefined : 'bold',
            },
          })
        }
        onRemoveRef={isEmbed ? undefined : (sourceId) => removeNodeRef(data.nodeId, sourceId)}
        onClickRef={
          isEmbed
            ? undefined
            : (sourceId) => {
                const ref = data.refs?.find((r) => r.sourceId === sourceId);
                void openNodeRef(sourceId, { type: ref?.type, name: ref?.name });
              }
        }
      />

      {/* Action Buttons Container - hidden in recite mode */}
      {!reciteMode && (
      <div
        className={cn(
          "absolute flex items-center justify-end w-8",
          isEditing
            ? "invisible pointer-events-none"
            : selected
              ? "visible pointer-events-auto"
              : "invisible pointer-events-none group-hover:visible group-hover:pointer-events-auto"
        )}
        style={{ right: '-32px', top: '50%', marginTop: '-12px' }}
      >
        <NotionButton variant="ghost"
          onClick={handleAddChild}
          className="mm-collapse-btn bg-[var(--mm-bg-elevated)] border border-[var(--mm-border)] w-6 h-6 hover:bg-[var(--mm-bg-hover)]"
          aria-label={t('actions.addChild')}
        >
          <Plus className="w-3.5 h-3.5 text-[var(--mm-text-secondary)]" />
        </NotionButton>
      </div>
      )}

      {/* 动态渲染 Source Handle（与 BranchNode 统一：默认隐藏、hover/选中淡入的小锚点） */}
      {(() => {
        const sourcePos = data.sourcePosition || 'right';
        
        if (sourcePos === 'both') {
          return (
            <>
              <Handle
                type="source"
                position={Position.Left}
                id="left"
                className="mm-node-handle"
                isConnectable={false}
              />
              <Handle
                type="source"
                position={Position.Right}
                id="right"
                className="mm-node-handle"
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
            className="mm-node-handle"
            isConnectable={false}
          />
        );
      })()}
    </div>
  );
};
