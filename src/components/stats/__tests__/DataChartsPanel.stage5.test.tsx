import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import enLlmUsage from '@/locales/en-US/llm_usage.json';

const mockGetSummary = vi.hoisted(() => vi.fn());
const mockGetTrends = vi.hoisted(() => vi.fn());
const mockGetByModel = vi.hoisted(() => vi.fn());
const mockGetByCaller = vi.hoisted(() => vi.fn());

vi.mock('@/api/llmUsageApi', () => ({
  LlmUsageApi: {
    getSummary: mockGetSummary,
    getTrends: mockGetTrends,
    getByModel: mockGetByModel,
    getByCaller: mockGetByCaller,
  },
}));

const stableChatStats = {
  loading: false,
  totalSessions: 4,
  activeSessions: 3,
  archivedSessions: 1,
  totalMessages: 20,
  userMessages: 10,
  assistantMessages: 10,
  recentSessions: 4,
  avgMessagesPerSession: 5,
  dailyActivity: [{ date: '2026-11-24', sessions: 2, messages: 8 }],
  refresh: vi.fn(),
};

vi.mock('@/hooks/useChatV2Stats', () => ({
  useChatV2Stats: () => stableChatStats,
}));

vi.mock('@/hooks/useRefreshOnReturn', () => ({
  useRefreshOnReturn: vi.fn(),
}));

vi.mock('@/components/LearningHeatmap', () => ({
  LearningHeatmap: () => <div data-testid="mock-learning-heatmap">Heatmap</div>,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-recharts-container">{children}</div>
  ),
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const stableT = (key: string) => {
  if (key.startsWith('llm_usage:')) {
    const subKey = key.slice('llm_usage:'.length);
    const parts = subKey.split('.');
    let cur: unknown = enLlmUsage;
    for (const p of parts) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[p] : undefined;
    }
    if (typeof cur === 'string') return cur;
  }
  return key;
};
const stableI18n = { language: 'en-US', changeLanguage: () => Promise.resolve() };
const stableTranslationResult = { t: stableT, i18n: stableI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => stableTranslationResult,
}));

import { DataChartsPanel } from '@/components/stats/DataChartsPanel';

describe('DataChartsPanel Stage 5 regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSummary.mockResolvedValue({
      totalRequests: 4,
      successRequests: 4,
      failedRequests: 0,
      totalTokens: 1200,
      avgDurationMs: 250,
    });
    mockGetTrends.mockResolvedValue([
      { timeLabel: '2026-11-24', totalTokens: 1200, requestCount: 4 },
    ]);
    mockGetByModel.mockResolvedValue([
      { modelId: 'gpt-4o-mini', displayName: 'GPT-4o mini', requestCount: 4, totalTokens: 1200 },
    ]);
    mockGetByCaller.mockResolvedValue([
      {
        callerType: 'embedding',
        displayName: '文本嵌入',
        requestCount: 4,
        totalTokens: 1200,
      },
    ]);
  });

  it('localizes caller display names in en-US instead of leaking Chinese 文本嵌入 and keeps whitespace between value and percent', async () => {
    render(<DataChartsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Embedding')).toBeInTheDocument();
    });

    expect(screen.queryByText('文本嵌入')).not.toBeInTheDocument();
    // Row and BarList should have space separating numeric value and percentage
    expect(document.body.textContent).not.toContain('4100.0%');
    expect(document.body.textContent).not.toContain('100.0%4 / 4');
    expect(document.body.textContent).toContain('4 100.0%');
  });

  it('defers TrendChart and LearningHeatmap mount until requestAnimationFrame with skeleton fallback', async () => {
    let rafCallback: FrameRequestCallback | null = null;
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        rafCallback = cb;
        return 1;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    try {
      render(<DataChartsPanel />);

      await waitFor(() => {
        expect(screen.getByTestId('trend-chart-skeleton')).toBeInTheDocument();
        expect(screen.getByTestId('heatmap-chart-skeleton')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('mock-learning-heatmap')).not.toBeInTheDocument();

      await act(async () => {
        rafCallback?.(16);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mock-learning-heatmap')).toBeInTheDocument();
        expect(screen.getByTestId('mock-recharts-container')).toBeInTheDocument();
      });
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });
});
