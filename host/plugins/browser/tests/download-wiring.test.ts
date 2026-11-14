import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { artifactRoot } from '../../agent-workspace/api.ts';
import type {
  BrowserSurfaceCreateOptions, BrowserSurfaceHost, SurfaceEventCallbacks,
} from '../api.ts';
import type { BrowserRuntimeService } from '../src/browser-service.ts';
import type { JsonValue } from '../src/command-result.ts';
import browser from '../index.ts';
import { f3FeatureFlags } from './support/f3-feature-flags.ts';

class MinimalSurface implements BrowserSurfaceHost {
  present = false;
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
  async mainViewportSize(): Promise<{ width: number; height: number }> { return { width: 1200, height: 800 }; }
  async setContentBounds(): Promise<void> {}
  async setContentOcclusions(): Promise<void> {}
  async setContentVisibility(): Promise<void> {}
  async snapshot(): Promise<JsonValue> { return { text: '' }; }
  async click(): Promise<JsonValue> { return { ok: true }; }
  async typeText(): Promise<JsonValue> { return { ok: true }; }
  async setInputFiles(): Promise<JsonValue> { return { ok: true }; }
  async scroll(): Promise<JsonValue> { return { ok: true }; }
  subscribe(_callbacks: SurfaceEventCallbacks): () => void { return () => undefined; }
}

describe('browser plugin download artifact root wiring (extensions.rs:166-197, service.rs:1334/1499)', () => {
  it('agent downloads land in chat_v2 runtime_roots::artifact_root and are hashed off the event loop', async () => {
    const values = new Map<string, string>([['desktop.workbenchBrowserEnabled', 'true']]);
    const settings = {
      get: (key: string) => values.get(key) ?? null,
      save: (key: string, value: string) => { values.set(key, value); },
      delete: (key: string) => values.delete(key),
      listByPrefix: () => [],
      deleteByPrefix: () => 0,
      getSecret: async () => null,
      saveSecret: async () => undefined,
      deleteSecret: async () => false,
    };
    const host = await createTestHost({
      provide: {
        settings,
        log: { logger: () => undefined },
        browserSurface: new MinimalSurface(),
        featureFlags: f3FeatureFlags,
        agentTools: { registerToolExecutors: () => undefined },
      },
      app: { version: '0.11.0', debug: true, platform: 'darwin' },
    });
    const storage = createStorageService({ baseDir: host.app.dataDir, dataLocalDir: host.app.dataDir });
    host.ctx.provide('storage', storage);
    try {
      await host.install(browser);
      const service = host.ctx.browser as unknown as BrowserRuntimeService;
      const opened = await service.openSession({ url: 'https://1.1.1.1/', fromAgent: true, chatSessionId: 'chat-1' });
      const requested = await service.onDownloadRequested(opened.id, 'https://example.com/f.txt', 'f.txt');
      expect(requested.allow).toBe(true);
      const expectedRoot = artifactRoot(host.app.dataDir, 'chat-1', false).path;
      expect(requested.path!.startsWith(`${expectedRoot}/browser-downloads/`)).toBe(true);

      await writeFile(requested.path!, 'hello');
      service.onDownloadFinished('https://example.com/f.txt', requested.path, true);
      expect(service.listDownloads(opened.id)[0]?.state).toBe('processing');
      await vi.waitFor(() => expect(service.listDownloads(opened.id)[0]?.state).toBe('completed'));
      expect(service.listDownloads(opened.id)[0]).toMatchObject({
        sha256: createHash('sha256').update('hello').digest('hex'), sizeBytes: 5, chatSessionId: 'chat-1',
      });
    } finally {
      storage.dispose();
      await host.dispose();
    }
  });
});
