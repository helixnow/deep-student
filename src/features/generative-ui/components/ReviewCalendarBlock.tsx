import React from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { z } from 'zod';
import { formatGenerativeDate } from '../utils/formatGenerativeDate';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export const reviewCalendarPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(120).optional(),
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

function toDateTime(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

export function ReviewCalendarBlock({ title, days }: ReviewCalendarProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const resolvedTitle = title ?? t('review_calendar.default_title');
  return (
    <Card className="min-w-0" role="region" aria-labelledby={titleId}>
      <CardHeader className="pb-2">
        <CardTitle id={titleId} dir="auto" className="text-sm font-medium">{resolvedTitle}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-2">
          {days.map((day, idx) => (
            <li
              key={`${day.date}-${idx}`}
              className="flex items-center justify-between gap-2 text-sm"
              aria-label={t('a11y.review_day', {
                date: day.label ? `${day.date} ${day.label}` : day.date,
                due: day.dueCount,
              })}
            >
              <div className="min-w-0">
                <time className="font-medium" dateTime={toDateTime(day.date)} dir="auto">
                  {formatGenerativeDate(day.date)}
                </time>
                {day.label ? (
                  <div className="text-xs text-muted-foreground" dir="auto">
                    {day.label}
                  </div>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge
                  variant={day.dueCount > 0 ? 'default' : 'secondary'}
                  className="text-xs"
                  data-due-count={formatGenerativeNumber(day.dueCount)}
                >
                  {t('review_calendar.due', { count: day.dueCount })}
                </Badge>
                {day.completedCount != null ? (
                  <span
                    className="text-xs text-muted-foreground"
                    data-completed-count={formatGenerativeNumber(day.completedCount)}
                  >
                    {t('review_calendar.completed', { count: day.completedCount })}
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
