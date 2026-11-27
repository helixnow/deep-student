import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge } from './ui/shad/Badge';
import { Progress as ShadProgress } from './ui/shad/Progress';
import { cn } from '@/utils/cn';
import { useTranslation } from 'react-i18next';

type TimelineStatus = 'pending' | 'active' | 'done';

interface StatusVisual {
  label: string;
  icon: React.ReactNode;
  badge: 'default' | 'secondary' | 'outline';
}

interface TimelineItem {
  step: string;
  status: TimelineStatus;
  title: string;
  description?: string;
  message?: string;
  timestamp?: string;
  percentage?: number;
}

interface WorkflowTimelineProps {
  items: TimelineItem[];
  overallProgress: number;
  isProcessing: boolean;
  latestMessage: string;
  title: string;
  subtitle?: string;
  resolveTimelineStatus: (status: TimelineStatus) => StatusVisual;
  formatTimestamp: (timestamp: string) => string;
  prefersReducedMotion?: boolean;
  currentStep?: string;
}

export const WorkflowTimeline: React.FC<WorkflowTimelineProps> = ({
  items,
  overallProgress,
  isProcessing,
  latestMessage,
  title,
  subtitle,
  resolveTimelineStatus,
  formatTimestamp,
  prefersReducedMotion = false,
  currentStep,
}) => {
  const [focusedStep, setFocusedStep] = useState<string | null>(null);
  const { t } = useTranslation('common');

  useEffect(() => {
    if (!focusedStep && currentStep) {
      setFocusedStep(currentStep);
    }
  }, [currentStep, focusedStep]);

  const summarizedItems = useMemo(() => {
    return items.map(item => ({ ...item, visuals: resolveTimelineStatus(item.status) }));
  }, [items, resolveTimelineStatus]);

  const activeItem = useMemo(() => {
    if (focusedStep) {
      return summarizedItems.find(item => item.step === focusedStep) ?? null;
    }
    return summarizedItems.find(item => item.status === 'active') ?? summarizedItems.find(item => item.status === 'done') ?? null;
  }, [summarizedItems, focusedStep]);

  const timelineMetas = summarizedItems.map(item => ({
    step: item.step,
    title: item.title,
    status: item.status,
    visuals: item.visuals,
  }));

  if (!items || items.length === 0) return null;

  return (
    <motion.section
      layout
      className="mx-auto max-w-6xl px-4 md:px-6"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={isProcessing}
    >
      <motion.div
        layout
        className="overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex flex-col gap-5 border-b border-border p-5 md:p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0 space-y-2">
              {isProcessing && (
                <div className="text-xs uppercase tracking-wider text-muted-foreground">
                  {t('workflow.progress.processing')}
                </div>
              )}
              <div className="space-y-1">
                <h3 className="text-lg font-semibold tracking-tight text-foreground md:text-xl">{title}</h3>
                {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
              </div>
              <p className="text-sm text-muted-foreground">{latestMessage}</p>
            </div>
            <div className="flex items-baseline gap-1 self-start md:self-end text-foreground">
              <span className="text-3xl font-semibold leading-none tabular-nums">{Math.round(overallProgress)}</span>
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <ShadProgress value={overallProgress} className="h-1 rounded-full bg-muted" />
            <div className="flex flex-wrap justify-between gap-1 md:gap-2">
              {timelineMetas.map((meta, index) => {
                const isCurrent = meta.step === activeItem?.step;
                return (
                  <motion.button
                    key={meta.step}
                    layout
                    type="button"
                    onClick={() => setFocusedStep(meta.step)}
                    className={cn(
                      'group relative flex min-w-[80px] flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30',
                      meta.status === 'done' && 'text-success',
                      meta.status === 'active' && 'text-primary',
                      meta.status === 'pending' && 'text-muted-foreground',
                      isCurrent && 'bg-muted/60 text-primary'
                    )}
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: prefersReducedMotion ? 0.15 : 0.3, delay: prefersReducedMotion ? 0 : index * 0.04 } }}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-current/40 text-xs">
                      {meta.visuals.icon}
                    </span>
                    <span className="text-center leading-tight text-current">
                      {meta.title}
                    </span>
                    <span
                      className={cn(
                        'absolute inset-x-4 bottom-0 h-0.5 rounded-full opacity-0 transition-opacity',
                        isCurrent && 'opacity-100',
                        meta.status === 'done'
                          ? 'bg-success'
                          : meta.status === 'active'
                            ? 'bg-primary'
                            : 'bg-border'
                      )}
                    />
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>

        {activeItem && (
          <div className="px-5 py-4 md:px-6">
            <motion.div
              key={activeItem.step}
              layout
              initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: prefersReducedMotion ? 0.15 : 0.25 } }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.18 } }}
              className="flex flex-col gap-2 text-sm text-foreground"
            >
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <Badge variant={activeItem.visuals.badge} className="rounded-full px-2.5 py-0.5 text-xs uppercase tracking-wider">
                  {activeItem.visuals.label}
                </Badge>
                {activeItem.percentage !== undefined && (
                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-foreground">
                    {t('workflow.progress.percentage', { value: Math.round(activeItem.percentage) })}
                  </span>
                )}
                <span>{formatTimestamp(activeItem.timestamp ?? '') || '—'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="text-sm font-semibold text-foreground">{activeItem.title}</span>
                {(activeItem.description || activeItem.message) && (
                  <span className="truncate text-muted-foreground">
                    {activeItem.description ?? activeItem.message}
                  </span>
                )}
                <span>
                  {activeItem.status === 'done'
                    ? t('workflow.progress.stage_done')
                    : activeItem.status === 'active'
                      ? t('workflow.progress.stage_active')
                      : t('workflow.progress.stage_pending')}
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </motion.div>
    </motion.section>
  );
};

export default WorkflowTimeline;
