/**
 * Workbench app contributions (FE-B4).
 *
 * The app modules (`apps/<name>/register.ts`, loaded with the Workbench chunk) call `contributeWorkbenchApp(def)`;
 * the official UI plugin `dstu.ui.workbench` contributes each definition through `ctx.ui.workbench.registerApp`, so
 * the apps belong to that plugin and disappear with it. Without that plugin (lightweight windows, tests without a
 * UI kernel) definitions go straight into `appRegistry`, as before.
 */
import { createLazyContributionPoint } from '@/ui-sdk/lazy';
import { appRegistry } from './appRegistry';
import type { AppDefinition } from './types';

export const workbenchAppContributions = createLazyContributionPoint<AppDefinition>('workbench.apps', (def) => {
  appRegistry.register(def);
  return () => { appRegistry.unregister(def.typeId, def); };
});

export function contributeWorkbenchApp(def: AppDefinition): void {
  workbenchAppContributions.announce(def);
}
