import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { KeyValueGridProps } from '../schema';
import { formatGenerativeStatValue } from '../utils/formatGenerativeNumber';

export function KeyValueGridBlock({ title, rows }: KeyValueGridProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  return (
    <Card
      className="min-w-0"
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.key_value_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        <dl className="grid gap-2 sm:grid-cols-2">
          {rows.map((row, idx) => (
            <div key={`${row.key}-${idx}`} className="min-w-0">
              <dt dir="auto" className="text-xs text-muted-foreground">{row.key}</dt>
              <dd dir="auto" className="text-sm font-medium break-words" data-kv-value>
                {formatGenerativeStatValue(row.value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
