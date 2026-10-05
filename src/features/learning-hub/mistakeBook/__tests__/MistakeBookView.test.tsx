import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listMistakes: vi.fn(),
  openQuestionInExam: vi.fn(),
  openDueMistakesReview: vi.fn(),
}));

vi.mock('../mistakeBookApi', () => ({ listMistakes: mocks.listMistakes }));
vi.mock('../mistakeBookNavigation', () => ({ openQuestionInExam: mocks.openQuestionInExam }));
vi.mock('@/features/learning-today/dueMistakesReview', () => ({ openDueMistakesReview: mocks.openDueMistakesReview }));
vi.mock('@/components/practice/QuestionFollowUpBar', () => ({
  QuestionFollowUpBar: () => <div data-testid="follow-up" />,
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'learningHub:mistakeBook.summary': `${options?.count} 道错题 · 来自 ${options?.exams} 个题目集`,
        'learningHub:mistakeBook.summaryFiltered': `筛选出 ${options?.count} 道 · 共 ${options?.all} 道错题`,
        'learningHub:mistakeBook.reviewDue': '复习到期错题',
        'learningHub:mistakeBook.refresh': '刷新错题本',
        'learningHub:mistakeBook.examFilter': '按题目集筛选',
        'learningHub:mistakeBook.allExams': '全部题目集',
        'learningHub:mistakeBook.sortLabel': '错题排序',
        'learningHub:mistakeBook.sort.recent': '最近做错',
        'learningHub:mistakeBook.sort.errors': '错得最多',
        'learningHub:mistakeBook.wrongTimes': `错 ${options?.count} 次`,
        'learningHub:mistakeBook.myAnswer': '我的答案',
        'learningHub:mistakeBook.correctAnswer': '正确答案',
        'learningHub:mistakeBook.redo': '去题目集重做',
        'learningHub:mistakeBook.empty': '还没有错题',
        'learningHub:mistakeBook.noMatches': '没有匹配的错题',
        'review:questionType.single_choice': '单选题',
        'review:questions.errorCause.neverCorrect': '从未答对',
      };
      return map[key] ?? key;
    },
  }),
}));

import { MistakeBookView } from '../MistakeBookView';

const question = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  questionLabel: '',
  content: `题干 ${id}`,
  questionType: 'single_choice',
  answer: 'A',
  userAnswer: 'B',
  attemptCount: 2,
  correctCount: 0,
  lastAttemptAt: new Date().toISOString(),
  ...overrides,
});

const page = (items: Array<{ id: string; examId: string; examName: string }>, overrides: Record<string, unknown> = {}) => ({
  items: items.map(({ id, examId, examName }) => ({ question: question(id), examId, examName })),
  total: items.length,
  page: 1,
  hasMore: false,
  exams: [
    { examId: 'exam-a', examName: '高数', count: 2 },
    { examId: 'exam-b', examName: '英语', count: 1 },
  ],
  ...overrides,
});

describe('MistakeBookView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists mistakes across question sets and opens one back in its set', async () => {
    mocks.listMistakes.mockResolvedValue(page([
      { id: 'q1', examId: 'exam-a', examName: '高数' },
      { id: 'q2', examId: 'exam-b', examName: '英语' },
    ], { total: 3 }));
    render(<MistakeBookView search="" />);

    expect(await screen.findByText('题干 q1')).toBeInTheDocument();
    expect(mocks.listMistakes).toHaveBeenCalledWith({ examId: null, search: '', sort: 'recent', page: 1 });
    expect(screen.getByText('3 道错题 · 来自 2 个题目集')).toBeInTheDocument();
    expect(screen.getByText(/高数 · 单选题 · 错 2 次/)).toBeInTheDocument();
    expect(screen.getAllByText('从未答对')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /题干 q1/ }));
    expect(screen.getByText('我的答案')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
    expect(screen.getByTestId('follow-up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '去题目集重做' }));
    expect(mocks.openQuestionInExam).toHaveBeenCalledWith('exam-a', 'q1');

    fireEvent.click(screen.getByRole('button', { name: '复习到期错题' }));
    expect(mocks.openDueMistakesReview).toHaveBeenCalled();
  });

  it('refetches with the chosen question set and sort', async () => {
    mocks.listMistakes.mockResolvedValue(page([{ id: 'q1', examId: 'exam-a', examName: '高数' }]));
    render(<MistakeBookView search="极限" />);
    await screen.findByText('题干 q1');

    fireEvent.change(screen.getByLabelText('按题目集筛选'), { target: { value: 'exam-b' } });
    await waitFor(() => expect(mocks.listMistakes).toHaveBeenLastCalledWith(
      { examId: 'exam-b', search: '极限', sort: 'recent', page: 1 },
    ));

    fireEvent.click(screen.getByRole('radio', { name: '错得最多' }));
    await waitFor(() => expect(mocks.listMistakes).toHaveBeenLastCalledWith(
      { examId: 'exam-b', search: '极限', sort: 'errors', page: 1 },
    ));
    expect(screen.getByText('筛选出 1 道 · 共 3 道错题')).toBeInTheDocument();
  });

  it('says so when there are no mistakes yet', async () => {
    mocks.listMistakes.mockResolvedValue({ items: [], total: 0, page: 1, hasMore: false, exams: [] });
    render(<MistakeBookView search="" />);
    expect(await screen.findByText('还没有错题')).toBeInTheDocument();
    expect(screen.queryByLabelText('按题目集筛选')).toBeNull();
  });
});
