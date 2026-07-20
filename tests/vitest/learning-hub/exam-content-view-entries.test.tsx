import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetExamSheetSessionDetail, mockResumeQuestionImport, mockInvoke } = vi.hoisted(() => ({
  mockGetExamSheetSessionDetail: vi.fn(),
  mockResumeQuestionImport: vi.fn(),
  mockInvoke: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  focusMode: false,
  mockExamSession: null,
  timedSession: null,
  dailyPractice: null,
  generatedPaper: null,
  setFocusMode: vi.fn(),
  setMockExamSession: vi.fn(),
}));

const hookState = vi.hoisted(() => ({
  questions: [
    {
      id: 'q_1',
      cardId: 'card_q_1',
      questionLabel: 'Q1',
      content: 'Question 1',
      ocrText: 'Question 1',
      questionType: 'single_choice',
      options: [],
      answer: 'A',
      explanation: 'Explanation 1',
      difficulty: 'easy',
      tags: ['tag-1'],
      status: 'new',
      userAnswer: '',
      isCorrect: null,
      userNote: '',
      attemptCount: 0,
      correctCount: 0,
      lastAttemptAt: undefined,
      isFavorite: true,
      images: [],
    },
  ],
  currentIndex: 0,
  stats: {
    total: 1,
    mastered: 0,
    review: 0,
    inProgress: 0,
    newCount: 1,
    correctRate: 0,
  },
  isLoading: false,
  error: null,
  loadQuestions: vi.fn(),
  submitAnswer: vi.fn(),
  markCorrect: vi.fn(),
  navigate: vi.fn(),
  setPracticeMode: vi.fn(),
  practiceMode: 'sequential',
  refreshStats: vi.fn(),
  refreshQuestion: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (key === 'editor.discardDraftTitle') return '放弃未提交的内容？';
      if (key === 'editor.discardDraftDescription') return '离开当前视图会清除尚未提交或保存的内容。';
      if (key === 'common:actions.discard') return '放弃';
      return typeof fallback === 'string' ? fallback : key;
    },
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getExamSheetSessionDetail: mockGetExamSheetSessionDetail,
    resumeQuestionImport: mockResumeQuestionImport,
  },
}));

vi.mock('@/hooks/useQuestionBankSession', () => ({
  useQuestionBankSession: () => hookState,
}));

vi.mock('@/stores/questionBankStore', () => ({
  useQuestionBankStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
  // 真实签名: (value: unknown, expectedExamId: string) => QbankPracticeHandoff | PracticeHandoffHydrationFailure
  // ExamContentView 顶层具名导入并在 hydratePracticeSession 分支调用；mock 默认返回校验失败
  validateQbankPracticeHandoff: vi.fn((_value: unknown, _expectedExamId: string) => ({
    ok: false as const,
    code: 'INVALID_PRACTICE_HANDOFF' as const,
    hint: 'mocked validator',
  })),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/debug-panel/plugins/ExamSheetProcessingDebugPlugin', () => ({
  emitExamSheetDebug: vi.fn(),
}));

vi.mock('@/components/QuestionBankEditor', () => ({
  default: ({ onDraftDirtyChange }: { onDraftDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="question-bank-editor">
      <button type="button" onClick={() => onDraftDirtyChange?.(true)}>
        mark answer draft
      </button>
      <button type="button" onClick={() => onDraftDirtyChange?.(false)}>
        clear answer draft
      </button>
    </div>
  ),
}));

vi.mock('@/components/QuestionBankListView', () => ({
  default: () => <div data-testid="question-bank-list-view" />,
}));

vi.mock('@/components/ReviewQuestionsView', () => ({
  default: () => <div data-testid="review-questions-view" />,
}));

vi.mock('@/components/TagNavigationView', () => ({
  default: () => <div data-testid="tag-navigation-view" />,
}));

vi.mock('@/components/practice/PracticeLauncher', () => ({
  default: ({ onStartPractice }: { onStartPractice?: (mode: string) => void }) => (
    <div data-testid="practice-launcher">
      <button type="button" onClick={() => onStartPractice?.('sequential')}>
        start sequential practice
      </button>
    </div>
  ),
}));

vi.mock('@/components/QuestionBankStatsView', () => ({
  default: () => <div data-testid="question-bank-stats-view" />,
}));

vi.mock('@/components/QuestionFavoritesView', () => ({
  default: () => <div data-testid="question-favorites-view" />,
}));

vi.mock('@/components/QuestionBankManageView', () => ({
  default: ({ onCsvImport, onCsvExport }: { onCsvImport?: () => void; onCsvExport?: () => void }) => (
    <div data-testid="question-bank-manage-view">
      <button type="button" title="CSV 导入" onClick={() => onCsvImport?.()}>
        import
      </button>
      <button type="button" title="导出" onClick={() => onCsvExport?.()}>
        export
      </button>
    </div>
  ),
}));

vi.mock('@/components/CsvImportDialog', () => ({
  default: () => null,
  // CSV 导入已从模态框改为内嵌面板（viewMode = 'csvImport'）
  CsvImportPanel: () => <div data-testid="csv-import-panel" />,
}));

vi.mock('@/components/QuestionBankExportDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="question-bank-export-dialog" /> : null),
}));

import ExamContentView from '@/features/learning-hub/apps/views/ExamContentView';

const findButton = (patterns: RegExp[]) => {
  const buttons = screen.queryAllByRole('button');
  return buttons.find((button) => {
    const text = [button.textContent, button.getAttribute('title'), button.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    return patterns.some((pattern) => pattern.test(text));
  });
};

// 二级视图（管理/统计/收藏等）已收纳进 Tab 栏的「更多」菜单：
// 先点开菜单触发器，再点击对应的 menuitem
const openSecondaryMenuItem = async (patterns: RegExp[]) => {
  const moreTrigger = findButton([/更多/i, /learningHub:exam\.tab\.more/i]);
  expect(moreTrigger).toBeTruthy();
  fireEvent.click(moreTrigger!);
  const items = await screen.findAllByRole('menuitem');
  const item = items.find((el) => patterns.some((pattern) => pattern.test(el.textContent ?? '')));
  expect(item).toBeTruthy();
  fireEvent.click(item!);
};

describe('ExamContentView secondary entry points', () => {
  beforeEach(() => {
    storeState.focusMode = false;
    storeState.mockExamSession = null;
    storeState.timedSession = null;
    storeState.dailyPractice = null;
    storeState.generatedPaper = null;
    storeState.setFocusMode.mockReset();
    storeState.setMockExamSession.mockReset();

    mockInvoke.mockReset();
    mockGetExamSheetSessionDetail.mockReset();
    mockResumeQuestionImport.mockReset();
    hookState.loadQuestions.mockReset();
    hookState.submitAnswer.mockReset();
    hookState.markCorrect.mockReset();
    hookState.navigate.mockReset();
    hookState.setPracticeMode.mockReset();
    hookState.refreshStats.mockReset();
    hookState.refreshQuestion.mockReset();

    mockGetExamSheetSessionDetail.mockResolvedValue({
      summary: { status: 'ready', exam_name: 'Exam 1' },
      preview: { pages: [] },
    });
  });

  it('exposes management entry and opens CSV import/export dialogs from the manage view', async () => {
    render(
      <ExamContentView
        node={{
          id: 'exam_1',
          name: 'Exam 1',
          type: 'exam',
          path: '/exam_1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as any}
      />,
    );

    await waitFor(() => {
      expect(mockGetExamSheetSessionDetail).toHaveBeenCalled();
    }, { timeout: 5000 });

    await openSecondaryMenuItem([/管理/i, /manage/i, /learningHub:exam\.tab\.manage/i]);

    await waitFor(() => {
      expect(screen.getByTitle(/CSV 导入|import/i)).toBeInTheDocument();
      expect(screen.getByTitle(/导出|export/i)).toBeInTheDocument();
    }, { timeout: 5000 });

    fireEvent.click(screen.getByTitle(/CSV 导入|import/i));
    // CSV 导入已改为内嵌面板视图（不再弹出模态框），管理视图随之卸载
    await waitFor(() => {
      expect(screen.getByTestId('csv-import-panel')).toBeInTheDocument();
    }, { timeout: 5000 });

    // 导出对话框仍挂载在背景层，先从内嵌 CSV 视图返回管理视图
    await openSecondaryMenuItem([/管理/i, /manage/i, /learningHub:exam\.tab\.manage/i]);
    fireEvent.click(screen.getByTitle(/导出|export/i));
    await waitFor(() => {
      expect(screen.getByTestId('question-bank-export-dialog')).toBeInTheDocument();
    }, { timeout: 5000 });
  });

  it('confirms before a dirty practice draft can leave the editor', async () => {
    render(
      <ExamContentView
        node={{
          id: 'exam_1',
          name: 'Exam 1',
          type: 'exam',
          path: '/exam_1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as any}
      />,
    );

    await waitFor(() => expect(mockGetExamSheetSessionDetail).toHaveBeenCalled(), { timeout: 5000 });

    const practiceButton = findButton([/练习/i, /practice/i, /learningHub:exam\.tab\.practice/i]);
    expect(practiceButton).toBeTruthy();
    fireEvent.click(practiceButton!);
    fireEvent.click(await screen.findByRole('button', { name: /start sequential practice/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark answer draft/i }));

    await openSecondaryMenuItem([/管理/i, /manage/i, /learningHub:exam\.tab\.manage/i]);

    expect(await screen.findByText('放弃未提交的内容？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /放弃/i }));

    await waitFor(() => {
      expect(screen.getByTestId('question-bank-manage-view')).toBeInTheDocument();
    });
  });

  it('defers a qbank refresh until an unfocused draft is clean', async () => {
    render(
      <ExamContentView
        node={{
          id: 'exam_1',
          name: 'Exam 1',
          type: 'exam',
          path: '/exam_1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as any}
      />,
    );

    await waitFor(() => expect(mockGetExamSheetSessionDetail).toHaveBeenCalled(), { timeout: 5000 });
    const practiceButton = findButton([/练习/i, /practice/i, /learningHub:exam\.tab\.practice/i]);
    fireEvent.click(practiceButton!);
    fireEvent.click(await screen.findByRole('button', { name: /start sequential practice/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark answer draft/i }));

    hookState.loadQuestions.mockClear();
    hookState.refreshStats.mockClear();
    window.dispatchEvent(new CustomEvent('qbank:refresh', {
      detail: { source: 'agent', action: 'update', entityIds: ['q_1'] },
    }));

    await Promise.resolve();
    expect(hookState.loadQuestions).not.toHaveBeenCalled();
    expect(hookState.refreshStats).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /clear answer draft/i }));
    await waitFor(() => {
      expect(hookState.loadQuestions).toHaveBeenCalledTimes(1);
      expect(hookState.refreshStats).toHaveBeenCalledTimes(1);
    });
  });
});
