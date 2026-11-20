import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_EMPTY_BADGE_SNOOZE_KEY,
  MobileEmptyStateToggle,
  clearMobileEmptyBadgeSnooze,
  computeMobileEmptyBadgeSnoozeUntil,
} from '../MobileEmptyStateToggle';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('MobileEmptyStateToggle', () => {
  beforeEach(() => {
    clearMobileEmptyBadgeSnooze();
    localStorage.removeItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY);
  });

  afterEach(() => {
    clearMobileEmptyBadgeSnooze();
    vi.useRealTimers();
  });

  it('shows only the centered greeting and logo badge by default, then toggles cleanly to the card and back', () => {
    render(
      <MobileEmptyStateToggle
        title="哪个知识盲点想被照亮？"
        brandIcon={<span data-testid="brand-logo" />}
        renderCard={() => <div data-testid="today-card">冲刺小卡片</div>}
        hasAccent
        resetKey="session-1"
      />,
    );

    const toggle = screen.getByTestId('mobile-empty-logo-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('mobile-empty-logo-badge')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: '哪个知识盲点想被照亮？' })).toBeInTheDocument();
    expect(screen.queryByTestId('today-card')).toBeNull();

    // 点击 Logo → 展开卡片
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('today-card')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-empty-snooze-today')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-empty-snooze-week')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '哪个知识盲点想被照亮？' })).toBeInTheDocument();

    // 再次点击 Logo → 收起卡片，回到欢迎语
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { level: 2, name: '哪个知识盲点想被照亮？' })).toBeInTheDocument();
  });

  it('resets back to the quiet greeting when resetKey changes', () => {
    const { rerender } = render(
      <MobileEmptyStateToggle
        title="今天想学点什么？"
        brandIcon={<span data-testid="brand-logo" />}
        renderCard={() => <div data-testid="today-card">冲刺小卡片</div>}
        resetKey="session-a"
      />,
    );

    const toggle = screen.getByTestId('mobile-empty-logo-toggle');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <MobileEmptyStateToggle
        title="今天想学点什么？"
        brandIcon={<span data-testid="brand-logo" />}
        renderCard={() => <div data-testid="today-card">冲刺小卡片</div>}
        resetKey="session-b"
      />,
    );

    expect(screen.getByTestId('mobile-empty-logo-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides the collapsed badge after snoozing for today or week, keeps logo clickable, and allows restoring', () => {
    const { unmount } = render(
      <MobileEmptyStateToggle
        title="哪个知识盲点想被照亮？"
        brandIcon={<span data-testid="brand-logo" />}
        renderCard={() => <div data-testid="today-card">冲刺小卡片</div>}
        resetKey="session-1"
      />,
    );

    // 展开后选择「当天不显示」→ 自动收起并隐藏收起态气泡
    fireEvent.click(screen.getByTestId('mobile-empty-logo-toggle'));
    fireEvent.click(screen.getByTestId('mobile-empty-snooze-today'));

    expect(screen.getByTestId('mobile-empty-logo-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY)).toContain('"scope":"today"');

    // 重新挂载仍保持静默，收起态不渲染气泡
    unmount();
    render(
      <MobileEmptyStateToggle
        title="哪个知识盲点想被照亮？"
        brandIcon={<span data-testid="brand-logo" />}
        renderCard={() => <div data-testid="today-card">冲刺小卡片</div>}
        resetKey="session-2"
      />,
    );
    expect(screen.queryByTestId('mobile-empty-logo-badge')).toBeNull();

    // 静默期间主动点击 Logo 仍能打开卡片，并可点击「恢复显示」
    fireEvent.click(screen.getByTestId('mobile-empty-logo-toggle'));
    expect(screen.getByTestId('today-card')).toBeInTheDocument();
    expect(screen.getByTestId('mobile-empty-snooze-restore')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('mobile-empty-snooze-restore'));
    expect(localStorage.getItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY)).toBeNull();
    expect(screen.getByTestId('mobile-empty-snooze-week')).toBeInTheDocument();

    // 选择「本周不显示」→ 持久化 week 范围
    fireEvent.click(screen.getByTestId('mobile-empty-snooze-week'));
    expect(localStorage.getItem(MOBILE_EMPTY_BADGE_SNOOZE_KEY)).toContain('"scope":"week"');
  });

  it('computes exact local midnight boundaries for today and Monday-based week snooze', () => {
    // Saturday 2026-11-21 15:30 -> tomorrow is Sunday 2026-11-22 00:00, next Monday is 2026-11-23 00:00
    const saturday = new Date(2026, 10, 21, 15, 30, 0, 0);
    expect(computeMobileEmptyBadgeSnoozeUntil('today', saturday)).toBe(
      new Date(2026, 10, 22, 0, 0, 0, 0).getTime()
    );
    expect(computeMobileEmptyBadgeSnoozeUntil('week', saturday)).toBe(
      new Date(2026, 10, 23, 0, 0, 0, 0).getTime()
    );

    // Sunday 2026-11-22 10:00 -> next Monday is 2026-11-23 00:00 (1 day later)
    const sunday = new Date(2026, 10, 22, 10, 0, 0, 0);
    expect(computeMobileEmptyBadgeSnoozeUntil('week', sunday)).toBe(
      new Date(2026, 10, 23, 0, 0, 0, 0).getTime()
    );

    // Monday 2026-11-23 09:00 -> next Monday is 2026-11-30 00:00 (7 days later)
    const monday = new Date(2026, 10, 23, 9, 0, 0, 0);
    expect(computeMobileEmptyBadgeSnoozeUntil('week', monday)).toBe(
      new Date(2026, 10, 30, 0, 0, 0, 0).getTime()
    );
  });
});
