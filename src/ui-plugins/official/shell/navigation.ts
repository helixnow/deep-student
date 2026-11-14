import type { SlotEntry } from '@/ui-kernel/slots';
import type { ShellNavItem, ShellVisibilityContext, ShellViewContribution } from '@/ui-kernel/contracts/shell';
import type { CurrentView } from '@/types/navigation';
import { canonicalizeView } from '@/app/navigation/canonicalView';
import { officialShellViewIds } from './index';

/** §6.2: unplaced community contributions follow official navigation. Preserve
 * the slot's order/id ordering inside each group and explicit placements.
 */
export function shellNavigationItems(
  entries: readonly SlotEntry<ShellNavItem>[],
  context: ShellVisibilityContext,
  surface: 'desktop' | 'mobile',
) {
  return entries
    .filter(({ value }) => !value.visible || value.visible(context))
    .map(entry => ({
      ...entry.value, owner: entry.owner, origin: entry.origin,
      desktop: entry.origin === 'community' && !entry.value.desktop?.placement
        ? { ...entry.value.desktop, placement: 'primary' as const } : entry.value.desktop,
      mobile: entry.origin === 'community' && !entry.value.mobile?.placement
        ? { ...entry.value.mobile, placement: 'launcher' as const } : entry.value.mobile,
      defaultPlacement: entry.origin === 'community' && !entry.value[surface]?.placement,
    }))
    .sort((a, b) => Number(a.defaultPlacement) - Number(b.defaultPlacement));
}

/** Keep all original official/alias canonicalization; only registered new keys
 * extend the shell's routing set. Key collisions remain the kernel's concern.
 */
export function resolveShellView(view: string, entries: readonly SlotEntry<ShellViewContribution>[]): CurrentView {
  if (!officialShellViewIds.has(view) && entries.some(entry => entry.key === view)) return view as CurrentView;
  return canonicalizeView(view);
}
