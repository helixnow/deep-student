import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MockExamScoreCard } from '@/stores/questionBankStore';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  generateMockExam: vi.fn(),
  submitMockExam: vi.fn(),
  setMockExamSession: vi.fn(),
  notify: vi.fn(),
  mockExamSession: null as unknown,
  mockExamScoreCard: null as MockExamScoreCard | null,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: mocks.notify,
}));
vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isWebUiShell: () => true,
}));
vi.mock('@/utils/urlOpener', () => ({
  isTauriEnvironment: () => false,
}));
vi.mock('@/stores/questionBankStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/questionBankStore')>();
  return {
    ...actual,
    useQuestionBankStore: Object.assign(
      (selector?: (state: Record<string, unknown>) => unknown) => {
        const state = {
          mockExamSession: mocks.mockExamSession,
          mockExamScoreCard: mocks.mockExamScoreCard,
          setMockExamSession: mocks.setMockExamSession,
          generateMockExam: mocks.generateMockExam,
          submitMockExam: mocks.submitMockExam,
          isLoadingPractice: false,
          questions: new Map(),
        };
        return selector ? selector(state) : state;
      },
      {
        getState: () => ({
          mockExamSession: mocks.mockExamSession,
          mockExamScoreCard: mocks.mockExamScoreCard,
          setCurrentQuestion: vi.fn(),
        }),
      },
    ),
  };
});

import '@/i18n';
import { CsvImportDialog } from '@/components/CsvImportDialog';
import { MockExamMode } from '../MockExamMode';

describe('S2-05 CSV batch import & mixed subjective mock exam', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.generateMockExam.mockReset();
    mocks.submitMockExam.mockReset();
    mocks.setMockExamSession.mockReset();
    mocks.notify.mockReset();
    mocks.mockExamSession = null;
    mocks.mockExamScoreCard = null;
  });

  it('invokes qbank_batch_create_questions with { paramsList } and preserves short_answer type on WebUI CSV import', async () => {
    mocks.invoke.mockResolvedValue([]);

    render(<CsvImportDialog open onOpenChange={vi.fn()} examId="exam-1" examName="概率论" />);

    const fileInput = screen.getByTestId('qbank-csv-file-input') as HTMLInputElement;
    const csvContent = '题目,题型,选项,答案,解析\n简述贝叶斯公式的意义,简答题,,先验概率结合似然得到后验概率,核心推理\n单选一,单选题,A.对|B.错,A,解析';
    const csvFile = {
      name: 'mixed.csv',
      type: 'text/csv',
      text: async () => csvContent,
    } as unknown as File;

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [csvFile] } });
    });

    await screen.findByText('字段映射');
    fireEvent.click(screen.getByRole('button', { name: /下一页|下一步/ }));
    await screen.findByText(/开始导入/);
    fireEvent.click(screen.getByRole('button', { name: /开始导入/ }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith('qbank_batch_create_questions', {
        paramsList: [
          expect.objectContaining({
            exam_id: 'exam-1',
            content: '简述贝叶斯公式的意义',
            question_type: 'short_answer',
            options: null,
            answer: '先验概率结合似然得到后验概率',
          }),
          expect.objectContaining({
            exam_id: 'exam-1',
            content: '单选一',
            question_type: 'single_choice',
            answer: 'A',
          }),
        ],
      });
    });
  });

  it('honors explicit type distribution count (short_answer: 1) without padding 30 single-choice questions and localizes ShortAnswer in ScoreCard', async () => {
    mocks.generateMockExam.mockResolvedValue({
      id: 'mock-1',
      exam_id: 'exam-1',
      config: {
        duration_minutes: 60,
        type_distribution: { short_answer: 1 },
        difficulty_distribution: {},
        total_count: 1,
        shuffle: true,
        include_mistakes: true,
      },
      question_ids: ['q-short'],
      started_at: '2026-11-24T00:00:00Z',
      ended_at: null,
      answers: {},
      results: {},
      is_submitted: false,
      score: null,
      correct_rate: null,
    });

    const { rerender } = render(<MockExamMode examId="exam-1" />);
    const increaseShortAnswer = screen.getByRole('button', { name: /增加.*简答题|stepper\.increase/ });
    fireEvent.click(increaseShortAnswer);
    fireEvent.click(screen.getByRole('button', { name: /开始考试/ }));

    await waitFor(() => {
      expect(mocks.generateMockExam).toHaveBeenCalledWith(
        'exam-1',
        expect.objectContaining({
          type_distribution: { short_answer: 1 },
          total_count: 1,
        }),
      );
    });

    mocks.mockExamSession = {
      id: 'mock-1',
      exam_id: 'exam-1',
      config: {
        duration_minutes: 60,
        type_distribution: { short_answer: 1 },
        difficulty_distribution: {},
        total_count: 1,
        shuffle: true,
        include_mistakes: true,
      },
      question_ids: ['q-short'],
      started_at: '2026-11-24T00:00:00Z',
      ended_at: '2026-11-24T00:05:00Z',
      answers: { 'q-short': '我的回答' },
      results: { 'q-short': true },
      is_submitted: true,
      score: 100,
      correct_rate: 100,
    };
    mocks.mockExamScoreCard = {
      session_id: 'mock-1',
      exam_id: 'exam-1',
      total_count: 1,
      answered_count: 1,
      correct_count: 1,
      wrong_count: 0,
      unanswered_count: 0,
      correct_rate: 100,
      time_spent_seconds: 300,
      type_stats: {
        ShortAnswer: { total: 1, correct: 1, rate: 100 },
      },
      difficulty_stats: {},
      wrong_question_ids: [],
      comment: '优秀！',
      completed_at: '2026-11-24T00:05:00Z',
    };

    rerender(<MockExamMode examId="exam-1" />);
    expect(await screen.findByText('简答题')).toBeInTheDocument();
  });
});
