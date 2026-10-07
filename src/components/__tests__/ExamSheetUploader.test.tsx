import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getApiConfigurations: vi.fn(),
  getExamSheetSessionDetail: vi.fn(),
  updateExamSheetCards: vi.fn(),
  showGlobalNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/utils/tauriApi', () => ({
  TauriAPI: {
    getApiConfigurations: mocks.getApiConfigurations,
    getExamSheetSessionDetail: mocks.getExamSheetSessionDetail,
    updateExamSheetCards: mocks.updateExamSheetCards,
  },
}));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.showGlobalNotification }));
vi.mock('@/debug-panel/plugins/QuestionImportDebugPlugin', () => ({ emitImportDebug: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));
vi.mock('../custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../LatexText', () => ({
  LatexText: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('@/components/shared/UnifiedDragDropZone', () => ({
  DEFAULT_MAX_UPLOAD_FILE_SIZE: 50 * 1024 * 1024,
  UnifiedDragDropZone: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dropzone-wrapper" className={className}>{children}</div>
  ),
}));
vi.mock('@/components/shared/UnifiedModelSelector', () => ({
  UnifiedModelSelector: ({ models }: { models: Array<{ id: string; name: string }> }) => (
    <select data-testid="model-select">
      {models.map(m => <option key={m.id}>{m.name}</option>)}
    </select>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'count' in opts) return `${key}:${opts.count}`;
      if (opts && typeof opts === 'object' && 'error' in opts) return `${key}:${opts.error}`;
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ExamSheetUploader, buildImportSummary } from '../ExamSheetUploader';

const card = (id: string, extra: Record<string, unknown> = {}) => ({
  card_id: id,
  ocr_text: `question ${id}`,
  question_type: 'single_choice',
  ...extra,
});

const detailWith = (cards: ReturnType<typeof card>[]) => ({
  summary: { id: 'exam_1' },
  preview: { pages: [{ cards }] },
}) as any;

const selectFiles = (files: File[]) => {
  const input = screen.getByTestId('exam-uploader-file-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
};

const docx = () => new File(['hello'], 'quiz.docx', {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

describe('buildImportSummary', () => {
  it('only counts cards added by this import when a baseline is known', () => {
    const summary = buildImportSummary(
      detailWith([card('old-1'), card('old-2'), card('new-1', { question_type: 'fill_blank' }), card('new-2', { ocr_text: ' ' })]),
      new Set(['old-1', 'old-2']),
    );
    expect(summary.cards.map(c => c.card_id)).toEqual(['new-1', 'new-2']);
    expect(summary.questionTypes).toEqual({ fill_blank: 1, single_choice: 1 });
    expect(summary.emptyQuestions).toBe(1);
  });

  it('falls back to all cards when the baseline snapshot failed', () => {
    expect(buildImportSummary(detailWith([card('a'), card('b')]), null).cards).toHaveLength(2);
  });
});

describe('ExamSheetUploader (streamlined layout)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiConfigurations.mockResolvedValue([]);
    mocks.getExamSheetSessionDetail.mockResolvedValue(detailWith([card('old-1')]));
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:preview');
    (globalThis as any).URL.revokeObjectURL = vi.fn();
  });

  it('empty state shows one title, the dropzone and the manual-create link — no stepper, tips or action bar', () => {
    render(<ExamSheetUploader sessionId="exam_1" onBack={() => {}} onManualCreate={() => {}} />);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByTestId('exam-uploader-dropzone')).toBeInTheDocument();
    expect(screen.getByText('exam_sheet:uploader.manual_create_link')).toBeInTheDocument();
    expect(screen.queryByText(/uploader\.steps\./)).toBeNull();
    expect(screen.queryByText(/uploader\.header_desc|uploader\.tips_combined/)).toBeNull();
    expect(screen.queryByTestId('exam-uploader-start')).toBeNull();
  });

  it('collapses the dropzone into a replace strip once a document is chosen and hides the empty model picker', async () => {
    render(<ExamSheetUploader sessionId="exam_1" onBack={() => {}} onManualCreate={() => {}} />);
    selectFiles([docx()]);

    expect(await screen.findByTestId('exam-uploader-selected-document')).toHaveTextContent('quiz.docx');
    expect(screen.queryByTestId('exam-uploader-dropzone')).toBeNull();
    expect(screen.getByTestId('exam-uploader-add-more')).toHaveTextContent('exam_sheet:uploader.replace_file');
    expect(screen.queryByTestId('exam-uploader-model')).toBeNull();
    expect(screen.queryByText('exam_sheet:uploader.manual_create_link')).toBeNull();
    expect(screen.getByTestId('exam-uploader-start')).toBeInTheDocument();
  });

  it('offers the model picker for images too (images go through the same model pipeline)', async () => {
    mocks.getApiConfigurations.mockResolvedValue([{ id: 'm1', name: 'Model One', model: 'x', enabled: true }]);
    render(<ExamSheetUploader sessionId="exam_1" />);
    await waitFor(() => expect(mocks.getApiConfigurations).toHaveBeenCalled());
    selectFiles([new File(['img'], 'p1.png', { type: 'image/png' })]);

    expect(await screen.findByTestId('exam-uploader-selected-images')).toBeInTheDocument();
    expect(await screen.findByTestId('exam-uploader-model')).toHaveTextContent('Model One');
    expect(screen.getByTestId('exam-uploader-add-more')).toHaveTextContent('exam_sheet:uploader.add_more_images');
  });

  it('summary lists only the newly imported questions and only deletes the ones the user unchecks', async () => {
    const onUploadSuccess = vi.fn();
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'import_question_bank_stream') {
        return detailWith([card('old-1'), card('new-1'), card('new-2')]);
      }
      return true;
    });
    mocks.updateExamSheetCards.mockResolvedValue(detailWith([card('old-1'), card('new-1')]));

    render(<ExamSheetUploader sessionId="exam_1" onUploadSuccess={onUploadSuccess} />);
    selectFiles([docx()]);
    await act(async () => {
      fireEvent.click(await screen.findByTestId('exam-uploader-start'));
    });

    const rows = await screen.findAllByTestId('exam-uploader-summary-question');
    expect(rows).toHaveLength(2);
    expect(screen.queryByText('question old-1')).toBeNull();
    expect(screen.getByText('exam_sheet:uploader.import_done:2')).toBeInTheDocument();

    fireEvent.click(rows[1].querySelector('input[type="checkbox"]')!);
    await act(async () => {
      fireEvent.click(screen.getByText('exam_sheet:uploader.view_questions_filtered:1'));
    });

    expect(mocks.updateExamSheetCards).toHaveBeenCalledWith({ session_id: 'exam_1', delete_card_ids: ['new-2'] });
    expect(onUploadSuccess).toHaveBeenCalledTimes(1);
  });

  it('shows a failure once, with retry as the primary action instead of a second retry button', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'import_question_bank_stream') throw new Error('未找到可用的模型');
      return true;
    });
    render(<ExamSheetUploader sessionId="exam_1" onBack={() => {}} />);
    selectFiles([new File(['img'], 'p1.png', { type: 'image/png' })]);
    await act(async () => {
      fireEvent.click(await screen.findByTestId('exam-uploader-start'));
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('未找到可用的模型');
    expect(alert.querySelector('button')).toBeNull();
    expect(screen.getByTestId('exam-uploader-start')).toHaveTextContent('common:retry');
    // 失败只在页内说一次，不再额外弹全局错误通知
    expect(mocks.showGlobalNotification).not.toHaveBeenCalledWith('error', expect.anything());
  });
});
