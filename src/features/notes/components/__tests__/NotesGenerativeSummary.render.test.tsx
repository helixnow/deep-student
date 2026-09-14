import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NotesGenerativeSummary } from '../NotesGenerativeSummary';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, d?: unknown) => {
        if (typeof d === 'string') return d;
        if (d && typeof d === 'object' && 'defaultValue' in d) {
          const v = (d as { defaultValue?: string }).defaultValue;
          if (typeof v === 'string') return v;
        }
        // Return Chinese error key text only if asked — so we can detect crashes.
        if (k === 'generativeUi:blocks.markdown.error' || k === 'blocks.markdown.error') {
          return '正文渲染失败';
        }
        return k;
      },
      i18n: { language: 'zh-CN' },
    }),
  };
});

describe('NotesGenerativeSummary render', () => {
  it('does not show 正文渲染失败 for normal note content', () => {
    const { container } = render(
      <NotesGenerativeSummary
        title="光合作用"
        tags={['生物']}
        content={'# 概览\n\n叶绿体把光能转成化学能。'}
        headingLabels={['概览']}
        updatedAt="2026-09-14T00:00:00.000Z"
      />,
    );
    expect(container.querySelectorAll('[data-generative-error-boundary]')).toHaveLength(0);
    expect(container.textContent ?? '').not.toContain('正文渲染失败');
    expect(container.querySelector('[data-generative-markdown-body]')).toBeTruthy();
  });
});
