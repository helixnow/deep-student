import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { vfsStub } from './database-fixture.ts';
import { generateBlockId, generateMessageId } from '../api.ts';

describe('types.rs runtime message/block values', () => {
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => { host = await createTestHost({ plugins: [plugin], provide: { storage: {}, vfs: vfsStub } }); });
  afterEach(async () => { await host.dispose(); });
  it('test_block_id_generation', () => {
    const a = generateBlockId(); const b = generateBlockId();
    expect(a.startsWith('blk_')).toBe(true); expect(b.startsWith('blk_')).toBe(true); expect(a).not.toBe(b);
  });
  it('test_message_id_generation', () => {
    const a = generateMessageId(); const b = generateMessageId();
    expect(a.startsWith('msg_')).toBe(true); expect(a).not.toBe(b);
  });
  it('test_message_block_state_transitions', () => {
    const service = host.ctx.chatSession;
    const block = service.newMessageBlock('msg_123', 'content', 0);
    expect(block.status).toBe('pending'); expect(block.startedAt).toBeUndefined(); expect(block.endedAt).toBeUndefined();
    service.setBlockRunning(block);
    expect(block.status).toBe('running'); expect(block.startedAt).toBeDefined(); expect(block.endedAt).toBeUndefined();
    service.setBlockSuccess(block);
    expect(block.status).toBe('success'); expect(block.endedAt).toBeDefined();
  });
  it('test_message_block_error_state', () => {
    const service = host.ctx.chatSession;
    const block = service.newMessageBlock('msg_123', 'content', 0);
    service.setBlockRunning(block); service.setBlockError(block, 'Test error message');
    expect(block.status).toBe('error'); expect(block.error).toBe('Test error message'); expect(block.endedAt).toBeDefined();
  });
  it('test_message_block_content_append', () => {
    const service = host.ctx.chatSession;
    const block = service.newMessageBlock('msg_123', 'content', 0);
    service.appendBlockContent(block, 'Hello'); expect(block.content).toBe('Hello');
    service.appendBlockContent(block, ' World'); expect(block.content).toBe('Hello World');
  });
  it('append preserves first nonempty chunk time and an empty append creates an empty content value', () => {
    const service = host.ctx.chatSession;
    const block = service.newMessageBlock('msg_123', 'thinking', 7);
    service.appendBlockContent(block, ''); expect(block.content).toBe(''); expect(block.firstChunkAt).toBeUndefined();
    service.appendBlockContent(block, ' '); expect(block.firstChunkAt).toBeDefined();
    const first = block.firstChunkAt;
    service.appendBlockContent(block, 'later'); expect(block.firstChunkAt).toBe(first); expect(block.blockIndex).toBe(7);
  });
  it('new user and assistant messages retain role-specific block ids and omit absent fields', () => {
    const user = host.ctx.chatSession.newUserMessage('sess_1', ['blk_1']);
    const assistant = host.ctx.chatSession.newAssistantMessage('sess_1');
    expect(user).toMatchObject({ sessionId: 'sess_1', role: 'user', blockIds: ['blk_1'], timestamp: expect.any(Number) });
    expect(assistant).toMatchObject({ sessionId: 'sess_1', role: 'assistant', blockIds: [], timestamp: expect.any(Number) });
    for (const message of [user, assistant]) {
      expect(message.id).toMatch(/^msg_[0-9a-f-]{36}$/);
      expect(message).not.toHaveProperty('variants'); expect(message).not.toHaveProperty('_meta');
      expect(message).not.toHaveProperty('attachments'); expect(message).not.toHaveProperty('persistentStableId');
    }
  });
});
