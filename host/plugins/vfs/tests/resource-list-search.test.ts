import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import plugin from '../index.ts';
import { createResourceNode } from '../api.ts';
import { parseResourceType, sanitizeEssayNodesForList } from '../src/tools/resource-list.ts';
import { BuiltinResourceExecutor, type ResourceToolContext } from '../src/tools/resource-executor.ts';

let root: string, host: TestHost, storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-list-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true);
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({ app: { dataDir: root }, provide: { storage, settings },
    plugins: [pathsPlugin, agentPlugin, notesPlugin, reposPlugin, indexPlugin, plugin] });
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
const db = () => host.ctx.vfsDatabase.getConnSafe();
function executor() { return host.ctx.agentTools.toolExecutors().find(e => e.name() === 'BuiltinResourceExecutor') as BuiltinResourceExecutor; }
async function invoke(name: string, args: unknown = {}) {
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'resource-list', false);
  const context: ResourceToolContext = { services: host.ctx, message_id: 'm', block_id: 'b', variant_id: null, round_id: null, skill_state_version: null,
    emitter, emitToolCallStart(toolName, input, id) { emitter.emitStart('tool_call', 'm', 'b', { toolName, input, id }, null); }, saveToolBlock: vi.fn() };
  return executor().execute({ id: 'call', name: `builtin-${name}`, arguments: args }, context);
}
const folder = (title: string) => host.invoke<{ id: string }>('dstu_folder_create', { title });
const add = (folderId: string, itemType: string, itemId: string) => host.invoke('dstu_folder_add_item', { folderId, itemType, itemId });

it('test_parse_resource_type', () => {
  for (const [input, expected] of [['note', 'note'], ['notes', 'note'], ['textbook', 'textbook'], ['exam', 'exam'], ['file', 'file'], ['image', 'image'], ['mindmap', 'mindmap']]) {
    expect(parseResourceType(input!)).toBe(expected);
  }
  expect(parseResourceType('unknown')).toBeNull();
});
it('test_sanitize_essay_nodes_for_list', () => {
  const essay = createResourceNode('essay_001', '/essay_001', '测试作文', 'essay', 'essay_001');
  essay.metadata = { essayType: 'narrative', score: 85, gradingResult: { level: 'A' }, latestScore: 90, gradeLevel: '高中', isFavorite: true };
  const note = createResourceNode('note_001', '/note_001', '测试笔记', 'note', 'note_001');
  note.metadata = { tags: ['math'], isFavorite: false };
  sanitizeEssayNodesForList([essay, note], host.ctx.logger);
  for (const field of ['score', 'gradingResult', 'latestScore', 'gradeLevel']) expect(essay.metadata).not.toHaveProperty(field);
  expect(essay.metadata).toMatchObject({ essayType: 'narrative', isFavorite: true });
  expect(note.metadata).toHaveProperty('tags'); expect(note.metadata).toHaveProperty('isFavorite', false);
});
it('keeps folder-scoped file inclusion and post-limit favorite filtering in the Rust order', async () => {
  const target = await folder('Resource listing');
  const doc = host.ctx.vfsRepo.files.createFile(db(), 'list-doc', 'list.txt', 5, 'document', 'text/plain', null, null);
  const image = host.ctx.vfsRepo.files.createFile(db(), 'list-image', 'list.png', 5, 'image', 'image/png', null, null);
  await add(target.id, 'file', doc.id); await add(target.id, 'file', image.id);
  const scoped = await invoke('resource_list', { type: 'file', folder_id: target.id });
  expect(scoped.success).toBe(true);
  expect((scoped.output as { items: { id: string }[] }).items.map(item => item.id).sort()).toEqual([doc.id, image.id].sort());
  const global = await invoke('resource_list', { type: 'file' });
  expect((global.output as { items: { id: string }[] }).items.map(item => item.id)).toContain(doc.id);
  expect((global.output as { items: { id: string }[] }).items.map(item => item.id)).not.toContain(image.id);
  const notes = host.ctx.notes.repository;
  const old = notes.createNote({ title: 'Old favorite', content: '', tags: [] }, db());
  const recent = notes.createNote({ title: 'Recent plain', content: '', tags: [] }, db());
  notes.setFavorite(old.id, true, db()); await add(target.id, 'note', old.id); await add(target.id, 'note', recent.id);
  db().run('UPDATE notes SET updated_at = ?1 WHERE id = ?2', ['2000-01-01T00:00:00Z', old.id]);
  db().run('UPDATE notes SET updated_at = ?1 WHERE id = ?2', ['2026-01-01T00:00:00Z', recent.id]);
  expect((await invoke('resource_list', { type: 'note', folder_id: target.id, favorites_only: true, limit: 1 })).output).toMatchObject({ count: 0, items: [] });
});
it('reports a failing all-type query as partial success but fails a single-type query', async () => {
  db().exec('ALTER TABLE notes RENAME TO resource_list_notes_unavailable');
  try {
    const partial = await invoke('resource_list', { type: 'all' });
    expect(partial.success).toBe(true);
    expect(partial.output).toMatchObject({ partial_success: true, partial_errors: expect.arrayContaining([expect.stringContaining('notes:')]) });
    const single = await invoke('resource_list', { type: 'note' });
    expect(single.success).toBe(false); expect(single.error).toContain('no such table: notes');
  } finally { db().exec('ALTER TABLE resource_list_notes_unavailable RENAME TO notes'); }
});
it('searches with unknown types as unrestricted and uses character-based snippets', async () => {
  const text = '前'.repeat(120) + '中文关键词' + '后'.repeat(120);
  const note = host.ctx.notes.repository.createNote({ title: 'Keyword fixture 中文关键词', content: text, tags: [] }, db());
  const result = await invoke('resource_search', { query: '中文关键词', types: ['not-a-type'], top_k: 1000 });
  expect(result.success).toBe(true);
  const item = (result.output as { items: Record<string, unknown>[] }).items.find(item => item.id === note.id);
  expect(item).toMatchObject({ snippet: `...${'前'.repeat(100)}中文关键词${'后'.repeat(100)}...`, chatankiCompatible: false, chatankiTargetId: null });
  const missing = await invoke('resource_search', {});
  expect(missing.success).toBe(false); expect(missing.error).toBe('Missing \'query\' parameter. 请提供搜索关键词，例如 resource_search(query="关键词")。');
});
it('lists folder trees with optional counts and stops recursion only after depth 50', async () => {
  const parent = await folder('Recursive fixture');
  for (let index = 0; index < 55; index++) {
    db().run('INSERT INTO folders(id, parent_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, 1, 1)',
      [`fld_deep_${index}`, index === 0 ? parent.id : `fld_deep_${index - 1}`, `Depth ${index}`]);
  }
  const result = await invoke('folder_list', { parent_id: parent.id, recursive: true, include_count: false });
  expect(result.success).toBe(true);
  const output = result.output as { folders: Record<string, unknown>[]; count: number };
  expect(output.count).toBe(1);
  let nodes = output.folders, depth = 0;
  while (nodes.length > 0) {
    expect(nodes[0]).not.toHaveProperty('resource_count'); depth++;
    nodes = (nodes[0]!.children as Record<string, unknown>[] | undefined) ?? [];
  }
  expect(depth).toBe(51);
  const flat = await invoke('folder_list', { parent_id: parent.id });
  expect(flat.output).toMatchObject({ count: 1, recursive: false, folders: [expect.objectContaining({ resource_count: 0 })] });
});

it('folder_list recursive batches item counts accurately across nested folders', async () => {
  const rootFolder = await folder('Batch Count Root');
  const childA = await host.invoke<{ id: string }>('dstu_folder_create', { title: 'Child A', parentId: rootFolder.id });
  const childB = await host.invoke<{ id: string }>('dstu_folder_create', { title: 'Child B', parentId: rootFolder.id });
  const doc1 = host.ctx.vfsRepo.files.createFile(db(), 'b1', 'b1.txt', 3, 'document', 'text/plain', null, null);
  const doc2 = host.ctx.vfsRepo.files.createFile(db(), 'b2', 'b2.txt', 3, 'document', 'text/plain', null, null);
  const doc3 = host.ctx.vfsRepo.files.createFile(db(), 'b3', 'b3.txt', 3, 'document', 'text/plain', null, null);
  await add(rootFolder.id, 'file', doc1.id);
  await add(childA.id, 'file', doc2.id);
  await add(childA.id, 'file', doc3.id);

  const res = await invoke('folder_list', { parent_id: rootFolder.id, recursive: true, include_count: true });
  expect(res.success).toBe(true);
  const folders = (res.output as { folders: Array<{ id: string; resource_count: number }> }).folders;
  const byId = new Map(folders.map(f => [f.id, f.resource_count]));
  expect(byId.get(childA.id)).toBe(2);
  expect(byId.get(childB.id)).toBe(0);
});
