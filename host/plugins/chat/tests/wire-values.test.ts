import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import type { ChatSessionService, LoadSessionResponse } from '../api.ts';

describe('types.rs wire values through production persistence and IPC', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let s: ChatSessionService;
  beforeAll(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    s = host.ctx.chatSession; s.createSession(newSession('sess_wire', 'analysis'));
  });
  afterAll(async () => { await host.dispose(); f.dispose(); });
  it('message_meta_inbound_origin_uses_camel_case_key_and_is_optional', () => {
    const message = s.newAssistantMessage('sess_wire'); message._meta = {}; s.createMessage(message);
    expect(s.getMessage(message.id)?._meta).not.toHaveProperty('inboundOrigin');
    const origin = { kind: 'super_inbox', items: [{ type: 'worker.completed' }] };
    s.updateMessage({ ...message, _meta: { inboundOrigin: origin } });
    expect(s.getMessage(message.id)?._meta?.inboundOrigin).toEqual(origin);
    s.updateMessage({ ...message, _meta: { modelId: 'm' } });
    expect(s.getMessage(message.id)?._meta?.inboundOrigin).toBeUndefined();
  });
  it('test_panel_states_accepts_v0944_shape_missing_skill', async () => {
    await host.invoke('chat_v2_save_session', { sessionId: 'sess_wire', sessionState: {
      sessionId: 'sess_wire', updatedAt: '2026-01-01T00:00:00Z',
      panelStates: { rag: true, mcp: false, search: true, learn: false, model: true, advanced: false, attachment: true },
    } });
    const panels = s.loadSessionState('sess_wire')!.panelStates!;
    expect(panels.model).toBe(true); expect(panels.attachment).toBe(true); expect(panels.skill).toBeUndefined();
  });
  it('test_panel_states_round_trips_current_skill_panel', async () => {
    await host.invoke('chat_v2_save_session', { sessionId: 'sess_wire', sessionState: {
      sessionId: 'sess_wire', updatedAt: '2026-01-01T00:00:00Z', panelStates: { mcp: false, model: false, advanced: false, attachment: false, skill: true },
    } });
    const panels = s.loadSessionState('sess_wire')!.panelStates!;
    expect(panels.skill).toBe(true); expect(JSON.parse(JSON.stringify(panels)).skill).toBe(true);
  });
  it('test_message_block_serialization', () => {
    const message = s.newAssistantMessage('sess_wire'); s.createMessage(message);
    const block = { ...s.newMessageBlock(message.id, 'content', 0), status: 'running', content: 'Hello', startedAt: 1234567890 };
    s.createBlock(block); const json = JSON.stringify(s.getBlock(block.id));
    expect(json).toContain('"type":"content"'); expect(json).toContain('"messageId"');
    expect(json).not.toContain('blockIndex'); expect(json).toContain('"startedAt"'); expect(json).not.toContain('"toolName"');
  });
  it('test_chat_message_serialization', () => {
    const message = s.newAssistantMessage('sess_wire'); message.blockIds = ['blk_1', 'blk_2']; message._meta = { modelId: 'gpt-4' };
    s.createMessage(message); const json = JSON.stringify(s.getMessage(message.id));
    expect(json).toContain('"sessionId"'); expect(json).toContain('"blockIds"'); expect(json).toContain('"role":"assistant"');
    expect(json).not.toContain('"parentId"'); expect(json).toContain('"_meta"');
  });
  it('test_chat_session_serialization', () => {
    const json = JSON.stringify(s.getSession('sess_wire'));
    expect(json).toContain('"persistStatus"'); expect(json).toContain('"createdAt"'); expect(json).toContain('"persistStatus":"active"');
  });
  it('test_citation_serialization', () => {
    const message = s.newAssistantMessage('sess_wire'); s.createMessage(message);
    const block = s.newMessageBlock(message.id, 'rag', 0); block.citations = [{ type: 'rag', title: 'Test Document', url: 'https://example.com', snippet: 'Test snippet...', score: 0.95 }];
    s.createBlock(block); expect(JSON.stringify(s.getBlock(block.id)?.citations?.[0])).toContain('"type":"rag"');
  });
  it('test_persist_status_serialization', () => {
    for (const status of ['active', 'archived', 'deleted'] as const) {
      const id = `sess_enum_${status}`; s.createSession({ ...newSession(id, 'chat'), persistStatus: status });
      expect(JSON.stringify(s.getSession(id)?.persistStatus)).toBe(`"${status}"`);
    }
  });
  it('test_message_role_serialization', () => {
    for (const message of [s.newUserMessage('sess_wire', []), s.newAssistantMessage('sess_wire')]) {
      s.createMessage(message); expect(JSON.stringify(s.getMessage(message.id)?.role)).toBe(`"${message.role}"`);
    }
  });
  it('test_load_session_response_serialization', async () => {
    const loaded = await host.invoke<LoadSessionResponse>('chat_v2_load_session', { sessionId: 'sess_wire' });
    const json = JSON.stringify(loaded); expect(json).toContain('"session"'); expect(json).toContain('"messages"'); expect(json).toContain('"blocks"');
  });
});
