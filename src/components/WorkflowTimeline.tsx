import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from './ui/shad/Badge';
import { Progress as ShadProgress } from './ui/shad/Progress';
import { cn } from '../lib/utils';
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

const statusLineClass: Record<TimelineStatus, string> = {
  done: 'bg-primary/80',
  active: 'bg-primary/60 dark:bg-primary/80',
  pending: 'bg-border',
};

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
        className="overflow-hidden rounded-3xl border border-transparent ring-1 ring-border/40 bg-card/80 shadow-lg backdrop-blur"
      >
        <div className="flex flex-col gap-6 border-b border-border/60 bg-gradient-to-b from-background via-background/90 to-muted/30 p-6 md:p-7">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="space-y-3">
              {isProcessing && (
                <div className="text-xs uppercase tracking-[0.22em] text-muted-foreground/70">
                  {t('workflow.progress.processing', '流程进行中')}
                </div>
              )}
              <div className="space-y-1">
                <h3 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">{title}</h3>
                {subtitle && <p className="text-sm text-muted-foreground/90">{subtitle}</p>}
              </div>
              <p className="text-sm text-muted-foreground/80">{latestMessage}</p>
            </div>
            <div className="flex items-center justify-center rounded-2xl border border-border/60 bg-background/70 px-6 py-4">
              <div className="flex flex-col items-center text-center">
                <span className="text-[36px] font-light leading-none text-foreground">{Math.round(overallProgress)}</span>
                <span className="text-[11px] tracking-[0.26em] text-muted-foreground">%</span>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <ShadProgress value={overallProgress} className="h-[3px] rounded-full bg-border/40" />
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
                      'group relative flex min-w-[80px] flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] font-medium transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30',
                      meta.status === 'done' && 'text-emerald-500',
                      meta.status === 'active' && 'text-primary',
                      meta.status === 'pending' && 'text-muted-foreground/70',
                      isCurrent && 'text-primary'
                    )}
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: prefersReducedMotion ? 0.15 : 0.3, delay: prefersReducedMotion ? 0 : index * 0.04 } }}
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-full border border-current/50 text-xs">
                      {meta.visuals.icon}
                    </span>
                    <span className="text-center leading-tight text-current">
                      {meta.title}
                    </span>
                    <span className={cn('absolute inset-x-6 bottom-0 h-[2px] rounded-full opacity-0 transition-opacity', isCurrent && 'opacity-100', meta.status === 'done' ? 'bg-emerald-400/80' : meta.status === 'active' ? 'bg-primary/80' : 'bg-border/60')} />
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>

        {activeItem && (
          <div className="px-6 pb-5 pt-3 md:px-7">
            <motion.div
              key={activeItem.step}
              layout
              initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { duration: prefersReducedMotion ? 0.15 : 0.25 } }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.18 } }}
              className="flex flex-col gap-2 rounded-lg border border-border/40 bg-background/60 px-5 py-3 text-sm text-foreground"
            >
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground/70">
                <Badge variant={activeItem.visuals.badge} className="rounded-full px-3 py-0.5 text-[10px] uppercase tracking-wider">
                  {activeItem.visuals.label}
                </Badge>
                {activeItem.percentage !== undefined && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-muted px-2 py-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary/70" aria-hidden="true" />
                    {t('workflow.progress.percentage', { defaultValue: '{{value}}%', value: Math.round(activeItem.percentage) })}
                  </span>
                )}
                <span>{formatTimestamp(activeItem.timestamp ?? '') || '—'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
                <span className="text-sm font-semibold text-foreground">{activeItem.title}</span>
                {(activeItem.description || activeItem.message) && (
                  <span className="truncate text-muted-foreground/80">
                    {activeItem.description ?? activeItem.message}
                  </span>
                )}
                <span>
                  {activeItem.status === 'done'
                    ? t('workflow.progress.stage_done', '阶段已完成')
                    : activeItem.status === 'active'
                      ? t('workflow.progress.stage_active', '阶段执行中')
                      : t('workflow.progress.stage_pending', '阶段待执行')}
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
