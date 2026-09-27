import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isMobilePlatformMock } = vi.hoisted(() => ({
  isMobilePlatformMock: vi.fn(),
}));

vi.mock('@/utils/platform', () => ({
  isMobilePlatform: isMobilePlatformMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The hook only stores icon references. Avoid loading the complete icon library
// while testing navigation membership and platform gates.
vi.mock('@phosphor-icons/react', () => {
  const Icon = () => null;
  return {
    BookOpen: Icon,
    Brain: Icon,
    ChartBar: Icon,
    ClockCountdown: Icon,
    FileText: Icon,
    Flask: Icon,
    Globe: Icon,
    Keyboard: Icon,
    Microphone: Icon,
    Palette: Icon,
    Plug: Icon,
    PuzzlePiece: Icon,
    Robot: Icon,
    Shield: Icon,
    SlidersHorizontal: Icon,
    SquaresFour: Icon,
    Wrench: Icon,
  };
});

import { useSettingsNavigation } from '../useSettingsNavigation';

const EXPECTED_DESKTOP_CATEGORIES = [
  { value: 'ai', tabs: ['apis', 'models', 'params'] },
  { value: 'experience', tabs: ['general', 'appearance', 'workbench', 'shortcuts'] },
  { value: 'personalization', tabs: ['voice-input', 'memory'] },
  { value: 'integrations', tabs: ['mcp', 'search', 'plugins'] },
  { value: 'workflow', tabs: ['automation', 'document-processing'] },
  { value: 'data', tabs: ['statistics', 'data-governance'] },
];

const DESKTOP_ONLY_TABS = ['workbench', 'plugins', 'shortcuts'];

describe('settings category navigation compatibility', () => {
  beforeEach(() => {
    isMobilePlatformMock.mockReturnValue(false);
  });

  it('places all 16 existing settings tabs in exactly one of six categories', () => {
    const { result } = renderHook(() => useSettingsNavigation());
    const categories = result.current.sidebarCategories.map((category) => ({
      value: category.value,
      tabs: category.items.map((item) => item.value),
    }));

    expect(categories).toEqual(EXPECTED_DESKTOP_CATEGORIES);
    const categorizedTabs = categories.flatMap((category) => category.tabs);
    expect(categorizedTabs).toHaveLength(16);
    expect(new Set(categorizedTabs).size).toBe(16);
    expect([...categorizedTabs].sort()).toEqual(
      result.current.sidebarNavItems
        .filter((item) => item.value !== 'about')
        .map((item) => item.value)
        .sort(),
    );
  });

  it.each([false, true])('keeps About addressable and searchable outside categories (mobile=%s)', (isMobile) => {
    isMobilePlatformMock.mockReturnValue(isMobile);
    const { result } = renderHook(() => useSettingsNavigation());

    expect(result.current.sidebarNavItems.filter((item) => item.value === 'about')).toHaveLength(1);
    expect(result.current.settingsSearchIndex.some((item) => item.tab === 'about')).toBe(true);
    expect(result.current.sidebarCategories.flatMap((category) => category.items))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ value: 'about' })]));
  });

  it('keeps desktop-only pages in both desktop navigation and search', () => {
    const { result } = renderHook(() => useSettingsNavigation());
    const navTabs = result.current.sidebarNavItems.map((item) => item.value);
    const searchTabs = result.current.settingsSearchIndex.map((item) => item.tab);
    const categoryTabs = result.current.sidebarCategories.flatMap((category) =>
      category.items.map((item) => item.value),
    );

    for (const tab of DESKTOP_ONLY_TABS) {
      expect(navTabs).toContain(tab);
      expect(searchTabs).toContain(tab);
      expect(categoryTabs).toContain(tab);
    }
    expect(navTabs).toHaveLength(17);
  });

  it.each([
    { tab: 'about', keywords: ['about', 'version', 'acknowledgements'] },
    { tab: 'plugins', keywords: ['plugins', 'plugin', 'ilink', 'wechat', '微信', 'clawbot', '集成'] },
    { tab: 'shortcuts', keywords: ['shortcuts', 'keyboard', 'hotkey'] },
  ])('preserves legacy search aliases when merging the $tab section entry', ({ tab, keywords }) => {
    const { result } = renderHook(() => useSettingsNavigation());
    const section = result.current.sidebarNavItems.find((item) => item.value === tab)!;
    const entries = result.current.settingsSearchIndex.filter((item) =>
      item.tab === tab && item.label === section.label);

    expect(entries).toHaveLength(1);
    expect(entries[0].keywords).toEqual(expect.arrayContaining(keywords));
    const category = result.current.sidebarCategories.find((entry) =>
      entry.items.some((item) => item.value === tab));
    if (category) expect(entries[0].keywords).toContain(category.label);
  });

  it('hides desktop-only pages on mobile without dropping any remaining category or page', () => {
    isMobilePlatformMock.mockReturnValue(true);
    const { result } = renderHook(() => useSettingsNavigation());
    const categories = result.current.sidebarCategories.map((category) => ({
      value: category.value,
      tabs: category.items.map((item) => item.value),
    }));

    expect(categories).toEqual(EXPECTED_DESKTOP_CATEGORIES.map((category) => ({
      ...category,
      tabs: category.tabs.filter((tab) => !DESKTOP_ONLY_TABS.includes(tab)),
    })));

    const navTabs = result.current.sidebarNavItems.map((item) => item.value);
    const searchTabs = result.current.settingsSearchIndex.map((item) => item.tab);
    for (const tab of DESKTOP_ONLY_TABS) {
      expect(navTabs).not.toContain(tab);
      expect(searchTabs).not.toContain(tab);
    }
    expect(navTabs).toHaveLength(14);
    expect(categories.flatMap((category) => category.tabs)).toHaveLength(13);
  });
});
