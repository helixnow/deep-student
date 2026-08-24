import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => key.split('.').pop() ?? key,
  }),
}));

const mockStats = {
  total: 12,
  mastered: 6,
  review: 2,
  inProgress: 3,
  newCount: 1,
  correctRate: 0.8,
};

const onStartReview = vi.fn();
const onOpenPractice = vi.fn();

import { ExamGenerativeBriefing } from '@/features/learning-hub/components/ExamGenerativeBriefing';

describe('ExamGenerativeBriefing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders briefing with stats from props', () => {
    render(
      <ExamGenerativeBriefing
        stats={mockStats}
        examName="Math Exam"
        onStartReview={onStartReview}
        onOpenPractice={onOpenPractice}
      />,
    );
    expect(screen.getByTestId('exam-generative-briefing')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(document.querySelector('[data-generative-block="chart"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-chart]')).toBeTruthy();
    expect(document.querySelector('[data-generative-block="table"]')).toBeTruthy();
    expect(document.querySelector('[data-generative-table]')).toBeTruthy();
  });
});
