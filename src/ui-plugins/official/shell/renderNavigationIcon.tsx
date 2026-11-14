import React from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { SlotEntry } from '@/ui-kernel/slots';

/** Official icons retain their original rendering path; isolate only a foreign
 * contribution's icon, so its label/action and neighboring entries survive.
 */
export function renderNavigationIcon(
  origin: SlotEntry<unknown>['origin'],
  owner: string,
  id: string,
  Icon: React.ComponentType<any> | undefined,
  props: Record<string, unknown>,
) {
  if (!Icon) return null;
  const icon = <Icon {...props} />;
  return origin === 'builtin'
    ? icon
    : <ErrorBoundary key={`${owner}/${id}`} name={`nav-icon:${owner}/${id}`} fallback={() => null}>{icon}</ErrorBoundary>;
}
