import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count != null ? `${key}:${options.count}` : key
    ),
  }),
}));

vi.mock('@/features/chat/components/renderers', () => ({
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/components/essay-grading/ScoreCard', () => ({
  ScoreCard: ({ score }: { score: { total: number } }) => <div data-testid="score-card">{score.total}</div>,
}));

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({
    children,
    className,
    viewportClassName,
    viewportRef,
  }: {
    children: React.ReactNode;
    className?: string;
    viewportClassName?: string;
    viewportRef?: (el: HTMLDivElement | null) => void;
  }) => (
    <div className={className}>
      <div ref={viewportRef} className={viewportClassName} data-testid={viewportRef ? 'grading-viewport' : undefined}>
        {children}
      </div>
    </div>
  ),
}));

import { GradingStreamRenderer } from './GradingStreamRenderer';

const essayBody = 'Some people <good>believe</good> that university should be free.';
const scoreOpen = '<score total="6.5" max="9"><dim name="Task Response" score="6" max="9">立场明确，论证充分</dim>';
const graded = `${essayBody}\n${scoreOpen}</score>`;

describe('GradingStreamRenderer score timing', () => {
  const scrollTo = vi.fn();

  beforeEach(() => {
    scrollTo.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it('shows a scoring placeholder instead of streaming the dimension comments as body text', () => {
    render(<GradingStreamRenderer content={`${essayBody}\n${scoreOpen}`} isStreaming />);

    expect(screen.getByText('essay_grading:score_generating')).toBeInTheDocument();
    expect(screen.queryByText(/立场明确/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('score-card')).not.toBeInTheDocument();
  });

  it('scrolls back to the score card when grading finishes and exposes the total in the tab row', () => {
    const accessory = <span>round meta</span>;
    const { rerender } = render(
      <GradingStreamRenderer content={`${essayBody}\n${scoreOpen}`} isStreaming toolbarAccessory={accessory} />,
    );
    expect(scrollTo).not.toHaveBeenCalled();

    rerender(<GradingStreamRenderer content={graded} isStreaming={false} toolbarAccessory={accessory} />);

    expect(screen.getByTestId('score-card')).toHaveTextContent('6.5');
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(screen.queryByText('essay_grading:score_generating')).not.toBeInTheDocument();

    scrollTo.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:score.total 6.5/9' }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('leaves the scroll position alone when an already graded round is opened', () => {
    render(<GradingStreamRenderer content={graded} isStreaming={false} />);

    expect(screen.getByTestId('score-card')).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
