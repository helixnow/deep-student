/**
 * useSettingsNavigation — 学习桌面（Workbench）设置入口的平台门控
 *
 * 回归背景：Workbench 在移动端被 App.tsx 的 workbenchActive 平台护栏禁用，
 * 但设置页此前照常显示「学习桌面」Tab，切换后无任何作用（用户实测）。
 * 修复后移动端隐藏该 Tab 与搜索索引条目；桌面端行为不变。
 */
import { describe, expect, it, vi } from 'vitest';

const { isMobilePlatformMock } = vi.hoisted(() => ({ isMobilePlatformMock: vi.fn() }));

vi.mock('@/utils/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform')>();
  return {
    ...actual,
    isMobilePlatform: isMobilePlatformMock,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { renderHook } from '@testing-library/react';
import { useSettingsNavigation } from '../useSettingsNavigation';

describe('useSettingsNavigation — workbench entry platform gating', () => {
  it('desktop keeps the workbench tab and its search entries', () => {
    isMobilePlatformMock.mockReturnValue(false);
    const { result } = renderHook(() => useSettingsNavigation());

    const navValues = result.current.sidebarNavItems.map((item) => item.value);
    expect(navValues).toContain('workbench');
    expect(
      result.current.settingsSearchIndex.some((item) => item.tab === 'workbench'),
    ).toBe(true);
  });

  it('mobile hides the workbench tab and its search entries', () => {
    isMobilePlatformMock.mockReturnValue(true);
    const { result } = renderHook(() => useSettingsNavigation());

    const navValues = result.current.sidebarNavItems.map((item) => item.value);
    expect(navValues).not.toContain('workbench');
    expect(
      result.current.settingsSearchIndex.some((item) => item.tab === 'workbench'),
    ).toBe(false);
    // 相邻 Tab 不受影响（守卫只收 workbench）
    expect(navValues).toContain('memory');
    expect(navValues).toContain('appearance');
  });
});
