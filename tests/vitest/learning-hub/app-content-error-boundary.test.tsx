import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AppContentErrorBoundary } from '@/components/learning-hub/apps/AppContentErrorBoundary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: string | Record<string, unknown>, maybeOptions?: Record<string, unknown>) => {
      if (key === 'learningHub:resourceType.exam') {
        return '题目集';
      }
      if (key === 'common:actions.retry') {
        return '重试';
      }

      const defaultValue = typeof defaultValueOrOptions === 'string' ? defaultValueOrOptions : key;
      const options = (typeof defaultValueOrOptions === 'string' ? maybeOptions : defaultValueOrOptions) ?? {};
      return defaultValue.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => String((options as Record<string, unknown>)[name] ?? ''));
    },
  }),
}));

describe('AppContentErrorBoundary', () => {
  it('shows fallback and recovers after retry', () => {
    let shouldThrow = true;
    const onRetry = vi.fn();

    const Crashy = () => {
      if (shouldThrow) {
        throw new Error('boom');
      }
      return <div>Recovered Content</div>;
    };

    render(
      <AppContentErrorBoundary resourceType="exam" onRetry={onRetry}>
        <Crashy />
      </AppContentErrorBoundary>
    );

    expect(screen.getByText('题目集 应用加载失败，请重试')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Recovered Content')).toBeInTheDocument();
  });
});
