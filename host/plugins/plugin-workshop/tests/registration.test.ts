import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { AgentToolExecutorRegistry, type AgentToolExecutor } from '../../agent-skills/api.ts';
import workshop from '../index.ts';

it('registers the actual Host service and six executable schemas, rejects cross-plugin RPC and cleans up on unload', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-registration-'));
  const registry = new AgentToolExecutorRegistry();
  const host = await createTestHost({ app: { dataDir }, provide: {
    paths: { appDataDir: dataDir }, chatSession: {}, chatPipeline: {},
    agentTools: { registerToolExecutors: (executors: readonly AgentToolExecutor[]) => registry.register(executors) },
    dstuPluginInstaller: { inventory: async () => ({ revision: 'test', plugins: [], safeMode: false }),
      plugins: () => [], installManagedDirectory: async () => { throw new Error('not invoked'); }, uninstall: async () => null },
  }, plugins: [workshop] });
  try {
    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]?.schemaTools?.()).toHaveLength(14);
    const list = await host.invoke('plugin:host|call', { caller: 'dstu.plugin-workshop', service: 'pluginWorkshop', method: 'list', args: [] });
    expect(list).toEqual([]);
    await expect(host.invoke('plugin:host|call', { caller: 'dstu.settings', service: 'pluginWorkshop', method: 'list', args: [] })).rejects.toBeDefined();
    await host.runtime.unload('dstu.plugin-workshop');
    expect(registry.all()).toEqual([]);
  } finally { await host.dispose(); }
});
