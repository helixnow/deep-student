import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../kernel/agent-api.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { RuntimeRootsService } from '../../agent-workspace/api.ts';
import workspace from '../../agent-workspace/index.ts';
import type {
  BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import { BrowserRuntimeService } from '../src/browser-service.ts';
import type { BrowserDatabase } from '../src/database.ts';
import { f3FeatureFlags, loadF3Flags, settingsStore } from './support/f3-feature-flags.ts';
import type { JsonValue } from '../src/command-result.ts';
import { BrowserToolExecutor } from '../src/browser-tool-executor.ts';

const WORKBENCH_BROWSER_ENABLED = 'desktop.workbenchBrowserEnabled';
const BROWSER_AGENT_CONTROL = 'desktop.workbenchBrowserAgentControl';

class MemorySettings {
  private readonly values = new Map<string, string>();

  get(key: string): string | null { return this.values.get(key) ?? null; }
  save(key: string, value: string): void { this.values.set(key, value); }
  delete(key: string): boolean { return this.values.delete(key); }
  listByPrefix(prefix: string): { key: string; value: string; updatedAt: string }[] {
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '1970-01-01T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string): number {
    let deleted = 0;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix)) { this.values.delete(key); deleted += 1; }
    }
    return deleted;
  }
  async saveSecret(key: string, value: string): Promise<void> { this.save(key, value); }
  async getSecret(key: string): Promise<string | null> { return this.get(key); }
  async deleteSecret(key: string): Promise<boolean> { return this.delete(key); }
  bind(): this { return this; }
}

class FakeSurface implements BrowserSurfaceHost {
  present = false;
  clicks: string[] = [];
  uploads: Array<{ ref: string; files: JsonValue }> = [];
  failSnapshot = false;
  snapshots = 0;
  /** Bridge envelope error (`BridgeError::Bridge`) returned by click/type/setInputFiles. */
  bridgeFailure: JsonValue | null = null;
  beforeBridgeFailure: (() => Promise<void>) | null = null;

  private async rejectIfBridgeFailure(): Promise<void> {
    if (this.bridgeFailure === null) return;
    if (this.beforeBridgeFailure !== null) await this.beforeBridgeFailure();
    throw this.bridgeFailure;
  }
  hostMode(): string { return 'embedded'; }
  hasContentWindow(): boolean { return this.present; }
  async createContentWindow(_options: BrowserSurfaceCreateOptions): Promise<void> { this.present = true; }
  async destroyContentWindow(): Promise<boolean> { this.present = false; return true; }
  async navigate(): Promise<void> {}
  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}
  async focusContentWindow(): Promise<void> {}
  async releaseContentFocus(): Promise<void> {}
  async mainViewportSize(): Promise<{ width: number; height: number }> {
    return { width: 1_280, height: 720 };
  }
  async setContentBounds(): Promise<void> {}
  async setContentOcclusions(): Promise<void> {}
  async setContentVisibility(): Promise<void> {}
  async snapshot(): Promise<JsonValue> {
    this.snapshots += 1;
    if (this.failSnapshot) throw new Error('snapshot unavailable');
    return { text: 'snapshot text', epoch: 7 };
  }
  async click(ref: string): Promise<JsonValue> {
    this.clicks.push(ref);
    await this.rejectIfBridgeFailure();
    return { ok: true, ref };
  }
  async typeText(ref: string, text: string): Promise<JsonValue> {
    await this.rejectIfBridgeFailure();
    return { ok: true, ref, text };
  }
  async setInputFiles(ref: string, files: JsonValue): Promise<JsonValue> {
    this.uploads.push({ ref, files });
    await this.rejectIfBridgeFailure();
    return { ok: true, ref, files };
  }
  async scroll(options: { direction: string | null; amount: number | null; ref: string | null }): Promise<JsonValue> {
    return { ok: true, ...options };
  }
  subscribe(_callbacks: SurfaceEventCallbacks): () => void { return () => undefined; }
}

function fakeDatabase(): BrowserDatabase {
  return {
    ensureOpen(): void {},
    isOpen(): boolean { return false; },
    activeDir(): string { return join(tmpdir(), 'browser-executor-test'); },
    dbPath(): string { return join(tmpdir(), 'browser-executor-test', 'browser.db'); },
    getConn(): never { throw new Error('unused test database'); },
    tryGetConn(): never { throw new Error('unused test database'); },
    getSchemaVersion(): number { return 0; },
    close(): void {},
    dispose(): void {},
  } as unknown as BrowserDatabase;
}

function settingsForAgent(enabled: boolean): MemorySettings {
  const settings = new MemorySettings();
  settings.save(WORKBENCH_BROWSER_ENABLED, 'true');
  settings.save(BROWSER_AGENT_CONTROL, 'true');
  const manager = loadF3Flags(settings);
  manager.enableFeature('ui.workbench_browser');
  if (enabled) manager.enableFeature('tools.browser_agent');
  f3FeatureFlags.save(manager, settingsStore(settings));
  return settings;
}

interface Harness {
  executor: BrowserToolExecutor;
  surface: FakeSurface;
  events: Array<[string, unknown]>;
  service: BrowserRuntimeService;
  logs: Array<[string, string]>;
}

function harness(enabled = true, runtimeRoots?: RuntimeRootsService): Harness {
  const settings = settingsForAgent(enabled);
  const surface = new FakeSurface();
  const events: Array<[string, unknown]> = [];
  const logs: Array<[string, string]> = [];
  const featureFlagEnabled = (name: string): boolean => loadF3Flags(settings).isFeatureEnabled(name);
  const service = new BrowserRuntimeService({
    db: fakeDatabase(),
    settings: settings as unknown as SettingsStore,
    surface,
    platform: 'darwin',
    featureFlags: { isEnabled: featureFlagEnabled },
    emit: (event, payload) => { events.push([event, payload]); },
    now: () => new Date('2026-11-04T00:00:00.000Z'),
  });
  const executor = new BrowserToolExecutor({
    service: () => service,
    settings: settings as unknown as SettingsStore,
    featureFlagEnabled,
    log: (level, message) => { logs.push([level, message]); },
    ...(runtimeRoots === undefined ? {} : { runtimeRoots: () => runtimeRoots }),
  });
  return { executor, surface, events, service, logs };
}

async function createRootsHost(): Promise<{
  host: TestHost;
  roots: RuntimeRootsService;
  dispose: () => Promise<void>;
}> {
  const host = await createTestHost({ provide: { settings: new MemorySettings() } });
  const storage = createStorageService({
    baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir,
  });
  host.ctx.provide('storage', storage);
  await host.install(workspace);
  return {
    host,
    roots: host.ctx.runtimeRoots,
    dispose: async () => { storage.dispose(); await host.dispose(); },
  };
}

function artifactFile(host: TestHost, relativePath: string, content: string | Buffer): void {
  const root = host.ctx.runtimeRoots.rootById('artifacts', { session_id: 'session-1' });
  fs.mkdirSync(root.path, { recursive: true });
  fs.writeFileSync(join(root.path, relativePath), content);
}

function context(events: Array<[string, unknown]>): ExecutionContext {
  return {
    ids: { sessionId: 'session-1', messageId: 'message-1', blockId: 'block-1', toolCallId: 'call-1', round: 0 },
    host: {
      hasFrontend: () => true,
      emit: (event: string, payload: unknown) => { events.push([event, payload]); },
    },
    isCancelled: () => false,
  } as unknown as ExecutionContext;
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { id: 'call-1', name, arguments: args };
}

describe('BrowserToolExecutor production execute', () => {
  it('browser_screenshot preserves the Rust unavailable-capability payload without substituting a DOM snapshot', async () => {
    const { executor, surface, events } = harness();
    const ctx = context(events);
    const opened = await executor.execute(call('builtin-browser_open', { url: 'https://1.1.1.1/' }), ctx);
    expect(opened.success, String(opened.error)).toBe(true);
    const session = (opened.output as Record<string, unknown>).session as Record<string, unknown>;
    const snapshotCalls = surface.snapshots;
    surface.failSnapshot = true;
    const screenshot = await executor.execute(call('builtin-browser_screenshot'), ctx);
    expect(screenshot.success, String(screenshot.error)).toBe(true);
    expect(screenshot.output).toEqual({
      ok: true, action: 'screenshot_capability', available: false,
      capability: 'browser_visible_webview_screenshot', reasonCode: 'PLATFORM_API_UNAVAILABLE',
      reason: '当前 Tauri/Wry 平台未提供嵌入式 WebView 可见区域截图接口',
      session_id: session.id, url: session.url, object_handle: null,
    });
    expect(surface.snapshots).toBe(snapshotCalls);
  });

  it('executes open, snapshot, click and close through the browser service', async () => {
    const { executor, surface, events } = harness();
    const ctx = context(events);

    const opened = await executor.execute(
      call('builtin-browser_open', { url: 'https://1.1.1.1/' }), ctx,
    );
    expect(opened.success, String(opened.error)).toBe(true);
    const openOutput = opened.output as Record<string, unknown>;
    expect(openOutput.opened).toBe(true);
    expect(openOutput.snapshot).toContain('<untrusted_web_content');
    expect(openOutput.snapshot).toContain('snapshot text');
    expect(openOutput.ref_epoch).toBe(7);
    const session = openOutput.session as Record<string, unknown>;
    expect(String(session.id)).toMatch(/^bs_/);
    expect(session.controlMode).toBe('agent');

    const clicked = await executor.execute(
      call('browser_click', { ref: 'e12', include_snapshot: false }), ctx,
    );
    expect(clicked.success).toBe(true);
    expect((clicked.output as Record<string, unknown>).ref).toBe('e12');
    expect(surface.clicks).toEqual(['e12']);

    const closed = await executor.execute(call('browser_close'), ctx);
    expect(closed.success).toBe(true);
    expect(closed.output).toEqual({ ok: true, closed: true });
  });

  it('fails closed when the tools.browser_agent flag is disabled', async () => {
    const { executor, events } = harness(false);
    const result = await executor.execute(
      call('browser_open', { url: 'https://1.1.1.1/' }), context(events),
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('BROWSER_DISABLED');
    expect(String(result.error)).toContain('tools.browser_agent');
  });

  it('validates URLs and refs before touching the native surface', async () => {
    const { executor, surface, events } = harness();
    const ctx = context(events);
    const invalidUrl = await executor.execute(call('browser_open', { url: 'http://10.0.0.1/' }), ctx);
    expect(invalidUrl.success).toBe(false);
    expect(String(invalidUrl.error)).toContain('BROWSER_SSRF_BLOCKED');
    expect(surface.present).toBe(false);

    const invalidRef = await executor.execute(call('browser_click', { ref: 'css=body' }), ctx);
    expect(invalidRef.success).toBe(false);
    expect(String(invalidRef.error)).toContain('BROWSER_INVALID_ARGS');
  });
});

const PASSWORD_BLOCKED_ERROR = '[BROWSER_PASSWORD_BLOCKED] 密码/OTP 输入框禁止 Agent 代填，请用户接管后自行输入';

function controlModeEvents(events: Array<[string, unknown]>): Array<Record<string, unknown>> {
  return events.filter(([name]) => name === 'browser:control-mode-changed')
    .map(([, payload]) => payload as Record<string, unknown>);
}

describe('BrowserToolExecutor map_bridge_err_maybe_takeover (browser_executor.rs:190-203)', () => {
  it('click on a password field (BLOCKED/password_field) forces user take_over before returning the structured error', async () => {
    const { executor, surface, events, service, logs } = harness();
    const ctx = context(events);
    expect((await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx)).success).toBe(true);
    surface.bridgeFailure = {
      kind: 'Bridge', code: 'BLOCKED', message: 'refused', details: { reason: 'password_field' },
    };
    const before = controlModeEvents(events).length;

    const result = await executor.execute(call('browser_click', { ref: 'e3' }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe(PASSWORD_BLOCKED_ERROR);
    expect(service.getActiveState()?.controlMode).toBe('user');
    const changed = controlModeEvents(events).slice(before);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ controlMode: 'user', reason: 'password_blocked' });
    expect(logs).toContainEqual(['info', '[BrowserToolExecutor] password BLOCKED → forced user take_over']);
  });

  it('type with a password message (no details.reason) forces take_over too', async () => {
    const { executor, surface, events, service, logs } = harness();
    const ctx = context(events);
    expect((await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx)).success).toBe(true);
    surface.bridgeFailure = { kind: 'Bridge', code: 'blocked', message: 'Password input refused', details: null };

    const result = await executor.execute(call('browser_type', { ref: 'e4', text: 'secret' }), ctx);
    expect(result.error).toBe(PASSWORD_BLOCKED_ERROR);
    expect(service.getActiveState()?.controlMode).toBe('user');
    expect(controlModeEvents(events).at(-1)).toMatchObject({ controlMode: 'user', reason: 'password_blocked' });
    expect(logs.filter(([level]) => level === 'info')).toHaveLength(1);
  });

  it('non-password bridge errors keep agent control and the generic mapping', async () => {
    const { executor, surface, events, service, logs } = harness();
    const ctx = context(events);
    expect((await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx)).success).toBe(true);
    surface.bridgeFailure = { kind: 'Bridge', code: 'BLOCKED', message: 'disabled', details: { reason: 'disabled' } };
    const before = controlModeEvents(events).length;

    const result = await executor.execute(call('browser_click', { ref: 'e5' }), ctx);
    expect(result.error).toBe('[BROWSER_BLOCKED] disabled | details={"reason":"disabled"}');
    expect(service.getActiveState()?.controlMode).toBe('agent');
    expect(controlModeEvents(events).slice(before)).toHaveLength(0);
    expect(logs.some(([, message]) => message.includes('password BLOCKED'))).toBe(false);
  });

  it('take_over failure is logged as warn and the password error is still returned', async () => {
    const { executor, surface, events, service, logs } = harness();
    const ctx = context(events);
    expect((await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx)).success).toBe(true);
    surface.bridgeFailure = {
      kind: 'Bridge', code: 'BLOCKED', message: 'refused', details: { reason: 'password_field' },
    };
    // The session disappears while the bridge call is in flight, so take_over_with_reason
    // fails with BrowserError::NotFound("no active browser session").
    surface.beforeBridgeFailure = () => service.closeSession();

    const result = await executor.execute(call('browser_click', { ref: 'e6' }), ctx);
    expect(result.error).toBe(PASSWORD_BLOCKED_ERROR);
    expect(logs).toContainEqual([
      'warn', '[BrowserToolExecutor] password BLOCKED take_over failed: Not found: no active browser session',
    ]);
    expect(logs.some(([level]) => level === 'info')).toBe(false);
  });
});

describe('browser_file_upload against the published L05 runtimeRoots service', () => {
  it('password BLOCKED from setInputFiles forces user take_over (browser_executor.rs:845)', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      artifactFile(host, 'hello.txt', 'hello');
      const { executor, surface, events, service, logs } = harness(true, roots);
      const ctx = context(events);
      expect((await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx)).success).toBe(true);
      surface.bridgeFailure = {
        kind: 'Bridge', code: 'BLOCKED', message: 'refused', details: { reason: 'password_field' },
      };
      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e7', files: [{ root_id: 'artifacts', relative_path: 'hello.txt' }],
      }), ctx);
      expect(result.error).toBe(PASSWORD_BLOCKED_ERROR);
      expect(service.getActiveState()?.controlMode).toBe('user');
      expect(controlModeEvents(events).at(-1)).toMatchObject({ controlMode: 'user', reason: 'password_blocked' });
      expect(logs).toContainEqual(['info', '[BrowserToolExecutor] password BLOCKED → forced user take_over']);
    } finally {
      await dispose();
    }
  });
  it('authorizes artifacts files and bridges name/mime/base64 payloads', async () => {
    const { host, roots, dispose } = await createRootsHost();
    // Observe the real native implementation; do not replace or fake its hash result.
    const digest = vi.spyOn(webcrypto.subtle, 'digest');
    try {
      artifactFile(host, 'hello.txt', 'hello');
      artifactFile(host, 'alias.md', '# alias');
      const { executor, surface, events } = harness(true, roots);
      const ctx = context(events);
      const opened = await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);
      expect(opened.success, String(opened.error)).toBe(true);
      const sessionId = String((opened.output as Record<string, JsonValue>).session_id ?? '');

      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e5',
        files: [
          { root_id: 'artifacts', relative_path: 'hello.txt' },
          { rootId: 'artifacts', relativePath: 'alias.md' },
        ],
      }), ctx);
      expect(result.success, String(result.error)).toBe(true);
      const output = result.output as Record<string, JsonValue>;
      expect(output.ok).toBe(true);
      expect(output.action).toBe('file_upload');
      expect(output.ref).toBe('e5');
      expect(output.submitted).toBe(false);
      expect(output.session_id).toBe(sessionId);
      expect(String(output.snapshot)).toContain('snapshot text');

      const files = output.files as Array<Record<string, JsonValue>>;
      expect(files).toHaveLength(2);
      const hello = files[0]!;
      expect(hello.name).toBe('hello.txt');
      expect(hello.root_id).toBe('artifacts');
      expect(hello.relative_path).toBe('hello.txt');
      expect(hello.locator).toBe('runtime://artifacts/hello.txt');
      expect(hello.sha256).toBe(createHash('sha256').update('hello').digest('hex'));
      expect(hello.size_bytes).toBe(5);

      const handle = hello.object_handle as Record<string, JsonValue>;
      expect(handle.kind).toBe('file');
      expect(handle.displayName).toBe('hello.txt');
      expect(handle.mediaType).toBe('text/plain');
      expect(handle.sizeBytes).toBe(5);
      expect(handle.sha256).toBe(hello.sha256);
      expect(handle.locator).toEqual({ rootId: 'artifacts', relativePath: 'hello.txt' });
      expect(handle.capabilities).toMatchObject({
        readable: true, materializable: true, writable: false,
        shareable: false, sendable: true, deletable: false,
      });
      expect((handle.provenance as Record<string, JsonValue>).tool).toBe('browser_file_upload');
      expect(files[1]!.name).toBe('alias.md');
      expect(digest).toHaveBeenCalledTimes(2);
      expect(digest).toHaveBeenNthCalledWith(1, 'SHA-256', Buffer.from('hello'));
      expect(digest).toHaveBeenNthCalledWith(2, 'SHA-256', Buffer.from('# alias'));

      expect(surface.uploads).toHaveLength(1);
      expect(surface.uploads[0]!.ref).toBe('e5');
      expect(surface.uploads[0]!.files).toEqual([
        { name: 'hello.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' },
        { name: 'alias.md', mimeType: 'text/plain', base64: Buffer.from('# alias').toString('base64') },
      ]);
    } finally {
      digest.mockRestore();
      await dispose();
    }
  });

  it('rejects temp roots, parent traversal, directories and missing files before the bridge', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      const root = roots.rootById('artifacts', { session_id: 'session-1' });
      fs.mkdirSync(join(root.path, 'nested'), { recursive: true });
      const { executor, surface, events } = harness(true, roots);
      const ctx = context(events);
      await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);

      const temp = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'temp', relative_path: 'draft.txt' }],
      }), ctx);
      expect(temp.success).toBe(false);
      expect(String(temp.error)).toContain('BROWSER_FILE_UNAUTHORIZED');

      const traversal = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: '../escape.txt' }],
      }), ctx);
      expect(traversal.success).toBe(false);
      expect(String(traversal.error)).toContain('BROWSER_FILE_UNAUTHORIZED');

      const directory = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'nested' }],
      }), ctx);
      expect(directory.success).toBe(false);
      expect(String(directory.error)).toContain('BROWSER_FILE_UNAUTHORIZED');

      const missing = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'missing.txt' }],
      }), ctx);
      expect(missing.success).toBe(false);
      expect(String(missing.error)).toContain('BROWSER_FILE_NOT_FOUND');

      expect(surface.uploads).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks that canonicalize outside the selected runtime root', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      const root = roots.rootById('artifacts', { session_id: 'session-1' });
      fs.mkdirSync(root.path, { recursive: true });
      const outside = join(host.app.dataDir, 'outside.txt');
      fs.writeFileSync(outside, 'outside');
      fs.symlinkSync(outside, join(root.path, 'escape.txt'));
      const { executor, surface, events } = harness(true, roots);
      const ctx = context(events);
      await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);

      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'escape.txt' }],
      }), ctx);
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('BROWSER_FILE_UNAUTHORIZED');
      expect(surface.uploads).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  it('enforces the 16 MiB aggregate upload limit for the authorized file', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      const root = roots.rootById('artifacts', { session_id: 'session-1' });
      fs.mkdirSync(root.path, { recursive: true });
      const big = join(root.path, 'big.bin');
      fs.writeFileSync(big, '');
      fs.truncateSync(big, 16 * 1024 * 1024 + 1);
      const { executor, surface, events } = harness(true, roots);
      const ctx = context(events);
      await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);

      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'big.bin' }],
      }), ctx);
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('BROWSER_FILE_TOO_LARGE');
      expect(surface.uploads).toHaveLength(0);
    } finally {
      await dispose();
    }
  });

  const canRevokeRead = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.runIf(canRevokeRead)('RF-W05-browser-upload-size-precheck: rejects an oversized file from its stat size without reading it',
    async () => {
      const { roots, dispose } = await createRootsHost();
      try {
        const root = roots.rootById('artifacts', { session_id: 'session-1' });
        fs.mkdirSync(root.path, { recursive: true });
        fs.writeFileSync(join(root.path, 'first.bin'), Buffer.alloc(8 * 1024 * 1024));
        const second = join(root.path, 'second.bin');
        fs.writeFileSync(second, '');
        fs.truncateSync(second, 8 * 1024 * 1024 + 1);
        // Unreadable: a read attempt would surface BROWSER_FILE_READ_FAILED instead of the size error.
        fs.chmodSync(second, 0o000);
        const { executor, surface, events } = harness(true, roots);
        const ctx = context(events);
        await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);

        const result = await executor.execute(call('browser_file_upload', {
          ref: 'e1', files: [
            { root_id: 'artifacts', relative_path: 'first.bin' },
            { root_id: 'artifacts', relative_path: 'second.bin' },
          ],
        }), ctx);
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('BROWSER_FILE_TOO_LARGE');
        expect(String(result.error)).not.toContain('BROWSER_FILE_READ_FAILED');
        expect(surface.uploads).toHaveLength(0);
      } finally {
        await dispose();
      }
    });

  it('keeps the upload successful when the post-upload snapshot fails', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      artifactFile(host, 'hello.txt', 'hello');
      const { executor, surface, events } = harness(true, roots);
      surface.failSnapshot = true;
      const ctx = context(events);
      await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);

      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'hello.txt' }],
      }), ctx);
      expect(result.success, String(result.error)).toBe(true);
      const output = result.output as Record<string, JsonValue>;
      expect(output.ok).toBe(true);
      expect(output.snapshot).toBeUndefined();
      expect(surface.uploads).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it('fails closed when the runtimeRoots service is not published', async () => {
    const { executor, surface, events } = harness();
    const ctx = context(events);
    await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);
    const result = await executor.execute(call('browser_file_upload', {
      ref: 'e1', files: [{ root_id: 'artifacts', relative_path: 'hello.txt' }],
    }), ctx);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('BROWSER_FILE_UNAVAILABLE');
    expect(surface.uploads).toHaveLength(0);
  });

  it('rejects authorized roots after revocation through the L05 command surface', async () => {
    const { host, roots, dispose } = await createRootsHost();
    try {
      const selected = join(host.app.dataDir, 'selected');
      fs.mkdirSync(selected, { recursive: true });
      fs.writeFileSync(join(selected, 'notes.txt'), 'notes');
      const authorized = await host.invoke<Array<{ id: string; path: string }>>(
        'chat_v2_authorize_runtime_root', { path: selected },
      );
      const rootId = authorized.find(
        root => root.path === fs.realpathSync.native(selected),
      )!.id;
      await host.invoke('chat_v2_revoke_runtime_root', { rootId });

      const { executor, surface, events } = harness(true, roots);
      const ctx = context(events);
      await executor.execute(call('browser_open', { url: 'https://1.1.1.1/' }), ctx);
      const result = await executor.execute(call('browser_file_upload', {
        ref: 'e1', files: [{ root_id: rootId, relative_path: 'notes.txt' }],
      }), ctx);
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain('BROWSER_FILE_UNAUTHORIZED');
      expect(surface.uploads).toHaveLength(0);
    } finally {
      await dispose();
    }
  });
});
