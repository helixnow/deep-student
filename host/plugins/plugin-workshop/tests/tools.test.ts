import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { definePlugin, Schema, type AppInfo } from '../../../kernel/api.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { WorkshopToolExecutor } from '../src/tools.ts';
import { WorkshopOperations } from '../src/operations.ts';

it('discovers actual registered metadata and source contracts, exposes fourteen non-install tools', async () => {
  const plugin = definePlugin({ meta: { id: 'example.live', provides: ['exampleLive'], remote: { exampleLive: ['read'] } }, Config: Schema.object({ enabled: Schema.boolean() }), apply() {} });
  let registered = [plugin];
  const catalog = new WorkshopCatalog(() => registered);
  expect((await catalog.list('services')).entries).toEqual([{ id: 'services:example.live', category: 'services', summary: 'example.live' }]);
  expect((await catalog.read('services:example.live', '0.11.0')).content).toMatchObject({ services: ['exampleLive'], remote: { exampleLive: ['read'] } });
  expect((await catalog.read('config:example.live', '0.11.0')).content).toMatchObject({ fields: [{ path: 'enabled', type: 'boolean' }] });
  registered = [];
  await expect(catalog.read('services:example.live', '0.11.0')).rejects.toThrow('unknown API');
  const slots = await catalog.list('slots');
  expect(slots.entries.length).toBeGreaterThan(0);
  expect((await catalog.read(slots.entries[0]!.id, '0.11.0')).content).toBeTypeOf('string');
  await expect(catalog.read('../../private', '0.11.0')).rejects.toThrow();
  const ops = new WorkshopOperations({ version: '0.20.0', dataDir: await mkdtemp(join(tmpdir(), 'dstu-tools-')) } as AppInfo);
  const tools = new WorkshopToolExecutor(ops, catalog);
  expect(tools.schemaTools()).toHaveLength(14);
  expect(tools.canHandle('dstu_plugin_install')).toBe(false);
  expect(tools.canHandle('dstu_plugin_create')).toBe(false);
  expect(tools.canHandle('builtin-dstu_plugin_configure')).toBe(true);
  expect(tools.sensitivityLevel('dstu_plugin_api_list')).toBe('low');
  expect(tools.sensitivityLevel('dstu_plugin_inventory')).toBe('low');
  expect(tools.sensitivityLevel('dstu_plugin_config_get')).toBe('low');
  expect(tools.sensitivityLevel('dstu_plugin_configure')).toBe('high');
  expect(tools.sensitivityLevel('dstu_plugin_set_enabled')).toBe('high');
  expect(tools.sensitivityLevel('dstu_plugin_app_restart')).toBe('high');
  expect(tools.sensitivityLevel('dstu_plugin_propose_install')).toBe('high');
  expect(tools.sensitivityLevel('dstu_plugin_write_source')).toBe('medium');
  expect(tools.sensitivityLevel('dstu_plugin_validate')).toBe('medium');
  const card = await tools.invoke('dstu_plugin_propose_install', { title: 'Test', description: 'Test', template: 'host-tool', changes: [], capabilities: [], sessionId: 'spoof' }, 'real') as { id: string; sessionId: string };
  expect(card.sessionId).toBe('real');
  await expect(tools.invoke('dstu_plugin_validate', { id: card.id }, 'spoof')).rejects.toThrow('another conversation');
  // Without a bound manager the new tools fail closed instead of inventing plugin state.
  await expect(tools.invoke('dstu_plugin_inventory', {}, 'real')).rejects.toThrow('WORKSHOP_UNAVAILABLE');
  await expect(tools.invoke('dstu_plugin_config_get', { pluginId: 'dstu.example' }, 'real')).rejects.toThrow('WORKSHOP_UNAVAILABLE');
  await expect(tools.invoke('dstu_plugin_app_restart', {}, 'real')).rejects.toThrow('WORKSHOP_UNAVAILABLE');
});

it('reads and hot-updates plugin configuration through the kernel manager port', async () => {
  const ops = new WorkshopOperations({ version: '0.20.0', dataDir: await mkdtemp(join(tmpdir(), 'dstu-tools-config-')) } as AppInfo);
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const calls: string[] = [];
  ops.bindAdmin({
    inventory: async () => ({ safeMode: false, revision: 'r1', plugins: [] }),
    installManagedDirectory: async () => { throw new Error('not invoked'); },
    uninstall: async () => null,
    configOf: async id => ({ id, revision: 'r1', values: { enabled: true }, schema: null }),
    configureManaged: async (id, values) => {
      calls.push(`configure:${id}:${JSON.stringify(values)}`);
      return { id, revision: 'r2', values, schema: null };
    },
    setEnabledManaged: async (id, enabled) => { calls.push(`enabled:${id}:${enabled}`); return { id, enabled, revision: 'r3' }; },
  });
  ops.bindRestart(async () => { calls.push('restart'); });
  expect(await tools.invoke('dstu_plugin_inventory', {}, 'session')).toMatchObject({ revision: 'r1' });
  expect(await tools.invoke('dstu_plugin_config_get', { pluginId: 'dstu.example' }, 'session')).toMatchObject({ id: 'dstu.example', revision: 'r1' });
  expect(await tools.invoke('dstu_plugin_configure', { pluginId: 'dstu.example', values: { enabled: false } }, 'session')).toMatchObject({ revision: 'r2' });
  expect(await tools.invoke('dstu_plugin_set_enabled', { pluginId: 'dstu.example', enabled: true }, 'session')).toMatchObject({ enabled: true });
  expect(await tools.invoke('dstu_plugin_app_restart', { reason: 'user asked' }, 'session')).toMatchObject({ restartRequested: true });
  expect(calls).toEqual([
    'configure:dstu.example:{"enabled":false}',
    'enabled:dstu.example:true',
    'restart',
  ]);
});

it('ignores blank, null, or hallucinated new-work pluginId slugs while rejecting official dstu.* plugins and accepting workshop.plugin- prefixed ids', async () => {
  const ops = new WorkshopOperations({ version: '0.20.0', dataDir: await mkdtemp(join(tmpdir(), 'dstu-tools-propose-')) } as AppInfo);
  const tools = new WorkshopToolExecutor(ops, new WorkshopCatalog(() => []));
  const proposeSchema = tools.schemaTools().find(t => t.id === 'dstu_plugin_propose_install');
  const pluginIdSchema = (proposeSchema?.schema as { function?: { parameters?: { properties?: { pluginId?: { description?: string } } } } })
    ?.function?.parameters?.properties?.pluginId;
  expect(pluginIdSchema?.description).toContain('workshop.plugin-');

  const baseArgs = { title: 'Test', description: 'Desc', template: 'host-tool', changes: ['add cmd'], capabilities: ['read'] };
  const fromEmpty = await tools.invoke('dstu_plugin_propose_install', { ...baseArgs, pluginId: '' }, 'session-a') as { id: string; pluginId: string };
  const fromSlug = await tools.invoke('dstu_plugin_propose_install', { ...baseArgs, pluginId: 'workshop.plugin-focus-formula-quicklook' }, 'session-a') as { pluginId: string };
  const fromNull = await tools.invoke('dstu_plugin_propose_install', { ...baseArgs, pluginId: null }, 'session-a') as { pluginId: string };
  expect(fromEmpty.pluginId).toMatch(/^workshop\.plugin-[a-f0-9-]{36}$/);
  expect(fromSlug.pluginId).toMatch(/^workshop\.plugin-[a-f0-9-]{36}$/);
  expect(fromNull.pluginId).toMatch(/^workshop\.plugin-[a-f0-9-]{36}$/);

  await expect(tools.invoke('dstu_plugin_propose_install', { ...baseArgs, pluginId: 'dstu.shell' }, 'session-a'))
    .rejects.toThrow('WORKSHOP_INVALID: only managed works can be edited (omit pluginId when creating a new plugin, or pass an existing workshop.plugin-... pluginId)');

  const edited = await tools.invoke('dstu_plugin_propose_install', { ...baseArgs, title: 'Updated', pluginId: `  ${fromEmpty.pluginId}  ` }, 'session-a') as { pluginId: string; revision: number };
  expect(edited.pluginId).toBe(fromEmpty.pluginId);
  expect(edited.revision).toBe(2);

  // Also accept workshop.plugin-<uuid> when model passes pluginId as id to diagnose/status
  const statusByPrefixed = await tools.invoke('dstu_plugin_status', { id: fromEmpty.pluginId }, 'session-a') as { works: Array<{ id: string }> };
  expect(statusByPrefixed.works).toHaveLength(1);
  expect(statusByPrefixed.works[0]?.id).toBe(fromEmpty.id);
});
