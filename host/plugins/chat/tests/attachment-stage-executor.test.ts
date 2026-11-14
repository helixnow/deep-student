/**
 * attachment_stage_executor.rs ToolExecutor shell (:1931-2012) and its unit tests
 * test_can_handle / test_sensitivity_level, plus production registration.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { writeZip } from '../../../platform/util/node.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { BackendEventsSink, ChatV2Emitter } from '../api.ts';
import type { ToolResultInfo } from '../api.ts';
import { newSession } from '../src/types.ts';
import { createMessage } from '../repository/messages.ts';
import { AttachmentStageExecutor } from '../src/attachment-stage-executor.ts';
import { tempRoot } from '../../agent-workspace/api.ts';

describe('AttachmentStageExecutor', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let dataDir: string;
  let registered: unknown[];
  beforeEach(async () => {
    f = databaseFixture();
    dataDir = mkdtempSync(join(tmpdir(), 'w10-attachment-stage-'));
    registered = [];
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub,
      agentTools: { registerToolExecutors(executors: unknown[]) { registered.push(...executors); return () => {}; },
        toolExecutors: () => registered },
    } });
    host.ctx.chatSession.createSession(newSession('sess_att', 'chat'));
    host.ctx.chatSession.createSession(newSession('sess_other', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); rmSync(dataDir, { recursive: true, force: true }); });

  function executor(): AttachmentStageExecutor {
    return new AttachmentStageExecutor({ dataDir: () => dataDir, attachments: () => undefined });
  }
  function context(sessionId = 'sess_att') {
    const ctx = host.ctx.chatSession.createExecutionContext({ sessionId, messageId: 'msg_tool', blockId: 'blk_tool',
      services: host.ctx, emitter: ChatV2Emitter.withSinkAndBatching(new BackendEventsSink(host.ctx.backendEvents), sessionId, false),
      toolRegistry: { async detectToolConflicts() { return []; }, stripMcpNamespace: name => name,
        async callTool() { throw new Error('not used'); } },
    });
    ctx.chat_v2_db = host.ctx.chatSession.database;
    ctx.tauri_window = { window: 'main', webview: 'main' };
    return ctx;
  }
  function userMessage(id: string, attachments: { id: string; name: string; mimeType: string; previewUrl: string }[]): void {
    createMessage(f.db, { id, sessionId: 'sess_att', role: 'user', blockIds: [], timestamp: 1,
      attachments: attachments.map(a => ({ ...a, type: 'document', size: 0, status: 'ready' })) });
  }
  const dataUrl = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

  it('test_can_handle / test_sensitivity_level', () => {
    const e = executor();
    expect(e.canHandle('builtin-attachment_stage')).toBe(true);
    expect(e.canHandle('attachment_stage')).toBe(true);
    expect(e.canHandle('builtin-attachment_extract')).toBe(true);
    expect(e.canHandle('attachment_extract')).toBe(true);
    expect(e.canHandle('builtin-attachment_read')).toBe(false);
    expect(e.canHandle('builtin-attachment_list')).toBe(false);
    expect(e.sensitivityLevel('builtin-attachment_stage')).toBe('medium');
    expect(e.concurrencyClass('builtin-attachment_stage')).toBe('serial');
    expect(e.name()).toBe('AttachmentStageExecutor');
  });

  it('is registered through agentTools.registerToolExecutors', () => {
    expect(registered.map(e => (e as { name(): string }).name())).toContain('AttachmentStageExecutor');
  });

  it('attachment_stage materializes a legacy data-URL attachment and saves the tool block', async () => {
    userMessage('msg_u', [{ id: 'att_1', name: 'notes.txt', mimeType: 'text/plain', previewUrl: dataUrl(Buffer.from('hello'), 'text/plain') }]);
    const ctx = context();
    const call = { id: 'call_1', name: 'builtin-attachment_stage', arguments: { message_id: 'msg_u', attachment_id: 'att_1' } };
    const result = await executor().execute(call, ctx) as ToolResultInfo;
    expect(result).toMatchObject({ toolCallId: 'call_1', blockId: 'blk_tool', toolName: 'builtin-attachment_stage', success: true });
    const output = result.output as Record<string, unknown>;
    expect(output).toMatchObject({ success: true, root_id: 'temp', relative_path: 'attachments/notes.txt', size: 5,
      original_name: 'notes.txt', staged: 'staged', attachment_id: 'att_1', message_id: 'msg_u', mime_type: 'text/plain' });
    expect(Object.keys(output)).toEqual(['success', 'root_id', 'relative_path', 'size', 'sha256', 'original_name', 'staged',
      'attachment_id', 'message_id', 'hint', 'durationMs', 'object_handle', 'mime_type']);
    expect((output.object_handle as Record<string, unknown>).handleId).toBe(`attachment:att_1:${output.sha256 as string}`);
    expect(readFileSync(join(tempRoot(dataDir, 'sess_att', false).path, 'attachments', 'notes.txt'), 'utf8')).toBe('hello');
    expect(host.ctx.chatSession.getBlock('blk_tool')).toMatchObject({ status: 'success' });
    const again = await executor().execute(call, ctx) as ToolResultInfo;
    expect((again.output as Record<string, unknown>).staged).toBe('already_staged');
  });

  it('attachment_stage failures become localized failure results', async () => {
    userMessage('msg_u', [{ id: 'att_1', name: 'a.txt', mimeType: 'text/plain', previewUrl: dataUrl(Buffer.from('x'), 'text/plain') }]);
    const missingArg = await executor().execute({ id: 'c', name: 'builtin-attachment_stage', arguments: {} }, context()) as ToolResultInfo;
    expect(missingArg.success).toBe(false);
    expect(JSON.parse(missingArg.error!).code).toBe('ATTACHMENT_INVALID_ARGS');
    const foreign = await executor().execute({ id: 'c', name: 'builtin-attachment_stage',
      arguments: { message_id: 'msg_u', attachment_id: 'att_1' } }, context('sess_other')) as ToolResultInfo;
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain('Unauthorized: Cannot access attachments from other sessions');
    const unknown = await executor().execute({ id: 'c', name: 'builtin-attachment_stage',
      arguments: { message_id: 'msg_u', attachment_id: 'att_missing' } }, context()) as ToolResultInfo;
    expect(JSON.parse(unknown.error!).code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('attachment_extract unpacks a staged zip into extracted/<stem>/ and rejects non-temp roots', async () => {
    const zip = writeZip([{ name: 'docs/a.txt', data: Buffer.from('A') }, { name: 'b.txt', data: Buffer.from('BB') }]);
    userMessage('msg_z', [{ id: 'att_z', name: 'bundle.zip', mimeType: 'application/zip', previewUrl: dataUrl(zip, 'application/zip') }]);
    const ctx = context();
    const staged = await executor().execute({ id: 's', name: 'builtin-attachment_stage',
      arguments: { message_id: 'msg_z', attachment_id: 'att_z' } }, ctx) as ToolResultInfo;
    const stagedOut = staged.output as Record<string, unknown>;
    expect((stagedOut.archive_manifest as Record<string, unknown>).entryCount).toBe(2);
    const extracted = await executor().execute({ id: 'x', name: 'builtin-attachment_extract',
      arguments: { root_id: 'temp', relative_path: stagedOut.relative_path } }, ctx) as ToolResultInfo;
    expect(extracted.success).toBe(true);
    expect(extracted.output).toMatchObject({ success: true, format: 'zip', root_id: 'temp', extract_dir: 'extracted/bundle',
      source: 'attachments/bundle.zip', fileCount: 2, directoryCount: 0, totalUncompressedBytes: 3,
      files: [{ path: 'extracted/bundle/docs/a.txt', sizeBytes: 1 }, { path: 'extracted/bundle/b.txt', sizeBytes: 2 }],
      filesTruncated: false });
    const second = await executor().execute({ id: 'x2', name: 'builtin-attachment_extract',
      arguments: { relative_path: 'attachments/bundle.zip' } }, ctx) as ToolResultInfo;
    expect((second.output as Record<string, unknown>).extract_dir).toBe('extracted/bundle_1');
    const wrongRoot = await executor().execute({ id: 'x3', name: 'builtin-attachment_extract',
      arguments: { root_id: 'artifacts', relative_path: 'attachments/bundle.zip' } }, ctx) as ToolResultInfo;
    expect(wrongRoot.success).toBe(false);
    expect(wrongRoot.error).toContain("attachment_extract only accepts root_id=temp (staged attachments), got 'artifacts'");
    const missing = await executor().execute({ id: 'x4', name: 'builtin-attachment_extract',
      arguments: { relative_path: 'attachments/nope.zip' } }, ctx) as ToolResultInfo;
    expect(JSON.parse(missing.error!).code).toBe('ATTACHMENT_STAGED_FILE_NOT_FOUND');
  });
});
