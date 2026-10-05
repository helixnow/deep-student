/**
 * 题目集自带错题本渲染公式：行摘要、我的答案 / 正确答案 / 解析不再出现 TeX 源码。
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/custom-scroll-area', () => ({
  CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('@/features/anki/generateCardsFromText', () => ({
  generateCardsFromText: vi.fn(),
}));

vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => (
      typeof fallback === 'string' ? fallback : key
    ),
  }),
  Trans: () => null,
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ReviewQuestionsView } from '../ReviewQuestionsView';

const mathQuestion = {
  id: 'question-math',
  questionLabel: 'Q1',
  content: '判断级数 $\\sum_{n=1}^{\\infty} \\frac{1}{n^2}$ 的敛散性',
  questionType: 'short_answer' as const,
  tags: [],
  status: 'review' as const,
  userAnswer: '发散，因为 $\\frac{1}{n^2} > 0$',
  answer: '收敛（$p=2>1$）',
  explanation: '$p$ 级数 $\\sum \\frac{1}{n^p}$ 在 $p>1$ 时收敛',
};

describe('ReviewQuestionsView math rendering', () => {
  it('renders TeX in the row stem and in the expanded answers and explanation', () => {
    const { container } = render(<ReviewQuestionsView questions={[mathQuestion]} />);

    const rowToggle = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(rowToggle).not.toBeNull();
    expect(rowToggle?.querySelector('.katex')).not.toBeNull();
    expect(rowToggle?.textContent).not.toContain('$\\sum');

    fireEvent.click(rowToggle!);

    expect(screen.getByText('review:questions.myAnswer').parentElement?.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('review:questions.correctAnswer').parentElement?.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('review:questions.explanation').parentElement?.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).not.toMatch(/\$[^$]+\$/);
  });

  it('keeps plain stems as plain text', () => {
    const { container } = render(
      <ReviewQuestionsView questions={[{ ...mathQuestion, content: '默写《出师表》第一段', userAnswer: '', answer: '', explanation: '' }]} />,
    );

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('默写《出师表》第一段');
  });
});
