import { mistakeAnalysisPropsSchema } from '../schema';
export { mistakeAnalysisPropsSchema } from '../schema';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import type { z } from 'zod';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export type MistakeAnalysisProps = z.infer<typeof mistakeAnalysisPropsSchema>;

const severityVariant = {
  low: 'info',
  medium: 'warning',
  high: 'destructive',
} as const;

export function MistakeAnalysisBlock({
  topic,
  errorRate,
  mistakeCount,
  suggestion,
  severity = 'medium',
}: MistakeAnalysisProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const formattedRate = formatGenerativeNumber(errorRate);
  return (
    <Alert variant={severityVariant[severity]} role="alert" aria-labelledby={titleId}>
      <AlertTitle id={titleId} dir="auto" data-error-rate={formattedRate}>
        {topic} · {t('mistake.error_rate', { rate: formattedRate })}
        {mistakeCount != null ? t('mistake.count', { count: formatGenerativeNumber(mistakeCount) }) : ''}
      </AlertTitle>
      <AlertDescription dir="auto">{suggestion}</AlertDescription>
    </Alert>
  );
}
