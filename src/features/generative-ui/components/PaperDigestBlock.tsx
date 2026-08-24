import React from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Badge } from '@/components/ui/shad/Badge';
import { formatGenerativeNumber } from '../utils/formatGenerativeNumber';

export const paperDigestPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(300),
  authors: z.string().max(200).optional(),
  venue: z.string().max(120).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  citationLabel: z.string().max(40).optional(),
  citationCount: z.number().min(0).optional(),
  keyFindings: z.array(z.string().min(1).max(300)).max(8).optional(),
  abstractExcerpt: z.string().max(500).optional(),
});

export type PaperDigestBlockProps = z.infer<typeof paperDigestPropsSchema>;

export function PaperDigestBlock({
  title,
  authors,
  venue,
  year,
  citationLabel,
  citationCount,
  keyFindings,
  abstractExcerpt,
}: PaperDigestBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const findingsId = React.useId();
  const meta = [authors, venue, year ? String(year) : undefined].filter(Boolean).join(' · ');
  const formattedCitationCount =
    typeof citationCount === 'number' ? formatGenerativeNumber(citationCount) : undefined;

  return (
    <Card className="min-w-0" data-generative-paper-digest role="region" aria-labelledby={titleId}>
      <CardHeader className="pb-2 space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle id={titleId} dir="auto" className="text-sm font-semibold leading-snug">{title}</CardTitle>
          {citationLabel ? (
            <Badge variant="secondary" dir="auto" className="text-xs shrink-0">
              {citationLabel}
            </Badge>
          ) : null}
        </div>
        {meta ? <p dir="auto" className="text-xs text-muted-foreground">{meta}</p> : null}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {typeof citationCount === 'number' ? (
          <div className="text-xs text-muted-foreground" data-citation-count={formattedCitationCount}>
            {t('research.paper_digest.citations', { count: formattedCitationCount })}
          </div>
        ) : null}
        {abstractExcerpt ? (
          <p dir="auto" className="text-sm text-muted-foreground leading-relaxed">{abstractExcerpt}</p>
        ) : null}
        {keyFindings?.length ? (
          <div className="space-y-1">
            <h4 id={findingsId} className="text-xs font-medium text-muted-foreground">
              {t('research.paper_digest.key_findings')}
            </h4>
            <ul className="list-disc pl-4 space-y-1 text-sm" aria-labelledby={findingsId}>
              {keyFindings.map((finding) => (
                <li key={finding} dir="auto">{finding}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
