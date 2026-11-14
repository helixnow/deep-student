import React, { type ComponentType } from 'react';
import type { SlotEntry } from '@/ui-kernel/slots';

export const CommunityErrorBoundary = React.lazy(() => import('@/components/ErrorBoundary'));

type Icon = ComponentType<{ className?: string }>;
const emptyIcon = () => null;
const isolatedIcons = new WeakMap<Icon, Map<string, Icon>>();

/** Builtin icons are returned unchanged; community icons fail to an empty icon, leaving label and click intact. */
export function settingsIcon(icon: Icon, entry: SlotEntry<unknown>): Icon {
  if (entry.origin === 'builtin') return icon;
  const name = `settings:${entry.id}:icon`;
  let byName = isolatedIcons.get(icon);
  if (!byName) isolatedIcons.set(icon, byName = new Map());
  let isolated = byName.get(name);
  if (!isolated) {
    const Original = icon;
    isolated = (props) => (
      <React.Suspense fallback={null}>
        <CommunityErrorBoundary name={name} fallback={emptyIcon}><Original {...props} /></CommunityErrorBoundary>
      </React.Suspense>
    );
    byName.set(name, isolated);
  }
  return isolated;
}
