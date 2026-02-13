import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, X } from 'lucide-react';

import { cn } from '@/utils/cn';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import type { AnkiCardsBlockData } from '../ankiCardsBlock';

type StepId = 'routing' | 'importing' | 'generating' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'active' | 'done';

function clampRatioToPercent(ratio: unknown): number | null {
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) return null;
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * 100);
}

function normalizeStageToStep(stage: string | undefined): StepId {
  switch ((stage || '').toLowerCase()) {
    case 'routing':
    case 'queued':
      return 'routing';
    case 'importing':
      return 'importing';
    case 'generating':
    case 'paused':
      return 'generating';
    case 'completed':
    case 'success':
      return 'completed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'error':
    case 'failed':
      return 'failed';
    default:
      return 'routing';
  }
}

function getStepStatus(stepIndex: number, activeIndex: number, isCompleted: boolean): StepStatus {
  if (isCompleted) return 'done';
  if (stepIndex < activeIndex) return 'done';
  if (stepIndex === activeIndex) return 'active';
  return 'pending';
}

function getAnkiConnectState(ankiConnect: AnkiCardsBlockData['ankiConnect']) {
  if (!ankiConnect) {
    return { state: 'unknown' as const, label: 'checking', variant: 'secondary' as const, className: '' };
  }
  if (ankiConnect.available === true) {
    return { state: 'connected' as const, label: 'connected', variant: 'default' as const, className: '' };
  }
  if (ankiConnect.available === false) {
    return {
      state: 'not_connected' as const,
      label: 'notConnected',
      variant: 'secondary' as const,
      className: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    };
  }
  return { state: 'unknown' as const, label: 'checking', variant: 'secondary' as const, className: '' };
}

export const ChatAnkiProgressCompact: React.FC<{
  progress?: AnkiCardsBlockData['progress'];
  ankiConnect?: AnkiCardsBlockData['ankiConnect'];
  warnings?: AnkiCardsBlockData['warnings'];
  cardsCount: number;
  blockStatus: string;
  finalStatus?: string;
}> = ({ progress, ankiConnect, warnings, cardsCount, blockStatus, finalStatus }) => {
  const { t } = useTranslation('chatV2');

  const percent = useMemo(() => clampRatioToPercent(progress?.completedRatio), [progress?.completedRatio]);
  const stage = progress?.stage;
  const normalizedFinalStatus =
    typeof finalStatus === 'string' ? finalStatus.toLowerCase() : undefined;
  const normalizedStage =
    typeof stage === 'string' ? stage.toLowerCase() : undefined;
  const statusHint =
    normalizedFinalStatus ??
    normalizedStage ??
    (blockStatus === 'error' ? 'failed' : blockStatus === 'success' ? 'completed' : undefined);

  const isCancelled = statusHint === 'cancelled' || statusHint === 'canceled';
  const isError =
    blockStatus === 'error' || statusHint === 'error' || statusHint === 'failed';
  const isCompleted =
    !isCancelled &&
    !isError &&
    (blockStatus === 'success' ||
      statusHint === 'completed' ||
      statusHint === 'success');

  const step = normalizeStageToStep(statusHint);
  const terminalStepId: StepId = isError ? 'failed' : isCancelled ? 'cancelled' : 'completed';

  const steps = useMemo(() => {
    const base = [
      { id: 'routing' as const, label: t('blocks.ankiCards.progress.steps.routing') },
      { id: 'importing' as const, label: t('blocks.ankiCards.progress.steps.importing') },
      { id: 'generating' as const, label: t('blocks.ankiCards.progress.steps.generating') },
    ];
    const terminalLabel = isError
      ? t('blocks.ankiCards.progress.segments.failed')
      : isCancelled
        ? t('blocks.ankiCards.progress.segments.cancelled')
        : t('blocks.ankiCards.progress.steps.completed');
    return [...base, { id: terminalStepId, label: terminalLabel }] as const;
  }, [t, isError, isCancelled, terminalStepId]);

  const activeIndex = useMemo(() => steps.findIndex(s => s.id === step), [steps, step]);

  const ankiConnectMeta = useMemo(() => getAnkiConnectState(ankiConnect), [ankiConnect]);
  const cardsGenerated = typeof progress?.cardsGenerated === 'number' ? progress.cardsGenerated : cardsCount;
  const segTotal = typeof progress?.counts === 'object' && progress?.counts ? (progress.counts as any).total : undefined;
  const segCompleted = typeof progress?.counts === 'object' && progress?.counts ? (progress.counts as any).completed : undefined;
  const segCounts = useMemo(() => {
    if (!progress?.counts || typeof progress.counts !== 'object') return null;
    const c = progress.counts as any;
    const read = (key: string): number | undefined => (typeof c[key] === 'number' ? c[key] : undefined);
    const total = read('total');
    if (typeof total !== 'number') return null;

    const processing = (read('processing') ?? 0) + (read('streaming') ?? 0);

    return {
      total,
      pending: read('pending'),
      processing,
      paused: read('paused'),
      completed: read('completed'),
      failed: read('failed'),
      truncated: read('truncated'),
      cancelled: read('cancelled'),
    };
  }, [progress?.counts]);

  const metricsText = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${t('blocks.ankiCards.progress.metrics.cards')}: ${cardsGenerated}`);
    if (typeof segTotal === 'number' && typeof segCompleted === 'number') {
      parts.push(
        `${t('blocks.ankiCards.progress.metrics.segments')}: ${segCompleted}/${segTotal}`
      );
    }
    return parts.join('  ·  ');
  }, [t, cardsGenerated, segTotal, segCompleted]);

  const messageKey = typeof progress?.messageKey === 'string' ? progress.messageKey.trim() : '';
  const messageParams =
    progress?.messageParams && typeof progress.messageParams === 'object'
      ? (progress.messageParams as Record<string, unknown>)
      : undefined;
  const localizedMessage = messageKey
    ? t(messageKey, { ...(messageParams || {}), defaultValue: '' })
    : '';
  const rawMessage = typeof progress?.message === 'string' ? progress.message.trim() : '';
  const message = localizedMessage || rawMessage;
  const route = typeof progress?.route === 'string' ? progress.route : '';
  const routeLabel = useMemo(() => {
    if (!route) return '';
    const normalized = route.trim().toLowerCase();
    if (!normalized) return '';
    return t(`blocks.ankiCards.progress.routeValues.${normalized}` as any, {
      defaultValue: route,
    });
  }, [route, t]);
  const warningMessages = useMemo(() => {
    if (!warnings || warnings.length === 0) return [];
    const resolved = warnings
      .map(warning => {
        if (warning?.messageKey) {
          const translated = t(warning.messageKey, {
            ...(warning.messageParams || {}),
            defaultValue: '',
          });
          if (translated) return translated;
        }
        if (warning?.message && warning.message.trim()) return warning.message.trim();
        if (warning?.code && warning.code.trim()) return warning.code.trim();
        return '';
      })
      .filter(Boolean) as string[];
    return Array.from(new Set(resolved));
  }, [warnings, t]);

  let progressValue: number | null = percent;
  if (progressValue == null) {
    if (isCompleted) {
      progressValue = 100;
    } else if (isCancelled || isError) {
      progressValue = 0;
    } else if (blockStatus === 'running') {
      progressValue = null;
    } else {
      progressValue = 0;
    }
  }

  return (
    <section
      data-testid="chatanki-progress"
      className={cn(
        'mt-2 rounded-xl border border-border/50 bg-muted/10 px-3 py-2 overflow-hidden',
        isError && 'border-destructive/40 bg-destructive/5',
        isCancelled && 'border-amber-500/40 bg-amber-100/30'
      )}
      aria-live="polite"
      aria-busy={blockStatus === 'running'}
    >
      {/* 步骤条 + AnkiConnect 状态 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {/* 步骤指示器 - 移动端使用紧凑布局 */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0 overflow-x-auto scrollbar-none">
          {steps.map((s, idx) => {
            const status = getStepStatus(idx, Math.max(activeIndex, 0), isCompleted);
            const isActive = status === 'active';
            const isDone = status === 'done';
            const isTerminalActive = isActive && (isError || isCancelled || isCompleted);
            const dotClass = cn(
              'flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full border text-[9px] sm:text-[10px] flex-shrink-0',
              isDone && 'border-emerald-500 bg-emerald-500 text-white',
              isActive && !isError && !isCancelled && 'border-primary bg-primary/10 text-primary',
              isActive && isError && 'border-destructive bg-destructive/10 text-destructive',
              isActive && isCancelled && 'border-amber-500 bg-amber-500/10 text-amber-600',
              status === 'pending' && 'border-border bg-background/40 text-muted-foreground'
            );
            const labelClass = cn(
              'text-[10px] sm:text-[11px] leading-none whitespace-nowrap',
              isDone && 'text-emerald-600 dark:text-emerald-400',
              isActive && !isError && !isCancelled && 'text-primary',
              isActive && isError && 'text-destructive',
              isActive && isCancelled && 'text-amber-600',
              status === 'pending' && 'text-muted-foreground'
            );

            return (
              <React.Fragment key={s.id}>
                <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
                  <div className={dotClass} data-testid={`chatanki-progress-step-${s.id}`}>
                    {isDone ? (
                      <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                    ) : isActive ? (
                      isTerminalActive ? (
                        <X className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                      ) : (
                        <Loader2 className={cn('h-2.5 w-2.5 sm:h-3 sm:w-3', blockStatus === 'running' && 'animate-spin')} />
                      )
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
                  <span className={labelClass}>{s.label}</span>
                </div>
                {idx < steps.length - 1 && (
                  <div
                    className={cn(
                      'mx-0.5 sm:mx-2 h-px w-3 sm:w-6 flex-shrink-0',
                      isDone ? 'bg-emerald-500/60' : isActive ? 'bg-primary/40' : 'bg-border'
                    )}
                    aria-hidden="true"
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* AnkiConnect 状态 + 百分比 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge
            variant={ankiConnectMeta.variant}
            className={cn('rounded-full px-2 py-0.5 text-[10px] whitespace-nowrap max-w-[180px] sm:max-w-[220px] truncate', ankiConnectMeta.className)}
            data-testid="chatanki-progress-anki-connect"
            title={ankiConnect?.error ?? undefined}
          >
            {t('blocks.ankiCards.progress.ankiConnect.label', { defaultValue: 'AnkiConnect' })}:{' '}
            {t(`blocks.ankiCards.progress.ankiConnect.${ankiConnectMeta.label}` as any, {
              defaultValue:
                ankiConnectMeta.label === 'connected'
                  ? 'connected'
                  : ankiConnectMeta.label === 'notConnected'
                    ? 'not connected'
                    : 'checking',
            })}
          </Badge>
          {typeof percent === 'number' && (
            <span
              className={cn('text-xs tabular-nums flex-shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')}
              data-testid="chatanki-progress-percent"
            >
              {percent}%
            </span>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div className="mt-2">
        <Progress
          value={progressValue}
          className={cn(
            'h-1.5',
            isError && '[&>div]:bg-destructive',
            isCancelled && '[&>div]:bg-amber-500'
          )}
        />
      </div>

      {/* 指标信息 */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:gap-2 text-[10px] sm:text-[11px] text-muted-foreground">
        <span data-testid="chatanki-progress-metrics">{metricsText}</span>
        {route && (
          <Badge variant="outline" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]" data-testid="chatanki-progress-route">
            {t('blocks.ankiCards.progress.route', { defaultValue: 'route' })}: {routeLabel || route}
          </Badge>
        )}
      </div>

      {segCounts && (
        <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="chatanki-progress-segment-badges">
          {typeof segCounts.pending === 'number' && segCounts.pending > 0 && (
            <Badge variant="secondary" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.pending')}: {segCounts.pending}
            </Badge>
          )}
          {typeof segCounts.processing === 'number' && segCounts.processing > 0 && (
            <Badge variant="secondary" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.processing')}: {segCounts.processing}
            </Badge>
          )}
          {typeof segCounts.paused === 'number' && segCounts.paused > 0 && (
            <Badge variant="outline" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.paused')}: {segCounts.paused}
            </Badge>
          )}
          {typeof segCounts.failed === 'number' && segCounts.failed > 0 && (
            <Badge variant="destructive" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.failed')}: {segCounts.failed}
            </Badge>
          )}
          {typeof segCounts.truncated === 'number' && segCounts.truncated > 0 && (
            <Badge variant="destructive" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.truncated')}: {segCounts.truncated}
            </Badge>
          )}
          {typeof segCounts.cancelled === 'number' && segCounts.cancelled > 0 && (
            <Badge variant="outline" className="rounded-full px-1.5 sm:px-2 py-0.5 text-[9px] sm:text-[10px]">
              {t('blocks.ankiCards.progress.segments.cancelled')}: {segCounts.cancelled}
            </Badge>
          )}
        </div>
      )}

      {message && (
        <div
          className={cn('mt-1 text-[11px] text-muted-foreground line-clamp-2', isError && 'text-destructive/80')}
          data-testid="chatanki-progress-message"
        >
          {message}
        </div>
      )}

      {warningMessages.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-600" data-testid="chatanki-progress-warnings">
          {warningMessages.map((warning, index) => (
            <div key={`${warning}-${index}`} className="leading-snug">
              {warning}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
