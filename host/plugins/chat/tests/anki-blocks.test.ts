import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { createMessage } from '../repository/messages.ts';
import { createBlock } from '../repository/blocks.ts';
import { newSession } from '../src/types.ts';
import { ChatV2Error } from '../api.ts';

describe('chat_v2 anki block lookup', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  beforeEach(async () => {
    f = databaseFixture();
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage, vfs: vfsStub } });
    createSession(f.db, newSession('sess_anki', 'chat'));
    createMessage(f.db, {
      id: 'msg_anki', sessionId: 'sess_anki', role: 'assistant', timestamp: 1, blockIds: [],
    });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  function addToolBlock(id: string, documentId: string, cards: unknown[]): void {
    createBlock(f.db, {
      id, messageId: 'msg_anki', type: 'anki_cards', status: 'success', blockIndex: 0,
      toolOutput: { documentId, cards },
    });
  }

  it('returns cards from the newest block exactly matching a trimmed documentId', async () => {
    addToolBlock('blk_old', 'doc_1', [{ front: 'old', back: 'b' }]);
    addToolBlock('blk_new', 'doc_1', [{
      front: 'new', back: 'b', tags: ['t'], images: [], extra_fields: { x: 'y' },
    }]);
    addToolBlock('blk_substring', 'doc_10', [{ front: 'other', back: 'b' }]);

    const cards = await host.invoke<Array<Record<string, unknown>>>(
      'chat_v2_get_anki_cards_from_block_by_document_id', { documentId: ' doc_1 ' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      front: 'new', back: 'b', text: null, tags: ['t'], images: [],
      task_id: '', is_error_card: false, error_content: null, extra_fields: { x: 'y' }, template_id: null,
    });
    expect(typeof cards[0]!.id).toBe('string');
    expect(typeof cards[0]!.created_at).toBe('string');
  });

  it('skips malformed tool output and malformed cards', async () => {
    createBlock(f.db, {
      id: 'blk_bad_json', messageId: 'msg_anki', type: 'anki_cards', status: 'success',
      blockIndex: 0, content: 'not json', toolOutput: { documentId: 'doc_2', cards: [] },
    });
    // Overwrite tool_output_json with invalid JSON via the block update path.
    f.db.run('UPDATE chat_v2_blocks SET tool_output_json = ?2 WHERE id = ?1', ['blk_bad_json', '{bad']);
    addToolBlock('blk_valid', 'doc_2', [
      { front: 'ok', back: 'b' },
      { front: 42 },
      { front: 'bad-tags', tags: [1] },
    ]);
    const cards = await host.invoke<Array<Record<string, unknown>>>(
      'chat_v2_get_anki_cards_from_block_by_document_id', { documentId: 'doc_2' });
    expect(cards.map(card => card.front)).toEqual(['ok']);
  });

  it('requires a non-empty documentId', async () => {
    await expect(host.invoke('chat_v2_get_anki_cards_from_block_by_document_id', { documentId: '   ' }))
      .rejects.toBe(new ChatV2Error('Validation', 'documentId is required').toCommandError());
  });
});
