/**
 * 研究报告 — 流式 markdown 正文 + [type-N] 引用（Research/Translation #7 POC）
 */

import type { GenerativeUIIntent } from '../types';
import { countResearchReportCitations } from './parseResearchReportCitations';

export interface ResearchReportLabels {
  metaTitle: string;
  citationStatTitle: string;
}

export interface ResearchReportInput {
  title?: string;
  body: string;
  labels: ResearchReportLabels;
}

export function buildResearchReportIntent(input: ResearchReportInput): GenerativeUIIntent {
  const citationCount = countResearchReportCitations(input.body);

  return {
    version: '1',
    meta: {
      title: input.labels.metaTitle,
      description: input.title,
    },
    blocks: [
      ...(citationCount > 0
        ? [
            {
              type: 'stat-card' as const,
              props: {
                title: input.labels.citationStatTitle,
                value: citationCount,
              },
            },
          ]
        : []),
      {
        type: 'research-report',
        props: {
          title: input.title,
          body: input.body,
        },
      },
    ],
  };
}
