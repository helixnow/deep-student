import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  parseResearchReportCitations,
  countResearchReportCitations,
} from '@/features/generative-ui/utils/parseResearchReportCitations';
import { buildResearchReportIntent } from '@/features/generative-ui/utils/buildResearchReportIntent';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'research.report.citation_aria') return `引用 ${params?.label ?? ''}`;
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import '@/features/generative-ui/blocks';

describe('parseResearchReportCitations', () => {
  it('parses [type-N] citation markers', () => {
    const text = '结论基于 [paper-1] 与 [web-2] 的证据。';
    const citations = parseResearchReportCitations(text);
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ typeText: 'paper', index: 1, fullMatch: '[paper-1]' });
    expect(citations[1]).toMatchObject({ typeText: 'web', index: 2, fullMatch: '[web-2]' });
  });

  it('counts citations in body', () => {
    expect(countResearchReportCitations('见 [paper-1] 和 [paper-2]')).toBe(2);
  });
});

describe('research-report block E2E', () => {
  it('renders body with citation badges through GenerativeUIRenderer', () => {
    const intent = buildResearchReportIntent({
      title: '综合结论',
      body: 'Transformer 在 NLP 任务表现优异 [paper-1]，后续工作扩展至多模态 [web-3]。',
      labels: { metaTitle: '研究报告', citationStatTitle: '引用数' },
    });

    render(<GenerativeUIRenderer intent={intent} showChrome={false} />);

    const report = document.querySelector('[data-generative-research-report]');
    expect(report).toBeTruthy();
    expect(report?.getAttribute('data-citation-count')).toBe('2');
    expect(report?.querySelector('h4')).toHaveAttribute('dir', 'auto');
    expect(report?.children.item(1)).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('[paper-1]')).toBeInTheDocument();
    expect(screen.getByText('[web-3]')).toBeInTheDocument();
    expect(screen.getByText('引用数')).toBeInTheDocument();
  });

  it('supports partial streaming body (incomplete citation tail)', () => {
    const partialIntent = {
      version: '1' as const,
      blocks: [
        {
          type: 'research-report',
          props: {
            body: '正在生成报告… 参考 [paper-1] 与 [web-',
          },
        },
      ],
    };

    render(<GenerativeUIRenderer intent={partialIntent} isStreaming showChrome={false} />);
    expect(screen.getByText('[paper-1]')).toBeInTheDocument();
    expect(screen.getByText(/\[web-$/)).toBeInTheDocument();
  });
});
