import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, MessageBlock } from '../api.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import * as sessions from '../repository/sessions.ts';
import * as messages from '../repository/messages.ts';
import * as blocks from '../repository/blocks.ts';
import { loadSessionFull } from '../repository/load-session.ts';
import { loadSessionState, saveSessionState } from '../repository/session-state.ts';
import { newSession } from '../src/types.ts';

function newMessage(sessionId: string, id: string, role: ChatMessage['role'] = 'assistant', timestamp = 1_000): ChatMessage {
  return { id, sessionId, role, blockIds: [], timestamp };
}

function newBlock(messageId: string, id: string, index: number, content: string | null = null): blocks.StoredBlock {
  return {
    id, messageId, type: 'content', status: content === null ? 'pending' : 'success',
    blockIndex: index, ...(content === null ? {} : { content }),
  };
}

describe('chat_v2/repo.rs messages and blocks', () => {
  let f: ReturnType<typeof databaseFixture>;
  beforeEach(() => { f = databaseFixture(); });
  afterEach(() => f.dispose());

  it('test_message_crud', () => {
    sessions.createSession(f.db, newSession('sess_msg_test', 'analysis'));
    const message = newMessage('sess_msg_test', 'msg_123', 'user');
    message.blockIds = ['blk_1'];
    messages.createMessage(f.db, message);

    const loaded = messages.getMessage(f.db, 'msg_123')!;
    expect(loaded.role).toBe('user');
    expect(loaded.blockIds).toEqual(['blk_1']);
    expect(messages.getSessionMessages(f.db, 'sess_msg_test')).toHaveLength(1);

    messages.deleteMessage(f.db, 'msg_123');
    expect(messages.getMessage(f.db, 'msg_123')).toBeNull();
  });

  it('test_block_crud', () => {
    sessions.createSession(f.db, newSession('sess_blk_test', 'analysis'));
    messages.createMessage(f.db, newMessage('sess_blk_test', 'msg_blk'));

    const block = newBlock('msg_blk', 'blk_123', 0);
    blocks.createBlock(f.db, block);
    const loaded = blocks.getBlock(f.db, 'blk_123')!;
    expect(loaded.type).toBe('content');
    expect(loaded.status).toBe('pending');

    blocks.updateBlock(f.db, { ...loaded, content: 'Hello, world!', status: 'success' });
    const reloaded = blocks.getBlock(f.db, 'blk_123')!;
    expect(reloaded.content).toBe('Hello, world!');
    expect(reloaded.status).toBe('success');
    expect(blocks.getMessageBlocks(f.db, 'msg_blk')).toHaveLength(1);

    blocks.deleteBlock(f.db, 'blk_123');
    expect(blocks.getBlock(f.db, 'blk_123')).toBeNull();
  });

  it('test_create_blocks_batch_atomic', () => {
    sessions.createSession(f.db, newSession('sess_batch_blocks', 'chat'));
    messages.createMessage(f.db, newMessage('sess_batch_blocks', 'msg_batch_blocks'));

    const batch = [0, 1, 2].map(index => newBlock('msg_batch_blocks', `blk_batch_${index}`, index, `batch content ${index}`));
    blocks.createBlocksBatch(f.db, batch);
    expect(blocks.getMessageBlocks(f.db, 'msg_batch_blocks')).toHaveLength(3);

    const updated = batch.map((block, index) => index === 1 ? { ...block, content: 'batch content 1 updated' } : block);
    blocks.createBlocksBatch(f.db, updated);
    const loaded = blocks.getMessageBlocks(f.db, 'msg_batch_blocks');
    expect(loaded).toHaveLength(3);
    expect(loaded[1]!.content).toBe('batch content 1 updated');

    const badBatch = [
      newBlock('msg_batch_blocks', 'blk_batch_good', 10, 'good'),
      newBlock('msg_not_exists', 'blk_batch_bad', 0, 'bad'),
    ];
    expect(() => blocks.createBlocksBatch(f.db, badBatch)).toThrow();
    expect(blocks.getBlock(f.db, 'blk_batch_good')).toBeNull();

    blocks.createBlocksBatch(f.db, []);
  });

  it('test_block_index_correct', () => {
    sessions.createSession(f.db, newSession('sess_index_test', 'general_chat'));
    messages.createMessage(f.db, newMessage('sess_index_test', 'msg_index'));

    for (let index = 0; index < 5; index += 1) {
      blocks.createBlock(f.db, newBlock('msg_index', `blk_idx_${index}`, index, `块 ${index} 内容`));
    }
    const loaded = blocks.getMessageBlocks(f.db, 'msg_index');
    loaded.forEach((block, index) => {
      expect(block.blockIndex).toBe(index);
      expect(block.id).toBe(`blk_idx_${index}`);
    });
  });

  it('test_load_session_messages_page_with_role_filter', () => {
    sessions.createSession(f.db, newSession('sess_message_page', 'chat'));
    for (let index = 0; index < 5; index += 1) {
      const message = newMessage('sess_message_page', `msg_page_${index}`, index % 2 === 0 ? 'user' : 'assistant', 1_000 + index);
      message.blockIds = [`blk_page_${index}`];
      messages.createMessage(f.db, message);
      blocks.createBlock(f.db, newBlock(message.id, `blk_page_${index}`, 0, `message ${index}`));
    }

    const page = messages.loadSessionMessagesWindow(f.db, 'sess_message_page', 2, 2, null);
    expect(page.messages.map(message => message.id)).toEqual(['msg_page_2', 'msg_page_3']);
    expect(page.blocks.map(block => block.id)).toEqual(['blk_page_2', 'blk_page_3']);

    const users = messages.loadSessionMessagesWindow(f.db, 'sess_message_page', 1 * 1, 1, 'user');
    expect(users.total).toBe(3);
    expect(users.messages[0]!.id).toBe('msg_page_2');
    expect(users.blocks[0]!.id).toBe('blk_page_2');

    const empty = messages.loadSessionMessagesWindow(f.db, 'sess_message_page', 98 * 20, 20, null);
    expect(empty.total).toBe(5);
    expect(empty.messages).toHaveLength(0);
    expect(empty.blocks).toHaveLength(0);
  });

  it('test_load_session_full', () => {
    sessions.createSession(f.db, newSession('sess_full_test', 'analysis'));
    messages.createMessage(f.db, newMessage('sess_full_test', 'msg_full_1', 'user'));
    messages.createMessage(f.db, newMessage('sess_full_test', 'msg_full_2', 'assistant'));
    blocks.createBlock(f.db, newBlock('msg_full_2', 'blk_full_1', 0));
    blocks.createBlock(f.db, newBlock('msg_full_2', 'blk_full_2', 1));

    saveSessionState(f.db, 'sess_full_test', {
      sessionId: 'sess_full_test', features: { rag: true }, inputValue: 'draft input',
      updatedAt: '2026-11-03T00:00:00+00:00',
    });

    const full = loadSessionFull(f.db, 'sess_full_test');
    expect(full.session.id).toBe('sess_full_test');
    expect(full.messages).toHaveLength(2);
    expect(full.blocks).toHaveLength(2);
    expect(full.blocks[0]).not.toHaveProperty('blockIndex');
    expect(full.state).toBeDefined();
    expect(full.state!.inputValue).toBe('draft input');
    expect(full.state!.features!.rag).toBe(true);
  });

  it('test_session_state_upsert', () => {
    sessions.createSession(f.db, newSession('sess_state_test', 'analysis'));

    saveSessionState(f.db, 'sess_state_test', {
      sessionId: 'sess_state_test', inputValue: 'first draft', updatedAt: '2026-11-03T00:00:00+00:00',
    });
    expect(loadSessionState(f.db, 'sess_state_test')!.inputValue).toBe('first draft');

    saveSessionState(f.db, 'sess_state_test', {
      sessionId: 'sess_state_test', inputValue: 'second draft', updatedAt: '2026-11-03T00:01:00+00:00',
    });
    expect(loadSessionState(f.db, 'sess_state_test')!.inputValue).toBe('second draft');
    expect(f.db.pluck<number>('SELECT COUNT(*) FROM chat_v2_session_state WHERE session_id = ?1', ['sess_state_test'])).toBe(1);
  });
});
