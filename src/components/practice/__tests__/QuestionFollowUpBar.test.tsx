import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@/events', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/events')>()),
  dispatchAppEvent: dispatch,
}));
import { QuestionFollowUpBar, questionSourceResourceId } from '../QuestionFollowUpBar';

afterEach(() => { cleanup(); dispatch.mockClear(); });

const prefilled = (index = 0) => {
  const [eventName, detail] = dispatch.mock.calls[index];
  expect(eventName).toBe('PREFILL_CHAT_INPUT');
  // 每道题的追问是独立话题，新开对话，不自动发送
  expect(detail).toMatchObject({ autoSend: false, newSession: true });
  return detail.content as string;
};

const question = {
  id: 'q1', questionLabel: '1', content: '1+1=?', questionType: 'single_choice',
  options: [{ key: 'A', content: '1' }, { key: 'B', content: '2' }], answer: 'B', explanation: '加法',
  sourceRef: JSON.stringify({ resourceIds: ['file_math'] }),
} as never;

describe('QuestionFollowUpBar', () => {
  it('prefills a wrong-answer explanation request with stem, options, answers and explanation', () => {
    render(<QuestionFollowUpBar question={question} examId="exam_1" userAnswer="A" isCorrect={false} />);
    fireEvent.click(screen.getByRole('button', { name: /问 AI 讲解/ }));
    const text = prefilled();
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
    expect(prefilled()).toContain('exam_1');
    expect(screen.getByRole('button', { name: /出处/ })).toBeInTheDocument();
    cleanup();
    render(<QuestionFollowUpBar question={{ ...(question as object), sourceRef: null } as never} examId="exam_1" />);
    expect(screen.queryByRole('button', { name: /出处/ })).toBeNull();
  });

  it('parses source refs defensively', () => {
    expect(questionSourceResourceId('{"resourceIds":["a","b"]}')).toBe('a');
    expect(questionSourceResourceId('not json')).toBeNull();
    expect(questionSourceResourceId(null)).toBeNull();
  });
});
