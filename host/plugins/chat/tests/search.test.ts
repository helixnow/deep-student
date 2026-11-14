import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { createSession } from '../repository/sessions.ts';
import { searchContent } from '../repository/search.ts';
import { newSession } from '../src/types.ts';

describe('chat_v2/repo.rs content search', () => {
  let f: ReturnType<typeof databaseFixture>;
  beforeEach(() => { f = databaseFixture(); });
  afterEach(() => f.dispose());
  function text(id: string, content: string) {
    f.db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
      VALUES (?1, ?2, 'user', ?3, ?4)`, [`msg_${id}`, `sess_${id}`, JSON.stringify([`blk_${id}`]), Date.now()]);
    f.db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content)
      VALUES (?1, ?2, 'content', 'success', 0, ?3)`, [`blk_${id}`, `msg_${id}`, content]);
  }
  it('test_search_content_date_range_preserves_legacy_search', () => {
    for (const [index, updatedAt] of ['2026-07-10T12:00:00Z', '2026-07-11T18:30:00Z'].entries()) {
      createSession(f.db, { ...newSession(`sess_fts_date_${index}`, 'chat'), title: `Date ${index}`, updatedAt });
      text(`fts_date_${index}`, `needle date result ${index}`);
    }
    expect(searchContent(f.db, 'needle', 10)).toHaveLength(2);
    const filtered = searchContent(f.db, 'needle', 10, '2026-07-11T00:00:00.000Z', '2026-07-11T23:59:59.999Z');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.sessionId).toBe('sess_fts_date_1');
  });
  it('test_fts_triggers_cover_block_type_changes', () => {
    createSession(f.db, newSession('sess_fts_blocktype', 'chat'));
    text('fts_blocktype', 'blocktypeneedle indexed text');
    expect(searchContent(f.db, 'blocktypeneedle', 10)).toHaveLength(1);
    f.db.run("UPDATE chat_v2_blocks SET block_type = 'mcp_tool' WHERE id = 'blk_fts_blocktype'");
    expect(searchContent(f.db, 'blocktypeneedle', 10)).toEqual([]);
    f.db.run("UPDATE chat_v2_blocks SET block_type = 'thinking' WHERE id = 'blk_fts_blocktype'");
    expect(searchContent(f.db, 'blocktypeneedle', 10)).toHaveLength(1);
  });
});
