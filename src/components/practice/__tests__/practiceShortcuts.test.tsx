import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PracticeDraft, PracticeAttempt } from '@/api/practiceApi';
import type { Question, SubmitResult } from '@/api/questionBankApi';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), small: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (file: string) => file }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/learning-today/todayLearningStore', () => ({ refreshTodayLearning: vi.fn(async () => {}) }));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: mocks.small }),
  useIsMobile: () => mocks.small,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/useQbankAiGrading', () => {
  const value = {
    state: { isGrading: false, feedback: '' },
    resetState: vi.fn(), startGrading: vi.fn(async () => {}),
    retryGrading: vi.fn(), cancelGrading: vi.fn(),
  };
  return { useQbankAiGrading: () => value };
});

import { QuestionBankEditor } from '@/components/QuestionBankEditor';
import BatchPracticeWorkspace from '../BatchPracticeWorkspace';
import MistakeRedoOverlay from '@/features/learning-hub/mistakeBook/MistakeRedoOverlay';
import { useQuestionBankStore } from '@/stores/questionBankStore';

const owner = { examId: 'exam-shortcuts', viewInstanceId: 'shortcuts' };
const choice: Question = {
  id: 'q1', content: 'Drill choice', questionType: 'single_choice',
  options: [{ key: 'A', content: 'Alpha' }, { key: 'B', content: 'Beta' }],
  answer: 'B', status: 'new', tags: [],
};

function newDraft(): PracticeDraft {
  const question = {
    id: 'q1', exam_id: owner.examId, content: 'First draft question',
    question_type: 'single_choice' as const,
    options: choice.options!, answer: 'B', explanation: 'HIDDEN REFERENCE', status: 'new' as const,
    user_answer: '', is_correct: null, attempt_count: 0, correct_count: 0,
    tags: [], is_favorite: false, is_bookmarked: false,
    source_type: 'manual' as const, created_at: '', updated_at: '', images: [],
  };
  return {
    id: 'draft-shortcuts', scope_id: owner.examId, paper_id: null, title: 'Shortcut paper', mode: 'sequential',
    questions: [question, { ...question, id: 'q2', content: 'Second draft question' }, { ...question, id: 'q3', content: 'Third draft question' }],
    answers: {}, marked_ids: [], current_index: 0, elapsed_seconds: 0,
    duration_seconds: null, deadline: null, revision: 1, created_at: '', updated_at: '',
  };
}

let saved: PracticeDraft;
let saveFailure: boolean;
let delaySave: (() => Promise<void>) | undefined;
const key = (value: string, target: EventTarget = document.body, init = {}) => fireEvent.keyDown(target, { key: value, ...init });
const submitMock = () => vi.fn(async (): Promise<SubmitResult> => ({ isCorrect: false, correctAnswer: 'B' }));
function drill(submit = submitMock(), question = choice, isActive = true, extra = {}) {
  return <QuestionBankEditor sessionId={owner.examId} practiceSessionOwner={owner}
    questions={[question]} onSubmitAnswer={submit} isActive={isActive} {...extra} />;
}
async function batch(props: Partial<React.ComponentProps<typeof BatchPracticeWorkspace>> = {}) {
  const surface = render(<BatchPracticeWorkspace practiceId={saved.id} onBack={vi.fn()} isActive {...props} />);
  await screen.findByText('First draft question');
  return surface;
}

beforeEach(() => {
  mocks.small = false;
  mocks.invoke.mockReset();
  saved = newDraft();
  saveFailure = false;
  delaySave = undefined;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return saved;
    if (command === 'qbank_save_practice') {
      if (saveFailure) throw new Error('disk full');
      await delaySave?.();
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
    if (command === 'qbank_get_question') return { is_favorite: false };
    if (command === 'qbank_toggle_favorite') return { is_favorite: true };
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    throw new Error(`Unexpected IPC: ${command}`);
  });
  useQuestionBankStore.setState({ practiceSessions: {} });
  useQuestionBankStore.getState().ensurePracticeSession(owner, ['q1']);
});

describe('drill shortcut regressions', () => {
  it('selects and submits outside inputs, but inactive windows yield', async () => {
    const submit = submitMock();
    const surface = render(drill(submit, choice, false));
    key('1'); key('Enter');
    expect(submit).not.toHaveBeenCalled();
    surface.rerender(drill(submit));
    key('1'); key('Enter'); key('Enter');
    await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith('q1', 'A', 'single_choice'));
  });

  it.each(['fill_blank', 'short_answer', 'numeric'] as const)('delegates single-line %s Enter to submission', async (questionType) => {
    const submit = submitMock();
    render(drill(submit, { ...choice, content: 'Fill ___', questionType, options: [] }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '42' } });
    key('Enter', input);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not let repeat toggle multi-choice off or IME select an answer', () => {
    const submit = submitMock();
    render(drill(submit, { ...choice, questionType: 'multiple_choice' }));
    key('2', document.body, { isComposing: true });
    key('2', document.body, { keyCode: 229 });
    key('1'); key('1', document.body, { repeat: true }); key('Enter');
    expect(submit).toHaveBeenCalledWith('q1', 'A', 'multiple_choice');
  });

  it('supports Caps Lock R after an incorrect result', async () => {
    const submit = submitMock();
    render(drill(submit));
    key('1'); key('Enter');
    await screen.findByRole('button', { name: /^重做$/ });
    key('R'); key('2'); key('Enter');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('gives option F priority over favorites', () => {
    const favorite = vi.fn();
    const submit = submitMock();
    render(drill(submit, { ...choice, options: [{ key: 'F', content: 'Sixth' }] }, true, { onToggleFavorite: favorite }));
    key('F'); key('Enter');
    expect(favorite).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith('q1', 'F', 'single_choice');
  });

  it('browse Enter navigates and writable F favorites without answering or retrying', () => {
    const navigate = vi.fn();
    const favorite = vi.fn();
    const submit = submitMock();
    render(<QuestionBankEditor sessionId={owner.examId} practiceSessionOwner={owner}
      questions={[choice, { ...choice, id: 'q2' }]} browseMode showTimer={false}
      onNavigate={navigate} onToggleFavorite={favorite} onSubmitAnswer={submit} />);
    key('1'); key('R'); key('F'); key('Enter');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(1);
    expect(favorite).toHaveBeenCalledExactlyOnceWith('q1', true);
    expect(submit).not.toHaveBeenCalled();
  });

  it('keeps multiline Enter as a newline and yields to a top modal even before focus moves', () => {
    const submit = submitMock();
    const surface = render(drill(submit, { ...choice, questionType: 'essay', options: [] }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Essay' } });
    expect(key('Enter', input)).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    surface.rerender(<>{drill(submit)}<div role="dialog" aria-modal="true">Other modal</div></>);
    key('1'); key('Enter');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('whole-paper shortcuts', () => {
  it('selects with numbers and letters, persists latest input before navigating without grading', async () => {
    await batch();
    key('1');
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeChecked();
    key('b');
    expect(screen.getByRole('radio', { name: /Beta/ })).toBeChecked();
    key('Enter');
    await screen.findByText('Second draft question');
    expect(saved.answers).toEqual({ q1: 'B' });
    key('ArrowLeft');
    await screen.findByText('First draft question');
    expect(screen.getByRole('radio', { name: /Beta/ })).toBeChecked();
    expect(screen.queryByText('HIDDEN REFERENCE')).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([cmd]) => ['qbank_submit_practice', 'qbank_submit_answer', 'qbank_ai_grade'].includes(cmd))).toBe(false);
  });

  it('works after mouse focus on an answer radio and preserves native Space', async () => {
    await batch();
    const radio = screen.getByRole('radio', { name: /Alpha/ });
    fireEvent.click(radio); radio.focus();
    key('b', radio);
    expect(screen.getByRole('radio', { name: /Beta/ })).toBeChecked();
    expect(key(' ', radio)).toBe(true);
    key('Enter', radio);
    await screen.findByText('Second draft question');
    expect(saved.answers.q1).toBe('B');
  });

  it('accepts selection after a toolbar click without hijacking its native Enter', async () => {
    await batch();
    const next = screen.getByRole('button', { name: '下一题' });
    next.focus();
    key('1', next);
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeChecked();
    expect(key('Enter', next)).toBe(true);
  });

  it('toggles multi-choice once per press and selects true/false without grading', async () => {
    saved.questions[0].question_type = 'multiple_choice';
    saved.questions[1] = { ...saved.questions[1], question_type: 'true_false', options: [] };
    await batch();
    key('1'); key('1', document.body, { repeat: true }); key('B');
    expect(screen.getByRole('checkbox', { name: /Alpha/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Beta/ })).toBeChecked();
    key('Enter');
    await screen.findByText('Second draft question');
    key('2');
    expect(screen.getByRole('radio', { name: '错误' })).toBeChecked();
    key('Enter');
    await screen.findByText('Third draft question');
    expect(saved.answers).toEqual({ q1: 'AB', q2: 'false' });
  });

  it('yields to search, selectors, multiline input and an open menu', async () => {
    await batch();
    const search = document.createElement('input');
    const select = document.createElement('select');
    const textarea = document.createElement('textarea');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu'); menu.dataset.state = 'open';
    document.body.append(search, select, textarea);
    for (const target of [search, select, textarea]) {
      expect(key('1', target)).toBe(true);
      expect(key('ArrowRight', target)).toBe(true);
    }
    document.body.append(menu);
    key('1'); key('ArrowRight');
    expect(screen.getByText('First draft question')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked();
    search.remove(); select.remove(); textarea.remove(); menu.remove();
  });

  it('flushes before single-flight navigation, including answers typed during an autosave', async () => {
    let resolve: () => void = () => {};
    delaySave = () => new Promise<void>(done => { resolve = done; });
    await batch();
    key('1');
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('qbank_save_practice', expect.anything()));
    key('2');
    key('ArrowRight'); key('ArrowRight');
    delaySave = undefined; resolve();
    await screen.findByText('Second draft question');
    expect(saved.answers.q1).toBe('B');
    expect(saved.current_index).toBe(1);
  });

  it('keeps answer and position after save failure; retrying Enter navigates', async () => {
    await batch();
    saveFailure = true;
    key('b'); key('ArrowRight');
    await screen.findByText('disk full');
    expect(screen.getByText('First draft question')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Beta/ })).toBeChecked();
    saveFailure = false;
    key('Enter');
    await screen.findByText('Second draft question');
    expect(saved.answers.q1).toBe('B');
  });

  it('never submits a paper on last-question Enter, R, H or Space', async () => {
    saved.questions = [saved.questions[0]];
    await batch();
    key('1'); key('Enter');
    await waitFor(() => expect(saved.answers.q1).toBe('A'));
    key('R'); key('H'); key(' ');
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeChecked();
    expect(screen.queryByText('HIDDEN REFERENCE')).not.toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'qbank_submit_practice')).toBe(false);
  });

  it.each(['fill_blank', 'numeric'] as const)('flushes %s input Enter without grading', async (question_type) => {
    saved.questions[0] = { ...saved.questions[0], question_type, options: [], content: 'First draft question' };
    await batch();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '42' } });
    key('Enter', input);
    await screen.findByText('Second draft question');
    expect(saved.answers.q1).toContain('42');
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'qbank_submit_practice')).toBe(false);
  });

  it('yields while the confirmation dialog is open and does not consume native button Enter', async () => {
    await batch();
    const submit = screen.getByRole('button', { name: '交卷', exact: true });
    expect(key('Enter', submit)).toBe(true);
    fireEvent.click(submit);
    await screen.findByRole('dialog');
    key('1'); key('ArrowRight');
    expect(screen.getByText('First draft question')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked();
  });

  it('ignores modified, repeating, composing and already handled keys', async () => {
    await batch();
    for (const init of [{ repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) key('1', document.body, init);
    const event = createEvent.keyDown(document.body, { key: '1' });
    event.preventDefault(); fireEvent(document.body, event);
    expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked();
  });

  it('inactive or small-screen practice does not register answer keys', async () => {
    const surface = await batch({ isActive: false });
    key('1'); key('ArrowRight');
    expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked();
    mocks.small = true;
    surface.rerender(<BatchPracticeWorkspace practiceId={saved.id} onBack={vi.fn()} isActive />);
    key('1'); key('ArrowRight');
    expect(screen.getByText('First draft question')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Alpha/ })).not.toBeChecked();
  });

  it('navigates submitted results inside the selected filter without changing answers', async () => {
    const attempt: PracticeAttempt = { ...saved, status: 'completed', submitted_at: '', origin_device_id: 'test',
      results: saved.questions.map((q, i) => ({ question_id: q.id, status: i === 1 ? 'correct' : 'incorrect',
        is_correct: i === 1, score: i === 1 ? 100 : 0, feedback: null, error: null, source_available: true, submission_id: `s${i}` })),
    };
    mocks.invoke.mockImplementation(async command => command === 'qbank_get_practice' ? attempt : undefined);
    await batch({ submitted: true });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wrong' } });
    key('ArrowRight');
    await screen.findByText('Third draft question');
    key('ArrowLeft');
    await screen.findByText('First draft question');
    key('1'); key('R');
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'qbank_save_practice' || cmd === 'qbank_create_practice')).toBe(false);
  });

  it('opening the real mistake overlay isolates a focused background drill', async () => {
    const submit = submitMock();
    const surface = render(<><button data-testid="background-focus">Background</button>{drill(submit)}</>);
    screen.getByTestId('background-focus').focus();
    surface.rerender(<>
      <button data-testid="background-focus">Background</button>{drill(submit)}
      <MistakeRedoOverlay questionIds={['q1', 'q2']} examNames={{}} practiceId={saved.id} onClose={vi.fn()} />
    </>);
    await screen.findByText('First draft question');
    const modal = screen.getByRole('dialog', { name: '错题重做' });
    expect(modal).toHaveFocus();
    key('1', document.activeElement!);
    expect(screen.getByRole('radio', { name: /Alpha/ })).toBeChecked();
    key('Enter', document.activeElement!);
    await screen.findByText('Second draft question');
    expect(submit).not.toHaveBeenCalled();
  });
});
