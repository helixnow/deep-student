import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from '@/ui-plugins/official/settings';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import {
  MobileHeaderProvider,
  MobileLayoutProvider,
  useSetMobileHeaderActiveView,
} from '@/components/layout';
import { Settings } from '../Settings';

/**
 * Settings 外壳渲染冒烟：桌面工作区与移动端两级导航各渲染一次，并进入分区内容态。
 *
 * W36 把外壳拆成 useSettingsMobileShell / SettingsMainContent 等模块后，
 * 分区 hook、懒加载分区与右滑面板都不再有直接渲染 Settings 的回归测试；
 * 这里只验证外壳两种承载方式能挂载、分区内容区存在且不抛错。
 */
const state = vi.hoisted(() => ({
  mobile: false,
  small: false,
  lang: 'zh-CN' as 'en-US' | 'zh-CN',
}));

vi.mock('react-i18next', async () => {
  const [enSettings, zhSettings, enCommon, zhCommon] = await Promise.all([
    import('@/locales/en-US/settings.json'),
    import('@/locales/zh-CN/settings.json'),
    import('@/locales/en-US/common.json'),
    import('@/locales/zh-CN/common.json'),
  ]);
  const bundles: Record<'en-US' | 'zh-CN', Record<string, Record<string, unknown>>> = {
    'en-US': {
      settings: enSettings.default as Record<string, unknown>,
      common: enCommon.default as Record<string, unknown>,
    },
    'zh-CN': {
      settings: zhSettings.default as Record<string, unknown>,
      common: zhCommon.default as Record<string, unknown>,
    },
  };
  const lookup = (root: Record<string, unknown>, path: string): string | undefined => {
    if (typeof root[path] === 'string') return root[path] as string;
    let cur: unknown = root;
    for (const part of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === 'string' ? cur : undefined;
  };
  const cache = new Map<
    string,
    {
      t: (key: string, opts?: unknown) => string;
      i18n: { language: string; changeLanguage: () => Promise<void> };
    }
  >();
  return {
    initReactI18next: { type: '3rdParty', init: () => {} },
    Trans: ({ i18nKey, children }: { i18nKey?: string; children?: React.ReactNode }) => (
      <>{i18nKey ?? children}</>
    ),
    useTranslation: (ns?: string | string[]) => {
      const lang = state.lang;
      const defaultNs = Array.isArray(ns) ? ns[0] : (ns ?? 'common');
      const cacheKey = `${lang}:${defaultNs}`;
      let entry = cache.get(cacheKey);
      if (!entry) {
        const t = (key: string, opts?: unknown): string => {
          if (typeof opts === 'string') return opts;
          let resolvedKey = key;
          let targetNs = defaultNs;
          if (key.includes(':')) {
            const [prefix, rest] = key.split(':', 2);
            targetNs = prefix;
            resolvedKey = rest;
          }
          const bundle = bundles[lang]?.[targetNs];
          const hit = bundle ? lookup(bundle, resolvedKey) : undefined;
          if (hit !== undefined) return hit;
          const fallback = (opts as { defaultValue?: string } | undefined)?.defaultValue;
          return typeof fallback === 'string' ? fallback : key;
        };
        entry = { t, i18n: { language: lang, changeLanguage: () => Promise.resolve() } };
        cache.set(cacheKey, entry);
      }
      return entry;
    },
  };
});

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

afterEach(() => {
  state.lang = 'zh-CN';
});

function ActiveSettingsView({ props }: { props: Partial<React.ComponentProps<typeof Settings>> }) {
  const setActiveView = useSetMobileHeaderActiveView();
  React.useLayoutEffect(() => {
    setActiveView('settings');
  }, [setActiveView]);
  return <Settings onBack={() => {}} isActive {...props} />;
}

async function renderSettings(props: Partial<React.ComponentProps<typeof Settings>> = {}) {
  const kernel = new UiKernel();
  await kernel.install(settingsPlugin, { origin: 'builtin' });
  const view = render(
    <UiKernelProvider kernel={kernel}>
      <MobileLayoutProvider>
        <MobileHeaderProvider>
          <ActiveSettingsView props={props} />
        </MobileHeaderProvider>
      </MobileLayoutProvider>
    </UiKernelProvider>,
  );
  return { view, kernel };
}

describe('Settings shell renders', () => {
  it('mounts the desktop workspace without standalone category or About headings', async () => {
    state.mobile = false;
    state.small = false;
    useSettingsShellStore.setState({ activeTab: 'apis' });
    const { view, kernel } = await renderSettings();
    await waitFor(() => {
      expect(view.container.querySelector('#settings-main-content')).not.toBeNull();
    });
    expect(view.container.querySelector('[data-wb-settings-content-ready]')).not.toBeNull();
    expect(view.container.querySelector('#settings-main-content h1')).toBeNull();

    act(() => {
      useSettingsShellStore.getState().setActiveTab('about');
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-wb-settings-active-tab="about"]')).not.toBeNull();
    });
    expect(view.container.querySelector('#settings-main-content h1')).toBeNull();

    view.unmount();
    await kernel.dispose();
  });

  it('G11a: renders visible section content immediately on 360px when embeddedInWorkbench is true without a duplicate mobile shell', async () => {
    state.mobile = false;
    state.small = true;
    useSettingsShellStore.setState({ activeTab: 'general' });

    const { view, kernel } = await renderSettings({ embeddedInWorkbench: true });

    await waitFor(() => {
      expect(view.container.querySelector('[data-wb-settings-content-ready]')).not.toBeNull();
      expect(view.container.querySelector('#settings-main-content')).not.toBeNull();
    });
    expect(view.container.querySelector('[data-wb-settings-embedded="true"]')).not.toBeNull();
    // Must NOT mount the conflicting standalone mobile sections shell
    expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).toBeNull();
    expect(view.container.querySelector('[data-settings-mobile-sheet-level]')).toBeNull();

    // Switching tabs from Workbench sidebar updates active content directly
    act(() => {
      useSettingsShellStore.getState().setActiveTab('about');
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-wb-settings-active-tab="about"]')).not.toBeNull();
      expect(view.container.querySelector('#settings-main-content')).not.toBeNull();
    });

    view.unmount();
    await kernel.dispose();
  });

  it.each([
    { lng: 'en-US' as const },
    { lng: 'zh-CN' as const },
  ])('keeps a single UnifiedMobileHeader without duplicate subpage header or pinned cloud sync banners in $lng', async ({ lng }) => {
    state.lang = lng;
    state.mobile = true;
    state.small = true;
    const { view, kernel } = await renderSettings();
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).not.toBeNull());
    expect(view.container.querySelector('[data-wb-settings-content-ready]')).not.toBeNull();

    // Mobile Settings root must NOT hang extra cloud sync shortcut / quick-sync bars below the top header
    expect(view.queryByTestId('settings-mobile-cloud-sync-shortcut')).toBeNull();
    expect(view.queryByTestId('settings-mobile-quick-sync-now-btn')).toBeNull();
    expect(view.container.querySelectorAll('[data-mobile-shell="header"]')).toHaveLength(1);

    const categories = view.container.querySelector('[data-settings-category-list]') as HTMLElement;
    fireEvent.click(within(categories).getAllByRole('button')[0]!);
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="content"]')).not.toBeNull());
    expect(view.container.querySelector('#settings-main-content')).not.toBeNull();

    // Mobile Settings subpages must reuse the single UnifiedMobileHeader, never rendering a second subpage header
    expect(view.queryByTestId('settings-mobile-subpage-header')).toBeNull();
    expect(view.queryByTestId('settings-mobile-right-header')).toBeNull();
    const header = view.container.querySelector('[data-mobile-shell="header"]') as HTMLElement;
    expect(header).not.toBeNull();
    const backBtn = within(header).getAllByRole('button')[0]!;
    fireEvent.click(backBtn);
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).not.toBeNull());

    view.unmount();
    await kernel.dispose();
  });

  it('returns to the category list from the About subpage via the single UnifiedMobileHeader back button', async () => {
    state.lang = 'en-US';
    state.mobile = true;
    state.small = true;
    const { view, kernel } = await renderSettings();
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).not.toBeNull());

    const aboutFooter = view.container.querySelector('[data-settings-about-footer]') as HTMLElement;
    expect(aboutFooter).not.toBeNull();
    fireEvent.click(within(aboutFooter).getByRole('button'));
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="content"]')).not.toBeNull());

    expect(view.queryByTestId('settings-mobile-subpage-header')).toBeNull();
    const header = view.container.querySelector('[data-mobile-shell="header"]') as HTMLElement;
    expect(header).not.toBeNull();
    const backBtn = within(header).getAllByRole('button')[0]!;
    fireEvent.click(backBtn);
    await waitFor(() => expect(view.container.querySelector('[data-settings-mobile-level="sections"]')).not.toBeNull());

    view.unmount();
    await kernel.dispose();
  });
});
