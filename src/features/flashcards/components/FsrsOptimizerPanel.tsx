/**
 * FSRS 参数个性化：用本机复习日志跑优化器（fsrs_optimize_parameters），
 * 新参数更准才写入并按新参数重算记忆状态；可恢复 FSRS-6 默认参数。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Brain, CaretDown, CaretUp } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { getErrorMessage } from '@/utils/errorUtils';
import { requestFlashcardsDueRefresh } from '../events';
import { DEFAULT_FSRS6_WEIGHTS } from './FsrsParamsPanel';
import {
  parseOptimizeResult,
  parseSchedulerConfig,
  type OptimizeResult,
  type SchedulerConfig,
} from '../schedulerConfig';

export interface FsrsOptimizerPanelProps {
  fsrsParams: number[];
  optimizedAtMs?: number | null;
  optimizedReviewCount?: number | null;
  disabled?: boolean;
  onConfigChanged: (config: SchedulerConfig) => void;
}

function formatMetric(value: number, digits = 4): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export const FsrsOptimizerPanel: React.FC<FsrsOptimizerPanelProps> = ({
  fsrsParams,
  optimizedAtMs,
  optimizedReviewCount,
  disabled = false,
  onConfigChanged,
}) => {
  const { t, i18n } = useTranslation('flashcards');
  const [busy, setBusy] = useState<'optimize' | 'reset' | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weightsExpanded, setWeightsExpanded] = useState(false);
  const personalized = fsrsParams.length > 0;
  const activeWeights = fsrsParams.length === 21 ? fsrsParams : DEFAULT_FSRS6_WEIGHTS;
  const vectorPreview = useMemo(
    () => `[${activeWeights.slice(0, 4).map((w) => w.toFixed(4)).join(', ')}, …, ${activeWeights[activeWeights.length - 1]!.toFixed(4)}]`,
    [activeWeights],
  );

  const refreshConfig = useCallback(async () => {
    const parsed = parseSchedulerConfig(await invoke<unknown>('fsrs_get_scheduler_config'));
    if (parsed) onConfigChanged(parsed);
  }, [onConfigChanged]);

  const handleOptimize = useCallback(async () => {
    setBusy('optimize');
    setError(null);
    setResult(null);
    try {
      const parsed = parseOptimizeResult(await invoke<unknown>('fsrs_optimize_parameters'));
      if (!parsed) throw new Error(t('settings.optimizer.failed'));
      setResult(parsed);
      if (parsed.status === 'optimized') {
        await refreshConfig();
        requestFlashcardsDueRefresh();
      }
    } catch (optimizeError) {
      setError(getErrorMessage(optimizeError) || t('settings.optimizer.failed'));
    } finally {
      setBusy(null);
    }
  }, [refreshConfig, t]);

  const handleReset = useCallback(async () => {
    setBusy('reset');
    setError(null);
    setResult(null);
    try {
      const parsed = parseSchedulerConfig(
        await invoke<unknown>('fsrs_update_scheduler_config', { update: { fsrsParams: [] } }),
      );
      if (!parsed) throw new Error(t('settings.optimizer.failed'));
      onConfigChanged(parsed);
      requestFlashcardsDueRefresh();
    } catch (resetError) {
      setError(getErrorMessage(resetError) || t('settings.optimizer.failed'));
    } finally {
      setBusy(null);
    }
  }, [onConfigChanged, t]);

  const optimizedDate = optimizedAtMs
    ? new Date(optimizedAtMs).toLocaleDateString(i18n.language)
    : null;

  return (
    <div className="flex flex-col gap-2 border-t border-border/60 pt-3" data-testid="fsrs-optimizer">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Brain size={14} weight="duotone" aria-hidden="true" />
        {t('settings.optimizer.title')}
      </div>
      <p className="text-xs text-muted-foreground">
        {personalized
          ? optimizedDate
            ? t('settings.optimizer.personalizedSince', {
              date: optimizedDate,
              count: optimizedReviewCount ?? 0,
            })
            : t('settings.optimizer.personalized')
          : t('settings.optimizer.usingDefaults')}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <code className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
          w = {vectorPreview}
        </code>
        <button
          type="button"
          aria-expanded={weightsExpanded}
          onClick={() => setWeightsExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <span>
            {weightsExpanded
              ? t('settings.optimizer.collapseWeights', { defaultValue: '收起 21 维权重明细' })
              : t('settings.optimizer.expandWeights', { defaultValue: '展开 21 维权重明细' })}
          </span>
          {weightsExpanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
        </button>
      </div>
      {weightsExpanded ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 rounded-lg bg-foreground/[0.025] px-3 py-2 font-mono text-[11px] tabular-nums sm:grid-cols-7">
          {activeWeights.map((weight, index) => (
            <div key={index} className="flex items-baseline justify-between gap-1">
              <span className="text-muted-foreground">w[{index}]</span>
              <span className="text-foreground/90">{weight.toFixed(4)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <DsButton
          type="button"
          variant="default"
          size="sm"
          disabled={disabled || busy != null}
          onClick={() => void handleOptimize()}
          className="text-xs"
        >
          {busy === 'optimize' ? t('settings.optimizer.running') : t('settings.optimizer.optimize')}
        </DsButton>
        {personalized ? (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy != null}
            onClick={() => void handleReset()}
            className="text-xs"
          >
            {t('settings.optimizer.resetDefaults')}
          </DsButton>
        ) : null}
      </div>
      {result ? (
        <p role="status" className="text-xs text-muted-foreground" data-status={result.status}>
          {result.status === 'not_enough_data'
            ? t('settings.optimizer.notEnoughData', { items: result.itemCount })
            : result.status === 'already_optimal'
              ? t('settings.optimizer.alreadyOptimal', {
                logLoss: formatMetric(result.current?.logLoss ?? Number.NaN),
              })
              : t('settings.optimizer.optimized', {
                before: formatMetric(result.current?.logLoss ?? Number.NaN),
                after: formatMetric(result.optimized?.logLoss ?? Number.NaN),
                reviews: result.reviewCount,
                cards: result.recomputedCards,
              })}
        </p>
      ) : null}
      {error ? (
        <p role="status" className="text-xs text-destructive">{error}</p>
      ) : null}
      <p className="wb-fcx-footnote">{t('settings.optimizer.hint')}</p>
    </div>
  );
};

export default FsrsOptimizerPanel;
