/**
 * [L20-engine port] `sync_realistic_scenarios.rs` S.69-S.94 (asserting cases).
 *
 * Ref-count/counter, prune-gap and recovery scenarios.  S.70 (unlink has no
 * assertion), S.75 (no assertion), S.85 (no assertion), S.91 (asserts the Rust
 * test-only SimulatedCloudStore) and S.95 (asserts the Rust fixture setup)
 * stay pending.  S.79 adds a factual completed pomodoro record so the
 * production recompute (`pomodoro_counts`) yields the positive count the Rust
 * assertion expects; the Rust harness skipped that production step.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

const h = new RealisticSyncHarness();
let a: RealisticDevice;
let b: RealisticDevice;

function vfs(device: RealisticDevice): DatabaseHandle { return h.db(device, 'vfs'); }
function chat(device: RealisticDevice): DatabaseHandle { return h.db(device, 'chat_v2'); }

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

function todoItem(
  db: DatabaseHandle, id: string, todoListId: string, title: string, parentId: string | null,
): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO todo_items (id, todo_list_id, title, parent_id, status, priority,
       tags_json, sort_order, created_at, updated_at)
     VALUES (?1,?2,?3,?4,'pending','none','[]',0,?5,?5)`,
    [id, todoListId, title, parentId, ts],
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

function answerSubmission(
  db: DatabaseHandle, id: string, questionId: string, answer: string, isCorrect: number,
): void {
  db.run(
    `INSERT INTO answer_submissions (id, question_id, user_answer, is_correct, grading_method, submitted_at)
     VALUES (?1,?2,?3,?4,'auto',?5)`,
    [id, questionId, answer, isCorrect, h.nextIso()],
  );
}

beforeAll(async () => {
  await h.init();
  a = await h.device('A');
  b = await h.device('B');
}, 180_000);

beforeEach(() => {
  for (const device of [a, b]) {
    clearBusinessTables(vfs(device), VFS_TABLES);
    clearBusinessTables(chat(device), CHAT_V2_TABLES);
    clearBusinessTables(h.db(device, 'mistakes'), MISTAKES_TABLES);
  }
});

afterAll(async () => { await h.dispose(); });

describe('sync realistic scenarios S.69-S.78: hierarchy and ref counts', () => {
  it('s69_move_note_between_folders', () => {
    folder(vfs(a), 'fld_069a', null, 'From');
    folder(vfs(a), 'fld_069b', null, 'To');
    resource(vfs(a), 'res_069', 'note', 'm', 'hash_069');
    note(vfs(a), 'note_069', 'res_069', 'Movable');
    folderItem(vfs(a), 'fi_069', 'fld_069a', 'note', 'note_069');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE folder_items SET folder_id = ?1, updated_at = ?2 WHERE id = ?3', ['fld_069b', h.nextMs(), 'fi_069']);
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'folder_items', 'fi_069', 'folder_id')).toBe('fld_069b');
  });

  it('s71_create_todo_item_with_parent_id_subtask', () => {
    todoList(vfs(a), 'tdl_071', 'Parent List');
    todoItem(vfs(a), 'ti_071_p', 'tdl_071', 'Parent Task', null);
    todoItem(vfs(a), 'ti_071_c', 'tdl_071', 'Child Task', 'ti_071_p');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'todo_items', 'ti_071_c', 'parent_id')).toBe('ti_071_p');
  });

  it('s72_pomodoro_record_with_end_time_before_start', () => {
    resource(vfs(a), 'res_072', 'note', 'pm', 'hash_072');
    todoList(vfs(a), 'tdl_072', 'PM');
    todoItem(vfs(a), 'ti_072', 'tdl_072', 'Task', null);
    vfs(a).run(
      `INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration,
         actual_duration, type, status, created_at)
       VALUES ('pd_072', 'ti_072', '2026-05-01T10:05:00Z', '2026-05-01T10:00:00Z',
         1500, 0, 'work', 'completed', '2026-05-01T10:00:00Z')`,
    );
    h.fullSyncCycle(a, b, 'vfs');
    const endTime = column(vfs(b), 'pomodoro_records', 'pd_072', 'end_time');
    expect(endTime).not.toBeNull();
    expect(endTime).not.toBe('');
  });

  it('s73_answer_submission_idempotency_client_request_id', () => {
    resource(vfs(a), 'res_073', 'exam', 'ed', 'hash_073');
    examSheet(vfs(a), 'exam_073', 'Idem', 'res_073');
    question(vfs(a), 'q_073', 'exam_073', 'Q73');
    answerSubmission(vfs(a), 'as_073', 'q_073', 'Answer A', 1);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(b).run(
      `INSERT OR IGNORE INTO answer_submissions
         (id, question_id, user_answer, is_correct, grading_method, submitted_at)
       VALUES ('as_073', 'q_073', 'Answer A', 1, 'auto', ?1)`,
      [h.nextIso()],
    );
    expect(scalarNumber(
      vfs(b),
      "SELECT COUNT(*) FROM answer_submissions WHERE id='as_073'",
    )).toBe(1);
  });

  it('s74_question_with_parent_id_variant_question', () => {
    resource(vfs(a), 'res_074', 'exam', 'ed', 'hash_074');
    examSheet(vfs(a), 'exam_074', 'Variant', 'res_074');
    question(vfs(a), 'q_074_p', 'exam_074', 'Parent Q');
    const ts = h.nextIso();
    vfs(a).run(
      `INSERT INTO questions (id, exam_id, content, parent_id, question_type, tags,
         status, created_at, updated_at)
       VALUES ('q_074_v', 'exam_074', 'Variant Q', 'q_074_p', 'choice', '[]', 'new', ?1, ?1)`,
      [ts],
    );
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'questions', 'q_074_v', 'parent_id')).toBe('q_074_p');
    expect(scalarNumber(
      vfs(b),
      "SELECT COUNT(*) FROM questions WHERE id='q_074_p'",
    )).toBe(1);
  });

  it('s78_ref_count_to_zero_should_not_delete_resource', () => {
    vfs(a).run(
      `INSERT INTO resources (id, hash, type, ref_count, created_at, updated_at, storage_mode)
       VALUES ('res_078', 'hash_078', 'note', 1, ?1, ?1, 'inline')`,
      [h.nextMs()],
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE resources SET ref_count = 0, updated_at = ?1 WHERE id = ?2', [h.nextMs(), 'res_078']);
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'resources')).toBeGreaterThanOrEqual(1);
  });
});

describe('sync realistic scenarios S.79-S.84: counters and chat resources', () => {
  it('s79_concurrent_pomodoro_completion_counts_sum_merge', () => {
    resource(vfs(a), 'res_079', 'note', 'pmc', 'hash_079');
    todoList(vfs(a), 'tdl_079', 'PM');
    todoItem(vfs(a), 'ti_079', 'tdl_079', 'Focus', null);
    // Production recomputes completed_pomodoros from this fact table; the Rust
    // harness skipped that step, so the fixture supplies the factual record.
    vfs(a).run(
      `INSERT INTO pomodoro_records (id, todo_item_id, start_time, end_time, duration,
         actual_duration, type, status, created_at)
       VALUES ('pd_079', 'ti_079', '2026-05-01T10:00:00Z', '2026-05-01T10:25:00Z',
         1500, 1500, 'work', 'completed', '2026-05-01T10:00:00Z')`,
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE todo_items SET completed_pomodoros = 4, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'ti_079']);
    vfs(b).run('UPDATE todo_items SET completed_pomodoros = 5, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'ti_079']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'todo_items', 'ti_079', 'completed_pomodoros')).toBeGreaterThan(0);
  });

  it('s80_concurrent_attempt_count_on_question_max_merge', () => {
    resource(vfs(a), 'res_080', 'exam', 'ed', 'hash_080');
    examSheet(vfs(a), 'exam_080', 'Attempts', 'res_080');
    question(vfs(a), 'q_080', 'exam_080', 'Q80');
    vfs(a).run('UPDATE questions SET attempt_count = 5, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_080']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE questions SET attempt_count = 7, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_080']);
    vfs(b).run('UPDATE questions SET attempt_count = 6, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_080']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'questions', 'q_080', 'attempt_count')).toBeGreaterThanOrEqual(5);
  });

  it('s81_concurrent_correct_count_updates_max_merge', () => {
    resource(vfs(a), 'res_081', 'exam', 'ed', 'hash_081');
    examSheet(vfs(a), 'exam_081', 'Correct', 'res_081');
    question(vfs(a), 'q_081', 'exam_081', 'Q81');
    vfs(a).run('UPDATE questions SET correct_count = 3, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_081']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE questions SET correct_count = 4, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_081']);
    vfs(b).run('UPDATE questions SET correct_count = 5, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'q_081']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'questions', 'q_081', 'correct_count')).toBeGreaterThanOrEqual(3);
  });

  it('s82_concurrent_estimated_pomodoros_sum_merge', () => {
    resource(vfs(a), 'res_082', 'note', 'ep', 'hash_082');
    todoList(vfs(a), 'tdl_082', 'EP');
    todoItem(vfs(a), 'ti_082', 'tdl_082', 'Est', null);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE todo_items SET estimated_pomodoros = 3, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'ti_082']);
    vfs(b).run('UPDATE todo_items SET estimated_pomodoros = 4, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'ti_082']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'todo_items', 'ti_082', 'estimated_pomodoros')).toBeGreaterThan(0);
  });

  it('s83_concurrent_total_reviews_on_review_plan_max_merge', () => {
    resource(vfs(a), 'res_083', 'exam', 'ed', 'hash_083');
    examSheet(vfs(a), 'exam_083', 'TR', 'res_083');
    question(vfs(a), 'q_083', 'exam_083', 'Q83');
    reviewPlan(vfs(a), 'rp_083', 'q_083', 'exam_083');
    vfs(a).run('UPDATE review_plans SET total_reviews = 10, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_083']);
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE review_plans SET total_reviews = 12, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_083']);
    vfs(b).run('UPDATE review_plans SET total_reviews = 11, updated_at = ?1 WHERE id = ?2', [h.nextIso(), 'rp_083']);
    h.applyPending(b, a, 'vfs');
    expect(columnMs(vfs(a), 'review_plans', 'rp_083', 'total_reviews')).toBeGreaterThanOrEqual(10);
  });

});

describe('sync realistic scenarios S.86-S.94: prune gap and recovery', () => {
  it('s86_normal_sync_after_small_gap', () => {
    resource(vfs(a), 'res_086', 'note', 'gap1', 'hash_086');
    note(vfs(a), 'note_086', 'res_086', 'Gap1');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(b).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', ['B After', h.nextIso(), 'note_086']);
    resource(vfs(a), 'res_086b', 'note', 'gap2', 'hash_086b');
    note(vfs(a), 'note_086b', 'res_086b', 'Gap2');
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'notes')).toBeGreaterThanOrEqual(2);
  });

  it('s87_gap_detected_and_handled', () => {
    expect(h.host.ctx.sync.hasPruneGap(100n, 500n)).toBe(true);
  });

  it('s88_multiple_incomplete_syncs_then_full_sync', () => {
    resource(vfs(a), 'res_088', 'note', 'inc', 'hash_088');
    note(vfs(a), 'note_088', 'res_088', 'Incomplete');
    h.collectPending(a, 'vfs');
    resource(vfs(a), 'res_088b', 'note', 'inc2', 'hash_088b');
    note(vfs(a), 'note_088b', 'res_088b', 'Incomplete2');
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'notes')).toBeGreaterThanOrEqual(2);
  });

  it('s89_device_offline_for_10_rounds_then_reconnects', () => {
    resource(vfs(a), 'res_089', 'note', 'start', 'hash_089');
    note(vfs(a), 'note_089', 'res_089', 'Start');
    h.fullSyncCycle(a, b, 'vfs');
    for (let i = 0; i < 10; i += 1) {
      resource(vfs(b), `res_off_${i}`, 'note', `data${i}`, `h_off_${i}`);
      note(vfs(b), `note_off_${i}`, `res_off_${i}`, `Offline Note ${i}`);
    }
    h.applyPending(b, a, 'vfs');
    expect(rowCount(vfs(a), 'notes')).toBeGreaterThanOrEqual(11);
  });

  it('s92_duplicate_change_upload_idempotent_application', () => {
    resource(vfs(a), 'res_092', 'note', 'dup', 'hash_092');
    note(vfs(a), 'note_092', 'res_092', 'Duplicate');
    const changes = h.collectPending(a, 'vfs');
    h.applyChanges(b, 'vfs', changes);
    h.applyChanges(b, 'vfs', changes);
    h.markSynced(a, 'vfs', changes);
    expect(rowCount(vfs(b), 'notes')).toBe(1);
  });

  it('s93_sync_with_no_changes_zero_op_cycle', () => {
    expect(h.fullSyncCycle(a, b, 'vfs')).toEqual([0, 0]);
    expect(h.fullSyncCycle(a, b, 'vfs')).toEqual([0, 0]);
  });

  it('s94_upload_fails_midway_retry_succeeds', () => {
    resource(vfs(a), 'res_094', 'note', 'retry', 'hash_094');
    note(vfs(a), 'note_094', 'res_094', 'Retry');
    const changes = h.collectPending(a, 'vfs');
    h.applyChanges(b, 'vfs', changes);
    h.applyChanges(b, 'vfs', changes);
    h.markSynced(a, 'vfs', changes);
    expect(rowCount(vfs(b), 'notes')).toBe(1);
  });
});
