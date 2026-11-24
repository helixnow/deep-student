import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const stableT = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;
const stableI18n = { language: 'en-US', changeLanguage: () => Promise.resolve() };
const stableTranslation = { t: stableT, i18n: stableI18n };

vi.mock('react-i18next', () => ({
  useTranslation: () => stableTranslation,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));

const { heatmapData, refreshMock } = vi.hoisted(() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    heatmapData: [
      {
        date: key,
        count: 3,
        details: {
          chatSessions: 1,
          chatMessages: 2,
          notesEdited: 0,
          textbooksOpened: 0,
          examsCreated: 0,
          translationsCreated: 0,
          essaysCreated: 0,
          ankiCardsCreated: 0,
          questionsAnswered: 0,
        },
        studySeconds: 4500,
      },
    ],
    refreshMock: vi.fn(),
  };
});

vi.mock('@/hooks/useLearningHeatmap', () => ({
  useLearningHeatmap: () => ({
    data: heatmapData,
    heatmapData: [],
    loading: false,
    error: null,
    totalActivities: 3,
    activeDays: 1,
    maxCount: 3,
    totalStudySeconds: 4500,
    studyDays: 1,
    maxStudySeconds: 4500,
    refresh: refreshMock,
  }),
}));

import { LearningHeatmap } from '@/components/LearningHeatmap';

describe('LearningHeatmap Stage 5 duration summary', () => {
  it('renders a readable total study duration summary when duration mode is active', async () => {
    render(<LearningHeatmap months={1} showStats={false} showLegend />);

    await screen.findByText('heatmap.title');
    expect(screen.queryByTestId('study-duration-summary')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'heatmap.metric.duration' }));

    await waitFor(() => {
      expect(screen.getByTestId('study-duration-summary')).toBeInTheDocument();
    });
    expect(screen.getByTestId('study-duration-summary')).toHaveTextContent(
      'heatmap.duration.totalAria',
    );
  });
});
