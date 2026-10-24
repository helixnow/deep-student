import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  getApiConfigurations: vi.fn(),
  getExamSheetSessionDetail: vi.fn(),
  showGlobalNotification: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('@/utils/tauriApi', () => ({ TauriAPI: {
  getApiConfigurations: mocks.getApiConfigurations,
  getExamSheetSessionDetail: mocks.getExamSheetSessionDetail,
} }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.showGlobalNotification }));
vi.mock('@/debug-panel/plugins/QuestionImportDebugPlugin', () => ({ emitImportDebug: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({ debugLog: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() } }));
vi.mock('../custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('../LatexText', () => ({ LatexText: ({ content }: { content: string }) => <span>{content}</span> }));
vi.mock('@/components/shared/UnifiedDragDropZone', () => ({
  DEFAULT_MAX_UPLOAD_FILE_SIZE: 50 * 1024 * 1024,
  UnifiedDragDropZone: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/UnifiedModelSelector', () => ({ UnifiedModelSelector: () => <select aria-label="Model" /> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: string | Record<string, unknown>) => {
    if (options && typeof options === 'object') {
      if (typeof options.defaultValue === 'string') return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, token) => String(options[token] ?? ''));
      if ('count' in options) return `${key}:${options.count}`;
      if ('error' in options) return `${key}:${options.error}`;
    }
    return key;
  } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import {
  buildQuestionSourceCoverage,
  QuestionSourceCoverage,
  QuestionSourceRangePicker,
  readQuestionSourceRangeFailure,
  type QuestionSourceDescriptor,
  type QuestionSourceRangePlan,
} from '../QuestionSourceRangePicker';
import { ExamSheetUploader } from '../ExamSheetUploader';

const plan: QuestionSourceRangePlan = {
  schema_version: 1, total_pages: 25, automatic: false, requires_user_selection: true,
  warnings: ['Separate answer and material evidence must be included.'],
  ranges: [
    { source_id: 'file1_s1', start_page: 1, end_page: 20, dependency_safe: false, chapter_labels: ['Chapter 1'] },
    { source_id: 'file1_s1', start_page: 21, end_page: 25, dependency_safe: false, chapter_labels: ['Chapter 2'] },
  ],
};
const sources: QuestionSourceDescriptor[] = [
  { source_id: 'file1_s1', name: 'questions.pdf', page_count: 25 },
  { source_id: 'file2_s1', name: 'answers.txt', page_count: null },
  { source_id: 'file3_s1', name: 'materials.pdf', page_count: 2 },
];
const rangeError = () => ({
  message: 'Provider context limit',
  details: { code: 'SOURCE_RANGE_PLAN_REQUIRED', plan, sources, session_id: 'created_exam' },
});
const detail = { summary: { id: 'created_exam' }, preview: { pages: [{ cards: [] }] } };
const partialDraft = () => ({
  ...detail, draft_job_id: 'job_partial', draft_version: 2,
  draft_document: { questions: [{ local_id: 'q1', content: 'Verified scoped question', question_type: 'short_answer' }],
    issues: ['Answer assignment requires review'], coverage: [
      { source_id: 'file1_s1', page: 1, status: 'processed' },
      { source_id: 'file2_s1', page: null, status: 'processed' },
    ] },
  model_route: { complete_document: false, sources, expected_coverage: [
    { source_id: 'file1_s1', page: 1 }, { source_id: 'file2_s1', page: null },
  ], original_coverage: [
    { source_id: 'file1_s1', page: 1 }, { source_id: 'file1_s1', page: 2 }, { source_id: 'file2_s1', page: null },
  ] },
});

describe('QuestionSourceRangePicker', () => {
  it('requires explicit selection and offers independent native and paged evidence', async () => {
    const onChange = vi.fn();
    render(<QuestionSourceRangePicker plan={plan} sources={sources} onChange={onChange} />);
    expect(screen.getByText(plan.warnings[0])).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(4);
    expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).checked)).toBe(true);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([], false));
    const rows = screen.getAllByTestId('source-range-row');
    fireEvent.click(within(rows[0]).getByRole('checkbox'));
    fireEvent.click(within(rows[2]).getByRole('checkbox'));
    fireEvent.click(within(rows[3]).getByRole('checkbox'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([
      { source_id: 'file1_s1', start_page: 1, end_page: 20 },
      { source_id: 'file2_s1', start_page: null, end_page: null },
      { source_id: 'file3_s1', start_page: 1, end_page: 2 },
    ], true));
  });

  it('rejects invalid, fractional, empty and overlapping bounds without silently fixing them', async () => {
    const onChange = vi.fn();
    render(<QuestionSourceRangePicker plan={plan} sources={sources} onChange={onChange} />);
    const rows = screen.getAllByTestId('source-range-row');
    fireEvent.click(within(rows[0]).getByRole('checkbox'));
    const [start, end] = within(rows[0]).getAllByRole('spinbutton');
    for (const value of ['0', '1.5', '']) {
      fireEvent.change(start, { target: { value } });
      await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([], false));
      expect(screen.getByRole('alert')).toHaveTextContent('whole numbers');
    }
    fireEvent.change(start, { target: { value: '1' } });
    fireEvent.change(end, { target: { value: '26' } });
    expect(screen.getByRole('alert')).toHaveTextContent('whole numbers');
    fireEvent.change(end, { target: { value: '21' } });
    fireEvent.click(within(rows[1]).getByRole('checkbox'));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([], false));
    expect(screen.getByRole('alert')).toHaveTextContent('overlap');
    fireEvent.change(end, { target: { value: '20' } });
    await waitFor(() => expect(onChange.mock.lastCall?.[1]).toBe(true));
  });

  it('resets choices when a new provider plan arrives, even if automatic is true', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<QuestionSourceRangePicker plan={plan} sources={sources} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    rerender(<QuestionSourceRangePicker plan={{ ...plan, automatic: true }} sources={sources} onChange={onChange} />);
    await waitFor(() => expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).checked)).toBe(true));
    expect(onChange).toHaveBeenLastCalledWith([], false);
  });

  it('parses structured and serialized AppErrors but rejects prose and malformed plans', () => {
    expect(readQuestionSourceRangeFailure(rangeError())?.plan.ranges).toHaveLength(2);
    expect(readQuestionSourceRangeFailure(JSON.stringify(rangeError()))?.sessionId).toBe('created_exam');
    expect(readQuestionSourceRangeFailure(new Error(JSON.stringify(rangeError())))?.plan.ranges).toHaveLength(2);
    expect(readQuestionSourceRangeFailure(new Error('SOURCE_RANGE_PLAN_REQUIRED'))).toBeNull();
    expect(readQuestionSourceRangeFailure({ details: { code: 'SOURCE_RANGE_PLAN_REQUIRED', plan: { ranges: [
      { source_id: 's1', start_page: 0, end_page: 20 },
    ] } } })).toBeNull();
  });

  it('shows original unselected pages as not processed, even if a response claims otherwise', () => {
    const metadata = partialDraft().model_route;
    const coverage = [
      { source_id: 'file1_s1', page: 1, status: 'processed' },
      { source_id: 'file1_s1', page: 2, status: 'processed' },
      { source_id: 'file2_s1', page: null, status: 'processed' },
    ];
    expect(buildQuestionSourceCoverage(metadata, coverage).find(entry => entry.page === 2)?.status).toBe('unprocessed');
    render(<QuestionSourceCoverage metadata={metadata} coverage={coverage} />);
    expect(screen.getByText('Partial source only. The full document has not been processed.')).toBeInTheDocument();
    expect(screen.getByText('Processed source units: 2 / 3')).toBeInTheDocument();
    expect(screen.getByText('Not processed')).toBeInTheDocument();
  });
});

describe('ExamSheetUploader source ranges', () => {
  let progress: (event: { payload: Record<string, unknown> }) => void;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiConfigurations.mockResolvedValue([]);
    mocks.getExamSheetSessionDetail.mockResolvedValue(detail);
    mocks.listen.mockImplementation(async (_name: string, listener: typeof progress) => { progress = listener; return () => {}; });
    mocks.invoke.mockResolvedValue(null);
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });
  const selectFiles = () => fireEvent.change(screen.getByTestId('exam-uploader-file-input'), { target: { files: [
    new File(['original questions'], 'questions.pdf', { type: 'application/pdf' }),
    new File(['full independent answer evidence'], 'answers.txt', { type: 'text/plain' }),
  ] } });

  it('keeps full original files and session on manual retry, then gates partial commit on review', async () => {
    let imports = 0;
    const onUploadSuccess = vi.fn();
    mocks.invoke.mockImplementation(async (command: string, args?: any) => {
      if (command === 'import_question_bank_stream') {
        imports++;
        if (imports === 1) {
          progress({ payload: { type: 'SessionCreated', import_id: args.request.import_id, session_id: 'created_exam' } });
          throw rangeError();
        }
        return partialDraft();
      }
      if (command === 'qbank_commit_authoring_draft') return { committed: true, exam_id: 'created_exam', partial: true };
      return null;
    });
    render(<ExamSheetUploader onUploadSuccess={onUploadSuccess} />);
    selectFiles();
    fireEvent.click(screen.getByTestId('exam-uploader-start'));
    const picker = await screen.findByTestId('question-source-range-picker');
    expect(imports).toBe(1);
    expect(screen.getByTestId('exam-uploader-start')).toBeDisabled();
    expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).checked)).toBe(true);
    const rows = within(picker).getAllByTestId('source-range-row');
    fireEvent.click(within(rows[0]).getByRole('checkbox'));
    fireEvent.change(within(rows[0]).getAllByRole('spinbutton')[1], { target: { value: '1' } });
    fireEvent.click(within(rows.find(row => row.dataset.sourceId === 'file2_s1')!).getByRole('checkbox'));
    await waitFor(() => expect(screen.getByTestId('exam-uploader-start')).toBeEnabled());
    fireEvent.click(screen.getByTestId('exam-uploader-start'));
    await screen.findByTestId('exam-uploader-summary');
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === 'import_question_bank_stream');
    const original = calls[0][1].request;
    const retry = calls[1][1].request;
    expect(original.source_ranges).toBeUndefined();
    expect(retry.content).toBe(original.content);
    expect(retry.format).toBe('bundle');
    expect(retry.session_id).toBe('created_exam');
    expect(retry.import_id).not.toBe(original.import_id);
    expect(retry.source_ranges).toEqual([
      { source_id: 'file1_s1', start_page: 1, end_page: 1 },
      { source_id: 'file2_s1', start_page: null, end_page: null },
    ]);
    expect(JSON.parse(retry.content).map((source: { name: string }) => source.name)).toEqual(['questions.pdf', 'answers.txt']);
    expect(screen.getByText('Partial source draft: 1 questions')).toBeInTheDocument();
    expect(screen.getByTestId('question-source-coverage')).toHaveTextContent('Not processed');
    const confirm = screen.getByText('exam_sheet:uploader.confirm_import');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'qbank_commit_authoring_draft')).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('exam-uploader-review-acknowledgment')).getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(onUploadSuccess).toHaveBeenCalledTimes(1));
    expect(mocks.invoke).toHaveBeenCalledWith('qbank_commit_authoring_draft', {
      jobId: 'job_partial', selectedLocalIds: ['q1'], expectedVersion: 2,
    });
    expect(mocks.showGlobalNotification).toHaveBeenCalledWith('warning', expect.stringContaining('remain incomplete'));
  });

  it('can explicitly retry the entire source and reopens an unchecked plan on another limit', async () => {
    let imports = 0;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'import_question_bank_stream') { imports++; throw JSON.stringify(rangeError()); }
      return null;
    });
    render(<ExamSheetUploader />);
    selectFiles();
    fireEvent.click(screen.getByTestId('exam-uploader-start'));
    await screen.findByTestId('question-source-range-picker');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByTestId('exam-uploader-retry-whole'));
    await waitFor(() => expect(imports).toBe(2));
    await waitFor(() => expect(screen.getAllByRole('checkbox').every(input => !(input as HTMLInputElement).checked)).toBe(true));
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === 'import_question_bank_stream');
    expect(calls[1][1].request.content).toBe(calls[0][1].request.content);
    expect(calls[1][1].request.source_ranges).toBeUndefined();
    expect(screen.getByTestId('exam-uploader-start')).toBeDisabled();
  });

  it('resets old source ranges after a file change and does not treat arbitrary errors as range plans', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'import_question_bank_stream') throw rangeError();
      return null;
    });
    render(<ExamSheetUploader />);
    selectFiles();
    fireEvent.click(screen.getByTestId('exam-uploader-start'));
    await screen.findByTestId('question-source-range-picker');
    fireEvent.change(screen.getByTestId('exam-uploader-file-input'), { target: { files: [
      new File(['additional full source'], 'material.txt', { type: 'text/plain' }),
    ] } });
    expect(screen.queryByTestId('question-source-range-picker')).not.toBeInTheDocument();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'import_question_bank_stream') throw new Error('network failure');
      return null;
    });
    await act(async () => { fireEvent.click(screen.getByTestId('exam-uploader-start')); });
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'import_question_bank_stream')).toHaveLength(2));
    expect(screen.queryByTestId('question-source-range-picker')).not.toBeInTheDocument();
    const calls = mocks.invoke.mock.calls.filter(([command]) => command === 'import_question_bank_stream');
    expect(calls[1][1].request.source_ranges).toBeUndefined();
    expect(JSON.parse(calls[1][1].request.content)).toHaveLength(3);
  });
});
