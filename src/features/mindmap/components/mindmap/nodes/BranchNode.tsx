import React, { useCallback, useContext, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, NodeProps, Node } from '@xyflow/react';
import { cn } from '@/lib/utils';
import { Plus, Trash, DotsThree } from '@phosphor-icons/react';
import { NodeContent } from './NodeContent';
import { useNodeHeightObserver } from './useNodeHeightObserver';
import { pickDefined } from './styleUtils';
import { useMindMapStore, useMindMapStoreApi } from '../../../store';
import { MindMapThemeContext, useMindMapDarkMode, useMindMapTheme } from '../../../hooks/useMindMapTheme';
import { getThemeFontMetrics, MM_NODE_LINE_HEIGHT_RATIO } from '../../../styles/themes';
import { getBranchColor } from '../../../constants/colors';
import { findParentNode, findNodeById } from '../../../utils/node/find';
import { openNodeRef } from '../../../utils/openNodeRef';
import { getSearchResultIdSet } from '../../../utils/searchFilter';
import {
  selectNodeDecorationKey,
  parseNodeDecorations,
} from '../../../utils/nodeDecorations';
import { selectNodeImages } from '../../../utils/nodeImages';
import { selectNodeExcerptMeta } from '../../../utils/nodeAnchors';
import type { NodeStyle, BlankRange, MindMapNode, MindMapNodeRef } from '../../../types';
import './nodes.css';

export type NodeMasteryStatus = 'due' | 'learning' | 'mastered' | 'struggling';

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
  /** 一级分支索引（可选，未传时按文档树 O(1) 缓存解析） */
  branchIndex?: number;
  /** FSRS 掌握度状态（供热力图微点/边色渲染） */
  masteryStatus?: NodeMasteryStatus;
  /** 是否开启 FSRS 掌握度热力图覆盖层 */
  showMasteryOverlay?: boolean;
  /** 嵌入预览指定主题 ID（优先于全局 store styleId） */
  embedStyleId?: string;
  /**
   * 明确开启 Handle 拖拽连接（onConnect → reparent）。
   * 默认关闭：普通拖动锚点极易误触 reparent，改父级请用节点整体拖拽（drop target）。
   */
  handlesConnectable?: boolean;
  onOpenMenu?: (nodeId: string, position: { x: number; y: number }) => void;
}

const branchIndexCache = new WeakMap<MindMapNode, ReadonlyMap<string, number>>();

/** O(1) 查询节点所属的一级分支序号（按文档根引用缓存，整棵树仅遍历一次） */
function selectNodeBranchIndex(root: MindMapNode, nodeId: string): number {
  let map = branchIndexCache.get(root);
  if (!map) {
    const built = new Map<string, number>();
    root.children.forEach((branch, index) => {
      const stack: MindMapNode[] = [branch];
      while (stack.length > 0) {
        const current = stack.pop()!;
        built.set(current.id, index);
        for (const child of current.children) stack.push(child);
      }
    });
    branchIndexCache.set(root, built);
    map = built;
  }
  return map.get(nodeId) ?? -1;
}

function getPosition(pos: string): Position {
  switch (pos) {
    case 'left': return Position.Left;
    case 'right': return Position.Right;
    case 'top': return Position.Top;
    case 'bottom': return Position.Bottom;
    default: return Position.Left;
  }
}

export function getMasteryBorderColor(status: NodeMasteryStatus | undefined): string | undefined {
  switch (status) {
    case 'mastered':
      return 'hsl(var(--success, 142 71% 45%) / 0.78)';
    case 'learning':
      return 'hsl(var(--primary) / 0.78)';
    case 'due':
      return 'hsl(var(--warning, 38 92% 50%) / 0.85)';
    case 'struggling':
      return 'hsl(var(--destructive) / 0.85)';
    default:
      return undefined;
  }
}

interface BranchStaticLabels {
  lang: string;
  expand: string;
  collapse: string;
  addChild: string;
  addChildShortcut: string;
}

let cachedBranchLabels: BranchStaticLabels | null = null;

function getBranchStaticLabels(
  t: (key: string) => string,
  lang: string,
): BranchStaticLabels {
  if (lang && cachedBranchLabels && cachedBranchLabels.lang === lang) {
    return cachedBranchLabels;
  }
  const next: BranchStaticLabels = {
    lang,
    expand: t('actions.expand'),
    collapse: t('actions.collapse'),
    addChild: t('actions.addChild'),
    addChildShortcut: t('node.addChildShortcut'),
  };
  if (lang) {
    cachedBranchLabels = next;
  }
  return next;
}

const BranchNodeComponent: React.FC<NodeProps<Node<BranchNodeData>>> = ({
  data,
  selected,
}) => {
  const { t, i18n } = useTranslation('mindmap');
  const staticLabels = getBranchStaticLabels(t, i18n?.resolvedLanguage || i18n?.language || '');
  const storeApi = useMindMapStoreApi();
  const nodeId = data.nodeId;

  // 精细原子订阅：仅订阅当前 nodeId 相关的原始/稳定值，避免编辑/搜索/揭空触发全图 500+ 节点重渲染
  const isEditing = useMindMapStore(useCallback((state) => state.editingNodeId === nodeId, [nodeId]));
  const isEditingNote = useMindMapStore(useCallback((state) => state.editingNoteNodeId === nodeId, [nodeId]));
  const storeStyleId = useMindMapStore((state) => state.styleId);
  const styleId = data.embedStyleId ?? storeStyleId;
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

  const themeCtx = useContext(MindMapThemeContext);
  const hasEmbedStyle = Boolean(data.embedStyleId);
  const usesCanvasCssVars = Boolean(themeCtx?.usesCanvasCssVars && !hasEmbedStyle);
  const isLargeGraph = Boolean(themeCtx?.isLargeGraph && !hasEmbedStyle);
  const [hoveredForActions, setHoveredForActions] = useState(false);
  // 从 StyleRegistry 解析主题（订阅暗色模式切换与注册变更，见 useMindMapTheme）
  const theme = useMindMapTheme(styleId, { bypassContext: hasEmbedStyle });
  const isDark = useMindMapDarkMode(hasEmbedStyle);
  const isDarkTheme =
    isDark || theme?.id === 'dark' || Boolean(theme?.id?.endsWith('-dark'));

  const useBranchPalette = Boolean(theme?.useBranchPalette);
  const needsDerivedBranchIndex =
    useBranchPalette && !data.branchColor && typeof data.branchIndex !== 'number';
  const derivedBranchIndex = useMindMapStore(
    useCallback(
      (state) => (needsDerivedBranchIndex ? selectNodeBranchIndex(state.document.root, nodeId) : -1),
      [needsDerivedBranchIndex, nodeId],
    ),
  );

  const nodeRef = useRef<HTMLDivElement>(null);

  const hasChildren = data.hasChildren;
  const isCollapsed = data.collapsed;

  // Handle 位置
  const targetPos = data.targetPosition || 'left';
  const sourcePos = data.sourcePosition || 'right';
  const sourcePositionEnum = getPosition(sourcePos);
  const targetPositionEnum = getPosition(targetPos);

  const isEmbed = !!(data as Record<string, unknown>).isEmbed;
  const showCollapseButton = hasChildren && (!isEmbed || isCollapsed);

  // 根据 sourcePosition 计算折叠按钮位置（锚定在子节点外侧，支持 >=100 自适应胶囊宽度）
  const getCollapseButtonStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
    switch (sourcePos) {
      case 'left':
        return { ...baseStyle, right: '100%', marginRight: '4px', top: '50%', marginTop: '-10px' };
      case 'right':
        return { ...baseStyle, left: '100%', marginLeft: '4px', top: '50%', marginTop: '-10px' };
      case 'top':
        return { ...baseStyle, bottom: '100%', marginBottom: '4px', left: '50%', transform: 'translateX(-50%)' };
      case 'bottom':
        return { ...baseStyle, top: '100%', marginTop: '4px', left: '50%', transform: 'translateX(-50%)' };
      default:
        return { ...baseStyle, left: '100%', marginLeft: '4px', top: '50%', marginTop: '-10px' };
    }
  };

  // 操作按钮组位置：
  // - sourcePos === Position.Left 时挂靠节点左侧，避免撞上右侧父级连线；
  // - 同侧存在折叠按钮时自动外移避让（28px，>=100 三位胶囊时 36px），彻底消除 64% 重叠。
  const actionsOnLeft = sourcePositionEnum === Position.Left;
  const hasSameSideCollapse =
    showCollapseButton && (actionsOnLeft ? sourcePos === 'left' : sourcePos === 'right');
  const actionOffsetPx = hasSameSideCollapse
    ? (isCollapsed && data.childCount >= 100 ? 36 : 28)
    : 6;
  const actionsStyle: React.CSSProperties = actionsOnLeft
    ? {
        left: 'auto',
        right: '100%',
        marginLeft: 0,
        marginRight: `${actionOffsetPx}px`,
        flexDirection: 'row-reverse',
      }
    : {
        left: '100%',
        right: 'auto',
        marginLeft: `${actionOffsetPx}px`,
        marginRight: 0,
      };

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
    const { document: doc, addNode: add, setFocusedNodeId: focus, setEditingNodeId: edit } =
      storeApi.getState();
    const root = doc.root;
    if (root.id === nodeId) {
      const newId = add(nodeId, 0);
      if (newId) {
        focus(newId);
        edit(newId);
      }
      return;
    }
    const parent = findParentNode(root, nodeId);
    if (!parent) return;
    const idx = parent.children.findIndex((c) => c.id === nodeId);
    const newId = add(parent.id, idx + 1);
    if (newId) {
      focus(newId);
      edit(newId);
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

  // 空文本失焦策略：新建后从未输入内容的空节点，真正结束编辑时删除（不留「未命名」残留）。
  // 守卫与 handleEndEdit 同源：连续建点（Enter 后 editingNodeId 已移至新节点）时不删除。
  const handleEmptyCommit = useCallback(() => {
    const state = storeApi.getState();
    if (state.editingNodeId !== nodeId) return;
    state.setEditingNodeId(null);
    const node = findNodeById(state.document.root, nodeId);
    // 有子节点或已有正文（如经 live commit 写入）的节点不删
    if (node && (node.children?.length ?? 0) === 0 && node.text.trim() === '') {
      state.deleteNode(nodeId);
    }
  }, [nodeId, storeApi]);

  const handleAddChild = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleCommitAndCreateChild();
  }, [handleCommitAndCreateChild]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    storeApi.getState().deleteNode(nodeId);
  }, [nodeId, storeApi]);

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
    storeApi.getState().toggleCollapse(nodeId);
  }, [nodeId, storeApi]);

  // 记录节点实测高度，避免布局重叠
  // ★ 2026-02 优化：embed 模式下跳过测量，防止小容器的测量值覆盖主编辑器
  useNodeHeightObserver(nodeRef, nodeId, setMeasuredNodeHeight, !isEmbed);

  // 节点外观只由层级决定，避免新增子节点时在 branch/leaf 样式间跳变。
  const nodeTheme = data.level === 1 ? theme?.node?.branch : theme?.node?.leaf;
  // fallback 字号走主题度量单一数据源（default 主题 branch 实为 15px，勿再硬编码 14px）
  const branchMetrics = getThemeFontMetrics(theme, false);

  // 二级及以下使用下划线风格。
  const isUnderlineNode = data.level >= 2;
  const effectiveBranchIndex =
    typeof data.branchIndex === 'number' ? data.branchIndex : derivedBranchIndex;
  const branchColor =
    data.branchColor ??
    (useBranchPalette && effectiveBranchIndex >= 0
      ? getBranchColor(effectiveBranchIndex, Math.max(0, data.level - 1), isDarkTheme)
      : undefined);
  const hasCustomBg = Boolean(data.style?.bgColor && data.style.bgColor !== 'transparent');
  const activeMasteryStatus = data.showMasteryOverlay ? data.masteryStatus : undefined;
  const masteryBorderColor = getMasteryBorderColor(activeMasteryStatus);

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

  // 下划线语义色优先级：掌握度热力边色 > 自定义背景派生色 > 彩虹分支色
  const underlineColor = masteryBorderColor
    ? masteryBorderColor
    : hasCustomBg
      ? `color-mix(in srgb, ${data.style!.bgColor} 65%, var(--mm-text) 22%)`
      : branchColor;

  const themeBg = usesCanvasCssVars
    ? (nodeTheme?.background ? `var(--mm-branch-bg, ${nodeTheme.background})` : 'var(--mm-branch-bg, var(--mm-bg-elevated))')
    : (nodeTheme?.background || 'var(--mm-bg-elevated)');
  const themeFg = usesCanvasCssVars
    ? isUnderlineNode
      ? (nodeTheme?.foreground ? `var(--mm-leaf-fg, ${nodeTheme.foreground})` : 'var(--mm-leaf-fg, var(--mm-text))')
      : (nodeTheme?.foreground ? `var(--mm-branch-fg, ${nodeTheme.foreground})` : 'var(--mm-branch-fg, var(--mm-text))')
    : (nodeTheme?.foreground || 'var(--mm-text)');
  const themeBorder = usesCanvasCssVars
    ? (nodeTheme?.border ? `var(--mm-branch-border, ${nodeTheme.border})` : 'var(--mm-branch-border, 1px solid var(--mm-border))')
    : (nodeTheme?.border || '1px solid var(--mm-border)');
  const themeShadow = nodeTheme?.shadow
    ? (usesCanvasCssVars ? `var(--mm-branch-shadow, ${nodeTheme.shadow})` : nodeTheme.shadow)
    : undefined;

  // Box 边框统一经单一 `border` 简写合成（禁止与条件 `borderColor` 混用，
  // 否则关闭热力图或切出彩虹主题时 React 清空 `borderColor` 会把边框退化为 currentColor）
  const resolvedBoxBorder = masteryBorderColor
    ? `1px solid ${masteryBorderColor}`
    : hasCustomBg
      ? `1px solid color-mix(in srgb, ${data.style!.bgColor} 70%, var(--mm-text) 18%)`
      : branchColor && data.level === 1
        ? `1px solid ${branchColor}`
        : themeBorder;

  // 合并主题样式和自定义样式
  // ★ 修复「框内黄补丁 Bug」：当用户设置 data.style?.bgColor 时，直接微染整个节点卡片外壳；
  //   Level 2+ 枝叶节点仅在显式设置 bgColor 时呈现 6px 圆角轻量微染胶囊，未设置时保持纯净透明排版流
  const themeStyle: React.CSSProperties = isUnderlineNode ? {
    background: hasCustomBg ? data.style!.bgColor : 'transparent',
    color: themeFg,
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : `${branchMetrics.fontSize}px`,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    // 自定义样式优先级更高
    ...customStyle,
    border: 'none',
    boxShadow: 'none',
    borderRadius: hasCustomBg ? '6px' : '0px',
    padding: hasCustomBg ? '3px 8px 4px 8px' : '2px 4px',
    borderBottom: '1.5px solid var(--mm-underline-color, var(--mm-border))',
  } : {
    background: hasCustomBg ? data.style!.bgColor : themeBg,
    color: themeFg,
    border: resolvedBoxBorder,
    borderRadius: nodeTheme?.borderRadius ? `${nodeTheme.borderRadius}px` : '8px',
    fontSize: nodeTheme?.fontSize ? `${nodeTheme.fontSize}px` : `${branchMetrics.fontSize}px`,
    fontWeight: nodeTheme?.fontWeight || 500,
    // 行高与布局估算（getThemeFontMetrics）保持同一系数，编辑态 textarea 继承后不跳动
    lineHeight: MM_NODE_LINE_HEIGHT_RATIO,
    padding: nodeTheme?.padding || '7px 14px',
    ...(themeShadow ? { boxShadow: themeShadow } : {}),
    // 自定义样式优先级更高
    ...customStyle,
  };

  // 下划线节点 Handle 定位：
  // - 水平方向（left/right）：锚点贴在下划线两端（bottom: -4px）
  // - 垂直组织图方向（top/bottom）：按真实 Position.Top / Position.Bottom 水平居中对齐，防止连线穿透节点文字
  const getUnderlineHandleStyle = (pos: string): React.CSSProperties => {
    if (!isUnderlineNode) return {};
    if (pos === 'top') {
      return {
        top: '-3px',
        bottom: 'auto',
        left: '50%',
        right: 'auto',
        transform: 'translateX(-50%)',
      };
    }
    if (pos === 'bottom') {
      return {
        top: 'auto',
        bottom: '-4px',
        left: '50%',
        right: 'auto',
        transform: 'translateX(-50%)',
      };
    }
    return {
      top: 'auto',
      bottom: '-4px',
      transform: 'none',
      left: pos === 'left' ? 0 : 'auto',
      right: pos === 'right' ? 0 : 'auto',
      marginLeft: pos === 'left' ? '-3px' : 0,
      marginRight: pos === 'right' ? '-3px' : 0,
    };
  };

  const targetHandleStyle = getUnderlineHandleStyle(targetPos);
  const sourceHandleStyle = getUnderlineHandleStyle(sourcePos);

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
        "group relative flex items-center justify-center gap-1",
        spawnOriginClass,
        selected && "selected",
        isEditing && "editing",
        isSearchMatch && "search-match",
        isCurrentSearchMatch && "search-match-current",
        data.completed && "mm-completed"
      )}
      data-node-chrome={isUnderlineNode ? 'underline' : 'box'}
      data-has-bg={hasCustomBg ? 'true' : undefined}
      data-node-editing={isEditing ? 'true' : undefined}
      data-mastery-status={activeMasteryStatus}
      style={{
        ...themeStyle,
        ...(isUnderlineNode && underlineColor
          ? ({ '--mm-underline-color': underlineColor } as React.CSSProperties)
          : {}),
      }}
      onMouseEnter={isLargeGraph ? () => setHoveredForActions(true) : undefined}
      onMouseLeave={isLargeGraph ? () => setHoveredForActions(false) : undefined}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Handled by ReactFlow onNodeDoubleClick
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

      {/* Collapse/Expand Toggle - 位置根据 sourcePosition 调整
          触屏无 hover：mm-collapse-wrap 在 coarse 媒体查询下常驻淡色显示
          ★ embed（只读预览）：节点组件共用全局 store，embed 文档不在全局 store 中，
          折叠钮点击会误写当前打开的导图——仅在已折叠时保留计数徽标作纯展示 */}
      {showCollapseButton && (
        <div
          className={cn(
            "mm-collapse-wrap min-w-5 h-5 z-20",
            isEmbed && "pointer-events-none",
            !selected && !isCollapsed ? "invisible group-hover:visible" : "visible"
          )}
          style={getCollapseButtonStyle()}
        >
          <button
            type="button"
            onClick={handleToggleCollapse}
            disabled={isEmbed}
            aria-label={isCollapsed ? staticLabels.expand : staticLabels.collapse}
            className={cn(
              "mm-collapse-btn border",
              isCollapsed
                ? "is-collapsed min-w-5 h-5 px-1 rounded-full border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] hover:bg-[var(--mm-bg-hover)]"
                : "w-5 h-5 bg-transparent hover:bg-[var(--mm-bg-hover)] border-transparent hover:border-[var(--mm-border)]"
            )}
          >
            {isCollapsed ? (
              <span className="flex items-center justify-center text-[10px] font-bold leading-none tabular-nums whitespace-nowrap text-[var(--mm-text-muted)]">
                {data.childCount}
              </span>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--mm-border-strong)] group-hover:bg-[var(--mm-text-secondary)] transition-colors motion-reduce:transition-none" />
            )}
          </button>
        </div>
      )}

      <Handle
        type="target"
        position={targetPositionEnum}
        className={handleClassName}
        isConnectable={handlesConnectable}
        style={targetHandleStyle}
      />

      <div className="flex w-full min-w-0 items-center">
        <NodeContent
          nodeId={nodeId}
          text={data.label}
          note={data.note}
          refs={data.refs}
          images={images}
          icon={data.style?.icon}
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
          onEmptyCommit={handleEmptyCommit}
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
      </div>

      {/* Action Buttons - hidden in recite mode & embed.
          ★ 克制化收敛：非选中悬停仅轻显单个「+」按钮，避免掠过画布时到处闪烁三个方块与刺眼红垃圾桶；
            仅当节点被选中（selected）时才展开更多菜单与删除入口 */}
      {!reciteMode && !isEmbed && (!isLargeGraph || selected || hoveredForActions) && (
      <div
        className={cn(
          "mm-node-actions nodrag nopan",
          isEditing
            ? "invisible pointer-events-none"
            : selected
              ? "visible pointer-events-auto"
              : "invisible pointer-events-none group-hover:visible group-hover:pointer-events-auto"
        )}
        style={actionsStyle}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleAddChild}
          className="mm-action-btn mm-action-btn--add"
          aria-label={staticLabels.addChild}
          title={staticLabels.addChildShortcut}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        {selected && (
          <>
            <button
              type="button"
              onClick={handleOpenMenu}
              className="mm-action-btn mm-action-btn--menu"
              aria-label={t('node.openMenu')}
              title={t('node.moreActions')}
            >
              <DotsThree className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="mm-action-btn mm-action-btn--delete hover:text-[hsl(var(--destructive))]"
              aria-label={t('actions.delete')}
              title={t('node.deleteShortcut')}
            >
              <Trash className="w-3.5 h-3.5" />
            </button>
          </>
        )}
      </div>
      )}

      <Handle
        type="source"
        position={sourcePositionEnum}
        className={handleClassName}
        isConnectable={handlesConnectable}
        style={sourceHandleStyle}
      />
    </div>
  );
};

export const BranchNode = React.memo(BranchNodeComponent);
BranchNode.displayName = 'BranchNode';
