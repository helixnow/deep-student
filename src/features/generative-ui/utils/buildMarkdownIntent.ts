/**
 * Markdown 正文块 — 确定性意图构建（截断超长 body，trim 空白）
 */

import type { GenerativeUIIntent } from '../types';
import { MARKDOWN_BODY_MAX, MARKDOWN_TITLE_MAX } from '../components/MarkdownBlock';

export interface MarkdownIntentLabels {
  empty: string;
}

export interface MarkdownIntentInput {
  title?: string;
  body: string;
  variant?: 'default' | 'compact';
  labels?: MarkdownIntentLabels;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function buildMarkdownIntent(input: MarkdownIntentInput): GenerativeUIIntent {
  const titleRaw = input.title?.trim();
  const title = titleRaw ? truncate(titleRaw, MARKDOWN_TITLE_MAX) : undefined;

  let body = truncate(input.body.trim(), MARKDOWN_BODY_MAX);
  if (!body) {
    const fallback = input.labels?.empty?.trim();
    body = fallback ? truncate(fallback, MARKDOWN_BODY_MAX) : '—';
  }

  return {
    version: '1',
    blocks: [
      {
        type: 'markdown',
        props: {
          ...(title ? { title } : {}),
          body,
          ...(input.variant ? { variant: input.variant } : {}),
        },
      },
    ],
  };
}
