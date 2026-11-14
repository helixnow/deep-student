import type { TFunction } from 'i18next';
import type { SettingsSection, SettingsVisibilityContext } from '@/ui-kernel/contracts/settings';
import type { SlotEntry } from '@/ui-kernel/slots';
import { settingsIcon } from './isolation';
import type { SettingsSearchIndexItem, SettingsSidebarCategory, SettingsSidebarNavItem } from '@/features/settings/components/useSettingsNavigation';

/** Derive the legacy navigation shapes from slot entries; no section list lives here. */
export function settingsNavigation(slotEntries: readonly SlotEntry<SettingsSection>[], t: TFunction, context: SettingsVisibilityContext) {
  // `plugin-manager` absorbs the legacy WeChat channel page. Keeping the `plugins` definition intact
  // preserves `dstu.ui.settings` goldens, but when the manager is mounted the sidebar must show one
  // unified entry only. The id is a literal to keep the settings chunk free of plugin-manager code.
  const hasPluginManager = slotEntries.some((entry) => entry.value.id === 'plugin-manager');
  const visibleEntries = slotEntries.filter(({ value: section }) =>
    !(hasPluginManager && section.id === 'plugins') && section.navigation && (section.visible?.(context) ?? true))
    .sort((a, b) => a.value.navigation!.order - b.value.navigation!.order);
  const visible = visibleEntries.map((entry) => entry.value);
  const sidebarNavGroups: SettingsSidebarNavItem[][] = [];
  const itemById = new Map<string, SettingsSidebarNavItem>();
  for (const entry of visibleEntries) {
    const section = entry.value;
    const nav = section.navigation!;
    const item: SettingsSidebarNavItem = {
      value: section.id, icon: settingsIcon(nav.icon, entry), label: t(section.titleKey),
      ...(nav.tourId ? { tourId: nav.tourId } : {}),
      mobileDescription: t(nav.mobileDescriptionKey), mobileAccent: nav.mobileAccent,
    };
    (sidebarNavGroups[nav.legacyGroup] ??= []).push(item);
    itemById.set(section.id, item);
  }
  const sidebarNavItems = sidebarNavGroups.flat();
  const categories = [...new Map(visibleEntries.filter((entry) => entry.value.navigation!.category)
    .map((entry) => [entry.value.navigation!.category!.id, { category: entry.value.navigation!.category!, entry }])).values()]
    .sort((a, b) => a.category.order - b.category.order);
  const sidebarCategories: SettingsSidebarCategory[] = categories.map(({ category, entry }) => ({
    value: category.id, label: t(category.titleKey), icon: settingsIcon(category.icon, entry),
    items: visible.filter((section) => section.navigation!.category?.id === category.id)
      .sort((a, b) => a.navigation!.categoryOrder - b.navigation!.categoryOrder)
      .map((section) => itemById.get(section.id)!),
  }));
  const categoryByTab = new Map(sidebarCategories.flatMap((category) =>
    category.items.map((item) => [item.value, category.label] as const)));
  const sectionEntries = sidebarNavItems.map((item) => ({
    tab: item.value, label: item.label, keywords: [item.value, categoryByTab.get(item.value) ?? ''],
  }));
  const settingDetails = visible.flatMap((section) => (section.searchDetails ?? []).map((detail) => ({
    tab: section.id, order: detail.order,
    label: detail.labelKey ? t(detail.labelKey, detail.defaultValue ? { defaultValue: detail.defaultValue } : {}) : detail.label!,
    keywords: detail.keywords,
  }))).sort((a, b) => a.order - b.order).map(({ order, ...detail }) => detail);
  const entries = new Map<string, SettingsSearchIndexItem>();
  for (const item of [...sectionEntries, ...settingDetails]) {
    const key = `${item.tab}:${item.label}`;
    const existing = entries.get(key);
    entries.set(key, { ...item, keywords: [...new Set([...(existing?.keywords ?? []), ...item.keywords])] });
  }
  return { sidebarNavGroups, sidebarNavItems, sidebarCategories, settingsSearchIndex: [...entries.values()] };
}
