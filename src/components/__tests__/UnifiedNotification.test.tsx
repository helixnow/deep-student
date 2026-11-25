import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedNotification } from '../UnifiedNotification';

describe('UnifiedNotification async action handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('awaits async action settlement before closing, guards double-click, and pauses auto-dismiss', async () => {
    let resolveAction!: () => void;
    const actionPromise = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    const onClick = vi.fn(() => actionPromise);
    const onClose = vi.fn();

    render(
      <UnifiedNotification
        notification={{
          type: 'success',
          message: '笔记已移至回收站 · Linear Algebra',
          visible: true,
          action: { label: '撤销', onClick },
        }}
        onClose={onClose}
      />,
    );

    const actionBtn = screen.getByRole('button', { name: '撤销' });
    fireEvent.click(actionBtn);

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(actionBtn).toBeDisabled();
    expect(actionBtn).toHaveAttribute('aria-busy', 'true');
    expect(onClose).not.toHaveBeenCalled();

    // Double-click while in-flight must not re-invoke
    fireEvent.click(actionBtn);
    expect(onClick).toHaveBeenCalledTimes(1);

    // Auto-dismiss timer must remain paused while async action is running
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(onClose).not.toHaveBeenCalled();

    // Once resolved, toast closes cleanly
    await act(async () => {
      resolveAction();
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('logs uncaught async action rejections instead of swallowing them and closes cleanly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onClick = vi.fn(() => Promise.reject(new Error('restore boom')));
    const onClose = vi.fn();

    render(
      <UnifiedNotification
        notification={{
          type: 'success',
          message: '笔记已移至回收站',
          visible: true,
          action: { label: '撤销', onClick },
        }}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[UnifiedNotification] Async action handler failed:',
      expect.any(Error),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('closes immediately for synchronous actions', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();

    render(
      <UnifiedNotification
        notification={{
          type: 'info',
          message: 'Sync toast',
          visible: true,
          action: { label: 'Apply', onClick },
        }}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
