import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { GenerativeUIErrorBoundary } from '@/features/generative-ui/components/GenerativeUIErrorBoundary';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'blocks.markdown.error': '正文渲染失败',
        'a11y.block_error': '组件渲染失败',
        'a11y.retry': '重试',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const Bomb: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('boom');
  return <div data-testid="recovered">recovered</div>;
};

describe('GenerativeUIErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when the subtree is healthy', () => {
    render(
      <GenerativeUIErrorBoundary>
        <div>healthy</div>
      </GenerativeUIErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows i18n error when the subtree throws and does not crash the page', () => {
    render(
      <>
        <div data-testid="page-alive">page-ok</div>
        <GenerativeUIErrorBoundary>
          <Bomb shouldThrow />
        </GenerativeUIErrorBoundary>
      </>,
    );

    expect(screen.getByTestId('page-alive')).toHaveTextContent('page-ok');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-generative-error-boundary');
    expect(alert).toHaveAttribute('data-block-error');
    expect(alert).toHaveAttribute('aria-label', '组件渲染失败');
    expect(alert).toHaveTextContent('正文渲染失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('calls onReset and remounts children after retry', () => {
    const onReset = vi.fn();
    let shouldThrow = true;
    const Flaky: React.FC = () => <Bomb shouldThrow={shouldThrow} />;

    render(
      <GenerativeUIErrorBoundary onReset={onReset}>
        <Flaky />
      </GenerativeUIErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('recovered')).toBeInTheDocument();
  });

  it('resets when resetKey changes', () => {
    const { rerender } = render(
      <GenerativeUIErrorBoundary resetKey="a">
        <Bomb shouldThrow />
      </GenerativeUIErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(
      <GenerativeUIErrorBoundary resetKey="b">
        <div data-testid="after-reset-key">ok</div>
      </GenerativeUIErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('after-reset-key')).toBeInTheDocument();
  });
});
