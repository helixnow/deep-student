import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkshopOperations } from '../src/operations.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';

it('B6 answers Agent cross-session reproposals with a bind card, never reassigning the managed work itself', async () => {
  const ops = new WorkshopOperations({ dataDir: await mkdtemp(join(tmpdir(), 'dstu-session-owner-')), version: '0.20.0', platform: 'darwin', debug: true });
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const brief = { title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [] };
  const original = await ops.propose({ ...brief, template: 'host-tool', sessionId: 'A' });
  // F19: no error; the card offers 「在这个对话里修改」 and only the user's click binds it.
  await expect(tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'B'))
    .resolves.toMatchObject({ id: original.id, sessionId: 'A', bindRequired: { sessionId: 'B' } });
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
  await expect(tools.invoke('dstu_plugin_propose_install', { ...brief, pluginId: original.pluginId }, 'C')).resolves.toMatchObject({ bindRequired: { sessionId: 'C' } });
  expect((await ops.status(original.id)).sessionId).toBe('A');
  await expect(ops.propose({ ...brief, template: 'host-tool', sessionId: 'C', pluginId: original.pluginId })).rejects.toThrow('another conversation');
  // Every work is listed in every conversation (F19), marked whether it can be changed here.
  await expect(tools.invoke('dstu_plugin_status', {}, 'C')).resolves.toMatchObject({ works: [{ id: original.id, ownedHere: false }] });
  await expect(tools.invoke('dstu_plugin_diagnose', { id: original.id }, 'C')).rejects.toThrow('another conversation');
});
