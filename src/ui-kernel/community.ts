/**
 * Community code and shared SDK modules stay off the empty-manifest/demo boot path.
 *
 * FE-A3: the same startup also syncs Host plugin status into `kernel.hostStatus` (v2 manifest + `plugin:host|status`).
 * Official UI plugins are already installed optimistically before this runs; nothing here blocks the first frame.
 */
import type { UiKernel } from './kernel';
import { UiPluginLoader, type LoaderDeps, type UiManifestEntry } from './loader';
import type { HostDegradedPlugin } from './services/host-status';

/** `UiManifestV2` (`host/kernel/core.ts`) as read by the renderer. */
export interface UiHostManifest {
  version: 2;
  plugins: { id: string; origin: 'builtin' | 'community'; platforms: readonly string[]; version?: string; file?: string }[];
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
    // In safe mode this is an empty list, so an already loaded community UI is unloaded as well.
    sync(communityEntries(manifest));
  };
  const applyStatus = (degraded: HostDegradedPlugin[]) => {
    if (!stopped && Array.isArray(degraded)) kernel.hostStatus.updateDegraded(degraded);
  };
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

async function installCommunitySharedModules(): Promise<void> {
  const [react, reactDom, sdk, i18next, { installSharedModules }] = await Promise.all([
    import('react'),
    import('react-dom'),
    import('../ui-sdk'),
    import('i18next'),
    import('./shared'),
  ]);
  installSharedModules({ react, 'react-dom': reactDom, '@deepstudent/ui': sdk, i18next });
}
