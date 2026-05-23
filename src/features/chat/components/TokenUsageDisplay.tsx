/**
 * Chat V2 - Token Usage Display 组件
 *
 * 显示 token 使用统计信息，支持单变体和多变体模式。
 * 支持亮/暗色主题，使用 i18n 国际化。
 */

import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import type { TokenUsage } from '../core/types';

// ============================================================================
// Props
// ============================================================================

export interface TokenUsageDisplayProps {
  /** Token 使用统计 */
  usage: TokenUsage;
  /** 变体模式（显示额外提示） */
  isVariant?: boolean;
  /** 紧凑模式 */
  compact?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 格式化 token 数量（超过 1000 显示 K）
 */
function formatTokenCount(count: number): string {
  if (count >= 10000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}

/**
 * 获取来源标识的样式
 *
 * 语义映射：
 * - api      → success（最权威：来自 API 实际值）
 * - tiktoken → info（计算值）
 * - heuristic→ warning（估算值，需注意）
 * - mixed    → primary（混合来源，使用强调色）
 * - default  → muted
 */
function getSourceBadgeClass(source: TokenUsage['source']): string {
  switch (source) {
    case 'api':
      return 'bg-success/10 text-success';
    case 'tiktoken':
      return 'bg-info/10 text-info';
    case 'heuristic':
      return 'bg-warning/10 text-warning';
    case 'mixed':
      return 'bg-primary/10 text-primary';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

// ============================================================================
// 组件
// ============================================================================

/**
 * TokenUsageDisplay - Token 使用统计显示组件
 */
export const TokenUsageDisplay: React.FC<TokenUsageDisplayProps> = memo(
  ({ usage, isVariant = false, compact = false, className }) => {
    const { t } = useTranslation('chatV2');

    // 没有 token 数据时不渲染
    if (!usage || usage.totalTokens === 0) {
      return null;
    }

    const sourceLabel = t(`tokenUsage.source.${usage.source}`, usage.source);
    const sourceBadgeClass = getSourceBadgeClass(usage.source);

    // 构建详细信息内容
    const tooltipContent = (
      <div className="w-52 p-1">
        {/* 头部：标题 + 来源 */}
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-border">
          <div className="font-semibold text-sm text-foreground">{t('tokenUsage.title')}</div>
          <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium leading-none', sourceBadgeClass)}>
            {sourceLabel}
          </span>
        </div>

        {/* 核心数据 - 列表式布局 */}
        <div className="space-y-2 text-xs">
          {/* 输入 */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary"></span>
              {t('tokenUsage.prompt')}
            </span>
            <span className="font-mono tabular-nums text-foreground">{usage.promptTokens.toLocaleString()}</span>
          </div>

          {/* 输出 */}
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-info"></span>
              {t('tokenUsage.completion')}
            </span>
            <span className="font-mono tabular-nums text-foreground">{usage.completionTokens.toLocaleString()}</span>
          </div>

          {/* 推理 (Optional) */}
          {usage.reasoningTokens !== undefined && (
             <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary/40"></span>
                {t('tokenUsage.reasoning')}
              </span>
              <span className="font-mono tabular-nums text-foreground">{usage.reasoningTokens.toLocaleString()}</span>
            </div>
          )}

          {/* 缓存 (Optional) */}
          {usage.cachedTokens !== undefined && (
             <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-warning"></span>
                {t('tokenUsage.cached')}
              </span>
              <span className="font-mono tabular-nums text-foreground">
                {usage.cachedTokens.toLocaleString()}
                {usage.promptTokens > 0 && (
                  <span className="text-muted-foreground">
                    {' '}({((usage.cachedTokens / usage.promptTokens) * 100).toFixed(1)}%)
                  </span>
                )}
              </span>
            </div>
          )}

          {/* 分隔线 */}
          <div className="my-2 border-t border-border" />

          {/* 总计 */}
          <div className="flex items-center justify-between">
             <span className="text-foreground font-medium">
               {t('tokenUsage.total')}
             </span>
             <span className="font-mono tabular-nums font-bold text-foreground">{usage.totalTokens.toLocaleString()}</span>
          </div>
        </div>

        {/* 上下文窗口 (如果存在) — 使用强调色语义 */}
        {usage.lastRoundPromptTokens !== undefined && (
          <div className="mt-2.5 pt-2 border-t border-border flex items-center justify-between text-xs">
             <span className="text-muted-foreground">{t('tokenUsage.contextWindow')}</span>
             <span className="font-mono tabular-nums font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">
               {usage.lastRoundPromptTokens.toLocaleString()}
             </span>
          </div>
        )}
      </div>
    );

    // 紧凑模式 - 格式: 7.3K ↑7.0K ↓304
    if (compact) {
      return (
        <CommonTooltip content={tooltipContent} position="top">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-mono',
              'text-muted-foreground hover:text-foreground',
              'transition-colors cursor-default',
              className
            )}
          >
            <span className="font-medium text-foreground/80">{formatTokenCount(usage.totalTokens)}</span>
            <span className="text-primary">↑{formatTokenCount(usage.promptTokens)}</span>
            <span className="text-info">↓{formatTokenCount(usage.completionTokens)}</span>
          </span>
        </CommonTooltip>
      );
    }

    // 完整模式 - 格式: 7.3K ↑7.0K ↓304
    return (
      <CommonTooltip content={tooltipContent} position="top">
        <div
          className={cn(
            'inline-flex items-center gap-2 px-2.5 py-1 rounded-full',
            'bg-muted/60 hover:bg-[var(--interactive-hover)] border border-border/50 hover:border-border',
            'text-[11px] font-medium tabular-nums text-foreground',
            'transition-all duration-200 cursor-default select-none',
            className
          )}
        >
          <span className="font-semibold text-foreground">{formatTokenCount(usage.totalTokens)}</span>
          <span className="flex items-center gap-0.5 text-primary">
            <span className="text-[9px] opacity-70">↑</span>{formatTokenCount(usage.promptTokens)}
          </span>
          <span className="flex items-center gap-0.5 text-info">
            <span className="text-[9px] opacity-70">↓</span>{formatTokenCount(usage.completionTokens)}
          </span>
        </div>
      </CommonTooltip>
    );
  }
);

TokenUsageDisplay.displayName = 'TokenUsageDisplay';

export default TokenUsageDisplay;
