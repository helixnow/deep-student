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

it('keeps the original conversation bound after the user opened a modification elsewhere', async () => {
  const ops = new WorkshopOperations({ dataDir: await mkdtemp(join(tmpdir(), 'dstu-session-rebind-')), version: '0.20.0', platform: 'darwin', debug: true });
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const brief = { title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] };
  const original = await ops.propose({ ...brief, template: 'host-tool', sessionId: 'A' });
  // The manager's 「让 AI 改」 opened conversation B for this work.
  const bound = await ops.bindSession(original.id, original.revision, 'B');
  expect(bound).toMatchObject({ sessionId: 'B', boundSessions: ['A'] });
  // Continuing in A no longer fails with "work belongs to another conversation".
  await expect(tools.invoke('dstu_plugin_status', {}, 'A')).resolves.toMatchObject({ works: [{ id: original.id }] });
  const again = await tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'A');
  expect(again).toMatchObject({ sessionId: 'A', boundSessions: ['B'], id: original.id });
  // A conversation the user never bound still cannot touch it.
  await expect(tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'C')).rejects.toThrow('another conversation');
  await expect(tools.invoke('dstu_plugin_diagnose', { id: original.id }, 'C')).rejects.toThrow('another conversation');
});
