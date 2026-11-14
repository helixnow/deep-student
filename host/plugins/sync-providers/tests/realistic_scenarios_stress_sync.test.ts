/**
 * [L20-engine port] `sync_realistic_scenarios.rs` S.96-S.115.
 *
 * Field-merge-shaped and stress scenarios.  The Rust file's own harness never
 * invoked `field_merge`; it only asserted survival/non-emptiness after an
 * unconditional SQL replace.  These ports keep those exact assertions while
 * sending the changes through the production engine (including its real
 * field-merge path).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { threadId } from 'node:worker_threads';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  CHAT_V2_TABLES,
  MISTAKES_TABLES,
  RealisticSyncHarness,
  VFS_TABLES,
  clearBusinessTables,
  column,
  columnMs,
  rowCount,
  scalarNumber,
  type RealisticDevice,
} from './realistic_sync_harness.ts';

const h = new RealisticSyncHarness(event => {
  console.info('[L23-S108-phase]', JSON.stringify({
    ...event,
    pid: process.pid,
    error: event.error instanceof Error ? event.error.stack : event.error,
  }));
});
let a: RealisticDevice;
let b: RealisticDevice;

/** Yield a macrotask so Vitest's worker RPC watchdog sees progress. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function vfs(device: RealisticDevice): DatabaseHandle { return h.db(device, 'vfs'); }
function chat(device: RealisticDevice): DatabaseHandle { return h.db(device, 'chat_v2'); }
function mistakes(device: RealisticDevice): DatabaseHandle { return h.db(device, 'mistakes'); }

function resource(db: DatabaseHandle, id: string, type: string, data: string, hash: string): void {
  db.run(
    `INSERT INTO resources (id, hash, type, data, ref_count, created_at, updated_at, storage_mode)
     VALUES (?1,?2,?3,?4,1,?5,?5,'inline')`,
    [id, hash, type, data, h.nextMs()],
  );
}

function note(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
     VALUES (?1,?2,?3,'[]',0,?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function examSheet(db: DatabaseHandle, id: string, examName: string, resourceId: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO exam_sheets (id, resource_id, exam_name, status, temp_id, metadata_json,
       preview_json, created_at, updated_at, is_favorite)
     VALUES (?1,?2,?3,'completed',?4,'{}','{}',?5,?5,0)`,
    [id, resourceId, examName, `tmp_${id}`, ts],
  );
}

function question(db: DatabaseHandle, id: string, examId: string, content: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO questions (id, exam_id, content, question_type, tags, status, created_at, updated_at)
     VALUES (?1,?2,?3,'choice','[]','new',?4,?4)`,
    [id, examId, content, ts],
  );
}

function reviewPlan(db: DatabaseHandle, id: string, questionId: string, examId: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO review_plans (id, question_id, exam_id, next_review_date, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,'new',?5,?5)`,
    [id, questionId, examId, ts, ts],
  );
}

function folder(db: DatabaseHandle, id: string, parentId: string | null, title: string): void {
  const ts = h.nextMs();
  db.run(
    `INSERT INTO folders (id, parent_id, title, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,0,?4,?4)`,
    [id, parentId, title, ts],
  );
}

function folderItem(
  db: DatabaseHandle, id: string, folderId: string, itemType: string, itemId: string,
): void {
  const ts = h.nextMs();
  db.run(
    `INSERT INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,?4,0,?5,?5)`,
    [id, folderId, itemType, itemId, ts],
  );
}

function todoList(db: DatabaseHandle, id: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO todo_lists (id, title, sort_order, created_at, updated_at)
     VALUES (?1,?2,0,?3,?3)`,
    [id, title, ts],
  );
}

function todoItem(db: DatabaseHandle, id: string, todoListId: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO todo_items (id, todo_list_id, title, status, priority, tags_json,
       sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,'pending','none','[]',0,?4,?4)`,
    [id, todoListId, title, ts],
  );
}

function pomodoroRecord(db: DatabaseHandle, id: string, todoItemId: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration,
       actual_duration, type, status, created_at)
     VALUES (?1,?2,?3,?3,1500,1500,'work','completed',?3)`,
    [id, todoItemId, ts],
  );
}

function essay(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO essays (id, resource_id, title, score, round_number, created_at, updated_at)
     VALUES (?1,?2,?3,90,1,?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function translation(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO translations (id, resource_id, src_lang, tgt_lang, title, created_at, updated_at)
     VALUES (?1,?2,'en','zh',?3,?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function mindmap(db: DatabaseHandle, id: string, resourceId: string, title: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO mindmaps (id, resource_id, title, settings, created_at, updated_at)
     VALUES (?1,?2,?3,'{}',?4,?4)`,
    [id, resourceId, title, ts],
  );
}

function answerSubmission(
  db: DatabaseHandle, id: string, questionId: string, answer: string, isCorrect: number,
): void {
  db.run(
    `INSERT INTO answer_submissions (id, question_id, user_answer, is_correct, grading_method, submitted_at)
     VALUES (?1,?2,?3,?4,'auto',?5)`,
    [id, questionId, answer, isCorrect, h.nextIso()],
  );
}

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
  db: DatabaseHandle, id: string, messageId: string, name: string, mimeType: string, size: number,
): void {
  db.run(
    `INSERT INTO chat_v2_attachments (id, message_id, name, type, mime_type, size, status, created_at)
     VALUES (?1,?2,?3,'image',?4,?5,'ready',?6)`,
    [id, messageId, name, mimeType, size, h.nextIso()],
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
     VALUES (?1,?2,'test.pdf',0,'S','Completed','{}',?3,?3)`,
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
  console.info('[L23-S108-worker]', JSON.stringify({
    pid: process.pid, ppid: process.ppid, threadId,
    poolId: process.env.VITEST_POOL_ID, workerId: process.env.VITEST_WORKER_ID,
    maxForks: process.env.VITEST_MAX_FORKS, maxThreads: process.env.VITEST_MAX_THREADS,
    node: process.version, execArgv: process.execArgv,
  }));
  await h.init();
  a = await h.device('A');
  b = await h.device('B');
}, 180_000);

beforeEach(() => {
  for (const device of [a, b]) {
    clearBusinessTables(vfs(device), VFS_TABLES);
    clearBusinessTables(chat(device), CHAT_V2_TABLES);
    clearBusinessTables(mistakes(device), MISTAKES_TABLES);
  }
});

afterAll(async () => { await h.dispose(); });

describe('sync realistic scenarios S.96-S.105: field merge shaped cases', () => {
  it('s96_ease_factor_field_merge_average', () => {
    resource(vfs(a), 'res_096', 'exam', 'ed', 'hash_096');
    examSheet(vfs(a), 'exam_096', 'EF Avg', 'res_096');
    question(vfs(a), 'q_096', 'exam_096', 'Q96');
    const ts = h.nextIso();
    vfs(a).run(
      `INSERT INTO review_plans (id, question_id, exam_id, ease_factor, next_review_date,
         status, created_at, updated_at)
       VALUES ('rp_096', 'q_096', 'exam_096', 2.5, ?1, 'learning', ?1, ?1)`,
      [ts],
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE review_plans SET ease_factor = 2.8, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_096']);
    vfs(b).run('UPDATE review_plans SET ease_factor = 2.2, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_096']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'review_plans', 'rp_096', 'ease_factor')).not.toBeNull();
  });

  it('s97_interval_days_field_merge_max', () => {
    resource(vfs(a), 'res_097', 'exam', 'ed', 'hash_097');
    examSheet(vfs(a), 'exam_097', 'Interval', 'res_097');
    question(vfs(a), 'q_097', 'exam_097', 'Q97');
    reviewPlan(vfs(a), 'rp_097', 'q_097', 'exam_097');
    vfs(a).run('UPDATE review_plans SET interval_days = 7, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_097']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE review_plans SET interval_days = 10, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_097']);
    vfs(b).run('UPDATE review_plans SET interval_days = 8, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_097']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'review_plans', 'rp_097', 'interval_days')).toBeGreaterThan(0);
  });

  it('s98_consecutive_failures_field_merge_max', () => {
    resource(vfs(a), 'res_098', 'exam', 'ed', 'hash_098');
    examSheet(vfs(a), 'exam_098', 'CF', 'res_098');
    question(vfs(a), 'q_098', 'exam_098', 'Q98');
    reviewPlan(vfs(a), 'rp_098', 'q_098', 'exam_098');
    vfs(a).run('UPDATE review_plans SET consecutive_failures = 3, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_098']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE review_plans SET consecutive_failures = 5, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_098']);
    vfs(b).run('UPDATE review_plans SET consecutive_failures = 4, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_098']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'review_plans', 'rp_098', 'consecutive_failures')).toBeGreaterThanOrEqual(3);
  });

  it('s99_user_note_string_concat_merge', () => {
    resource(vfs(a), 'res_099', 'exam', 'ed', 'hash_099');
    examSheet(vfs(a), 'exam_099', 'Note', 'res_099');
    question(vfs(a), 'q_099', 'exam_099', 'Q99');
    vfs(a).run("UPDATE questions SET user_note = 'Note from A', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_099']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run("UPDATE questions SET user_note = 'Note from A + more from A', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_099']);
    vfs(b).run("UPDATE questions SET user_note = 'Note from A + more from B', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_099']);
    h.applyPending(b, a, 'vfs');
    const userNote = column(vfs(a), 'questions', 'q_099', 'user_note');
    expect(userNote).not.toBeNull();
    expect(userNote).not.toBe('');
  });

  it('s100_ai_feedback_string_concat_merge', () => {
    resource(vfs(a), 'res_100', 'exam', 'ed', 'hash_100');
    examSheet(vfs(a), 'exam_100', 'AI', 'res_100');
    question(vfs(a), 'q_100', 'exam_100', 'Q100');
    vfs(a).run("UPDATE questions SET ai_feedback = 'AI: Good work', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_100']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run("UPDATE questions SET ai_feedback = 'AI: Good work + Excellent', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_100']);
    vfs(b).run("UPDATE questions SET ai_feedback = 'AI: Good work + Needs improvement', updated_at = ?1 WHERE id = ?2", [h.nextIso(), 'q_100']);
    h.applyPending(b, a, 'vfs');
    expect(column(vfs(a), 'questions', 'q_100', 'ai_feedback')).not.toBeNull();
  });

  it('s101_is_favorite_boolean_or_merge', () => {
    resource(vfs(a), 'res_101', 'note', 'fav', 'hash_101');
    note(vfs(a), 'note_101', 'res_101', 'Fav');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE notes SET is_favorite = 1, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'note_101']);
    vfs(b).run('UPDATE notes SET is_favorite = 1, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'note_101']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'notes', 'note_101', 'is_favorite')).toBe(1);
  });

  it('s102_is_bookmarked_boolean_or_merge', () => {
    resource(vfs(a), 'res_102', 'exam', 'ed', 'hash_102');
    examSheet(vfs(a), 'exam_102', 'Bookmark', 'res_102');
    question(vfs(a), 'q_102', 'exam_102', 'Q102');
    vfs(a).run('UPDATE questions SET is_bookmarked = 1, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_102']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(b).run('UPDATE questions SET is_bookmarked = 1, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_102']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'questions', 'q_102', 'is_bookmarked')).toBe(1);
  });

  it('s103_metadata_json_deep_merge', () => {
    vfs(a).run(
      `INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode)
       VALUES ('res_103', 'hash_103', 'note', '{"v":1,"a":"x"}', 1, ?1, ?1, 'inline')`,
      [h.nextMs()],
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"v":1,"a":"x","b":"y"}', h.nextMs(), 'res_103']);
    vfs(b).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"v":1,"a":"x","c":"z"}', h.nextMs(), 'res_103']);
    h.applyPending(b, a, 'vfs');
    expect(column(vfs(a), 'resources', 'res_103', 'metadata_json')).not.toBeNull();
  });

  it('s104_citations_json_deep_merge', () => {
    const da = chat(a);
    chatSession(da, 'sess_104', 'general_chat', 'Citations');
    chatMessage(da, 'msg_104', 'sess_104', 'assistant', 1000);
    chatBlock(da, 'blk_104', 'msg_104', 'content');
    da.run("UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"}]' WHERE id = 'blk_104'");
    h.fullSyncCycle(a, b, 'chat_v2');
    da.run("UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"},{\"url\":\"b.com\"}]' WHERE id = 'blk_104'");
    chat(b).run("UPDATE chat_v2_blocks SET citations_json = '[{\"url\":\"a.com\"},{\"url\":\"c.com\"}]' WHERE id = 'blk_104'");
    h.applyPending(b, a, 'chat_v2');
    expect(column(chat(a), 'chat_v2_blocks', 'blk_104', 'citations_json')).not.toBe('');
  });

  it('s105_tags_json_set_union_on_anki_cards', () => {
    const da = mistakes(a);
    documentTask(da, 'task_105', 'doc_105');
    ankiCard(da, 'ac_105', 'task_105', 'Q', 'A', '["tag1"]');
    h.fullSyncCycle(a, b, 'mistakes');
    da.run("UPDATE anki_cards SET tags_json = '[\"tag1\",\"tag2\"]', updated_at = ?1 WHERE id = 'ac_105'", [h.nextIso()]);
    mistakes(b).run("UPDATE anki_cards SET tags_json = '[\"tag1\",\"tag3\"]', updated_at = ?1 WHERE id = 'ac_105'", [h.nextIso()]);
    h.applyPending(b, a, 'mistakes');
    expect(column(mistakes(a), 'anki_cards', 'ac_105', 'tags_json')).not.toBe('');
  });
});

describe('sync realistic scenarios S.106-S.115: stress and full population', () => {
  it('s106_1000_records_bulk_create_and_sync', () => {
    for (let i = 0; i < 1000; i += 1) {
      resource(vfs(a), `rs${i}`, 'note', 'd', `h${i}`);
    }
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'resources')).toBe(1000);
  }, 120_000);

  it('s107_100_records_each_with_50_updates', async () => {
    for (let i = 0; i < 100; i += 1) {
      resource(vfs(a), `ru${i}`, 'note', 'd', `hu${i}`);
      note(vfs(a), `nu${i}`, `ru${i}`, 'base');
    }
    h.fullSyncCycle(a, b, 'vfs');
    for (let u = 0; u < 50; u += 1) {
      for (let i = 0; i < 100; i += 1) {
        vfs(a).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', [`n${i}v${u}`, h.nextIso(), `nu${i}`]);
      }
      if (u % 5 === 0) await yieldToEventLoop();
    }
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'notes', 'nu50', 'title')?.startsWith('n50v')).toBe(true);
  }, 180_000);

  it('s108_10_devices_each_creating_10_records', async () => {
    const target = await h.device('D0', 'dev_0');
    clearBusinessTables(vfs(target), VFS_TABLES);
    for (let d = 0; d < 10; d += 1) {
      const device = d === 0 ? target : await h.device(`D${d}`, `dev_${d}`);
      if (d !== 0) clearBusinessTables(vfs(device), VFS_TABLES);
      for (let i = 0; i < 10; i += 1) {
        const idx = d * 10 + i;
        resource(vfs(device), `r10_${idx}`, 'note', 'd', `h10_${idx}`);
      }
      await yieldToEventLoop();
    }
    for (let d = 0; d < 10; d += 1) {
      const device = d === 0 ? target : (await h.device(`D${d}`, `dev_${d}`));
      h.applyPending(device, target, 'vfs');
      await yieldToEventLoop();
    }
    expect(rowCount(vfs(target), 'resources')).toBe(100);
  }, 180_000);

  it('s109_rapid_successive_syncs_10_cycles', () => {
    for (let cycle = 0; cycle < 10; cycle += 1) {
      resource(vfs(a), `rc${cycle}`, 'note', 'd', `hc${cycle}`);
      h.fullSyncCycle(a, b, 'vfs');
    }
    expect(rowCount(vfs(b), 'resources')).toBe(10);
  });

  it('s110_deeply_nested_json_5_levels', () => {
    const deep = '{"l1":{"l2":{"l3":{"l4":{"l5":"deepest"}}}}}';
    vfs(a).run(
      `INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode)
       VALUES ('res_110', 'hash_110', 'note', ?1, 1, ?2, ?2, 'inline')`,
      [deep, h.nextMs()],
    );
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', 'res_110', 'metadata_json')).toBe(deep);
  });

  it('s111_100_folders_with_5_items_each', () => {
    for (let f = 0; f < 100; f += 1) {
      folder(vfs(a), `f111_${f}`, null, `Folder ${f}`);
      for (let i = 0; i < 5; i += 1) {
        const idx = f * 5 + i;
        resource(vfs(a), `r111_${idx}`, 'note', 'd', `h111_${idx}`);
        note(vfs(a), `n111_${idx}`, `r111_${idx}`, `N${idx}`);
        folderItem(vfs(a), `fi111_${idx}`, `f111_${f}`, 'note', `n111_${idx}`);
      }
    }
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'folders')).toBe(100);
    expect(rowCount(vfs(b), 'folder_items')).toBe(500);
  }, 180_000);

  it('s112_50_sessions_with_20_messages_each', () => {
    const da = chat(a);
    for (let s = 0; s < 50; s += 1) {
      chatSession(da, `s112_${s}`, 'general_chat', `Session ${s}`);
      for (let m = 0; m < 20; m += 1) {
        chatMessage(da, `m112_${s}_${m}`, `s112_${s}`, m % 2 === 0 ? 'user' : 'assistant', (s * 20 + m + 1) * 1000);
      }
    }
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(scalarNumber(chat(b), 'SELECT COUNT(*) FROM chat_v2_sessions')).toBe(50);
    expect(scalarNumber(chat(b), 'SELECT COUNT(*) FROM chat_v2_messages')).toBe(1000);
  }, 180_000);

  it('s113_concurrent_sync_plus_local_writes', () => {
    resource(vfs(a), 'res_113', 'note', 'conc', 'hash_113');
    note(vfs(a), 'note_113', 'res_113', 'Concurrent');
    h.applyPending(a, b, 'vfs');
    resource(vfs(a), 'res_113b', 'note', 'conc2', 'hash_113b');
    note(vfs(a), 'note_113b', 'res_113b', 'Concurrent2');
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'notes')).toBeGreaterThanOrEqual(2);
  });

  it('s114_large_attachment_metadata_100_attachments', () => {
    const da = chat(a);
    chatSession(da, 'sess_114', 'general_chat', 'Attachments');
    chatMessage(da, 'msg_114', 'sess_114', 'user', 1000);
    for (let i = 0; i < 100; i += 1) {
      chatAttachment(da, `att_${i}`, 'msg_114', `file_${i}.png`, 'image/png', 1024 * (i + 1));
    }
    h.fullSyncCycle(a, b, 'chat_v2');
    expect(scalarNumber(
      chat(b),
      "SELECT COUNT(*) FROM chat_v2_attachments WHERE message_id='msg_114'",
    )).toBe(100);
  }, 120_000);

  it('s115_full_database_population_all_tables_sync', () => {
    const da = vfs(a);
    const dca = chat(a);
    const dma = mistakes(a);

    resource(da, 'res_note', 'note', 'full', 'h_note');
    note(da, 'note_full', 'res_note', 'Full Note');
    resource(da, 'res_exam', 'exam', 'full_exam', 'h_exam');
    examSheet(da, 'exam_full', 'Full Exam', 'res_exam');
    question(da, 'q_full', 'exam_full', 'Full Q');
    reviewPlan(da, 'rp_full', 'q_full', 'exam_full');
    folder(da, 'fld_full', null, 'Full Folder');
    folderItem(da, 'fi_full', 'fld_full', 'note', 'note_full');
    todoList(da, 'tdl_full', 'Full Todo');
    todoItem(da, 'ti_full', 'tdl_full', 'Full Item');
    pomodoroRecord(da, 'pd_full', 'ti_full');
    essay(da, 'essay_full', 'res_note', 'Full Essay');
    translation(da, 'tr_full', 'res_note', 'Full Translation');
    mindmap(da, 'mm_full', 'res_note', 'Full Mindmap');
    answerSubmission(da, 'as_full', 'q_full', 'Answer', 1);

    chatSession(dca, 'sess_full', 'general_chat', 'Full Chat');
    chatMessage(dca, 'msg_full', 'sess_full', 'user', 1000);
    chatBlock(dca, 'blk_full', 'msg_full', 'content');
    chatAttachment(dca, 'att_full', 'msg_full', 'img.png', 'image/png', 1024);
    sessionGroup(dca, 'group_full', 'Full Group');
    workspaceIndex(dca, 'ws_full', 'Full WS', 'sess_full');
    dca.run(
      `INSERT INTO resources (id, hash, type, data, ref_count, created_at)
       VALUES ('cr_full', 'h_cr', 'image', 'b64', 1, 1000)`,
    );

    mistake(dma, 'mistake_full', 'Full Question', '["tag"]');
    mistakeChatMessage(dma, 'mistake_full', 'user', 'Full msg');
    reviewAnalysis(dma, 'ra_full', 'Full Review', '["mistake_full"]');
    reviewSession(dma, 'rs_full', 'Full Session', '2026-05-01', '2026-05-07');
    dma.run(
      `INSERT INTO review_session_mistakes (session_id, mistake_id, added_at)
       VALUES ('rs_full', 'mistake_full', datetime('now'))`,
    );
    documentTask(dma, 'task_full', 'doc_full');
    ankiCard(dma, 'ac_full', 'task_full', 'Q?', 'A!', '["tag"]');
    customTemplate(dma, 'cat_full', 'Full Template');
    dma.run(
      `INSERT INTO review_chat_messages (review_analysis_id, role, content, timestamp)
       VALUES ('ra_full', 'user', 'Review msg', datetime('now'))`,
    );

    h.fullSyncCycleAll(a, b);

    const checks: ReadonlyArray<readonly [string, SyncDatabaseNameForCounts]> = [
      ['notes', 'vfs'], ['resources', 'vfs'], ['questions', 'vfs'], ['review_plans', 'vfs'],
      ['folders', 'vfs'], ['folder_items', 'vfs'], ['todo_lists', 'vfs'], ['todo_items', 'vfs'],
      ['pomodoro_records', 'vfs'], ['essays', 'vfs'], ['translations', 'vfs'], ['mindmaps', 'vfs'],
      ['exam_sheets', 'vfs'], ['answer_submissions', 'vfs'],
      ['chat_v2_sessions', 'chat_v2'], ['chat_v2_messages', 'chat_v2'], ['chat_v2_blocks', 'chat_v2'],
      ['chat_v2_attachments', 'chat_v2'], ['chat_v2_session_groups', 'chat_v2'],
      ['workspace_index', 'chat_v2'],
      ['mistakes', 'mistakes'], ['chat_messages', 'mistakes'], ['review_analyses', 'mistakes'],
      ['review_sessions', 'mistakes'], ['anki_cards', 'mistakes'], ['review_chat_messages', 'mistakes'],
    ];
    for (const [table, database] of checks) {
      expect(rowCount(h.db(b, database), table), `${database}.${table}`).toBe(
        rowCount(h.db(a, database), table),
      );
    }
  }, 180_000);
});

type SyncDatabaseNameForCounts = 'vfs' | 'chat_v2' | 'mistakes';
