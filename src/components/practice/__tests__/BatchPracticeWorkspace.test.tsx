import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PracticeDraft, PracticeAttempt } from '@/api/practiceApi';

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
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

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  mocks.invoke.mockReset();
});
afterEach(cleanup);

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
