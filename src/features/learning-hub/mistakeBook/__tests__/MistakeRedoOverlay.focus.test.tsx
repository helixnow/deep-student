import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PracticeDraft } from '@/api/practiceApi';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/features/learning-today/todayLearningStore', () => ({
  refreshTodayLearning: mocks.refresh,
}));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 100, view: 50, navigation: 0 },
  registerBackHandler: vi.fn(() => () => {}),
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  useIsMobile: () => false,
}));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));

import { MistakeRedoOverlay } from '../MistakeRedoOverlay';

function makeDraft(): PracticeDraft {
  const question = {
    id: 'q1',
    exam_id: 'exam1',
    content: 'First question',
    question_type: 'single_choice' as const,
    options: [
      { key: 'A', content: 'Option alpha' },
      { key: 'B', content: 'Option beta' },
    ],
    answer: 'B',
    explanation: '',
    status: 'review' as const,
    user_answer: 'B',
    is_correct: true,
    attempt_count: 1,
    correct_count: 0,
    tags: [],
    is_favorite: false,
    is_bookmarked: false,
    source_type: 'manual' as const,
    created_at: '',
    updated_at: '',
    images: [],
  };

  return {
    id: 'draft1',
    scope_id: '__mistake_redo__',
    paper_id: null,
    title: 'Mistake redo',
    mode: 'mistake_redo',
    questions: [question, { ...question, id: 'q2', content: 'Second question' }],
    answers: {},
    marked_ids: [],
    current_index: 0,
    elapsed_seconds: 0,
    duration_seconds: null,
    deadline: null,
    revision: 1,
    created_at: '',
    updated_at: '',
  };
}

let currentDraft: PracticeDraft;
let saveError: Error | null;

beforeEach(() => {
  vi.clearAllMocks();
  currentDraft = makeDraft();
  saveError = null;
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'qbank_get_practice') return currentDraft;
    if (command === 'qbank_resume_practice_grading') return undefined;
    if (command === 'qbank_get_question') return { is_favorite: false };
    if (command === 'qbank_save_practice') {
      if (saveError) throw saveError;
      currentDraft = {
        ...currentDraft,
        ...(args?.request as Partial<PracticeDraft>),
        revision: currentDraft.revision + 1,
      };
      return currentDraft;
    }
    throw new Error(`Unexpected command ${command}`);
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开错题重做
      </button>
      {open ? (
        <MistakeRedoOverlay
          questionIds={['q1', 'q2']}
          examNames={{}}
          practiceId="draft1"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

describe('MistakeRedoOverlay focus', () => {
  it('moves focus into the overlay and wraps Tab at both ends', async () => {
    render(
      <MistakeRedoOverlay
        questionIds={['q1', 'q2']}
        examNames={{}}
        practiceId="draft1"
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '错题重做' });
    await screen.findByText('First question');
    const close = within(dialog).getByRole('button', { name: '关闭' });
    const last = within(dialog).getByRole('button', { name: '下一题' });

    expect(dialog).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();

    act(() => close.focus());
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('keeps the overlay open during submission and retains a failed submission error', async () => {
    let rejectSubmit: (error: Error) => void = () => {};
    const ordinary = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === 'qbank_submit_practice') return new Promise((_resolve, reject) => { rejectSubmit = reject; });
      if (command === 'qbank_get_practice' && args?.submitted) return Promise.reject(new Error('not submitted'));
      return ordinary(command, args);
    });
    const onClose = vi.fn();
    render(<MistakeRedoOverlay questionIds={['q1', 'q2']} examNames={{}} practiceId="draft1" onClose={onClose} />);
    const outer = screen.getByRole('dialog', { name: '错题重做' });
    await screen.findByText('First question');
    fireEvent.click(within(outer).getByRole('button', { name: '交卷' }));
    const nested = (await screen.findByText('确认交卷')).closest('[role="dialog"]')!;
    fireEvent.click(within(nested as HTMLElement).getByRole('button', { name: '交卷' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('qbank_submit_practice', expect.anything()));
    fireEvent.click(within(outer).getByRole('button', { name: '关闭' }));
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => rejectSubmit(new Error('submission offline')));
    await screen.findByText('submission offline');
    expect(outer).toBeInTheDocument();
  });

  it('returns focus to the opener after a successful close', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开错题重做' });
    act(() => opener.focus());
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: '错题重做' });
    await screen.findByText('First question');
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '错题重做' })).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the overlay open and focus contained when flush fails', async () => {
    saveError = new Error('disk full');
    const onClose = vi.fn();
    render(
      <MistakeRedoOverlay
        questionIds={['q1', 'q2']}
        examNames={{}}
        practiceId="draft1"
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: '错题重做' });
    await screen.findByText('First question');
    fireEvent.click(within(dialog).getByRole('radio', { name: /Option alpha/ }));
    const close = within(dialog).getByRole('button', { name: '关闭' });
    act(() => close.focus());
    fireEvent.click(close);

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'qbank_save_practice',
        expect.objectContaining({ request: expect.objectContaining({ id: 'draft1' }) }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('keeps a nested dialog in control of its own focus loop', async () => {
    render(
      <MistakeRedoOverlay
        questionIds={['q1', 'q2']}
        examNames={{}}
        practiceId="draft1"
        onClose={vi.fn()}
      />,
    );

    const outer = screen.getByRole('dialog', { name: '错题重做' });
    await screen.findByText('First question');
    fireEvent.click(within(outer).getByRole('button', { name: '交卷' }));

    const nestedTitle = await screen.findByText('确认交卷');
    const nested = nestedTitle.closest('[role="dialog"]') as HTMLElement | null;
    expect(nested).not.toBeNull();
    expect(nested).not.toBe(outer);

    const first = within(nested!).getByRole('button', { name: '关闭' });
    const last = within(nested!).getByRole('button', { name: '交卷' });
    expect(first).toHaveFocus();

    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();

    act(() => first.focus());
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    expect(nested).toContainElement(document.activeElement as HTMLElement);
    expect(outer).not.toContainElement(document.activeElement as HTMLElement);
  });
});
