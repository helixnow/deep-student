/**
 * Generative UI a11y contract — 18 内置块 landmark / progressbar / alert / live region
 * + [data-generative-ui] 内 button/a/[tabindex] 的 :focus-visible ring token
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { GenerativeUIRenderer } from '@/features/generative-ui';
import {
  ALL_BLOCK_TYPES,
  buildAllBlocksIntent,
  buildSingleBlockIntent,
} from '@/features/generative-ui/demo/allBlocksFixture';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        parse_error_title: '无法解析 AI 界面意图',
        parse_error_invalid: '格式无效',
        unknown_block_title: `未知：${params?.type ?? ''}`,
        unknown_block_desc: '跳过',
        validation_failed_title: '校验失败',
        'chrome.accept': '接受',
        'chrome.regenerate': '重新生成',
        'chrome.dismiss': '忽略',
        'chrome.streaming': '生成中…',
        'action.unregistered_hint': '未注册',
        'action.confirm_title': `确认：${params?.label ?? ''}`,
        'action.confirm_desc': '确认描述',
        'action.confirm_execute': '确认执行',
        'a11y.region_label': 'AI 生成界面',
        'a11y.action_bar_label': '操作栏',
        'a11y.list_label': '列表',
        'a11y.text_label': '文本',
        'a11y.progress_label': '进度',
        'a11y.key_value_label': '键值信息',
        'a11y.flashcard_front': '闪卡正面',
        'a11y.flashcard_back': '闪卡背面',
        'a11y.mindmap_label': '思维导图',
        'a11y.research_report_label': '研究报告',
        'a11y.review_day': `${params?.date ?? ''}，待复习 ${params?.due ?? 0} 项`,
        'a11y.step_pending': '未开始',
        'a11y.step_active': '进行中',
        'a11y.step_done': '已完成',
        'a11y.step_error': '失败',
        'a11y.step_skipped': '已跳过',
        'a11y.markdown_label': 'Markdown 正文',
        'a11y.chart_label': `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim(),
        'a11y.chart_empty': '暂无图表数据',
        'a11y.steps_label': '步骤',
        'a11y.table_label': '表格',
        'a11y.table_caption': '数据表',
        'blocks.chart.a11y_label': `${params?.title ?? ''} ${params?.kind ?? ''} 图表`.trim(),
        'blocks.steps.status_pending': '待开始',
        'blocks.steps.status_active': '进行中',
        'blocks.steps.status_done': '已完成',
        'blocks.steps.status_error': '失败',
        'blocks.steps.status_skipped': '已跳过',
        'blocks.table.empty': '暂无数据',
        'blocks.markdown.empty': '暂无正文',
        'flashcard.preview_title': '闪卡预览',
        'flashcard.front': '正面',
        'flashcard.back': '背面',
        'review_calendar.default_title': '复习日历',
        'review_calendar.due': `待复习 ${params?.count ?? 0}`,
        'review_calendar.completed': `已完成 ${params?.count ?? 0}`,
        'mistake.error_rate': `错误率 ${params?.rate ?? 0}%`,
        'research.paper_digest.key_findings': '关键发现',
        'research.plan.progress': `已完成 ${params?.done ?? 0} / ${params?.total ?? 0} 步`,
        'research.report.citation_aria': `引用 ${params?.label ?? ''}`,
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/features/mindmap/components/mindmap/MindMapEmbed', () => ({
  MindMapEmbed: () => <div data-testid="mindmap-embed-mock" />,
}));

import '@/features/generative-ui/blocks';

const REQUIRED_FOURTEEN = [
  'stat-card',
  'alert',
  'list',
  'progress',
  'action-bar',
  'text',
  'key-value-grid',
  'flashcard-preview',
  'review-calendar',
  'mistake-analysis',
  'mindmap-embed',
  'paper-digest',
  'research-plan',
  'research-report',
] as const;

const REQUIRED_EIGHTEEN = [
  ...REQUIRED_FOURTEEN,
  'markdown',
  'chart',
  'steps',
  'table',
] as const;

describe('generativeUIA11y.contract', () => {
  it('covers the 14 built-in block types from the fixture', () => {
    for (const type of REQUIRED_FOURTEEN) {
      expect(ALL_BLOCK_TYPES).toContain(type);
    }
  });

  it('covers the 18 built-in block types from the fixture', () => {
    expect(ALL_BLOCK_TYPES).toHaveLength(18);
    for (const type of REQUIRED_EIGHTEEN) {
      expect(ALL_BLOCK_TYPES).toContain(type);
    }
  });

  it('renderer root is a labelled region', () => {
    render(<GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />);
    const root = document.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('role', 'region');
    expect(root).toHaveAttribute('aria-label', 'AI 生成界面');
  });

  it('puts dir="auto" on renderer meta and action display labels', () => {
    render(
      <GenerativeUIRenderer
        intent={{
          version: '1.1',
          meta: {
            title: 'Study סיכום',
            description: 'Review مرحبا',
          },
          blocks: [
            {
              type: 'action-bar',
              props: {
                actions: [{ id: 'open-review', label: 'Open مراجعة' }],
              },
            },
          ],
        }}
        showChrome={false}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Study סיכום' })).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Review مرحبا')).toHaveAttribute('dir', 'auto');
    const action = screen.getByRole('button', { name: 'Open مراجعة' });
    expect(action.querySelector('span')).toHaveAttribute('dir', 'auto');
  });

  it('sets aria-busy and chrome live region while streaming', () => {
    render(<GenerativeUIRenderer intent={buildAllBlocksIntent()} isStreaming showChrome />);
    const root = document.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('aria-busy', 'true');
    const live = document.querySelector('[data-generative-ui-chrome] [aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live).toHaveTextContent('生成中…');
    expect(document.querySelector('[data-generative-ui-chrome]')).toHaveAttribute('aria-busy', 'true');
  });

  it('parse error uses role=alert', () => {
    render(<GenerativeUIRenderer intent="{ bad json" showChrome={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('无法解析 AI 界面意图');
  });

  it('all-blocks fixture exposes progressbar, region, alert, toolbar, article', () => {
    render(<GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />);

    const bars = screen.getAllByRole('progressbar');
    expect(bars.length).toBeGreaterThanOrEqual(1);
    for (const bar of bars) {
      expect(bar).toHaveAttribute('aria-valuenow');
      expect(bar).toHaveAttribute('aria-valuemin');
      expect(bar).toHaveAttribute('aria-valuemax');
    }

    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('toolbar', { name: '操作栏' })).toBeInTheDocument();
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '闪卡预览' })).toBeInTheDocument();
    expect(screen.getByRole('note', { name: '引用 [paper-1]' })).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label');
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-steps] [aria-current="step"]')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '说明' })).toBeInTheDocument();
  });

  it.each(REQUIRED_EIGHTEEN)('block "%s" renders required aria', (blockType) => {
    const { container } = render(
      <GenerativeUIRenderer intent={buildSingleBlockIntent(blockType)} showChrome={false} />,
    );
    const root = container.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('role', 'region');
    expect(root).toHaveAttribute('aria-label', 'AI 生成界面');

    if (blockType === 'progress' || blockType === 'research-plan') {
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow');
      expect(bar).toHaveAttribute('aria-valuemin');
      expect(bar).toHaveAttribute('aria-valuemax');
    }

    if (blockType === 'alert' || blockType === 'mistake-analysis') {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    }

    if (blockType === 'list' || blockType === 'review-calendar') {
      expect(screen.getByRole('list')).toBeInTheDocument();
    }

    if (blockType === 'review-calendar') {
      const timeEl = container.querySelector('time');
      expect(timeEl).toBeTruthy();
      expect(timeEl).toHaveAttribute('datetime', '2026-08-24');
    }

    if (blockType === 'action-bar') {
      expect(screen.getByRole('toolbar', { name: '操作栏' })).toBeInTheDocument();
    }

    if (blockType === 'flashcard-preview') {
      expect(screen.getByRole('region', { name: '闪卡预览' })).toBeInTheDocument();
      expect(screen.getByLabelText('闪卡正面')).toBeInTheDocument();
      expect(screen.getByLabelText('闪卡背面')).toBeInTheDocument();
    }

    if (blockType === 'research-report') {
      expect(screen.getByRole('article')).toBeInTheDocument();
      expect(screen.getByRole('note', { name: '引用 [paper-1]' })).not.toHaveAttribute('tabindex');
    }

    if (blockType === 'stat-card') {
      expect(screen.getByRole('region', { name: '指标' })).toBeInTheDocument();
    }

    if (blockType === 'mindmap-embed') {
      expect(screen.getByRole('heading', { name: '导图' })).toBeInTheDocument();
    }

    if (blockType === 'text') {
      expect(screen.getByRole('region', { name: '文本' })).toBeInTheDocument();
    }

    if (blockType === 'key-value-grid') {
      expect(screen.getByRole('region', { name: '键值信息' })).toBeInTheDocument();
    }

    if (blockType === 'paper-digest') {
      expect(screen.getByRole('region', { name: '论文标题' })).toBeInTheDocument();
      expect(screen.getByRole('list')).toBeInTheDocument();
    }

    if (blockType === 'markdown') {
      expect(screen.getByRole('region', { name: '说明' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '说明' })).toBeInTheDocument();
    }

    if (blockType === 'chart') {
      expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('复习量'));
    }

    if (blockType === 'steps') {
      expect(screen.getByRole('list')).toBeInTheDocument();
      const current = container.querySelector('[aria-current="step"]');
      expect(current).toBeTruthy();
      expect(current?.tagName).toBe('LI');
      expect(container.querySelector('[data-generative-steps] .sr-only')).toHaveTextContent('进行中');
    }

    if (blockType === 'table') {
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(container.querySelector('caption')).toBeTruthy();
      for (const header of screen.getAllByRole('columnheader')) {
        expect(header).toHaveAttribute('scope', 'col');
      }
    }
  });

  it('ships :focus-visible semantic ring token for button/a/[tabindex]', () => {
    const css = fs.readFileSync(
      path.join(process.cwd(), 'src/features/generative-ui/generative-ui.css'),
      'utf8',
    );
    expect(css).toContain('[data-generative-ui]');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('--ring');
    expect(css).toMatch(/\[data-generative-ui\]\s+:is\(button,\s*a,\s*\[tabindex\]\):focus-visible/);
    expect(css).toMatch(/hsl\(\s*var\(\s*--ring\s*\)\s*\)/);
    expect(css).not.toMatch(/:focus-visible[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);
    expect(css).not.toMatch(/:focus-visible[^{]*\{[^}]*(?:#0000ff|#0066ff|#3b82f6|rgb\(\s*0\s*,\s*0\s*,\s*255)/i);
  });
});
