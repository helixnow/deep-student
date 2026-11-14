/** Main app assembly only: contributes under dstu.ui.settings, not a second official plugin directory. */
import type { Context } from '@deepseek-ai/cordis';
import { settingsFeatureContributions } from '@/ui-plugins/official/settings';
import { PluginManagerController } from './controller';
import { createHostPluginManagerAdapter } from './host-adapter';
import { createPluginManagerSection } from './mount';
import type { PluginManagerWorkshop } from './workshop';

export function mountProductionPluginManager(ctx: Context, workshop?: PluginManagerWorkshop): void {
  const uiStatus = ctx.ui.hostStatus; // Required real W17 handle. Never optional on the production path.
  const adapter = createHostPluginManagerAdapter(ctx.ui.platform.kind);
  // Host-status pushes trigger inventory reconciliation, including changes originating outside this page.
  adapter.subscribe = (listener) => uiStatus.subscribe(listener);
  const controller = new PluginManagerController(adapter);
  ctx.effect(() => () => controller.dispose());
  ctx.ui.settings.register(createPluginManagerSection({ controller, uiStatus, workshop }));
}

settingsFeatureContributions.announce(mountProductionPluginManager);
