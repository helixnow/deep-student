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
import { setPendingSettingsRoute } from '@/utils/pendingSettingsTab';
import { getWorkbenchHostBridge } from '@/shared/workbenchHost';

const CONTRIBUTED_SLOT_PLACES: Readonly<Record<string, (entry: { value?: unknown }) => WorkshopPlace>> = {
  'editor.selectionToolbar': () => ({ kind: 'selectionButton' }),
  'pdf.selectionToolbar': () => ({ kind: 'pdfSelectionButton' }),
  'chat.composer.commands': (entry) => {
    const name = typeof (entry.value as { name?: unknown } | undefined)?.name === 'string'
      ? (entry.value as { name: string }).name.trim()
      : undefined;
    return name ? { kind: 'slashCommand', command: name } : { kind: 'slashCommand' };
  },
  'chat.message.actions': () => ({ kind: 'chatMessageAction' }),
  'review.cardActions': () => ({ kind: 'reviewAction' }),
  'desktop.widgets': () => ({ kind: 'desktopWidget' }),
  'statusbar.items': () => ({ kind: 'statusBarItem' }),
  'theme.variants': () => ({ kind: 'themeVariant' }),
  'dashboard.widgets': () => ({ kind: 'dashboardWidget' }),
  'dashboard.stats': () => ({ kind: 'dashboardWidget' }),
  'dashboard.charts': () => ({ kind: 'dashboardWidget' }),
};

function findContributedPlace(
  slots: { definitions?(): readonly { name: string }[]; list(name: string): readonly { owner: string; value?: unknown }[] },
  pluginId: string,
): WorkshopPlace | undefined {
  for (const def of slots.definitions?.() ?? []) {
    if (def.name === 'views') continue;
    const mapper = CONTRIBUTED_SLOT_PLACES[def.name];
    if (!mapper) continue;
    const entry = slots.list(def.name).find(item => item.owner === pluginId);
    if (entry) return mapper(entry);
  }
  return undefined;
}

function hasPluginSlotContribution(
  slots: { definitions?(): readonly { name: string }[]; list(name: string): readonly { owner: string; version?: string }[] },
  pluginId: string,
  version: string,
): boolean {
  for (const def of slots.definitions?.() ?? []) {
    if (def.name === 'views') continue;
    if (slots.list(def.name).some(entry => entry.owner === pluginId && entry.version === version)) return true;
  }
  return false;
}

async function waitForPluginSlotContribution(
  slots: {
    definitions?(): readonly { name: string }[];
    list(name: string): readonly { owner: string; version?: string }[];
    subscribe(fn: () => void): () => void;
  },
  pluginId: string,
  version: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<void> {
  if (hasPluginSlotContribution(slots, pluginId, version)) return;
  if (options.signal?.aborted) throw new Error('WORKSHOP_OPEN_ABORTED');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stop: () => void = () => {};
    const onAbort = () => finish(new Error('WORKSHOP_OPEN_ABORTED'));
    const timer = setTimeout(() => {
      if (hasPluginSlotContribution(slots, pluginId, version)) finish();
      else finish(new Error(`WORKSHOP_OPEN_TIMEOUT: ${pluginId}@${version} contributed no UI slot`));
    }, options.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (hasPluginSlotContribution(slots, pluginId, version)) finish();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    stop = slots.subscribe(check);
    check();
  });
}

workshopContributions.announce(ctx => {
  const remote = ctx.ui.host.pluginWorkshop as unknown as WorkshopRemote;
  const storageRemote = ctx.ui.host.pluginWorkshop as unknown as {
    storedData?(pluginId: string): Promise<{ keys: string[]; bytes: number }>;
    clearStoredData?(pluginId: string): Promise<number>;
  };
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
  const launchSurface = (workbenchTypeId: string | null, classicFallback: () => void) => {
    const bridge = getWorkbenchHostBridge();
    if (bridge?.isEnabled() && workbenchTypeId && bridge.launch({ typeId: workbenchTypeId, reason: 'api' })) return;
    classicFallback();
  };
  const routeNonAppPlace = (place: WorkshopPlace): boolean => {
    switch (place.kind) {
      case 'selectionButton':
        dispatchAppEvent(APP_EVENTS.OPEN_NOTES);
        return true;
      case 'pdfSelectionButton':
        launchSurface('files', () => { dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'learning-hub' }); });
        return true;
      case 'slashCommand':
        dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: place.command ? `/${place.command} ` : '/', autoSend: false });
        launchSurface('chat', () => { dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' }); });
        return true;
      case 'chatMessageAction':
        launchSurface('chat', () => { dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' }); });
        return true;
      case 'reviewAction':
        launchSurface('flashcards', () => { dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' }); });
        return true;
      case 'themeVariant':
        setPendingSettingsRoute({ tab: 'appearance' });
        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_TAB, { tabName: 'settings' });
        dispatchAppEvent(APP_EVENTS.SETTINGS_NAVIGATE_TAB, { tab: 'appearance' });
        return true;
      case 'dashboardWidget':
        dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'dashboard' });
        return true;
      case 'desktopWidget':
      case 'statusBarItem':
        if (!getWorkbenchHostBridge()?.isEnabled()) {
          dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'dashboard' });
        }
        return true;
      case 'agentTool':
        dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, { content: place.title, autoSend: false });
        return true;
      case 'app':
        return false;
    }
  };
  // Open or try an installed work by what it adds. Views open through navigation (the learning desktop mirrors
  // community views as apps); UI-slot contributions route directly to their host surface without waiting for views.
  const openPluginView = async (pluginId: string, place?: WorkshopPlace) => {
    if (place && routeNonAppPlace(place)) return;
    const find = () => ctx.ui.slots.list('views').find(entry => entry.owner === pluginId)?.key;
    const immediateKey = find();
    if (immediateKey) {
      ctx.ui.navigation.navigate(immediateKey);
      return;
    }
    if (!place) {
      const contributed = findContributedPlace(ctx.ui.slots, pluginId);
      if (contributed && routeNonAppPlace(contributed)) return;
    }
    // The view/slot appears once the UI manifest refresh after install/enable lands: wait up to 5 s while
    // the card's button shows its pending state, and say so instead of silently doing nothing.
    const resolved = await new Promise<{ key?: string; contributed?: WorkshopPlace }>((resolve) => {
      let unsubscribe: () => void = () => {};
      const inspect = () => {
        const key = find();
        if (key) return { key };
        if (!place) {
          const contributed = findContributedPlace(ctx.ui.slots, pluginId);
          if (contributed) return { contributed };
        }
        return undefined;
      };
      const timer = setTimeout(() => { unsubscribe(); resolve(inspect() ?? {}); }, OPEN_VIEW_TIMEOUT_MS);
      unsubscribe = (place ? (fn: () => void) => ctx.ui.slots.subscribe('views', fn) : (fn: () => void) => ctx.ui.slots.subscribe(fn))(() => {
        const hit = inspect();
        if (hit) { clearTimeout(timer); unsubscribe(); resolve(hit); }
      });
    });
    if (resolved.contributed && routeNonAppPlace(resolved.contributed)) return;
    if (!resolved.key) throw new Error(`WORKSHOP_OPEN_TIMEOUT: ${pluginId} has no view yet`);
    ctx.ui.navigation.navigate(resolved.key);
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
    ...(typeof storageRemote.storedData === 'function' ? { storedData: (pluginId: string) => storageRemote.storedData!(pluginId) } : {}),
    ...(typeof storageRemote.clearStoredData === 'function' ? { clearStoredData: (pluginId: string) => storageRemote.clearStoredData!(pluginId) } : {}),
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
              || card.installation.version !== card.validation.version) continue;
            const hasApp = Boolean(card.places?.some(place => place.kind === 'app'));
            const hasUiSlot = Boolean(card.places?.some(place => place.kind !== 'app' && place.kind !== 'agentTool'));
            if (!hasApp && !hasUiSlot) continue;
            const key = `${card.id}:${card.validation.revision}`;
            if (opened.has(key)) continue;
            try {
              if (hasApp) {
                await openWorkshopCandidateView(ctx.ui.slots, card.pluginId, card.validation.version, {
                  signal: cancellation.signal, timeoutMs: OPEN_VIEW_TIMEOUT_MS,
                });
              } else {
                await waitForPluginSlotContribution(ctx.ui.slots, card.pluginId, card.validation.version, {
                  signal: cancellation.signal, timeoutMs: OPEN_VIEW_TIMEOUT_MS,
                });
              }
              if (!disposed) opened.add(key);
            }
            catch (error) {
              if (disposed) return;
              await remote.reportValidation?.(card.id, card.validation.version, card.validation.revision, { ok: false, detail: String(error) });
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
      listen('plugin-workshop:verify-candidate', () => { void refresh(); }),
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
    const reportLoad = (failure: { id: string; version?: string; error: string }) => {
      const prefixed = /^(?:IMPORT_FAILED|APPLY_FAILED|SERVICE_MISSING|PERMISSION_UNDECLARED|KERNEL_API_FORBIDDEN|SERVICE_CONFLICT|activate:|render:|filter:|report:|callback:)/i.test(failure.error)
        ? failure.error
        : `activate: ${failure.error}`;
      report({ ...failure, error: prefixed });
    };
    const stopRuntime = ctx.ui.onPluginError(report);
    const stopLoading = subscribeCommunityUiLoadFailures(reportLoad);
    return () => { stopRuntime(); stopLoading(); };
  });
});
