import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

    fireEvent.click(closeButton);
    act(() => {
      vi.advanceTimersByTime(180);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
