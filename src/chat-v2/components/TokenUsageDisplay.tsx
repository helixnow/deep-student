/**
 * Chat V2 - Token Usage Display 组件
 *
 * 显示 token 使用统计信息，支持单变体和多变体模式。
 * 支持亮/暗色主题，使用 i18n 国际化。
 */

import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
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
 */
function getSourceBadgeClass(source: TokenUsage['source']): string {
  switch (source) {
    case 'api':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300';
    case 'tiktoken':
      return 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300';
    case 'heuristic':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300';
    case 'mixed':
      return 'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300';
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-600 dark:text-gray-300';
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
        <div className="flex items-center justify-between mb-2.5 pb-2 border-b border-gray-200 dark:border-gray-600">
          <div className="font-semibold text-sm text-gray-900 dark:text-white">{t('tokenUsage.title')}</div>
          <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-medium leading-none', sourceBadgeClass)}>
            {sourceLabel}
          </span>
        </div>

        {/* 核心数据 - 列表式布局 */}
        <div className="space-y-2 text-xs">
          {/* 输入 */}
          <div className="flex items-center justify-between">
            <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              {t('tokenUsage.prompt')}
            </span>
            <span className="font-mono tabular-nums text-gray-800 dark:text-gray-200">{usage.promptTokens.toLocaleString()}</span>
          </div>

          {/* 输出 */}
          <div className="flex items-center justify-between">
            <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              {t('tokenUsage.completion')}
            </span>
            <span className="font-mono tabular-nums text-gray-800 dark:text-gray-200">{usage.completionTokens.toLocaleString()}</span>
          </div>

          {/* 推理 (Optional) */}
          {usage.reasoningTokens !== undefined && (
             <div className="flex items-center justify-between">
              <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-violet-500"></span>
                {t('tokenUsage.reasoning')}
              </span>
              <span className="font-mono tabular-nums text-gray-800 dark:text-gray-200">{usage.reasoningTokens.toLocaleString()}</span>
            </div>
          )}

          {/* 缓存 (Optional) */}
          {usage.cachedTokens !== undefined && (
             <div className="flex items-center justify-between">
              <span className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                {t('tokenUsage.cached')}
              </span>
              <span className="font-mono tabular-nums text-gray-800 dark:text-gray-200">{usage.cachedTokens.toLocaleString()}</span>
            </div>
          )}

          {/* 分隔线 */}
          <div className="my-2 border-t border-gray-200 dark:border-gray-600" />

          {/* 总计 */}
          <div className="flex items-center justify-between">
             <span className="text-gray-900 dark:text-white font-medium flex items-center gap-2">
               <Zap size={13} className="text-amber-500" />
               {t('tokenUsage.total')}
             </span>
             <span className="font-mono tabular-nums font-bold text-gray-900 dark:text-white">{usage.totalTokens.toLocaleString()}</span>
          </div>
        </div>

        {/* 上下文窗口 (如果存在) */}
        {usage.lastRoundPromptTokens !== undefined && (
          <div className="mt-2.5 pt-2 border-t border-gray-200 dark:border-gray-600 flex items-center justify-between text-xs">
             <span className="text-gray-500 dark:text-gray-400">{t('tokenUsage.contextWindow')}</span>
             <span className="font-mono tabular-nums font-semibold text-orange-600 dark:text-orange-400 bg-orange-100 dark:bg-orange-500/20 px-2 py-0.5 rounded">
               {usage.lastRoundPromptTokens.toLocaleString()}
             </span>
          </div>
        )}
      </div>
    );

    // 紧凑模式 - 新格式: ⚡ 863 ↑568 ↓120
    if (compact) {
      return (
        <CommonTooltip content={tooltipContent} position="top">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-mono',
              'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
              'transition-colors cursor-default',
              className
            )}
          >
            <Zap size={12} className="text-amber-500 dark:text-amber-400" />
            <span className="font-medium text-gray-700 dark:text-gray-200">{formatTokenCount(usage.totalTokens)}</span>
            <span className="text-emerald-600 dark:text-emerald-400">↑{formatTokenCount(usage.promptTokens)}</span>
            <span className="text-blue-600 dark:text-blue-400">↓{formatTokenCount(usage.completionTokens)}</span>
          </span>
        </CommonTooltip>
      );
    }

    // 完整模式 - 新格式: ⚡ 863 ↑568 ↓120
    return (
      <CommonTooltip content={tooltipContent} position="top">
        <div
          className={cn(
            'inline-flex items-center gap-2 px-2.5 py-1 rounded-full',
            // 亮色模式：浅灰背景，深色文字
            'bg-gray-100/80 hover:bg-gray-200/80 border border-gray-200/50 hover:border-gray-300/60',
            // 暗色模式：半透明深色背景，浅色文字
            'dark:bg-white/5 dark:hover:bg-white/10 dark:border-white/10 dark:hover:border-white/20',
            'text-[11px] font-medium tabular-nums',
            'transition-all duration-200 cursor-default select-none',
            className
          )}
        >
          <Zap size={11} className="text-amber-500 dark:text-amber-400" />
          <span className="font-semibold text-gray-700 dark:text-gray-100">{formatTokenCount(usage.totalTokens)}</span>
          <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
            <span className="text-[9px] opacity-70">↑</span>{formatTokenCount(usage.promptTokens)}
          </span>
          <span className="flex items-center gap-0.5 text-blue-600 dark:text-blue-400">
            <span className="text-[9px] opacity-70">↓</span>{formatTokenCount(usage.completionTokens)}
          </span>
        </div>
      </CommonTooltip>
    );
  }
);

TokenUsageDisplay.displayName = 'TokenUsageDisplay';

// ============================================================================
// 输入估算组件
// ============================================================================

export interface InputTokenEstimateProps {
  /** 估算的 token 数量 */
  tokenCount: number;
  /** 自定义类名 */
  className?: string;
}

/**
 * InputTokenEstimate - 输入框 token 估算显示
 */
export const InputTokenEstimate: React.FC<InputTokenEstimateProps> = memo(
  ({ tokenCount, className }) => {
    const { t } = useTranslation('chatV2');

    // 没有内容时不显示
    if (tokenCount <= 0) {
      return null;
    }

    return (
      <CommonTooltip 
        content={t('tokenUsage.inputEstimate')} 
        position="top"
      >
        <span
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full',
            // 亮色模式
            'bg-gray-100/60 hover:bg-gray-100',
            // 暗色模式
            'dark:bg-white/5 dark:hover:bg-white/10',
            'text-[11px] font-medium tabular-nums',
            'text-gray-500 dark:text-gray-400',
            'transition-all duration-200 select-none cursor-default',
            className
          )}
        >
          <span className="text-gray-400 dark:text-gray-500 text-[10px]">~</span>
          <span className="text-gray-600 dark:text-gray-300">{formatTokenCount(tokenCount)}</span>
          <span className="text-gray-400 dark:text-gray-500 text-[10px] uppercase tracking-wider">{t('tokenUsage.tokens')}</span>
        </span>
      </CommonTooltip>
    );
  }
);

InputTokenEstimate.displayName = 'InputTokenEstimate';

export default TokenUsageDisplay;
