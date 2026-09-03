import React from 'react';
import { useTranslation } from 'react-i18next';
import { Progress } from '@/components/ui/shad/Progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import type { ProgressBlockProps } from '../schema';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export function ProgressBlock({ title, current, total, label }: ProgressBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const reducedMotion = usePrefersReducedMotion();
  const pct = Math.min(100, Math.round((current / total) * 100));
  const defaultLabel = `${formatGenerativeNumber(current)} / ${formatGenerativeNumber(total)}`;
  return (
    <Card
      className="min-w-0"
      data-generative-progress
      data-reduced-motion={reducedMotion ? 'true' : undefined}
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.progress_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0 space-y-2' : 'pt-4 space-y-2'}>
        <Progress
          value={pct}
          className="h-2"
          aria-labelledby={title ? titleId : undefined}
          aria-label={title ? undefined : (label ?? t('a11y.progress_label'))}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span dir="auto" data-progress-label>{label ?? defaultLabel}</span>
          <span data-progress-percent>{`${formatGenerativeNumber(pct)}%`}</span>
        </div>
      </CardContent>
    </Card>
  );
}
