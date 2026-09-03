import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/features/chat/components/renderers/MarkdownRenderer';
import {
  parseResearchReportCitations,
  RESEARCH_REPORT_CITATION_PATTERN,
} from '../utils/parseResearchReportCitations';
import { sanitizeGenerativeMarkdown } from '../utils/sanitizeGenerativeMarkdown';

export const researchReportPropsSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(12000),
  density: z.enum(['compact', 'normal']).optional().default('normal'),
});

export type ResearchReportBlockProps = z.infer<typeof researchReportPropsSchema>;

interface MarkdownAstNode {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
}

const CITATION_CLASS =
  'mx-0.5 inline-flex items-center rounded-md border border-transparent bg-secondary px-2.5 py-0.5 align-baseline text-xs font-normal text-secondary-foreground';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function replaceResearchCitations(
  value: string,
  citationAriaLabel: (label: string) => string,
): MarkdownAstNode[] {
  const parts: MarkdownAstNode[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(RESEARCH_REPORT_CITATION_PATTERN.source, 'g');

  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    const fullMatch = match[0];
    parts.push({
      type: 'html',
      value: `<span class="${CITATION_CLASS}" role="note" data-citation="${escapeHtml(fullMatch)}" aria-label="${escapeHtml(citationAriaLabel(fullMatch))}">${escapeHtml(fullMatch)}</span>`,
    });
    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < value.length) {
    parts.push({ type: 'text', value: value.slice(lastIndex) });
  }

  return parts;
}

function createResearchCitationRemarkPlugin(citationAriaLabel: (label: string) => string) {
  return function researchCitationAttacher() {
    return function researchCitationTransformer(tree: MarkdownAstNode) {
      function visit(node: MarkdownAstNode): void {
        if (['code', 'inlineCode', 'math', 'inlineMath', 'html'].includes(node.type ?? '')) {
          return;
        }
        if (!node.children) return;

        const nextChildren: MarkdownAstNode[] = [];
        for (const child of node.children) {
          if (child.type === 'text' && child.value?.includes('[')) {
            nextChildren.push(...replaceResearchCitations(child.value, citationAriaLabel));
          } else {
            visit(child);
            nextChildren.push(child);
          }
        }
        node.children = nextChildren;
      }

      visit(tree);
    };
  };
}

export function ResearchReportBlock({ title, body, density }: ResearchReportBlockProps) {
  const { t } = useTranslation('generativeUi');
  const titleId = React.useId();
  const citationCount = useMemo(() => parseResearchReportCitations(body).length, [body]);
  const sanitizedBody = useMemo(() => sanitizeGenerativeMarkdown(body.trim()), [body]);
  const citationRemarkPlugins = useMemo(
    () => [
      createResearchCitationRemarkPlugin((label) =>
        t('research.report.citation_aria', { label }),
      ),
    ],
    [t],
  );

  return (
    <article
      className={cn('min-w-0 space-y-2 rounded-lg border border-border bg-card p-3', density === 'compact' && 'p-2')}
      data-generative-research-report
      data-citation-count={citationCount || undefined}
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : t('a11y.research_report_label')}
    >
      {title ? (
        <h4 id={titleId} dir="auto" className={cn('font-semibold', density === 'compact' ? 'text-sm' : 'text-base')}>{title}</h4>
      ) : null}
      <div
        dir="auto"
        className={cn(
          'text-muted-foreground leading-relaxed',
          density === 'compact' ? 'text-xs' : 'text-sm',
        )}
      >
        <MarkdownRenderer
          content={sanitizedBody}
          isStreaming={false}
          className={density === 'compact' ? 'text-xs' : 'text-sm'}
          extraRemarkPlugins={citationRemarkPlugins}
        />
      </div>
    </article>
  );
}
