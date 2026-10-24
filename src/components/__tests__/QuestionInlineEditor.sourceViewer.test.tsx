import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => state.invokeMock(...args),
}));
vi.mock('@/hooks/useBreakpoint', () => ({
  useIsMobile: () => false,
}));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));

import { QuestionInlineEditor, getQuestionSourceRefs } from '../QuestionInlineEditor';
import type { Question } from '@/api/questionBankApi';

const question = {
  id: 'q1',
  cardId: 'q1',
  questionLabel: '1',
  content: '题干内容',
  questionType: 'single_choice',
  options: [
    { key: 'A', content: '选项 A' },
    { key: 'B', content: '选项 B' },
  ],
  answer: 'A',
  explanation: '',
  difficulty: 'medium',
  tags: [],
  status: 'new',
  userAnswer: '',
  isCorrect: null,
  userNote: '',
  attemptCount: 0,
  correctCount: 0,
  lastAttemptAt: null,
  isFavorite: false,
  images: [],
  examId: 'exam_1',
  sourceRefs: [{ source_id: 'qsrc_1', page: 2, bbox: [0.1, 0.2, 0.5, 0.6] }],
  answerSourceRefs: [{ source_id: 'qsrc_1', page: 3 }],
} as unknown as Question;

beforeEach(() => {
  state.invokeMock.mockReset();
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function () {
    return this.parentElement;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('QuestionInlineEditor source trigger', () => {
  it('exposes question and answer refs from the structural Question payload', () => {
    expect(getQuestionSourceRefs(question)).toEqual({
      sourceRefs: [{ source_id: 'qsrc_1', page: 2, bbox: [0.1, 0.2, 0.5, 0.6] }],
      answerSourceRefs: [{ source_id: 'qsrc_1', page: 3 }],
    });
  });

  it('falls back to provenance carried in the serialized sourceRef field', () => {
    const legacyMapped = {
      ...question,
      sourceRefs: undefined,
      answerSourceRefs: undefined,
      sourceRef: JSON.stringify({
        source_refs: [{ source_id: 'att_chat_image', page: 1, bbox: [0, 0, 1, 1] }],
        answer_source_refs: [{ source_id: 'att_chat_image', page: 1 }],
      }),
    } as unknown as Question;

    expect(getQuestionSourceRefs(legacyMapped)).toEqual({
      sourceRefs: [{ source_id: 'att_chat_image', page: 1, bbox: [0, 0, 1, 1] }],
      answerSourceRefs: [{ source_id: 'att_chat_image', page: 1 }],
    });
  });

  it('opens the source viewer from the editor toolbar with the real page request', async () => {
    state.invokeMock.mockImplementation(async (command: string) => {
      if (command === 'qbank_get_source_page') {
        return {
          source_id: 'qsrc_1',
          page: 2,
          blob_hash: 'blob_2',
          width: 1000,
          height: 1400,
          text: 'text layer',
          source_name: 'exam.pdf',
          source_format: 'pdf',
          original_path: '/library/exam.pdf',
          page_count: 3,
          available_pages: [1, 2, 3],
        };
      }
      if (command === 'vfs_get_blob_base64') {
        return { base64: 'AAAA', mimeType: 'image/png', size: 3 };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(
      <QuestionInlineEditor
        question={question}
        mode="edit"
        examId="exam_1"
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /查看原题来源/ }));

    expect(await screen.findByTestId('question-source-viewer')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /第 2 页/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(state.invokeMock).toHaveBeenCalledWith('qbank_get_source_page', {
        examId: 'exam_1',
        sourceId: 'qsrc_1',
        page: 2,
      }),
    );
  });
});
