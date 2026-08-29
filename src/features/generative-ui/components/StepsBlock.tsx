import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { CheckCircle, Circle, MinusCircle, WarningCircle } from '@phosphor-icons/react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { cn } from '@/utils/cn';
import { generativeUIRegistry } from '../registry';

export const STEPS_STATUSES = ['pending', 'active', 'done', 'error', 'skipped'] as const;
export type StepsStatus = (typeof STEPS_STATUSES)[number];

/** status → 设计宪法语义色（default/info/success/destructive/muted） */
export const STEPS_STATUS_TONE = {
  pending: 'default',
  active: 'info',
  done: 'success',
  error: 'destructive',
  skipped: 'muted',
} as const satisfies Record<StepsStatus, 'default' | 'info' | 'success' | 'destructive' | 'muted'>;

const STATUS_ICON_CLASS: Record<StepsStatus, string> = {
  pending: 'text-foreground',
  active: 'text-info',
  done: 'text-success',
  error: 'text-destructive',
  skipped: 'text-muted-foreground',
};

const STATUS_LABEL_CLASS: Record<StepsStatus, string> = {
  pending: 'text-foreground',
  active: 'text-info',
  done: 'text-success',
  error: 'text-destructive',
  skipped: 'text-muted-foreground',
};

const STATUS_BADGE_CLASS: Record<StepsStatus, string> = {
  pending: 'bg-muted/30 text-foreground',
  active: 'bg-info/10 text-info',
  done: 'bg-success/10 text-success',
  error: 'bg-destructive/10 text-destructive',
  skipped: 'bg-muted/10 text-muted-foreground',
};

export const stepsStepSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(160),
  description: z.string().max(300).optional(),
  status: z.enum(STEPS_STATUSES).default('pending'),
  durationLabel: z.string().max(40).optional(),
});

export const stepsBlockPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
  steps: z.array(stepsStepSchema).min(1).max(20),
});

export type StepsStepProps = z.infer<typeof stepsStepSchema>;
export type StepsBlockProps = z.infer<typeof stepsBlockPropsSchema>;

export const STEPS_BLOCK_TYPE = 'steps';

const STEP_STATUS_A11Y_KEY = {
  pending: 'a11y.step_pending',
  active: 'a11y.step_active',
  done: 'a11y.step_done',
  error: 'a11y.step_error',
  skipped: 'a11y.step_skipped',
} as const satisfies Record<StepsStatus, string>;

function StepStatusIcon({ status }: { status: StepsStatus }) {
  const className = cn('h-4 w-4 shrink-0', STATUS_ICON_CLASS[status]);
  if (status === 'done') {
    return <CheckCircle className={className} weight="fill" aria-hidden />;
  }
  if (status === 'active') {
    return <Circle className={className} weight="fill" aria-hidden />;
  }
  if (status === 'error') {
    return <WarningCircle className={className} weight="fill" aria-hidden />;
  }
  if (status === 'skipped') {
    return <MinusCircle className={className} aria-hidden />;
  }
  return <Circle className={className} aria-hidden />;
}

export function StepsBlock({ id, title, steps }: StepsBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();

  return (
    <Card
      className="min-w-0"
      data-generative-steps
      data-steps-id={id}
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.steps_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        <ol className="space-y-3">
          {steps.map((step, index) => {
            const status = step.status ?? 'pending';
            const isActive = status === 'active';
            return (
              <li
                key={step.id ?? `${index}-${step.label}`}
                aria-current={isActive ? 'step' : undefined}
                data-step-status={status}
                data-tone={STEPS_STATUS_TONE[status]}
                className="flex items-start gap-3"
              >
                <StepStatusIcon status={status} />
                <span className="sr-only">{t(STEP_STATUS_A11Y_KEY[status])}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span
                      dir="auto"
                      className={cn(
                        'text-sm font-medium',
                        STATUS_LABEL_CLASS[status],
                        status === 'skipped' && 'line-through',
                      )}
                    >
                      {step.label}
                    </span>
                    {step.durationLabel ? (
                      <span dir="auto" className="shrink-0 text-xs text-muted-foreground">{step.durationLabel}</span>
                    ) : null}
                  </div>
                  {step.description ? (
                    <p dir="auto" className="text-xs text-muted-foreground">{step.description}</p>
                  ) : null}
                  <span
                    className={cn(
                      'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
                      STATUS_BADGE_CLASS[status],
                    )}
                  >
                    {t(`blocks.steps.status_${status}`)}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/** 测试 / 按需注册。不写入 blocks/index.ts，避免破坏 EXPECTED_BLOCK_TYPES。 */
export function registerStepsBlock(): void {
  generativeUIRegistry.register({
    type: STEPS_BLOCK_TYPE,
    component: StepsBlock,
    propsSchema: stepsBlockPropsSchema,
    description: '学习计划步骤：通用步骤列表（pending/active/done/error/skipped，可选时长）',
    allowPartialRender: true,
  });
}
