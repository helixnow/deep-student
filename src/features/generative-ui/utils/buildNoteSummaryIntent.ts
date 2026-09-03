/**
 * 从笔记元数据确定性构建摘要意图（只读 POC，无需 LLM）
 */

import type { GenerativeUIIntent } from '../types';
import { buildMarkdownIntent } from './buildMarkdownIntent';

export interface NoteSummaryLabels {
  defaultTitle: string;
  updatedPrefix: string;
  headingStatTitle: string;
  overviewTitle: string;
  charCountKey: string;
  tagsKey: string;
  tagsEmpty: string;
  headingsTitle: string;
  updatedAtKey?: string;
  emptyNoteTitle?: string;
  emptyNoteDescription?: string;
  emptyHeadings?: string;
  markdownOverviewTitle?: string;
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

function buildNoteOverviewMarkdown(input: NoteSummaryInput): string {
  const { labels } = input;
  const lines: string[] = [];
  const title = input.title.trim();
  if (title) {
    lines.push(`**${title}**`);
  }
  if (input.charCount != null) {
    lines.push(`- ${labels.charCountKey}: ${input.charCount}`);
  }
  if (input.updatedAtLabel) {
    lines.push(`- ${labels.updatedAtKey ?? labels.updatedPrefix}: ${input.updatedAtLabel}`);
  }
  const tags = input.tags ?? [];
  lines.push(`- ${labels.tagsKey}: ${tags.length > 0 ? tags.join('、') : labels.tagsEmpty}`);
  const headings = (input.topHeadings ?? []).slice(0, 5);
  if (headings.length > 0) {
    lines.push('');
    for (const heading of headings) {
      lines.push(`- ${heading.slice(0, 200)}`);
    }
  }
  return lines.join('\n').trim();
}

export function buildNoteSummaryIntent(input: NoteSummaryInput): GenerativeUIIntent {
  const tags = input.tags ?? [];
  const headings = input.topHeadings ?? [];
  const { labels } = input;
  const rows: Array<{ key: string; value: string }> = [];

  if (input.charCount != null) {
    rows.push({ key: labels.charCountKey, value: String(input.charCount) });
  }
  if (input.updatedAtLabel) {
    rows.push({
      key: labels.updatedAtKey ?? labels.updatedPrefix,
      value: input.updatedAtLabel,
    });
  }
  rows.push({
    key: labels.tagsKey,
    value: tags.length > 0 ? tags.join('、') : labels.tagsEmpty,
  });

  const isEmptyNote = (input.charCount ?? 0) === 0 && headings.length === 0;

  return {
    version: '1',
    meta: {
      title: input.title || labels.defaultTitle,
      description: input.updatedAtLabel
        ? `${labels.updatedPrefix} ${input.updatedAtLabel}`
        : undefined,
    },
    blocks: [
      ...(isEmptyNote
        ? [
            {
              type: 'alert' as const,
              props: {
                variant: 'info' as const,
                title: labels.emptyNoteTitle ?? labels.defaultTitle,
                description: labels.emptyNoteDescription,
              },
            },
          ]
        : []),
      {
        type: 'stat-card',
        props: {
          title: labels.headingStatTitle,
          value: input.headingCount ?? headings.length,
        },
      },
      {
        type: 'key-value-grid',
        props: {
          title: labels.overviewTitle,
          rows,
        },
      },
      ...buildMarkdownIntent({
        title: labels.markdownOverviewTitle ?? labels.overviewTitle,
        body: buildNoteOverviewMarkdown(input),
        variant: 'compact',
        labels: { empty: labels.emptyNoteDescription ?? labels.tagsEmpty },
      }).blocks,
      {
        type: 'list',
        props: {
          title: labels.headingsTitle,
          items: headings.slice(0, 5).map((label) => ({ label: label.slice(0, 200) })),
          emptyLabel: labels.emptyHeadings ?? labels.tagsEmpty,
        },
      },
    ],
  };
}
