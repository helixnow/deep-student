import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && typeof params === 'object' && Object.keys(params).length > 0
        ? `${key}:${JSON.stringify(params)}`
        : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

const mockHeatmapState = vi.hoisted(() => {
  const localKey = (offsetDays: number): string => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const emptyDetails = {
    chatSessions: 0,
    chatMessages: 0,
    notesEdited: 0,
    textbooksOpened: 0,
    examsCreated: 0,
    translationsCreated: 0,
    essaysCreated: 0,
    ankiCardsCreated: 0,
    questionsAnswered: 0,
  };
  return {
    localKey,
    emptyDetails,
    current: {
      data: [] as Array<{
        date: string;
        count: number;
        details: typeof emptyDetails;
        studySeconds: number;
      }>,
      heatmapData: [],
      loading: false,
      error: null as string | null,
      totalActivities: 0,
      activeDays: 0,
      maxCount: 0,
      totalStudySeconds: 0,
      studyDays: 0,
      maxStudySeconds: 0,
      refresh: () => Promise.resolve(),
    },
  };
});

vi.mock('@/hooks/useLearningHeatmap', () => ({
  useLearningHeatmap: () => mockHeatmapState.current,
}));

import { LearningHeatmap } from '../index';

describe('LearningHeatmap keyboard focus, legend clarity & onboarding encouragement', () => {
  beforeEach(() => {
    mockHeatmapState.current = {
      data: [],
      heatmapData: [],
      loading: false,
      error: null,
      totalActivities: 0,
      activeDays: 0,
      maxCount: 0,
      totalStudySeconds: 0,
      studyDays: 0,
      maxStudySeconds: 0,
      refresh: () => Promise.resolve(),
    };
  });

  it('renders encouraging zero-data onboarding banner and clear legend scale caption for new learners', () => {
    render(<LearningHeatmap months={1} />);

    const banner = screen.getByTestId('heatmap-onboarding-banner');
    expect(banner).toHaveTextContent('heatmap.onboarding.zeroTitle');
    expect(banner).toHaveTextContent('heatmap.onboarding.zeroActivityHint');

    expect(screen.getByTestId('heatmap-legend-caption')).toHaveTextContent(
      'heatmap.legend.activityScale',
    );
    expect(screen.getByLabelText('heatmap.legend.activityLevel4')).toBeInTheDocument();
  });

  it('renders starter habit encouragement when learner has 1-3 active days', () => {
    const today = mockHeatmapState.localKey(0);
    mockHeatmapState.current = {
      ...mockHeatmapState.current,
      data: [
        {
          date: today,
          count: 6,
          details: { ...mockHeatmapState.emptyDetails, questionsAnswered: 6 },
          studySeconds: 25 * 60,
        },
      ],
      totalActivities: 6,
      activeDays: 2,
      maxCount: 6,
      totalStudySeconds: 25 * 60,
      studyDays: 2,
      maxStudySeconds: 25 * 60,
    };

    render(<LearningHeatmap months={1} />);

    expect(screen.getByTestId('heatmap-onboarding-banner')).toHaveTextContent(
      'heatmap.onboarding.earlyStreakHint:{"count":2}',
    );
    expect(screen.getByTestId('heatmap-legend-caption')).toHaveTextContent(
      'heatmap.legend.activityScalePeak:{"peak":6}',
    );
  });

  it('supports roving tabIndex, tooltip on keyboard focus, arrow-key navigation, and Escape dismiss', () => {
    const today = mockHeatmapState.localKey(0);
    const yesterday = mockHeatmapState.localKey(1);
    mockHeatmapState.current = {
      ...mockHeatmapState.current,
      data: [
        {
          date: today,
          count: 12,
          details: { ...mockHeatmapState.emptyDetails, notesEdited: 12 },
          studySeconds: 45 * 60,
        },
        {
          date: yesterday,
          count: 5,
          details: { ...mockHeatmapState.emptyDetails, chatMessages: 5 },
          studySeconds: 20 * 60,
        },
      ],
      totalActivities: 17,
      activeDays: 5,
      maxCount: 12,
      totalStudySeconds: 65 * 60,
      studyDays: 5,
      maxStudySeconds: 45 * 60,
    };

    render(<LearningHeatmap months={1} />);

    const todayCell = document.querySelector(`[data-date="${today}"]`) as HTMLElement;
    const yesterdayCell = document.querySelector(`[data-date="${yesterday}"]`) as HTMLElement;
    expect(todayCell).toHaveAttribute('tabindex', '0');
    expect(yesterdayCell).toHaveAttribute('tabindex', '-1');

    todayCell.focus();
    fireEvent.focus(todayCell);

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent('heatmap.tooltip.activitiesCount:{"count":12}');
    expect(tooltip).toHaveTextContent('heatmap.duration.minutes:{"minutes":45}');

    // ArrowUp moves focus to the previous day (-1) and updates roving tabIndex + tooltip
    fireEvent.keyDown(todayCell, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(yesterdayCell);
    expect(yesterdayCell).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'heatmap.tooltip.activitiesCount:{"count":5}',
    );

    // Escape closes the tooltip while preserving cell focus
    fireEvent.keyDown(yesterdayCell, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
