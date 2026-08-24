/**
 * 从笔记元数据确定性构建摘要意图（只读 POC，无需 LLM）
 */

import type { GenerativeUIIntent } from '../types';

export interface NoteSummaryLabels {
  defaultTitle: string;
  updatedPrefix: string;
  headingStatTitle: string;
  overviewTitle: string;
  charCountKey: string;
  tagsKey: string;
  tagsEmpty: string;
  headingsTitle: string;
}

export interface NoteSummaryInput {
  title: string;
  tags?: string[];
  headingCount?: number;
  charCount?: number;
  updatedAtLabel?: string;
  topHeadings?: string[];
  labels: NoteSummaryLabels;
}

export function buildNoteSummaryIntent(input: NoteSummaryInput): GenerativeUIIntent {
  const tags = input.tags ?? [];
  const headings = input.topHeadings ?? [];
  const { labels } = input;

  return {
    version: '1',
    meta: {
      title: input.title || labels.defaultTitle,
      description: input.updatedAtLabel
        ? `${labels.updatedPrefix} ${input.updatedAtLabel}`
        : undefined,
    },
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: labels.headingStatTitle,
          value: input.headingCount ?? 0,
        },
      },
      {
        type: 'key-value-grid',
        props: {
          title: labels.overviewTitle,
          rows: [
            { key: labels.charCountKey, value: String(input.charCount ?? 0) },
            {
              key: labels.tagsKey,
              value: tags.length > 0 ? tags.join('、') : labels.tagsEmpty,
            },
          ],
        },
      },
      ...(headings.length > 0
        ? [
            {
              type: 'list' as const,
              props: {
                title: labels.headingsTitle,
                items: headings.slice(0, 5).map((label) => ({ label })),
              },
            },
          ]
        : []),
    ],
  };
}
