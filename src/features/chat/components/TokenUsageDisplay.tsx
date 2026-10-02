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
export function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return String(count);
}

/**
 * 来源徽章的语义色相（只给色相，具体透明度由 --tooltip-* 族合成）
 *
 * 语义映射：
 * - api      → success（最权威：来自 API 实际值）
 * - tiktoken → info（计算值）
 * - heuristic→ warning（估算值，需注意）
 * - mixed    → primary（混合来源，使用强调色）
 * - default  → 无色相（中性）
 *
 * 不能直接用 `bg-success/10 text-success` 这类成对类名：CommonTooltip 的
 * 外壳是反色的（亮色主题下 ≈ 近黑底），而 --success/--info/--warning 都是
 * 按亮色底调的，直接用会掉对比度。所以这里只取色相，再和
 * var(--tooltip-foreground)（反色前景）做 mix 交给 CSS 合成——
 * 两种主题下都由同一个公式保证可读。
 */
function getSourceHue(source: TokenUsage['source']): string | null {
  switch (source) {
    case 'api':
      return 'hsl(var(--success))';
    case 'tiktoken':
      return 'hsl(var(--info))';
    case 'heuristic':
      return 'hsl(var(--warning))';
    case 'mixed':
      return 'hsl(var(--primary))';
    default:
      return null;
  }
}

interface SourceBadgeStyle {
  color: string;
  background: string;
  borderColor: string;
}

function getSourceBadgeStyle(source: TokenUsage['source']): SourceBadgeStyle {
  const hue = getSourceHue(source);
  if (!hue) {
    return {
      color: 'var(--tooltip-text-secondary)',
      background: 'var(--tooltip-chip-surface)',
      borderColor: 'var(--tooltip-chip-border)',
    };
  }
  return {
    // 文字是实色：反色前景压住对比度下限，色相只承担"是哪一档估算"的语义。
    // 底色不能也拿反色前景去 mix——那样字和底会塌成同一个亮度（实测 1.09），
    // 必须是低透明度的色相薄涂，让底下那层反色表面透上来。
    color: `color-mix(in oklab, var(--tooltip-foreground) 88%, ${hue} 12%)`,
    background: `color-mix(in oklab, ${hue} 16%, transparent)`,
    borderColor: `color-mix(in oklab, var(--tooltip-foreground) 22%, transparent)`,
  };
}

/**
 * 数据卡里的一行「标签 — 数值」
 *
 * 语法与 ContextUsagePopover 的「已用 / 剩余 / 上限」同源：标签走次级色，
 * 数值走主色 + 等宽数字。分隔线用 --tooltip-divider（反色前景的 16%），
 * 不用 --border 类——那也是按亮色底调的，落到反色气泡上等于看不见。
 */
function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[color:var(--tooltip-text-secondary)]">{label}</span>
      <span className="font-mono tabular-nums text-[color:var(--tooltip-foreground)]">
        {value}
      </span>
    </div>
  );
}

// ============================================================================
// 组件
// ============================================================================

/**
 * TokenUsageDisplay - Token 使用统计显示组件
 */
export const TokenUsageDisplay: React.FC<TokenUsageDisplayProps> = memo(
  ({ usage, isVariant = false, compact = false, className }) => {
    const { t, i18n } = useTranslation('chatV2');
    const locale = i18n.resolvedLanguage ?? i18n.language;

    // 没有 token 数据时不渲染
    if (!usage || usage.totalTokens === 0) {
      return null;
    }

    const sourceLabel = t(`tokenUsage.source.${usage.source}`, usage.source);
    const sourceBadgeStyle = getSourceBadgeStyle(usage.source);

    // 详细信息卡。
    // 整张卡活在 CommonTooltip 的反色外壳里，所以只用 --tooltip-* 族；
    // 页面语义 token（--text-secondary / --border / --surface-*）是按亮色底
    // 调的，落上来会掉对比度。行语法与 ContextUsagePopover 同源。
    const tooltipContent = (
      <div className="w-52 p-1">
        {/* 头部：标题 + 来源徽章 */}
        <div className="mb-2.5 flex items-center justify-between gap-2 border-b border-[color:var(--tooltip-divider)] pb-2">
          <div className="text-sm font-semibold text-[color:var(--tooltip-foreground)]">
            {t('tokenUsage.title')}
          </div>
          <span
            className="rounded-full border px-2 py-0.5 text-2xs font-medium leading-none"
            style={sourceBadgeStyle}
          >
            {sourceLabel}
          </span>
        </div>

        {/* 核心数据 - 列表式布局 */}
        <div className="space-y-2 text-xs">
          <MetaRow
            label={t('tokenUsage.prompt')}
            value={usage.promptTokens.toLocaleString(locale)}
          />
          <MetaRow
            label={t('tokenUsage.completion')}
            value={usage.completionTokens.toLocaleString(locale)}
          />

          {/* 推理 (Optional) */}
          {usage.reasoningTokens !== undefined && (
            <MetaRow
              label={t('tokenUsage.reasoning')}
              value={usage.reasoningTokens.toLocaleString(locale)}
            />
          )}

          {/* 缓存 (Optional) — 命中率作为次级后缀，不另起一行 */}
          {usage.cachedTokens !== undefined && (
            <MetaRow
              label={t('tokenUsage.cached')}
              value={
                <>
                  {usage.cachedTokens.toLocaleString(locale)}
                  {usage.promptTokens > 0 && (
                    <span className="text-[color:var(--tooltip-text-muted)]">
                      {' '}({((usage.cachedTokens / usage.promptTokens) * 100).toFixed(1)}%)
                    </span>
                  )}
                </>
              }
            />
          )}

          {/* 分隔线 + 总计 */}
          <div className="my-2 border-t border-[color:var(--tooltip-divider)]" />
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-[color:var(--tooltip-foreground)]">
              {t('tokenUsage.total')}
            </span>
            <span className="font-mono font-bold tabular-nums text-[color:var(--tooltip-foreground)]">
              {usage.totalTokens.toLocaleString(locale)}
            </span>
          </div>
        </div>

        {/* 上下文窗口 (如果存在)。
            这里只是"这条消息那轮的输入量"，不是水位明细——所以用和上面
            一样的普通键值行，不再给强调色 chip：同一个数字在弹层里已经有
            一套带进度条/上限/压缩的完整表达，再加一个高饱和 chip 只会让人
            以为是另一套状态。明细看输入栏右侧的水位环。 */}
        {usage.lastRoundPromptTokens !== undefined && (
          <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[color:var(--tooltip-divider)] pt-2 text-xs">
            <span className="text-[color:var(--tooltip-text-secondary)]">
              {t('tokenUsage.contextWindow')}
            </span>
            <span className="font-mono tabular-nums text-[color:var(--tooltip-foreground)]">
              {usage.lastRoundPromptTokens.toLocaleString(locale)}
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
              'inline-flex cursor-default items-center gap-1.5 font-mono text-xs',
              'text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-primary)]',
              className
            )}
          >
            <span className="font-medium text-[color:var(--text-primary)] opacity-80">
              {formatTokenCount(usage.totalTokens)}
            </span>
            <span className="text-[color:var(--accent-primary)]">
              ↑{formatTokenCount(usage.promptTokens)}
            </span>
            <span className="text-[color:var(--brand-secondary)]">
              ↓{formatTokenCount(usage.completionTokens)}
            </span>
          </span>
        </CommonTooltip>
      );
    }

    // 完整模式 - 格式: 7.3K ↑7.0K ↓304
    return (
      <CommonTooltip content={tooltipContent} position="top">
        <div
          className={cn(
            'inline-flex cursor-default select-none items-center gap-2 rounded-full border px-2.5 py-1',
            'border-[color:var(--border-soft)] bg-[color:var(--surface-panel-muted)]',
            'text-2xs font-medium tabular-nums text-[color:var(--text-primary)]',
            'transition-colors duration-200',
            'hover:border-[color:var(--border-default)] hover:bg-[color:var(--interactive-hover)]',
            className
          )}
        >
          <span className="font-semibold text-[color:var(--text-primary)]">
            {formatTokenCount(usage.totalTokens)}
          </span>
          <span className="flex items-center gap-0.5 text-[color:var(--accent-primary)]">
            <span className="text-2xs opacity-70">↑</span>
            {formatTokenCount(usage.promptTokens)}
          </span>
          <span className="flex items-center gap-0.5 text-[color:var(--brand-secondary)]">
            <span className="text-2xs opacity-70">↓</span>
            {formatTokenCount(usage.completionTokens)}
          </span>
        </div>
      </CommonTooltip>
    );
  }
);

TokenUsageDisplay.displayName = 'TokenUsageDisplay';

export default TokenUsageDisplay;
