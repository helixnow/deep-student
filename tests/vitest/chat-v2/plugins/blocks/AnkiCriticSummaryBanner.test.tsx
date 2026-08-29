/**
 * Chat V2 - AnkiCriticSummaryBanner（AI 质检终审任务级摘要横幅）测试
 *
 * 覆盖点：
 * - 无数据 / 非对象 / 全零且未降级 → 不渲染
 * - 正常摘要句（examined/kept/revised/flagged 插值）
 * - skippedOverBudget / goldReferences / persistFailures 明细行按需出现
 * - degraded 态：展示降级说明、不展示统计句、data-degraded 标记
 * - wire 格式兼容：snake_case（后端事件）与 camelCase 均可解析
 *
 * 注意：本文件按任务要求「只写不跑」，未在本轮执行。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import {
  AnkiCriticSummaryBanner,
  parseAnkiCriticSummary,
} from '@/features/chat/plugins/blocks/components/AnkiCriticSummaryBanner';

// Mock i18n：支持 {{var}} 插值，未知 key 回退 key 本身
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'agent.critic.title': 'AI final review',
        'agent.critic.summary':
          'Reviewed {{examined}} cards: {{kept}} kept, {{revised}} revised, {{flagged}} flagged',
        'agent.critic.skippedOverBudget':
          '{{count}} cards were skipped due to the review budget',
        'agent.critic.goldReferences':
          'This review referenced {{count}} gold-standard card pairs',
        'agent.critic.degraded':
          'AI final review was unavailable; this batch was kept as-is without review',
        'agent.critic.persistFailures':
          '{{count}} card revisions from the final review failed to write back; what you see may differ from the saved version',
      };
      const template = dict[key];
      if (!template) return key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(options?.[name] ?? ''),
      );
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

describe('parseAnkiCriticSummary', () => {
  it('returns null for missing / non-object / array input', () => {
    expect(parseAnkiCriticSummary(undefined)).toBeNull();
    expect(parseAnkiCriticSummary(null)).toBeNull();
    expect(parseAnkiCriticSummary('x')).toBeNull();
    expect(parseAnkiCriticSummary(42)).toBeNull();
    expect(parseAnkiCriticSummary([{ examined: 3 }])).toBeNull();
  });

  it('returns null when there is no signal (all zeros, not degraded)', () => {
    expect(
      parseAnkiCriticSummary({ examined: 0, kept: 0, revised: 0, flagged: 0, degraded: null }),
    ).toBeNull();
    expect(parseAnkiCriticSummary({})).toBeNull();
    // 空白 degraded 字符串不算降级信号
    expect(parseAnkiCriticSummary({ degraded: '   ' })).toBeNull();
  });

  it('parses snake_case wire format from the backend event', () => {
    const parsed = parseAnkiCriticSummary({
      examined: 10,
      kept: 6,
      revised: 3,
      flagged: 1,
      skipped_over_budget: 2,
      gold_references: 4,
      persist_failures: 1,
      degraded: null,
    });
    expect(parsed).toEqual({
      examined: 10,
      kept: 6,
      revised: 3,
      flagged: 1,
      skippedOverBudget: 2,
      goldReferences: 4,
      persistFailures: 1,
      degraded: null,
    });
  });

  it('parses camelCase input identically', () => {
    const parsed = parseAnkiCriticSummary({
      examined: 5,
      kept: 5,
      skippedOverBudget: 1,
      goldReferences: 2,
      persistFailures: 0,
    });
    expect(parsed?.skippedOverBudget).toBe(1);
    expect(parsed?.goldReferences).toBe(2);
    expect(parsed?.persistFailures).toBe(0);
  });

  it('sanitizes invalid counts (negative / NaN / non-number) to 0', () => {
    const parsed = parseAnkiCriticSummary({
      examined: 3,
      kept: -2,
      revised: Number.NaN,
      flagged: 'many',
      skipped_over_budget: null,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kept).toBe(0);
    expect(parsed?.revised).toBe(0);
    expect(parsed?.flagged).toBe(0);
    expect(parsed?.skippedOverBudget).toBe(0);
  });

  it('treats a non-empty degraded string as a signal even with zero counts', () => {
    const parsed = parseAnkiCriticSummary({ degraded: 'model timeout' });
    expect(parsed?.degraded).toBe('model timeout');
    expect(parsed?.examined).toBe(0);
  });
});

describe('AnkiCriticSummaryBanner', () => {
  it('renders nothing without data', () => {
    const { container } = render(<AnkiCriticSummaryBanner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('chatanki-critic-summary')).toBeNull();
  });

  it('renders nothing for a zero summary', () => {
    render(<AnkiCriticSummaryBanner criticSummary={{ examined: 0, degraded: null }} />);
    expect(screen.queryByTestId('chatanki-critic-summary')).toBeNull();
  });

  it('renders the summary sentence with interpolated counts', () => {
    render(
      <AnkiCriticSummaryBanner
        criticSummary={{ examined: 10, kept: 6, revised: 3, flagged: 1 }}
      />,
    );
    expect(screen.getByTestId('chatanki-critic-summary')).toHaveAttribute(
      'data-degraded',
      'false',
    );
    expect(screen.getByText('AI final review')).toBeInTheDocument();
    expect(screen.getByTestId('chatanki-critic-sentence')).toHaveTextContent(
      'Reviewed 10 cards: 6 kept, 3 revised, 1 flagged',
    );
    // 无跳过/金标/写回失败时不出现对应明细行
    expect(screen.queryByTestId('chatanki-critic-skipped')).toBeNull();
    expect(screen.queryByTestId('chatanki-critic-gold')).toBeNull();
    expect(screen.queryByTestId('chatanki-critic-persist-failures')).toBeNull();
  });

  it('renders skipped / gold / persist-failure detail lines when present', () => {
    render(
      <AnkiCriticSummaryBanner
        criticSummary={{
          examined: 8,
          kept: 8,
          skipped_over_budget: 2,
          gold_references: 3,
          persist_failures: 1,
        }}
      />,
    );
    expect(screen.getByTestId('chatanki-critic-skipped')).toHaveTextContent(
      '2 cards were skipped due to the review budget',
    );
    expect(screen.getByTestId('chatanki-critic-gold')).toHaveTextContent(
      'This review referenced 3 gold-standard card pairs',
    );
    expect(screen.getByTestId('chatanki-critic-persist-failures')).toHaveTextContent(
      '1 card revisions from the final review failed to write back',
    );
  });

  it('renders the degraded notice instead of the stats sentence when degraded', () => {
    render(
      <AnkiCriticSummaryBanner
        criticSummary={{ examined: 0, degraded: 'model timeout' }}
      />,
    );
    expect(screen.getByTestId('chatanki-critic-summary')).toHaveAttribute(
      'data-degraded',
      'true',
    );
    expect(screen.getByTestId('chatanki-critic-degraded')).toHaveTextContent(
      'AI final review was unavailable',
    );
    expect(screen.queryByTestId('chatanki-critic-sentence')).toBeNull();
  });
});
