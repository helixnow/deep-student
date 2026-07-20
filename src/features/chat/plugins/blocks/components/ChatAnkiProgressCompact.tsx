import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleNotch, X, ArrowClockwise, CaretDown } from '@phosphor-icons/react';

import { cn } from '@/utils/cn';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { DsButton } from '@/components/ui/DsButton';
import type { AnkiCardsBlockData } from '../ankiCardsBlock';
import { parseAnkiSegmentCounts } from './ankiSegmentCounts';
import './chat-anki-cards.css';

type StepId = 'routing' | 'importing' | 'generating' | 'completed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'active' | 'done';

/** 动态 i18n key 改为显式映射，消灭 `t(... as any)` */
const ANKI_CONNECT_LABEL_KEYS = {
  connected: 'blocks.ankiCards.progress.ankiConnect.connected',
  notConnected: 'blocks.ankiCards.progress.ankiConnect.notConnected',
  checking: 'blocks.ankiCards.progress.ankiConnect.checking',
} as const;

const ROUTE_VALUE_KEYS: Record<string, string> = {
  simple_text: 'blocks.ankiCards.progress.routeValues.simple_text',
  vlm_light: 'blocks.ankiCards.progress.routeValues.vlm_light',
  vlm_full: 'blocks.ankiCards.progress.routeValues.vlm_full',
};

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
    case 'completed_with_errors':
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
      className: 'border-warning/40 bg-warning/10 text-warning',
    };
  }
  return { state: 'unknown' as const, label: 'checking', variant: 'secondary' as const, className: '' };
}

const AnkiConnectRefreshButton: React.FC<{
  onRefresh: () => Promise<void>;
  label: string;
}> = ({ onRefresh, label }) => {
  const [refreshing, setRefreshing] = useState(false);
  const handleClick = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <DsButton
      type="button"
      variant="ghost"
      size="icon"
      iconOnly
      onClick={handleClick}
      disabled={refreshing}
      className="!h-10 !w-10 rounded-full"
      title={label}
      aria-label={label}
    >
      <ArrowClockwise className={cn('h-4 w-4 text-muted-foreground', refreshing && 'animate-spin')} />
    </DsButton>
  );
};

export const ChatAnkiProgressCompact: React.FC<{
  progress?: AnkiCardsBlockData['progress'];
  ankiConnect?: AnkiCardsBlockData['ankiConnect'];
  warnings?: AnkiCardsBlockData['warnings'];
  cardsCount: number;
  blockStatus: string;
  finalStatus?: string;
  errorMessage?: string;
  onRefreshAnkiConnect?: () => Promise<void>;
}> = ({
  progress,
  ankiConnect,
  warnings,
  cardsCount,
  blockStatus,
  finalStatus,
  errorMessage,
  onRefreshAnkiConnect,
}) => {
  const { t } = useTranslation('chatV2');
  const { t: tAnki } = useTranslation('anki');
  // 次要指标（分段徽标/路线）可折叠；默认展开保持既有信息密度
  const [showDetails, setShowDetails] = useState(true);

  const percent = useMemo(() => clampRatioToPercent(progress?.completedRatio), [progress?.completedRatio]);
  const stage = progress?.stage;
  const normalizedFinalStatus =
    typeof finalStatus === 'string' ? finalStatus.toLowerCase() : undefined;
  const normalizedStage =
    typeof stage === 'string' ? stage.toLowerCase() : undefined;
  const statusHint =
    normalizedStage === 'completed_with_errors'
      ? normalizedStage
      : normalizedFinalStatus ??
        normalizedStage ??
        (blockStatus === 'error' ? 'failed' : blockStatus === 'success' ? 'completed' : undefined);

  const isCancelled = statusHint === 'cancelled' || statusHint === 'canceled';
  const isCompletedWithErrors = statusHint === 'completed_with_errors';
  const isError =
    !isCancelled &&
    !isCompletedWithErrors &&
    (blockStatus === 'error' || statusHint === 'error' || statusHint === 'failed' || Boolean(errorMessage));
  const isCompleted =
    !isCancelled &&
    !isError &&
    (isCompletedWithErrors ||
      blockStatus === 'success' ||
      statusHint === 'completed' ||
      statusHint === 'success');

  const route = typeof progress?.route === 'string' ? progress.route : '';
  const normalizedRoute = route.trim().toLowerCase();
  const includeImporting =
    normalizedStage === 'importing' ||
    (normalizedRoute.length > 0 && normalizedRoute !== 'simple_text');
  const hasSegmentEvidence =
    progress?.counts !== null &&
    typeof progress?.counts === 'object' &&
    Object.values(progress.counts as Record<string, unknown>).some(
      value => typeof value === 'number' && value > 0,
    );
  const hasGenerationEvidence =
    cardsCount > 0 ||
    (typeof progress?.cardsGenerated === 'number' && progress.cardsGenerated > 0) ||
    (typeof progress?.completedRatio === 'number' && progress.completedRatio > 0) ||
    hasSegmentEvidence;
  const normalizedPipelineStep = normalizeStageToStep(normalizedStage);
  const activePipelineStep: StepId =
    normalizedPipelineStep === 'routing' ||
    normalizedPipelineStep === 'importing' ||
    normalizedPipelineStep === 'generating'
      ? normalizedPipelineStep
      : hasGenerationEvidence
        ? 'generating'
        : includeImporting
          ? 'importing'
          : 'routing';
  const step = isError || isCancelled
    ? activePipelineStep
    : isCompleted
      ? 'completed'
      : normalizedPipelineStep;

  const steps = useMemo(() => {
    const base = [
      { id: 'routing' as const, label: t('blocks.ankiCards.progress.steps.routing') },
      ...(includeImporting
        ? [{ id: 'importing' as const, label: t('blocks.ankiCards.progress.steps.importing') }]
        : []),
      { id: 'generating' as const, label: t('blocks.ankiCards.progress.steps.generating') },
    ];
    if (isError || isCancelled) {
      const activePhaseIndex = Math.max(
        base.findIndex(item => item.id === activePipelineStep),
        0,
      );
      return base.slice(0, activePhaseIndex + 1);
    }
    return [
      ...base,
      { id: 'completed' as const, label: t('blocks.ankiCards.progress.steps.completed') },
    ];
  }, [t, isError, isCancelled, includeImporting, activePipelineStep]);

  const activeIndex = useMemo(() => steps.findIndex(s => s.id === step), [steps, step]);

  const ankiConnectMeta = useMemo(() => getAnkiConnectState(ankiConnect), [ankiConnect]);
  const cardsGenerated = typeof progress?.cardsGenerated === 'number' ? progress.cardsGenerated : cardsCount;
  const parsedCounts = useMemo(() => parseAnkiSegmentCounts(progress?.counts), [progress?.counts]);
  const segTotal = parsedCounts?.total;
  const segCompleted = parsedCounts?.completed;
  const segCounts = useMemo(() => {
    if (!parsedCounts || typeof parsedCounts.total !== 'number') return null;
    return {
      ...parsedCounts,
      total: parsedCounts.total,
      processing: (parsedCounts.processing ?? 0) + (parsedCounts.streaming ?? 0),
    };
  }, [parsedCounts]);

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
  const routeLabel = useMemo(() => {
    if (!route) return '';
    const normalized = route.trim().toLowerCase();
    if (!normalized) return '';
    const key = ROUTE_VALUE_KEYS[normalized];
    return key ? t(key, { defaultValue: route }) : route;
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
  const visibleWarningMessages = warningMessages.filter(
    warning => warning !== message && warning !== errorMessage,
  );

  // 运行期进度条单调不回退：后台分段完成率可能抖动，
  // 视觉上只前进不倒退，终态/重新路由时重置。
  const monotonicPercentRef = useRef(0);
  const smoothedPercent = useMemo(() => {
    if (typeof percent !== 'number') return percent;
    const isRestarting = normalizedStage === 'routing' || normalizedStage === 'queued';
    if (blockStatus !== 'running' || isError || isCancelled || isCompleted || isRestarting) {
      monotonicPercentRef.current = percent;
      return percent;
    }
    monotonicPercentRef.current = Math.max(monotonicPercentRef.current, percent);
    return monotonicPercentRef.current;
  }, [percent, blockStatus, normalizedStage, isError, isCancelled, isCompleted]);

  let progressValue: number | null = smoothedPercent;
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

  const isLimitReached = messageKey.endsWith('limitReached');
  // 生成阶段无后端文案时，给出"生成第 N 张"实时提示（key 变化触发轻微入场动画）
  const showGeneratingTicker =
    blockStatus === 'running' &&
    !isError &&
    !isCancelled &&
    !isCompleted &&
    !message &&
    step === 'generating';

  return (
    <section
      data-testid="chatanki-progress"
      className={cn(
        'mt-2 overflow-hidden rounded-lg border border-border/50 bg-muted/10 px-3 py-2',
        isError && 'border-destructive/40 bg-destructive/5',
        isCompletedWithErrors && 'border-warning/40 bg-warning/5',
        isCancelled && 'border-warning/40 bg-warning/10'
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
              'flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full border text-2xs sm:text-2xs flex-shrink-0',
              isDone && 'border-success bg-success text-white',
              isActive && !isError && !isCancelled && 'border-primary bg-primary/10 text-primary',
              isActive && isError && 'border-destructive bg-destructive/10 text-destructive',
              isActive && isCancelled && 'border-warning bg-warning/10 text-warning',
              status === 'pending' && 'border-border bg-background/40 text-muted-foreground'
            );
            const labelClass = cn(
              'text-xs leading-none whitespace-nowrap',
              isDone && 'text-success',
              isActive && !isError && !isCancelled && 'text-primary',
              isActive && isError && 'text-destructive',
              isActive && isCancelled && 'text-warning',
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
                        <CircleNotch className={cn('h-2.5 w-2.5 sm:h-3 sm:w-3', blockStatus === 'running' && 'animate-spin')} />
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
                      isDone ? 'bg-success/60' : isActive ? 'bg-primary/40' : 'bg-border'
                    )}
                    aria-hidden="true"
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* AnkiConnect 状态 + 刷新按钮 + 百分比 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Badge
            variant={ankiConnectMeta.variant}
            className={cn('max-w-[180px] truncate whitespace-nowrap rounded-full px-2 py-0.5 text-xs sm:max-w-[220px]', ankiConnectMeta.className)}
            data-testid="chatanki-progress-anki-connect"
            title={ankiConnect?.error ?? undefined}
          >
            {t('blocks.ankiCards.progress.ankiConnect.label', { defaultValue: 'AnkiConnect' })}:{' '}
            {t(ANKI_CONNECT_LABEL_KEYS[ankiConnectMeta.label], {
              defaultValue:
                ankiConnectMeta.label === 'connected'
                  ? 'connected'
                  : ankiConnectMeta.label === 'notConnected'
                    ? 'not connected'
                    : 'checking',
            })}
          </Badge>
          {onRefreshAnkiConnect && ankiConnectMeta.state !== 'connected' && (
            <AnkiConnectRefreshButton
              onRefresh={onRefreshAnkiConnect}
              label={t('blocks.ankiCards.progress.ankiConnect.refresh')}
            />
          )}
          {typeof smoothedPercent === 'number' && (
            <span
              className={cn('text-xs tabular-nums flex-shrink-0', isError ? 'text-destructive' : 'text-muted-foreground')}
              data-testid="chatanki-progress-percent"
            >
              {smoothedPercent}%
            </span>
          )}
          <DsButton
            type="button"
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setShowDetails(prev => !prev)}
            className="!h-8 !w-8 rounded-full"
            aria-expanded={showDetails}
            aria-label={tAnki(showDetails ? 'chatBlock.detailsCollapse' : 'chatBlock.detailsExpand')}
            title={tAnki(showDetails ? 'chatBlock.detailsCollapse' : 'chatBlock.detailsExpand')}
          >
            <CaretDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform duration-200',
                showDetails && 'rotate-180'
              )}
            />
          </DsButton>
        </div>
      </div>

      {/* 进度条（宽度平滑过渡，杜绝跳变） */}
      <div className="mt-2">
        <Progress
          value={progressValue}
          className={cn(
            'h-1.5 [&>div]:duration-500 [&>div]:ease-out',
            isError && '[&>div]:bg-destructive',
            isCancelled && '[&>div]:bg-warning'
          )}
        />
      </div>

      {/* 生成阶段实时提示：生成第 N 张（cardsGenerated 变化触发入场动画） */}
      {showGeneratingTicker && (
        <div
          key={cardsGenerated}
          className="ui-rise-in mt-1.5 text-xs text-muted-foreground"
          data-testid="chatanki-progress-ticker"
        >
          {tAnki('chatBlock.generatingNth', { count: cardsGenerated + 1 })}
        </div>
      )}

      {/* 指标信息（可折叠详情） */}
      {showDetails && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground sm:gap-2">
          <span data-testid="chatanki-progress-metrics">{metricsText}</span>
          {route && (
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-xs" data-testid="chatanki-progress-route">
              {t('blocks.ankiCards.progress.route', { defaultValue: 'route' })}: {routeLabel || route}
            </Badge>
          )}
        </div>
      )}

      {showDetails && (segCounts || isCompletedWithErrors) && (
        <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="chatanki-progress-segment-badges">
          {isCompletedWithErrors && (
            <Badge
              variant="destructive"
              className="rounded-full px-2 py-0.5 text-xs"
              data-testid="chatanki-progress-completed-with-errors"
            >
              {t('blocks.ankiCards.progress.segments.completedWithErrors')}
            </Badge>
          )}
          {typeof segCounts?.pending === 'number' && segCounts.pending > 0 && (
            <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.pending')}: {segCounts.pending}
            </Badge>
          )}
          {typeof segCounts?.processing === 'number' && segCounts.processing > 0 && (
            <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.processing')}: {segCounts.processing}
            </Badge>
          )}
          {typeof segCounts?.paused === 'number' && segCounts.paused > 0 && (
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.paused')}: {segCounts.paused}
            </Badge>
          )}
          {typeof segCounts?.failed === 'number' && segCounts.failed > 0 && (
            <Badge variant="destructive" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.failed')}: {segCounts.failed}
            </Badge>
          )}
          {typeof segCounts?.truncated === 'number' && segCounts.truncated > 0 && (
            <Badge variant="destructive" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.truncated')}: {segCounts.truncated}
            </Badge>
          )}
          {typeof segCounts?.cancelled === 'number' && segCounts.cancelled > 0 && (
            <Badge variant="outline" className="rounded-full px-2 py-0.5 text-xs">
              {t('blocks.ankiCards.progress.segments.cancelled')}: {segCounts.cancelled}
            </Badge>
          )}
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs leading-snug text-destructive"
          data-testid="chatanki-progress-error"
        >
          {errorMessage}
        </div>
      )}

      {message && message !== errorMessage && (
        isLimitReached ? (
          // limitReached 是正常完成而非失败：绿色信息条 + 标题，避免被误读为错误
          <div
            className="mt-1.5 flex items-start gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-1.5 text-xs leading-snug text-success"
            data-testid="chatanki-progress-message"
          >
            <Check className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <span>
              <span className="font-medium">{tAnki('chatBlock.limitReachedTitle')}</span>
              {' · '}
              {message}
            </span>
          </div>
        ) : (
          <div
            className={cn('mt-1 line-clamp-2 text-xs text-muted-foreground', isError && 'text-destructive/80')}
            data-testid="chatanki-progress-message"
          >
            {message}
          </div>
        )
      )}

      {visibleWarningMessages.length > 0 && (
        <div className="mt-1 text-xs text-warning" data-testid="chatanki-progress-warnings">
          {visibleWarningMessages.map((warning, index) => (
            <div key={`${warning}-${index}`} className="leading-snug">
              {warning}
            </div>
          ))}
        </div>
      )}

      {ankiConnectMeta.state === 'not_connected' && ankiConnect?.error && (
        <div className="mt-1 text-xs leading-snug text-warning">
          {ankiConnect.error}
        </div>
      )}
    </section>
  );
};
