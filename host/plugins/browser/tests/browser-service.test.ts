import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type {
  AgentNavigationPolicy, BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import type { IpAddress } from '../src/policy.ts';
import { BrowserFailure } from '../src/error.ts';
import { BrowserRuntimeService } from '../src/browser-service.ts';
import type { BrowserDatabase } from '../src/database.ts';
import { loadF3Flags } from './support/f3-feature-flags.ts';
import type { JsonValue } from '../src/command-result.ts';

const WORKBENCH_BROWSER_ENABLED = 'desktop.workbenchBrowserEnabled';

class MemorySettings {
  private readonly values = new Map<string, string>();

  get(key: string): string | null { return this.values.get(key) ?? null; }
  save(key: string, value: string): void { this.values.set(key, value); }
  delete(key: string): boolean { return this.values.delete(key); }
  listByPrefix(prefix: string): { key: string; value: string; updatedAt: string }[] {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00.000+00:00' }));
  }
  deleteByPrefix(prefix: string): number {
    let count = 0;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) { this.values.delete(key); count += 1; }
    }
    return count;
  }
  async saveSecret(key: string, value: string): Promise<void> { this.save(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.get(key); }
  async deleteSecret(key: string): Promise<boolean> { return this.delete(key); }
}

class FakeSurface implements BrowserSurfaceHost {
  present = false;
  created: BrowserSurfaceCreateOptions | null = null;
  navigations: string[] = [];
  bounds: { x: number; y: number; width: number; height: number }[] = [];
  occlusions: { x: number; y: number; width: number; height: number }[][] = [];
  visibility: { visible: boolean; focus: boolean }[] = [];
  focusCount = 0;
  releaseCount = 0;
  callbacks: SurfaceEventCallbacks | null = null;
  policies: AgentNavigationPolicy[] = [];
  resolutions: string[] = [];
  resolveAnswer: IpAddress[] | string | null = null;

  hostMode(): string { return 'embedded'; }
  async setAgentNavigationPolicy(policy: AgentNavigationPolicy): Promise<void> { this.policies.push({ ...policy }); }
  hasContentWindow(): boolean { return this.present; }

  async createContentWindow(options: BrowserSurfaceCreateOptions): Promise<void> {
    this.created = options;
    this.present = true;
  }
  async destroyContentWindow(): Promise<boolean> { this.present = false; return true; }
  async navigate(url: string): Promise<void> { this.navigations.push(url); }
  async goBack(): Promise<void> { this.navigations.push('back'); }
  async goForward(): Promise<void> { this.navigations.push('forward'); }
  async reload(): Promise<void> { this.navigations.push('reload'); }
  async focusContentWindow(): Promise<void> { this.focusCount += 1; }
  async releaseContentFocus(): Promise<void> { this.releaseCount += 1; }
  async mainViewportSize(): Promise<{ width: number; height: number }> {
    return { width: 2_000, height: 1_000 };
  }
  async setContentBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    this.bounds.push(bounds);
  }
  async setContentOcclusions(
    occlusions: readonly { x: number; y: number; width: number; height: number }[],
  ): Promise<void> {
    this.occlusions.push([...occlusions]);
  }
  async setContentVisibility(visible: boolean, focus: boolean): Promise<void> {
    this.visibility.push({ visible, focus });
  }
  async snapshot(): Promise<JsonValue> { return { text: 'snapshot text' }; }
  async click(ref: string): Promise<JsonValue> { return { ok: true, ref }; }
  async typeText(ref: string, text: string): Promise<JsonValue> { return { ok: true, ref, text }; }
  async setInputFiles(ref: string, files: JsonValue): Promise<JsonValue> {
    return { ok: true, ref, files };
  }
  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue> {
    return { ok: true, ...options };
  }
  subscribe(callbacks: SurfaceEventCallbacks): () => void {
    this.callbacks = callbacks;
    return () => { this.callbacks = null; };
  }
}

function fakeDatabase(activeDir = join(tmpdir(), 'browser-service-test')): BrowserDatabase {
  return {
    ensureOpen(): void {},
    isOpen(): boolean { return false; },
    activeDir(): string { return activeDir; },
    dbPath(): string { return join(activeDir, 'browser.db'); },
    getConn(): never { throw new Error('unused test database'); },
    tryGetConn(): never { throw new Error('unused test database'); },
    getSchemaVersion(): number { return 0; },
    close(): void {},
    dispose(): void {},
  } as unknown as BrowserDatabase;
}

interface Harness {
  service: BrowserRuntimeService;
  surface: FakeSurface;
  settings: MemorySettings;
  events: { event: string; payload: unknown }[];
}

function harness(options: {
  debug?: boolean; artifactRoot?: (chatSessionId: string) => Promise<string>; activeDir?: string; shellResolver?: boolean;
} = {}): Harness {
  const settings = new MemorySettings();
  settings.save(WORKBENCH_BROWSER_ENABLED, 'true');
  const surface = new FakeSurface();
  if (options.shellResolver === true) {
    Object.assign(surface, {
      resolveAgentHost: async (host: string, port: number): Promise<IpAddress[] | string> => {
        surface.resolutions.push(`${host}:${port}`);
        return surface.resolveAnswer ?? 'DNS resolution failed: no answer configured';
      },
    });
  }
  const events: { event: string; payload: unknown }[] = [];
  const service = new BrowserRuntimeService({
    db: fakeDatabase(options.activeDir),
    settings: settings as unknown as SettingsStore,
    surface,
    platform: 'darwin',
    featureFlags: {
      isEnabled: name => loadF3Flags(settings, options.debug ?? true).isFeatureEnabled(name),
    },
    emit: (event, payload) => { events.push({ event, payload }); },
    artifactRoot: options.artifactRoot ?? null,
    now: () => new Date('2026-11-03T00:00:00.000Z'),
  });
  return { service, surface, settings, events };
}

async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setImmediate(resolve); });
}

const OPEN_URL = 'https://example.com/';

describe('browser runtime service (service.rs state machine)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('opens a gated session, binds trusted input, and closes with events', async () => {
    const { service, surface, events } = harness();
    const state = await service.openSession({ url: OPEN_URL, displayName: 'Example' });

    expect(state.url).toBe(OPEN_URL);
    expect(state.alive).toBe(true);
    expect(state.controlMode).toBe('user');
    expect(state.label).toBe('browser-content');
    expect(surface.present).toBe(true);
    expect(surface.created?.title).toBe('Example');
    expect(surface.created?.initializationScript).toContain(state.id);
    const nonce = /var nonce = "([0-9a-f]{32})"/.exec(surface.created?.initializationScript ?? '')?.[1];
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(events.map(entry => entry.event)).toContain('browser:navigated');

    service.contentUserInput(state.id, nonce!, 'pointerdown');
    expect(events.map(entry => entry.event)).toContain('browser:content-user-input');

    await service.closeSession();
    expect(surface.present).toBe(false);
    expect(service.getState(null)).toBeNull();
    expect(events.map(entry => entry.event)).toContain('browser:closed');
  });

  it('rejects closed settings gates without creating a window', async () => {
    const { service, surface, settings } = harness();
    settings.save(WORKBENCH_BROWSER_ENABLED, 'false');
    await expect(service.openSession({ url: OPEN_URL }))
      .rejects.toThrow(/desktop\.workbenchBrowserEnabled/);
    expect(surface.present).toBe(false);
  });

  it('navigates, goes back and forward, and keeps history shape', async () => {
    const { service, surface } = harness();
    const opened = await service.openSession({ url: OPEN_URL });
    const next = await service.navigate(opened.id, 'https://example.com/next', false, false);
    expect(next.url).toBe('https://example.com/next');
    expect(next.historyLen).toBe(2);
    expect(next.canGoBack).toBe(true);
    // Native page load completes and clears the pending navigation.
    await surface.callbacks?.pageFinished('https://example.com/next');
    await flush();

    const back = await service.back(opened.id);
    expect(back.url).toBe(OPEN_URL);
    expect(back.canGoForward).toBe(true);
    expect(surface.navigations).toEqual(['https://example.com/next', 'back']);
    await surface.callbacks?.pageFinished(OPEN_URL);
    await flush();

    const forward = await service.forward(opened.id);
    expect(forward.url).toBe('https://example.com/next');
    expect(surface.navigations.at(-1)).toBe('forward');
  });

  it('blocks agent navigation to internal addresses before touching the surface', async () => {
    const { service, surface } = harness();
    await expect(service.openSession({ url: 'https://10.0.0.1/', fromAgent: true }))
      .rejects.toThrow(/navigation_blocked/);
    expect(surface.present).toBe(false);

    const opened = await service.openSession({ url: OPEN_URL });
    await expect(service.navigate(opened.id, 'https://127.0.0.1/', false, true))
      .rejects.toThrow(/navigation_blocked/);
    expect(surface.navigations).toEqual([]);
  });

  it('tells the shell whether the agent guard is on and which http policy applies, on every change', async () => {
    const { service, surface, settings } = harness();
    // 初始为关闭，与外壳默认（以及 Host 退出后外壳的复位）一致，不必推送。
    expect(surface.policies).toEqual([]);
    const opened = await service.openSession({ url: 'https://1.1.1.1/', fromAgent: true });
    expect(surface.policies.at(-1)).toEqual({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    settings.save('desktop.workbenchBrowserNetworkMode', 'full');
    await service.navigate(opened.id, 'https://1.0.0.1/', false, true);
    expect(surface.policies.at(-1)).toEqual({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
    service.takeOver();
    expect(surface.policies.at(-1)).toEqual({ agentPrivateNetworkGuard: false, agentAllowInsecureHttp: true });
    const pushes = surface.policies.length;
    service.takeOver();
    expect(surface.policies).toHaveLength(pushes);
  });

  it('agent preflight resolves domain targets through the shell resolver (Rust check_agent_dns_target)', async () => {
    const { service, surface } = harness({ shellResolver: true });
    surface.resolveAnswer = [{ version: 4, octets: [93, 184, 216, 34] }];
    const opened = await service.openSession({ url: 'https://example.com/', fromAgent: true });
    expect(opened.url).toBe('https://example.com/');
    expect(surface.resolutions).toEqual(['example.com:443']);

    surface.resolveAnswer = [{ version: 4, octets: [10, 0, 0, 7] }];
    await expect(service.navigate(opened.id, 'https://intranet.example:8443/', false, true))
      .rejects.toThrow('navigation_blocked: DNS resolved to private/internal address 10.0.0.7');
    surface.resolveAnswer = 'DNS resolution timed out';
    await expect(service.navigate(opened.id, 'https://slow.example/', false, true))
      .rejects.toThrow('navigation_blocked: DNS resolution timed out');
    expect(surface.resolutions).toEqual(['example.com:443', 'intranet.example:8443', 'slow.example:443']);
    expect(surface.navigations).toEqual([]);
  });

  it('switches control modes and records a takeover notice', async () => {
    const { service, events } = harness();
    const opened = await service.openSession({ url: OPEN_URL });

    const agent = service.setAgentControl();
    expect(agent.controlMode).toBe('agent');
    expect(events.map(entry => entry.event)).toContain('browser:control-mode-changed');

    const user = service.takeOver();
    expect(user.controlMode).toBe('user');
    expect(service.consumeTakeoverNotice(opened.id)).toBe(true);
    expect(service.consumeTakeoverNotice(opened.id)).toBe(false);
  });

  it('applies surface bounds in physical pixels and ignores stale sequences', async () => {
    const { service, surface } = harness();
    const opened = await service.openSession({ url: OPEN_URL });

    const mode = await service.setSurfaceBounds(
      opened.id, 100, 50, 500, 250, 1_000, 500, [], [], 2,
    );
    expect(mode).toBe('embedded');
    expect(surface.bounds).toEqual([{ x: 200, y: 100, width: 1_000, height: 500 }]);

    expect(await service.setSurfaceBounds(
      opened.id, 0, 0, 100, 100, 1_000, 500, [], [], 1,
    )).toBe('embedded');
    expect(surface.bounds).toHaveLength(1);
  });

  it('delegates bridge actions and exposes snapshots', async () => {
    const { service } = harness();
    const opened = await service.openSession({ url: OPEN_URL });

    expect(await service.snapshot(opened.id, 4_000)).toEqual({
      sessionId: opened.id,
      url: OPEN_URL,
      title: '',
      snapshot: 'snapshot text',
    });
    expect(await service.click(opened.id, 'e1')).toEqual({ ok: true, ref: 'e1' });
    expect(await service.type(opened.id, 'e1', 'hello', false))
      .toEqual({ ok: true, ref: 'e1', text: 'hello' });
    expect(await service.scroll(opened.id, 'down', 3, null))
      .toEqual({ ok: true, direction: 'down', amount: 3, ref: null });
  });

  it('rolls back a blocked page-initiated navigation and emits blocked', async () => {
    const { service, surface, events } = harness();
    const opened = await service.openSession({ url: OPEN_URL });
    await surface.callbacks?.pageFinished(OPEN_URL);
    await flush();

    await service.navigate(opened.id, 'https://example.com/redirect', false, false);
    expect(service.getState(opened.id)?.url).toBe('https://example.com/redirect');
    await surface.callbacks?.navigationBlocked('https://evil.test/', 'host not allowed');
    await flush();

    const state = service.getState(opened.id);
    expect(state?.url).toBe(OPEN_URL);
    expect(state?.canGoBack).toBe(false);
    expect(events.map(entry => entry.event)).toContain('browser:navigation-blocked');
  });

  it('tracks download ownership, hashes completed files, and lists by session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-download-'));
    cleanup.push(root);
    const { service } = harness({ artifactRoot: async () => root });
    const opened = await service.openSession({
      url: 'https://1.1.1.1/', fromAgent: true, chatSessionId: 'chat-1',
    });

    const requested = await service.onDownloadRequested(
      opened.id, 'https://example.com/file.txt', '../escape name.txt',
    );
    expect(requested.allow).toBe(true);
    expect(requested.path).not.toBeNull();
    expect(requested.path).toContain('browser-downloads/');
    expect(requested.path).not.toContain('..');
    expect(requested.path).toContain('_escape name.txt');
    expect(existsSync(join(root, 'browser-downloads'))).toBe(true);
    await writeFile(requested.path!, 'hello');
    const expectedSha = createHash('sha256').update('hello').digest('hex');

    service.onDownloadFinished('https://example.com/file.txt', requested.path, true);
    // service.rs:1499 hashes on a worker thread; the observation is Processing until it finishes.
    expect(service.listDownloads(opened.id)[0]?.state).toBe('processing');
    await vi.waitFor(() => expect(service.listDownloads(opened.id)[0]?.state).toBe('completed'));
    const downloads = service.listDownloads(opened.id);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({
      state: 'completed', sha256: expectedSha, sizeBytes: 5, chatSessionId: 'chat-1',
    });
    const handle = downloads[0]!.objectHandle as {
      handleId: string; kind: string; sha256: string | undefined; sizeBytes: number | undefined;
      locator: { rootId: string; relativePath: string };
      capabilities: Record<string, boolean>;
      provenance: { source: string; tool?: string; sourceUri?: string; derivedFrom: unknown[] };
    };
    expect(handle.handleId).toMatch(/^browser_download:bd_/);
    expect(handle.kind).toBe('file');
    expect(handle.sha256).toBe(expectedSha);
    expect(handle.sizeBytes).toBe(5);
    expect(handle.locator).toEqual({
      rootId: 'artifacts', relativePath: downloads[0]!.relativePath,
    });
    expect(handle.capabilities).toMatchObject({
      readable: true, materializable: true, writable: false,
      shareable: false, sendable: false, deletable: true,
    });
    expect(handle.provenance).toMatchObject({
      source: 'browser_download', tool: 'browser_downloads', sourceUri: 'https://example.com/file.txt',
    });
    expect(handle.provenance.derivedFrom).toHaveLength(1);
    expect(service.listTaskDownloads('chat-1')).toHaveLength(1);
    expect(service.listTaskDownloads('other')).toHaveLength(0);
  });

  it('rejects agent downloads when no artifact root provider is published', async () => {
    const { service } = harness();
    const opened = await service.openSession({
      url: 'https://1.1.1.1/', fromAgent: true, chatSessionId: 'chat-2',
    });
    expect(await service.onDownloadRequested(opened.id, 'https://example.com/a.bin', 'a.bin'))
      .toEqual({ allow: false, path: null });
    expect(service.listDownloads(opened.id)).toHaveLength(0);
  });

  it('reports surface host mode and rejects stale sessions', async () => {
    const { service, surface } = harness();
    const opened = await service.openSession({ url: OPEN_URL });
    expect(service.surfaceHostMode()).toBe('embedded');
    await expect(service.focus('bs_missing')).rejects.toBeInstanceOf(BrowserFailure);
    await service.focus(opened.id);
    expect(surface.focusCount).toBe(0); // embedded focus is a no-op
    await service.releaseSurfaceFocus(opened.id);
    await flush();
    expect(surface.releaseCount).toBe(1);
  });

  describe('window.rs errors map to BrowserError::Validation (service.rs:545-565, 686-795, 813-945)', () => {
    const boom = (): Promise<never> => Promise.reject(new Error('boom'));

    it('back/forward/reload wrap surface failures with the Rust context prefix', async () => {
      const { service, surface } = harness();
      const opened = await service.openSession({ url: OPEN_URL });
      await service.navigate(opened.id, 'https://example.com/next', false, false);
      await surface.callbacks?.pageFinished('https://example.com/next');
      await flush();
      surface.goBack = boom;
      await expect(service.back(opened.id)).rejects.toMatchObject({ error: { kind: 'Validation', message: 'navigate failed: boom' } });
      surface.reload = boom;
      await expect(service.reload(opened.id)).rejects.toMatchObject({ error: { kind: 'Validation', message: 'reload failed: boom' } });
    });

    it('release_surface_focus propagates the window error instead of dropping it', async () => {
      const { service, surface } = harness();
      const opened = await service.openSession({ url: OPEN_URL });
      surface.releaseContentFocus = boom;
      await expect(service.releaseSurfaceFocus(opened.id)).rejects.toMatchObject({ error: { kind: 'Validation', message: 'boom' } });
    });

    it('close_session still emits browser:closed when destroying the window fails, then returns the error', async () => {
      const { service, surface, events } = harness();
      await service.openSession({ url: OPEN_URL });
      surface.destroyContentWindow = boom;
      await expect(service.closeSession()).rejects.toMatchObject({ error: { kind: 'Validation', message: 'boom' } });
      expect(events.map(entry => entry.event)).toContain('browser:closed');
    });

    it('open_session ignores a failed stale-window destroy like `let _ = destroy_content_window`', async () => {
      const { service, surface } = harness();
      surface.present = true;
      let attempts = 0;
      surface.destroyContentWindow = async () => { attempts += 1; throw new Error('stale'); };
      const opened = await service.openSession({ url: OPEN_URL });
      expect(attempts).toBe(1);
      expect(opened.url).toBe(OPEN_URL);
    });
  });
});
