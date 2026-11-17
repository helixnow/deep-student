// RUST-FIX(RF-P5-workshop-assembly): root composition preserves the paired workshop UI caller.
import { workshopContributions } from '@/ui-plugins/official/plugin-workshop/api';
import { HostWorkshopAdapter, createWorkshopIntegration, describeWorkshopError, type WorkshopFilesPort, type WorkshopItem, type WorkshopPlace, type WorkshopRemote } from '@/features/plugin-workshop';

/** How long 「打开」 waits for a freshly installed or enabled plugin's view to appear. */
const OPEN_VIEW_TIMEOUT_MS = 5000;
import i18n from '@/i18n';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { createHostPluginManagerAdapter } from '@/features/plugin-manager/host-adapter';
import { registerPluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import { registerHostSkill, type HostSkillResource } from '@/features/chat/skills/hostResources';
import { subscribeCommunityUiLoadFailures } from '@/ui-kernel/community';
import { reportWorkshopRuntimeFailure } from '@/features/plugin-workshop/runtime-failures';
import { openWorkshopCandidateView } from '@/features/plugin-workshop/open-candidate';

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
    const verified = item.phase === 'installed' && item.validation?.status === 'passed' && item.installed?.version === item.validation.version;
    const success = verified || item.phase === 'ready';
    const key = verified ? 'workshop.notice.verified' : item.execution?.stage === 'blocked' ? 'workshop.notice.blocked'
      : item.phase === 'ready' ? 'workshop.notice.ready' : 'workshop.notice.failed';
    void import('@/components/UnifiedNotification').then(({ showGlobalNotification }) =>
      showGlobalNotification(success ? 'success' : 'warning', i18n.t(`plugin_manager:${key}`, { name: item.name }) as string))
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
      submit: async (id, text) => (await import('@/features/chat/workshop')).workshopSessions.submit(id, text),
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
  ctx.effect(() => {
    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;
    const opened = new Set<string>();
    const cancellation = new AbortController();
    const refresh = async () => {
      if (disposed) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const cards = await remote.list();
          for (const card of cards) {
            if (disposed) return;
            if (card.validation?.status !== 'pending' || card.installation?.state !== 'installed'
              || card.execution?.stage === 'blocked'
              || card.installation.version !== card.validation.version || !card.places?.some(place => place.kind === 'app')) continue;
            const key = `${card.id}:${card.validation.revision}`;
            if (opened.has(key)) continue;
            try {
              await openWorkshopCandidateView(ctx.ui.slots, card.pluginId, card.validation.version, {
                signal: cancellation.signal, timeoutMs: OPEN_VIEW_TIMEOUT_MS,
              });
              if (!disposed) opened.add(key);
            }
            catch (error) {
              if (disposed) return;
              await reportWorkshopRuntimeFailure(remote, { id: card.pluginId, version: card.validation.version, error: String(error) });
            }
          }
        } while (refreshAgain && !disposed);
      } catch (error) { console.error('[plugin-workshop] candidate preview failed', error); }
      finally { refreshing = false; }
    };
    let stopCandidate: (() => void) | undefined;
    // A version upgrade does not change the Host's plugin-id set. Listen to the
    // actual validation transition, then reconcile once to cover startup races.
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ id: string; revision: number }>('plugin-workshop:verify-candidate', ({ payload }) => {
        // Each verifier attempt needs a visible candidate, even if this same activation was opened before.
        // launch reopens a closed window and focuses an existing one; a retry deliberately reuses its revision.
        opened.delete(`${payload.id}:${payload.revision}`);
        void refresh();
      }),
    ).then(stop => {
      if (disposed) stop();
      else { stopCandidate = stop; void refresh(); }
    }).catch(error => console.error('[plugin-workshop] candidate listener failed', error));
    return () => { disposed = true; cancellation.abort(); stopCandidate?.(); };
  });
  ctx.ui.contribute('chat.toolResults', {
    id: 'dstu-plugin-workshop-confirmation', key: 'dstu_plugin_propose_install', value: integration.toolResult,
  });
  ctx.effect(() => {
    const report = (failure: { id: string; version?: string; error: string }) => {
      void reportWorkshopRuntimeFailure(remote, failure)
        .catch(error => console.error('[plugin-workshop] fault recovery failed', error));
    };
    const stopRuntime = ctx.ui.onPluginError(report);
    const stopLoading = subscribeCommunityUiLoadFailures(report);
    return () => { stopRuntime(); stopLoading(); };
  });
});
