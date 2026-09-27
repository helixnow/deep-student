import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { QuestionBankEditor, type QuestionBankEditorProps } from '@/components/QuestionBankEditor';
import { QuestionHistoryView } from '@/components/QuestionHistoryView';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { encodeImageAnswerUserAnswer, type Question, type QuestionImage } from '@/api/questionBankApi';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { fetchImageAnswerDataUrl, uploadImageAnswerImage } from '@/components/question-types/imageAnswerUpload';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: false }),
  useIsMobile: () => false,
  useIsTablet: () => false,
}));
vi.mock('@/hooks/useQbankAiGrading', () => {
  const state = { isGrading: false, feedback: '', verdict: null, score: null, error: null };
  const callbacks = {
    resetState: vi.fn(), startGrading: vi.fn(), retryGrading: vi.fn(), cancelGrading: vi.fn(),
  };
  return { useQbankAiGrading: () => ({ state, ...callbacks }) };
});
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/components/ImageCropDialog', () => ({ ImageCropDialog: () => null }));
vi.mock('@/components/layout', () => ({ useMobileSubviewChrome: () => false }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: vi.fn(),
}));
vi.mock('@/components/question-types/imageAnswerUpload', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/question-types/imageAnswerUpload')>(),
  uploadImageAnswerImage: vi.fn(),
  fetchImageAnswerDataUrl: vi.fn(),
}));

const owner = { examId: 'image-exam', viewInstanceId: 'image-view' };
const makeQuestion = (id: string, extra: Partial<Question> = {}): Question => ({
  id, content: `题目 ${id}`, questionType: 'short_answer', status: 'new',
  attemptCount: 0, correctCount: 0, tags: [], ...extra,
});
const makeImage = (id: string): QuestionImage => ({
  id, name: `${id}.jpg`, mime: 'image/jpeg', hash: `hash-${id}`,
});
const questions = [makeQuestion('q1'), makeQuestion('q2')];
const upload = vi.mocked(uploadImageAnswerImage);
const readImage = vi.mocked(fetchImageAnswerDataUrl);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectImage(container: HTMLElement) {
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['image'], 'answer.jpg', { type: 'image/jpeg' })] },
  });
}

function renderEditor(overrides: Partial<QuestionBankEditorProps> = {}) {
  const props: QuestionBankEditorProps = {
    sessionId: 'image-exam', practiceSessionOwner: owner, questions, showTimer: false,
    onSubmitAnswer: vi.fn().mockResolvedValue({
      isCorrect: null, needsManualGrading: true, submissionId: 'submission-1',
    }),
    ...overrides,
  };
  return { ...render(<QuestionBankEditor {...props} />), props };
}

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockReset();
  readImage.mockResolvedValue('data:image/jpeg;base64,aW1hZ2U=');
  useQuestionBankStore.setState({ practiceSessions: {} });
  useQuestionBankStore.getState().ensurePracticeSession(owner, ['q1', 'q2']);
});

describe('image answer ownership and submission', () => {
  it.each(['question', 'session'] as const)('ignores an upload completed after changing %s', async (scope) => {
    const pending = deferred<QuestionImage>();
    const image = makeImage(`old-${scope}`);
    upload.mockReturnValue(pending.promise);
    const onDraftDirtyChange = vi.fn();
    const { container, rerender, props } = renderEditor({ onDraftDirtyChange });
    selectImage(container);
    expect(onDraftDirtyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: /提交答案|submit/i })).toBeDisabled();

    const nextProps = scope === 'question'
      ? { ...props, currentIndex: 1 }
      : { ...props, sessionId: 'other-exam', practiceSessionOwner: { examId: 'other-exam', viewInstanceId: 'other-view' } };
    rerender(<QuestionBankEditor {...nextProps} />);
    await act(async () => { pending.resolve(image); await pending.promise; });

    expect(screen.queryByRole('button', { name: image.name })).not.toBeInTheDocument();
    expect(screen.getByText('0/6')).toBeInTheDocument();
    expect(onDraftDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not let an old upload clear the next question upload or reappear on return', async () => {
    const oldUpload = deferred<QuestionImage>();
    const newUpload = deferred<QuestionImage>();
    upload.mockReturnValueOnce(oldUpload.promise).mockReturnValueOnce(newUpload.promise);
    const { container, rerender, props } = renderEditor();
    selectImage(container);
    rerender(<QuestionBankEditor {...props} currentIndex={1} />);
    selectImage(container);
    await act(async () => { oldUpload.resolve(makeImage('old-q1')); await oldUpload.promise; });
    expect(screen.getByRole('button', { name: /拍照\/上传手写答案/ })).toBeDisabled();
    rerender(<QuestionBankEditor {...props} />);
    await act(async () => { newUpload.resolve(makeImage('old-q2')); await newUpload.promise; });
    expect(screen.getByText('0/6')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-q1.jpg' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old-q2.jpg' })).not.toBeInTheDocument();
  });

  it('waits for the upload before submitting the complete text and image answer', async () => {
    const pending = deferred<QuestionImage>();
    const image = makeImage('submit-image');
    upload.mockReturnValue(pending.promise);
    const { container, props } = renderEditor();
    fireEvent.change(screen.getByPlaceholderText('请输入答案...'), { target: { value: '文字补充' } });
    selectImage(container);
    const submit = screen.getByRole('button', { name: /提交答案|submit/i });
    fireEvent.click(submit);
    expect(props.onSubmitAnswer).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(image); await pending.promise; });
    fireEvent.click(submit);
    await waitFor(() => expect(props.onSubmitAnswer).toHaveBeenCalledWith(
      'q1', encodeImageAnswerUserAnswer([image], '文字补充'), 'short_answer',
    ));
  });

  it('keeps every numbered fill-blank answer alongside the images', async () => {
    const image = makeImage('fill-image');
    upload.mockResolvedValue(image);
    const { container, props } = renderEditor({
      questions: [makeQuestion('q1', { questionType: 'fill_blank', content: '___ 与 ___' }), questions[1]],
    });
    fireEvent.change(container.querySelector('[data-blank-index="0"]')!, { target: { value: '甲' } });
    fireEvent.change(container.querySelector('[data-blank-index="1"]')!, { target: { value: '乙' } });
    selectImage(container);
    await screen.findByRole('button', { name: image.name });
    fireEvent.click(screen.getByRole('button', { name: /提交答案|submit/i }));
    await waitFor(() => expect(props.onSubmitAnswer).toHaveBeenCalledWith(
      'q1', encodeImageAnswerUserAnswer([image], '1. 甲\n2. 乙'), 'fill_blank',
    ));
  });

  it('shows serialization failures through the existing notification path', async () => {
    const invalid = { ...makeImage('invalid-image'), mime: 'image/heic' };
    upload.mockResolvedValue(invalid);
    const { container, props } = renderEditor();
    selectImage(container);
    await screen.findByRole('button', { name: invalid.name });
    fireEvent.click(screen.getByRole('button', { name: /提交答案|submit/i }));
    await waitFor(() => expect(showGlobalNotification).toHaveBeenCalledWith('error', expect.any(String)));
    expect(props.onSubmitAnswer).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /提交答案|submit/i })).toBeEnabled();
  });

  it('ignores a failed upload after the editor has unmounted', async () => {
    const pending = deferred<QuestionImage>();
    upload.mockReturnValue(pending.promise);
    const { container, unmount } = renderEditor();
    selectImage(container);
    unmount();
    await act(async () => {
      pending.reject(new Error('late failure'));
      await pending.promise.catch(() => {});
    });
    expect(showGlobalNotification).not.toHaveBeenCalled();
  });
});

describe('saved image answer review', () => {
  it('shows the persisted answer on initial load and when returning to the question', async () => {
    const image = makeImage('persisted-image');
    const saved = makeQuestion('q1', { userAnswer: encodeImageAnswerUserAnswer([image], '已保存的作答') });
    const { rerender, props } = renderEditor({ questions: [saved, questions[1]] });
    await screen.findByRole('button', { name: image.name });
    expect(screen.getByText('已保存的作答')).toBeInTheDocument();
    rerender(<QuestionBankEditor {...props} currentIndex={1} />);
    expect(screen.queryByRole('button', { name: image.name })).not.toBeInTheDocument();
    rerender(<QuestionBankEditor {...props} />);
    const thumbnail = await screen.findByRole('button', { name: image.name });
    fireEvent.click(thumbnail);
    expect(thumbnail).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByAltText(image.name)).toHaveLength(2);
  });

  it('loads historical images only when the answer is expanded', async () => {
    const image = makeImage('history-image');
    vi.mocked(invoke).mockResolvedValueOnce([{
      id: 'history-1', question_id: 'q1', field_name: 'user_answer', change_type: 'answer',
      new_value: encodeImageAnswerUserAnswer([image], '历史作答'), created_at: '2026-09-27T10:00:00Z',
    }]);
    render(<QuestionHistoryView questionId="q1" open onOpenChange={vi.fn()} />);
    const summary = await screen.findByText(/手写图片作答/);
    expect(readImage).not.toHaveBeenCalled();
    fireEvent.click(summary);
    const thumbnail = await screen.findByRole('button', { name: image.name });
    expect(readImage).toHaveBeenCalledWith(image);
    fireEvent.click(thumbnail);
    expect(thumbnail).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByAltText(image.name)).toHaveLength(2);
  });
});
