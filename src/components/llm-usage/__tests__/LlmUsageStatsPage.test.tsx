import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmUsageStatsPage } from '../LlmUsageStatsPage';

const {
  getSummaryMock,
  getTrendsMock,
  getByModelMock,
  getByCallerMock,
  getRecentMock,
  translateMock,
} = vi.hoisted(() => ({
  getSummaryMock: vi.fn(),
  getTrendsMock: vi.fn(),
  getByModelMock: vi.fn(),
  getByCallerMock: vi.fn(),
  getRecentMock: vi.fn(),
  translateMock: vi.fn((key: string) => {
    const dictionary: Record<string, string> = {
      title: 'LLM Usage',
      description: 'Usage analytics',
      'actions.refresh': 'Refresh',
      'summary.totalCalls': 'Total Calls',
      'summary.totalTokens': 'Total Tokens',
      'summary.promptTokens': 'Prompt Tokens',
      'summary.completionTokens': 'Completion Tokens',
      'summary.successRate': 'Success Rate',
      'summary.avgDuration': 'Avg Duration',
      'trends.title': 'Usage Trends',
      'byModel.title': 'By Model',
      'byModel.calls': 'Calls',
      'byCaller.title': 'By Caller',
      'byCaller.calls': 'Calls',
      'recent.title': 'Recent Calls',
      'recent.model': 'Model',
      'recent.provider': 'Provider',
      'recent.caller': 'Caller',
      'recent.tokens': 'Tokens',
      'recent.duration': 'Duration',
      'recent.status': 'Status',
      'recent.unknownProvider': 'Unknown',
      'empty.description': 'No data',
      'callerTypes.voice_input': 'Voice Input',
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
    getRecent: getRecentMock,
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
    data: Array<{ name: string; value: number }>;
  }) => <div data-testid="pie-data">{JSON.stringify(data)}</div>,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
}));

describe('LlmUsageStatsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses request counts for voice-capable distribution charts and shows duration in recent calls', async () => {
    getSummaryMock.mockResolvedValue({
      startDate: '2026-05-01',
      endDate: '2026-05-08',
      totalRequests: 2,
      successRequests: 2,
      errorRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      avgDurationMs: 1350,
    });
    getTrendsMock.mockResolvedValue([
      {
        timeLabel: '05-08',
        timestamp: 1,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        requestCount: 2,
      },
    ]);
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
    getRecentMock.mockResolvedValue([
      {
        id: 'voice-1',
        callerType: 'voice_input',
        modelId: 'TeleAI/TeleSpeechASR',
        providerId: 'siliconflow',
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        durationMs: 1350,
        success: true,
        createdAt: '2026-05-08T10:00:00.000Z',
      },
    ]);

    render(<LlmUsageStatsPage embedded />);

    await waitFor(() => {
      expect(getRecentMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getAllByText('1.4s').length).toBeGreaterThanOrEqual(2);
    });

    const piePayloads = screen.getAllByTestId('pie-data').map((node) => node.textContent ?? '');
    expect(piePayloads.some((payload) => payload.includes('"value":2'))).toBe(true);
  });

  it('shows a dash for success rate when there are no requests yet', async () => {
    getSummaryMock.mockResolvedValue({
      startDate: '2026-05-01',
      endDate: '2026-05-08',
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      avgDurationMs: undefined,
    });
    getTrendsMock.mockResolvedValue([]);
    getByModelMock.mockResolvedValue([]);
    getByCallerMock.mockResolvedValue([]);
    getRecentMock.mockResolvedValue([]);

    render(<LlmUsageStatsPage embedded />);

    await waitFor(() => {
      expect(getSummaryMock).toHaveBeenCalled();
    });

    expect(screen.getByText('Success Rate')).toBeInTheDocument();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('0 / 0')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });

  it('shows 0% instead of 0.0% when the ratio is a real zero', async () => {
    getSummaryMock.mockResolvedValue({
      startDate: '2026-05-01',
      endDate: '2026-05-08',
      totalRequests: 2,
      successRequests: 0,
      errorRequests: 2,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      avgDurationMs: 800,
    });
    getTrendsMock.mockResolvedValue([]);
    getByModelMock.mockResolvedValue([]);
    getByCallerMock.mockResolvedValue([]);
    getRecentMock.mockResolvedValue([]);

    render(<LlmUsageStatsPage embedded />);

    await waitFor(() => {
      expect(getSummaryMock).toHaveBeenCalled();
    });

    expect(screen.getByText('Success Rate')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('0 / 2')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
  });
});
