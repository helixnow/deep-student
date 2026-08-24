import React from 'react';
import { useTranslation } from 'react-i18next';
import { Progress } from '@/components/ui/shad/Progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { ProgressBlockProps } from '../schema';

export function ProgressBlock({ title, current, total, label }: ProgressBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const pct = Math.min(100, Math.round((current / total) * 100));
  return (
    <Card
      className="min-w-0"
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.progress_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} className="text-sm font-medium">{title}</CardTitle>
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
          <span>{label ?? `${current} / ${total}`}</span>
          <span>{pct}%</span>
        </div>
      </CardContent>
    </Card>
  );
}
