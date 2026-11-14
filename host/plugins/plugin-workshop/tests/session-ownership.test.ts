import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';

it('B6 rejects Agent cross-session reproposals without reassigning the managed work', async () => {
  const ops = new WorkshopOperations({ dataDir: await mkdtemp(join(tmpdir(), 'dstu-session-owner-')), version: '0.20.0', platform: 'darwin', debug: true });
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const brief = { title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] };
  const original = await ops.propose({ ...brief, template: 'host-tool', sessionId: 'A' });
  await expect(tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'B')).rejects.toThrow('another conversation');
  expect(await ops.status(original.id)).toEqual(original);
  const bound = await ops.bindSession(original.id, original.revision, 'B');
  expect(bound.sessionId).toBe('B');
  await expect(tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'B')).resolves.toMatchObject({ sessionId: 'B', id: original.id });
  expect(tools.canHandle('dstu_plugin_bind_session')).toBe(false);
});
