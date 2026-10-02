import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EssayTextStats } from '@/essay-grading/textStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count != null ? `${key}:${options.count}` : key
    ),
  }),
}));

import { InputSummaryBar } from '../InputSummaryBar';

const stats = (overrides: Partial<EssayTextStats>): EssayTextStats => ({
  hanChars: 0,
  englishWords: 0,
  punctuationTotal: 0,
  cnPunctuation: 0,
  enPunctuation: 0,
  nonWhitespaceChars: 0,
  totalChars: 0,
  lineCount: 0,
  paragraphCount: 0,
  ...overrides,
});

describe('InputSummaryBar', () => {
  it('summarises the essay on one line and reopens it for editing', () => {
    const onExpand = vi.fn();
    const onGrade = vi.fn();
    render(
      <InputSummaryBar
        modeName="雅思大作文"
        modelName="deepseek-v4"
        textStats={stats({ englishWords: 129 })}
        isGrading={false}
        canGrade
        onExpand={onExpand}
        onGrade={onGrade}
        onCancelGrading={vi.fn()}
      />,
    );

    expect(screen.getByText('雅思大作文')).toBeInTheDocument();
    expect(screen.getByText('deepseek-v4')).toBeInTheDocument();
    expect(screen.getByText('essay_grading:input_summary.word_count:129')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:input_summary.regrade' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onGrade).toHaveBeenCalledTimes(1);
  });

  it('counts Chinese essays by characters', () => {
    render(
      <InputSummaryBar
        textStats={stats({ hanChars: 812, englishWords: 3 })}
        isGrading={false}
        canGrade={false}
        onExpand={vi.fn()}
        onGrade={vi.fn()}
        onCancelGrading={vi.fn()}
      />,
    );

    expect(screen.getByText('essay_grading:input_summary.han_count:812')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'essay_grading:input_summary.regrade' })).toBeDisabled();
  });

  it('asks for a second click before cancelling a running grade', () => {
    const onCancelGrading = vi.fn();
    render(
      <InputSummaryBar
        textStats={stats({ englishWords: 129 })}
        isGrading
        canGrade
        onExpand={vi.fn()}
        onGrade={vi.fn()}
        onCancelGrading={onCancelGrading}
      />,
    );

    expect(screen.getByRole('button', { name: 'essay_grading:input_summary.view' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common:aria.cancel_grading' }));
    expect(onCancelGrading).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'essay_grading:confirm.cancel' }));
    expect(onCancelGrading).toHaveBeenCalledTimes(1);
  });
});
