import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { ChatV2Emitter, NoopEventSink } from '../../chat/api.ts';
import { normalizeRuntimeRelativePath } from '../../agent-workspace/api.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: real table owners for the executor integration path
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: real table owners for the executor integration path
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import { DstuToolExecutor, DSTU_TOOL_NAMES, requiredUploadLocator, mimeTypeFromName,
  invalidArgs, parseTrashPagination, rejectUnknownArgs, requiredString } from '../src/tools/dstu-executor.ts';
let host: TestHost, root: string, storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dstu-executor-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const result = await storage.migrations.runAll(); expect(result.success, result.error ?? '').toBe(true);
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
const executor = () => new DstuToolExecutor({ database: host.ctx.vfsDatabase, log: host.ctx.logger,
  emit: (name, value) => host.ctx.backendEvents.emit(name, value), index: {
    cleanup: async id => { await host.ctx.vfs.unitIndex.deleteResourceIndexFull(id, host.ctx.vfsIndex.lance); },
    cleanupVectors: async ids => { for (const id of ids) { await host.ctx.vfsIndex.lance.deleteByResource('text', id); await host.ctx.vfsIndex.lance.deleteByResource('multimodal', id); } },
  } });
it('handles_exact_dstu_tool_surface', () => {
  const value = executor();
  for (const name of DSTU_TOOL_NAMES) { expect(value.canHandle(name)).toBe(true); expect(value.canHandle(`builtin-${name}`)).toBe(true); }
  expect(value.canHandle('builtin-resource_read')).toBe(false); expect(value.canHandle('builtin-dstu_empty_trash')).toBe(false);
});
it('risk_levels_match_product_contract', () => {
  const value = executor();
  expect(value.sensitivityLevel('builtin-dstu_list_trash')).toBe('low');
  expect(value.sensitivityLevel('builtin-dstu_set_favorite')).toBe('low');
  expect(value.sensitivityLevel('builtin-dstu_purge')).toBe('high');
  for (const name of DSTU_TOOL_NAMES.filter(name => !['dstu_list_trash', 'dstu_set_favorite', 'dstu_purge'].includes(name))) expect(value.sensitivityLevel(name)).toBe('medium');
});
it('list_trash_is_the_only_parallel_read', () => {
  expect(executor().concurrencyClass('builtin-dstu_list_trash')).toBe('read_only');
  expect(executor().concurrencyClass('builtin-dstu_set_favorite')).toBe('serial');
});
it('secx_08_upload_source_requires_managed_runtime_locator', () => {
  expect(requiredUploadLocator({ root_id: 'temp', relative_path: 'attachments/a.pdf' })).toEqual(['temp', 'attachments/a.pdf']);
  for (const args of [{}, { root_id: 'temp' }, { relative_path: 'a.pdf' }]) expect(() => requiredUploadLocator(args)).toThrow();
  expect(() => normalizeRuntimeRelativePath('/tmp/a.pdf')).toThrow();
  expect(() => normalizeRuntimeRelativePath('../a.pdf')).toThrow();
  expect(() => rejectUnknownArgs({ local_path: '/tmp/a.pdf' }, ['root_id', 'relative_path', 'folder_id', 'name', 'mime_type'])).toThrow();
});
it('mime_inference_covers_primary_document_types', () => {
  expect(mimeTypeFromName('a.pdf')).toBe('application/pdf'); expect(mimeTypeFromName('a.PNG')).toBe('image/png');
  expect(mimeTypeFromName('a.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(mimeTypeFromName('a.unknown')).toBe('application/octet-stream');
});
it('structured_errors_are_machine_readable', () => {
  expect(JSON.parse(invalidArgs('bad', 'fix it'))).toMatchObject({ code: 'INVALID_ARGS', retryable: false });
});
it('trash_pagination_matches_global_read_limit', () => {
  expect(parseTrashPagination({})).toEqual([20, 0]); expect(parseTrashPagination({ limit: 1, offset: 7 })).toEqual([1, 7]);
  for (const args of [{ limit: 0 }, { limit: 21 }, { offset: -1 }, { unknown: true }]) expect(() => parseTrashPagination(args)).toThrow();
  expect(() => rejectUnknownArgs({ title: 'ok', extra: 1 }, ['title'])).toThrow();
  expect(() => requiredString({ title: '  ' }, 'title')).toThrow();
});
it('folder_create_and_trash_listing_use_real_migrated_vfs_repository', async () => {
  const value = executor();
  const context = { message_id: 'm', block_id: 'b', variant_id: null, skill_state_version: null, round_id: null,
    emitter: new ChatV2Emitter(new NoopEventSink(), 'dstu-executor'),
    emitToolCallStart() {}, saveToolBlock() {}, isCancelled: () => false };
  const created = await value.execute({ id: 'c', name: 'dstu_folder_create', arguments: { title: 'Agent repository folder', icon: 'folder', color: '#336699' } }, context);
  expect(created.success).toBe(true);
  const output = created.output as { folder: { id: string; title: string; color: string } };
  const row = storage.database('vfs').get<{ title: string; color: string }>('SELECT title,color FROM folders WHERE id = ?', [output.folder.id]);
  expect(row).toEqual({ title: 'Agent repository folder', color: '#336699' });
  await host.invoke('dstu_folder_delete', { folderId: output.folder.id });
  const listed = await value.execute({ id: 'l', name: 'dstu_list_trash', arguments: {} }, context);
  expect(listed.success).toBe(true);
  expect((listed.output as { items: { id: string; path: string }[] }).items.find(n => n.id === output.folder.id)?.path).toBe(`/_trash/${output.folder.id}`);
});
