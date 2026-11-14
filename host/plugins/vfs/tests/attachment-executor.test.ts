import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi, type MockInstance } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import { stripToolNamespace } from '../../agent-skills/api.ts';
// boundary-allow cross-plugin-impl: install real Chat V2 message persistence for the original integration tests
import chatPlugin from '../../chat/index.ts';
// boundary-allow cross-plugin-impl: actual VFS table owner
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: actual note owner required by VFS
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: actual document parser used by the executor
import mediaPlugin from '../../media/index.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import { AttachmentToolExecutor, type AttachmentErrorPort, type AttachmentToolContext } from '../src/tools/attachment-executor.ts';

let host: TestHost, storage: ReturnType<typeof createStorageService>, root: string;
// Chat (chat_v2/tools/attachment_stage_executor.rs) owns the error classifier; spy on the real provided port.
let localize: MockInstance<AttachmentErrorPort['localize']>;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fake-image-bytes')]);
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-executor-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true);
  const settings = createSettingsService({ db: () => storage.database('mistakes'),
    secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({
    plugins: [pathsPlugin, agentPlugin, notesPlugin, reposPlugin, indexPlugin, plugin, mediaPlugin, chatPlugin],
    app: { dataDir: root }, provide: { storage, settings },
  });
  localize = vi.spyOn(host.ctx.chatAttachmentErrors, 'localize');
  const chat = host.ctx.chatSession;
  for (const id of ['sess_attachment_db', 'sess_context_ref']) chat.createSession({ id, mode: 'chat',
    titleLocked: false, persistStatus: 'active', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' });
  chat.createMessage({ id: 'msg_attachment_db', sessionId: 'sess_attachment_db', role: 'user', blockIds: [], timestamp: 1,
    attachments: [{ id: 'att_text', name: 'note.txt', type: 'document', mimeType: 'text/plain', size: 5,
      previewUrl: 'data:text/plain;base64,aGVsbG8=', status: 'ready' }] });
  chat.createMessage({ id: 'msg_context_ref', sessionId: 'sess_context_ref', role: 'user', blockIds: [], timestamp: 2,
    _meta: { contextSnapshot: { userRefs: [['res_ref_img', 'image'], ['res_ref_doc', 'file'], ['res_ref_noblob', 'image']]
      .map(([resourceId, typeId]) => ({ resourceId: resourceId!, typeId: typeId!, hash: 'hash' })) } } });
  const db = host.ctx.vfsDatabase.getConnSafe();
  const blob = host.ctx.vfsRepo.blobs.storeBlob(db, host.ctx.vfsDatabase.blobsDir(), png, 'image/png', 'png');
  const now = Date.now(), ts = '2026-10-11T00:00:00Z';
  for (const [id, hash, type, mode, data, source] of [
    ['res_upload_img', 'h-upload-img', 'image', 'external', null, 'att_img'],
    ['res_ref_img', 'h-ref-img', 'image', 'inline', '{"refs":[{"sourceId":"att_img"}]}', 'att_img'],
    ['res_upload_doc', 'h-upload-doc', 'file', 'external', null, 'att_doc'],
    ['res_ref_doc', 'h-ref-doc', 'file', 'inline', '{"refs":[]}', 'res_upload_doc'],
    ['res_ref_noblob', 'h-ref-noblob', 'image', 'inline', '{"refs":[]}', 'att_noblob'],
  ]) db.run(`INSERT INTO resources(id,hash,type,storage_mode,data,source_id,ref_count,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,?6,1,?7,?7)`, [id!, hash!, type!, mode!, data!, source!, now]);
  db.run(`INSERT INTO files(id,resource_id,blob_hash,sha256,file_name,name,mime_type,type,size,created_at,updated_at)
    VALUES ('att_img','res_upload_img',?1,'sha-img','photo.png','photo.png','image/png','image',?2,?3,?3)`, [blob.hash, png.length, ts]);
  db.run(`INSERT INTO files(id,resource_id,sha256,file_name,name,mime_type,type,size,extracted_text,created_at,updated_at)
    VALUES ('att_doc','res_upload_doc','sha-doc','notes.pdf','notes.pdf','application/pdf','document',10,'第一章 线性回归',?1,?1)`, [ts]);
  db.run(`INSERT INTO files(id,sha256,file_name,name,mime_type,type,size,created_at,updated_at)
    VALUES ('att_noblob','sha-noblob','lost.png','lost.png','image/png','image',1,?1,?1)`, [ts]);
}, 120_000);
afterAll(async () => { await host?.dispose(); storage?.dispose(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
function executor() { return host.ctx.agentTools.toolExecutors().find(value => value.name() === 'AttachmentToolExecutor') as AttachmentToolExecutor; }
function context(session = 'sess_attachment_db'): AttachmentToolContext {
  return { session_id: session, chat_v2_db: host.ctx.chatSession.database, services: host.ctx,
    block_id: 'blk_attachment', emitToolCallStart: vi.fn(), emitToolCallEnd: vi.fn(), emitToolCallError: vi.fn(), saveToolBlock: vi.fn() };
}
const call = (name: string, args: unknown = {}) => ({ id: 'call_attachment', name, arguments: args });
it('test_can_handle', () => {
  expect(executor()).toBeInstanceOf(AttachmentToolExecutor);
  expect(executor().canHandle('builtin-attachment_list')).toBe(true);
  expect(executor().canHandle('builtin-attachment_read')).toBe(true);
  expect(executor().canHandle('builtin-rag_search')).toBe(false);
  expect(executor().canHandle('builtin-resource_read')).toBe(false);
});
it('does not register tool families whose required owner ports are absent', () => {
  const names = host.ctx.agentTools.toolExecutors().map(value => value.name());
  expect(names).toContain('AttachmentToolExecutor');
  expect(names).not.toContain('GenerativeUiExecutor');
  expect(names).not.toContain('DstuToolExecutor');
  expect(names).not.toContain('BuiltinRetrievalExecutor');
});
it('test_strip_namespace', () => {
  expect(stripToolNamespace('builtin-attachment_list')).toBe('attachment_list');
  expect(stripToolNamespace('attachment_read')).toBe('attachment_read');
});
it('test_sensitivity_level', () => {
  for (const name of ['builtin-attachment_list', 'builtin-attachment_read']) {
    expect(executor().sensitivityLevel(name)).toBe('low'); expect(executor().concurrencyClass(name)).toBe('read_only');
  }
  expect(executor().canHandle('builtin-attachment_stage')).toBe(false);
});
it('attachment_queries_use_chat_v2_database_without_main_database', async () => {
  // The executor reads through chatSession; no mistakes database is supplied to its context.
  const list = await executor().executeList(call('builtin-attachment_list'), context());
  expect(list.count).toBe(1); expect(list.attachments[0]).toMatchObject({ attachment_id: 'att_text' });
  expect((await executor().executeRead(call('builtin-attachment_read', { message_id: 'msg_attachment_db', attachment_id: 'att_text' }), context())).content).toBe('hello');
});
const readRef = (id: string) => executor().executeRead(call('builtin-attachment_read', { message_id: 'msg_context_ref', attachment_id: id }), context('sess_context_ref'));
it('attachment_read_resolves_reference_image_to_blob_base64', async () => {
  const list = await executor().executeList(call('builtin-attachment_list'), context('sess_context_ref'));
  expect(list.attachments[0]).toMatchObject({ attachment_id: 'res_ref_img', status: 'context_ref' });
  expect(await readRef('res_ref_img')).toMatchObject({ source: 'context_snapshot', type: 'image', mime_type: 'image/png', name: 'photo.png', content: png.toString('base64') });
});
it('attachment_read_resolves_indirect_document_reference_to_text', async () => {
  expect(await readRef('res_ref_doc')).toMatchObject({ type: 'document', name: 'notes.pdf', content: '第一章 线性回归' });
});
it('attachment_read_reports_missing_source_bytes_explicitly', async () => {
  await expect(readRef('res_ref_noblob')).rejects.toThrow('Attachment source not found in VFS: res_ref_noblob（文件 att_noblob 的原始内容缺失）');
  const result = await executor().execute(call('builtin-attachment_read', { message_id: 'msg_context_ref', attachment_id: 'res_ref_noblob' }), context('sess_context_ref'));
  expect(result.success).toBe(false); expect(JSON.parse(result.error!).code).toBe('ATTACHMENT_SOURCE_UNAVAILABLE');
  expect(localize).toHaveBeenCalledWith('Attachment source not found in VFS: res_ref_noblob（文件 att_noblob 的原始内容缺失）');
});
it('preserves the Rust list group limit order, session isolation and UTF8 byte length', async () => {
  const ctx = context();
  const original = host.ctx.chatSession.getMessage('msg_attachment_db')!;
  host.ctx.chatSession.updateMessage({ ...original, _meta: { contextSnapshot: { userRefs: [{ resourceId: 'res_ref_img', hash: 'hash', typeId: 'image' }] } } });
  expect((await executor().executeList(call('attachment_list', { limit: 0, session_id: 'other' }), ctx)).count).toBe(2);
  await expect(executor().executeRead(call('attachment_read', { message_id: 'msg_context_ref', attachment_id: 'res_ref_img' }), ctx))
    .rejects.toThrow('Unauthorized: Cannot access attachments from other sessions');
  host.ctx.chatSession.updateMessage(original);
  const read = await readRef('res_ref_doc'); expect(read.contentLength).toBe(Buffer.byteLength('第一章 线性回归'));
});
