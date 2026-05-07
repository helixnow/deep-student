import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

describe('StyleDebugPage toast lab', () => {
  it('renders a dedicated toast debug tab with preview states and triggers global notifications', async () => {
    const user = userEvent.setup();
    const notificationListener = vi.fn();
    window.addEventListener('showGlobalNotification', notificationListener);

    render(<StyleDebugPage />);

    await user.click(screen.getByRole('button', { name: 'Toast 调试' }));

    expect(screen.getByRole('button', { name: 'Toast 调试' })).toBeInTheDocument();
    expect(screen.getByText('统一 Toast 调试')).toBeInTheDocument();
    expect(screen.getByText('UnifiedNotification / 全局入口')).toBeInTheDocument();
    expect(screen.getByText('静态状态预览')).toBeInTheDocument();
    expect(screen.getByText('顶部居中')).toBeInTheDocument();
    expect(screen.getByText('小圆条')).toBeInTheDocument();
    expect(screen.getByText('icon 参数')).toBeInTheDocument();
    expect(screen.getByText('右侧关闭')).toBeInTheDocument();
    expect(screen.getByText('低打扰')).toBeInTheDocument();
    expect(screen.getByText('状态边框')).toBeInTheDocument();
    expect(screen.getByText('progress 参数')).toBeInTheDocument();
    expect(screen.getByText('重复合并')).toBeInTheDocument();
    expect(screen.getByText('命令 action')).toBeInTheDocument();
    expect(screen.getByText('hover 展开')).toBeInTheDocument();
    expect(screen.getByText('黑色边')).toBeInTheDocument();
    expect(screen.getByText('Icon parameter')).toBeInTheDocument();
    expect(screen.getByText('Progress parameter')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重复触发 success toast' })).toBeInTheDocument();
    expect(screen.getByText('增强实验矩阵')).toBeInTheDocument();
    expect(screen.getByText('Warning / Error emphasized')).toBeInTheDocument();
    expect(screen.getByText('Action command toast')).toBeInTheDocument();
    expect(screen.getByText('Long copy expand toast')).toBeInTheDocument();
    expect(screen.getByText('Merged duplicate toast')).toBeInTheDocument();
    expect(screen.getByText('Success toast')).toBeInTheDocument();
    expect(screen.getByText('Warning toast')).toBeInTheDocument();
    expect(screen.getByText('Error toast')).toBeInTheDocument();
    expect(screen.getByText('Info API / neutral toast')).toBeInTheDocument();
    expect(screen.getAllByText('info -> neutral').length).toBeGreaterThan(0);
    expect(screen.getByText('Neutral border toast')).toBeInTheDocument();
    expect(screen.getAllByLabelText('关闭通知预览').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Info API / neutral toast preview')).toHaveClass('unified-notification-neutral');
    expect(screen.getByLabelText('Info API / neutral toast preview')).not.toHaveClass('unified-notification-info');

    await user.click(screen.getByRole('button', { name: '触发 success toast' }));
    await user.click(screen.getByRole('button', { name: '重复触发 success toast' }));

    expect(notificationListener).toHaveBeenCalledTimes(4);
    expect(notificationListener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        type: 'success',
        title: 'Toast 调试：Success',
      },
    });

    window.removeEventListener('showGlobalNotification', notificationListener);
  });
});
