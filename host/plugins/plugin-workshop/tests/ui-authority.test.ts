import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { definePlugin } from '../../../kernel/api.ts';
import workshop from '../index.ts';
import { WorkshopStore } from '../src/store.ts';
import { checkPluginModule, type PluginManifest } from '../../../kernel/manifest.ts';
import type { WorkshopCard } from '../api.ts';

it('B2 denies ordinary full and restricted Host callers and untrusted UI sources before mutation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-ui-authority-'));
  const uninstall = vi.fn(async () => null);
  const host = await createTestHost({ app: { dataDir }, provide: {
    paths: { appDataDir: dataDir }, chatSession: {}, chatPipeline: {},
    agentTools: { registerToolExecutors: () => ({ dispose() {} }) },
    dstuPluginInstaller: { plugins: () => [], inventory: async () => ({ revision: 'r', plugins: [], safeMode: false }), uninstall },
  }, plugins: [workshop] });
  try {
    const request = { caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method: 'propose', args: [{
      sessionId: 'test', title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [],
    }] };
    for (const source of [{ window: 'main', webview: 'main', origin: 'https://other.example' }, { window: 'other', webview: 'main' }]) {
      await expect(host.invoke('plugin:host|call', request, source)).rejects.toBeDefined();
    }
    const card = await host.invoke<WorkshopCard>('plugin:host|call', request);
    await new WorkshopStore(dataDir).write({ ...card, state: 'installed', version: '1.0.0' });
    for (const trust of ['full', 'restricted']) {
      const malicious = definePlugin({ meta: { id: `example.${trust}`, version: '1.0.0' }, inject: ['pluginWorkshop'], async apply(ctx) {
        await ctx.pluginWorkshop.revoke(card.id, card.revision);
      } });
      const manifest: PluginManifest = { id: malicious.meta.id, version: '1.0.0', packageName: malicious.meta.id, engines: '^0.11', platforms: ['desktop'], requires: {}, permissions: ['service:pluginWorkshop'], trust: trust as 'full' | 'restricted' };
      expect(checkPluginModule(manifest, malicious)).toBeNull();
      await expect(host.runtime.installEntry({ plugin: malicious, packageRoot: join(dataDir, trust), manifest })).rejects.toThrow('WORKSHOP_UI_REQUIRED');
    }
    await expect(host.ctx.pluginWorkshop.list()).rejects.toThrow('WORKSHOP_UI_REQUIRED');
    expect(uninstall).not.toHaveBeenCalled();
    expect(await host.invoke('plugin:host|call', { ...request, method: 'list', args: [] })).toMatchObject([{ id: card.id, state: 'installed' }]);
  } finally { await host.dispose(); }
});
