/**
 * Generative UI a11y contract — 14 内置块 landmark / progressbar / alert / live region
 */
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

describe('generativeUIA11y.contract', () => {
  it('covers the 14 built-in block types from the fixture', () => {
    for (const type of REQUIRED_FOURTEEN) {
      expect(ALL_BLOCK_TYPES).toContain(type);
    }
  });

  it('renderer root is a labelled region', () => {
    render(<GenerativeUIRenderer intent={buildAllBlocksIntent()} showChrome={false} />);
    const root = document.querySelector('[data-generative-ui]');
    expect(root).toHaveAttribute('role', 'region');
    expect(root).toHaveAttribute('aria-label', 'AI 生成界面');
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
    expect(screen.getByRole('link', { name: '引用 [paper-1]' })).toHaveAttribute('tabindex', '0');
  });

  it.each(REQUIRED_FOURTEEN)('block "%s" renders required aria', (blockType) => {
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
      expect(screen.getByRole('link', { name: '引用 [paper-1]' })).toHaveAttribute('tabindex', '0');
    }

    if (blockType === 'stat-card') {
      expect(screen.getByRole('region', { name: '指标' })).toBeInTheDocument();
    }

    if (blockType === 'mindmap-embed') {
      expect(screen.getByRole('heading', { name: '导图' })).toBeInTheDocument();
    }
  });
});
