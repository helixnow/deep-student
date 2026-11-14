import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { artifactRoot, tempRoot } from '../../agent-workspace/api.ts';
import { createGroupWithConn } from '../api.ts';
import { newSession } from '../src/types.ts';

describe('C04-02/C04-06 command lifecycle and Rust logs', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  const records: Array<{ level: string; message: string }> = [];
  beforeEach(async () => {
    f = databaseFixture(); records.length = 0;
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) {
      records.push({ level: message.type, message: String(message.args[0]) });
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('C04-02 create initializes both real L05 roots after saving the session', async () => {
    const session = await host.invoke<{ id: string }>('chat_v2_create_session', { mode: 'chat', title: 'title' });
    expect(host.ctx.chatSession.getSession(session.id)).not.toBeNull();
    expect(existsSync(artifactRoot(host.app.dataDir, session.id, false).path)).toBe(true);
    expect(existsSync(tempRoot(host.app.dataDir, session.id, false).path)).toBe(true);
    expect(records).toContainEqual({ level: 'info', message: '[ChatV2::handlers] chat_v2_create_session: mode=chat, title=Some("title")' });
    expect(records.at(-1)).toEqual({ level: 'info', message: `[ChatV2::handlers] Created session: id=${session.id}, mode=chat` });
  });

  it('C04-02 root initialization failure warns but preserves the committed session', async () => {
    writeFileSync(join(host.app.dataDir, 'chat_v2_artifacts'), 'not a directory');
    const session = await host.invoke<{ id: string }>('chat_v2_create_session', { mode: 'chat' });
    expect(host.ctx.chatSession.getSession(session.id)).not.toBeNull();
    const warning = records.findIndex(record => record.level === 'warn' && record.message.startsWith(`[ChatV2::handlers] Failed to initialize runtime roots for ${session.id}: `));
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(records.at(-1)).toEqual({ level: 'info', message: `[ChatV2::handlers] Created session: id=${session.id}, mode=chat` });
    expect(warning).toBeLessThan(records.length - 1);
  });

  it('C04-06 missing and inactive groups retain the original warnings before rejecting', async () => {
    await expect(host.invoke('chat_v2_create_session', { mode: 'chat', groupId: 'missing' })).rejects.toContain('GROUP_NOT_FOUND');
    expect(records).toContainEqual({ level: 'warn', message: '[ChatV2::handlers] Ignoring non-existent group_id: missing' });
    createGroupWithConn(f.db, { id: 'inactive', name: 'old', defaultSkillIds: [], pinnedResourceIds: [], sortOrder: 0,
      persistStatus: 'archived', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    await expect(host.invoke('chat_v2_create_session', { mode: 'chat', groupId: 'inactive' })).rejects.toContain('inactive (inactive)');
    expect(records).toContainEqual({ level: 'warn', message: '[ChatV2::handlers] Ignoring deleted/archived group_id: inactive' });
    expect(f.db.pluck('SELECT count(*) FROM chat_v2_sessions')).toBe(0);
  });

  it('C04-06 cancel and authority logs preserve validation and success ordering', async () => {
    host.ctx.chatSession.createSession(newSession('sess_logs', 'chat'));
    host.ctx.chatState.registerStream('sess_logs');
    await host.invoke('chat_v2_cancel_stream', { sessionId: 'sess_logs', messageId: 'msg_logs' });
    expect(records.filter(r => r.message.includes('[ChatV2::handlers]'))).toEqual([
      { level: 'info', message: '[ChatV2::handlers] chat_v2_cancel_stream: session_id=sess_logs, message_id=msg_logs' },
      { level: 'info', message: '[ChatV2::handlers] Stream cancellation requested: session=sess_logs, message=msg_logs' },
    ]);
    records.length = 0;
    await expect(host.invoke('chat_v2_set_authority_mode', { sessionId: 'sess_logs', mode: 'invalid' })).rejects.toContain('Invalid authority mode');
    expect(records).toEqual([]);
    await host.invoke('chat_v2_set_authority_mode', { sessionId: 'sess_logs', mode: 'ask' });
    expect(records).toContainEqual({ level: 'info', message: '[ChatV2::handlers] chat_v2_set_authority_mode: session=sess_logs, mode=ask' });
  });

  it('C04-06 variant switch/cancel/delete retain log levels and the event-before-delete-log order', async () => {
    host.ctx.chatSession.createSession(newSession('sess_logs', 'chat'));
    host.ctx.chatSession.createMessage({ id: 'msg_logs', sessionId: 'sess_logs', role: 'assistant', blockIds: [], timestamp: 0,
      activeVariantId: 'var_a', variants: ['var_a', 'var_b'].map(id => ({ id, modelId: 'model', blockIds: [], status: 'success', createdAt: 0 })) });
    await host.invoke('chat_v2_switch_variant', { sessionId: 'sess_logs', messageId: 'msg_logs', variantId: 'var_b' });
    expect(records).toContainEqual({ level: 'info', message: '[ChatV2::VariantHandler] Variant switched: message_id=msg_logs, variant_id=var_b' });
    host.ctx.chatState.registerStream('sess_logs:var_a');
    await host.invoke('chat_v2_cancel_variant', { sessionId: 'sess_logs', variantId: 'var_a' });
    await host.invoke('chat_v2_cancel_variant', { sessionId: 'sess_logs', variantId: 'var_a' });
    expect(records).toContainEqual({ level: 'info', message: '[ChatV2::VariantHandler] CancellationToken cancelled: session_id=sess_logs, variant_id=var_a' });
    expect(records).toContainEqual({ level: 'debug', message: '[ChatV2::VariantHandler] No active CancellationToken for session_id=sess_logs, variant_id=var_a' });
    host.ctx.backendEvents.listen('chat_v2_session_sess_logs', () => records.push({ level: 'event', message: 'variant_deleted' }));
    await host.invoke('chat_v2_delete_variant', { sessionId: 'sess_logs', messageId: 'msg_logs', variantId: 'var_a' });
    const eventIndex = records.findIndex(record => record.level === 'event');
    const infoIndex = records.findIndex(record => record.message === '[ChatV2::VariantHandler] Variant deleted: message_id=msg_logs, variant_id=var_a, remaining=1');
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(infoIndex).toBeGreaterThan(eventIndex);
  });
});
