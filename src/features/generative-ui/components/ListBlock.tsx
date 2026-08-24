import React from 'react';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { ListBlockProps } from '../schema';

export function ListBlock({ title, items, emptyLabel }: ListBlockProps) {
  return (
    <Card className="min-w-0">
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel ?? '—'}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <li key={item.id ?? idx} className="flex items-start justify-between gap-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">{item.label}</div>
                  {item.description ? (
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  ) : null}
                </div>
                {item.badge ? (
                  <Badge variant="secondary" className="shrink-0 text-xs">
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
