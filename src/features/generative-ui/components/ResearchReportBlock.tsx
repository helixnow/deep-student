import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/shad/Badge';
import {
  parseResearchReportCitations,
  RESEARCH_REPORT_CITATION_PATTERN,
} from '../utils/parseResearchReportCitations';

export const researchReportPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(12000),
  density: z.enum(['compact', 'normal']).optional().default('normal'),
});

export type ResearchReportBlockProps = z.infer<typeof researchReportPropsSchema>;

function renderBodyWithCitations(body: string, citationAriaLabel: (label: string) => string) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(RESEARCH_REPORT_CITATION_PATTERN.source, 'g');

  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`} className="whitespace-pre-wrap">
          {body.slice(lastIndex, start)}
        </span>,
      );
    }
    const fullMatch = match[0];
    parts.push(
      <Badge
        key={`cite-${start}`}
        variant="secondary"
        className="mx-0.5 align-baseline text-[10px] font-normal"
        aria-label={citationAriaLabel(fullMatch)}
      >
        {fullMatch}
      </Badge>,
    );
    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < body.length) {
    parts.push(
      <span key={`text-${lastIndex}`} className="whitespace-pre-wrap">
        {body.slice(lastIndex)}
      </span>,
    );
  }

  return parts;
}

export function ResearchReportBlock({ title, body, density }: ResearchReportBlockProps) {
  const { t } = useTranslation('generativeUi');
  const citationCount = useMemo(() => parseResearchReportCitations(body).length, [body]);

  return (
    <article
      className={cn('min-w-0 space-y-2 rounded-lg border border-border bg-card p-3', density === 'compact' && 'p-2')}
      data-generative-research-report
      data-citation-count={citationCount || undefined}
    >
      {title ? (
        <h4 className={cn('font-semibold', density === 'compact' ? 'text-sm' : 'text-base')}>{title}</h4>
      ) : null}
      <div
        className={cn(
          'text-muted-foreground leading-relaxed',
          density === 'compact' ? 'text-xs' : 'text-sm',
        )}
      >
        {renderBodyWithCitations(body, (label) => t('research.report.citation_aria', { label }))}
      </div>
    </article>
  );
}
