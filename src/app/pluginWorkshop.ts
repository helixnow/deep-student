// RUST-FIX(RF-P5-workshop-assembly): root composition preserves the paired workshop UI caller.
import { workshopContributions } from '@/ui-plugins/official/plugin-workshop/api';
import { HostWorkshopAdapter, createWorkshopIntegration, type WorkshopRemote } from '@/features/plugin-workshop';
import { createHostPluginManagerAdapter } from '@/features/plugin-manager/host-adapter';
import { registerPluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import { registerHostSkill, type HostSkillResource } from '@/features/chat/skills/hostResources';

workshopContributions.announce(ctx => {
  const remote = ctx.ui.host.pluginWorkshop as unknown as WorkshopRemote;
  const resources = ctx.ui.host.pluginWorkshop as unknown as { developmentSkill(includeContent?: boolean): Promise<HostSkillResource> };
  let skillReady: Promise<void>;
  ctx.effect(() => {
    let disposed = false;
    let unregister: (() => void) | undefined;
    skillReady = resources.developmentSkill(false).then(resource => {
      if (!disposed) unregister = registerHostSkill(resource, () => resources.developmentSkill(true));
    });
    void skillReady.catch(error => console.error('[plugin-workshop] skill discovery failed', error));
    return () => { disposed = true; unregister?.(); };
  });
  const manager = createHostPluginManagerAdapter(ctx.ui.platform.kind);
  const openPluginView = async (pluginId: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const viewEntry = ctx.ui.slots.list('views').find(entry => entry.owner === pluginId);
      if (viewEntry?.key) {
        ctx.ui.navigation.navigate(viewEntry.key);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const adapter = new HostWorkshopAdapter(remote, manager, openPluginView);
  const integration = createWorkshopIntegration({
    adapter,
    sessions: {
      bindSession: async (id, revision, sessionId) => { await remote.bindSession(id, revision, sessionId); },
      create: async options => {
        await skillReady;
        return (await import('@/features/chat/workshop')).workshopSessions.create(options);
      },
      activateSkill: async (id, skill) => (await import('@/features/chat/workshop')).workshopSessions.activateSkill(id, skill),
      navigate: id => { void import('@/features/chat/workshop').then(({ workshopSessions }) => workshopSessions.navigate(id))
        .catch(error => console.error('[plugin-workshop] navigation failed', error)); },
    },
    reportError: message => { void import('@/components/UnifiedNotification').then(({ showGlobalNotification }) =>
      showGlobalNotification('error', message)).catch(error => console.error('[plugin-workshop]', message, error)); },
  });
  ctx.effect(() => registerPluginManagerWorkshop(integration.workshop));
  ctx.ui.contribute('chat.toolResults', {
    id: 'dstu-plugin-workshop-confirmation', key: 'dstu_plugin_propose_install', value: integration.toolResult,
  });
  ctx.effect(() => ctx.ui.onPluginDisabled((id, errors) => {
    void remote.list().then(async cards => {
      const card = cards.find(item => item.pluginId === id && item.state === 'installed');
      if (card && remote.reportFault) await remote.reportFault(card.id, `UI_ERROR_BUDGET: ${errors.join('\n')}`);
    }).catch(error => console.error('[plugin-workshop] fault recovery failed', error));
  }));
});
