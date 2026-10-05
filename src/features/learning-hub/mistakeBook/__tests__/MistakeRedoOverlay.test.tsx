import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  session: null as unknown as Record<string, unknown>,
  editorProps: null as unknown as Record<string, unknown> | null,
  refreshTodayLearning: vi.fn(),
  t: (key: string, options?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      'learningHub:mistakeBook.redoSet.title': '错题重做',
      'learningHub:mistakeBook.redoSet.from': `出自「${options?.exam}」`,
      'learningHub:mistakeBook.redoSet.loading': '正在准备这套错题…',
      'learningHub:mistakeBook.redoSet.skipped': `已跳过 ${options?.count} 道已删除的题`,
      'learningHub:mistakeBook.loadFailed': '错题加载失败',
      'learningHub:mistakeBook.untitledExam': '未命名题目集',
      'common:close': '关闭',
    };
    return map[key] ?? key;
  },
}));

vi.mock('../useMistakeRedoSession', () => ({
  MISTAKE_REDO_SESSION_KEY: '__mistake_redo__',
  useMistakeRedoSession: () => mocks.session,
}));
vi.mock('@/components/QuestionBankEditor', () => ({
  QuestionBankEditor: (props: Record<string, unknown>) => {
    mocks.editorProps = props;
    return <div data-testid="editor" />;
  },
}));
vi.mock('@/features/learning-today/todayLearningStore', () => ({ refreshTodayLearning: mocks.refreshTodayLearning }));
vi.mock('@/app/navigation/androidBackCoordinator', () => ({
  BACK_PRIORITY: { overlay: 100 },
  registerBackHandler: vi.fn(() => () => undefined),
}));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: mocks.t }),
}));

import { MistakeRedoOverlay } from '../MistakeRedoOverlay';

const owner = { examId: '__mistake_redo__', viewInstanceId: 'v1' };

function sessionWith(overrides: Record<string, unknown>) {
  return {
    owner,
    phase: { kind: 'ready' },
    missing: 0,
    questions: [{ id: 'q1' }, { id: 'q3' }],
    currentIndex: 1,
    currentExamId: 'exam-b',
    navigate: vi.fn(),
    submitAnswer: vi.fn(),
    markCorrect: vi.fn(),
    refreshQuestion: vi.fn(),
    toggleFavorite: vi.fn(),
    ...overrides,
  };
}

describe('MistakeRedoOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.editorProps = null;
  });

  it('hands the set to the practice editor under the current question’s own question set', () => {
    mocks.session = sessionWith({ missing: 1 });
    const onClose = vi.fn();
    render(<MistakeRedoOverlay questionIds={['q1', 'q2', 'q3']} examNames={{ 'exam-a': '高数', 'exam-b': '英语' }} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: '错题重做' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('出自「英语」')).toBeInTheDocument();
    expect(screen.getByText('已跳过 1 道已删除的题')).toBeInTheDocument();
    expect(mocks.editorProps).toMatchObject({
      sessionId: 'exam-b',
      practiceSessionOwner: owner,
      questions: [{ id: 'q1' }, { id: 'q3' }],
      currentIndex: 1,
      practiceMode: 'sequential',
      showTimer: false,
    });
    expect(mocks.editorProps?.onModeChange).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.refreshTodayLearning).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape while loading and shows load errors', () => {
    mocks.session = sessionWith({ phase: { kind: 'loading' } });
    const onClose = vi.fn();
    const { rerender } = render(<MistakeRedoOverlay questionIds={['q1']} examNames={{}} onClose={onClose} />);
    expect(screen.getByText('正在准备这套错题…')).toBeInTheDocument();
    expect(screen.queryByTestId('editor')).toBeNull();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    mocks.session = sessionWith({ phase: { kind: 'error', message: 'db locked' } });
    rerender(<MistakeRedoOverlay questionIds={['q1']} examNames={{}} onClose={onClose} />);
    expect(screen.getByText('错题加载失败')).toBeInTheDocument();
    expect(screen.getByText('db locked')).toBeInTheDocument();
  });
});
