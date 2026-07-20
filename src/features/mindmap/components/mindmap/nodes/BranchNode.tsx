import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Plus, Trash, DotsThree } from '@phosphor-icons/react';
import { NodeContent } from './NodeContent';
import { DsButton } from '@/components/ui/DsButton';
import { useNodeHeightObserver } from './useNodeHeightObserver';
import { pickDefined } from './styleUtils';
import { useMindMapStore, useMindMapStoreApi } from '../../../store';
import { useMindMapTheme } from '../../../hooks/useMindMapTheme';
import { getThemeFontMetrics, MM_NODE_LINE_HEIGHT_RATIO } from '../../../styles/themes';
import { findParentNode, findNodeById } from '../../../utils/node/find';
import { openNodeRef } from '../../../utils/openNodeRef';
import { getSearchResultIdSet } from '../../../utils/searchFilter';
import {
  selectNodeDecorationKey,
  parseNodeDecorations,
} from '../../../utils/nodeDecorations';
import type { NodeStyle, BlankRange, MindMapNodeRef } from '../../../types';
import './nodes.css';

export interface BranchNodeData extends Record<string, unknown> {
  label: string;
  note?: string;
  refs?: MindMapNodeRef[];
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
  /**
   * 明确开启 Handle 拖拽连接（onConnect → reparent）。
   * 默认关闭：普通拖动锚点极易误触 reparent，改父级请用节点整体拖拽（drop target）。
   */
  handlesConnectable?: boolean;
  onOpenMenu?: (nodeId: string, position: { x: number; y: number }) => void;
}

export const BranchNode: React.FC<NodeProps<Node<BranchNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
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
  
  const hasChildren = data.hasChildren;
  const isCollapsed = data.collapsed;
  const isSearchMatch = searchResultIds.has(data.nodeId);
  const isCurrentSearchMatch = isSearchMatch && currentSearchResultId === data.nodeId;
  
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
    const { document: doc, addNode: add, setFocusedNodeId: focus, setEditingNodeId: edit } =
      storeApi.getState();
    const root = doc.root;
    if (root.id === data.nodeId) {
      const newId = add(data.nodeId, 0);
      if (newId) {
        focus(newId);
        edit(newId);
      }
      return;
    }
    const parent = findParentNode(root, data.nodeId);
    if (!parent) return;
    const idx = parent.children.findIndex((c) => c.id === data.nodeId);
    const newId = add(parent.id, idx + 1);
    if (newId) {
      focus(newId);
      edit(newId);
    }
  }, [data.nodeId, storeApi]);

  const handleCommitAndCreateChild = useCallback(() => {
    const newId = addNode(data.nodeId, 0);
    if (newId) {
      setFocusedNodeId(newId);
      setEditingNodeId(newId);
    }
  }, [data.nodeId, addNode, setFocusedNodeId, setEditingNodeId]);

  // 空文本失焦策略：新建后从未输入内容的空节点，真正结束编辑时删除（不留「未命名」残留）。
  // 守卫与 handleEndEdit 同源：连续建点（Enter 后 editingNodeId 已移至新节点）时不删除。
  const handleEmptyCommit = useCallback(() => {
    const state = storeApi.getState();
    if (state.editingNodeId !== data.nodeId) return;
    state.setEditingNodeId(null);
    const node = findNodeById(state.document.root, data.nodeId);
    // 有子节点或已有正文（如经 live commit 写入）的节点不删
    if (node && (node.children?.length ?? 0) === 0 && node.text.trim() === '') {
      state.deleteNode(data.nodeId);
    }
  }, [data.nodeId, storeApi]);

  const handleAddChild = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleCommitAndCreateChild();
  }, [handleCommitAndCreateChild]);

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
  useNodeHeightObserver(nodeRef, data.nodeId, setMeasuredNodeHeight, !isEmbed);

  // 节点外观只由层级决定，避免新增子节点时在 branch/leaf 样式间跳变。
  const nodeTheme = data.level === 1 ? theme?.node?.branch : theme?.node?.leaf;
  // fallback 字号走主题度量单一数据源（default 主题 branch 实为 15px，勿再硬编码 14px）
  const branchMetrics = getThemeFontMetrics(theme, false);

  // 二级及以下使用下划线风格。
  const isUnderlineNode = data.level >= 2;
  const branchColor = data.branchColor;
  
  // 自定义样式（来自 data.style）优先级高于主题样式
  // ★ 修复：剔除 undefined 字段——直接展开会把主题样式同名键覆盖为 undefined，
  //   导致主题 foreground / fontSize 等被静默丢弃
  const customStyle: React.CSSProperties = pickDefined({
    color: data.style?.textColor,
    fontWeight: data.style?.fontWeight,
    fontStyle: data.style?.fontStyle === 'italic' ? 'italic' : undefined,
    textDecoration: data.style?.textDecoration && data.style.textDecoration !== 'none' ? data.style.textDecoration : undefined,
    fontSize: data.style?.headingLevel === 'h1' ? '22px' : data.style?.headingLevel === 'h2' ? '18px' : data.style?.headingLevel === 'h3' ? '16px' : data.style?.fontSize ? `${data.style.fontSize}px` : undefined,
  });

  // 合并主题样式和自定义样式
  // ★ 修复：正确应用全局主题的所有属性
  const themeStyle: React.CSSProperties = isUnderlineNode ? {
    // 下划线节点忽略大部分主题背景样式
    color: nodeTheme?.foreground || 'var(--mm-text)',
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : `${branchMetrics.fontSize}px`,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    // 自定义样式优先级更高
    ...customStyle,
    border: 'none',
    boxShadow: 'none',
    padding: '2px 4px', // 紧凑一点
    // 如果有彩虹分支色，覆盖底边颜色强制声明内联 borderBottom，以避免部分导出引擎丢失 CSS 中的简写和 !important
    borderBottom: `1.5px solid ${branchColor || 'var(--mm-border)'}`,
  } : {
    color: nodeTheme?.foreground || 'var(--mm-text)',
    border: nodeTheme?.border || '1px solid var(--mm-border)',
    borderRadius: nodeTheme?.borderRadius ? `${nodeTheme.borderRadius}px` : '4px',
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : `${branchMetrics.fontSize}px`,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    padding: nodeTheme?.padding || '6px 12px',
    boxShadow: nodeTheme?.shadow,
    // 自定义样式优先级更高
    ...customStyle,
    // 如果有彩虹分支色，且是 Level 1，覆盖边框色
    ...(branchColor && data.level === 1 ? { borderColor: branchColor } : {}),
  };

  // 下划线节点：Target Handle 和 Source Handle 需各自定位到底部对应侧（锚点贴在下划线两端）
  const baseHandleStyle: React.CSSProperties = isUnderlineNode
    ? { top: 'auto', bottom: '-4px', transform: 'none' }
    : {};

  const targetHandleStyle: React.CSSProperties = isUnderlineNode
    ? {
        ...baseHandleStyle,
        left: targetPos === 'left' ? 0 : 'auto',
        right: targetPos === 'right' ? 0 : 'auto',
        marginLeft: targetPos === 'left' ? '-3px' : 0,
        marginRight: targetPos === 'right' ? '-3px' : 0,
      }
    : {};

  const sourceHandleStyle: React.CSSProperties = isUnderlineNode
    ? {
        ...baseHandleStyle,
        left: sourcePos === 'left' ? 0 : 'auto',
        right: sourcePos === 'right' ? 0 : 'auto',
        marginLeft: sourcePos === 'left' ? '-3px' : 0,
        marginRight: sourcePos === 'right' ? '-3px' : 0,
      }
    : {};

  // 锚点统一视觉（默认隐藏、hover/选中淡入），样式见 nodes.css
  const handlesConnectable = data.handlesConnectable === true;
  const handleClassName = cn(
    'mm-node-handle',
    handlesConnectable && 'mm-node-handle--connectable',
  );

  // 下划线节点选中/hover 状态走 data-node-chrome + --mm-underline-color CSS 变量
  // （见 styles/node-edge-enhancements.css），替代 [style*="border-bottom-color"] 属性选择器黑客

  // 入场动画的生长起点朝向父节点一侧（transform-origin，常驻无副作用）
  const spawnOriginClass = {
    left: 'mm-node-origin-left',
    right: 'mm-node-origin-right',
    top: 'mm-node-origin-top',
    bottom: 'mm-node-origin-bottom',
  }[targetPos] ?? 'mm-node-origin-left';

  return (
    <div
      ref={nodeRef}
      className={cn(
        // mm-node--underline 为语义类（mindmap.css 已备好全套状态 twin 规则），与旧类并存兼容
        isUnderlineNode ? "mindmap-node-underline mm-node--underline" : "mm-branch-node",
        "group flex items-center justify-center gap-1",
        spawnOriginClass,
        selected && "selected",
        isEditing && "editing",
        isSearchMatch && "search-match",
        isCurrentSearchMatch && "search-match-current",
        data.completed && "mm-completed"
      )}
      data-node-chrome={isUnderlineNode ? 'underline' : 'box'}
      style={{
        ...themeStyle,
        ...(isUnderlineNode && branchColor
          ? ({ '--mm-underline-color': branchColor } as React.CSSProperties)
          : {}),
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Handled by ReactFlow onNodeDoubleClick
      }}
    >
      {/* Collapse/Expand Toggle - 位置根据 targetPosition 或 side 调整
          触屏无 hover：mm-collapse-wrap 在 coarse 媒体查询下常驻淡色显示
          ★ embed（只读预览）：节点组件共用全局 store，embed 文档不在全局 store 中，
          折叠钮点击会误写当前打开的导图——仅在已折叠时保留计数徽标作纯展示 */}
      {hasChildren && (!isEmbed || isCollapsed) && (
        <div 
          className={cn(
            "mm-collapse-wrap w-5 h-5 z-20",
            isEmbed && "pointer-events-none",
            !selected && !isCollapsed ? "invisible group-hover:visible" : "visible"
          )}
          style={getCollapseButtonStyle()}
        >
          <DsButton variant="ghost"
            onClick={handleToggleCollapse}
            disabled={isEmbed}
            aria-label={isCollapsed ? t('actions.expand') : t('actions.collapse')}
            className={cn(
              "mm-collapse-btn w-5 h-5 border border-[var(--mm-border)]",
              isCollapsed && "is-collapsed",
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
          </DsButton>
        </div>
      )}

      <Handle
        type="target"
        position={getPosition(targetPos)}
        className={handleClassName}
        isConnectable={handlesConnectable}
        style={targetHandleStyle}
      />

      <div className="flex items-center">
        <NodeContent
          text={data.label}
          note={data.note}
          refs={data.refs}
          bgColor={data.style?.bgColor || (nodeTheme?.background || 'var(--mm-bg-elevated)')}
          icon={data.style?.icon}
          isCompleted={data.completed}
          isEditing={isEditing}
          isEditingNote={isEditingNote}
          blankedRanges={data.blankedRanges}
          revealedIndices={revealedBlanks[data.nodeId]}
          reciteMode={reciteMode}
          decorations={decorations}
          showCheckbox={data.style?.showCheckbox}
          onToggleCompleted={() => updateNode(data.nodeId, { completed: !data.completed })}
          onEmptyCommit={handleEmptyCommit}
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
      </div>

      {/* Action Buttons (Right side) - hidden in recite mode.
          ★ embed（只读预览）同样隐藏：hover 出的加号/菜单/删除会误写全局 store */}
      {!reciteMode && !isEmbed && (
      <div
        className={cn(
          "mm-node-actions nodrag nopan",
          // 与 RootNode 一致：选中或 hover 均可见（编辑态收起）
          isEditing
            ? "invisible pointer-events-none"
            : selected
              ? "visible pointer-events-auto"
              : "invisible pointer-events-none group-hover:visible group-hover:pointer-events-auto"
        )}
        style={{ left: '100%', marginLeft: '8px' }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DsButton variant="ghost"
          onClick={handleAddChild}
          className="mm-action-btn mm-action-btn--add"
          aria-label={t('actions.addChild')}
          title={t('node.addChildShortcut')}
        >
          <Plus className="w-3.5 h-3.5" />
        </DsButton>
        {/* 触屏下弱化侧向浮动操作（只保留加号）：菜单/删除走底部工具条 */}
        <DsButton variant="ghost"
          onClick={handleOpenMenu}
          className="mm-action-btn mm-action-btn--menu"
          aria-label={t('node.openMenu')}
          title={t('node.moreActions')}
        >
          <DotsThree className="w-3.5 h-3.5" />
        </DsButton>
        <DsButton variant="ghost"
          onClick={handleDelete}
          className="mm-action-btn mm-action-btn--delete hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          aria-label={t('actions.delete')}
          title={t('node.deleteShortcut')}
        >
          <Trash className="w-3.5 h-3.5" />
        </DsButton>
      </div>
      )}

      <Handle
        type="source"
        position={getPosition(sourcePos)}
        className={handleClassName}
        isConnectable={handlesConnectable}
        style={sourceHandleStyle}
      />
    </div>
  );
};
