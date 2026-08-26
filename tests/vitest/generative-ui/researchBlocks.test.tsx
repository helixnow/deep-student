import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { buildPaperDigestIntent } from '@/features/generative-ui/utils/buildPaperDigestIntent';
import { buildResearchPlanIntent } from '@/features/generative-ui/utils/buildResearchPlanIntent';
import { ResearchReportBlock } from '@/features/generative-ui/components/ResearchReportBlock';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { generativeUIRegistry } from '@/features/generative-ui/registry';
import { generativeUIIntentSchema, validateBlockProps } from '@/features/generative-ui/schema';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'research.paper_digest.key_findings': '关键发现',
        'research.paper_digest.citations': `引用 ${params?.count ?? 0} 处`,
        'research.plan.round': `第 ${params?.round ?? 0} 轮`,
        'research.plan.progress': `已完成 ${params?.done ?? 0} / ${params?.total ?? 0} 步`,
        parse_error_title: '解析失败',
        unknown_block_title: '未知',
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

import '@/features/generative-ui/blocks';

describe('Research generative-ui blocks POC', () => {
  it('registers paper-digest and research-plan block types', () => {
    expect(generativeUIRegistry.has('paper-digest')).toBe(true);
    expect(generativeUIRegistry.has('research-plan')).toBe(true);
  });

  it('buildPaperDigestIntent renders through GenerativeUIRenderer', () => {
    const intent = buildPaperDigestIntent({
      title: 'Attention Is All You Need',
      authors: 'Vaswani et al.',
      venue: 'NeurIPS',
      year: 2017,
      citationLabel: '[paper-1]',
      citationCount: 3,
      keyFindings: ['Transformer 架构', 'Self-attention 机制'],
      labels: { metaTitle: '论文摘要', findingsStatTitle: '要点数' },
    });
    const parsed = generativeUIIntentSchema.safeParse(intent);
    expect(parsed.success).toBe(true);

    render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
    expect(document.querySelector('[data-generative-paper-digest]')).toBeTruthy();
    expect(screen.getByText('Transformer 架构')).toBeInTheDocument();
    expect(screen.getByText('[paper-1]')).toBeInTheDocument();
  });

  it('buildResearchPlanIntent renders plan steps with progress', () => {
    const intent = buildResearchPlanIntent({
      title: '检索与综合',
      round: 2,
      steps: [
        { label: '生成检索 query', status: 'done' },
        { label: '候选排序', status: 'active' },
        { label: '综合报告', status: 'pending' },
      ],
      labels: { metaTitle: '研究计划', roundLabel: '第' },
    });

    for (const block of intent.blocks) {
      const config = generativeUIRegistry.get(block.type);
      expect(config).toBeDefined();
      const validation = validateBlockProps(config!.propsSchema, block.props ?? {});
      expect(validation.ok).toBe(true);
    }

    render(<GenerativeUIRenderer intent={intent} showChrome={false} />);
    expect(document.querySelector('[data-generative-research-plan]')).toBeTruthy();
    expect(screen.getByText('生成检索 query')).toBeInTheDocument();
    expect(screen.getByText('第 2 轮')).toBeInTheDocument();
  });

  it('marks research-report citations as notes, not fake links', () => {
    render(<ResearchReportBlock body="结论见 [paper-1]。" />);

    const badge = document.querySelector('[data-citation]');
    expect(badge).toBeTruthy();
    expect(badge).toHaveTextContent('[paper-1]');
    expect(badge).toHaveAttribute('role', 'note');
    expect(badge).not.toHaveAttribute('tabIndex');
    expect(badge).toHaveAttribute('data-citation', '[paper-1]');
  });

  it('renders research-report Markdown through the shared renderer', () => {
    const { container } = render(
      <ResearchReportBlock body={'## 综合结论\n\n证据支持 **多模态融合** [paper-1]。'} />,
    );

    expect(screen.getByRole('heading', { name: '综合结论' })).toBeInTheDocument();
    expect(container.querySelector('strong')).toHaveTextContent('多模态融合');
    expect(container.querySelector('.markdown-content')).toBeTruthy();
    expect(container.querySelector('[data-citation="[paper-1]"]')).toHaveAttribute('role', 'note');
  });
});
