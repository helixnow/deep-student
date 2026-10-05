import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { prefill } = vi.hoisted(() => ({ prefill: vi.fn(() => true) }));
vi.mock('@/features/pdf/selectionStudyActions', () => ({ sendSelectionToChatInput: prefill }));
import { QuestionFollowUpBar, questionSourceResourceId } from '../QuestionFollowUpBar';

afterEach(() => { cleanup(); prefill.mockClear(); });

const question = {
  id: 'q1', questionLabel: '1', content: '1+1=?', questionType: 'single_choice',
  options: [{ key: 'A', content: '1' }, { key: 'B', content: '2' }], answer: 'B', explanation: '加法',
  sourceRef: JSON.stringify({ resourceIds: ['file_math'] }),
} as never;

describe('QuestionFollowUpBar', () => {
  it('prefills a wrong-answer explanation request with stem, options, answers and explanation', () => {
    render(<QuestionFollowUpBar question={question} examId="exam_1" userAnswer="A" isCorrect={false} />);
    fireEvent.click(screen.getByRole('button', { name: /问 AI 讲解/ }));
    const text = prefill.mock.calls[0][0].text as string;
    expect(text).toContain('做错了');
    expect(text).toContain('1+1=?');
    expect(text).toContain('A. 1');
    expect(text).toContain('正确答案：B');
    expect(text).toContain('我的答案：A');
    expect(text).toContain('解析：加法');
  });

  it('asks for similar questions into the same set and shows the source only when known', () => {
    render(<QuestionFollowUpBar question={question} examId="exam_1" />);
    fireEvent.click(screen.getByRole('button', { name: /生成同类题/ }));
    expect(prefill.mock.calls[0][0].text).toContain('exam_1');
    expect(screen.getByRole('button', { name: /出处/ })).toBeInTheDocument();
    cleanup();
    render(<QuestionFollowUpBar question={{ ...(question as object), sourceRef: null } as never} examId="exam_1" />);
    expect(screen.queryByRole('button', { name: /出处/ })).toBeNull();
  });

  it('jumps to the lecture moment when the explanation cites a media anchor', () => {
    const opened = vi.fn();
    document.addEventListener('media-ref:open', opened);
    render(
      <QuestionFollowUpBar
        question={{ ...(question as object), explanation: '加法\n[媒体@file_lec2:03:05]' } as never}
        examId="exam_1"
      />,
    );
    expect(screen.queryByRole('button', { name: /^出处$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /回看 03:05/ }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ resourceId: 'file_lec2', seconds: 185 });
    document.removeEventListener('media-ref:open', opened);
  });

  it('parses source refs defensively', () => {
    expect(questionSourceResourceId('{"resourceIds":["a","b"]}')).toBe('a');
    expect(questionSourceResourceId('not json')).toBeNull();
    expect(questionSourceResourceId(null)).toBeNull();
  });
});
