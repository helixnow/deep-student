import React from 'react';
import { Progress } from '@/components/ui/shad/Progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type { ProgressBlockProps } from '../schema';

export function ProgressBlock({ title, current, total, label }: ProgressBlockProps) {
  const pct = Math.min(100, Math.round((current / total) * 100));
  return (
    <Card className="min-w-0">
      {title ? (
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent className={title ? 'pt-0 space-y-2' : 'pt-4 space-y-2'}>
        <Progress value={pct} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{label ?? `${current} / ${total}`}</span>
          <span>{pct}%</span>
        </div>
      </CardContent>
    </Card>
  );
}
