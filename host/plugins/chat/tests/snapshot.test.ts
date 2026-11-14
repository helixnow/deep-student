import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock, getBlock } from '../repository/blocks.ts';
import { loadSessionState } from '../repository/session-state.ts';
import { newSession } from '../src/types.ts';
import { remapIdsInValue } from '../src/snapshot.ts';
import type { ExportMessagesChunk, ExportSessionMeta, ImportSessionResult } from '../api.ts';

const SESSION_ID = 'sess_snapshot';

describe('chat_v2 conversation snapshots', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function seed(): void {
    const session = newSession(SESSION_ID, 'chat');
    session.title = 'Snapshot source';
    session.description = 'desc';
    session.metadata = { origin: 'unit' };
    session.createdAt = '2026-01-01T00:00:00Z';
    createSession(f.db, session);
    createMessage(f.db, {
      id: 'msg_user', sessionId: SESSION_ID, role: 'user', timestamp: 1_000,
      blockIds: ['blk_user'],
    });
    createBlock(f.db, {
      id: 'blk_user', messageId: 'msg_user', type: 'content', status: 'success',
      blockIndex: 0, content: 'hello',
    });
    createMessage(f.db, {
      id: 'msg_assistant', sessionId: SESSION_ID, role: 'assistant', timestamp: 2_000,
      blockIds: ['blk_tool'], activeVariantId: 'var_snap',
      variants: [{ id: 'var_snap', modelId: 'm1', blockIds: ['blk_tool'], status: 'success', createdAt: 2_000 }],
      _meta: {
        contextSnapshot: {
          userRefs: [{ resourceId: 'res_1', typeId: 'note', hash: 'h1', injectModes: null }],
        },
      },
      sharedContext: { ragSources: [], memorySources: [], graphSources: [], webSearchSources: [], multimodalSources: [] },
    });
    createBlock(f.db, {
      id: 'blk_tool', messageId: 'msg_assistant', type: 'tool', status: 'success',
      blockIndex: 0, toolName: 'lookup',
      toolInput: { ref: 'blk_user', note: 'msg_user', nested: ['blk_tool', 'other'] },
      toolOutput: { url: 'https://example.test/?id=msg_user' },
    });
  }

  it('exports meta and paged messages, then imports with full ID remapping', async () => {
    seed();
    const meta = await host.invoke<ExportSessionMeta>('chat_v2_export_session_meta', { sessionId: SESSION_ID });
    expect(meta).toMatchObject({
      format: 'deepstudent-conversation-snapshot', version: 1, appVersion: host.ctx.app.version,
      messageCount: 2, pageSize: 100,
    });
    expect(meta.session.id).toBe(SESSION_ID);
    expect(meta.sessionState).toBeNull();

    const first = await host.invoke<ExportMessagesChunk>('chat_v2_export_session_messages', {
      sessionId: SESSION_ID, offset: 0, limit: 1,
    });
    expect(first.messages.map(message => message.id)).toEqual(['msg_user']);
    expect(first.blocks.map(block => block.id)).toEqual(['blk_user']);
    expect(first.nextOffset).toBe(1);
    const second = await host.invoke<ExportMessagesChunk>('chat_v2_export_session_messages', {
      sessionId: SESSION_ID, offset: 1,
    });
    expect(second.messages.map(message => message.id)).toEqual(['msg_assistant']);
    expect(second.nextOffset).toBeNull();

    const snapshot = {
      format: meta.format, version: meta.version,
      session: meta.session, sessionState: meta.sessionState,
      messages: [...first.messages, ...second.messages],
      blocks: [...first.blocks, ...second.blocks],
    };
    const imported = await host.invoke<ImportSessionResult>('chat_v2_import_session', {
      snapshotJson: JSON.stringify(snapshot),
    });
    expect(imported).toMatchObject({ messageCount: 2, blockCount: 2 });
    expect(imported.warnings).toEqual([
      'Snapshot references VFS resources; they may not exist locally and are not relinked',
    ]);
    expect(imported.sessionId).not.toBe(SESSION_ID);

    const session = getSession(f.db, imported.sessionId)!;
    expect(session.title).toBe('Snapshot source (imported)');
    expect(session.titleLocked).toBe(true);
    expect(session.persistStatus).toBe('active');
    expect(session.groupId ?? null).toBeNull();
    expect(session.createdAt).toBe('2026-01-01T00:00:00Z');
    const metadata = session.metadata as Record<string, unknown>;
    expect(metadata.origin).toBe('unit');
    expect(metadata.importedFrom).toMatchObject({ sourceSessionId: SESSION_ID });

    // Message IDs are regenerated; locate by role instead.
    const all = f.db.all<{ id: string; role: string }>(
      'SELECT id, role FROM chat_v2_messages WHERE session_id = ?1 ORDER BY timestamp', [imported.sessionId]);
    expect(all.map(row => row.role)).toEqual(['user', 'assistant']);
    expect(all.map(row => row.id)).not.toContain('msg_user');
    expect(all.map(row => row.id)).not.toContain('msg_assistant');

    const newUserBlock = f.db.all<{ id: string }>(
      'SELECT b.id FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id = b.message_id WHERE m.session_id = ?1 AND b.block_type = ?2',
      [imported.sessionId, 'content'])[0]!;
    const newToolBlockId = f.db.pluck<string>(
      'SELECT b.id FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id = b.message_id WHERE m.session_id = ?1 AND b.block_type = ?2',
      [imported.sessionId, 'tool'])!;
    const toolBlock = getBlock(f.db, newToolBlockId)!;
    expect((toolBlock.toolInput as Record<string, unknown>).ref).toBe(newUserBlock.id);
    expect((toolBlock.toolInput as Record<string, unknown>).note).not.toBe('msg_user');
    expect((toolBlock.toolInput as Record<string, unknown>).nested).toEqual([
      newToolBlockId, 'other',
    ]);
    expect((toolBlock.toolOutput as Record<string, unknown>).url).toBe('https://example.test/?id=msg_user');

    const assistant = f.db.get<{ active_variant_id: string; variants_json: string }>(
      'SELECT active_variant_id, variants_json FROM chat_v2_messages WHERE session_id = ?1 AND role = ?2',
      [imported.sessionId, 'assistant'])!;
    const variants = JSON.parse(assistant.variants_json) as Array<{ id: string; blockIds: string[] }>;
    expect(assistant.active_variant_id).toBe(variants[0]!.id);
    expect(variants[0]!.id).not.toBe('var_snap');
    expect(variants[0]!.blockIds).toEqual([newToolBlockId]);
  });

  it('import trims drafts and warns about orphan blocks and VFS references', async () => {
    seed();
    const meta = await host.invoke<ExportSessionMeta>('chat_v2_export_session_meta', { sessionId: SESSION_ID });
    const chunk = await host.invoke<ExportMessagesChunk>('chat_v2_export_session_messages', {
      sessionId: SESSION_ID, offset: 0,
    });
    const snapshot = {
      format: meta.format, version: meta.version, session: meta.session,
      sessionState: {
        sessionId: SESSION_ID, inputValue: 'draft', panelStates: { a: 1 },
        pendingContextRefsJson: '[]', loadedSkillIdsJson: '["s"]', activeSkillIdsJson: '["a"]',
        skillStateJson: '{}', updatedAt: '2026-01-01T00:00:00Z',
      },
      messages: chunk.messages,
      blocks: [...chunk.blocks, {
        id: 'blk_orphan', messageId: 'msg_missing', type: 'content', status: 'success',
      }],
    };
    const imported = await host.invoke<ImportSessionResult>('chat_v2_import_session', {
      snapshotJson: JSON.stringify(snapshot),
    });
    expect(imported.blockCount).toBe(2);
    expect(imported.warnings).toEqual([
      'Skipped 1 orphan blocks (message not in snapshot)',
      'Snapshot references VFS resources; they may not exist locally and are not relinked',
    ]);
    const state = loadSessionState(f.db, imported.sessionId)!;
    expect(state.inputValue).toBeUndefined();
    expect(state.panelStates).toBeUndefined();
    expect(state.pendingContextRefsJson).toBeUndefined();
    expect(state.loadedSkillIdsJson).toBe('["s"]');
    expect(state.activeSkillIdsJson).toBe('["a"]');
    expect(state.skillStateJson).toBe('{}');
    expect(state.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });

  it('import rejects invalid format, version and oversized payloads', async () => {
    await expect(host.invoke('chat_v2_import_session', { snapshotJson: '{bad' }))
      .rejects.toContain('Invalid snapshot JSON:');
    await expect(host.invoke('chat_v2_import_session', {
      snapshotJson: JSON.stringify({ format: 'other', version: 1, session: {} }),
    })).rejects.toContain('Unknown snapshot format: other');
    await expect(host.invoke('chat_v2_import_session', {
      snapshotJson: JSON.stringify({ format: 'deepstudent-conversation-snapshot', version: 2, session: {} }),
    })).rejects.toContain('Unsupported snapshot version: 2');
    await expect(host.invoke('chat_v2_import_session', { snapshotJson: 'x'.repeat(50 * 1024 * 1024 + 1) }))
      .rejects.toContain('Snapshot exceeds maximum size');
  });

  it('test_remap_ids_in_value_remaps_only_exact_string_matches', () => {
    const idMap = new Map<string, string>([['msg_old_111', 'msg_new_111'], ['blk_old_222', 'blk_new_222']]);
    const toolOutput = {
      originating_block_id: 'blk_old_222', msg: 'msg_old_111',
      nested: {
        ref_msg: 'msg_old_111',
        url: 'https://example.com/path?id=msg_old_111',
        list: ['blk_old_222', 'unrelated_id_zzz', { deep_block: 'blk_old_222' }],
      },
      unmapped_id: 'blk_other_999',
    };
    remapIdsInValue(toolOutput, idMap);
    expect(toolOutput.originating_block_id).toBe('blk_new_222');
    expect(toolOutput.msg).toBe('msg_new_111');
    expect(toolOutput.nested.ref_msg).toBe('msg_new_111');
    expect(toolOutput.nested.url).toContain('msg_old_111');
    const list = toolOutput.nested.list;
    expect(list[0]).toBe('blk_new_222');
    expect((list[2] as Record<string, unknown>).deep_block).toBe('blk_new_222');
    expect(toolOutput.unmapped_id).toBe('blk_other_999');
  });
});
