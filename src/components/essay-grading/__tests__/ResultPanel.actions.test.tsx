import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SuggestionChange } from '@/essay-grading/suggestionAnchors';

const suggestion: SuggestionChange = {
  original: 'old',
  replacement: 'new',
  before: 'before',
  after: 'after',
  key: 'change-1',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'essay_grading:result_section.title': 'Result',
      'essay_grading:result_section.copy': 'Copy',
      'essay_grading:result_section.save_as_note': 'Save as note',
      'essay_grading:result_section.export': 'Export',
      'essay_grading:make_cards.label': 'Make cards',
      'essay_grading:make_cards.running': 'Making cards',
      'essay_grading:make_cards.disabled_grading': 'Wait for grading',
      'essay_grading:make_cards.disabled_no_result': 'No result',
    }[key] ?? key),
  }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/essay-grading/GradingStreamRenderer', () => ({
  GradingStreamRenderer: ({
    onApplySuggestion,
    onUndoSuggestion,
  }: {
    onApplySuggestion?: (change: SuggestionChange) => void;
    onUndoSuggestion?: (change: SuggestionChange) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onApplySuggestion?.(suggestion)}>Apply suggestion</button>
      <button type="button" onClick={() => onUndoSuggestion?.(suggestion)}>Undo suggestion</button>
    </div>
  ),
}));

import { ResultPanel } from '../ResultPanel';

describe('ResultPanel composed essay actions', () => {
  it('keeps anchored apply/undo, save-note, and CardAgent entry together', () => {
    const onApplySuggestion = vi.fn();
    const onUndoSuggestion = vi.fn();
    const onSaveAsNote = vi.fn();
    const onGenerateCards = vi.fn();

    render(
      <ResultPanel
        gradingResult="<section-annotation>graded</section-annotation>"
        isGrading={false}
        charCount={42}
        onCopyResult={vi.fn()}
        onExportResult={vi.fn()}
        currentRound={1}
        onApplySuggestion={onApplySuggestion}
        onUndoSuggestion={onUndoSuggestion}
        onSaveAsNote={onSaveAsNote}
        onGenerateCards={onGenerateCards}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo suggestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make cards' }));

    expect(onApplySuggestion).toHaveBeenCalledWith(suggestion);
    expect(onUndoSuggestion).toHaveBeenCalledWith(suggestion);
    expect(onSaveAsNote).toHaveBeenCalledTimes(1);
    expect(onGenerateCards).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save as note' })).toHaveClass(
      '[@media(pointer:coarse)]:!h-11',
      '[@media(pointer:coarse)]:!w-11',
    );
    expect(screen.getByRole('button', { name: 'Make cards' })).toHaveClass(
      '[@media(pointer:coarse)]:!min-h-[44px]',
    );
  });

  it('keeps card generation visible but disabled while grading', () => {
    render(
      <ResultPanel
        gradingResult="<section-annotation>partial</section-annotation>"
        isGrading
        charCount={10}
        onCopyResult={vi.fn()}
        onExportResult={vi.fn()}
        currentRound={1}
        onGenerateCards={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Make cards' })).toBeDisabled();
  });
});
