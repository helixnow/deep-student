import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { KeyValueGridProps } from '../schema';

export function KeyValueGridBlock({ title, rows }: KeyValueGridProps) {
  return (
    <Card className="min-w-0">
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0' : 'pt-4'}>
        <dl className="grid gap-2 sm:grid-cols-2">
          {rows.map((row, idx) => (
            <div key={`${row.key}-${idx}`} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{row.key}</dt>
              <dd className="text-sm font-medium break-words">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
