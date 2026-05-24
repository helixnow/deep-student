/**
 * Chat V2 - BlockRenderer 块渲染组件
 *
 * 职责：从 blockRegistry 获取组件，渲染块
 * 约束：禁止 switch/case，只能从注册表获取组件
 */

import React, { useMemo, Component, memo } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import type { StoreApi } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Warning, ArrowCounterClockwise } from '@phosphor-icons/react';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { blockRegistry } from '../registry';
import type { Block, ChatStore } from '../core/types';
import { useBlock, useIsBlockActive } from '../hooks/useChatStore';
import { sessionSwitchPerf } from '../debug/sessionSwitchPerf';

// ============================================================================
// 来源块类型列表（这些块只在 SourcePanelV2 中统一显示，不在消息流中渲染）
// ============================================================================

/**
 * 不在消息流中单独渲染的块类型
 * 这些块的数据会被 SourcePanelV2 提取并在来源面板中统一展示
 */
const SOURCE_BLOCK_TYPES = new Set(['rag', 'memory', 'web_search', 'multimodal_rag']);

// ============================================================================
// Block Error Boundary
// ============================================================================

interface BlockErrorBoundaryProps {
  children: ReactNode;
  block: Block;
  onReset?: () => void;
}

interface BlockErrorBoundaryState {
  hasError: boolean;
  error: string | null;
  prevBlockId?: string;
}

/**
 * 块渲染错误边界
 * 当块渲染出错时，显示错误信息而不是让整个消息列表崩溃
 */
class BlockErrorBoundary extends Component<BlockErrorBoundaryProps, BlockErrorBoundaryState> {
  constructor(props: BlockErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): Partial<BlockErrorBoundaryState> {
    return { hasError: true, error: getErrorMessage(error) };
  }

  // 当 block ID 变化时（新的块），自动重置错误状态
  static getDerivedStateFromProps(
    props: BlockErrorBoundaryProps,
    state: BlockErrorBoundaryState
  ): Partial<BlockErrorBoundaryState> | null {
    if (state.prevBlockId !== props.block.id) {
      return {
        hasError: false,
        error: null,
        prevBlockId: props.block.id,
      };
    }
    return null;
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.error(
      '[BlockRenderer] Block render error:',
      'blockId:', this.props.block.id,
      'type:', this.props.block.type,
      'error:', getErrorMessage(error),
      'componentStack:', errorInfo.componentStack
    );
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <BlockErrorFallbackUI
          error={this.state.error}
          block={this.props.block}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

// 错误回退 UI 组件（函数组件，可使用 hooks）
interface BlockErrorFallbackUIProps {
  error: string | null;
  block: Block;
  onReset: () => void;
}

const BlockErrorFallbackUI: React.FC<BlockErrorFallbackUIProps> = ({
  error,
  block,
  onReset,
}) => {
  const { t } = useTranslation('chatV2');

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex items-center gap-2 mb-2">
        <Warning size={14} className="text-destructive" />
        <span className="text-sm font-medium text-destructive">
          {t('error.blockRenderFailed', '块渲染失败')}
        </span>
        <span className="text-xs text-muted-foreground font-mono">
          [{block.type}]
        </span>
        <NotionButton variant="ghost" size="sm" onClick={onReset} className="ml-auto text-destructive hover:bg-destructive/10">
          <ArrowCounterClockwise size={12} />
          {t('error.retry', '重试')}
        </NotionButton>
      </div>
      <div className="text-xs text-muted-foreground bg-background/50 rounded p-2 font-mono break-all">
        {error || t('error.unknownError', '未知错误')}
      </div>
      {/* 显示块的原始内容（如果有） */}
      {block.content && (
        <details className="mt-2">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            {t('error.showContent', '显示原始内容')}
          </summary>
          <pre className="mt-1 text-xs text-muted-foreground bg-background/50 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-words">
            {block.content}
          </pre>
        </details>
      )}
    </div>
  );
};

// ============================================================================
// Props 定义
// ============================================================================

export interface BlockRendererProps {
  /** 块数据 */
  block: Block;
  /** 是否正在流式生成 */
  isStreaming?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 通用块组件（Fallback）
// ============================================================================

/**
 * GenericBlock - 未知块类型的 Fallback 渲染
 */
const GenericBlock: React.FC<{ block: Block; isStreaming?: boolean }> = ({
  block,
  isStreaming,
}) => {
  return (
    <div className="p-3 bg-muted/50 rounded-md border border-border">
      <div className="text-xs text-muted-foreground mb-1">
        Unknown block type: <code className="font-mono">{block.type}</code>
      </div>
      {block.content && (
        <pre className="text-sm whitespace-pre-wrap break-words">
          {block.content}
        </pre>
      )}
      {block.toolOutput && (
        <pre className="text-sm text-muted-foreground">
          {JSON.stringify(block.toolOutput, null, 2)}
        </pre>
      )}
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1" />
      )}
    </div>
  );
};

// ============================================================================
// 组件实现
// ============================================================================

/**
 * BlockRenderer 块渲染组件
 *
 * 核心逻辑：
 * 1. 跳过来源类型块（rag, memory, web_search, multimodal_rag），这些块由 SourcePanelV2 统一渲染
 * 2. 从 blockRegistry 获取对应类型的渲染组件
 * 3. 如果未注册，使用 GenericBlock 作为 Fallback
 * 4. 禁止使用 switch/case 进行类型判断
 */
export const BlockRenderer: React.FC<BlockRendererProps> = ({
  block,
  isStreaming = false,
  className,
}) => {
  // 📊 细粒度打点：BlockRenderer render
  sessionSwitchPerf.mark('br_render', { blockType: block.type });
  
  // 跳过来源类型块，这些块只在 SourcePanelV2 中统一展示
  if (SOURCE_BLOCK_TYPES.has(block.type)) {
    return null;
  }

  // 从注册表获取渲染插件（禁止 switch/case）
  const plugin = useMemo(() => blockRegistry.get(block.type), [block.type]);

  // 获取渲染组件，未注册则使用 GenericBlock
  const Component = plugin?.component ?? GenericBlock;

  return (
    <div className={cn('block-renderer', className)}>
      <BlockErrorBoundary block={block}>
        <Component block={block} isStreaming={isStreaming} />
      </BlockErrorBoundary>
    </div>
  );
};

export default BlockRenderer;

// ============================================================================
// 🚀 P1 性能优化：BlockRendererWithStore - 独立订阅单个 block
// ============================================================================

export interface BlockRendererWithStoreProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 块 ID */
  blockId: string;
  /** 自定义类名 */
  className?: string;
}

/**
 * BlockRendererWithStore - 按 blockId 独立订阅的块渲染组件
 *
 * 🚀 性能优化特点：
 * 1. 使用 useBlock 只订阅单个 block，而非整个 blocks Map
 * 2. 使用 useIsBlockActive 只订阅单个 block 的流式状态
 * 3. 使用 React.memo 避免父组件重渲染时的不必要重渲染
 * 4. 当其他 block 更新时，此组件不会重渲染
 *
 * 使用场景：在 MessageItem 中替代直接传递 block 对象的 BlockRenderer
 */
const BlockRendererWithStoreInner: React.FC<BlockRendererWithStoreProps> = ({
  store,
  blockId,
  className,
}) => {
  // 🚀 细粒度订阅：只订阅单个 block
  const block = useBlock(store, blockId);
  
  // 🚀 细粒度订阅：只订阅此 block 的流式状态
  const isStreaming = useIsBlockActive(store, blockId);

  // 块不存在时返回 null
  if (!block) {
    return null;
  }

  // 跳过来源类型块
  if (SOURCE_BLOCK_TYPES.has(block.type)) {
    return null;
  }

  // 从注册表获取渲染插件
  const plugin = blockRegistry.get(block.type);
  const Component = plugin?.component ?? GenericBlock;

  return (
    <div className={cn('block-renderer', className)}>
      <BlockErrorBoundary block={block}>
        {/* 🔧 P1-24: 传递 store 用于块级操作（如 MCP 工具重试） */}
        <Component block={block} isStreaming={isStreaming} store={store} />
      </BlockErrorBoundary>
    </div>
  );
};

/**
 * 🚀 性能优化：使用 React.memo 包装
 * 
 * 只有当 store 引用、blockId 或 className 变化时才重渲染
 * 由于内部使用 useBlock/useIsBlockActive 独立订阅，
 * 其他 block 的变化不会触发此组件重渲染
 */
export const BlockRendererWithStore = memo(
  BlockRendererWithStoreInner,
  (prevProps, nextProps) => {
    return (
      prevProps.store === nextProps.store &&
      prevProps.blockId === nextProps.blockId &&
      prevProps.className === nextProps.className
    );
  }
);
