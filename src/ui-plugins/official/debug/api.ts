/**
 * `debug.panels` (FE-B7): the Analysis Panel entries. Development builds only — the official panels load with
 * `src/debug-panel/panels.ts` (imported by DebugPanelHost behind `import.meta.env.DEV`) and announce themselves
 * here; `dstu.ui.debug` mirrors every announcement into its slot. Nothing in this module imports a panel.
 */
import type { ComponentType } from 'react';
import { createLazyContributionPoint } from '@/ui-sdk/lazy';

export interface DebugPanelHostProps {
  visible: boolean;
  onClose: () => void;
  currentStreamId?: string;
}

export interface DebugPanelPluginProps extends DebugPanelHostProps {
  isActive: boolean;
  isActivated: boolean;
}

export interface DebugPanel {
  id: string;
  labelKey: string;
  descriptionKey: string;
  labelDefault?: string;
  descriptionDefault?: string;
  /** Home screen group of the host; a panel in an unknown group is only reachable through `DSTU_DEBUG_PLUGIN`. */
  groupId: string;
  component: ComponentType<DebugPanelPluginProps>;
}

declare module '@/ui-kernel/slot-map' {
  interface SlotMap {
    'debug.panels': DebugPanel;
  }
}

/** Without a UI kernel (lightweight windows, bare tests) the host reads the announcements directly. */
let unattached: readonly DebugPanel[] = [];
const listeners = new Set<() => void>();

function update(next: readonly DebugPanel[]) {
  unattached = next;
  for (const listener of [...listeners]) listener();
}

export const debugPanelContributions = createLazyContributionPoint<DebugPanel>('debug.panels', (panel) => {
  update([...unattached, panel]);
  return () => update(unattached.filter((candidate) => candidate !== panel));
});

export function unattachedDebugPanels(): readonly DebugPanel[] {
  return unattached;
}

export function subscribeUnattachedDebugPanels(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
