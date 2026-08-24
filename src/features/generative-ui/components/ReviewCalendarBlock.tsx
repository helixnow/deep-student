import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { z } from 'zod';

export const reviewCalendarPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional().default('复习日历'),
  days: z
    .array(
      z.object({
        date: z.string().min(1).max(20),
        label: z.string().max(40).optional(),
        dueCount: z.number().min(0),
        completedCount: z.number().min(0).optional(),
      }),
    )
    .min(1)
    .max(14),
});

export type ReviewCalendarProps = z.infer<typeof reviewCalendarPropsSchema>;

export function ReviewCalendarBlock({ title, days }: ReviewCalendarProps) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {days.map((day, idx) => (
            <li key={`${day.date}-${idx}`} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{day.date}</div>
                {day.label ? <div className="text-xs text-muted-foreground">{day.label}</div> : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant={day.dueCount > 0 ? 'default' : 'secondary'} className="text-xs">
                  待复习 {day.dueCount}
                </Badge>
                {day.completedCount != null ? (
                  <span className="text-xs text-muted-foreground">已完成 {day.completedCount}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
