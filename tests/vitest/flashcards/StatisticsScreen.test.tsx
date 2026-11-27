import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'statistics.dueReview': '到期复习（额度内）',
      'statistics.dueLearning': '到点的学习步',
      'statistics.dueNew': '今日可学新卡',
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
      'settings.scheduler.title': '调度设置',
      'stats.advanced.title': '进阶记忆分析',
      'stats.advanced.subtitle': '真实保留率、全库稳定度与难度分布、卡片状态构成',
      'stats.advanced.expand': '展开',
      'stats.advanced.collapse': '收起',
      'statistics.total': '已入队总数',
    }[key] ?? key),
    i18n: { language: 'zh-CN' },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/utils/chatApi', () => ({
  getFsrsStats: mocks.getStats,
}));

import { FSRS_STATS_REFRESH_EVENT } from '@/features/flashcards/events';
import { StatisticsScreen } from '@/features/flashcards/screens/StatisticsScreen';

const firstStats = {
  total: 30,
  due: 5,
  dueReview: 2,
  dueLearning: 1,
  dueNew: 2,
  newCount: 7,
  learning: 3,
  review: 15,
  relearning: 2,
  suspended: 3,
  reviewsToday: 11,
};

describe('StatisticsScreen', () => {
  beforeEach(() => {
    mocks.getStats.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the three queue categories separately from the new card inventory', async () => {
    mocks.getStats.mockResolvedValueOnce(firstStats);

    render(<StatisticsScreen />);
    expect(await screen.findByTestId('fsrs-statistics')).toBeInTheDocument();
    expect(screen.getByText('今日已复习')).toBeInTheDocument();
    expect(screen.getByText('到期复习（额度内）')).toBeInTheDocument();
    expect(screen.getByText('到点的学习步')).toBeInTheDocument();
    expect(screen.getByText('今日可学新卡')).toBeInTheDocument();
    expect(screen.getByText('新卡')).toBeInTheDocument();
    expect(screen.getByText('学习中')).toBeInTheDocument();
    expect(screen.getByText('复习中')).toBeInTheDocument();
    expect(screen.getByText('重新学习')).toBeInTheDocument();
    expect(screen.getByText('已暂停')).toBeInTheDocument();
    expect(screen.getByText('已入队总数')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();

  });

  it('keeps scheduler forms out of statistics and collapses advanced analytics by default', async () => {
    mocks.getStats.mockResolvedValueOnce(firstStats);

    render(<StatisticsScreen />);
    expect(await screen.findByTestId('fsrs-statistics')).toBeInTheDocument();
    expect(screen.queryByTestId('fsrs-scheduler-settings')).toBeNull();
    expect(screen.queryByTestId('fsrs-params-panel')).toBeNull();
    expect(screen.queryByTestId('fsrs-advanced-analytics')).toBeNull();

    fireEvent.click(screen.getByTestId('fsrs-advanced-analytics-toggle'));
    expect(screen.getByTestId('fsrs-advanced-analytics')).toBeInTheDocument();
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

  it('exposes a direct scheduler settings action when statistics loading fails', async () => {
    mocks.getStats.mockRejectedValueOnce(new Error('stats backend is offline'));
    const onOpenSchedulerSettings = vi.fn();

    render(<StatisticsScreen onOpenSchedulerSettings={onOpenSchedulerSettings} />);
    await screen.findByRole('alert');

    fireEvent.click(screen.getByTestId('fsrs-error-open-scheduler'));
    expect(onOpenSchedulerSettings).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the FSRS statistics domain event is dispatched', async () => {
    mocks.getStats
      .mockResolvedValueOnce(firstStats)
      .mockResolvedValueOnce({ ...firstStats, reviewsToday: 13 });

    render(<StatisticsScreen />);
    expect(await screen.findByText('11')).toBeInTheDocument();

    fireEvent(window, new Event(FSRS_STATS_REFRESH_EVENT));

    expect(await screen.findByText('13')).toBeInTheDocument();
    expect(mocks.getStats).toHaveBeenCalledTimes(2);
  });
});
