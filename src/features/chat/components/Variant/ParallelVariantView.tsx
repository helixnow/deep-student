/**
 * Chat V2 - ParallelVariantView 并行变体双卡片视图
 *
 * 当消息有多个变体时，以并排卡片方式展示所有变体的完整内容
 * 类似于双栏对比视图，每个变体独立渲染，包含完整的消息内容和操作工具栏
 * 
 * 每个变体卡片内部渲染与单变体完全一致（使用 BlockRenderer 统一渲染所有块）
 */

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import i18n from 'i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import './ParallelVariantView.css';
import {
  Copy,
  Check,
  ArrowCounterClockwise,
  Trash,
  Square,
  DotsThree,
  CaretLeft,
  CaretRight,
  GitBranch,
} from '@phosphor-icons/react';
import { ProviderIcon } from '@/components/ui/ProviderIcon';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
} from '@/components/ui/app-menu/AppMenu';
import { BlockRendererWithStore } from '../BlockRenderer';
import { TokenUsageDisplay } from '../TokenUsageDisplay';
import { SourcePanelV2, hasSourcesInBlocks } from '../panels';
import { ActivityTimelineWithStore, isTimelineBlockType } from '../ActivityTimeline';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types/store';
import type { Variant } from '../../core/types/message';
import type { Block } from '../../core/types/block';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// Props 定义
// ============================================================================

export interface ParallelVariantViewProps {
  /** Store 实例（用于来源面板和块订阅） */
  store: StoreApi<ChatStore>;
  /** 消息 ID（用于来源面板） */
  messageId: string;
  /** 变体列表（包含 blockIds） */
  variants: Variant[];
  /** 🚀 P0修复：移除 getVariantBlocks，改用 variant.blockIds + BlockRendererWithStore */
  /** 获取模型显示名称 */
  getModelDisplayName?: (modelId: string) => string;
  /** 获取模型图标 URL（可选） */
  getModelIcon?: (modelId: string) => string | undefined;
  /** 当前活跃的变体 ID */
  activeVariantId?: string;
  /** 切换变体 */
  onSwitchVariant?: (variantId: string) => void;
  /** 取消变体 */
  onCancelVariant?: (variantId: string) => Promise<void>;
  /** 重试变体 */
  onRetryVariant?: (variantId: string) => Promise<void>;
  /** 删除变体 */
  onDeleteVariant?: (variantId: string) => Promise<void>;
  /** 🆕 重试所有变体 */
  onRetryAllVariants?: () => Promise<void>;
  /** 🆕 删除整个消息 */
  onDeleteMessage?: () => Promise<void>;
  /** 🆕 复制消息内容 */
  onCopy?: () => Promise<void>;
  /** 🆕 消息是否锁定（流式中不允许操作） */
  isLocked?: boolean;
  /** 🔧 继续执行回调（工具限制节点使用） */
  onContinue?: () => void;
  /** 🆕 会话分支回调 */
  onBranchSession?: () => Promise<void>;
  /** 是否隐藏底部消息级操作栏（由父级自行渲染） */
  hideMessageLevelActions?: boolean;
  /** 🚀 P0修复：移除 isBlockStreaming，块状态由 BlockRendererWithStore 内部订阅 */
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 默认的模型名称显示函数
 * 从 modelId 提取具体的模型名称，而不仅仅是供应商名称
 * 例如："Qwen/Qwen3-8B" -> "Qwen3-8B"
 */
function defaultGetModelDisplayName(modelId: string): string {
  if (!modelId) return i18n.t('chatV2:variant.unknownModel');
  
  // 从 modelId 提取具体模型名称
  // 例如："Qwen/Qwen3-8B" -> "Qwen3-8B"
  // 例如："openai/gpt-4o" -> "gpt-4o"
  const parts = modelId.split('/');
  const modelName = parts[parts.length - 1] || modelId;
  
  // 返回原始模型名称，保持其可读性
  return modelName;
}

/**
 * 格式化时间戳
 */
function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}


// ============================================================================
// 子组件：单个变体卡片
// ============================================================================

interface VariantCardProps {
  store: StoreApi<ChatStore>;
  messageId: string;
  variant: Variant;
  /** 🚀 P0修复：改为传递 blockIds，每个块独立订阅 Store */
  blockIds: string[];
  modelName: string;
  modelId: string;
  modelIcon?: string;
  isActive: boolean;
  isLastVariant: boolean;
  /** 是否为移动端布局 */
  isMobile?: boolean;
  /** 变体索引（用于移动端滚动定位） */
  variantIndex?: number;
  /** 🚀 性能：以下回调按 variantId 调用且引用稳定，配合 React.memo 避免并行流式时互相拖累重渲染 */
  onSwitch?: (variantId: string) => void;
  onCancel?: (variantId: string) => Promise<void>;
  onRetry?: (variantId: string) => Promise<void>;
  onDelete?: (variantId: string) => Promise<void>;
  /** 滚动到指定索引的卡片（引用稳定） */
  scrollToVariant?: (index: number) => void;
  isBlockStreaming?: (blockId: string) => boolean;
  /** 🔧 继续执行回调（工具限制节点使用） */
  onContinue?: () => void;
}

const VariantCardImpl: React.FC<VariantCardProps> = ({
  store,
  messageId,
  variant,
  blockIds,
  modelName,
  modelId,
  modelIcon,
  isActive,
  isLastVariant,
  isMobile = false,
  variantIndex,
  onSwitch,
  onCancel,
  onRetry,
  onDelete,
  scrollToVariant,
  onContinue,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const [isOperating, setIsOperating] = useState(false);
  const [iconLoadFailed, setIconLoadFailed] = useState(false);

  const isStreaming = variant.status === 'streaming';
  const canCancel = variant.status === 'streaming' || variant.status === 'pending';
  const canRetry = variant.status === 'error' || variant.status === 'cancelled';
  const canDelete = !isLastVariant && variant.status !== 'streaming';

  // 图标地址变化时重置加载失败状态
  useEffect(() => {
    setIconLoadFailed(false);
  }, [modelIcon]);

  // 🚀 P0修复：即时获取 blocks 用于操作回调（不订阅，避免不必要的重渲染）
  const getBlocks = useCallback((): Block[] => {
    const blocksMap = store.getState().blocks;
    return blockIds
      .map((id) => blocksMap.get(id))
      .filter((b): b is Block => b !== undefined);
  }, [store, blockIds]);

  // 检查是否有来源（与单变体一致）
  // 订阅 Store 计算布尔值：流式过程中 citations 到达时也能及时显示来源面板
  // （选择器只返回 boolean，Object.is 相等时不会触发重渲染）
  const hasSources = useStore(store, (s) => {
    const blocks = blockIds
      .map((id) => s.blocks.get(id))
      .filter((b): b is Block => b !== undefined);
    return hasSourcesInBlocks(blocks);
  });

  // 🚀 P0修复：复制内容时即时获取 blocks
  const handleCopy = useCallback(async () => {
    if (copied) return;
    const blocks = getBlocks();
    const contentBlocks = blocks.filter((b) => b.type === 'content');
    const text = contentBlocks.map((b) => b.content || '').join('\n');
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      showGlobalNotification('success', t('messageItem.actions.copySuccess'));
    } catch (error: unknown) {
      console.error('[VariantCard] Copy failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('messageItem.actions.copyFailed'));
    }
  }, [getBlocks, copied, t]);

  // 切换（仅非激活卡片可切换）
  const handleSwitch = useCallback(() => {
    if (!onSwitch || isActive) return;
    if (typeof variantIndex === 'number') {
      scrollToVariant?.(variantIndex);
    }
    onSwitch(variant.id);
  }, [onSwitch, isActive, scrollToVariant, variantIndex, variant.id]);
  const canSwitch = !!onSwitch && !isActive;

  // 取消
  const handleCancel = useCallback(async () => {
    if (!onCancel || isOperating) return;
    setIsOperating(true);
    try {
      await onCancel(variant.id);
    } catch (error: unknown) {
      console.error('[VariantCard] Cancel failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.cancelFailed'));
    } finally {
      setIsOperating(false);
    }
  }, [onCancel, isOperating, variant.id, t]);

  // 重试
  const handleRetry = useCallback(async () => {
    if (!onRetry || isOperating) return;
    setIsOperating(true);
    try {
      await onRetry(variant.id);
    } catch (error: unknown) {
      console.error('[VariantCard] Retry failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.retryFailed'));
    } finally {
      setIsOperating(false);
    }
  }, [onRetry, isOperating, variant.id, t]);

  // 删除
  const handleDelete = useCallback(async () => {
    if (!onDelete || isOperating) return;
    setIsOperating(true);
    try {
      await onDelete(variant.id);
    } catch (error: unknown) {
      console.error('[VariantCard] Delete failed:', error);
      showGlobalNotification('error', getErrorMessage(error), t('variant.deleteFailed'));
    } finally {
      setIsOperating(false);
    }
  }, [onDelete, isOperating, variant.id, t]);

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border transition-all',
        'bg-card dark:bg-card/80',
        isActive
          ? 'border-primary/50 shadow-sm'
          : 'border-border hover:border-border/80',
        isStreaming && 'border-primary/30',
        // 移动端：固定宽度 + snap 对齐；桌面端：flex-1 自适应填满容器
        isMobile
          ? 'w-[85vw] min-w-[280px] max-w-[320px] shrink-0 snap-start'
          : 'flex-1 min-w-[200px]'
      )}
      data-variant-index={variantIndex}
      onClick={canSwitch ? handleSwitch : undefined}
      onKeyDown={
        canSwitch
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleSwitch();
              }
            }
          : undefined
      }
      role={canSwitch ? 'button' : undefined}
      tabIndex={canSwitch ? 0 : undefined}
    >
      {/* 头部：模型信息 + 时间戳 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          {/* 模型图标 - 使用 ProviderIcon 自动识别供应商并显示对应图标；自定义图标加载失败时降级 */}
          {modelIcon && !iconLoadFailed ? (
            <img
              src={modelIcon}
              alt={modelName}
              className="w-7 h-7 rounded-full object-cover"
              onError={() => setIconLoadFailed(true)}
            />
          ) : (
            <ProviderIcon
              modelId={modelId}
              size={28}
              showTooltip={true}
            />
          )}
          {/* 模型名称 */}
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground line-clamp-2 break-all">
              {modelName}
            </span>
            {variant.createdAt && (
              <span className="text-xs text-muted-foreground">
                {formatTimestamp(variant.createdAt)}
              </span>
            )}
          </div>
        </div>

      </div>

      {/* 🚀 P0修复：使用与单变体一致的分组渲染逻辑（ActivityTimeline + BlockRenderer） */}
      <div className="flex-1 px-4 py-3 min-h-[100px] overflow-y-auto">
        {blockIds.length > 0 ? (
          <div className="space-y-2">
            {(() => {
              // 🔧 与 MessageItem 保持一致的分组渲染逻辑
              const blocks = getBlocks();

              // 收集分组信息：记录 blockId 和是否为时间线类型
              type RenderSegment = {
                type: 'timeline' | 'content';
                blockIds: string[];
                key: string;
              };

              const segments: RenderSegment[] = [];
              let currentTimelineBlockIds: string[] = [];

              for (const block of blocks) {
                // 🔧 paper_save 工具不进时间线分组，使用专用 PaperSaveBlock 渲染
                const isPaperSaveBlock = block.type === 'mcp_tool' && (
                  block.toolName === 'paper_save' ||
                  block.toolName === 'builtin-paper_save' ||
                  block.toolName?.replace(/^builtin[-:]/, '').replace(/^mcp_/, '') === 'paper_save'
                );
                if (isTimelineBlockType(block.type) && !isPaperSaveBlock) {
                  // 时间线类型块，累积
                  currentTimelineBlockIds.push(block.id);
                } else {
                  // 非时间线类型块
                  // 1. 先把累积的时间线块作为一个段落
                  if (currentTimelineBlockIds.length > 0) {
                    segments.push({
                      type: 'timeline',
                      blockIds: currentTimelineBlockIds,
                      key: `timeline-${currentTimelineBlockIds[0]}`,
                    });
                    currentTimelineBlockIds = [];
                  }
                  // 2. 当前块作为单独段落
                  segments.push({
                    type: 'content',
                    blockIds: [block.id],
                    key: `content-${block.id}`,
                  });
                }
              }
              // 处理末尾可能残留的时间线块
              if (currentTimelineBlockIds.length > 0) {
                segments.push({
                  type: 'timeline',
                  blockIds: currentTimelineBlockIds,
                  key: `timeline-${currentTimelineBlockIds[0]}`,
                });
              }

              // 渲染所有段落
              return segments.map((segment) => {
                if (segment.type === 'timeline') {
                  // 🔧 P0修复：使用 ActivityTimelineWithStore 响应式订阅块状态变化
                  return (
                    <ActivityTimelineWithStore
                      key={segment.key}
                      store={store}
                      blockIds={segment.blockIds}
                      onContinue={onContinue}
                    />
                  );
                } else {
                  // 普通块使用 BlockRendererWithStore 独立订阅
                  return segment.blockIds.map((blockId) => (
                    <BlockRendererWithStore
                      key={blockId}
                      store={store}
                      blockId={blockId}
                    />
                  ));
                }
              });
            })()}
          </div>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="inline-block w-2 h-4 bg-primary animate-pulse" />
            <span>{t('variant.streaming')}</span>
          </div>
        ) : variant.status === 'error' ? (
          <p className="text-sm text-destructive">
            {variant.error || t('variant.error')}
          </p>
        ) : variant.status === 'pending' ? (
          <p className="text-sm text-muted-foreground">
            {t('variant.pending')}
          </p>
        ) : null}
      </div>

      {/* 🚀 P0修复：来源面板不传 blocks，让它自己订阅 */}
      {hasSources && (
        <div className="px-4 pb-3">
          <SourcePanelV2
            store={store}
            messageId={messageId}
            className="text-left"
          />
        </div>
      )}

      {/* 底部工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/50 bg-muted/20">
        {/* 操作按钮 */}
        <div className="flex items-center gap-0.5">
          {/* 复制 */}
          <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleCopy(); }} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
            {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
          </NotionButton>

          {/* 重试（可重试状态） */}
          {canRetry && onRetry && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleRetry(); }} disabled={isOperating} aria-label={t('variant.retry')} title={t('variant.retry')}>
              <ArrowCounterClockwise size={16} className={cn(isOperating && 'animate-spin')} />
            </NotionButton>
          )}

          {/* 取消（流式中） */}
          {canCancel && onCancel && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleCancel(); }} disabled={isOperating} aria-label={t('variant.cancel')} title={t('variant.cancel')}>
              <Square size={16} />
            </NotionButton>
          )}

          {/* 删除（非最后一个） */}
          {canDelete && onDelete && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => { e.stopPropagation(); handleDelete(); }} disabled={isOperating} className={cn(isOperating ? '' : 'hover:text-destructive')} aria-label={t('variant.delete')} title={t('variant.delete')}>
              <Trash size={16} />
            </NotionButton>
          )}

          {/* 更多操作菜单 */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={(e) => e.stopPropagation()} aria-label={t('variant.actions')} title={t('variant.actions')}>
                <DotsThree size={16} />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={160}>
              <AppMenuItem onClick={handleCopy} icon={<Copy size={16} />}>
                {t('messageItem.actions.copy')}
              </AppMenuItem>
              {canRetry && onRetry && (
                <AppMenuItem
                  onClick={handleRetry}
                  disabled={isOperating}
                  icon={<ArrowCounterClockwise size={16} />}
                >
                  {t('variant.retry')}
                </AppMenuItem>
              )}
              {canDelete && onDelete && (
                <AppMenuItem
                  onClick={handleDelete}
                  disabled={isOperating}
                  destructive
                  icon={<Trash size={16} />}
                >
                  {t('variant.delete')}
                </AppMenuItem>
              )}
            </AppMenuContent>
          </AppMenu>
        </div>

        {/* Token 统计 */}
        {variant.usage && (
          <TokenUsageDisplay usage={variant.usage} isVariant compact />
        )}
      </div>
    </div>
  );
};

/**
 * 🚀 性能：memo 边界——并行流式时，某个变体的更新只重渲染它自己的卡片。
 * Store 对变体做不可变更新（未变更的 variant 对象保持引用），
 * 配合上方引用稳定的按 id 回调，其余卡片全部命中 memo。
 */
const VariantCard = React.memo(VariantCardImpl);

// ============================================================================
// 子组件：消息级操作栏
// ============================================================================

interface MessageLevelActionsProps {
  variants: Variant[];
  isLocked: boolean;
  onRetryAll?: () => Promise<void>;
  onDeleteMessage?: () => Promise<void>;
  onCopy?: () => Promise<void>;
  onBranchSession?: () => Promise<void>;
}

const MessageLevelActions: React.FC<MessageLevelActionsProps> = ({
  variants,
  isLocked,
  onRetryAll,
  onDeleteMessage,
  onCopy,
  onBranchSession,
}) => {
  const { t } = useTranslation('chatV2');
  const [isRetryingAll, setIsRetryingAll] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [copied, setCopied] = useState(false);

  // 检查是否有正在流式的变体
  const hasStreamingVariant = variants.some(
    (v) => v.status === 'streaming' || v.status === 'pending'
  );

  // 检查是否可以重试（有失败或已取消的变体，或全部完成）
  const canRetryAll = !isLocked && !hasStreamingVariant;

  // 检查是否可以删除（非锁定且非流式中）
  const canDelete = !isLocked && !hasStreamingVariant;

  const handleRetryAll = useCallback(async () => {
    if (!onRetryAll || isRetryingAll || !canRetryAll) return;
    setIsRetryingAll(true);
    try {
      await onRetryAll();
    } catch (error: unknown) {
      console.error('[MessageLevelActions] Retry all failed:', error);
    } finally {
      setIsRetryingAll(false);
    }
  }, [onRetryAll, isRetryingAll, canRetryAll]);

  const handleDelete = useCallback(async () => {
    if (!onDeleteMessage || isDeleting || !canDelete) return;
    setIsDeleting(true);
    try {
      await onDeleteMessage();
    } catch (error: unknown) {
      console.error('[MessageLevelActions] Delete message failed:', error);
    } finally {
      setIsDeleting(false);
    }
  }, [onDeleteMessage, isDeleting, canDelete]);

  const handleCopy = useCallback(async () => {
    if (!onCopy || copied) return;
    try {
      await onCopy();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      console.error('[MessageLevelActions] Copy failed:', error);
    }
  }, [onCopy, copied]);

  const [isBranching, setIsBranching] = useState(false);
  const handleBranch = useCallback(async () => {
    if (!onBranchSession || isBranching || isLocked) return;
    setIsBranching(true);
    try {
      await onBranchSession();
    } catch (error: unknown) {
      console.error('[MessageLevelActions] Branch failed:', error);
    } finally {
      setIsBranching(false);
    }
  }, [onBranchSession, isBranching, isLocked]);

  // 如果没有任何操作可用，不显示操作栏
  if (!onRetryAll && !onDeleteMessage && !onCopy && !onBranchSession) {
    return null;
  }

  return (
    <div className="mt-3 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity max-w-thread mx-auto">
      <div className="flex items-center gap-1">
        {/* 复制按钮 */}
        {onCopy && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} aria-label={t('messageItem.actions.copy')} title={t('messageItem.actions.copy')}>
            {copied ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
          </NotionButton>
        )}

        {/* 会话分支按钮 */}
        {onBranchSession && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleBranch} disabled={isLocked || isBranching} aria-label={t('messageItem.actions.branch')} title={t('messageItem.actions.branch')}>
            <GitBranch size={16} className={cn(isBranching && 'animate-pulse')} />
          </NotionButton>
        )}

        {/* 全部重试按钮 */}
        {onRetryAll && (
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRetryAll} disabled={!canRetryAll || isRetryingAll} aria-label={t('variant.retryAll')} title={t('variant.retryAll')}>
            <ArrowCounterClockwise size={16} className={cn(isRetryingAll && 'animate-spin')} />
          </NotionButton>
        )}

        {/* 删除消息按钮（带确认） */}
        {onDeleteMessage && (
          <AppMenu>
            <AppMenuTrigger asChild>
              <NotionButton variant="ghost" size="icon" iconOnly disabled={!canDelete || isDeleting} className={cn(!canDelete || isDeleting ? '' : 'hover:text-destructive')} aria-label={t('messageItem.actions.delete')} title={t('messageItem.actions.delete')}>
                <Trash size={16} className={cn(isDeleting && 'animate-pulse')} />
              </NotionButton>
            </AppMenuTrigger>
            <AppMenuContent align="start" width={180}>
              <AppMenuItem
                onClick={handleDelete}
                disabled={!canDelete || isDeleting}
                destructive
                icon={<Trash size={16} />}
              >
                {t('variant.deleteMessage')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ParallelVariantView 并行变体双卡片视图
 *
 * 以并排卡片方式展示多个变体的完整内容
 *
 * 移动端优化：
 * - 使用横向滚动代替垂直堆叠
 * - 支持 snap 滚动，提升滑动体验
 */
export const ParallelVariantView: React.FC<ParallelVariantViewProps> = ({
  store,
  messageId,
  variants,
  getModelDisplayName = defaultGetModelDisplayName,
  getModelIcon,
  activeVariantId,
  onSwitchVariant,
  onCancelVariant,
  onRetryVariant,
  onDeleteVariant,
  onRetryAllVariants,
  onDeleteMessage,
  onCopy,
  isLocked = false,
  onContinue,
  onBranchSession,
  hideMessageLevelActions = false,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  // 检测移动端（< 768px）
  const { isSmallScreen } = useBreakpoint();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 滚动到指定变体卡片
  const scrollToVariant = useCallback((index: number, smooth: boolean = true) => {
    if (!scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    const card = container.querySelector(
      `[data-variant-index="${index}"]`
    ) as HTMLElement | null;

    if (card) {
      // 使用 getBoundingClientRect 获取准确位置
      const containerRect = container.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();

      // 计算卡片相对于容器可视区域的偏移
      const cardOffsetFromContainer = cardRect.left - containerRect.left;

      // 目标位置：使卡片居中
      const scrollTarget = container.scrollLeft + cardOffsetFromContainer - (containerRect.width - cardRect.width) / 2;

      container.scrollTo({
        left: Math.max(0, scrollTarget),
        behavior: smooth ? 'smooth' : 'instant',
      });
    }
  }, []);

  // 🔧 修复：初始加载时滚动到 activeVariantId 对应的变体位置
  // 使用 ref 追踪是否已完成首次滚动，避免每次 variants 更新都触发滚动
  const initialScrollDoneRef = useRef(false);

  useEffect(() => {
    // 只在首次加载时执行滚动
    if (initialScrollDoneRef.current) return;
    if (!activeVariantId || variants.length < 2) return;

    // 找到 activeVariantId 对应的索引
    const activeIndex = variants.findIndex(v => v.id === activeVariantId);

    // 如果不是第一个变体，需要滚动到对应位置
    if (activeIndex > 0) {
      // 使用 requestAnimationFrame 确保 DOM 已渲染
      requestAnimationFrame(() => {
        // 初始加载时使用 instant 避免用户看到滚动动画
        scrollToVariant(activeIndex, false);
        initialScrollDoneRef.current = true;
      });
    } else {
      // 第一个变体无需滚动，标记为已完成
      initialScrollDoneRef.current = true;
    }
  }, [isSmallScreen, activeVariantId, variants, scrollToVariant]);

  // 至少需要 2 个变体才显示并行视图
  if (variants.length < 2) {
    return null;
  }

  const isLastVariant = variants.length <= 1;

  return (
    <div className={cn('w-full', className)}>
      {/* 变体导航栏：左箭头 + 指示器圆点 + 右箭头 */}
      {variants.length > 1 && (() => {
        const activeIndex = variants.findIndex(v => v.id === activeVariantId);
        const hasPrev = activeIndex > 0;
        const hasNext = activeIndex < variants.length - 1;
        return (
          <div className="flex items-center justify-center gap-2 mb-3">
            {/* 左箭头 */}
            {/* eslint-disable-next-line ds-components/no-native-button -- 24px 紧凑视觉 + 伪元素扩大触控区的导航箭头，共享按钮组件 的 icon 尺寸体系不适配 */}
            <button
              type="button"
              onClick={() => {
                if (hasPrev) {
                  scrollToVariant(activeIndex - 1);
                  onSwitchVariant?.(variants[activeIndex - 1].id);
                }
              }}
              disabled={!hasPrev}
              className={cn(
                // 视觉 24px，透明伪元素扩大触控命中区至 ~44px
                'p-1 rounded-md transition-colors relative after:absolute after:-inset-2.5 after:content-[\'\']',
                hasPrev
                  ? 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] cursor-pointer'
                  : 'text-muted-foreground/20 cursor-default'
              )}
              aria-label={t('variant.switchToVariant', { index: Math.max(1, activeIndex)})}
              title={t('variant.switchToVariant', { index: Math.max(1, activeIndex)})}
            >
              <CaretLeft size={16} />
            </button>

            {/* 指示器圆点 */}
            <div className="flex items-center gap-2">
              {variants.map((variant, index) => {
                const isActive = variant.id === activeVariantId;
                return (
                  <NotionButton
                    key={variant.id}
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={() => {
                      scrollToVariant(index);
                      if (onSwitchVariant && !isActive) {
                        onSwitchVariant(variant.id);
                      }
                    }}
                    className={cn(
                      '!rounded-full flex-shrink-0 !p-0',
                      isActive
                        ? 'variant-indicator-dot-active bg-primary'
                        : 'variant-indicator-dot bg-muted-foreground/30 hover:bg-muted-foreground/50'
                    )}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={t('variant.switchToVariant', { index: index + 1})}
                  />
                );
              })}
            </div>

            {/* 右箭头 */}
            {/* eslint-disable-next-line ds-components/no-native-button -- 24px 紧凑视觉 + 伪元素扩大触控区的导航箭头，共享按钮组件 的 icon 尺寸体系不适配 */}
            <button
              type="button"
              onClick={() => {
                if (hasNext) {
                  scrollToVariant(activeIndex + 1);
                  onSwitchVariant?.(variants[activeIndex + 1].id);
                }
              }}
              disabled={!hasNext}
              className={cn(
                // 视觉 24px，透明伪元素扩大触控命中区至 ~44px
                'p-1 rounded-md transition-colors relative after:absolute after:-inset-2.5 after:content-[\'\']',
                hasNext
                  ? 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] cursor-pointer'
                  : 'text-muted-foreground/20 cursor-default'
              )}
              aria-label={t('variant.switchToVariant', { index: Math.min(variants.length, activeIndex + 2)})}
              title={t('variant.switchToVariant', { index: Math.min(variants.length, activeIndex + 2)})}
            >
              <CaretRight size={16} />
            </button>
          </div>
        );
      })()}

      {/* 变体卡片容器 */}
      <div
        ref={scrollContainerRef}
        className={cn(
          'flex gap-4 pb-2',
          // 移动端：横向滚动 + snap 对齐
          // 桌面端：卡片均分宽度；变体较多时（min-w 之和超出容器）允许横向滚动而非溢出裁切
          isSmallScreen
            ? 'overflow-x-auto scrollbar-hide snap-x snap-mandatory -mx-4 px-4'
            : 'w-full overflow-x-auto'
        )}
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        } as React.CSSProperties}
      >
        {/* 🚀 P0修复：传递 blockIds 而非 blocks；按 id 回调直接透传，保持引用稳定以命中 VariantCard 的 memo */}
        {variants.map((variant, index) => {
          const isActive = variant.id === activeVariantId;

          return (
            <VariantCard
              key={variant.id}
              store={store}
              messageId={messageId}
              variant={variant}
              blockIds={variant.blockIds}
              modelName={getModelDisplayName(variant.modelId)}
              modelId={variant.modelId}
              modelIcon={getModelIcon?.(variant.modelId)}
              isActive={isActive}
              isLastVariant={isLastVariant}
              isMobile={isSmallScreen}
              variantIndex={index}
              onSwitch={onSwitchVariant}
              onCancel={onCancelVariant}
              onRetry={onRetryVariant}
              onDelete={onDeleteVariant}
              scrollToVariant={scrollToVariant}
              onContinue={onContinue}
            />
          );
        })}
      </div>

      {/* 🆕 消息级操作栏：全部重试 + 删除消息 */}
      {!hideMessageLevelActions && (
        <MessageLevelActions
          variants={variants}
          isLocked={isLocked}
          onRetryAll={onRetryAllVariants}
          onDeleteMessage={onDeleteMessage}
          onCopy={onCopy}
          onBranchSession={onBranchSession}
        />
      )}
    </div>
  );
};

export default ParallelVariantView;
