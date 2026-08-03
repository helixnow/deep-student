import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WindowErrorBoundary } from '@/features/workbench/components/WindowErrorBoundary';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WindowErrorBoundary 单窗崩溃恢复', () => {
  it('子树抛错显示重载卡片，重载后恢复', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    const Crashy: React.FC = () => {
      if (shouldThrow) throw new Error('boom');
      return <div>recovered-content</div>;
    };

    render(
      <WindowErrorBoundary windowId="w1">
        <Crashy />
      </WindowErrorBoundary>,
    );

    const card = screen.getByRole('alert');
    expect(card).toHaveAttribute('data-wb-crash-card');
    expect(card.classList.contains('wb-body-crash')).toBe(true);
    expect(card.querySelector('.wb-body-crash-card.wb-glass')).toBeTruthy();
    expect(card.querySelector('.wb-body-crash-icon')).toBeTruthy();
    expect(card.textContent).toContain('此窗口的应用出错了');
    expect(card.textContent).toContain('boom');

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(screen.getByText('recovered-content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('重载调用 onReset 钩子', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReset = vi.fn();
    let shouldThrow = true;
    const Crashy: React.FC = () => {
      if (shouldThrow) throw new Error('x');
      return <div>ok</div>;
    };
    render(
      <WindowErrorBoundary onReset={onReset}>
        <Crashy />
      </WindowErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('正常子树原样渲染', () => {
    render(
      <WindowErrorBoundary>
        <div>healthy</div>
      </WindowErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
