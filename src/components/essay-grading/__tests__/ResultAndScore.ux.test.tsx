import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ResultPanel } from '../ResultPanel';
import { ScoreCard } from '../ScoreCard';

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/essay-grading/GradingStreamRenderer', () => ({
  GradingStreamRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-grading-stream">{content}</div>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('Essay Grading ResultPanel & ScoreCard 体验优化', () => {
  it('批改首个字符返回前展示冷静阶段提示并在等待超过 8 秒后平滑切换深度审阅提示', () => {
    vi.useFakeTimers();
    render(
      <ResultPanel
        gradingResult=""
        isGrading={true}
        charCount={0}
        onCopyResult={vi.fn()}
        onExportResult={vi.fn()}
        currentRound={1}
      />,
    );

    const card = screen.getByTestId('essay-grading-waiting-card');
    expect(card.textContent).toContain('essay_grading:progress.waiting_calm_hint');

    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(card.textContent).toContain('essay_grading:progress.waiting_deep_hint');
    expect(card.textContent).toContain('essay_grading:progress.elapsed_seconds');
  });

  it('ScoreCard 展示清晰的得分率与等级徽章', () => {
    render(
      <ScoreCard
        score={{
          total: 42,
          maxTotal: 50,
          grade: 'good',
          dimensions: [
            { name: '立意', score: 17, maxScore: 20, comment: '立意明确' },
            { name: '结构', score: 13, maxScore: 15, comment: '结构清晰' },
            { name: '语言', score: 12, maxScore: 15, comment: '表达流畅' },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('score-card-rate').textContent).toContain('84%');
  });
});
