import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmUsageStatsSection } from '../LlmUsageStatsSection';

const {
  getSummaryMock,
  getTrendsMock,
  getByModelMock,
  getByCallerMock,
  translateMock,
} = vi.hoisted(() => ({
  getSummaryMock: vi.fn(),
  getTrendsMock: vi.fn(),
  getByModelMock: vi.fn(),
  getByCallerMock: vi.fn(),
  translateMock: vi.fn((key: string) => {
    const dictionary: Record<string, string> = {
      activity_trend: 'Activity Trends',
      model_distribution: 'Model Distribution',
      module_stats: 'Module Statistics',
      no_data: 'No Data',
      no_data_or_load_failed: 'No data or failed to load',
      unknown_model: 'Unknown Model',
      custom_config: 'Custom Config',
      sessions: 'Sessions',
      'summary.totalCalls': 'Total Calls',
      'summary.totalTokens': 'Total Tokens',
      'summary.successRate': 'Success Rate',
      'summary.avgDuration': 'Avg Duration',
      'summary.cumulativeRequests': 'Cumulative requests',
      'summary.perRequestAvg': 'Per request average',
      'summary.tokenBreakdown': 'Token Breakdown',
      'callerTypes.voice_input': 'Voice Input',
      'actions.retry': 'Retry',
    };
    return dictionary[key] ?? key;
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translateMock,
  }),
}));

vi.mock('../../../api/llmUsageApi', () => ({
  LlmUsageApi: {
    getSummary: getSummaryMock,
    getTrends: getTrendsMock,
    getByModel: getByModelMock,
    getByCaller: getByCallerMock,
  },
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({
    data,
  }: {
    data: Array<{ name: string; value: number; percent?: string | null }>;
  }) => <div data-testid="pie-data">{JSON.stringify(data)}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

describe('LlmUsageStatsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses request counts for voice-input distributions instead of token totals', async () => {
    getSummaryMock.mockResolvedValue({
      startDate: '2026-05-01',
      endDate: '2026-05-08',
      totalRequests: 2,
      successRequests: 2,
      errorRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      avgDurationMs: 1200,
    });
    getTrendsMock.mockResolvedValue([]);
    getByModelMock.mockResolvedValue([
      {
        modelId: 'TeleAI/TeleSpeechASR',
        requestCount: 2,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
      },
    ]);
    getByCallerMock.mockResolvedValue([
      {
        callerType: 'voice_input',
        displayName: 'Voice Input',
        requestCount: 2,
        totalTokens: 0,
      },
    ]);

    render(<LlmUsageStatsSection />);

    await waitFor(() => {
      expect(getByCallerMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('Voice Input')).toBeInTheDocument();
    expect(screen.getAllByText('100.0%').length).toBeGreaterThanOrEqual(2);
    const piePayloads = screen.getAllByTestId('pie-data').map((node) => node.textContent ?? '');
    expect(piePayloads.some((payload) => payload.includes('"value":2'))).toBe(true);
  });
});
