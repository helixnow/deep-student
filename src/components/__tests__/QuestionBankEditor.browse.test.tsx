import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
  convertFileSrc: (path: string) => path,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
// 富文本渲染与本用例无关：直出文本便于断言
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
  StreamingMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { QuestionBankEditor } from '../QuestionBankEditor';
import type { Question } from '@/api/questionBankApi';

afterEach(() => {
  cleanup();
  mocks.invoke.mockReset();
  mocks.listeners.clear();
});

const owner = { examId: 'exam_1', viewInstanceId: 'browse-test' };

const choice: Question = {
  id: 'q1',
  questionLabel: '1',
  content: '1 + 1 = ?',
  questionType: 'single_choice',
  options: [{ key: 'A', content: '1' }, { key: 'B', content: '2' }],
  answer: 'B',
  explanation: '加法',
  status: 'new',
};

const unanswered: Question = {
  id: 'q2',
  questionLabel: '2',
  content: '简述牛顿第二定律',
  questionType: 'short_answer',
  answer: 'F = ma',
  status: 'new',
};

function renderBrowse(questions: Question[], extra: Partial<React.ComponentProps<typeof QuestionBankEditor>> = {}) {
  return render(
    <QuestionBankEditor
      sessionId="exam_1"
      practiceSessionOwner={owner}
      questions={questions}
      currentIndex={0}
      browseMode
      showTimer={false}
      onNavigate={vi.fn()}
      {...extra}
    />,
  );
}

describe('QuestionBankEditor 浏览模式（#466 / #467）', () => {
  it('shows answer and explanation read-only, without answering controls', () => {
    const onPracticeQuestion = vi.fn();
    renderBrowse([choice], { onPracticeQuestion });

    expect(screen.getByText('参考答案')).toBeInTheDocument();
    expect(screen.getByText('加法')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /提交答案/ })).toBeNull();
    expect(screen.queryByText('我的笔记')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /做这道题/ }));
    expect(onPracticeQuestion).toHaveBeenCalledWith('q1');
  });

  it('shows the empty state when a question has neither answer nor explanation', () => {
    renderBrowse([{ ...unanswered, answer: undefined }]);
    expect(screen.getByText('暂无答案和解析')).toBeInTheDocument();
  });

  it('hides AI explanation for read-only hosts', () => {
    renderBrowse([unanswered]);
    expect(screen.queryByRole('button', { name: /AI 解析/ })).toBeNull();
  });

  it('generates an explanation for an unanswered question without a submission', async () => {
    mocks.invoke.mockResolvedValue(null);
    const onRefreshQuestion = vi.fn().mockResolvedValue(undefined);
    renderBrowse([unanswered], { onRefreshQuestion });

    fireEvent.click(screen.getByRole('button', { name: /AI 解析/ }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('qbank_ai_grade', expect.anything()));
    const [, args] = mocks.invoke.mock.calls.find(([cmd]) => cmd === 'qbank_ai_grade')!;
    expect(args.request).toMatchObject({ question_id: 'q2', submission_id: null, mode: 'analyze' });

    const emit = mocks.listeners.get(`qbank_grading_stream_${args.request.stream_session_id}`)!;
    emit({ payload: { type: 'complete', feedback: '**解题思路**：F = ma', explanation_written: true } });

    await waitFor(() => expect(onRefreshQuestion).toHaveBeenCalledWith('q2'));
  });

  it('offers to write the AI explanation when the question already has one', () => {
    renderBrowse([{ ...choice, ai_feedback: 'AI 写的解析' }], { onRefreshQuestion: vi.fn() });

    expect(screen.getByText('AI 写的解析')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /写入解析/ }));
    // 已有解析：先确认，不直接覆盖
    expect(screen.getByRole('button', { name: /替换现有解析/ })).toBeInTheDocument();
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === 'qbank_update_question')).toBe(false);
  });
});
