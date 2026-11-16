// RUST-FIX(RF-P5-workshop-assembly): root composition preserves the paired workshop UI caller.
import { workshopContributions } from '@/ui-plugins/official/plugin-workshop/api';
import { HostWorkshopAdapter, createWorkshopIntegration, describeWorkshopError, workshopInstallation, type WorkshopFilesPort, type WorkshopItem, type WorkshopPlace, type WorkshopRemote } from '@/features/plugin-workshop';

/** How long 「打开」 waits for a freshly installed or enabled plugin's view to appear. */
const OPEN_VIEW_TIMEOUT_MS = 5000;
import i18n from '@/i18n';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
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
  // Open or try an installed work by what it adds. Views open through navigation (the learning desktop mirrors
  // community views as apps); a selection-toolbar button is tried in notes; an AI skill by a phrase in the composer.
  const openPluginView = async (pluginId: string, place?: WorkshopPlace) => {
    if (place?.kind === 'selectionButton') { dispatchAppEvent(APP_EVENTS.OPEN_NOTES); return; }
    if (place?.kind === 'agentTool') { dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: place.title, autoSend: false }); return; }
    // The view appears once the UI manifest refresh after install/enable lands: wait for the slot (up to 5 s) while
    // the card's button shows its pending state, and say so instead of silently doing nothing.
    const find = () => ctx.ui.slots.list('views').find(entry => entry.owner === pluginId)?.key;
    const key = find() ?? await new Promise<string | undefined>(resolve => {
      let unsubscribe: () => void = () => {};
      const timer = setTimeout(() => { unsubscribe(); resolve(find()); }, OPEN_VIEW_TIMEOUT_MS);
      unsubscribe = ctx.ui.slots.subscribe('views', () => {
        const found = find();
        if (found) { clearTimeout(timer); unsubscribe(); resolve(found); }
      });
    });
    if (!key) throw new Error(`WORKSHOP_OPEN_TIMEOUT: ${pluginId} has no view yet`);
    ctx.ui.navigation.navigate(key);
  };
  // A finished background generation is news even when the learner left the chat: one notification with the result.
  const onFinished = (item: WorkshopItem) => {
    const key = item.phase === 'ready' ? 'workshop.notice.ready' : 'workshop.notice.failed';
    void import('@/components/UnifiedNotification').then(({ showGlobalNotification }) =>
      showGlobalNotification(item.phase === 'ready' ? 'success' : 'warning', i18n.t(`plugin_manager:${key}`, { name: item.name }) as string))
      .catch(error => console.error('[plugin-workshop]', error));
  };
  // 导出：系统保存对话框（建议可读文件名）；没有对话框时文件留在工坊目录，卡片给出「在文件夹中显示」。
  const files: WorkshopFilesPort = {
    save: async (path, fileName) => {
      const { fileManager } = await import('@/utils/fileManager');
      const result = await fileManager.saveFromSource({ sourcePath: path, defaultFileName: fileName,
        filters: [{ name: 'DeepStudent plugin', extensions: ['dstuplugin'] }] });
      return result.canceled ? null : result.path ?? path;
    },
    reveal: async path => {
      const { canRevealInFolder, revealFileOrOpen } = await import('@/utils/systemFileOpener');
      if (canRevealInFolder()) await revealFileOrOpen(path);
    },
  };
  const adapter = new HostWorkshopAdapter(remote, manager, openPluginView, onFinished, files);
  const integration = createWorkshopIntegration({
    adapter,
    sessions: {
      bindSession: async (id, revision, sessionId) => { await remote.bindSession(id, revision, sessionId); },
      create: async options => {
        await skillReady;
        return (await import('@/features/chat/workshop')).workshopSessions.create(options);
      },
      activateSkill: async (id, skill) => (await import('@/features/chat/workshop')).workshopSessions.activateSkill(id, skill),
      prefill: async (id, text) => (await import('@/features/chat/workshop')).workshopSessions.prefill(id, text),
      focus: id => { void import('@/features/chat/workshop').then(({ workshopSessions }) => workshopSessions.focus(id)); },
      exists: async id => (await import('@/features/chat/workshop')).workshopSessions.exists(id),
      setEditing: (id, label) => { void import('@/features/chat/workshop').then(({ workshopSessions }) => workshopSessions.setEditing(id, label)); },
      navigate: id => { void import('@/features/chat/workshop').then(({ workshopSessions }) => workshopSessions.navigate(id))
        .catch(error => console.error('[plugin-workshop] navigation failed', error)); },
    },
    translate: (key, options) => i18n.t(`plugin_manager:${key}`, options) as string,
    reportError: raw => {
      const described = describeWorkshopError(raw);
      const message = i18n.t(`plugin_manager:workshop.errors.${described.key}`, described.values) as string;
      void import('@/components/UnifiedNotification').then(({ showGlobalNotification }) =>
        showGlobalNotification('error', message)).catch(error => console.error('[plugin-workshop]', raw, error));
    },
  });
  ctx.effect(() => registerPluginManagerWorkshop(integration.workshop));
  ctx.ui.contribute('chat.toolResults', {
    id: 'dstu-plugin-workshop-confirmation', key: 'dstu_plugin_propose_install', value: integration.toolResult,
  });
  ctx.effect(() => ctx.ui.onPluginDisabled((id, errors) => {
    void remote.list().then(async cards => {
      const card = cards.find(item => item.pluginId === id && workshopInstallation(item)?.state === 'installed');
      if (card && remote.reportFault) await remote.reportFault(card.id, `UI_ERROR_BUDGET: ${errors.join('\n')}`);
    }).catch(error => console.error('[plugin-workshop] fault recovery failed', error));
  }));
});
