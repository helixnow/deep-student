/**
 * WindowErrorBoundary 测试：单窗崩溃隔离卡（玻璃风格）+ 重新加载重建子树。
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { WindowErrorBoundary } from '../WindowErrorBoundary';

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React 会把边界捕获的错误打到 console.error；测试静音
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  cleanup();
});

const Bomb: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
  if (shouldThrow) throw new Error('boom');
  return <div data-testid="app-content">ok</div>;
};

describe('崩溃卡', () => {
  it('子树抛错时渲染玻璃崩溃卡（role=alert + 错误摘要 + 重新加载）', () => {
    render(
      <WindowErrorBoundary windowId="w1">
        <Bomb shouldThrow />
      </WindowErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.classList.contains('wb-body-crash')).toBe(true);
    // 玻璃材质契约类
    expect(alert.querySelector('.wb-body-crash-card.wb-glass')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重新加载/ })).toBeTruthy();
  });

  it('点击「重新加载」重建子树并恢复内容', () => {
    let shouldThrow = true;
    const Flaky: React.FC = () => <Bomb shouldThrow={shouldThrow} />;
    render(
      <WindowErrorBoundary windowId="w1">
        <Flaky />
      </WindowErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('app-content')).toBeTruthy();
  });

  it('onReset 钩子在重建前被调用', () => {
    const onReset = vi.fn();
    let shouldThrow = true;
    const Flaky: React.FC = () => <Bomb shouldThrow={shouldThrow} />;
    render(
      <WindowErrorBoundary windowId="w1" onReset={onReset}>
        <Flaky />
      </WindowErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
