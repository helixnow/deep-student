import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/shad/Alert';
import { z } from 'zod';

export const mistakeAnalysisPropsSchema = z.object({
  id: z.string().optional(),
  topic: z.string().min(1).max(120),
  errorRate: z.number().min(0).max(100),
  mistakeCount: z.number().min(0).optional(),
  suggestion: z.string().max(500),
  severity: z.enum(['low', 'medium', 'high']).optional().default('medium'),
});

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
  return (
    <Alert variant={severityVariant[severity]}>
      <AlertTitle>
        {topic} · 错误率 {errorRate}%
        {mistakeCount != null ? `（${mistakeCount} 道）` : ''}
      </AlertTitle>
      <AlertDescription>{suggestion}</AlertDescription>
    </Alert>
  );
}
