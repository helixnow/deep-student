import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import {
  newUserMessageParams, convertAttachmentInputToMeta, extractUserRefsSnapshot,
  newContextSnapshot, newContextRef, addUserContextRef, addRetrievalContextRef,
  contextSnapshotAllResourceIds, contextSnapshotHasRefs, contextRefToSendRef, sendRefToContextRef,
} from '../api.ts';

describe('user_message_builder.rs via chatSession', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterEach(async () => { await host.dispose(); });
  it('test_build_user_message_minimal', () => {
    const result = host.ctx.chatSession.buildUserMessage(newUserMessageParams('session_123', 'Hello'));
    expect(result.message.id.startsWith('msg_')).toBe(true); expect(result.message.sessionId).toBe('session_123');
    expect(result.message.role).toBe('user'); expect(result.block.content).toBe('Hello');
    expect(result.message.attachments).toBeUndefined(); expect(result.message._meta).toBeUndefined();
  });
  it('test_build_user_message_with_id', () => {
    const result = host.ctx.chatSession.buildUserMessage({ ...newUserMessageParams('session_123', 'Hello'), id: 'msg_custom_id' });
    expect(result.message.id).toBe('msg_custom_id'); expect(result.block.messageId).toBe('msg_custom_id');
    expect(result.block.id).toBe('blk_ucontent_custom_id');
  });
  it('test_convert_attachment_image', () => {
    const meta = convertAttachmentInputToMeta({ name: 'test.png', mimeType: 'image/png', base64Content: 'iVBORw0KGgo=' });
    expect(meta.type).toBe('image'); expect(meta.name).toBe('test.png');
    expect(meta.previewUrl).toBeDefined(); expect(meta.previewUrl!.startsWith('data:image/png;base64,')).toBe(true);
  });
  it('test_convert_attachment_document', () => {
    const meta = convertAttachmentInputToMeta({ name: 'doc.pdf', mimeType: 'application/pdf', textContent: 'PDF content' });
    expect(meta.type).toBe('document'); expect(meta.previewUrl).toBeDefined();
  });
  it('test_convert_attachment_audio', () => {
    expect(convertAttachmentInputToMeta({ name: 'audio.mp3', mimeType: 'audio/mpeg', base64Content: 'base64audio' }).type).toBe('audio');
  });
  it('test_convert_attachment_video', () => {
    expect(convertAttachmentInputToMeta({ name: 'video.mp4', mimeType: 'video/mp4', base64Content: 'base64video' }).type).toBe('video');
  });
  it('test_extract_user_refs_snapshot_empty', () => {
    expect(extractUserRefsSnapshot(newContextSnapshot())).toBeNull();
  });
  it('test_extract_user_refs_snapshot_with_refs', () => {
    const snapshot = newContextSnapshot(); addUserContextRef(snapshot, newContextRef('res_1', 'hash_1', 'note'));
    const extracted = extractUserRefsSnapshot(snapshot)!;
    expect(extracted).not.toBeNull(); expect(extracted.userRefs).toHaveLength(1);
    expect(extracted.retrievalRefs ?? []).toEqual([]);
  });
  it('test_build_user_message_with_context_snapshot', () => {
    const snapshot = newContextSnapshot(); addUserContextRef(snapshot, newContextRef('res_1', 'hash_1', 'note'));
    addRetrievalContextRef(snapshot, newContextRef('res_2', 'hash_2', 'retrieval'));
    const result = host.ctx.chatSession.buildUserMessage({ ...newUserMessageParams('session_123', 'Hello'), contextSnapshot: snapshot });
    expect(result.message._meta).toBeDefined(); expect(result.message._meta?.contextSnapshot).toBeDefined();
    expect(result.message._meta?.contextSnapshot?.userRefs).toHaveLength(1);
    expect(result.message._meta?.contextSnapshot?.retrievalRefs ?? []).toEqual([]);
  });
  it('multi_variant_user_can_persist_canonical_refs_without_claiming_a_model_snapshot', () => {
    const result = host.ctx.chatSession.buildUserMessage({ ...newUserMessageParams('session', 'look'), canonicalContent: [{
      type: 'image_ref', image_id: 'image-1', name: 'image.png', resource_id: 'res-1', source_id: 'file-1',
      blob_hash: 'blob-hash', content_hash: 'content-hash', mime_type: 'image/png', pinned: false, retrieval_hit: false,
    }] });
    expect(result.message._meta).toBeDefined(); expect(result.message._meta?.executionSnapshot).toBeUndefined();
    expect(result.message._meta?.canonicalContent).toHaveLength(1);
  });
  it('keeps supplied zero time, deterministic repeated-prefix ids, and warns only for absent time', () => {
    const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
    const p = { ...newUserMessageParams('s', ''), id: 'msg_msg_fixed', timestamp: 0 };
    const a = host.ctx.chatSession.buildUserMessage(p); const b = host.ctx.chatSession.buildUserMessage(p);
    expect(a).toEqual(b); expect(a.block.id).toBe('blk_ucontent_fixed');
    expect(a.message.timestamp).toBe(0); expect(a.message.blockIds).toEqual([a.block.id]);
    expect(a.block).toMatchObject({ status: 'success', type: 'content', blockIndex: 0, startedAt: 0, endedAt: 0, firstChunkAt: 0 });
    expect(warnings).toEqual([]);
    host.ctx.chatSession.buildUserMessage(newUserMessageParams('s', 'text'));
    expect(warnings).toEqual(['[UserMessageBuilder] No timestamp provided, falling back to current time']);
  });
  it('preserves the Rust size estimate and text precedence without decoding base64', () => {
    const meta = convertAttachmentInputToMeta({ name: 'a', mimeType: 'text/plain', base64Content: 'YQ==', textContent: '' });
    expect(meta.size).toBe(3); expect(meta.previewUrl).toBe('data:text/plain;base64,');
    expect(meta.status).toBe('ready'); expect(meta.id).toMatch(/^att_[0-9a-f-]{36}$/);
    expect(convertAttachmentInputToMeta({ name: 'a', mimeType: 'text/plain', textContent: '中文' })).toMatchObject({ size: 0, previewUrl: 'data:text/plain;base64,5Lit5paH' });
    expect(convertAttachmentInputToMeta({ name: 'a', mimeType: 'IMAGE/png' })).toMatchObject({ type: 'other', size: 0 });
  });
  it('test_context_ref_serialization', () => {
    const json = JSON.stringify(newContextRef('res_abc123', 'sha256_hash', 'note'));
    expect(json).toContain('"resourceId"'); expect(json).toContain('"typeId"');
    expect(json).not.toContain('"resource_id"'); expect(json).not.toContain('"type_id"');
  });
  it('test_send_context_ref_serialization', () => {
    const json = JSON.stringify(contextRefToSendRef(newContextRef('res_abc123', 'sha256_hash', 'note'), [{ type: 'text', text: 'content' }]));
    expect(json).toContain('"resourceId"'); expect(json).toContain('"formattedBlocks"');
  });
  it('test_context_snapshot_serialization', () => {
    const snapshot = newContextSnapshot(); addUserContextRef(snapshot, newContextRef('res_1', 'hash_1', 'note'));
    addRetrievalContextRef(snapshot, newContextRef('res_2', 'hash_2', 'retrieval'));
    const json = JSON.stringify(snapshot); expect(json).toContain('"userRefs"'); expect(json).toContain('"retrievalRefs"');
  });
  it('test_context_snapshot_empty_skip', () => { expect(JSON.stringify(newContextSnapshot())).toBe('{}'); });
  it('test_context_snapshot_all_resource_ids', () => {
    const snapshot = newContextSnapshot(); addUserContextRef(snapshot, newContextRef('res_1', 'hash_1', 'note'));
    addUserContextRef(snapshot, newContextRef('res_2', 'hash_2', 'file'));
    addRetrievalContextRef(snapshot, newContextRef('res_3', 'hash_3', 'retrieval'));
    expect(contextSnapshotAllResourceIds(snapshot)).toEqual(['res_1', 'res_2', 'res_3']);
    expect(contextSnapshotHasRefs(snapshot)).toBe(true);
  });
  it('test_send_context_ref_conversion', () => {
    const ref = newContextRef('res_abc', 'hash_xyz', 'note');
    const send = contextRefToSendRef(ref, [{ type: 'text', text: 'formatted content' }]);
    expect(send.resourceId).toBe('res_abc'); expect(send.typeId).toBe('note'); expect(send.formattedBlocks).toHaveLength(1);
    expect(sendRefToContextRef(send)).toEqual(ref);
  });
});
