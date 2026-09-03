import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { CheckCircle, Circle, CircleNotch } from '@phosphor-icons/react';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export const researchPlanStepSchema = z.object({
  label: z.string().min(1).max(200),
  status: z.enum(['pending', 'active', 'done']).optional().default('pending'),
});

export const researchPlanPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(160),
  round: z.number().int().min(1).optional(),
  steps: z.array(researchPlanStepSchema).min(1).max(12),
});

export type ResearchPlanBlockProps = z.infer<typeof researchPlanPropsSchema>;

function StepIcon({ status }: { status: 'pending' | 'active' | 'done' }) {
  if (status === 'done') {
    return <CheckCircle className="h-4 w-4 text-[hsl(var(--success))]" weight="fill" aria-hidden />;
  }
  if (status === 'active') {
    return <CircleNotch className="h-4 w-4 text-primary animate-spin" aria-hidden />;
  }
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />;
}

const STEP_STATUS_KEY = {
  pending: 'a11y.step_pending',
  active: 'a11y.step_active',
  done: 'a11y.step_done',
} as const;

export function ResearchPlanBlock({ title, round, steps }: ResearchPlanBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const progressLabel = t('research.plan.progress', {
    done: formatGenerativeNumber(doneCount),
    total: formatGenerativeNumber(steps.length),
  });

  return (
    <div
      className="min-w-0 rounded-lg border border-border bg-card p-3 space-y-3"
      data-generative-research-plan
      role="region"
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 id={titleId} dir="auto" className="text-sm font-semibold">{title}</h4>
        {typeof round === 'number' ? (
          <span className="text-xs text-muted-foreground">
            {t('research.plan.round', { round: formatGenerativeNumber(round) })}
          </span>
        ) : null}
      </div>
      <div
        className="text-xs text-muted-foreground"
        role="progressbar"
        aria-valuenow={doneCount}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-label={progressLabel}
      >
        {progressLabel}
      </div>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const status = step.status ?? 'pending';
          return (
            <li
              key={`${index}-${step.label}`}
              className={cn(
                'flex items-start gap-2 text-sm',
                status === 'done' && 'text-muted-foreground',
                status === 'active' && 'font-medium',
              )}
            >
              <StepIcon status={status} />
              <span className="sr-only">{t(STEP_STATUS_KEY[status])}</span>
              <span className="min-w-0 flex-1" dir="auto">{step.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
