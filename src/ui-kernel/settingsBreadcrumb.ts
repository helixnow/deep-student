import type { TFunction } from 'i18next';
import type { SettingsSection, SettingsVisibilityContext } from './contracts/settings';
import type { SlotEntry } from './slots';

/** Resolve the active settings category (or standalone section) label for topbar breadcrumbs. */
export function resolveSettingsBreadcrumbLabel(
  slotEntries: readonly SlotEntry<SettingsSection>[],
  activeTab: string | undefined,
  t: TFunction,
  context: SettingsVisibilityContext,
): string | null {
  if (!activeTab || slotEntries.length === 0) return null;
  const hasPluginManager = slotEntries.some((entry) => entry.value.id === 'plugin-manager');
  const resolvedTab = hasPluginManager && activeTab === 'plugins' ? 'plugin-manager' : activeTab;

  const visibleEntries = slotEntries
    .filter(
      ({ value: section }) =>
        !(hasPluginManager && section.id === 'plugins') &&
        section.navigation &&
        (section.visible?.(context) ?? true),
    )
    .sort((a, b) => a.value.navigation!.order - b.value.navigation!.order);

  const categoryTitleKeyById = new Map<string, string>();
  for (const entry of visibleEntries) {
    const category = entry.value.navigation!.category;
    if (category) {
      categoryTitleKeyById.set(category.id, category.titleKey);
    }
  }

  const visibleMatch = visibleEntries.find((entry) => entry.value.id === resolvedTab);
  if (visibleMatch?.value.navigation?.category) {
    const titleKey =
      categoryTitleKeyById.get(visibleMatch.value.navigation.category.id) ??
      visibleMatch.value.navigation.category.titleKey;
    return t(titleKey);
  }

  const activeSection = slotEntries.find(
    (entry) => entry.key === resolvedTab || entry.value.id === resolvedTab,
  );
  if (activeSection?.value.desktopHeadingKey) return t(activeSection.value.desktopHeadingKey);
  if (visibleMatch) return t(visibleMatch.value.titleKey);
  if (activeSection) return t(activeSection.value.titleKey);
  return null;
}
