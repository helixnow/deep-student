import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';
import type { ChatSessionService } from '../api.ts';

describe('repo.rs bounded history window with replay', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let service: ChatSessionService;
  beforeEach(async () => {
    f = databaseFixture(); host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    service = host.ctx.chatSession; service.createSession(newSession('sess_window', 'chat'));
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });
  it('test_history_window_batch_preserves_key_order_metadata_and_replay', () => {
    const expected: string[] = [];
    for (let index = 0; index < 405; index++) {
      const id = `msg_batch_${String(405 - index).padStart(4, '0')}`;
      service.createMessage({ id, sessionId: 'sess_window', role: 'assistant', timestamp: 1000, blockIds: [], _meta: { modelId: `model_${index}` } });
      expected.push(id);
      if (index === 0 || index === 404) for (const position of [2, 0]) {
        const block = { id: `blk_batch_${index}_${position}`, messageId: id, type: 'content', status: 'pending',
          blockIndex: position, content: `payload ${index}/${position}` };
        service.createBlock(block);
        if (position === 2) service.updateBlockReplayWithConn(f.db, block.id, {
          llmContent: `wrapped ${index}`, toolCallId: `call_${index}`, roundText: 'before tool',
        });
      }
    }
    const ids = service.getSessionMessageIdsWithConn(f.db, 'sess_window');
    expect(ids).toEqual(expected);
    const messages = service.getMessagesByIdsWithConn(f.db, 'sess_window', ids);
    expect(messages.map(message => message.id)).toEqual(ids);
    expect(messages[404]?._meta?.modelId).toBe('model_404');
    const [blocks, replay] = service.getHistoryBlocksWithReplayWithConn(f.db, ids);
    for (const index of [0, 404]) {
      expect(blocks.get(ids[index]!)!.map(block => block.blockIndex)).toEqual([0, 2]);
      for (const [blockId, value] of service.getBlockReplayMapWithConn(f.db, ids[index]!)) expect(replay.get(blockId)).toEqual(value);
    }
    expect(replay.size).toBe(2);
    const selected = [ids[404]!, ids[0]!];
    expect(service.getMessagesByIdsWithConn(f.db, 'sess_window', selected).map(message => message.id)).toEqual(selected);
    expect(service.getMessagesByIdsWithConn(f.db, 'another_session', selected)).toEqual([]);
  });
  it('test_history_batch_without_replay_columns_keeps_blocks', () => {
    for (const name of ['llm_content', 'tool_call_id', 'round_text']) f.db.exec(`ALTER TABLE chat_v2_blocks DROP COLUMN ${name}`);
    service.createMessage({ id: 'msg_old', sessionId: 'sess_window', role: 'user', timestamp: 1, blockIds: [] });
    service.createBlock({ id: 'blk_old', messageId: 'msg_old', type: 'content', status: 'pending', content: 'legacy body' });
    const [blocks, replay] = service.getHistoryBlocksWithReplayWithConn(f.db, ['msg_old']);
    expect(blocks.get('msg_old')?.[0]?.content).toBe('legacy body'); expect(replay.size).toBe(0);
    const [emptyBlocks, emptyReplay] = service.getHistoryBlocksWithReplayWithConn(f.db, []);
    expect(emptyBlocks.size).toBe(0); expect(emptyReplay.size).toBe(0);
  });
  it('malformed sidecar retains the valid block while malformed display data warns and is skipped', () => {
    service.createMessage({ id: 'msg_rows', sessionId: 'sess_window', role: 'assistant', timestamp: 1, blockIds: [] });
    for (const id of ['blk_sidecar', 'blk_display']) service.createBlock({ id, messageId: 'msg_rows', type: 'content', status: 'success', content: 'body' });
    f.db.exec("UPDATE chat_v2_blocks SET llm_content = X'00' WHERE id = 'blk_sidecar'; UPDATE chat_v2_blocks SET content = X'00' WHERE id = 'blk_display'");
    const logs: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export(message) { if (message.type === 'warn') logs.push(String(message.args[0])); } });
    const [blocks, replay] = service.getHistoryBlocksWithReplayWithConn(f.db, ['msg_rows']);
    expect(blocks.get('msg_rows')?.map(block => block.id)).toEqual(['blk_sidecar']);
    expect(replay.size).toBe(0);
    expect(logs).toEqual(['[ChatV2Repo] Skipping malformed history block: Invalid column type Blob at index: 5, name: content']);
  });
});
