import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { DEFAULT_TOOL_RESULT_CHAR_BUDGET } from '../../../kernel/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import { BackendEventsSink, ChatV2Emitter, type BackendEvent, type ToolResultInfo } from '../../chat/api.ts';
import { checkExpectedHash, pageUtf8Text, serializedCharLen, sha256Hex } from '../../agent-workspace/api.ts';
import { stripToolNamespace } from '../../agent-skills/api.ts';
import plugin from '../index.ts';
import { inferTypeFromId, isSupportedReadId, sanitizeReadResourceId, pickResourceReadId,
  collectReadAvailability, buildDegradationInfo, fitResourceReadResult } from '../src/tools/resource-read-helpers.ts';
import { BuiltinResourceExecutor, type ResourceToolContext } from '../src/tools/resource-executor.ts';

let root: string, host: TestHost, storage: ReturnType<typeof createStorageService>;
const saved: ToolResultInfo[] = [];
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-read-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true);
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({ app: { dataDir: root }, provide: { storage, settings },
    plugins: [pathsPlugin, agentPlugin, notesPlugin, reposPlugin, indexPlugin, plugin] });
}, 120_000);
beforeEach(() => { saved.length = 0; host.events.length = 0; });
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
function executor() { return host.ctx.agentTools.toolExecutors().find(e => e.name() === 'BuiltinResourceExecutor') as BuiltinResourceExecutor; }
function context(): ResourceToolContext {
  const emitter = new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'resource-read', false);
  return { services: host.ctx, block_id: 'resource-block', message_id: 'resource-message', variant_id: 'v1', skill_state_version: 3, round_id: 'round1', emitter,
    emitToolCallStart(name, input, id) { emitter.emitStartWithMeta('tool_call', 'resource-message', 'resource-block', { toolName: name, input, toolCallId: id }, 'v1', 3, 'round1'); },
    saveToolBlock(result) { saved.push(result); } };
}
const read = (args: unknown) => executor().execute({ id: 'read-call', name: 'builtin-resource_read', arguments: args }, context());

it('test_strip_namespace', () => {
  expect(stripToolNamespace('builtin-resource_list')).toBe('resource_list');
  expect(stripToolNamespace('builtin-resource_read')).toBe('resource_read');
  expect(stripToolNamespace('resource_list')).toBe('resource_list');
});
it('test_infer_type_from_id', () => {
  expect(inferTypeFromId('note_abc123')).toBe('notes'); expect(inferTypeFromId('tb_xyz789')).toBe('files');
  expect(inferTypeFromId('exam_test1')).toBe('exams'); expect(inferTypeFromId('essay_essay1')).toBe('essays');
  expect(inferTypeFromId('essay_session_abc123')).toBe('essays'); expect(inferTypeFromId('tr_trans1')).toBe('translations');
  expect(inferTypeFromId('unknown_id')).toBeNull();
});
it('test_is_supported_read_id', () => {
  for (const id of ['note_abc', 'tb_abc', 'res_abc']) expect(isSupportedReadId(id)).toBe(true);
  expect(isSupportedReadId('document.pdf')).toBe(false);
});
it('test_sanitize_read_resource_id', () => {
  for (const [raw, expected] of [['  `note_abc123`  ', 'note_abc123'], ['ID: tb_123，读取它', 'tb_123'],
    ['res_456 (resource)', 'res_456'], ['（readResourceId：res_789，请读取）', 'res_789'], ['sourceId=exam_111。', 'exam_111']]) {
    expect(sanitizeReadResourceId(raw!)).toBe(expected);
  }
});
it('test_pick_resource_read_id_priority', () => {
  expect(pickResourceReadId({ resource_id: '', readResourceId: ' res_1 ', sourceId: 'note_2' })).toEqual(['res_1', 'readResourceId']);
  expect(pickResourceReadId({ sourceId: 'note_2', resourceId: 'res_2' })).toEqual(['note_2', 'sourceId']);
});
it('test_build_degradation_info_fallback', () => {
  const info = buildDegradationInfo('files', '[文档: sample.pdf]', collectReadAvailability('', '', null), null);
  expect(info.level).toBe('fallback'); expect(info.reasonCodes).toContain('filename_placeholder');
});
it('test_sensitivity_level', () => {
  for (const name of ['builtin-resource_list', 'builtin-resource_search', 'builtin-resource_read']) expect(executor().sensitivityLevel(name)).toBe('low');
  for (const name of ['builtin-mindmap_delete', 'builtin-mindmap_edit_nodes']) expect(executor().sensitivityLevel(name)).toBe('high');
  expect(executor().managesCancellation('builtin-mindmap_edit_nodes')).toBe(true);
  expect(executor().managesCancellation('builtin-resource_read')).toBe(false);
});
it('resource_read_disables_outer_result_budget', () => {
  expect(executor().resultCharBudget('builtin-resource_read')).toBeNull();
  expect(executor().resultCharBudget('builtin-resource_list')).toBe(DEFAULT_TOOL_RESULT_CHAR_BUDGET);
});
it('resource_page_hash_covers_page_range_logical_content', () => {
  const logical = '第1页\n第2页你好', hash = sha256Hex(Buffer.from(logical));
  const page = pageUtf8Text(logical, 0, 4);
  expect(page.content).toBe('第1'); expect(page.next_offset).toBe(Buffer.byteLength('第1')); expect(page.eof).toBe(false);
  expect(() => checkExpectedHash(hash, hash)).not.toThrow();
  const rest = pageUtf8Text(logical, page.next_offset, 64);
  expect(page.content + rest.content).toBe(logical); expect(rest.eof).toBe(true);
});
it('resource_read_budget_prunes_large_preview_sidecars_and_keeps_progress', () => {
  const content = '正文'.repeat(20_000), previews = Array.from({ length: 2000 }, (_, index) => ({ pageIndex: index,
    blobHash: `blob-${index}-${'x'.repeat(80)}`, imagePath: `C:\\preview\\${'x'.repeat(80)}\\page.png` }));
  const result: Record<string, unknown> = { content, previewImages: structuredClone(previews), metadata: { previewImages: previews, title: 'large preview fixture' } };
  fitResourceReadResult(result, 0, Buffer.byteLength(content));
  expect(serializedCharLen(result)).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_CHAR_BUDGET - 400);
  expect(result.returned_bytes).toBeGreaterThan(0); expect(result.next_offset).toBeGreaterThan(0);
  expect(result.metadata).toMatchObject({ previewImagesOmitted: true });
});
it('reads a real note through resource-id resolution, returns UTF8 pages and persists scoped tool results', async () => {
  const note = host.ctx.notes.repository.createNote({ title: 'Paged note', content: '第1页\n第2页你好', tags: [] }, host.ctx.vfsDatabase.getConnSafe());
  const first = await read({ readResourceId: note.resourceId, max_bytes: 4 });
  expect(first.success).toBe(true);
  const output = first.output as Record<string, unknown>;
  expect(output).toMatchObject({ content: '第1', contentLength: 4, returned_bytes: 4, next_offset: 4, eof: false,
    resolvedResourceId: note.id, resolvedBy: 'resource.source_id', resolvedFromArg: 'readResourceId', type: 'notes' });
  const rest = await read({ resource_id: note.id, offset: output.next_offset, expected_hash: output.sha256 });
  expect(rest.success).toBe(true); expect((rest.output as Record<string, unknown>).content).toBe('页\n第2页你好');
  expect(saved).toEqual([first, rest]);
  const events = host.eventsNamed('chat_v2_event_resource-read') as BackendEvent[];
  expect(events.map(event => event.phase)).toEqual(['start', 'end', 'start', 'end']);
  for (const event of events) expect(event).toMatchObject({ variantId: 'v1', skillStateVersion: 3, roundId: 'round1' });
  const conflict = await read({ resource_id: note.id, expected_hash: 'bad' });
  expect(conflict.success).toBe(false); expect(conflict.error).toContain('expected_hash 不匹配');
});
it('reads the selected OCR page range and hashes that logical range rather than the byte window', async () => {
  const db = host.ctx.vfsDatabase.getConnSafe();
  const file = host.ctx.vfsRepo.files.createFile(db, 'resource-pages', 'pages.pdf', 20, 'document', 'application/pdf', null, null);
  db.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', ['["一页","二页","三页"]', file.id]);
  const result = await read({ resource_id: file.id, page_start: 2, page_end: 3, max_bytes: 5 });
  expect(result.success).toBe(true);
  expect(result.output).toMatchObject({ totalPages: 3, pageStart: 2, pageEnd: 3, content: '--- ',
    sha256: sha256Hex(Buffer.from('--- 第 2 页 ---\n二页\n\n--- 第 3 页 ---\n三页')) });
});
it('resolves the legacy textbook source-id hop when reading OCR pages', async () => {
  const db = host.ctx.vfsDatabase.getConnSafe();
  const file = host.ctx.vfsRepo.files.createFile(db, 'legacy-page-source', 'legacy.pdf', 20, 'document', 'application/pdf', null, null);
  db.run('UPDATE resources SET source_id = ?1 WHERE id = ?2', ['tb_legacy_resource_read', file.resourceId!]);
  db.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', ['["legacy page"]', file.id]);
  const result = await read({ resource_id: 'tb_legacy_resource_read', page_start: 1 });
  expect(result.success).toBe(true);
  expect(result.output).toMatchObject({ resolvedResourceId: 'tb_legacy_resource_read', totalPages: 1, content: '--- 第 1 页 ---\nlegacy page' });
});
it('maps the real essay-session owner DTO into resource metadata without losing its snake-case fields', async () => {
  const session = await host.invoke('dstu_create', { path: '/', options: { type: 'essay', name: 'Essay read', metadata: { essayType: 'narrative' } } }) as { id: string };
  const result = await read({ resource_id: session.id });
  expect(result.success).toBe(true);
  expect(result.output).toMatchObject({ metadata: { title: 'Essay read', essayType: 'narrative', totalRounds: 0,
    createdAt: expect.any(String), updatedAt: expect.any(String) } });
});
