/**
 * 从笔记元数据确定性构建摘要意图（只读 POC，无需 LLM）
 */

import type { GenerativeUIIntent } from '../types';

export interface NoteSummaryInput {
  title: string;
  tags?: string[];
  headingCount?: number;
  charCount?: number;
  updatedAtLabel?: string;
  topHeadings?: string[];
}

export function buildNoteSummaryIntent(input: NoteSummaryInput): GenerativeUIIntent {
  const tags = input.tags ?? [];
  const headings = input.topHeadings ?? [];

  return {
    version: '1',
    meta: {
      title: input.title || '笔记摘要',
      description: input.updatedAtLabel ? `更新于 ${input.updatedAtLabel}` : undefined,
    },
    blocks: [
      {
        type: 'stat-card',
        props: {
          title: '章节数',
          value: input.headingCount ?? 0,
        },
      },
      {
        type: 'key-value-grid',
        props: {
          title: '概览',
          rows: [
            { key: '字符数', value: String(input.charCount ?? 0) },
            { key: '标签', value: tags.length > 0 ? tags.join('、') : '—' },
          ],
        },
      },
      ...(headings.length > 0
        ? [
            {
              type: 'list' as const,
              props: {
                title: '主要章节',
                items: headings.slice(0, 5).map((label) => ({ label })),
              },
            },
          ]
        : []),
    ],
  };
}
