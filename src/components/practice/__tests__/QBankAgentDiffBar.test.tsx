import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@/api/questionBankApi';

const { refreshQuestionsSpy, setCurrentQuestionSpy } = vi.hoisted(() => ({
  refreshQuestionsSpy: vi.fn(async () => undefined),
  setCurrentQuestionSpy: vi.fn(),
}));

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: {
    getState: () => ({
      currentQuestionId: null,
      questions: new Map(),
      refreshQuestions: refreshQuestionsSpy,
      setCurrentQuestion: setCurrentQuestionSpy,
    }),
  },
}));

vi.mock('@/features/workbench/agent/visuals/agentFlash', () => ({
  agentFlash: vi.fn(),
  agentFlashMany: vi.fn(),
}));

import {
  buildQuestionRevertParams,
  buildSelectiveQuestionRevertParams,
  QuestionRevertError,
  isQbankAgentModifyPayload,
  useQbankAgentDiffStore,
} from '@/stores/qbankAgentDiffStore';
import {
  QBANK_REFRESH_EVENT,
  normalizeQbankRefreshPayload,
  refreshQbankPreservingCurrent,
} from '@/features/workbench/agent/drivers/qbankDriver';
import type { DomainChangePayload } from '@/features/workbench/agent/types';
import { QBankAgentDiffBar } from '../QBankAgentDiffBar';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

function makeQuestion(overrides: Partial<Question> & { id: string }): Question {
  return {
    examId: 'exam-1',
    cardId: `card-${overrides.id}`,
    questionLabel: 'Q1',
    content: '设函数 f(x) = x^2，求 f\'(2)。',
    ocrText: '',
    questionType: 'single_choice',
    options: [
      { key: 'A', content: '2' },
      { key: 'B', content: '4' },
    ],
    answer: 'B',
    explanation: '幂函数求导公式 f\'(x) = 2x。',
    difficulty: 'easy',
    tags: ['导数', '基础'],
    status: 'new',
    attemptCount: 0,
    correctCount: 0,
    isFavorite: false,
    ...overrides,
  };
}

beforeEach(() => {
  useQbankAgentDiffStore.getState().resetAllDiffs();
  refreshQuestionsSpy.mockClear();
  setCurrentQuestionSpy.mockClear();
});

afterEach(() => {
  cleanup();
  useQbankAgentDiffStore.getState().resetAllDiffs();
});

describe('qbankAgentDiffStore & payload guards', () => {
  it('reverts only unchanged Agent fields while preserving newer user edits and practice metadata', () => {
    const before = makeQuestion({ id: 'q1', content: '原题', userNote: '原备注', answer: 'A' });
    const after = { ...before, content: 'AI 题干', answer: 'B', userNote: 'AI 备注' };
    const current = { ...after, content: '用户后续修订', userNote: '用户笔记', attemptCount: 8 };
    const params = buildSelectiveQuestionRevertParams(before, after, current);
    expect(params).toMatchObject({ content: '用户后续修订', answer: 'A', user_note: '用户笔记' });
    expect(params).not.toHaveProperty('attempt_count');
  });

  it('accepting one pending question also clears its staged snapshot without clearing another question', () => {
    const q1 = makeQuestion({ id: 'q1' });
    const q2 = makeQuestion({ id: 'q2' });
    const store = useQbankAgentDiffStore.getState();
    store.stageBeforeRefresh('exam-1', [q1, q2]);
    store.acceptQuestionDiff('exam-1', 'q1');
    const entries = store.reconcileAfterRefresh('exam-1', [{ ...q1, answer: 'A' }, { ...q2, answer: 'A' }]);
    expect(entries.map((entry) => entry.questionId)).toEqual(['q2']);
  });
  it('classifies Agent non-delete payloads and filters user or pure delete payloads', () => {
    expect(
      isQbankAgentModifyPayload({ source: 'agent', action: 'qbank_update_question' }),
    ).toBe(true);
    expect(isQbankAgentModifyPayload({ source: 'ai', action: 'updated' })).toBe(true);
    expect(isQbankAgentModifyPayload({ source: 'user', action: 'updated' })).toBe(false);
    expect(isQbankAgentModifyPayload({ source: 'agent', action: 'delete' })).toBe(false);
    expect(
      isQbankAgentModifyPayload({ source: 'agent', action: 'qbank_batch_delete_questions' }),
    ).toBe(false);
    expect(isQbankAgentModifyPayload(null)).toBe(false);
  });

  it('extracts field-level diffs on stageBeforeRefresh -> reconcileAfterRefresh and prunes unchanged items', () => {
    const q1Before = makeQuestion({ id: 'q1', questionLabel: '1' });
    const q2Unchanged = makeQuestion({ id: 'q2', questionLabel: '2', content: '未改动题干' });

    const store = useQbankAgentDiffStore.getState();
    store.stageBeforeRefresh('exam-1', [q1Before, q2Unchanged], ['q1', 'q2'], 'run-42');

    const q1After = makeQuestion({
      id: 'q1',
      questionLabel: '1',
      content: '设函数 f(x) = x^3，求 f\'(2)。',
      options: [
        { key: 'A', content: '6' },
        { key: 'B', content: '12' },
      ],
      answer: 'B',
      explanation: '由 (x^3)\' = 3x^2 得 f\'(2) = 12。',
      difficulty: 'medium',
      tags: ['导数', '高阶'],
    });

    const entries = store.reconcileAfterRefresh('exam-1', [q1After, q2Unchanged]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.questionId).toBe('q1');
    expect(entries[0]?.runId).toBe('run-42');
    expect(entries[0]?.changes.map((c) => c.field)).toEqual([
      'questionText',
      'options',
      'explanation',
      'difficulty',
      'tags',
    ]);
  });

  it('preserves earliest baseline snapshot across consecutive Agent updates and builds lossless revert params', () => {
    const original = makeQuestion({
      id: 'q1',
      explanation: '',
      tags: [],
      difficulty: undefined,
      userNote: '',
    });
    const firstEdit = makeQuestion({
      id: 'q1',
      explanation: 'AI 第一次解析',
      tags: ['导数'],
      difficulty: 'medium',
      userNote: 'AI 备注',
    });
    const secondEdit = makeQuestion({
      id: 'q1',
      explanation: 'AI 第二次润色解析',
      tags: ['导数', '极值'],
      difficulty: 'hard',
      userNote: 'AI 备注 2',
    });

    const store = useQbankAgentDiffStore.getState();
    store.stageBeforeRefresh('exam-1', [original], ['q1'], 'run-1');
    store.reconcileAfterRefresh('exam-1', [firstEdit]);

    store.stageBeforeRefresh('exam-1', [firstEdit], ['q1'], 'run-2');
    const entries = store.reconcileAfterRefresh('exam-1', [secondEdit]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.before.explanation).toBe('');

    const revertParams = buildQuestionRevertParams(entries[0]!.before);
    expect(revertParams).toMatchObject({
      explanation: '',
      tags: [],
      difficulty: null,
      user_note: '',
    });
  });

  it('dispatches QBANK_REFRESH_EVENT with normalized { source: agent, entityIds, runId } in qbankDriver', async () => {
    const received: DomainChangePayload[] = [];
    const listener = (ev: Event) => {
      received.push((ev as CustomEvent<DomainChangePayload>).detail);
    };
    window.addEventListener(QBANK_REFRESH_EVENT, listener);

    try {
      const normalized = normalizeQbankRefreshPayload({
        source: 'agent',
        action: 'qbank_update_question',
        question_ids: ['q-101', 'q-102'],
        run_id: 'run-snake-9',
      } as unknown as DomainChangePayload);
      expect(normalized).toMatchObject({
        source: 'agent',
        action: 'qbank_update_question',
        entityIds: ['q-101', 'q-102'],
        runId: 'run-snake-9',
      });

      await refreshQbankPreservingCurrent({
        source: 'agent',
        action: 'updated',
        entityIds: ['q-101'],
        runId: 'run-abc',
      });

      expect(refreshQuestionsSpy).toHaveBeenCalledTimes(1);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        source: 'agent',
        action: 'updated',
        entityIds: ['q-101'],
        runId: 'run-abc',
      });
    } finally {
      window.removeEventListener(QBANK_REFRESH_EVENT, listener);
    }
  });
});

describe('QBankAgentDiffBar component', () => {
  it('keeps rollback visible while pending, blocks duplicate writes, and removes only successful batch prefix on failure', async () => {
    const q1 = makeQuestion({ id: 'q1' });
    const q2 = makeQuestion({ id: 'q2' });
    const store = useQbankAgentDiffStore.getState();
    store.stageBeforeRefresh('exam-1', [q1, q2]);
    store.reconcileAfterRefresh('exam-1', [{ ...q1, answer: 'A' }, { ...q2, answer: 'A' }]);
    let reject!: (error: unknown) => void;
    const revert = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    render(<QBankAgentDiffBar examId="exam-1" onRevertQuestions={revert} />);
    fireEvent.click(screen.getByTestId('qbank-diff-revert-all'));
    fireEvent.click(screen.getByTestId('qbank-diff-revert-current'));
    expect(revert).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('qbank-agent-diff-bar')).toBeInTheDocument();
    expect(screen.getByTestId('qbank-diff-revert-current')).toBeDisabled();
    await act(async () => { reject(new QuestionRevertError(['q1'], new Error('q2 failed'))); });
    expect(useQbankAgentDiffStore.getState().entriesByExamId['exam-1'].map((entry) => entry.questionId)).toEqual(['q2']);
    expect(screen.getByTestId('qbank-diff-counter')).toHaveTextContent('1 / 1');
  });

  it('does not dismiss a newer Agent diff when an older rollback completes', async () => {
    const original = makeQuestion({ id: 'q1' });
    const store = useQbankAgentDiffStore.getState();
    store.stageBeforeRefresh('exam-1', [original]);
    const first = { ...original, answer: 'A' };
    store.reconcileAfterRefresh('exam-1', [first]);
    let resolve!: () => void;
    render(<QBankAgentDiffBar examId="exam-1" onRevertQuestions={() => new Promise<void>((done) => { resolve = done; })} />);
    fireEvent.click(screen.getByTestId('qbank-diff-revert-current'));
    act(() => {
      store.stageBeforeRefresh('exam-1', [first]);
      store.reconcileAfterRefresh('exam-1', [{ ...first, explanation: '新的 AI 结果' }]);
    });
    await act(async () => { resolve(); });
    expect(useQbankAgentDiffStore.getState().entriesByExamId['exam-1']).toHaveLength(1);
    expect(screen.getByTestId('qbank-agent-diff-bar')).toBeInTheDocument();
  });
  it('renders Mineral Zen tokens, steps entries, expands field diffs, and handles single/batch accept', () => {
    const q1Before = makeQuestion({ id: 'q1', questionLabel: 'Q1', answer: 'A' });
    const q1After = makeQuestion({
      id: 'q1',
      questionLabel: 'Q1',
      answer: 'B',
      explanation: '补充严谨推导步骤',
    });
    const q2Before = makeQuestion({ id: 'q2', questionLabel: 'Q2', content: '旧题干' });
    const q2After = makeQuestion({ id: 'q2', questionLabel: 'Q2', content: '新题干' });

    const onRevertQuestions = vi.fn();
    const onFocusQuestion = vi.fn();

    const { rerender, container } = render(
      <QBankAgentDiffBar
        examId="exam-1"
        onRevertQuestions={onRevertQuestions}
        onFocusQuestion={onFocusQuestion}
      />,
    );
    expect(screen.queryByTestId('qbank-agent-diff-bar')).toBeNull();

    act(() => {
      const store = useQbankAgentDiffStore.getState();
      store.stageBeforeRefresh('exam-1', [q1Before, q2Before], ['q1', 'q2'], 'run-ui');
      store.reconcileAfterRefresh('exam-1', [q1After, q2After]);
    });

    rerender(
      <QBankAgentDiffBar
        examId="exam-1"
        onRevertQuestions={onRevertQuestions}
        onFocusQuestion={onFocusQuestion}
      />,
    );

    const bar = screen.getByTestId('qbank-agent-diff-bar');
    expect(bar.className).toContain('border-border/35');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    const dot = screen.getByTestId('qbank-diff-status-dot');
    expect(dot.className).toContain('h-1.5');
    expect(dot.className).toContain('w-1.5');
    expect(dot.className).toContain('bg-primary');

    const counter = screen.getByTestId('qbank-diff-counter');
    expect(counter.textContent).toBe('1 / 2');
    expect(counter.className).toContain('font-mono');
    expect(counter.className).toContain('tabular-nums');

    fireEvent.click(screen.getByTestId('qbank-diff-toggle-expand'));
    expect(screen.getByTestId('qbank-diff-before-correctAnswer').textContent).toContain('A');
    expect(screen.getByTestId('qbank-diff-after-correctAnswer').textContent).toContain('B');
    expect(EMOJI_RE.test(container.textContent ?? '')).toBe(false);

    fireEvent.click(screen.getByTestId('qbank-diff-next'));
    expect(onFocusQuestion).toHaveBeenCalledWith('q2');
    expect(screen.getByTestId('qbank-diff-counter').textContent).toBe('2 / 2');

    fireEvent.click(screen.getByTestId('qbank-diff-accept-current'));
    expect(screen.getByTestId('qbank-diff-counter').textContent).toBe('1 / 1');

    fireEvent.click(screen.getByTestId('qbank-diff-accept-all'));
    expect(screen.queryByTestId('qbank-agent-diff-bar')).toBeNull();
  });

  it('invokes onRevertQuestions with before snapshots and restores entries if rollback fails', async () => {
    const q1Before = makeQuestion({ id: 'q1', questionLabel: 'Q1', content: '原始题干 1' });
    const q1After = makeQuestion({ id: 'q1', questionLabel: 'Q1', content: 'AI 修改题干 1' });
    const q2Before = makeQuestion({ id: 'q2', questionLabel: 'Q2', content: '原始题干 2' });
    const q2After = makeQuestion({ id: 'q2', questionLabel: 'Q2', content: 'AI 修改题干 2' });

    act(() => {
      const store = useQbankAgentDiffStore.getState();
      store.stageBeforeRefresh('exam-1', [q1Before, q2Before], ['q1', 'q2'], 'run-revert');
      store.reconcileAfterRefresh('exam-1', [q1After, q2After]);
    });

    const onRevertQuestions = vi
      .fn<(questions: Question[]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('IPC failure'))
      .mockResolvedValueOnce(undefined);

    render(
      <QBankAgentDiffBar examId="exam-1" onRevertQuestions={onRevertQuestions} />,
    );

    // First attempt fails -> entry is restored automatically so user does not lose rollback state.
    fireEvent.click(screen.getByTestId('qbank-diff-revert-current'));
    await waitFor(() => {
      expect(onRevertQuestions).toHaveBeenCalledTimes(1);
    });
    expect(onRevertQuestions.mock.calls[0]?.[0]?.[0]?.content).toBe('原始题干 1');
    await waitFor(() => {
      expect(screen.getByTestId('qbank-diff-counter').textContent).toBe('1 / 2');
    });

    // Batch revert succeeds -> both before snapshots passed and bar unmounts cleanly.
    fireEvent.click(screen.getByTestId('qbank-diff-revert-all'));
    await waitFor(() => {
      expect(onRevertQuestions).toHaveBeenCalledTimes(2);
    });
    expect(onRevertQuestions.mock.calls[1]?.[0]?.map((q) => q.content)).toEqual([
      '原始题干 1',
      '原始题干 2',
    ]);
    await waitFor(() => {
      expect(screen.queryByTestId('qbank-agent-diff-bar')).toBeNull();
    });
  });
});
