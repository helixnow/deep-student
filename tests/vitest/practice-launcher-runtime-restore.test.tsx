import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({
  timedSession: null as null | Record<string, any>,
  mockExamSession: null as null | Record<string, any>,
  mockExamScoreCard: null as null | Record<string, any>,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
  }),
}));

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/components/practice/TimedPracticeMode', () => ({
  default: () => <div data-testid="timed-practice-mode" />,
}));

vi.mock('@/components/practice/MockExamMode', () => ({
  default: () => <div data-testid="mock-exam-mode" />,
}));

vi.mock('@/components/practice/DailyPracticeMode', () => ({
  default: () => <div data-testid="daily-practice-mode" />,
}));

vi.mock('@/components/practice/PaperGenerator', () => ({
  default: () => <div data-testid="paper-generator" />,
}));

describe('PracticeLauncher runtime restoration', () => {
  beforeEach(() => {
    storeState.timedSession = null;
    storeState.mockExamSession = null;
    storeState.mockExamScoreCard = null;
  });

  it('keeps the timed practice entry open when there is an active timed session for the current exam', async () => {
    storeState.timedSession = {
      id: 'timed_1',
      exam_id: 'exam_1',
      duration_minutes: 20,
      question_count: 10,
      question_ids: ['q1'],
      started_at: '2026-03-07T10:00:00.000Z',
      answered_count: 1,
      correct_count: 1,
      is_timeout: false,
      is_submitted: false,
      paused_seconds: 0,
      is_paused: false,
    };

    const { default: PracticeLauncher } = await import('@/components/practice/PracticeLauncher');

    render(
      <PracticeLauncher
        examId="exam_1"
        stats={null}
        questions={[{ tags: [] }]}
        onStartPractice={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('timed-practice-mode')).toBeInTheDocument();
    });
  });

  it('keeps the mock exam entry open when there is a submitted mock exam scorecard for the current exam', async () => {
    storeState.mockExamSession = {
      id: 'mock_1',
      exam_id: 'exam_1',
      config: { duration_minutes: 60 },
      question_ids: ['q1'],
      started_at: '2026-03-07T10:00:00.000Z',
      answers: {},
      results: {},
      is_submitted: true,
    };
    storeState.mockExamScoreCard = {
      session_id: 'mock_1',
      exam_id: 'exam_1',
      total_count: 1,
      answered_count: 1,
      correct_count: 1,
      wrong_count: 0,
      unanswered_count: 0,
      correct_rate: 100,
      time_spent_seconds: 10,
      type_stats: {},
      difficulty_stats: {},
      wrong_question_ids: [],
      comment: 'great',
      completed_at: '2026-03-07T10:30:00.000Z',
    };

    const { default: PracticeLauncher } = await import('@/components/practice/PracticeLauncher');

    render(
      <PracticeLauncher
        examId="exam_1"
        stats={null}
        questions={[{ tags: [] }]}
        onStartPractice={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mock-exam-mode')).toBeInTheDocument();
    });
  });
});
