import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from '@/ui-plugins/official/settings';
import { Settings } from '../Settings';

/**
 * Settings 外壳渲染冒烟：桌面工作区与移动端两级导航各渲染一次，并进入分区内容态。
 *
 * W36 把外壳拆成 useSettingsMobileShell / SettingsMainContent 等模块后，
 * 分区 hook、懒加载分区与右滑面板都不再有直接渲染 Settings 的回归测试；
 * 这里只验证外壳两种承载方式能挂载、分区内容区存在且不抛错。
 */
const state = vi.hoisted(() => ({ mobile: false, small: false }));

vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isMobilePlatform: () => state.mobile,
}));
vi.mock('@/hooks/useBreakpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useBreakpoint')>()),
  useBreakpoint: () => ({ isSmallScreen: state.small, isMobile: state.mobile, breakpoint: 'lg' }),
  useIsMobile: () => state.small,
}));
// useVendorModels 每次返回稳定引用：真实实现在 store 侧保持引用稳定，
// 这里若每次新建对象会触发 config 同步 effect 无限重跑。
vi.mock('@/hooks/useVendorModels', () => {
  const stable = {
    vendors: [], modelProfiles: [], modelAssignments: {}, resolvedApiConfigs: [],
    openAICodexAuthenticated: false, loading: false, saving: false,
    upsertVendor: vi.fn(), deleteVendor: vi.fn(), upsertModelProfile: vi.fn(), deleteModelProfile: vi.fn(),
    saveModelAssignments: vi.fn(), persistModelProfiles: vi.fn(), persistVendors: vi.fn(),
  };
  return { useVendorModels: () => stable };
});

async function renderSettings() {
  const kernel = new UiKernel();
  await kernel.install(settingsPlugin, { origin: 'builtin' });
  const view = render(<UiKernelProvider kernel={kernel}><Settings onBack={() => {}} isActive /></UiKernelProvider>);
  return { view, kernel };
}

describe('Settings shell renders', () => {
  it('mounts the desktop workspace with the section content area', async () => {
    state.mobile = false;
    state.small = false;
    const { view, kernel } = await renderSettings();
    expect(view.container.querySelector('[data-wb-settings-content-ready]')).not.toBeNull();
    expect(view.container.querySelector('#settings-main-content')).not.toBeNull();
    view.unmount();
    await kernel.dispose();
  });

  it('mounts the mobile section list and opens a section content page', async () => {
    state.mobile = true;
    state.small = true;
    const { view, kernel } = await renderSettings();
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).not.toBeNull());
    expect(view.container.querySelector('[data-wb-settings-content-ready]')).not.toBeNull();

    const categories = view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    fireEvent.click(within(categories).getAllByRole('button')[0]!);
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="content"]')).not.toBeNull());
    expect(view.container.querySelector('#settings-main-content')).not.toBeNull();

    view.unmount();
    await kernel.dispose();
  });
});
