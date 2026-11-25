import { renderHook } from '@testing-library/react';
import * as icons from '@phosphor-icons/react';
import { describe, expect, it, vi } from 'vitest';
import {
  mergeDataGovernanceSearchEntries,
  useSettingsNavigation,
  type SettingsSearchIndexItem,
} from '@/features/settings/components/useSettingsNavigation';
import { legacyNavigation } from './legacy';
import golden from './settings.json';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/utils/platform', () => ({ isMobilePlatform: () => platform.mobile }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const normalizeKeywords = (items: SettingsSearchIndexItem[]) =>
  items.map((item) => ({ ...item, keywords: [...item.keywords].sort() }));

describe('legacy evidence extractor independently checked against the unchanged real hook', () => {
  it.each([false, true])('preserves Map iteration and the entire search index (mobile=%s)', (mobile) => {
    platform.mobile = mobile;
    const { result, unmount } = renderHook(() => useSettingsNavigation());
    const iconNames = new Map(Object.entries(icons).map(([name, icon]) => [icon, name]));
    for (const [name, icon] of Object.entries(icons)) if (!name.endsWith('Icon')) iconNames.set(icon, name);
    const actual = JSON.parse(JSON.stringify(result.current, (key, item) => key === 'icon' ? iconNames.get(item) : item));
    expect(actual.settingsSearchIndex.length).toBeGreaterThan(actual.sidebarNavItems.length);
    expect(legacyNavigation(mobile)).toEqual(actual);
    const expected = golden.navigation[mobile ? 'mobile' : 'desktop'];
    expect(actual.sidebarNavGroups).toEqual(expected.sidebarNavGroups);
    expect(actual.sidebarNavItems).toEqual(expected.sidebarNavItems);
    expect(actual.sidebarCategories).toEqual(expected.sidebarCategories);
    // useSettingsNavigation intentionally enriches settingsSearchIndex with Data Governance sub-tab
    // entries & bilingual keywords via mergeDataGovernanceSearchEntries (commit dde02b90d).
    expect(normalizeKeywords(actual.settingsSearchIndex)).toEqual(
      normalizeKeywords(mergeDataGovernanceSearchEntries(expected.settingsSearchIndex, (key) => key)),
    );
    unmount();
  });
});
