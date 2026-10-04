import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

const { data, localKey } = vi.hoisted(() => {
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
  const data = [
    // 活动多、学习时长短
    { date: localKey(1), count: 40, details: { ...emptyDetails, chatMessages: 40 }, studySeconds: 5 * 60 },
    // 活动少、学习时长长
    { date: localKey(2), count: 1, details: { ...emptyDetails, chatSessions: 1 }, studySeconds: 2 * 3600 + 5 * 60 },
  ];
  return { data, localKey };
});

vi.mock('@/hooks/useLearningHeatmap', () => ({
  useLearningHeatmap: () => ({
    data,
    heatmapData: [],
    loading: false,
    error: null,
    totalActivities: 41,
    activeDays: 2,
    maxCount: 40,
    totalStudySeconds: 2 * 3600 + 10 * 60,
    studyDays: 2,
    maxStudySeconds: 2 * 3600 + 5 * 60,
    refresh: () => Promise.resolve(),
  }),
}));

import { LearningHeatmap, formatStudyDuration } from '../index';

const cellLevel = (date: string) =>
  document.querySelector(`[data-date="${date}"]`)?.getAttribute('data-level');

describe('LearningHeatmap metric toggle', () => {
  it('defaults to activity counts and switches to study-time levels', async () => {
    render(<LearningHeatmap months={1} />);

    expect(screen.getByRole('radio', { name: 'heatmap.metric.activity' })).toHaveAttribute('aria-checked', 'true');
    expect(cellLevel(localKey(1))).toBe('4');
    expect(cellLevel(localKey(2))).toBe('1');
    expect(screen.getByText('41')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'heatmap.metric.duration' }));

    expect(screen.getByRole('radio', { name: 'heatmap.metric.duration' })).toHaveAttribute('aria-checked', 'true');
    // 时长口径按绝对刻度：5 分钟 → 1 档；2 小时 → 4 档
    expect(cellLevel(localKey(1))).toBe('1');
    expect(cellLevel(localKey(2))).toBe('4');
    expect(screen.getByText('heatmap.duration.total')).toBeInTheDocument();
    expect(
      screen.getByText('heatmap.duration.hoursMinutes:{"hours":2,"minutes":"10"}'),
    ).toBeInTheDocument();
  });

  it('shows the toggle even when the title is provided by the container', () => {
    render(<LearningHeatmap months={1} hideTitle showStats={false} />);
    expect(screen.queryByText('heatmap.title')).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'heatmap.metric.label' })).toBeInTheDocument();
  });

  it('formats durations for humans', () => {
    const t = ((key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key) as never;
    expect(formatStudyDuration(0, t)).toBe('heatmap.duration.zero');
    expect(formatStudyDuration(30, t)).toBe('heatmap.duration.lessThanMinute');
    expect(formatStudyDuration(38 * 60, t)).toBe('heatmap.duration.minutes:{"minutes":38}');
    expect(formatStudyDuration(3600, t)).toBe('heatmap.duration.hours:{"hours":1}');
  });
});
