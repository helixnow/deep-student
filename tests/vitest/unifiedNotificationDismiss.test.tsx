import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationContainer } from '@/components/NotificationContainer';
import { UnifiedNotification } from '@/components/UnifiedNotification';

describe('UnifiedNotification dismiss affordance', () => {
  it('renders a compact right-side close icon that dismisses the toast', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(
      <UnifiedNotification
        notification={{
          type: 'success',
          message: '已归档。查看已归档的会话：',
          visible: true,
          borderTone: 'neutral',
          action: {
            label: '设置',
            onClick: () => undefined,
          },
        }}
        onClose={onClose}
      />
    );

    const closeButton = screen.getByRole('button', { name: '关闭通知' });
    expect(closeButton).toHaveClass('unified-notification-close');
    expect(closeButton.querySelector('.unified-notification-close-icon')).not.toBeNull();
    expect(document.querySelector('.unified-notification-icon')).toBeNull();
    expect(document.querySelector('.unified-notification-progress')).toBeNull();

    fireEvent.click(closeButton);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('renders dismiss progress only when requested', () => {
    const { rerender } = render(
      <UnifiedNotification
        notification={{
          type: 'warning',
          message: '索引需要复核',
          visible: true,
        }}
        onClose={() => undefined}
      />
    );

    expect(document.querySelector('.unified-notification-progress')).toBeNull();

    rerender(
      <UnifiedNotification
        notification={{
          type: 'warning',
          message: '索引需要复核',
          visible: true,
          progress: true,
        }}
        onClose={() => undefined}
      />
    );
    expect(document.querySelector('.unified-notification-progress')).not.toBeNull();
  });

  it('renders status icons only when auto rules or explicit icon options request them', () => {
    const { rerender } = render(
      <UnifiedNotification
        notification={{
          type: 'success',
          message: '资料库已同步',
          visible: true,
        }}
        onClose={() => undefined}
      />
    );

    expect(document.querySelector('.unified-notification-icon')).toBeNull();

    rerender(
      <UnifiedNotification
        notification={{
          type: 'warning',
          message: '索引需要复核',
          visible: true,
        }}
        onClose={() => undefined}
      />
    );
    expect(document.querySelector('.unified-notification-icon')).not.toBeNull();

    rerender(
      <UnifiedNotification
        notification={{
          type: 'warning',
          message: '索引需要复核',
          visible: true,
          icon: false,
        }}
        onClose={() => undefined}
      />
    );
    expect(document.querySelector('.unified-notification-icon')).toBeNull();

    rerender(
      <UnifiedNotification
        notification={{
          type: 'success',
          message: '资料库已同步',
          visible: true,
          icon: true,
        }}
        onClose={() => undefined}
      />
    );
    expect(document.querySelector('.unified-notification-icon')).not.toBeNull();
  });

  it('pauses auto-dismiss while hovered and resumes after leaving', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(
      <UnifiedNotification
        notification={{
          type: 'warning',
          message: '索引正在复核',
          visible: true,
        }}
        onClose={onClose}
      />
    );

    const toast = screen.getByRole('alert');
    fireEvent.mouseEnter(toast);

    act(() => {
      vi.advanceTimersByTime(12000);
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('merges duplicate visible notifications and displays the count', () => {
    vi.useFakeTimers();
    render(<NotificationContainer />);

    act(() => {
      window.dispatchEvent(new CustomEvent('showGlobalNotification', {
        detail: { type: 'success', title: '同步完成', message: '资料库已同步' },
      }));
      window.dispatchEvent(new CustomEvent('showGlobalNotification', {
        detail: { type: 'success', title: '同步完成', message: '资料库已同步' },
      }));
      window.dispatchEvent(new CustomEvent('showGlobalNotification', {
        detail: { type: 'success', title: '同步完成', message: '资料库已同步' },
      }));
    });

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText('x3')).toHaveClass('unified-notification-count');
    vi.useRealTimers();
  });
});
