/**
 * [L20-engine port] `sync_realistic_scenarios.rs` S.36-S.68 (asserting cases).
 *
 * VFS concurrency, hierarchy and conflict scenarios.  The shared harness
 * replaces the inline `apply_changes_to_db` with the production engine; row
 * timestamps are monotonic so the production LWW path observes the later
 * writer that the Rust fixture's unconditional INSERT OR REPLACE always used.
 *
 * S.38, S.47 and S.75 contain no assertion in the Rust source (they only log),
 * so they stay pending instead of being added as assertion-free tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
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

function mistake(db: DatabaseHandle, id: string, userQuestion: string, tags: string): void {
  const ts = h.nextIso();
  db.run(
    `INSERT INTO mistakes (id, question_images, analysis_images, user_question, ocr_text, tags,
       mistake_type, status, created_at, updated_at, last_accessed_at)
     VALUES (?1,'[]','[]',?2,'',?3,'math','active',?4,?4,'1970-01-01T00:00:00Z')`,
    [id, userQuestion, tags, ts],
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
    clearBusinessTables(mistakes(device), MISTAKES_TABLES);
  }
});

afterAll(async () => { await h.dispose(); });

describe('sync realistic scenarios S.36-S.45: concurrent edits and dedup', () => {
  it('s36_same_resource_created_both_devices_hash_conflict', () => {
    resource(vfs(a), 'res_036', 'note', 'Data A', 'same_hash_036');
    resource(vfs(b), 'res_036', 'note', 'Data B', 'same_hash_036');
    h.applyPending(b, a, 'vfs');
    expect(rowCount(vfs(a), 'resources')).toBeGreaterThanOrEqual(1);
  });

  it('s37_both_devices_update_same_note_title_lww', () => {
    resource(vfs(a), 'res_037', 'note', 'data', 'hash_037');
    note(vfs(a), 'note_037', 'res_037', 'Original');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', ['A Wins', h.nextIso(), 'note_037']);
    vfs(b).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', ['B Wins', h.nextIso(), 'note_037']);
    h.applyPending(b, a, 'vfs');
    const title = column(vfs(a), 'notes', 'note_037', 'title');
    expect(title).not.toBeNull();
    expect(title).not.toBe('');
  });

  it('s40_both_add_tags_to_note_tag_union', () => {
    resource(vfs(a), 'res_040', 'note', 'data', 'hash_040');
    note(vfs(a), 'note_040', 'res_040', 'Tag Union');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3', ['["urgent"]', h.nextIso(), 'note_040']);
    vfs(b).run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3', ['["done"]', h.nextIso(), 'note_040']);
    h.applyPending(b, a, 'vfs');
    const tags = column(vfs(a), 'notes', 'note_040', 'tags');
    expect(tags).not.toBeNull();
    expect(tags).not.toBe('');
  });

  it('s41_modify_metadata_json_deep_merge', () => {
    vfs(a).run(
      `INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode)
       VALUES ('res_041', 'hash_041', 'note', '{"v":1}', 1, ?1, ?1, 'inline')`,
      [h.nextMs()],
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"v":1,"key_a":"val_a"}', h.nextMs(), 'res_041']);
    vfs(b).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"v":1,"key_b":"val_b"}', h.nextMs(), 'res_041']);
    h.applyPending(b, a, 'vfs');
    expect(column(vfs(a), 'resources', 'res_041', 'metadata_json')).not.toBeNull();
  });

  it('s42_folder_item_unique_constraint_conflict', () => {
    folder(vfs(a), 'fld_042', null, 'Folder42');
    resource(vfs(a), 'res_042', 'note', 'data', 'hash_042');
    note(vfs(a), 'note_042', 'res_042', 'Item42');
    folderItem(vfs(a), 'fi_042', 'fld_042', 'note', 'note_042');
    folder(vfs(b), 'fld_042', null, 'Folder42');
    folderItem(vfs(b), 'fi_042_dup', 'fld_042', 'note', 'note_042');
    h.applyPending(b, a, 'vfs');
    expect(rowCount(vfs(a), 'folder_items')).toBeGreaterThanOrEqual(1);
  });

  it('s43_both_devices_add_different_tags_to_question', () => {
    resource(vfs(a), 'res_043', 'note', 'data', 'hash_043');
    note(vfs(a), 'note_043', 'res_043', 'Note 43');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3', ['["hard"]', h.nextIso(), 'note_043']);
    vfs(b).run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3', ['["review"]', h.nextIso(), 'note_043']);
    expect(column(vfs(a), 'notes', 'note_043', 'tags')).toBe('["hard"]');
    expect(column(vfs(b), 'notes', 'note_043', 'tags')).toBe('["review"]');
    h.applyPending(b, a, 'vfs');
    const tags = column(vfs(a), 'notes', 'note_043', 'tags');
    expect(tags).not.toBeNull();
    expect(tags).not.toBe('');
  });

  it('s44_both_devices_modify_metadata_json_resource', () => {
    vfs(a).run(
      `INSERT INTO resources (id, hash, type, metadata_json, ref_count, created_at, updated_at, storage_mode)
       VALUES ('res_044', 'hash_044', 'note', '{"x":1,"y":2}', 1, ?1, ?1, 'inline')`,
      [h.nextMs()],
    );
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"x":1,"y":2,"a":10}', h.nextMs(), 'res_044']);
    vfs(b).run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3', ['{"x":1,"y":2,"b":20}', h.nextMs(), 'res_044']);
    h.applyPending(b, a, 'vfs');
    expect(column(vfs(a), 'resources', 'res_044', 'metadata_json')).not.toBeNull();
  });

  it('s45_same_file_sha256_dedup', () => {
    resource(vfs(a), 'res_045', 'note', 'same data', 'sha256_aaa');
    resource(vfs(b), 'res_045b', 'note', 'same data', 'sha256_aaa');
    h.applyPending(b, a, 'vfs');
    expect(rowCount(vfs(a), 'resources')).toBeGreaterThanOrEqual(1);
  });
});

describe('sync realistic scenarios S.46-S.56: cascade, conflicts and payload edges', () => {
  it('s46_three_devices_concurrent_edit_cascade', async () => {
    const c = await h.device('C', 'device_c_001');
    clearBusinessTables(vfs(c), VFS_TABLES);
    resource(vfs(a), 'res_046', 'note', 'three', 'hash_046');
    note(vfs(a), 'note_046', 'res_046', 'Three Way');
    const initial = h.collectPending(a, 'vfs');
    h.applyChanges(b, 'vfs', initial);
    h.applyChanges(c, 'vfs', initial);
    h.markSynced(a, 'vfs', initial);
    note(vfs(b), 'note_046b', 'res_046', "B's Note");
    note(vfs(c), 'note_046c', 'res_046', "C's Note");
    h.applyPending(b, a, 'vfs');
    h.applyPending(c, a, 'vfs');
    expect(rowCount(vfs(a), 'notes')).toBeGreaterThanOrEqual(3);
  });

  it('s48_conflict_table_accumulation_3_rounds', () => {
    resource(vfs(a), 'res_048', 'note', 'data', 'hash_048');
    note(vfs(a), 'note_048', 'res_048', 'Conflict Test');
    h.fullSyncCycle(a, b, 'vfs');
    for (let round = 0; round < 3; round += 1) {
      vfs(a).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', [`A v${round}`, h.nextIso(), 'note_048']);
      vfs(b).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', [`B v${round}`, h.nextIso(), 'note_048']);
      h.applyPending(b, a, 'vfs');
    }
    expect(column(vfs(a), 'notes', 'note_048', 'title')).not.toBeNull();
  });

  it('s49_resolved_conflict_new_identical_conflict', () => {
    resource(vfs(a), 'res_049', 'note', 'data', 'hash_049');
    note(vfs(a), 'note_049', 'res_049', 'Resolve');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', ['Resolved', h.nextIso(), 'note_049']);
    vfs(b).run('UPDATE notes SET title = ?1, updated_at = ?2 WHERE id = ?3', ['Conflict', h.nextIso(), 'note_049']);
    h.applyPending(b, a, 'vfs');
    expect(column(vfs(a), 'notes', 'note_049', 'title')).not.toBeNull();
  });

  it('s50_long_record_id_1000_chars', () => {
    const longId = 'a'.repeat(1000);
    resource(vfs(a), longId, 'note', 'long_id', 'lh050');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', longId, 'data')).toBe('long_id');
  });

  it('s51_unicode_content_chinese_japanese_emoji', () => {
    const unicodeData = '中文日本語🎉✓∑テスト';
    resource(vfs(a), 'res_051', 'note', unicodeData, 'hash_051');
    note(vfs(a), 'note_051', 'res_051', unicodeData);
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'notes', 'note_051', 'title')).toBe(unicodeData);
  });

  it('s52_very_large_json_blob', () => {
    resource(vfs(a), 'res_052', 'note', 'x'.repeat(50000), 'hash_052');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', 'res_052', 'data')?.length).toBe(50000);
  });

  it('s53_concurrent_sync_plus_local_writes', () => {
    resource(vfs(a), 'res_053', 'note', 'conc', 'hash_053');
    note(vfs(a), 'note_053', 'res_053', 'BeforeSync');
    h.applyPending(a, b, 'vfs');
    note(vfs(b), 'note_053b', 'res_053', 'LocalWrite');
    expect(rowCount(vfs(b), 'notes')).toBeGreaterThanOrEqual(2);
  });

  it('s54_special_characters_in_json_cols', () => {
    const tags = '["tag with spaces","tag/with/slash"]';
    resource(vfs(a), 'res_054', 'note', 'Sp', 'hash_054');
    const ts = h.nextIso();
    vfs(a).run(
      `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
       VALUES ('note_054', 'res_054', 'Sp', ?1, 0, ?2, ?2)`,
      [tags, ts],
    );
    h.fullSyncCycle(a, b, 'vfs');
    const synced = column(vfs(b), 'notes', 'note_054', 'tags');
    expect(synced).not.toBeNull();
    expect(synced).not.toBe('');
  });

  it('s55_large_record_data_50kb', () => {
    resource(vfs(a), 'res_055', 'note', 'x'.repeat(50000), 'hash_055');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', 'res_055', 'data')?.length).toBe(50000);
  });

  it('s56_zero_local_version_initial_sync', () => {
    resource(vfs(a), 'res_056', 'note', 'v0', 'hash_056');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', 'res_056', 'data')).not.toBeNull();
  });
});

describe('sync realistic scenarios S.57-S.68: timestamps, keys and hierarchy', () => {
  it('s57_millisecond_timestamps_in_updated_at', () => {
    resource(vfs(a), 'res_057', 'note', 'ms', 'hash_057');
    note(vfs(a), 'note_057', 'res_057', 'MS Test');
    vfs(a).run("UPDATE notes SET updated_at = '2026-05-01T10:00:00.123Z' WHERE id = 'note_057'");
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'notes', 'note_057', 'updated_at')).not.toBeNull();
  });

  it('s58_negative_ease_factor', () => {
    resource(vfs(a), 'res_058', 'exam', 'd', 'hash_058');
    examSheet(vfs(a), 'exam_058', 'EF', 'res_058');
    question(vfs(a), 'q_058', 'exam_058', 'Q58');
    const ts = h.nextIso();
    vfs(a).run(
      `INSERT INTO review_plans (id, question_id, exam_id, ease_factor, next_review_date,
         status, created_at, updated_at)
       VALUES ('rp_058', 'q_058', 'exam_058', -0.5, ?1, 'new', ?1, ?1)`,
      [ts],
    );
    h.fullSyncCycle(a, b, 'vfs');
    expect(columnMs(vfs(b), 'review_plans', 'rp_058', 'ease_factor')).not.toBeNull();
  });

  it('s60_device_id_mismatch_detection', () => {
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it('s61_empty_change_log_on_one_device', () => {
    expect(h.fullSyncCycle(a, b, 'vfs')).toEqual([0, 0]);
  });

  it('s62_foreign_key_orphan_detection', () => {
    resource(vfs(a), 'res_062', 'note', 'o', 'hash_062');
    note(vfs(a), 'note_062', 'res_062', 'Orphan');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'resources', 'res_062', 'id')).not.toBeNull();
    expect(column(vfs(b), 'notes', 'note_062', 'resource_id')).toBe('res_062');
  });

  it('s63_self_referencing_fk_folder_parent_id', () => {
    folder(vfs(a), 'fld_parent', null, 'Parent');
    folder(vfs(a), 'fld_child', 'fld_parent', 'Child');
    h.fullSyncCycle(a, b, 'vfs');
    expect(column(vfs(b), 'folders', 'fld_child', 'parent_id')).toBe('fld_parent');
  });

  it('s64_composite_pk_record_id', () => {
    const da = mistakes(a);
    const db = mistakes(b);
    mistake(da, 'mistake_064', 'Q64', '["c"]');
    const ts = h.nextIso();
    da.run(
      `INSERT INTO review_sessions (id, title, start_date, end_date, created_at, updated_at)
       VALUES ('rs_064', 'Comp', '2026-05-01', '2026-05-07', ?1, ?1)`,
      [ts],
    );
    da.run(
      `INSERT INTO review_session_mistakes (session_id, mistake_id, added_at)
       VALUES ('rs_064', 'mistake_064', datetime('now'))`,
    );
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      db,
      "SELECT COUNT(*) FROM review_session_mistakes WHERE session_id='rs_064'",
    )).toBe(1);
  });

  it('s65_autoincrement_pk_on_chat_messages', () => {
    const da = mistakes(a);
    mistake(da, 'mistake_065', 'APK', '["t"]');
    for (let i = 0; i < 5; i += 1) {
      da.run(
        'INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES (?1,?2,?3,?4)',
        ['mistake_065', 'user', `Msg ${i}`, h.nextIso()],
      );
    }
    h.fullSyncCycle(a, b, 'mistakes');
    expect(scalarNumber(
      mistakes(b),
      "SELECT COUNT(*) FROM chat_messages WHERE mistake_id='mistake_065'",
    )).toBeGreaterThanOrEqual(5);
  });

  it('s66_create_resource_note_in_same_batch_atomic', () => {
    resource(vfs(a), 'res_066', 'note', 'atom', 'hash_066');
    note(vfs(a), 'note_066', 'res_066', 'Atomic');
    h.fullSyncCycle(a, b, 'vfs');
    expect(rowCount(vfs(b), 'resources')).toBeGreaterThanOrEqual(1);
    expect(rowCount(vfs(b), 'notes')).toBeGreaterThanOrEqual(1);
  });

  it('s67_delete_parent_cascade_synced', () => {
    resource(vfs(a), 'res_067', 'note', 'c', 'hash_067');
    folder(vfs(a), 'fld_067', null, 'Cascade');
    folderItem(vfs(a), 'fi_067', 'fld_067', 'note', 'res_067');
    h.fullSyncCycle(a, b, 'vfs');
    vfs(a).run(
      'UPDATE folders SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3',
      ['2026-06-01T00:00:00Z', h.nextIso(), 'fld_067'],
    );
    h.fullSyncCycle(a, b, 'vfs');
    const deleted = column(vfs(b), 'folders', 'fld_067', 'deleted_at');
    expect(deleted).not.toBeNull();
    expect(deleted).not.toBe('');
  });

  it('s68_reorder_folder_items_sort_order_preserved', () => {
    folder(vfs(a), 'fld_068', null, 'Reordered');
    resource(vfs(a), 'res_068', 'note', 'd', 'hash_068');
    note(vfs(a), 'note_068', 'res_068', 'N');
    folderItem(vfs(a), 'fi_068', 'fld_068', 'note', 'note_068');
    vfs(a).run('UPDATE folder_items SET sort_order = 99, updated_at = ?1 WHERE id = ?2', [h.nextMs(), 'fi_068']);
    h.fullSyncCycle(a, b, 'vfs');
    expect(columnMs(vfs(b), 'folder_items', 'fi_068', 'sort_order')).toBe(99);
  });
});
