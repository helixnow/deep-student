import React from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { ListBlockProps } from '../schema';

export function ListBlock({ title, items, emptyLabel }: ListBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  return (
    <Card
      className="min-w-0"
      role="region"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.list_label')}
    >
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-list-empty>
            {emptyLabel ?? t('blocks.list.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <li key={item.id ?? idx} className="flex items-start justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium" dir="auto">{item.label}</div>
                  {item.description ? (
                    <div className="text-xs text-muted-foreground" dir="auto">{item.description}</div>
                  ) : null}
                </div>
                {item.badge ? (
                  <Badge variant="secondary" className="shrink-0 text-xs" dir="auto">
                    {item.badge}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
