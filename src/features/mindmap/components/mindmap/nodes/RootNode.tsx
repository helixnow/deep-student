import React, { useCallback, useContext, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Plus } from '@phosphor-icons/react';
import { NodeContent } from './NodeContent';
import { useNodeHeightObserver } from './useNodeHeightObserver';
import { pickDefined } from './styleUtils';
import { useMindMapStore, useMindMapStoreApi } from '../../../store';
import { MindMapThemeContext, useMindMapTheme } from '../../../hooks/useMindMapTheme';
import { getThemeFontMetrics, MM_NODE_LINE_HEIGHT_RATIO } from '../../../styles/themes';
import { openNodeRef } from '../../../utils/openNodeRef';
import { getSearchResultIdSet } from '../../../utils/searchFilter';
import {
  selectNodeDecorationKey,
  parseNodeDecorations,
} from '../../../utils/nodeDecorations';
import { selectNodeImages } from '../../../utils/nodeImages';
import { selectNodeExcerptMeta } from '../../../utils/nodeAnchors';
import type { NodeStyle, BlankRange, MindMapNodeRef } from '../../../types';
import { getMasteryBorderColor, type NodeMasteryStatus } from './BranchNode';
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
  /** FSRS 掌握度状态（供热力图微点/边色渲染） */
  masteryStatus?: NodeMasteryStatus;
  /** 是否开启 FSRS 掌握度热力图覆盖层 */
  showMasteryOverlay?: boolean;
  /** 嵌入预览指定主题 ID（优先于全局 store styleId） */
  embedStyleId?: string;
}

const RootNodeComponent: React.FC<NodeProps<Node<RootNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
  const nodeId = data.nodeId;

  // 精细原子订阅：仅订阅当前 nodeId 相关的原始/稳定值，避免其他节点编辑/搜索/揭空触发重渲染
  const isEditing = useMindMapStore(useCallback((state) => state.editingNodeId === nodeId, [nodeId]));
  const isEditingNote = useMindMapStore(useCallback((state) => state.editingNoteNodeId === nodeId, [nodeId]));
  const storeStyleId = useMindMapStore((state) => state.styleId);
  const effectiveStyleId = data.embedStyleId ?? storeStyleId;
  const reciteMode = useMindMapStore((state) => state.reciteMode);
  const isSearchMatch = useMindMapStore(
    useCallback((state) => getSearchResultIdSet(state.searchResults).has(nodeId), [nodeId]),
  );
  const isCurrentSearchMatch = useMindMapStore(
    useCallback(
      (state) => state.searchResults[state.currentSearchIndex] === nodeId,
      [nodeId],
    ),
  );
  const revealedIndices = useMindMapStore(
    useCallback((state) => state.revealedBlanks[nodeId], [nodeId]),
  );
  // 装饰字段（priority/progress/href）：布局引擎未拷贝，经索引直接读 store（值稳定 key，无装饰不触发重渲染）
  const decorationKey = useMindMapStore(
    useCallback((state) => selectNodeDecorationKey(state.document.root, nodeId), [nodeId]),
  );
  const decorations = parseNodeDecorations(decorationKey);
  // 内嵌图片：同样经索引直接读 store（数组引用稳定，无图不触发重渲染）
  const images = useMindMapStore(
    useCallback((state) => selectNodeImages(state.document.root, nodeId), [nodeId]),
  );
  // 摘录出处 / 原文：同一索引模式（无摘录节点恒为 null，不触发重渲染）
  const excerpt = useMindMapStore(
    useCallback((state) => selectNodeExcerptMeta(state.document.root, nodeId), [nodeId]),
  );

  const nodeRef = useRef<HTMLDivElement>(null);

  const themeCtx = useContext(MindMapThemeContext);
  const hasEmbedStyle = Boolean(data.embedStyleId);
  const usesCanvasCssVars = Boolean(themeCtx?.usesCanvasCssVars && !hasEmbedStyle);
  // 从 StyleRegistry 解析主题（订阅暗色模式切换与注册变更，见 useMindMapTheme）
  const theme = useMindMapTheme(effectiveStyleId, { bypassContext: hasEmbedStyle });

  const setMeasuredNodeHeight = useCallback(
    (id: string, height: number) => {
      storeApi.getState().setMeasuredNodeHeight(id, height);
    },
    [storeApi],
  );

  const handleTextChange = useCallback((text: string) => {
    storeApi.getState().updateNode(nodeId, { text });
  }, [nodeId, storeApi]);

  const handleCommitLiveText = useCallback((text: string) => {
    storeApi.getState().updateNode(nodeId, { text }, { preserveBlankedRanges: true, skipHistory: true });
  }, [nodeId, storeApi]);

  const handleStartEdit = useCallback(() => {
    storeApi.getState().setEditingNodeId(nodeId);
  }, [nodeId, storeApi]);

  // 按 nodeId 守卫：连续建点时旧 textarea blur 不得清掉新节点的 editingNodeId
  const handleEndEdit = useCallback(() => {
    const state = storeApi.getState();
    if (state.editingNodeId === nodeId) {
      state.setEditingNodeId(null);
    }
  }, [nodeId, storeApi]);

  const handleCommitAndCreateSibling = useCallback(() => {
    // 根节点 Enter → 子级（与非编辑快捷键一致）
    const state = storeApi.getState();
    const newId = state.addNode(nodeId);
    if (newId) {
      state.setFocusedNodeId(newId);
      state.setEditingNodeId(newId);
    }
  }, [nodeId, storeApi]);

  const handleCommitAndCreateChild = useCallback(() => {
    const state = storeApi.getState();
    const newId = state.addNode(nodeId);
    if (newId) {
      state.setFocusedNodeId(newId);
      state.setEditingNodeId(newId);
    }
  }, [nodeId, storeApi]);

  const handleAddChild = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleCommitAndCreateChild();
  }, [handleCommitAndCreateChild]);

  // 记录节点实测高度，避免布局重叠
  // ★ 2026-02 优化：embed 模式下跳过测量，防止小容器的测量值覆盖主编辑器
  const isEmbed = !!(data as Record<string, unknown>).isEmbed;
  useNodeHeightObserver(nodeRef, nodeId, setMeasuredNodeHeight, !isEmbed);

  // 主题样式 - 从 theme.node.root 获取；fallback 走主题度量单一数据源
  const rootTheme = theme?.node?.root;
  const rootMetrics = getThemeFontMetrics(theme, true);

  const hasCustomBg = Boolean(data.style?.bgColor && data.style.bgColor !== 'transparent');
  const activeMasteryStatus = data.showMasteryOverlay ? data.masteryStatus : undefined;
  const masteryBorderColor = getMasteryBorderColor(activeMasteryStatus);

  // 自定义样式（来自 data.style）优先级高于主题样式
  // ★ 修复：剔除 undefined 字段——直接展开会把主题样式同名键覆盖为 undefined，
  //   导致主题 foreground / fontWeight 等被静默丢弃
  const customStyle: React.CSSProperties = pickDefined({
    background: hasCustomBg ? data.style?.bgColor : undefined,
    color: data.style?.textColor || (hasCustomBg ? 'var(--mm-text)' : undefined),
    fontWeight: data.style?.fontWeight,
    fontStyle: data.style?.fontStyle === 'italic' ? 'italic' : undefined,
    textDecoration: data.style?.textDecoration && data.style.textDecoration !== 'none' ? data.style.textDecoration : undefined,
    fontSize: data.style?.headingLevel === 'h1' ? '22px' : data.style?.headingLevel === 'h2' ? '18px' : data.style?.headingLevel === 'h3' ? '16px' : data.style?.fontSize ? `${data.style.fontSize}px` : undefined,
  });

  const themeBg = usesCanvasCssVars
    ? (rootTheme?.background ? `var(--mm-root-bg, ${rootTheme.background})` : 'var(--mm-root-bg, var(--mm-bg-elevated))')
    : (rootTheme?.background || 'var(--mm-bg-elevated)');
  const themeFg = usesCanvasCssVars
    ? (rootTheme?.foreground ? `var(--mm-root-fg, ${rootTheme.foreground})` : 'var(--mm-root-fg, var(--mm-text))')
    : (rootTheme?.foreground || 'var(--mm-text)');
  const themeBorder = usesCanvasCssVars
    ? (rootTheme?.border ? `var(--mm-root-border, ${rootTheme.border})` : 'var(--mm-root-border, 1px solid var(--mm-border))')
    : (rootTheme?.border || '1px solid var(--mm-border)');
  const themeShadow = rootTheme?.shadow
    ? (usesCanvasCssVars ? `var(--mm-root-shadow, ${rootTheme.shadow})` : rootTheme.shadow)
    : undefined;

  // 边框统一经单一 `border` 简写合成（禁止与条件 `borderColor` 混用，防退出热力图时退化为 currentColor）
  const resolvedBorder = masteryBorderColor
    ? `1px solid ${masteryBorderColor}`
    : hasCustomBg
      ? `1px solid color-mix(in srgb, ${data.style?.bgColor} 70%, var(--mm-text) 22%)`
      : themeBorder;

  // 合并主题样式和自定义样式，自定义样式优先级更高
  // ★ 修复：正确应用全局主题的所有属性
  const themeStyle: React.CSSProperties = {
    background: themeBg,
    color: themeFg,
    border: resolvedBorder,
    borderRadius: rootTheme?.borderRadius ? `${rootTheme.borderRadius}px` : '10px',
    fontSize: rootTheme?.fontSize ? `${rootTheme.fontSize}px` : `${rootMetrics.fontSize}px`,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    fontWeight: rootTheme?.fontWeight || 600,
    padding: rootTheme?.padding || '10px 20px',
    // ★ 修复：不要强制内联 boxShadow: 'none'——内联样式会压过
    //   .selected 选中轻染 / search-match 命中框 / .mm-dragging 抬起阴影
    //   等 class 级 box-shadow 反馈；主题未定义 shadow 时干脆不写内联值
    ...(themeShadow ? { boxShadow: themeShadow } : {}),
    // 自定义样式优先级更高
    ...customStyle,
  };

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
      data-node-editing={isEditing ? 'true' : undefined}
      data-mastery-status={activeMasteryStatus}
      role={isEmbed ? undefined : 'treeitem'}
      tabIndex={isEmbed ? undefined : 0}
      aria-selected={isEmbed ? undefined : Boolean(selected)}
      aria-label={isEmbed ? undefined : (data.label || t('outline.unnamedNode', { defaultValue: '中心主题' }))}
      style={themeStyle}
      onClick={() => {
        if (!isEmbed) storeApi.getState().setFocusedNodeId(nodeId);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!reciteMode && !isEmbed) handleStartEdit();
      }}
    >
      {activeMasteryStatus && (
        <span
          className="mm-mastery-dot"
          data-mastery-status={activeMasteryStatus}
          data-testid="mm-mastery-dot"
          aria-hidden="true"
        />
      )}

      <NodeContent
        nodeId={nodeId}
        text={data.label}
        note={data.note}
        refs={data.refs}
        images={images}
        icon={data.style?.icon}
        isRoot
        isCompleted={data.completed}
        isEditing={isEditing}
        isEditingNote={isEditingNote}
        blankedRanges={data.blankedRanges}
        revealedIndices={revealedIndices}
        reciteMode={reciteMode}
        decorations={decorations}
        excerpt={excerpt}
        isSelected={selected}
        onRemoveAnchor={isEmbed ? undefined : (anchorUri) => storeApi.getState().removeNodeAnchor(nodeId, anchorUri)}
        onRemoveExcerptSlot={isEmbed ? undefined : (slotId) => storeApi.getState().removeNodeExcerptSlot(nodeId, slotId)}
        onCardNoteChange={isEmbed ? undefined : (cardNote) => storeApi.getState().setNodeCardNote(nodeId, cardNote)}
        onToggleExpandedCard={isEmbed ? undefined : () => storeApi.getState().toggleNodeExpandedCard(nodeId)}
        onToggleFlashcard={isEmbed ? undefined : () => storeApi.getState().toggleNodeFlashcard(nodeId)}
        showCheckbox={data.style?.showCheckbox}
        onToggleCompleted={() => storeApi.getState().updateNode(nodeId, { completed: !data.completed })}
        onTextChange={handleTextChange}
        onCommitLiveText={handleCommitLiveText}
        onNoteChange={(note) => storeApi.getState().updateNode(nodeId, { note })}
        onStartEdit={reciteMode ? undefined : handleStartEdit}
        onEndEdit={handleEndEdit}
        onEndEditNote={() => storeApi.getState().setEditingNoteNodeId(null)}
        onCommitAndCreateSibling={reciteMode ? undefined : handleCommitAndCreateSibling}
        onCommitAndCreateChild={reciteMode ? undefined : handleCommitAndCreateChild}
        onCommitAndEditNote={reciteMode ? undefined : () => {
          const state = storeApi.getState();
          state.setEditingNodeId(null);
          state.setEditingNoteNodeId(nodeId);
        }}
        isBold={data.style?.fontWeight === 'bold'}
        onRevealBlank={(rangeIndex) => storeApi.getState().revealBlank(nodeId, rangeIndex)}
        onBlanksPresented={(rangeIndices) => storeApi.getState().markBlanksPresented(nodeId, rangeIndices)}
        onAddBlank={(range) => storeApi.getState().addBlankRange(nodeId, range)}
        onRemoveBlank={(rangeIndex) => storeApi.getState().removeBlankRange(nodeId, rangeIndex)}
        onToggleBold={() =>
          storeApi.getState().updateNode(nodeId, {
            style: {
              ...data.style,
              fontWeight: data.style?.fontWeight === 'bold' ? undefined : 'bold',
            },
          })
        }
        onRemoveRef={isEmbed ? undefined : (sourceId) => storeApi.getState().removeNodeRef(nodeId, sourceId)}
        onClickRef={
          isEmbed
            ? undefined
            : (sourceId) => {
                const ref = data.refs?.find((r) => r.sourceId === sourceId);
                void openNodeRef(sourceId, { type: ref?.type, name: ref?.name });
              }
        }
      />

      {/* Action Buttons Container - hidden in recite mode.
          ★ embed（聊天卡片只读预览）同样隐藏：节点组件共用全局 store，
          embed 文档不在全局 store 中，hover 出的加号点击会误写当前打开的导图 */}
      {!reciteMode && !isEmbed && (
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
        <DsButton variant="ghost"
          onClick={handleAddChild}
          className="mm-collapse-btn bg-[var(--mm-bg-elevated)] border border-[var(--mm-border)] w-6 h-6 hover:bg-[var(--mm-bg-hover)]"
          aria-label={t('actions.addChild')}
        >
          <Plus className="w-3.5 h-3.5 text-[var(--mm-text-secondary)]" />
        </DsButton>
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

export const RootNode = React.memo(RootNodeComponent);
RootNode.displayName = 'RootNode';
