/**
 * [L20-engine port] `sync_realistic_scenarios.rs` S.16-S.35.
 *
 * Chat-v2 and mistakes scenarios. Setup, sync direction and assertions are
 * preserved from the Rust file; the only adaptations are the shared harness
 * (production engine instead of the inline `apply_changes_to_db`) and, where
 * noted, a bumped `updated_at` so the production LWW path observes the later
 * writer the same way the Rust fixture's unconditional INSERT OR REPLACE did.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  CHAT_V2_TABLES,
  MISTAKES_TABLES,
  VFS_TABLES,
  RealisticSyncHarness,
  clearBusinessTables,
  column,
  rowCount,
  scalarNumber,
  type RealisticDevice,
} from './realistic_sync_harness.ts';

const h = new RealisticSyncHarness();
let a: RealisticDevice;
let b: RealisticDevice;

function chatDb(device: RealisticDevice): DatabaseHandle { return h.db(device, 'chat_v2'); }
function mistakesDb(device: RealisticDevice): DatabaseHandle { return h.db(device, 'mistakes'); }

function chatSession(db: DatabaseHandle, id: string, mode: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at)
     VALUES (?1,?2,?3,'active',?4,?4)`,
    [id, mode, title, ts],
  );
}

function chatMessage(
  db: DatabaseHandle, id: string, sessionId: string, role: string, timestamp: number,
): void {
  db.run(
    `INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
     VALUES (?1,?2,?3,'[]',?4)`,
    [id, sessionId, role, timestamp],
  );
}

function chatBlock(db: DatabaseHandle, id: string, messageId: string, blockType: string): void {
  db.run(
    `INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index)
     VALUES (?1,?2,?3,'success',0)`,
    [id, messageId, blockType],
  );
}

function chatAttachment(
  db: DatabaseHandle, id: string, messageId: string, name: string,
  mimeType: string, size: number,
): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO chat_v2_attachments (id, message_id, name, type, mime_type, size, status, created_at)
     VALUES (?1,?2,?3,'image',?4,?5,'ready',?6)`,
    [id, messageId, name, mimeType, size, ts],
  );
}

function sessionGroup(db: DatabaseHandle, id: string, name: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO chat_v2_session_groups (id, name, persist_status, created_at, updated_at)
     VALUES (?1,?2,'active',?3,?3)`,
    [id, name, ts],
  );
}

function workspaceIndex(
  db: DatabaseHandle, workspaceId: string, name: string, creatorSessionId: string,
): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO workspace_index (workspace_id, name, status, creator_session_id, created_at, updated_at)
     VALUES (?1,?2,'active',?3,?4,?4)`,
    [workspaceId, name, creatorSessionId, ts],
  );
}

function mistake(db: DatabaseHandle, id: string, userQuestion: string, tags: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO mistakes (id, question_images, analysis_images, user_question, ocr_text, tags,
       mistake_type, status, created_at, updated_at, last_accessed_at)
     VALUES (?1,'[]','[]',?2,'',?3,'math','active',?4,?4,'1970-01-01T00:00:00Z')`,
    [id, userQuestion, tags, ts],
  );
}

function mistakeChatMessage(db: DatabaseHandle, mistakeId: string, role: string, content: string): void {
  db.run(
    'INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES (?1,?2,?3,?4)',
    [mistakeId, role, content, h.nextIso()],
  );
}

function reviewAnalysis(db: DatabaseHandle, id: string, name: string, mistakeIds: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO review_analyses (id, name, mistake_ids, consolidated_input, user_question,
       status, tags, created_at, updated_at)
     VALUES (?1,?2,?3,'','','active','[]',?4,?4)`,
    [id, name, mistakeIds, ts],
  );
}

function reviewSession(
  db: DatabaseHandle, id: string, title: string, startDate: string, endDate: string,
): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO review_sessions (id, title, start_date, end_date, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?5)`,
    [id, title, startDate, endDate, ts],
  );
}

function documentTask(db: DatabaseHandle, id: string, documentId: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO document_tasks (id, document_id, original_document_name, segment_index,
       content_segment, status, anki_generation_options_json, created_at, updated_at)
     VALUES (?1,?2,'notes.pdf',0,'X','Completed','{}',?3,?3)`,
    [id, documentId, ts],
  );
}

function ankiCard(
  db: DatabaseHandle, id: string, taskId: string, front: string, back: string, tagsJson: string,
): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO anki_cards (id, task_id, front, back, tags_json, source_type, source_id,
       created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,'note','',?6,?6)`,
    [id, taskId, front, back, tagsJson, ts],
  );
}

function customTemplate(db: DatabaseHandle, id: string, name: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO custom_anki_templates (id, name, preview_front, preview_back, fields_json,
       generation_prompt, front_template, back_template, css_style, created_at, updated_at)
     VALUES (?1,?2,?3,?3,'[]','','','','',?4,?4)`,
    [id, name, name, ts],
  );
}

beforeAll(async () => {
  await h.init();
  a = await h.device('A');
  b = await h.device('B');
}, 180_000);

beforeEach(() => {
  for (const device of [a, b]) {
    clearBusinessTables(h.db(device, 'vfs'), VFS_TABLES);
    clearBusinessTables(h.db(device, 'chat_v2'), CHAT_V2_TABLES);
    clearBusinessTables(h.db(device, 'mistakes'), MISTAKES_TABLES);
  }
});

afterAll(async () => { await h.dispose(); });

describe('sync realistic scenarios S.16-S.25: chat v2', () => {
  it('s16_create_session_with_messages_and_blocks_full_sync', () => {
    const da = chatDb(a);
    const db = chatDb(b);
    chatSession(da, 'sess_016', 'analysis', 'Analysis');
    chatMessage(da, 'msg_016_1', 'sess_016', 'user', 1000);
    chatMessage(da, 'msg_016_2', 'sess_016', 'assistant', 2000);
    chatBlock(da, 'blk_016', 'msg_016_2', 'content');
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(rowCount(db, 'chat_v2_sessions')).toBe(1);
    expect(rowCount(db, 'chat_v2_messages')).toBe(2);
    expect(rowCount(db, 'chat_v2_blocks')).toBe(1);
  });

  it('s17_update_message_content_streaming_block_sync', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_017', 'general_chat', 'Chat');
    chatMessage(da, 'msg_017', 'sess_017', 'user', 1000);
    chatBlock(da, 'blk_017', 'msg_017', 'content');
    da.run("UPDATE chat_v2_blocks SET content = 'Updated stream' WHERE id = 'blk_017'");
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'chat_v2_blocks', 'blk_017', 'content')).toBe('Updated stream');
  });

  it('s18_add_attachment_to_message_sync', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_018', 'general_chat', 'Att');
    chatMessage(da, 'msg_018', 'sess_018', 'user', 1000);
    chatAttachment(da, 'att_018', 'msg_018', 'photo.png', 'image/png', 102400);
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'chat_v2_attachments', 'att_018', 'name')).toBe('photo.png');
  });

  it('s19_create_session_group_sync', () => {
    sessionGroup(chatDb(a), 'group_019', 'Math Group');
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'chat_v2_session_groups', 'group_019', 'name')).toBe('Math Group');
  });

  it('s20_link_session_to_mistake_sync', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_020', 'analysis', 'MA');
    da.run(
      `INSERT INTO chat_v2_session_mistakes (session_id, mistake_id, created_at)
       VALUES ('sess_020', 'm_020', datetime('now'))`,
    );
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(scalarNumber(
      chatDb(b),
      "SELECT COUNT(*) FROM chat_v2_session_mistakes WHERE session_id='sess_020'",
    )).toBe(1);
  });

  it('s21_create_workspace_index_entry_sync', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_021', 'general_chat', 'WS');
    workspaceIndex(da, 'ws_021', 'My WS', 'sess_021');
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'workspace_index', 'ws_021', 'name', 'workspace_id')).toBe('My WS');
  });

  it('s22_create_chat_v2_resources_entry_sync', () => {
    chatDb(a).run(
      `INSERT INTO resources (id, hash, type, data, ref_count, created_at)
       VALUES ('res_022', 'h022', 'image', 'b64', 1, 1000)`,
    );
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'resources', 'res_022', 'hash')).toBe('h022');
  });

  it('s23_multi_model_variant_in_message_sync_variants_json', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_023', 'general_chat', 'Var');
    da.run(
      `INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp,
         variants_json, active_variant_id)
       VALUES ('msg_023', 'sess_023', 'assistant', '[]', 1000, '[{"variant_id":"v1"}]', 'v1')`,
    );
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'chat_v2_messages', 'msg_023', 'active_variant_id')).toBe('v1');
  });

  it('s24_session_compaction_sync_reference', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_024', 'general_chat', 'Compact');
    da.run(
      "UPDATE chat_v2_sessions SET summary_hash = 'chash_024', updated_at = ?1 WHERE id = 'sess_024'",
      [h.nextIso()],
    );
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(column(chatDb(b), 'chat_v2_sessions', 'sess_024', 'summary_hash')).toBe('chash_024');
  });

  it('s25_large_chat_history_50_messages_bulk_sync', () => {
    const da = chatDb(a);
    chatSession(da, 'sess_025', 'general_chat', 'Big');
    for (let i = 0; i < 50; i += 1) {
      chatMessage(da, `msg_${String(i).padStart(2, '0')}`, 'sess_025', i % 2 === 0 ? 'user' : 'assistant', (i + 1) * 1000);
    }
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(scalarNumber(
      chatDb(b),
      "SELECT COUNT(*) FROM chat_v2_messages WHERE session_id='sess_025'",
    )).toBe(50);
  });
});

describe('sync realistic scenarios S.26-S.35: mistakes and anki', () => {
  it('s26_create_mistake_with_analysis_images_sync', () => {
    mistake(mistakesDb(a), 'mistake_026', 'Solve x^2=4', '["math"]');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(column(mistakesDb(b), 'mistakes', 'mistake_026', 'user_question')).toBe('Solve x^2=4');
  });

  it('s27_add_chat_messages_to_mistake_sync_conversation', () => {
    const da = mistakesDb(a);
    mistake(da, 'mistake_027', 'pi?', '["math"]');
    mistakeChatMessage(da, 'mistake_027', 'user', 'Explain pi');
    mistakeChatMessage(da, 'mistake_027', 'assistant', 'Pi is 3.14...');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      mistakesDb(b),
      "SELECT COUNT(*) FROM chat_messages WHERE mistake_id='mistake_027'",
    )).toBeGreaterThanOrEqual(2);
  });

  it('s28_create_review_analysis_sync_with_mistake_ids', () => {
    const da = mistakesDb(a);
    mistake(da, 'mistake_028', 'Integral sin(x)', '["calc"]');
    reviewAnalysis(da, 'ra_028', 'Review', '["mistake_028"]');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(column(mistakesDb(b), 'review_analyses', 'ra_028', 'mistake_ids')).toContain('mistake_028');
  });

  it('s29_create_review_session_with_linked_mistakes_sync', () => {
    const da = mistakesDb(a);
    mistake(da, 'mistake_029', 'd/dx e^x', '["calc"]');
    reviewSession(da, 'rs_029', 'Calc Review', '2026-05-01', '2026-05-07');
    da.run(
      `INSERT INTO review_session_mistakes (session_id, mistake_id, added_at)
       VALUES ('rs_029', 'mistake_029', datetime('now'))`,
    );
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      mistakesDb(b),
      "SELECT COUNT(*) FROM review_session_mistakes WHERE session_id='rs_029'",
    )).toBe(1);
  });

  it('s30_create_anki_card_from_document_tasks_sync', () => {
    const da = mistakesDb(a);
    documentTask(da, 'task_030', 'doc_030');
    ankiCard(da, 'ac_030', 'task_030', 'Q: 2+2?', 'A: 4', '["math"]');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(column(mistakesDb(b), 'anki_cards', 'ac_030', 'front')).toBe('Q: 2+2?');
  });

  it('s31_custom_anki_template_sync_as_backup', () => {
    const da = mistakesDb(a);
    customTemplate(da, 'cat_031', 'Basic');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      da,
      "SELECT COUNT(*) FROM __change_log WHERE table_name='custom_anki_templates'",
    )).toBe(0);
    expect(scalarNumber(
      mistakesDb(b),
      "SELECT COUNT(*) FROM custom_anki_templates WHERE id='cat_031'",
    )).toBe(0);
  });

  it('s32_update_mistake_tags_verify_tag_union', () => {
    const da = mistakesDb(a);
    mistake(da, 'mistake_032', 'What is 1+1?', '["math"]');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(column(mistakesDb(b), 'mistakes', 'mistake_032', 'tags')).toBe('["math"]');
  });

  it('s33_update_anki_card_front_back_sync', () => {
    const da = mistakesDb(a);
    documentTask(da, 'task_033', 'doc_033');
    ankiCard(da, 'ac_033', 'task_033', 'Front1', 'Back1', '["bio"]');
    h.fullSyncCycle(a, b, 'mistakes');
    expect(column(mistakesDb(b), 'anki_cards', 'ac_033', 'front')).toBe('Front1');
  });

  it('s34_concurrent_mistake_analysis_two_devices', () => {
    const da = mistakesDb(a);
    const db = mistakesDb(b);
    mistake(da, 'mistake_034', 'Integral of cos(x)', '["calc"]');
    h.fullSyncCycle(a, b, 'mistakes');
    reviewAnalysis(da, 'ra_034', 'Calc Review', '["mistake_034"]');
    reviewAnalysis(db, 'ra_b_034', 'Physics', '["mistake_034"]');
    h.applyPending(b, a, 'mistakes');
    expect(scalarNumber(
      da,
      "SELECT COUNT(*) FROM review_analyses WHERE mistake_ids LIKE '%mistake_034%'",
    )).toBeGreaterThanOrEqual(2);
  });

  it('s35_review_chat_messages_sync', () => {
    const da = mistakesDb(a);
    mistake(da, 'mistake_035', 'What is gravity?', '["physics"]');
    reviewAnalysis(da, 'ra_035', 'Gravity Review', '["mistake_035"]');
    da.run(
      `INSERT INTO review_chat_messages (review_analysis_id, role, content, timestamp)
       VALUES ('ra_035', 'user', 'Explain gravity', datetime('now'))`,
    );
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      mistakesDb(b),
      "SELECT COUNT(*) FROM review_chat_messages WHERE review_analysis_id='ra_035'",
    )).toBe(1);
  });
});
