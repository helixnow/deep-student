/**
 * 2026-08 exam/practice 打磨回归：
 * - E10 限时练习：交卷后配置页展示上轮总结卡 +「再来一轮」沿用上轮时长/题量重开。
 * - E7 组卷：未实现的 PDF/Word 导出置灰 + 即将推出徽标，可用格式保持可点。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/features/chat/components/renderers', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

import i18n from '@/i18n';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { TimedPracticeMode } from '@/components/practice/TimedPracticeMode';
import { PaperGenerator } from '@/components/practice/PaperGenerator';

const submittedSession = {
  id: 'timed-old',
  exam_id: 'exam-1',
  duration_minutes: 25,
  question_count: 15,
  question_ids: ['q-1', 'q-2'],
  started_at: '2026-08-24T07:00:00.000Z',
  ended_at: '2026-08-24T07:25:00.000Z',
  answered_count: 12,
  correct_count: 9,
  is_timeout: false,
  is_submitted: true,
  paused_seconds: 0,
  is_paused: false,
};

describe('TimedPracticeMode last-session summary (E10)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('zh-CN', 'practice')).toBe(true);
    });
    mockInvoke.mockReset();
    useQuestionBankStore.setState({ timedSession: null, isLoadingPractice: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the previous result and restarts with the same config via 再来一轮', async () => {
    useQuestionBankStore.setState({ timedSession: submittedSession as never });
    const freshSession = {
      ...submittedSession,
      id: 'timed-new',
      is_submitted: false,
      answered_count: 0,
      correct_count: 0,
      ended_at: null,
    };
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'qbank_start_timed_practice') return freshSession;
      throw new Error(`unexpected invoke: ${command}`);
    });
    const onStart = vi.fn();

    render(<TimedPracticeMode examId="exam-1" onStart={onStart} />);

    const summary = screen.getByTestId('timed-last-result');
    expect(summary).toHaveTextContent('上次练习结果');
    expect(summary).toHaveTextContent('已答 12 / 15 题 · 答对 9 题 · 正确率 75%');
    // 未超时的会话不显示超时徽标
    expect(summary).not.toHaveTextContent('超时自动交卷');

    fireEvent.click(screen.getByRole('button', { name: /再来一轮/ }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('qbank_start_timed_practice', {
        request: {
          exam_id: 'exam-1',
          duration_minutes: 25,
          question_count: 15,
        },
      });
      expect(onStart).toHaveBeenCalledWith(freshSession);
    });
  });

  it('does not show a summary that belongs to another exam', () => {
    useQuestionBankStore.setState({
      timedSession: { ...submittedSession, exam_id: 'exam-other' } as never,
    });
    render(<TimedPracticeMode examId="exam-1" />);
    expect(screen.queryByTestId('timed-last-result')).toBeNull();
  });
});

describe('PaperGenerator export availability (E7)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    await vi.waitFor(() => {
      expect(i18n.hasResourceBundle('zh-CN', 'practice')).toBe(true);
    });
    mockInvoke.mockReset();
    useQuestionBankStore.setState({ generatedPaper: null, isLoadingPractice: false });
  });

  afterEach(() => {
    cleanup();
  });

  it('disables unimplemented PDF/Word formats with a coming-soon badge', () => {
    render(<PaperGenerator examId="exam-1" />);

    const pdfButton = screen.getByRole('button', { name: /PDF/ });
    const wordButton = screen.getByRole('button', { name: /Word/ });
    expect(pdfButton).toBeDisabled();
    expect(wordButton).toBeDisabled();
    expect(screen.getAllByText('即将推出')).toHaveLength(2);

    const previewButton = screen.getByRole('button', { name: /预览/ });
    const markdownButton = screen.getByRole('button', { name: /Markdown/ });
    expect(previewButton).toBeEnabled();
    expect(markdownButton).toBeEnabled();
  });
});
