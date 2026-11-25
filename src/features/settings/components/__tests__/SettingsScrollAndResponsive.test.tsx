import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import settingsPlugin from '@/ui-plugins/official/settings';
import { useSettingsShellStore } from '@/stores/settingsShellStore';
import { ShellViewSwitch } from '@/components/ui/ShellViewSwitch';
import { Settings } from '../Settings';

const state = vi.hoisted(() => ({
  mobile: false,
  small: false,
  lang: 'en-US' as 'en-US' | 'zh-CN',
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
  useBreakpoint: () => ({ isSmallScreen: state.small, isMobile: state.mobile, breakpoint: 'md' }),
  useIsMobile: () => state.small,
}));
vi.mock('@/hooks/useVendorModels', () => {
  const stable = {
    vendors: [],
    modelProfiles: [],
    modelAssignments: {},
    resolvedApiConfigs: [],
    openAICodexAuthenticated: false,
    loading: false,
    saving: false,
    upsertVendor: vi.fn(),
    deleteVendor: vi.fn(),
    upsertModelProfile: vi.fn(),
    deleteModelProfile: vi.fn(),
    saveModelAssignments: vi.fn(),
    persistModelProfiles: vi.fn(),
    persistVendors: vi.fn(),
  };
  return { useVendorModels: () => stable };
});

afterEach(() => {
  state.mobile = false;
  state.small = false;
  state.lang = 'en-US';
});

async function renderSettings(initialTab: string, props: Partial<React.ComponentProps<typeof Settings>> = {}) {
  useSettingsShellStore.setState({ activeTab: initialTab });
  const kernel = new UiKernel();
  await kernel.install(settingsPlugin, { origin: 'builtin' });
  const view = render(
    <UiKernelProvider kernel={kernel}>
      <Settings onBack={() => {}} isActive {...props} />
    </UiKernelProvider>,
  );
  return { view, kernel };
}

describe('Settings scrollability (G25) & 768px/125% responsive layout (G29)', () => {
  it('ShellViewSwitch honors fullHeight=false for scrolling viewports and defaults to h-full', () => {
    const first = render(
      <ShellViewSwitch viewKey="a" fullHeight={false}>
        <div>Scroll content</div>
      </ShellViewSwitch>,
    );
    const motionBox = first.container.firstElementChild as HTMLElement;
    expect(motionBox.className).not.toContain('h-full');
    expect(motionBox.className).toContain('min-h-0');
    first.unmount();

    const second = render(
      <ShellViewSwitch viewKey="b">
        <div>Shell pane</div>
      </ShellViewSwitch>,
    );
    expect((second.container.firstElementChild as HTMLElement).className).toContain('h-full');
    second.unmount();
  });

  it('G25: keeps desktop 1440x900 Settings viewport vertically scrollable and keyboard focusable across tab switches', async () => {
    state.mobile = false;
    state.small = false;

    const { view, kernel } = await renderSettings('document-processing', { embeddedInWorkbench: true });

    await waitFor(() => {
      expect(view.container.querySelector('#settings-main-content')).not.toBeNull();
      expect(view.container.querySelector('[role="tabpanel"]')).not.toBeNull();
    });

    const mainContent = view.container.querySelector('#settings-main-content') as HTMLElement;
    expect(mainContent.className).toContain('[container-type:inline-size]');

    const viewport = view.container.querySelector('.settings-scroll-viewport') as HTMLElement;
    expect(viewport).not.toBeNull();
    expect(viewport.style.overflowY).toBe('auto');
    expect(viewport.style.overscrollBehaviorY).toBe('contain');
    expect(viewport.getAttribute('tabindex')).toBe('0');

    // ShellViewSwitch wrapper inside SettingsMainContent must not force h-full
    const tabpanel = view.container.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(tabpanel).not.toBeNull();
    const switchWrapper = tabpanel.parentElement as HTMLElement;
    expect(switchWrapper.className).not.toContain('h-full');

    // Switch tab and confirm scrollability persists
    act(() => {
      useSettingsShellStore.getState().setActiveTab('appearance');
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-wb-settings-active-tab="appearance"]')).not.toBeNull();
    });
    expect(viewport.style.overflowY).toBe('auto');

    view.unmount();
    await kernel.dispose();
  });

  it('G25: re-centers active .settings-search-hit when async section content expands after reveal, unless user scrolled', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const observed = new Map<Element, ResizeObserverCallback>();
    class MockResizeObserver {
      private cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        resizeCallbacks.push(cb);
      }
      observe(target: Element) {
        observed.set(target, this.cb);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {}
    }

    const origRO = globalThis.ResizeObserver;
    const scrollIntoViewMock = vi.fn();
    const origScrollIntoView = Element.prototype.scrollIntoView;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    try {
      const { view, kernel } = await renderSettings('document-processing', { embeddedInWorkbench: true });
      await waitFor(() => {
        expect(view.container.querySelector('.settings-scroll-viewport')).not.toBeNull();
      });

      const viewport = view.container.querySelector('.settings-scroll-viewport') as HTMLElement;
      const contentWrap = viewport.firstElementChild as HTMLElement;
      const contentObserverCb = observed.get(contentWrap);
      expect(contentObserverCb).toBeDefined();

      // Simulate viewport geometry (760px tall) and a search hit stuck near/below bottom edge
      vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
        top: 0,
        bottom: 760,
        left: 0,
        right: 1100,
        width: 1100,
        height: 760,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      const target = document.createElement('h3');
      target.className = 'settings-search-hit';
      target.textContent = 'OCR Settings';
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        top: 720,
        bottom: 750,
        left: 20,
        right: 300,
        width: 280,
        height: 30,
        x: 20,
        y: 720,
        toJSON: () => ({}),
      });
      contentWrap.appendChild(target);

      // Baseline size then async content growth (e.g. OcrSettingsSection finishes loading)
      contentObserverCb!(
        [{ target: contentWrap, contentRect: { width: 1000, height: 1100 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      scrollIntoViewMock.mockClear();

      contentObserverCb!(
        [{ target: contentWrap, contentRect: { width: 1000, height: 1650 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' });

      // Once user manually scrolls via wheel, further content resizes must not hijack scroll position
      scrollIntoViewMock.mockClear();
      fireEvent.wheel(viewport);
      contentObserverCb!(
        [{ target: contentWrap, contentRect: { width: 1000, height: 1900 } } as unknown as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(scrollIntoViewMock).not.toHaveBeenCalled();

      view.unmount();
      await kernel.dispose();
    } finally {
      globalThis.ResizeObserver = origRO;
      Element.prototype.scrollIntoView = origScrollIntoView;
    }
  });

  it('G29: renders Appearance Theme System Default without hard-clipping in 768x1024 / 125% tablet containers', async () => {
    state.lang = 'en-US';
    state.mobile = false;
    state.small = false;

    const { view, kernel } = await renderSettings('appearance', { embeddedInWorkbench: true });

    const systemDefault = await screen.findByRole('radio', { name: /System Default/i });
    const light = screen.getByRole('radio', { name: /Light/i });
    const dark = screen.getByRole('radio', { name: /Dark/i });
    expect(light).toBeInTheDocument();
    expect(dark).toBeInTheDocument();
    expect(systemDefault).toBeInTheDocument();

    const segmentedGroup = systemDefault.closest('[role="radiogroup"]') as HTMLElement;
    expect(segmentedGroup.className).toContain('max-w-full');
    expect(segmentedGroup.className).toContain('flex-wrap');
    expect(segmentedGroup.className).not.toContain('sm:flex-nowrap');

    const themeRow = segmentedGroup.closest('.group') as HTMLElement;
    expect(themeRow.className).not.toContain('overflow-hidden');
    expect(themeRow.className).toContain('[@container_(min-width:600px)]:flex-row');

    const viewport = view.container.querySelector('.settings-scroll-viewport') as HTMLElement;
    expect(viewport.style.overflowY).toBe('auto');

    // SystemWindowShared.css caps medium Settings sidebar width for 768px tablet breathing room
    const sysCss = readFileSync(
      resolve(process.cwd(), 'src/features/workbench/apps/system/SystemWindowShared.css'),
      'utf8',
    );
    expect(sysCss).toMatch(/\[data-wb-sys-app='settings'\]\[data-wb-sys-size='medium'\]\s+\.wb-sys-aside[\s\S]*width:\s*min\(var\(--wb-sidebar-width-medium,\s*240px\),\s*28%\)/);

    view.unmount();
    await kernel.dispose();
  });
});
