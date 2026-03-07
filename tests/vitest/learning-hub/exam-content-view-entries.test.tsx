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
  syncConflicts: [],
  mockExamSession: null,
  timedSession: null,
  dailyPractice: null,
  generatedPaper: null,
  setFocusMode: vi.fn(),
  checkSyncStatus: vi.fn(),
  getSyncConflicts: vi.fn(),
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
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
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

vi.mock('@/components/SyncConflictDialog', () => ({
  default: () => null,
}));

vi.mock('@/components/QuestionBankEditor', () => ({
  default: () => <div data-testid="question-bank-editor" />,
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
  default: () => <div data-testid="practice-launcher" />,
}));

vi.mock('@/components/QuestionBankStatsView', () => ({
  default: () => <div data-testid="question-bank-stats-view" />,
}));

vi.mock('@/components/QuestionFavoritesView', () => ({
  default: () => <div data-testid="question-favorites-view" />,
}));

vi.mock('@/components/CsvImportDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="csv-import-dialog" /> : null),
}));

vi.mock('@/components/QuestionBankExportDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="question-bank-export-dialog" /> : null),
}));

const findButton = (patterns: RegExp[]) => {
  const buttons = screen.queryAllByRole('button');
  return buttons.find((button) => {
    const text = [button.textContent, button.getAttribute('title'), button.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    return patterns.some((pattern) => pattern.test(text));
  });
};

describe('ExamContentView secondary entry points', () => {
  beforeEach(() => {
    storeState.focusMode = false;
    storeState.syncConflicts = [];
    storeState.mockExamSession = null;
    storeState.timedSession = null;
    storeState.dailyPractice = null;
    storeState.generatedPaper = null;
    storeState.setFocusMode.mockReset();
    storeState.checkSyncStatus.mockReset();
    storeState.getSyncConflicts.mockReset();
    storeState.setMockExamSession.mockReset();
    storeState.checkSyncStatus.mockResolvedValue({ pending_conflict_count: 0 });
    storeState.getSyncConflicts.mockResolvedValue([]);

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
    const { default: ExamContentView } = await import('@/components/learning-hub/apps/views/ExamContentView');

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
    });

    const manageButton = findButton([/管理/i, /manage/i, /learningHub:exam\.tab\.manage/i]);
    expect(manageButton).toBeTruthy();
    fireEvent.click(manageButton!);

    await waitFor(() => {
      expect(screen.getByTitle(/CSV 导入|import/i)).toBeInTheDocument();
      expect(screen.getByTitle(/导出|export/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/CSV 导入|import/i));
    await waitFor(() => {
      expect(screen.getByTestId('csv-import-dialog')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle(/导出|export/i));
    await waitFor(() => {
      expect(screen.getByTestId('question-bank-export-dialog')).toBeInTheDocument();
    });
  });
});
