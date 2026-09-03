/**
 * 论文摘要 digest — 确定性意图构建（Research POC）
 */

import type { GenerativeUIIntent } from '../types';

export interface PaperDigestLabels {
  metaTitle: string;
  findingsStatTitle: string;
}

export interface PaperDigestInput {
  title: string;
  authors?: string;
  venue?: string;
  year?: number;
  citationLabel?: string;
  citationCount?: number;
  keyFindings?: string[];
  abstractExcerpt?: string;
  labels: PaperDigestLabels;
}

export function buildPaperDigestIntent(input: PaperDigestInput): GenerativeUIIntent {
  const findingsCount = input.keyFindings?.length ?? 0;

  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description: input.title,
    },
    blocks: [
      ...(findingsCount > 0
        ? [
            {
              type: 'stat-card' as const,
              props: {
                title: input.labels.findingsStatTitle,
                value: findingsCount,
              },
            },
          ]
        : []),
      {
        type: 'paper-digest',
        props: {
          title: input.title,
          authors: input.authors,
          venue: input.venue,
          year: input.year,
          citationLabel: input.citationLabel,
          citationCount: input.citationCount,
          keyFindings: input.keyFindings,
          abstractExcerpt: input.abstractExcerpt,
        },
      },
    ],
  };
}
