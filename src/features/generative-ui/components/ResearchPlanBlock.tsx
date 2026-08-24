import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { CheckCircle, Circle, CircleNotch } from '@phosphor-icons/react';

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
    return <CheckCircle className="h-4 w-4 text-[hsl(var(--success))]" weight="fill" />;
  }
  if (status === 'active') {
    return <CircleNotch className="h-4 w-4 text-primary animate-spin" />;
  }
  return <Circle className="h-4 w-4 text-muted-foreground/50" />;
}

export function ResearchPlanBlock({ title, round, steps }: ResearchPlanBlockProps) {
  const { t } = useTranslation('generativeUi');
  const doneCount = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="min-w-0 rounded-lg border border-border bg-card p-3 space-y-3" data-generative-research-plan>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {typeof round === 'number' ? (
          <span className="text-xs text-muted-foreground">
            {t('research.plan.round', { round })}
          </span>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {t('research.plan.progress', { done: doneCount, total: steps.length })}
      </div>
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={`${index}-${step.label}`}
            className={cn(
              'flex items-start gap-2 text-sm',
              step.status === 'done' && 'text-muted-foreground',
              step.status === 'active' && 'font-medium',
            )}
          >
            <StepIcon status={step.status ?? 'pending'} />
            <span className="min-w-0 flex-1">{step.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
