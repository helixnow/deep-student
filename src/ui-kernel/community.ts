/**
 * Community code and shared SDK modules stay off the empty-manifest/demo boot path.
 *
 * FE-A3: the same startup also syncs Host plugin status into `kernel.hostStatus` (v2 manifest + `plugin:host|status`).
 * Official UI plugins are already installed optimistically before this runs; nothing here blocks the first frame.
 */
import type { UiKernel } from './kernel';
import { UiPluginLoader, type LoaderDeps, type UiManifestEntry } from './loader';
import type { HostDegradedPlugin } from './services/host-status';
import { recordPluginAgentTools } from './services/plugin-tools';

/** `UiManifestV2` (`host/kernel/core.ts`) as read by the renderer. */
export interface UiHostManifest {
  version: 2;
  plugins: {
    id: string; origin: 'builtin' | 'community'; platforms: readonly string[]; version?: string; file?: string;
    /** Agent tools the plugin declares: chat tool name and the title to show for it. */
    agentTools?: readonly { name: string; title: string }[];
  }[];
  degraded: HostDegradedPlugin[];
  /** W06/W01 safe-mode session. `true` means: shipped official UI only, never load community UI. */
  safeMode?: boolean;
}

export interface CommunityUiBridge {
  ready?(id: string, version: string | undefined): Promise<{ id: string; matched: boolean }>;
  invoke(): Promise<UiManifestEntry[]>;
  listen(callback: (manifest: UiManifestEntry[]) => void): Promise<() => void>;
  /** `plugin:ui|manifest {version: 2}`; a Host without v2 answers with the v1 array. Enables the FE-A3 host sync. */
  manifest?(): Promise<UiHostManifest | UiManifestEntry[]>;
  /** `host://ui-manifest-v2`. */
  listenManifest?(callback: (manifest: UiHostManifest) => void): Promise<() => void>;
  /** `plugin:host|status`. */
  status?(): Promise<HostDegradedPlugin[]>;
  /** `host://plugins-degraded`. */
  listenStatus?(callback: (degraded: HostDegradedPlugin[]) => void): Promise<() => void>;
}

function tauriBridge(): Required<CommunityUiBridge> {
  const core = () => import('@tauri-apps/api/core');
  const events = () => import('@tauri-apps/api/event');
  return {
    ready: (id, version) => core().then(({ invoke }) => invoke('plugin:ui|ready', { id, version })),
    invoke: () => core().then(({ invoke }) => invoke<UiManifestEntry[]>('plugin:ui|manifest')),
    listen: (callback) => events().then(({ listen }) => listen<UiManifestEntry[]>('host://ui-manifest', (event) => callback(event.payload))),
    manifest: () => core().then(({ invoke }) => invoke<UiHostManifest | UiManifestEntry[]>('plugin:ui|manifest', { version: 2 })),
    listenManifest: (callback) => events().then(({ listen }) => listen<UiHostManifest>('host://ui-manifest-v2', (event) => callback(event.payload))),
    status: () => core().then(({ invoke }) => invoke<HostDegradedPlugin[]>('plugin:host|status')),
    listenStatus: (callback) => events().then(({ listen }) => listen<HostDegradedPlugin[]>('host://plugins-degraded', (event) => callback(event.payload))),
  };
}

/** Renderer event the shell sends when a notification with `extra.dsAction` is clicked (electron/shell/plugins/system.ts). */
export const NOTIFICATION_ACTION_EVENT = 'ds://notification-action';

/** `dsAction` of a plugin notification (`pluginNotify.notify`, host/plugins/plugin-services). */
export interface PluginNotificationAction {
  kind: 'plugin';
  pluginId: string;
  /** A view id in the `views` slot; omitted = the plugin's first registered view. */
  view?: string;
  params?: Record<string, unknown>;
}

/**
 * Opens the plugin view a clicked plugin notification points at. Without a matching view (the plugin registers none,
 * or it is not loaded) the click only brought the app forward, which the shell already did.
 */
export function openPluginNotificationTarget(kernel: Pick<UiKernel, 'slots' | 'navigation'>, action: unknown): boolean {
  const value = action as Partial<PluginNotificationAction> | null;
  if (!value || typeof value !== 'object' || value.kind !== 'plugin' || typeof value.pluginId !== 'string') return false;
  const views = kernel.slots.list('views');
  const target = typeof value.view === 'string' && views.some((entry) => entry.key === value.view)
    ? value.view
    : views.find((entry) => entry.owner === value.pluginId)?.key;
  if (!target || !kernel.navigation.canNavigate(target)) return false;
  const params = value.params && typeof value.params === 'object' ? value.params : undefined;
  kernel.navigation.navigate(value.pluginId, target, params);
  return true;
}

function isHostManifest(value: unknown): value is UiHostManifest {
  const manifest = value as UiHostManifest | null;
  return !!manifest && typeof manifest === 'object' && manifest.version === 2 && Array.isArray(manifest.plugins) && Array.isArray(manifest.degraded);
}

/** Community UI entries of a v2 manifest, in the v1 loader shape. */
export function communityEntries(manifest: UiHostManifest): UiManifestEntry[] {
  return manifest.plugins
    .filter((p) => p.origin === 'community' && typeof p.file === 'string' && p.file.length > 0)
    .map((p) => (p.version === undefined ? { id: p.id, file: p.file! } : { id: p.id, file: p.file!, version: p.version }));
}

function isWebUiEnvironment(): boolean {
  if ((globalThis as { __DS_WEBUI__?: unknown }).__DS_WEBUI__ === true) return true;
  return typeof window !== 'undefined' && (window as unknown as { __DS_WEBUI__?: unknown }).__DS_WEBUI__ === true;
}

/**
 * Resolve community UI plugin URL for the current runtime:
 * - Desktop Electron/Tauri keeps `ds-plugin://<id>/<file>[?reload=<n>]` unchanged.
 * - WebUI browser rewrites it to same-origin `${origin}/api/protocol/ds-plugin/<id>/<file>[?reload=<n>]`
 *   so dynamic `import()` carries the same-origin session cookie and bypasses SW caching.
 */
export function resolveCommunityPluginUrl(url: string, origin?: string): string {
  if (!url.startsWith('ds-plugin://') || !isWebUiEnvironment()) return url;
  const resolvedOrigin =
    origin ?? (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined);
  if (!resolvedOrigin) return url;
  const rest = url.slice('ds-plugin://'.length);
  return `${resolvedOrigin.replace(/\/+$/, '')}/api/protocol/ds-plugin/${rest}`;
}

export async function startCommunityUiPlugins(
  kernel: UiKernel,
  bridge?: CommunityUiBridge,
  importModule: LoaderDeps['importModule'] = (url) => import(/* @vite-ignore */ resolveCommunityPluginUrl(url)),
): Promise<() => Promise<void>> {
  if ((window as unknown as { __DS_DEMO_SHELL__?: boolean }).__DS_DEMO_SHELL__) return async () => {};
  const transport = bridge ?? tauriBridge();
  let shared: Promise<unknown> | undefined;
  const loader = new UiPluginLoader(kernel, {
    ready: transport.ready?.bind(transport),
    async importModule(url) {
      shared ??= installCommunitySharedModules();
      await shared;
      return importModule(url);
    },
    log: console,
  });
  let stopped = false;
  /** Set by a v2 manifest with `safeMode: true`: community UI is never loaded in a safe-mode session. */
  let safeMode = false;
  const unlisteners: (() => void)[] = [];
  const sync = (manifest: UiManifestEntry[]) => {
    if (stopped) return;
    void loader.sync(safeMode ? [] : manifest).catch((error) => console.error('[ui-plugins] manifest sync failed', error));
  };
  const stop = async () => {
    stopped = true;
    for (const unlisten of unlisteners.splice(0)) unlisten();
    await loader.dispose();
  };

  /** v1: the community manifest only (also the fallback when the Host has no v2 manifest). */
  const startV1 = async (initial?: UiManifestEntry[]) => {
    let revision = 0;
    unlisteners.push(await transport.listen((manifest) => {
      revision++;
      sync(manifest);
    }));
    if (stopped) return;
    if (initial) return sync(initial);
    const requestedAt = revision;
    void transport.invoke().then(async (manifest) => {
      if (!stopped && revision === requestedAt) await loader.sync(manifest);
    }).catch((error) => {
      // An unavailable community bridge must not block the official application.
      console.error('[ui-plugins] manifest request failed', error);
    });
  };

  if (!transport.manifest) {
    await startV1();
    return stop;
  }

  const applyHostManifest = (manifest: UiHostManifest) => {
    if (stopped) return;
    // RUST-FIX(RF-W17-safe-mode-community-ui): safe-mode 会话只保留官方 UI，社区条目不装、已装的卸载
    safeMode = manifest.safeMode === true;
    kernel.hostStatus.update({ plugins: manifest.plugins, degraded: manifest.degraded, safeMode });
    recordPluginAgentTools(manifest.plugins.filter(plugin => plugin.origin === 'community'));
    // In safe mode this is an empty list, so an already loaded community UI is unloaded as well.
    sync(communityEntries(manifest));
  };
  const applyStatus = (degraded: HostDegradedPlugin[]) => {
    if (!stopped && Array.isArray(degraded)) kernel.hostStatus.updateDegraded(degraded);
  };
  if (!bridge) {
    // Plugin notifications (pluginNotify) open the plugin's view when clicked.
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<unknown>(NOTIFICATION_ACTION_EVENT, (event) => { openPluginNotificationTarget(kernel, event.payload); }))
      .then((off) => { if (stopped) off(); else unlisteners.push(off); })
      .catch((error) => console.error('[ui-plugins] notification action listener failed', error));
  }
  let manifestRevision = 0;
  let statusRevision = 0;
  const [offManifest, offStatus, offWebReload] = await Promise.all([
    transport.listenManifest?.((manifest) => {
      manifestRevision++;
      if (isHostManifest(manifest)) applyHostManifest(manifest);
    }),
    transport.listenStatus?.((degraded) => {
      statusRevision++;
      applyStatus(degraded);
    }),
    // WebUI `plugin:process|restart` hot-rebuilds the Host in-process and emits `host://webui-reload`
    // once Host state sync completes, so browser tabs reload cleanly instead of crashing the server.
    !bridge && isWebUiEnvironment()
      ? import('@tauri-apps/api/event')
          .then(({ listen }) => listen('host://webui-reload', () => { window.location?.reload?.(); }))
          .catch(() => undefined)
      : undefined,
  ]);
  for (const off of [offManifest, offStatus, offWebReload]) if (off) unlisteners.push(off);
  if (stopped) return stop;

  const manifestAt = manifestRevision;
  void transport.manifest().catch(() => transport.invoke()).then(async (reply) => {
    if (stopped || manifestRevision !== manifestAt) return;
    if (isHostManifest(reply)) return applyHostManifest(reply);
    // A Host without the v2 manifest: official UI stays optimistic; community plugins follow the v1 manifest.
    await startV1(Array.isArray(reply) ? reply : []);
  }).catch((error) => {
    console.error('[ui-plugins] manifest request failed', error);
  });
  const statusAt = statusRevision;
  void transport.status?.().then((degraded) => {
    if (statusRevision === statusAt) applyStatus(degraded);
  }).catch((error) => {
    console.error('[ui-plugins] host status request failed', error);
  });
  return stop;
}

/**
 * Bare module names a community UI bundle may import (kept external by the plugin build). Besides React, the SDK and
 * i18next, the Milkdown kit entries are shared so `editor.extensions` contributions build ProseMirror plugins against
 * the editor's own instance (a second copy would not recognise the editor's schema, plugin keys or ctx slices).
 */
export const COMMUNITY_SHARED_MODULES = [
  'react', 'react-dom', '@deepstudent/ui', 'i18next',
  '@milkdown/kit/core', '@milkdown/kit/ctx', '@milkdown/kit/utils', '@milkdown/kit/transformer',
  '@milkdown/kit/prose', '@milkdown/kit/prose/state', '@milkdown/kit/prose/view', '@milkdown/kit/prose/model',
  '@milkdown/kit/prose/transform', '@milkdown/kit/prose/commands', '@milkdown/kit/prose/inputrules', '@milkdown/kit/prose/keymap',
] as const;

async function installCommunitySharedModules(): Promise<void> {
  const [react, reactDom, sdk, i18next, { installSharedModules }, milkdown] = await Promise.all([
    import('react'),
    import('react-dom'),
    import('../ui-sdk'),
    import('i18next'),
    import('./shared'),
    loadMilkdownSharedModules(),
  ]);
  installSharedModules({ react, 'react-dom': reactDom, '@deepstudent/ui': sdk, i18next, ...milkdown });
}

/** The editor chunk is already loaded in a normal session; a failure here must not block community UI that ignores it. */
async function loadMilkdownSharedModules(): Promise<Record<string, object>> {
  try {
    const [core, ctx, utils, transformer, prose, state, view, model, transform, commands, inputrules, keymap] = await Promise.all([
      import('@milkdown/kit/core'),
      import('@milkdown/kit/ctx'),
      import('@milkdown/kit/utils'),
      import('@milkdown/kit/transformer'),
      import('@milkdown/kit/prose'),
      import('@milkdown/kit/prose/state'),
      import('@milkdown/kit/prose/view'),
      import('@milkdown/kit/prose/model'),
      import('@milkdown/kit/prose/transform'),
      import('@milkdown/kit/prose/commands'),
      import('@milkdown/kit/prose/inputrules'),
      import('@milkdown/kit/prose/keymap'),
    ]);
    return {
      '@milkdown/kit/core': core, '@milkdown/kit/ctx': ctx, '@milkdown/kit/utils': utils, '@milkdown/kit/transformer': transformer,
      '@milkdown/kit/prose': prose, '@milkdown/kit/prose/state': state, '@milkdown/kit/prose/view': view,
      '@milkdown/kit/prose/model': model, '@milkdown/kit/prose/transform': transform, '@milkdown/kit/prose/commands': commands,
      '@milkdown/kit/prose/inputrules': inputrules, '@milkdown/kit/prose/keymap': keymap,
    };
  } catch (error) {
    console.error('[ui-plugins] Milkdown shared modules unavailable', error);
    return {};
  }
}
