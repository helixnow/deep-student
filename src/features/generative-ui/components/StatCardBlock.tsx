import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { cn } from '@/utils/cn';
import type { StatCardProps } from '../schema';
import { TrendUp, TrendDown, Minus } from '@phosphor-icons/react';

const trendIcon = {
  up: TrendUp,
  down: TrendDown,
  neutral: Minus,
} as const;

export function StatCardBlock({ title, value, subtitle, trend, trendLabel }: StatCardProps) {
  const TrendIcon = trend ? trendIcon[trend] : null;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {(subtitle || trendLabel) && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {TrendIcon && (
              <TrendIcon
                className={cn(
                  'h-3.5 w-3.5',
                  trend === 'up' && 'text-success',
                  trend === 'down' && 'text-destructive',
                )}
                aria-hidden
              />
            )}
            <span>{trendLabel ?? subtitle}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
