/**
 * Discovery for the generation model: every live Host service a plugin can inject, with real method signatures and
 * short docs read from the app's api.ts types (dstu_plugin_api_list / dstu_plugin_api_read).
 */
import { expect, it } from 'vitest';
import { definePlugin } from '../../../kernel/api.ts';
import { WorkshopCatalog } from '../src/catalog.ts';
import { parseMembers, ServiceDocs } from '../src/service-docs.ts';

const root = new URL('../../../../', import.meta.url);
const rootPath = decodeURIComponent(root.pathname.replace(/^\/([A-Za-z]:)/, '$1'));

it('reads members, multi-line signatures and their first doc sentence', () => {
  expect(parseMembers(`
    /** Lists notes. Second sentence. */
    list(filter?: { tag?: string }): Promise<Note[]>;
    readonly version: 1
    create(
      input: NoteInput,
      options?: { signal?: AbortSignal },
    ): Promise<Note>;
  `)).toEqual([
    { name: 'list', signature: 'list(filter?: { tag?: string }): Promise<Note[]>', doc: 'Lists notes.' },
    { name: 'version', signature: 'readonly version: 1' },
    { name: 'create', signature: 'create( input: NoteInput, options?: { signal?: AbortSignal }, ): Promise<Note>' },
  ]);
});

it('lists every live documented service (plugin-provided and platform) and hides kernel-owned ones', async () => {
  const provider = definePlugin({ meta: { id: 'dstu.example', provides: ['notes', 'pluginModel', 'agentTodo', 'commands'] }, apply() {} });
  const catalog = new WorkshopCatalog(() => [provider], rootPath, name => ['settings', 'storage', 'shell'].includes(name));
  const ids = (await catalog.list('services')).entries.map(entry => entry.id);
  expect(ids).toEqual(expect.arrayContaining(['services:dstu.example', 'service:notes', 'service:pluginModel', 'service:agentTodo', 'service:settings', 'service:storage']));
  expect(ids).not.toContain('service:commands');
  expect(ids).not.toContain('service:shell');
  expect(ids).not.toContain('service:qbank'); // documented but not provided right now
  const summary = (await catalog.list('services')).entries.find(entry => entry.id === 'service:notes')!.summary;
  expect(summary).toMatch(/^ctx\.notes: NotesService \(dstu\.example\)/);

  const model = (await catalog.read('service:pluginModel', '0.20.1')).content as Awaited<ReturnType<ServiceDocs['read']>> & { use: { inject: string[]; permission: string } };
  expect(model.members.find(member => member.name === 'complete')?.signature).toMatch(/^complete\(request: PluginModelRequest/);
  expect(Object.keys(model.types)).toEqual(expect.arrayContaining(['PluginModelRequest', 'PluginModelResult']));
  expect(model.use).toMatchObject({ inject: ['pluginModel'], permission: 'service:pluginModel' });

  const notes = (await catalog.read('service:notes', '0.20.1')).content as NonNullable<Awaited<ReturnType<ServiceDocs['read']>>>;
  expect(notes.members.map(member => member.name)).toContain('repository');
  expect(notes.types.NoteRepository?.members?.length).toBeGreaterThan(0);

  const plugin = (await catalog.read('services:dstu.example', '0.20.1')).content as { api: Record<string, { members: unknown[] }> };
  expect(Object.keys(plugin.api)).toEqual(['notes', 'pluginModel', 'agentTodo']);
  await expect(catalog.read('service:commands', '0.20.1')).rejects.toThrow('unknown API');
  await expect(catalog.read('service:qbank', '0.20.1')).rejects.toThrow('unknown API');
});

it('documents the services the learner usually asks for', async () => {
  const docs = new ServiceDocs(rootPath);
  for (const name of ['notes', 'anki', 'qbank', 'review', 'vfs', 'agentTodo', 'agentAutomation', 'llm', 'pluginModel', 'settings', 'storage']) {
    const doc = await docs.read(name);
    expect(doc, name).not.toBeNull();
    expect(doc!.members.length + Object.keys(doc!.types).length, name).toBeGreaterThan(0);
  }
});
