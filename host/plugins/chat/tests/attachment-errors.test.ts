import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';

describe('attachment_stage_executor shared error service', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeAll(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterAll(async () => { await host.dispose(); });
  it('stage_failure_maps_args_schema_and_not_found', () => {
    const service = host.ctx.chatAttachmentErrors;
    let missing = '';
    try { service.requiredId({}, 'message_id'); } catch (error) { missing = (error as Error).message; }
    const args = JSON.parse(service.localize(missing));
    expect(args.code).toBe('ATTACHMENT_INVALID_ARGS'); expect(args.hint).toContain('<attachment_metadata>');
    const schema = JSON.parse(service.localize('Failed to get message: no such table: messages'));
    expect(schema.code).toBe('ATTACHMENT_STORE_SCHEMA_UNAVAILABLE'); expect(schema.retryable).toBe(false);
    expect(schema.hint).toContain('不要改试 attachment_stage');
    const attachment = JSON.parse(service.localize('Attachment not found: att_x in message msg_x'));
    expect(attachment.code).toBe('ATTACHMENT_NOT_FOUND'); expect(attachment.hint).toContain('attachment_list');
    const source = JSON.parse(service.localize('Attachment source not found in VFS: file_x'));
    expect(source.code).toBe('ATTACHMENT_SOURCE_UNAVAILABLE'); expect(source.hint).toContain('重新附加');
    const staged = JSON.parse(service.localize('Staged file not found: staged/archive.zip'));
    expect(staged.code).toBe('ATTACHMENT_STAGED_FILE_NOT_FOUND'); expect(staged.retryable).toBe(true); expect(staged.hint).toContain('attachment_stage');
  });
  it('required IDs trim Rust whitespace and reject non-string inputs without coercion', () => {
    expect(host.ctx.chatAttachmentErrors.requiredId({ attachment_id: '\u0085att_x\u0085' }, 'attachment_id')).toBe('att_x');
    for (const value of [null, 3, {}, '', ' \n']) {
      expect(() => host.ctx.chatAttachmentErrors.requiredId({ attachment_id: value }, 'attachment_id')).toThrow('ATTACHMENT_INVALID_ARGS');
    }
    expect(host.ctx.chatAttachmentErrors.requiredId({ attachment_id: '\ufeff' }, 'attachment_id')).toBe('\ufeff');
  });
  it('structured errors retain their code and nonmatching strings use the generic fallback', () => {
    const raw = host.ctx.chatAttachmentErrors.notFound('missing detail');
    expect(JSON.parse(host.ctx.chatAttachmentErrors.localize(raw))).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND', retryable: false });
    expect(JSON.parse(host.ctx.chatAttachmentErrors.localize('Something else'))).toMatchObject({ code: 'ATTACHMENT_OPERATION_FAILED' });
    expect(JSON.parse(host.ctx.chatAttachmentErrors.localize(' Attachment not found: x'))).toMatchObject({ code: 'ATTACHMENT_OPERATION_FAILED' });
  });
});
