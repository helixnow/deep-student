import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SuperInboxPausedBanner } from '../SuperInboxPausedBanner';
import { INITIAL_SUPER_RESIDENT_STATE, superResidentStore } from '../residentState';

describe('SuperInboxPausedBanner', () => {
  beforeEach(() => {
    superResidentStore.setState({ ...INITIAL_SUPER_RESIDENT_STATE });
  });

  it('is hidden when not paused or for other sessions', () => {
    superResidentStore.setState({ sessionId: 'sess_super', pendingInbox: 3 });
    const { rerender } = render(<SuperInboxPausedBanner sessionId="sess_super" />);
    expect(screen.queryByTestId('super-inbox-paused-banner')).toBeNull();

    act(() => superResidentStore.setState({ pausedReason: 'user_stop' }));
    rerender(<SuperInboxPausedBanner sessionId="sess_other" />);
    expect(screen.queryByTestId('super-inbox-paused-banner')).toBeNull();
  });

  it('hides the user-stop banner when nothing is pending', () => {
    superResidentStore.setState({ sessionId: 'sess_super', pausedReason: 'user_stop', pendingInbox: 0 });
    render(<SuperInboxPausedBanner sessionId="sess_super" />);
    expect(screen.queryByTestId('super-inbox-paused-banner')).toBeNull();
  });

  it('shows the pending count after a user stop and resumes on click', () => {
    const onResume = vi.fn(async () => null);
    superResidentStore.setState({ sessionId: 'sess_super', pausedReason: 'user_stop', pendingInbox: 3 });
    render(<SuperInboxPausedBanner sessionId="sess_super" onResume={onResume} />);
    expect(screen.getByText('已停止，后台事件暂停自动处理')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续处理 3 条待处理事件' }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('shows the auto-turn limit message even without a known count', () => {
    superResidentStore.setState({ sessionId: 'sess_super', pausedReason: 'auto_limit', autoTurns: 20 });
    render(<SuperInboxPausedBanner sessionId="sess_super" />);
    expect(screen.getByText('已连续自动处理 20 轮，后台事件暂停自动处理')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续处理待处理事件' })).toBeInTheDocument();
  });
});
