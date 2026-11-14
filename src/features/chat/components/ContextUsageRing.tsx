import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  computePromptCacheHitRate,
  planExtractiveTurnCompaction,
  type PromptCacheObservation,
} from '../utils/promptCacheAndTurnCompaction';

export { computePromptCacheHitRate, planExtractiveTurnCompaction, type PromptCacheObservation };

// ============================================================================
// 类型与估算工具
// ============================================================================

export type ContextUsageLevel = 'normal' | 'warn' | 'danger';

export interface EstimateContextUsageInput {
  systemPrompt?: string;
  skillMetaBlock?: string;
  historyContents?: readonly string[];
  draftText?: string;
  maxWindowTokens: number;
}

export interface ContextUsageEstimate {
  systemTokens: number;
  skillTokens: number;
  historyTokens: number;
  draftTokens: number;
  usedTokens: number;
  maxWindowTokens: number;
  remainingTokens: number;
  ratio: number;
  filledRatio: number;
  percent: number;
  level: ContextUsageLevel;
  formattedUsed: string;
  formattedWindow: string;
  formattedSummary: string;
}

export interface ContextUsageRingProps {
  usedTokens?: number;
  maxWindowTokens: number;
  systemPrompt?: string;
  skillMetaBlock?: string;
  historyContents?: readonly string[];
  draftText?: string;
  cacheObservations?: readonly PromptCacheObservation[];
  showInlineSummary?: boolean;
  onCompress?: () => void;
  isCompressing?: boolean;
  isCompressDisabled?: boolean;
  testId?: string;
  className?: string;
}

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * 粗略估算单段文本的 Token 数量（中英混合场景按字符数 × 0.7 向上取整）。
 */
export function estimateTextTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length * 0.7);
}

/**
 * 紧凑格式化 Token 数值：
 * - 32500 -> "32.5k"
 * - 128000 -> "128k"
 * - 875 -> "875"
 */
export function formatCompactTokens(tokens: number): string {
  const safe = Math.max(0, Math.round(tokens));
  if (safe < 1000) {
    return String(safe);
  }
  const kValue = (safe / 1000).toFixed(1).replace(/\.0$/, '');
  return `${kValue}k`;
}

/**
 * 根据使用比例判定三档状态：
 * - normal: <= 70%
 * - warn: > 70% 且 <= 90%
 * - danger: > 90%
 */
export function resolveContextUsageLevel(ratio: number): ContextUsageLevel {
  if (ratio > 0.9) return 'danger';
  if (ratio > 0.7) return 'warn';
  return 'normal';
}

/**
 * 格式化紧凑汇总文字列：`≈32.5k / 128k (25%)`
 */
export function formatContextUsageSummary(
  usedTokens: number,
  maxWindowTokens: number,
  percent?: number,
): string {
  const safeWindow = Math.max(0, maxWindowTokens);
  const safeUsed = Math.max(0, usedTokens);
  const pct =
    percent ?? (safeWindow > 0 ? Math.round((safeUsed / safeWindow) * 100) : 0);
  return `≈${formatCompactTokens(safeUsed)} / ${formatCompactTokens(safeWindow)} (${pct}%)`;
}

/**
 * 估算当前轮完整上下文 Token 用量（系统提示词 + 技能元数据 + 历史正文 + 当前草稿）。
 */
export function estimateContextUsageTokens(
  input: EstimateContextUsageInput,
): ContextUsageEstimate {
  const systemTokens = estimateTextTokens(input.systemPrompt);
  const skillTokens = estimateTextTokens(input.skillMetaBlock);
  const historyTokens = (input.historyContents ?? []).reduce(
    (sum, content) => sum + estimateTextTokens(content),
    0,
  );
  const draftTokens = estimateTextTokens(input.draftText);
  const usedTokens = systemTokens + skillTokens + historyTokens + draftTokens;

  return buildUsageEstimateFromCounts({
    systemTokens,
    skillTokens,
    historyTokens,
    draftTokens,
    usedTokens,
    maxWindowTokens: input.maxWindowTokens,
  });
}

function buildUsageEstimateFromCounts(counts: {
  systemTokens: number;
  skillTokens: number;
  historyTokens: number;
  draftTokens: number;
  usedTokens: number;
  maxWindowTokens: number;
}): ContextUsageEstimate {
  const maxWindowTokens = Math.max(0, Math.round(counts.maxWindowTokens));
  const usedTokens = Math.max(0, Math.round(counts.usedTokens));
  const remainingTokens = Math.max(0, maxWindowTokens - usedTokens);
  const ratio = maxWindowTokens > 0 ? usedTokens / maxWindowTokens : 0;
  const filledRatio = Math.min(1, Math.max(0, ratio));
  const percent = Math.round(ratio * 100);
  const level = resolveContextUsageLevel(ratio);
  const formattedUsed = formatCompactTokens(usedTokens);
  const formattedWindow = formatCompactTokens(maxWindowTokens);
  const formattedSummary = formatContextUsageSummary(
    usedTokens,
    maxWindowTokens,
    percent,
  );

  return {
    systemTokens: counts.systemTokens,
    skillTokens: counts.skillTokens,
    historyTokens: counts.historyTokens,
    draftTokens: counts.draftTokens,
    usedTokens,
    maxWindowTokens,
    remainingTokens,
    ratio,
    filledRatio,
    percent,
    level,
    formattedUsed,
    formattedWindow,
    formattedSummary,
  };
}

// ============================================================================
// 组件实现
// ============================================================================

export const ContextUsageRing: React.FC<ContextUsageRingProps> = ({
  usedTokens,
  maxWindowTokens,
  systemPrompt,
  skillMetaBlock,
  historyContents,
  draftText,
  cacheObservations,
  showInlineSummary = false,
  onCompress,
  isCompressing = false,
  isCompressDisabled = false,
  testId = 'context-usage-ring',
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

  const cacheHitRate = useMemo(
    () => (cacheObservations?.length ? computePromptCacheHitRate(cacheObservations) : null),
    [cacheObservations],
  );

  const estimate = useMemo<ContextUsageEstimate>(() => {
    const computed = estimateContextUsageTokens({
      systemPrompt,
      skillMetaBlock,
      historyContents,
      draftText,
      maxWindowTokens,
    });
    if (usedTokens === undefined) {
      return computed;
    }
    return buildUsageEstimateFromCounts({
      systemTokens: computed.systemTokens,
      skillTokens: computed.skillTokens,
      historyTokens: computed.historyTokens,
      draftTokens: computed.draftTokens,
      usedTokens,
      maxWindowTokens,
    });
  }, [
    usedTokens,
    maxWindowTokens,
    systemPrompt,
    skillMetaBlock,
    historyContents,
    draftText,
  ]);

  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - estimate.filledRatio);

  const levelToneClass =
    estimate.level === 'danger'
      ? 'text-destructive'
      : estimate.level === 'warn'
        ? 'text-amber-500 dark:text-amber-400'
        : 'text-muted-foreground';

  const baseTooltip = t(
    'chatV2:contextUsage.tooltip',
    '上下文用量 {{summary}}',
    { summary: estimate.formattedSummary },
  );

  const dangerAdvice = t(
    'chatV2:contextUsage.dangerHint',
    '上下文用量 {{summary}} · 建议开启新话题',
    { summary: estimate.formattedSummary },
  );

  const tooltipText =
    estimate.level === 'danger' ? dangerAdvice : baseTooltip;

  const handleToggleDetails = () => {
    setIsDetailsOpen((prev) => !prev);
  };

  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <button
        type="button"
        onClick={handleToggleDetails}
        data-testid={testId}
        data-level={estimate.level}
        aria-label={tooltipText}
        aria-expanded={isDetailsOpen}
        aria-busy={isCompressing}
        title={tooltipText}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md p-1.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          levelToneClass,
        )}
      >
        <svg
          className="h-[18px] w-[18px] shrink-0"
          viewBox="0 0 20 20"
          aria-hidden="true"
          focusable="false"
        >
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth={2.5}
          />
          <circle
            cx="10"
            cy="10"
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={strokeDashoffset.toFixed(2)}
            transform="rotate(-90 10 10)"
            className="transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none"
          />
        </svg>
        {showInlineSummary && (
          <span
            data-testid={`${testId}-summary`}
            className="font-mono text-xs tabular-nums"
          >
            {estimate.formattedSummary}
          </span>
        )}
      </button>

      {isDetailsOpen && (
        <div
          role="dialog"
          data-testid={`${testId}-popover`}
          aria-label={t('chatV2:contextUsage.title', '上下文用量详情')}
          className="absolute bottom-full right-0 z-30 mb-2 w-64 rounded-lg border border-border/35 bg-popover p-3 text-xs text-popover-foreground shadow-md"
        >
          <div className="mb-2 flex items-center justify-between border-b border-border/35 pb-1.5">
            <span className="font-medium">
              {t('chatV2:contextUsage.title', '上下文用量详情')}
            </span>
            <span
              data-testid={`${testId}-dialog-summary`}
              className={cn('font-mono tabular-nums', levelToneClass)}
            >
              {estimate.formattedSummary}
            </span>
          </div>

          <dl className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t('chatV2:contextUsage.usedLabel', '已用估算')}
              </dt>
              <dd className="font-mono tabular-nums">
                {t('chatV2:contextUsage.tokenCount', '≈{{count}} tokens', {
                  count: estimate.usedTokens,
                })}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t('chatV2:contextUsage.windowLabel', '上下文窗口')}
              </dt>
              <dd className="font-mono tabular-nums">
                {t('chatV2:contextUsage.windowCount', '{{count}} tokens', {
                  count: estimate.maxWindowTokens,
                })}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t('chatV2:contextUsage.remainingLabel', '剩余可用')}
              </dt>
              <dd className="font-mono tabular-nums">
                {t('chatV2:contextUsage.tokenCount', '≈{{count}} tokens', {
                  count: estimate.remainingTokens,
                })}
              </dd>
            </div>
            {cacheHitRate !== null && (
              <div
                data-testid={`${testId}-cache-hit-rate`}
                className="flex items-center justify-between gap-2"
              >
                <dt className="text-muted-foreground">
                  {t('chatV2:contextUsage.cacheHitRateLabel', '缓存命中率')}
                </dt>
                <dd className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                  {Math.round(cacheHitRate * 100)}%
                </dd>
              </div>
            )}
          </dl>

          {estimate.level === 'danger' && (
            <p className="mt-2 text-destructive">
              {t(
                'chatV2:contextUsage.dangerSuggestion',
                '当前会话接近上下文上限，建议开启新话题或压缩历史。',
              )}
            </p>
          )}

          {onCompress && (
            <button
              type="button"
              onClick={onCompress}
              disabled={isCompressDisabled || isCompressing}
              data-testid={`${testId}-compress`}
              className="mt-2.5 w-full rounded-md bg-secondary px-2.5 py-1.5 font-medium text-secondary-foreground transition-colors hover:bg-secondary/80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isCompressing
                ? t('chatV2:contextUsage.compressing', '正在压缩上下文...')
                : t('chatV2:contextUsage.compressAction', '压缩上下文')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ContextUsageRing;
