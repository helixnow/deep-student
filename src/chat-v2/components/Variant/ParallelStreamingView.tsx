/**
 * Chat V2 - ParallelStreamingView 并行流式预览组件
 *
 * 当有 2+ 个变体正在流式生成时显示
 * 以并排方式展示所有变体的实时进度
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { Square, Loader2 } from 'lucide-react';
import { VariantStatusIcon } from './VariantStatusIcon';
import type { Variant } from '../../core/types/message';
import type { Block } from '../../core/types/block';

// ============================================================================
// Props 定义
// ============================================================================

export interface ParallelStreamingViewProps {
  /** 变体列表 */
  variants: Variant[];
  /** 获取变体的块内容 */
  getVariantBlocks: (variantId: string) => Block[];
  /** 停止单个变体 */
  onStopVariant?: (variantId: string) => void;
  /** 停止所有变体 */
  onStopAll?: () => void;
  /** 获取模型显示名称 */
  getModelDisplayName?: (modelId: string) => string;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 默认的模型名称显示函数
 */
function defaultGetModelDisplayName(modelId: string): string {
  return modelId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * 获取变体的预览内容
 */
function getVariantPreview(blocks: Block[], maxLength = 200): string {
  // 只取 content 类型的块内容
  const contentBlocks = blocks.filter((b) => b.type === 'content');
  const content = contentBlocks.map((b) => b.content || '').join('\n');
  
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + '...';
}

/**
 * 获取变体进度（基于块状态）
 */
function getVariantProgress(variant: Variant, blocks: Block[]): number {
  if (variant.status === 'success') return 100;
  if (variant.status === 'error' || variant.status === 'cancelled') return 0;
  if (variant.status === 'pending') return 0;
  
  // streaming 状态 - 基于有内容的块数量估算进度
  const totalBlocks = blocks.length || 1;
  const completedBlocks = blocks.filter(
    (b) => b.status === 'success' || (b.content && b.content.length > 0)
  ).length;
  
  // 至少显示 10%，最多 90%（未完成）
  const progress = Math.max(10, Math.min(90, (completedBlocks / totalBlocks) * 100));
  return Math.round(progress);
}

// ============================================================================
// 子组件：单个变体卡片
// ============================================================================

interface VariantCardProps {
  variant: Variant;
  blocks: Block[];
  modelName: string;
  onStop?: () => void;
}

const VariantCard: React.FC<VariantCardProps> = ({
  variant,
  blocks,
  modelName,
  onStop,
}) => {
  const { t } = useTranslation('chatV2');
  const preview = useMemo(() => getVariantPreview(blocks), [blocks]);
  const progress = useMemo(
    () => getVariantProgress(variant, blocks),
    [variant, blocks]
  );
  const isStreaming = variant.status === 'streaming';

  return (
    <div
      className={cn(
        'flex-1 min-w-[200px] max-w-[400px] rounded-lg border',
        'bg-card dark:bg-card/50',
        isStreaming
          ? 'border-primary/50'
          : variant.status === 'success'
          ? 'border-green-500/50'
          : variant.status === 'error'
          ? 'border-destructive/50'
          : 'border-border'
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2">
          <VariantStatusIcon status={variant.status} size="sm" />
          <span className="text-sm font-medium truncate max-w-[120px]">
            {modelName}
          </span>
        </div>
        {isStreaming && onStop && (
          <button
            onClick={onStop}
            className={cn(
              'p-1 rounded text-xs',
              'text-muted-foreground hover:text-foreground',
              'hover:bg-muted transition-colors'
            )}
            title={t('variant.cancel')}
          >
            <Square className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* 进度条 */}
      {isStreaming && (
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* 预览内容 */}
      <div className="px-3 py-2 min-h-[80px] max-h-[120px] overflow-hidden">
        {preview ? (
          <p className="text-sm text-foreground/80 whitespace-pre-wrap break-words line-clamp-4">
            {preview}
          </p>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>{t('variant.streaming')}</span>
          </div>
        ) : variant.status === 'error' ? (
          <p className="text-sm text-destructive">
            {variant.error || t('variant.error')}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('variant.pending')}
          </p>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ParallelStreamingView 并行流式预览
 *
 * 当有 2+ 个变体在流式生成时显示
 */
export const ParallelStreamingView: React.FC<ParallelStreamingViewProps> = ({
  variants,
  getVariantBlocks,
  onStopVariant,
  onStopAll,
  getModelDisplayName = defaultGetModelDisplayName,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  // 统计正在流式的变体数量
  const streamingCount = useMemo(
    () => variants.filter((v) => v.status === 'streaming').length,
    [variants]
  );

  // 只有 2+ 个变体正在流式生成时才显示
  if (streamingCount < 2) {
    return null;
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-muted/30 dark:bg-muted/10 p-3',
        className
      )}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm font-medium">
            {t('variant.parallelStreaming')}
          </span>
          <span className="text-xs text-muted-foreground">
            ({streamingCount}/{variants.length})
          </span>
        </div>
        {onStopAll && streamingCount > 0 && (
          <button
            onClick={onStopAll}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-xs',
              'text-destructive hover:bg-destructive/10 transition-colors'
            )}
          >
            <Square className="w-3 h-3" />
            <span>{t('variant.stopAll')}</span>
          </button>
        )}
      </div>

      {/* 变体卡片网格 */}
      <div className="flex flex-wrap gap-3">
        {variants.map((variant) => (
          <VariantCard
            key={variant.id}
            variant={variant}
            blocks={getVariantBlocks(variant.id)}
            modelName={getModelDisplayName(variant.modelId)}
            onStop={
              variant.status === 'streaming' && onStopVariant
                ? () => onStopVariant(variant.id)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
};

export default ParallelStreamingView;
