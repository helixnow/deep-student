import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'statistics.due': '当前到期',
      'statistics.learning': '学习中',
      'statistics.loadFailed': '统计加载失败',
      'statistics.loading': '正在加载统计',
      'statistics.new': '新卡',
      'statistics.overview': '调度概览',
      'statistics.refresh': '刷新',
      'statistics.relearning': '重新学习',
      'statistics.retry': '重试',
      'statistics.review': '复习中',
      'statistics.reviewsToday': '今日已复习',
      'statistics.subtitle': 'FSRS 队列与今日复习概览',
      'statistics.suspended': '已暂停',
      'statistics.title': '学习统计',
      'statistics.total': '已入队总数',
    }[key] ?? key),
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/utils/chatApi', () => ({
  getFsrsStats: mocks.getStats,
}));

import { StatisticsScreen } from '@/features/flashcards/screens/StatisticsScreen';

const firstStats = {
  total: 30,
  due: 5,
  newCount: 7,
  learning: 3,
  review: 15,
  relearning: 2,
  suspended: 3,
  reviewsToday: 11,
};

describe('StatisticsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders every FSRS metric and refreshes it', async () => {
    mocks.getStats
      .mockResolvedValueOnce(firstStats)
      .mockResolvedValueOnce({ ...firstStats, reviewsToday: 12 });

    render(<StatisticsScreen />);
    expect(await screen.findByTestId('fsrs-statistics')).toBeInTheDocument();
    expect(screen.getByText('今日已复习')).toBeInTheDocument();
    expect(screen.getByText('当前到期')).toBeInTheDocument();
    expect(screen.getByText('新卡')).toBeInTheDocument();
    expect(screen.getByText('学习中')).toBeInTheDocument();
    expect(screen.getByText('复习中')).toBeInTheDocument();
    expect(screen.getByText('重新学习')).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已入队总数')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByText('12')).toBeInTheDocument());
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });

  it('places scheduler settings after the statistics panels', async () => {
    mocks.getStats.mockResolvedValueOnce(firstStats);

    render(<StatisticsScreen />);
    const statistics = await screen.findByTestId('fsrs-statistics');
    const settings = screen.getByTestId('fsrs-scheduler-settings');

    expect(
      statistics.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows backend errors and retries successfully', async () => {
    mocks.getStats
      .mockRejectedValueOnce(new Error('stats backend is offline'))
      .mockResolvedValueOnce(firstStats);

    render(<StatisticsScreen />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('stats backend is offline');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('fsrs-statistics')).toBeInTheDocument();
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });

  // 2026-08 修复回归：调度设置读写独立的 scheduler_config 命令，
  // 统计加载失败时必须保持可用（此前整块 UI 被 stats 分支一起拖垮）。
  it('keeps scheduler settings reachable when statistics loading fails', async () => {
    mocks.getStats.mockRejectedValueOnce(new Error('stats backend is offline'));

    render(<StatisticsScreen />);
    await screen.findByRole('alert');

    expect(screen.getByTestId('fsrs-scheduler-settings')).toBeInTheDocument();
  });

  it('refreshes when the FSRS statistics domain event is dispatched', async () => {
    mocks.getStats
      .mockResolvedValueOnce(firstStats)
      .mockResolvedValueOnce({ ...firstStats, reviewsToday: 13 });

    render(<StatisticsScreen />);
    expect(await screen.findByText('11')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('fsrs:stats-refresh'));

    expect(await screen.findByText('13')).toBeInTheDocument();
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });
});
