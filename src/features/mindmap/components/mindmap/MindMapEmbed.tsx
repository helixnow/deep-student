/**
 * 嵌入式思维导图组件
 * 
 * 用于在聊天消息等场景中内联渲染思维导图预览
 * 特点：
 * - 独立加载数据（不依赖全局 store）
 * - 只读模式（禁用编辑、拖拽）
 * - 无工具栏、无 MiniMap
 * - 自适应容器尺寸
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../styles/mindmap.css';

import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { WarningCircle, ArrowsOut, ArrowClockwise, MagnifyingGlassPlus, MagnifyingGlassMinus, Crosshair, GitFork } from '@phosphor-icons/react';
import { dstu } from '@/dstu';

import {
  getMindMap,
  getMindMapContent,
  getMindMapVersion,
  getMindMapVersionContent,
} from '../../api';
import { DEFAULT_LAYOUT_CONFIG, REACTFLOW_CONFIG, ROOT_NODE_STYLE, calculateBaseNodeHeight } from '../../constants';
import { LayoutRegistry, StyleRegistry } from '../../registry';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { ensureInitialized } from '../../init';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import type { MindMapDocument, VfsMindMap } from '../../types';

// ============================================================================
// 类型定义
// ============================================================================

export interface MindMapEmbedProps {
  /** 思维导图 ID（当前版本） */
  mindmapId?: string;
  /** 思维导图版本 ID（历史版本快照） */
  versionId?: string;
  /** 容器高度（默认 300px） */
  height?: number;
  /** 自定义类名 */
  className?: string;
  /** 点击打开回调 */
  onOpen?: () => void;
  /** 是否显示打开按钮 */
  showOpenButton?: boolean;
  /** 外部传入的显示标题（加载期间 fallback 显示） */
  displayTitle?: string;
}

interface LoadState {
  loading: boolean;
  error: string | null;
  metadata: VfsMindMap | null;
  document: MindMapDocument | null;
  /** ★ 2026-02-13: 版本引用时保存父导图 ID，用于"打开导图"导航 */
  parentMindmapId: string | null;
}

// 节点数阈值：超过此数量时使用 2 倍高度
const LARGE_MAP_NODE_THRESHOLD = 10;

/** 嵌入卡片角落控制按钮的统一外观（缩放/布局/打开等） */
const EMBED_CONTROL_BUTTON_CLASS = cn(
  'p-1.5 rounded-md [@media(pointer:coarse)]:min-w-10 [@media(pointer:coarse)]:min-h-10',
  'inline-flex items-center justify-center',
  'bg-background/80 hover:bg-background',
  'border border-border/50 hover:border-border',
  'text-muted-foreground hover:text-foreground',
  'transition-all duration-150',
  'cursor-pointer',
);

/**
 * 递归统计导图节点总数
 */
function countNodes(node: MindMapDocument['root']): number {
  if (!node) return 0;
  let count = 1;
  if (node.children?.length) {
    for (const child of node.children) {
      count += countNodes(child);
    }
  }
  return count;
}

// ============================================================================
// 内部组件：ReactFlow 渲染器
// ============================================================================

interface MindMapEmbedInnerProps {
  document: MindMapDocument;
  metadata: VfsMindMap | null;
}

// ★ 2026-07-08（审计 27-P1-2）：提为模块级常量。
// 原先是组件体内每次渲染新建的 {} 字面量，又被列入布局 useMemo 的依赖数组，
// 导致 memo 实质失效——每次父组件重渲染（聊天流式输出期间高频发生）都会全量重跑布局引擎。
const EMBED_MEASURED_NODE_HEIGHTS: Record<string, number> = Object.freeze({});

const MindMapEmbedInner: React.FC<MindMapEmbedInnerProps> = ({ document }) => {
  ensureInitialized();
  const { t } = useTranslation('mindmap');
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const hasFitView = useRef(false);
  // 触屏（粗指针）设备：嵌入卡片放行单指滑动给聊天滚动；响应运行时输入设备变化
  const isCoarsePointer = useCoarsePointer();

  // ★ 2026-02 修复：Embed 使用独立的默认配置，不订阅全局 store
  // 避免主编辑器切换布局/样式时导致所有 Embed 实例重新渲染
  const measuredNodeHeights = EMBED_MEASURED_NODE_HEIGHTS;
  const [isBothLayout, setIsBothLayout] = useState(true);
  const layoutId = isBothLayout ? 'balanced' : 'tree';
  const layoutDirection = isBothLayout ? 'both' : 'right';
  const edgeType = 'bezier';
  const styleId = 'default';

  // 切换单侧/两翼布局
  const handleToggleLayout = useCallback(() => {
    setIsBothLayout(prev => !prev);
    hasFitView.current = false; // 切换布局后重新 fitView
  }, []);

  const layoutEngine = useMemo(() => {
    const engine = LayoutRegistry.get(layoutId);
    if (!engine) {
      return LayoutRegistry.get('tree');
    }
    return engine;
  }, [layoutId]);

  const defaultEdgeType = useMemo(() => {
    const edgeTypeMap: Record<string, string> = {
      bezier: 'curved',
      curved: 'curved',
      straight: 'straight',
      orthogonal: 'orthogonal',
      step: 'step',
      smoothstep: 'smoothstep',
    };
    return edgeTypeMap[edgeType] || 'curved';
  }, [edgeType]);

  // 缩放控制函数
  const handleZoomIn = useCallback(() => zoomIn({ duration: 200 }), [zoomIn]);
  const handleZoomOut = useCallback(() => zoomOut({ duration: 200 }), [zoomOut]);
  const handleFitView = useCallback(() => fitView({ padding: 0.15, duration: 200 }), [fitView]);

  // 计算布局
  const { nodes, edges } = useMemo(() => {
    if (!document?.root) {
      return { nodes: [] as Node[], edges: [] as Edge[] };
    }

    if (!layoutEngine) {
      return { nodes: [] as Node[], edges: [] as Edge[] };
    }

    const validDirection = layoutEngine.directions.includes(layoutDirection)
      ? layoutDirection
      : layoutEngine.defaultDirection;

    const theme = StyleRegistry.get(styleId) || StyleRegistry.getDefault();
    const layoutConfig = {
      ...DEFAULT_LAYOUT_CONFIG,
      direction: validDirection,
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

    const layoutResult = layoutEngine.calculate(document.root, layoutConfig, validDirection);

    if (theme?.palette && theme.palette.length > 0) {
      const palette = theme.palette;
      const colorMap = new Map<string, string>();
      document.root.children?.forEach((child, index) => {
        const color = palette[index % palette.length];
        const assignColor = (node: typeof child, assignedColor: string) => {
          colorMap.set(node.id, assignedColor);
          node.children?.forEach(c => assignColor(c, assignedColor));
        };
        assignColor(child, color);
      });

      layoutResult.nodes.forEach(node => {
        const color = colorMap.get(node.id);
        if (color) {
          node.data = {
            ...node.data,
            branchColor: color,
          };
        }
      });

      layoutResult.edges.forEach(edge => {
        const color = colorMap.get(edge.target);
        if (color) {
          edge.style = {
            ...edge.style,
            stroke: color,
          };
        }
      });
    }

    // ★ 2026-02 修复：标记所有节点为 embed 模式，禁止节点组件写入全局 store 的 measuredNodeHeights
    layoutResult.nodes.forEach(node => {
      node.data = { ...node.data, isEmbed: true };
    });

    return layoutResult;
  }, [document, layoutEngine, layoutDirection, measuredNodeHeights, styleId]);

  // 初始化时及布局切换后自适应视图
  useEffect(() => {
    if (nodes.length === 0) return;
    if (!hasFitView.current) {
      hasFitView.current = true;
      // 延迟执行 fitView，确保 ReactFlow 已完成初始化
      const timer = setTimeout(() => {
        fitView({ padding: 0.15, duration: 0 });
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [nodes.length, fitView, isBothLayout]);

  return (
    <div className="w-full h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: defaultEdgeType }}
        fitView
        fitViewOptions={{ padding: REACTFLOW_CONFIG.fitViewPadding }}
        minZoom={0.1}
        maxZoom={1.5}
        // 只读模式配置
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // ★ 嵌入聊天流中：滚轮不缩放、不拦截，穿透给聊天容器滚动，
        // 避免"滚到导图上页面卡住开始缩放"。缩放走按钮/触控板捏合。
        // 触屏上单指滑动同样放行给聊天滚动（panOnDrag 关闭），
        // 画布平移用两指捏合附带的平移；桌面鼠标拖拽平移保留。
        panOnScroll={false}
        zoomOnScroll={false}
        preventScrolling={false}
        zoomOnDoubleClick={false}
        panOnDrag={!isCoarsePointer}
        // 隐藏交互元素
        proOptions={{ hideAttribution: true }}
        // 禁用节点点击
        onNodeClick={() => {}}
        onNodeDoubleClick={() => {}}
      />
      {/* 缩放控制按钮 + 布局切换（tooltip 统一 CommonTooltip，禁用原生 title） */}
      <div className="absolute bottom-2 left-2 flex gap-1">
        <CommonTooltip content={isBothLayout ? t('embed.layoutSingle') : t('embed.layoutBoth')} position="top">
          <DsButton variant="ghost"
            onClick={handleToggleLayout}
            className={EMBED_CONTROL_BUTTON_CLASS}
            aria-label={isBothLayout ? t('embed.layoutSingle') : t('embed.layoutBoth')}
          >
            <GitFork className={cn('w-3.5 h-3.5', isBothLayout && 'text-primary')} />
          </DsButton>
        </CommonTooltip>
        <CommonTooltip content={t('embed.zoomIn')} position="top">
          <DsButton variant="ghost"
            onClick={handleZoomIn}
            className={EMBED_CONTROL_BUTTON_CLASS}
            aria-label={t('embed.zoomIn')}
          >
            <MagnifyingGlassPlus size={14} />
          </DsButton>
        </CommonTooltip>
        <CommonTooltip content={t('embed.zoomOut')} position="top">
          <DsButton variant="ghost"
            onClick={handleZoomOut}
            className={EMBED_CONTROL_BUTTON_CLASS}
            aria-label={t('embed.zoomOut')}
          >
            <MagnifyingGlassMinus size={14} />
          </DsButton>
        </CommonTooltip>
        <CommonTooltip content={t('embed.fitView')} position="top">
          <DsButton variant="ghost"
            onClick={handleFitView}
            className={EMBED_CONTROL_BUTTON_CLASS}
            aria-label={t('embed.fitView')}
          >
            <Crosshair className="w-3.5 h-3.5" />
          </DsButton>
        </CommonTooltip>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const MindMapEmbed: React.FC<MindMapEmbedProps> = ({
  mindmapId,
  versionId,
  height = 280,
  className,
  onOpen,
  showOpenButton = true,
  displayTitle,
}) => {
  const { t } = useTranslation('mindmap');
  const [state, setState] = useState<LoadState>({
    loading: true,
    error: null,
    metadata: null,
    document: null,
    parentMindmapId: null,
  });

  const targetId = mindmapId || versionId;

  // B-10（轻量失效）：当前导图（非版本快照）在别处被更新时，静默重新拉取预览，
  // 避免聊天卡片与打开的编辑器短暂不一致。版本引用（mv_）不可变，无需订阅。
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    if (!targetId || targetId.startsWith('mv_')) return;
    const unwatch = dstu.watch('*', (event) => {
      if (event.type !== 'updated' || !event.node) return;
      if (event.node.id !== targetId) return;
      setReloadNonce((nonce) => nonce + 1);
    });
    return unwatch;
  }, [targetId]);

  // 计算节点数量
  const nodeCount = useMemo(() => {
    if (!state.document?.root) return 0;
    return countNodes(state.document.root);
  }, [state.document]);

  // 根据节点数量计算实际高度
  const actualHeight = useMemo(() => {
    if (!state.document?.root) return height;
    const nodeCount = countNodes(state.document.root);
    // 节点数超过阈值时使用 2 倍高度
    return nodeCount > LARGE_MAP_NODE_THRESHOLD ? height * 2 : height;
  }, [state.document, height]);

  // 加载思维导图数据
  useEffect(() => {
    let cancelled = false;

    const loadMindMap = async () => {
      try {
        // 静默刷新：已有文档时不回退到 loading 卡片，避免 watch 失效重载闪烁
        setState(prev => ({ ...prev, loading: !prev.document, error: null }));

        if (!targetId) {
          setState(prev => ({ ...prev, loading: false, error: t('embed.notFound') }));
          return;
        }

        const isVersionRef = targetId.startsWith('mv_');
        let metadata: VfsMindMap | null = null;
        let contentStr: string | null = null;
        let parentMmId: string | null = null;

        if (isVersionRef) {
          const [versionMeta, versionContent] = await Promise.all([
            getMindMapVersion(targetId),
            getMindMapVersionContent(targetId),
          ]);
          contentStr = versionContent;
          if (versionMeta) {
            parentMmId = versionMeta.mindmapId;
            metadata = {
              id: versionMeta.mindmapId,
              resourceId: versionMeta.resourceId,
              title: versionMeta.title,
              description: versionMeta.source
                  ? t('embed.versionSource', { source: versionMeta.source })
                : undefined,
              isFavorite: false,
              defaultView: 'mindmap',
              theme: null,
              settings: null,
              createdAt: versionMeta.createdAt,
              updatedAt: versionMeta.createdAt,
            } as VfsMindMap;
          }
        } else {
          [metadata, contentStr] = await Promise.all([
            getMindMap(targetId),
            getMindMapContent(targetId),
          ]);
        }

        if (cancelled) return;

        if (!metadata && !contentStr) {
          setState(prev => ({ ...prev, loading: false, error: t('embed.notFound') }));
          return;
        }

        let document: MindMapDocument | null = null;
        if (contentStr) {
          try {
            document = JSON.parse(contentStr);
          } catch {
            document = null;
          }
        }

        // M-068 修复：空内容时渲染默认根节点而非报错，使新建导图可正常预览
        if (!document?.root) {
          document = {
            root: {
              id: 'root',
              text: metadata?.title || displayTitle || t('embed.newMindMap'),
              children: [],
            },
          } as MindMapDocument;
        }

        setState({
          loading: false,
          error: null,
          metadata,
          document,
          // ★ 2026-02-13: 版本引用时保存父导图 ID，用于打开按钮导航
          parentMindmapId: parentMmId,
        });
      } catch (err: unknown) {
        if (cancelled) return;
        console.error('[MindMapEmbed] Load failed:', err);
        setState(prev => ({ ...prev, loading: false, error: t('embed.loadFailed') }));
      }
    };

    loadMindMap();

    return () => {
      cancelled = true;
    };
  }, [displayTitle, t, targetId, reloadNonce]);

  // 打开思维导图
  const handleOpen = useCallback(() => {
    if (onOpen) {
      onOpen();
      return;
    }

    // ★ 2026-02-13 修复：版本引用时跳转到父导图，而不是跳过
    // 优先使用父导图 ID（版本引用），否则使用当前 targetId（mm_xxx 引用）
    const openId = state.parentMindmapId || (targetId?.startsWith('mv_') ? null : targetId);
    if (!openId) return;
    const dstuPath = openId.startsWith('/') ? openId : `/${openId}`;
    
    const navEvent = new CustomEvent('NAVIGATE_TO_VIEW', {
      detail: { 
        view: 'learning-hub',
        openResource: dstuPath,
      },
    });
    window.dispatchEvent(navEvent);
  }, [onOpen, targetId, state.parentMindmapId]);

  // 渲染加载状态：模拟「根节点 + 两翼分支」的骨架屏（reduced-motion 下不闪烁）
  if (state.loading) {
    return (
      <div
        className={cn(
          'relative flex flex-col items-center justify-center rounded-lg overflow-hidden',
          'bg-muted/30 border border-border/50',
          className
        )}
        style={{ height }}
        role="status"
        aria-label={t('embed.loading')}
      >
        <div
          className="flex items-center gap-4 motion-safe:animate-pulse"
          aria-hidden
        >
          <div className="flex flex-col items-end gap-2.5">
            <div className="h-3 w-16 rounded-full bg-muted-foreground/15" />
            <div className="h-3 w-24 rounded-full bg-muted-foreground/15" />
            <div className="h-3 w-14 rounded-full bg-muted-foreground/15" />
          </div>
          <div className="h-7 w-28 rounded-lg bg-muted-foreground/25" />
          <div className="flex flex-col items-start gap-2.5">
            <div className="h-3 w-20 rounded-full bg-muted-foreground/15" />
            <div className="h-3 w-14 rounded-full bg-muted-foreground/15" />
            <div className="h-3 w-24 rounded-full bg-muted-foreground/15" />
          </div>
        </div>
        <div className="absolute top-2.5 left-3 right-10 flex items-center gap-2 text-muted-foreground">
          {displayTitle && (
            <span className="text-sm font-medium text-foreground/70 truncate">
              {displayTitle}
            </span>
          )}
          <span className="text-xs whitespace-nowrap">{t('embed.loading')}</span>
        </div>
      </div>
    );
  }

  // 渲染错误状态（带重试：重新触发一次数据拉取）
  if (state.error) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg',
          'bg-destructive/5 border border-destructive/20',
          className
        )}
        style={{ height }}
        role="alert"
      >
        <div className="flex items-center gap-2 text-destructive">
          <WarningCircle size={20} />
          <span>{state.error}</span>
        </div>
        <DsButton
          variant="ghost"
          className="ds-btn text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setReloadNonce((nonce) => nonce + 1)}
        >
          <ArrowClockwise size={13} />
          {t('shellV2.embed.retry')}
        </DsButton>
      </div>
    );
  }

  // 渲染思维导图
  return (
    <div
      className={cn(
        'mindmap-container relative rounded-lg overflow-hidden',
        'border border-border/50',
        'group',
        className
      )}
      style={{ height: actualHeight }}
    >
      {/* ReactFlow 容器 */}
      <ReactFlowProvider>
        <MindMapEmbedInner
          document={state.document!}
          metadata={state.metadata}
        />
      </ReactFlowProvider>

      {/* 标题栏 */}
      {(state.metadata || displayTitle) && (
        <div className="absolute top-0 left-0 right-0 px-3 py-1.5 bg-gradient-to-b from-background/80 to-transparent pointer-events-none">
          <span className="text-sm font-medium text-foreground/80 truncate">
            {state.metadata?.title || displayTitle}
          </span>
          {nodeCount > 0 && (
            <span className="ml-1.5 text-xs text-muted-foreground/60">
              {t('embed.nodeCount', { count: nodeCount })}
            </span>
          )}
        </div>
      )}

      {/* 打开按钮 */}
      {showOpenButton && (
        <div className="absolute top-2 right-2">
          <CommonTooltip content={t('embed.openInNewWindow')} position="left">
            <DsButton variant="ghost"
              onClick={handleOpen}
              className={EMBED_CONTROL_BUTTON_CLASS}
              aria-label={t('embed.openInNewWindow')}
            >
              <ArrowsOut size={16} />
            </DsButton>
          </CommonTooltip>
        </div>
      )}

      {/* 底部渐变遮罩 */}
      <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[var(--mm-bg)] to-transparent pointer-events-none" />
    </div>
  );
};

export default MindMapEmbed;
