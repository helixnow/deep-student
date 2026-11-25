import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PracticeDraft, PracticeAttempt, PracticeResult } from '@/api/practiceApi';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  notify: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void | Promise<void>>(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (
    name: string,
    handler: (event: { payload: unknown }) => void | Promise<void>,
  ) => {
    mocks.listeners.set(name, handler);
    return () => {
      if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name);
    };
  }),
}));
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));

import BatchPracticeWorkspace from '../BatchPracticeWorkspace';
import i18n from '@/i18n';

function draft(): PracticeDraft {
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
    explanation: 'SECRET EXPLANATION',
    status: 'review' as const,
    user_answer: 'B',
    is_correct: true,
    attempt_count: 5,
    correct_count: 2,
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
    scope_id: 'exam1',
    paper_id: null,
    title: 'My practice',
    mode: 'sequential',
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

function resultFor(status: PracticeResult['status'], questionId = 'q1'): PracticeResult {
  return {
    question_id: questionId,
    status,
    is_correct:
      status === 'correct' ? true : status === 'incorrect' || status === 'partial' ? false : null,
    score: status === 'correct' ? 100 : status === 'partial' ? 60 : status === 'incorrect' ? 0 : null,
    feedback: null,
    error: null,
    source_available: true,
    submission_id: status === 'unanswered' ? null : `submission-${questionId}`,
  };
}

function submittedAttempt(
  status?: PracticeResult['status'],
  overrides: Partial<PracticeAttempt> = {},
): PracticeAttempt {
  const base = draft();
  return {
    id: base.id,
    scope_id: base.scope_id,
    paper_id: base.paper_id,
    title: base.title,
    mode: base.mode,
    questions: base.questions,
    answers: base.answers,
    marked_ids: base.marked_ids,
    results: status ? [resultFor(status)] : [],
    elapsed_seconds: base.elapsed_seconds,
    duration_seconds: base.duration_seconds,
    status: 'completed',
    origin_device_id: 'device1',
    created_at: base.created_at,
    submitted_at: '2026-10-28T00:00:00Z',
    ...overrides,
  };
}

function manualVerdictButtonLabels(): string[] {
  return [
    i18n.t('practice:batch.markCorrect'),
    i18n.t('practice:batch.markWrong'),
  ];
}

function queryManualVerdictButtons(): HTMLElement[] {
  return manualVerdictButtonLabels().flatMap((name) =>
    screen.queryAllByRole('button', { name }),
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  mocks.invoke.mockReset();
  mocks.listeners.clear();
});
afterEach(() => {
  cleanup();
  mocks.listeners.clear();
});

it('saves and restores selections when changing questions without grading or revealing previous results', async () => {
  let saved = draft();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return saved;
    if (command === 'qbank_save_practice') {
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
    if (command === 'qbank_resume_practice_grading') return;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<BatchPracticeWorkspace practiceId="draft1" onBack={vi.fn()} />);
  await screen.findByText('First question');
  expect(screen.queryByText('SECRET EXPLANATION')).toBeNull();
  expect(screen.queryByRole('button', { name: /AI 解析/ })).toBeNull();
  expect(screen.queryByText('回答正确')).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: /Option alpha/ }));
  fireEvent.click(screen.getByRole('button', { name: /下一题/ }));
  await screen.findByText('Second question');
  fireEvent.click(screen.getByRole('button', { name: /上一题/ }));
  await screen.findByText('First question');
  expect(screen.getByRole('radio', { name: /Option alpha/ })).toBeChecked();
  expect(saved.answers).toEqual({ q1: 'A' });
  expect(
    mocks.invoke.mock.calls.some(
      ([command]) => command === 'qbank_submit_answer' || command === 'qbank_ai_grade',
    ),
  ).toBe(false);
});

it('keeps unsaved answers on a failed save and submits the newest version only after retry', async () => {
  let saved = draft();
  let fail = true;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return saved;
    if (command === 'qbank_save_practice') {
      if (fail) throw new Error('disk full');
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
    if (command === 'qbank_resume_practice_grading') return;
    throw new Error(`Unexpected command ${command}`);
  });
  const onBack = vi.fn();
  render(<BatchPracticeWorkspace practiceId="draft1" onBack={onBack} />);
  await screen.findByText('First question');
  fireEvent.click(screen.getByRole('radio', { name: /Option beta/ }));
  fireEvent.click(screen.getByRole('button', { name: /下一题/ }));
  await screen.findByText('disk full');
  expect(screen.getByText('First question')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Option beta/ })).toBeChecked();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: /重试/ }));
  await waitFor(() => expect(saved.answers.q1).toBe('B'));
  expect(onBack).not.toHaveBeenCalled();
});

it('flushes the latest answer before one whole-paper submission and keeps pending separate from wrong', async () => {
  let saved = draft();
  let completed: PracticeAttempt | null = null;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return args.submitted ? completed : saved;
    if (command === 'qbank_save_practice') {
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
    if (command === 'qbank_submit_practice') {
      expect(args.revision).toBe(saved.revision);
      expect(saved.answers.q1).toBe('A');
      completed = {
        ...saved,
        status: 'grading',
        submitted_at: '',
        origin_device_id: 'device1',
        results: [
          {
            question_id: 'q1',
            status: 'pending',
            is_correct: null,
            score: null,
            feedback: null,
            error: null,
            source_available: true,
            submission_id: 's1',
          },
          {
            question_id: 'q2',
            status: 'unanswered',
            is_correct: null,
            score: null,
            feedback: null,
            error: null,
            source_available: true,
            submission_id: null,
          },
        ],
      } satisfies PracticeAttempt;
      return completed;
    }
    if (command === 'qbank_resume_practice_grading') return;
    throw new Error(`Unexpected command ${command}`);
  });
  render(<BatchPracticeWorkspace practiceId="draft1" onBack={vi.fn()} />);
  await screen.findByText('First question');
  fireEvent.click(screen.getByRole('radio', { name: /Option alpha/ }));
  fireEvent.click(screen.getByRole('button', { name: '交卷' }));
  await screen.findByRole('dialog');
  const buttons = screen.getAllByRole('button', { name: '交卷' });
  fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByText('待批改 1 题');
  expect(screen.getByText('错误 0 题')).toBeInTheDocument();
  expect(
    mocks.invoke.mock.calls.filter(([command]) => command === 'qbank_submit_practice'),
  ).toHaveLength(1);
});

it('keeps favorites independent from this round marks and answer drafts', async () => {
  let saved = draft();
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return saved;
    if (command === 'qbank_get_question') return { is_favorite: false };
    if (command === 'qbank_toggle_favorite') return { is_favorite: true };
    if (command === 'qbank_save_practice') {
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
  });
  render(<BatchPracticeWorkspace practiceId="draft1" onBack={vi.fn()} />);
  await screen.findByText('First question');
  fireEvent.click(screen.getByRole('button', { name: '收藏' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'true'));
  expect(saved.marked_ids).toEqual([]);
  expect(saved.answers).toEqual({});
});

it('shows saved failed drafts and diagnostics while keeping the result awaiting grading', async () => {
  const saved = draft();
  const attempt: PracticeAttempt = {
    ...saved, status: 'needs_review', submitted_at: '', origin_device_id: 'device1',
    results: [{
      question_id: 'q1', status: 'failed', is_correct: null, score: null,
      feedback: null, error: 'Output truncated', source_available: true, submission_id: 's1',
      grading_drafts: [{
        feedback: 'Saved interrupted feedback', error: 'Output truncated', created_at: '2026-10-28T00:00:00Z',
        diagnostics: { status: 'truncated', model: 'test-reasoner', model_config_id: 'm1',
          max_output_tokens: 128000, finish_reason: 'length', usage: { completion_tokens: 128000 },
          response_chars: 25, reasoning_chars: 90000, http_status: 200 },
      }],
    }, {
      question_id: 'q2', status: 'unanswered', is_correct: null, score: null, feedback: null,
      error: null, source_available: true, submission_id: null,
    }],
  };
  mocks.invoke.mockImplementation(async (command) => command === 'qbank_get_practice' ? attempt : undefined);
  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('Saved interrupted feedback');
  expect(screen.getByText('待批改 1 题')).toBeInTheDocument();
  expect(screen.getByText('错误 0 题')).toBeInTheDocument();
  expect(screen.getByText(/批改反馈草稿（非正式成绩）/)).toBeInTheDocument();
  expect(screen.getByText('test-reasoner')).toBeInTheDocument();
  expect(screen.getByText('length')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新批改' })).toBeInTheDocument();
});

const definitiveStatuses: Array<[string, PracticeResult['status'] | undefined]> = [
  ['correct', 'correct'],
  ['incorrect', 'incorrect'],
  ['partial', 'partial'],
  ['unanswered', 'unanswered'],
  ['missing', undefined],
];

it.each(definitiveStatuses)(
  'hides manual grading actions for a submitted %s result',
  async (_label, status) => {
    const attempt = submittedAttempt(status);
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'qbank_get_practice') return attempt;
      if (command === 'qbank_get_question') {
        const question = attempt.questions.find((item) => item.id === args.questionId);
        return question ? { ...question, is_favorite: false } : null;
      }
      if (command === 'qbank_get_history') return [];
      if (command === 'qbank_resume_practice_grading') return;
      return undefined;
    });

    render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
    await screen.findByText('First question');

    expect(queryManualVerdictButtons()).toEqual([]);
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === 'qbank_grade_practice_manually'),
    ).toBe(false);
  },
);

it.each(['pending', 'failed'] as const)(
  'keeps manual grading available for a non-read-only %s result',
  async (status) => {
    const attempt = submittedAttempt(status);
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'qbank_get_practice') return attempt;
      if (command === 'qbank_get_question') {
        const question = attempt.questions.find((item) => item.id === args.questionId);
        return question ? { ...question, is_favorite: false } : null;
      }
      if (command === 'qbank_get_history') return [];
      if (command === 'qbank_resume_practice_grading') return;
      return undefined;
    });

    render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
    await screen.findByText('First question');

    expect(queryManualVerdictButtons()).toHaveLength(2);
  },
);

it.each(['pending', 'failed'] as const)(
  'hides manual grading actions for a read-only %s result',
  async (status) => {
    const attempt = submittedAttempt(status);
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'qbank_get_practice') return attempt;
      if (command === 'qbank_get_question') {
        const question = attempt.questions.find((item) => item.id === args.questionId);
        return question ? { ...question, is_favorite: false } : null;
      }
      if (command === 'qbank_get_history') return [];
      if (command === 'qbank_resume_practice_grading') return;
      return undefined;
    });

    render(
      <BatchPracticeWorkspace
        practiceId="draft1"
        submitted
        readOnly
        onBack={vi.fn()}
      />,
    );
    await screen.findByText('First question');

    expect(queryManualVerdictButtons()).toEqual([]);
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === 'qbank_grade_practice_manually'),
    ).toBe(false);
  },
);

it('removes manual grading fallback after a successful manual verdict', async () => {
  let attempt = submittedAttempt('pending');
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') {
      const question = attempt.questions.find((item) => item.id === args.questionId);
      return question ? { ...question, is_favorite: false } : null;
    }
    if (command === 'qbank_grade_practice_manually') {
      attempt = {
        ...attempt,
        results: attempt.results.map((result) =>
          result.question_id === args.questionId
            ? { ...result, status: 'correct', is_correct: true, score: 100 }
            : result,
        ),
      };
      return attempt;
    }
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('First question');
  fireEvent.click(screen.getByRole('button', { name: i18n.t('practice:batch.markCorrect') }));

  await waitFor(() => expect(queryManualVerdictButtons()).toEqual([]));
  expect(mocks.invoke).toHaveBeenCalledWith('qbank_grade_practice_manually', {
    id: 'draft1',
    questionId: 'q1',
    correct: true,
  });
  expect(screen.getByText('正确 1 题')).toBeInTheDocument();
});

it('removes manual grading fallback after a pushed verdict refreshes the attempt', async () => {
  let attempt = submittedAttempt('failed');
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') {
      const question = attempt.questions.find((item) => item.id === args.questionId);
      return question ? { ...question, is_favorite: false } : null;
    }
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('First question');
  expect(queryManualVerdictButtons()).toHaveLength(2);

  const getAttemptCalls = mocks.invoke.mock.calls.filter(
    ([command, args]) => command === 'qbank_get_practice' && args.submitted,
  ).length;
  attempt = {
    ...attempt,
    results: [{ ...resultFor('incorrect'), status: 'incorrect', is_correct: false, score: 0 }],
  };
  const pushed = mocks.listeners.get('qbank-practice-updated');
  expect(pushed).toBeDefined();
  await act(async () => {
    await pushed!({ payload: attempt.id });
  });

  await waitFor(() => expect(queryManualVerdictButtons()).toEqual([]));
  expect(
    mocks.invoke.mock.calls.filter(
      ([command, args]) => command === 'qbank_get_practice' && args.submitted,
    ).length,
  ).toBeGreaterThan(getAttemptCalls);
  expect(screen.getByText('错误 1 题')).toBeInTheDocument();
});

it.each([false, true])('runs submitted-paper AI analysis without grading and reloads saved feedback after navigation (explanation_written=%s)', async (explanationWritten) => {
  const base = draft();
  const attempt = submittedAttempt(undefined, {
    questions: base.questions,
    results: [resultFor('correct', 'q1'), resultFor('correct', 'q2')],
  });
  let feedback: string | null = null;
  const questionLookups = (questionId: string) =>
    mocks.invoke.mock.calls.filter(
      ([command, args]) => command === 'qbank_get_question' && args.questionId === questionId,
    ).length;

  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') {
      const question = attempt.questions.find((item) => item.id === args.questionId);
      return question
        ? {
            ...question,
            explanation:
              question.id === 'q1'
                ? 'LIVE QUESTION EXPLANATION DIFFERENT FROM SNAPSHOT'
                : question.explanation,
            ai_feedback: question.id === 'q1' ? feedback : null,
          }
        : null;
    }
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('First question');
  expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
  expect(screen.queryByText('已保存 AI 反馈')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /AI 解析/ }));
  await waitFor(() =>
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'qbank_ai_grade')).toBe(true),
  );
  const aiCall = mocks.invoke.mock.calls.find(([command]) => command === 'qbank_ai_grade')!;
  expect(aiCall[1].request).toMatchObject({
    question_id: 'q1',
    submission_id: null,
    mode: 'analyze',
  });

  const lookupsBeforeCompletion = questionLookups('q1');
  feedback = '已保存 AI 反馈';
  const stream = mocks.listeners.get(
    `qbank_grading_stream_${aiCall[1].request.stream_session_id}`,
  );
  expect(stream).toBeDefined();
  await act(async () => {
    await stream!({
      payload: {
        type: 'complete',
        feedback,
        explanation_written: explanationWritten,
      },
    });
  });

  await screen.findByText('已保存 AI 反馈');
  await waitFor(() => expect(questionLookups('q1')).toBeGreaterThan(lookupsBeforeCompletion));
  if (explanationWritten) {
    expect(screen.queryByText('SECRET EXPLANATION')).toBeNull();
  } else {
    expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /写入解析/ })).toBeInTheDocument();
  }
  expect(
    screen.queryByText('LIVE QUESTION EXPLANATION DIFFERENT FROM SNAPSHOT'),
  ).toBeNull();
  expect(screen.getByRole('button', { name: /问 AI 讲解/ })).toBeInTheDocument();
  expect(
    mocks.invoke.mock.calls.some(([command]) => command === 'qbank_update_question'),
  ).toBe(false);

  const lookupsBeforeNavigation = questionLookups('q1');
  fireEvent.click(screen.getByRole('button', { name: /下一题/ }));
  await screen.findByText('Second question');
  fireEvent.click(screen.getByRole('button', { name: /上一题/ }));
  await screen.findByText('First question');

  await screen.findByText('已保存 AI 反馈');
  await waitFor(() => expect(questionLookups('q1')).toBeGreaterThan(lookupsBeforeNavigation));
  expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
  expect(
    screen.queryByText('LIVE QUESTION EXPLANATION DIFFERENT FROM SNAPSHOT'),
  ).toBeNull();

  const commands = mocks.invoke.mock.calls.map(([command]) => command);
  expect(commands).not.toContain('qbank_submit_answer');
  expect(commands).not.toContain('qbank_grade_practice_manually');
  expect(commands).not.toContain('qbank_submit_practice');
});

it.each([
  { label: 'read-only', readOnly: true, sourceAvailable: true },
  { label: 'deleted source', readOnly: false, sourceAvailable: false },
])(
  'does not offer AI analysis for a submitted paper with a $label',
  async ({ readOnly, sourceAvailable }) => {
    const attempt = submittedAttempt('correct', {
      results: [{ ...resultFor('correct'), source_available: sourceAvailable }],
    });
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'qbank_get_practice') return attempt;
      if (command === 'qbank_get_question') {
        const question = attempt.questions.find((item) => item.id === args.questionId);
        return question ? { ...question, is_favorite: false } : null;
      }
      if (command === 'qbank_get_history') return [];
      if (command === 'qbank_resume_practice_grading') return;
      return undefined;
    });

    render(
      <BatchPracticeWorkspace
        practiceId="draft1"
        submitted
        readOnly={readOnly}
        onBack={vi.fn()}
      />,
    );
    await screen.findByText('First question');

    expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /AI 解析/ })).toBeNull();
    expect(
      mocks.invoke.mock.calls.some(([command]) => command === 'qbank_ai_grade'),
    ).toBe(false);
  },
);

it('hides AI analysis when the source was deleted after submission despite the saved availability flag', async () => {
  const attempt = submittedAttempt('correct');
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') return null;
    if (command === 'qbank_get_history') return [];
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText(i18n.t('practice:batch.sourceUnavailable'));
  expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /AI 解析/ })).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command]) => command === 'qbank_ai_grade')).toBe(false);
});

it('treats whitespace-only answers as unanswered, clears them before submit, and styles unanswered results neutrally (BUG-16)', async () => {
  const base = draft();
  let saved: PracticeDraft = {
    ...base,
    questions: [
      { ...base.questions[0], question_type: 'short_answer', options: [] },
      { ...base.questions[1], question_type: 'short_answer', options: [] },
    ],
    answers: { q1: '   ' },
  };
  const refreshEvents: string[] = [];
  const onRefresh = () => refreshEvents.push('learning-today:refresh');
  window.addEventListener('learning-today:refresh', onRefresh);

  let completed: PracticeAttempt | null = null;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return args.submitted ? completed : saved;
    if (command === 'qbank_save_practice') {
      saved = { ...saved, ...args.request, revision: saved.revision + 1 };
      return saved;
    }
    if (command === 'qbank_submit_practice') {
      completed = {
        ...saved,
        status: 'completed',
        submitted_at: '2026-10-28T00:00:00Z',
        origin_device_id: 'device1',
        results: [resultFor('unanswered', 'q1'), resultFor('unanswered', 'q2')],
      } satisfies PracticeAttempt;
      return completed;
    }
    if (command === 'qbank_get_question') return null;
    if (command === 'qbank_resume_practice_grading') return;
    return undefined;
  });

  try {
    render(<BatchPracticeWorkspace practiceId="draft1" onBack={vi.fn()} />);
    await screen.findByText('First question');

    // Open answer sheet: whitespace-only answer must count as 0 answered, 2 unanswered, pill not highlighted
    fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]);
    expect(screen.getAllByText('已答 0 / 2 题').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('未答 2 题').length).toBeGreaterThanOrEqual(1);
    const jumpQ1 = screen.getAllByRole('button', { name: '跳转到第 1 题' })[0];
    expect(jumpQ1.className).not.toContain('border-primary/40');
    fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]);

    // Typing whitespace-only into q2 keeps answered count at 0
    fireEvent.click(screen.getByRole('button', { name: /下一题/ }));
    await screen.findByText('Second question');
    const textbox = screen.getByRole('textbox', { name: '我的作答' });
    fireEvent.change(textbox, { target: { value: '   \n\t  ' } });
    fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]);
    expect(screen.getAllByText('已答 0 / 2 题').length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]);

    // Open submit confirmation: shows 0 answered, 2 unanswered, and jump-to-unanswered CTA
    fireEvent.click(screen.getByRole('button', { name: '交卷' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('已答 0 / 2 题');
    expect(dialog).toHaveTextContent('未答 2 题');
    expect(screen.getByRole('button', { name: '跳到未答题' })).toBeInTheDocument();

    // Confirm submit: blank-only entries stripped before submit and Today refresh event dispatched
    const submitButtons = screen.getAllByRole('button', { name: '交卷' });
    fireEvent.click(submitButtons[submitButtons.length - 1]);
    await screen.findByText('未作答', { selector: 'span' });

    expect(saved.answers).toEqual({});
    expect(refreshEvents).toEqual(['learning-today:refresh']);

    const statusBanner = screen.getByText('未作答', { selector: 'span' }).closest('div');
    expect(statusBanner?.className).toContain('bg-muted/40');
    expect(statusBanner?.className).not.toContain('bg-warning');

    // Post-submit answer sheet legend includes unanswered
    fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]);
    expect(screen.getAllByText('未答').length).toBeGreaterThanOrEqual(1);
  } finally {
    window.removeEventListener('learning-today:refresh', onRefresh);
  }
});

it('shows expanded AI subjective grading rationale, reconciles partial-credit metrics, and saves inline manual score override (S2-05)', async () => {
  const base = draft();
  let attempt: PracticeAttempt = submittedAttempt('partial', {
    questions: [
      { ...base.questions[0], question_type: 'short_answer', options: [] },
    ],
    answers: { q1: '学生的简要作答' },
    results: [
      {
        question_id: 'q1',
        status: 'partial',
        is_correct: false,
        score: 60,
        feedback: '要点1正确（+40分），缺少关键推导步骤（-40分）。',
        error: null,
        source_available: true,
        submission_id: 'sub-1',
      },
    ],
  });

  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') return { ...base.questions[0], is_favorite: false };
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    if (command === 'qbank_grade_practice_manually') {
      const nextScore = typeof args.score === 'number' ? args.score : args.correct ? 100 : 0;
      attempt = {
        ...attempt,
        results: [
          {
            ...attempt.results[0]!,
            score: nextScore,
            status: nextScore >= 80 ? 'correct' : nextScore === 0 ? 'incorrect' : 'partial',
            is_correct: nextScore >= 80,
          },
        ],
      };
      return attempt;
    }
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('First question');

  // Reconciled metrics: score 60 matches score rate 60%, not contradictory "得分 60分 · 准确率 0%"
  const summary = screen.getByTestId('batch-total-score-summary');
  expect(summary).toHaveTextContent('综合得分 60分 · 得分率 60%');
  expect(screen.getByText('部分正确 1 题')).toBeInTheDocument();

  // Visibly expanded AI subjective grading rationale
  const rationale = screen.getByTestId('practice-ai-grading-rationale');
  expect(rationale).toHaveTextContent('AI 评分依据与批改评语');
  expect(rationale).toHaveTextContent('60 / 100 分');
  expect(rationale).toHaveTextContent('要点1正确（+40分），缺少关键推导步骤（-40分）。');

  // Open inline manual score override and adjust score to 85
  fireEvent.click(screen.getByTestId('practice-manual-override-toggle'));
  const scoreInput = screen.getByTestId('practice-manual-override-score-input') as HTMLInputElement;
  expect(scoreInput.value).toBe('60');
  fireEvent.change(scoreInput, { target: { value: '85' } });
  fireEvent.click(screen.getByTestId('practice-manual-override-save'));

  await waitFor(() => {
    expect(mocks.invoke).toHaveBeenCalledWith('qbank_grade_practice_manually', {
      id: 'draft1',
      questionId: 'q1',
      correct: true,
      score: 85,
    });
  });

  await waitFor(() => {
    expect(screen.getByTestId('batch-total-score-summary')).toHaveTextContent(
      '综合得分 85分 · 得分率 85%（满分率 100%）',
    );
    expect(screen.getByText('正确 1 题')).toBeInTheDocument();
  });
});

it('shows concrete fallback rationale instead of bare numeric score when tags-only or empty feedback arrives for 68/100 (S2-05)', async () => {
  const base = draft();
  const attempt = submittedAttempt('partial', {
    questions: [
      { ...base.questions[0], question_type: 'short_answer', options: [], answer: '关键要点A与要点B' },
    ],
    answers: { q1: '只写了要点A' },
    results: [
      {
        question_id: 'q1',
        status: 'partial',
        is_correct: false,
        score: 68,
        feedback: '<verdict>partial</verdict><score value="68" />',
        error: null,
        source_available: true,
        submission_id: 'sub-tags-only',
      },
    ],
  });

  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') return { ...base.questions[0], is_favorite: false };
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    return undefined;
  });

  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('First question');

  const rationale = screen.getByTestId('practice-ai-grading-rationale');
  expect(rationale).toHaveTextContent('68 / 100 分');
  expect(rationale).toHaveTextContent('关键要点A与要点B');
  expect(rationale.textContent).not.toContain('<verdict>');
});

it('shows AI grading status banner during pending_count > 0, announces 40 -> 60 completion transition, and persists manual 100 -> 0 / 50 regrade across reload with intact rubric table (S2-05)', async () => {
  const base = draft();
  const fiveQuestions = [
    { ...base.questions[0], id: 'q1', content: 'Obj Q1' },
    { ...base.questions[0], id: 'q2', content: 'Obj Q2' },
    { ...base.questions[0], id: 'q3', content: 'Obj Q3' },
    { ...base.questions[0], id: 'q4', content: 'Obj Q4' },
    {
      ...base.questions[0],
      id: 'q5',
      content: 'Subjective Q5',
      question_type: 'short_answer' as const,
      options: [],
      answer: '标准推导步骤',
    },
  ];

  let attempt: PracticeAttempt = submittedAttempt('pending', {
    status: 'grading',
    questions: fiveQuestions,
    answers: { q1: 'A', q2: 'A', q3: 'B', q4: 'B', q5: '学生主观题作答' },
    results: [
      { question_id: 'q1', status: 'correct', is_correct: true, score: 100, feedback: null, error: null, source_available: true, submission_id: 's1' },
      { question_id: 'q2', status: 'correct', is_correct: true, score: 100, feedback: null, error: null, source_available: true, submission_id: 's2' },
      { question_id: 'q3', status: 'incorrect', is_correct: false, score: 0, feedback: null, error: null, source_available: true, submission_id: 's3' },
      { question_id: 'q4', status: 'incorrect', is_correct: false, score: 0, feedback: null, error: null, source_available: true, submission_id: 's4' },
      { question_id: 'q5', status: 'pending', is_correct: null, score: null, feedback: null, error: null, source_available: true, submission_id: 's5' },
    ],
  });

  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === 'qbank_get_practice') return attempt;
    if (command === 'qbank_get_question') return { ...fiveQuestions[0], is_favorite: false };
    if (command === 'qbank_get_history') return [];
    if (command === 'qbank_resume_practice_grading') return;
    if (command === 'qbank_grade_practice_manually') {
      const nextScore = typeof args.score === 'number' ? args.score : args.correct ? 100 : 0;
      const nextStatus: PracticeResult['status'] =
        nextScore === 0 ? 'incorrect' : nextScore >= 80 ? 'correct' : 'partial';
      attempt = {
        ...attempt,
        results: attempt.results.map((r) =>
          r.question_id === args.questionId
            ? {
                ...r,
                score: nextScore,
                status: nextStatus,
                is_correct: nextScore >= 80,
                feedback: `${(r.feedback ?? '').replace(/<manual_override\b[^>]*\/>/gi, '').trim()}\n<manual_override score="${nextScore}" status="${nextStatus}" original_score="100" original_status="correct"/>`,
              }
            : r,
        ),
      };
      return attempt;
    }
    return undefined;
  });

  const { unmount } = render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('Obj Q1');

  // 1. Initial pending state: 40 pts and visible role="status" AI grading banner
  expect(screen.getByTestId('batch-total-score-summary')).toHaveTextContent('得分 40分 · 准确率 40%');
  const gradingBanner = screen.getByTestId('practice-ai-grading-banner');
  expect(gradingBanner).toHaveAttribute('role', 'status');
  expect(gradingBanner).toHaveTextContent('AI 正在批改 1 道主观题...');

  // 2. Subjective grading finishes -> transitions pending_count 1 -> 0, score 40 -> 60
  attempt = {
    ...attempt,
    status: 'completed',
    results: attempt.results.map((r) =>
      r.question_id === 'q5'
        ? {
            ...r,
            status: 'correct',
            is_correct: true,
            score: 100,
            feedback:
              '本题满分作答。\n| 评分项 | 满分 | 得分 | 说明 | | --- | --- | --- | --- | | 核心公式 | 50 | 50 | 推导正确 | | 结论完整 | 50 | 50 | 表述清晰 |\n<verdict>correct</verdict><score value="100"/>',
          }
        : r,
    ),
  };

  const onPracticeUpdated = mocks.listeners.get('qbank-practice-updated');
  expect(onPracticeUpdated).toBeDefined();
  await act(async () => {
    await onPracticeUpdated?.({ payload: 'draft1' });
  });

  await waitFor(() => {
    expect(screen.queryByTestId('practice-ai-grading-banner')).toBeNull();
    expect(screen.getByTestId('batch-total-score-summary')).toHaveTextContent('得分 60分 · 准确率 60%');
  });
  expect(mocks.notify).toHaveBeenCalledWith('success', '主观题批改完成：总分 40 → 60');
  const completeBanner = screen.getByTestId('practice-ai-grading-complete-banner');
  expect(completeBanner).toHaveAttribute('role', 'status');
  expect(completeBanner).toHaveTextContent('主观题批改完成：总分 40 → 60');

  // 3. Navigate to Q5 and inspect rendered rubric markdown table
  fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: /第\s*5\s*题/ })[0]!);
  await screen.findByText('Subjective Q5');

  const rationale = screen.getByTestId('practice-ai-grading-rationale');
  expect(rationale.textContent).toContain('| 评分项 | 满分 | 得分 | 说明 |');
  expect(rationale.textContent).toContain('| 核心公式 | 50 | 50 | 推导正确 |');
  expect(rationale.textContent).toContain('| 结论完整 | 50 | 50 | 表述清晰 |');
  expect(rationale.textContent).not.toContain('<verdict>');
  expect(rationale.textContent).not.toContain('<score');

  // 4. Manual override 100 -> 0 updates header (60 -> 40), verdict bar, and override badge immediately
  fireEvent.click(screen.getByTestId('practice-manual-override-toggle'));
  fireEvent.click(screen.getByRole('button', { name: '0 分' }));
  fireEvent.click(screen.getByTestId('practice-manual-override-save'));

  await waitFor(() => {
    expect(screen.getByTestId('batch-total-score-summary')).toHaveTextContent('得分 40分 · 准确率 40%');
    expect(screen.getByTestId('practice-question-verdict-bar')).toHaveTextContent('回答错误 · 0/100');
    expect(screen.getByTestId('practice-question-verdict-bar')).toHaveTextContent('已人工改判为 0/100');
    expect(screen.getByTestId('practice-manual-override-banner')).toHaveTextContent(
      '已人工改判为 0/100（原 AI 评分：100/100）',
    );
  });

  // 5. Simulate full page reload (unmount + fresh mount reading persisted attempt)
  unmount();
  render(<BatchPracticeWorkspace practiceId="draft1" submitted onBack={vi.fn()} />);
  await screen.findByText('Obj Q1');
  expect(screen.getByTestId('batch-total-score-summary')).toHaveTextContent('得分 40分 · 准确率 40%');

  fireEvent.click(screen.getAllByRole('button', { name: '答题卡' })[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: /第\s*5\s*题/ })[0]!);
  await screen.findByText('Subjective Q5');
  expect(screen.getByTestId('practice-question-verdict-bar')).toHaveTextContent('回答错误 · 0/100');
  expect(screen.getByTestId('practice-manual-override-banner')).toHaveTextContent(
    '已人工改判为 0/100（原 AI 评分：100/100）',
  );
});
