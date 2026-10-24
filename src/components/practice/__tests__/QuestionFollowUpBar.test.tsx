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

  it('carries shared materials, structured data, image refs and a stable question citation', () => {
    const grouped = {
      ...(question as object),
      id: 'q_child1',
      groupId: 'qgroup_1',
      groupLabel: '阅读理解一',
      materials: [{
        id: 'qmat_1',
        content: '阅读材料：光合作用分为光反应和暗反应。',
        images: [{ id: 'file_mat_img', name: '材料图.png', mime: 'image/png', hash: 'b'.repeat(64) }],
        source_refs: [{ source_id: 'src_1', page: 1 }],
        version: 1,
      }],
      images: [{ id: 'file_q_img', name: '题干图.png', mime: 'image/png', hash: 'c'.repeat(64) }],
      structured_data: { answer_value: 3.14, tolerance: 0.01 },
    } as never;

    render(<QuestionFollowUpBar question={grouped} examId="exam_1" userAnswer="A" isCorrect={false} />);
    fireEvent.click(screen.getByRole('button', { name: /问 AI 讲解/ }));
    const text = prefilled();

    expect(text).toContain('阅读材料：光合作用分为光反应和暗反应。');
    expect(text).toContain('材料图.png');
    expect(text).toContain('题干图.png');
    expect(text).toContain('"answer_value":3.14');
    expect(text).toContain('[题目集:exam_1#q_child1:1]');
  });

  it('parses source refs defensively', () => {
    expect(questionSourceResourceId('{"resourceIds":["a","b"]}')).toBe('a');
    expect(questionSourceResourceId('not json')).toBeNull();
    expect(questionSourceResourceId(null)).toBeNull();
  });
});
