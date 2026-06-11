import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage toast lab', () => {
  it('renders toast comparison controls and triggers global notifications', async () => {
    const user = userEvent.setup();
    const notificationListener = vi.fn();
    window.addEventListener('showGlobalNotification', notificationListener);

    render(<StyleDebugPage />);

    await user.click(screen.getByRole('button', { name: '组件对比' }));
    await user.click(screen.getByRole('button', { name: 'Toast' }));

    expect(screen.getByText('Toast')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '触发 Success' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '触发 Warning' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '触发 Error' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '触发 Info' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '触发 Success' }));

    expect(notificationListener).toHaveBeenCalledTimes(1);
    expect(notificationListener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        type: 'success',
        title: '同步完成',
      },
    });

    window.removeEventListener('showGlobalNotification', notificationListener);
  });
});
