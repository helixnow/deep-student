import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PracticeDraft, PracticeAttempt, PracticeResult } from '@/api/practiceApi';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));

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
  expect(screen.getByText('SECRET EXPLANATION')).toBeInTheDocument();
  expect(
    screen.queryByText('LIVE QUESTION EXPLANATION DIFFERENT FROM SNAPSHOT'),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: /写入解析/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /替换现有解析/ })).toBeNull();
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
