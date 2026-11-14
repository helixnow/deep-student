import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import {
  cardTallies, checkpointsWithConn, questionTallies,
} from '../repository/media-ledger.ts';
import { assembleLedgers, normalizeIds } from '../src/ledger.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ledger-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ledger-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
}, 120_000);
afterAll(() => {
  storage?.dispose();
  fs.rmSync(template, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

it('tallies_cards_by_task_source_ref', () => {
  const conn = storage.database('mistakes');
  conn.exec(`DROP TABLE IF EXISTS fsrs_card_states;
    DROP TABLE IF EXISTS anki_cards;
    DROP TABLE IF EXISTS document_tasks;
    CREATE TABLE document_tasks (id TEXT PRIMARY KEY, anki_generation_options_json TEXT, deleted_at TEXT);
    CREATE TABLE anki_cards (id TEXT PRIMARY KEY, task_id TEXT, created_at TEXT, deleted_at TEXT);
    CREATE TABLE fsrs_card_states (id TEXT PRIMARY KEY, anki_card_id TEXT, state INTEGER,
      due_ms INTEGER, suspended INTEGER, deleted_at TEXT);`);
  conn.exec(`INSERT INTO document_tasks VALUES
      ('t1', '{"source_ref":{"kind":"resource","id":"file_lec"}}', NULL),
      ('t2', '{"source_ref":{"kind":"note","id":"note_x"}}', NULL),
      ('t3', 'not json', NULL),
      ('t4', '{"source_ref":{"kind":"resource","id":"file_lec"}}', '2026-10-01');
    INSERT INTO anki_cards VALUES
      ('c1', 't1', '1', NULL), ('c2', 't1', '2', NULL), ('c3', 't1', '3', NULL),
      ('c4', 't1', '4', NULL), ('c5', 't1', '5', '2026-10-02'),
      ('c6', 't2', '6', NULL), ('c7', 't3', '7', NULL), ('c8', 't4', '8', NULL);
    INSERT INTO fsrs_card_states VALUES
      ('s1', 'c1', 2, 1000, 0, NULL),
      ('s2', 'c2', 2, 9000, 0, NULL),
      ('s3', 'c3', 0, 0, 0, NULL),
      ('s4', 'c4', 2, 1000, 1, NULL);`);
  const ids = ['file_lec', 'file_none'];
  const tallies = cardTallies(conn, ids, 5000, true);
  const lec = tallies.get('file_lec')!;
  expect([lec.count, lec.due, lec.new]).toEqual([4, 1, 1]);
  expect(lec.ids).toEqual(['c1', 'c2', 'c3', 'c4']);
  expect(tallies.has('file_none')).toBe(false);
  expect(cardTallies(conn, ids, 5000, false).get('file_lec')!.ids).toEqual([]);
});

it('tallies_questions_by_resource_ids_and_assembles_in_request_order', async () => {
  const conn = storage.database('vfs');
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: root } },
  });
  const mediaApi = host.ctx.media;
  await host.dispose();
  for (const [id, deletedAt] of [
    ['exam_a', null],
    ['exam_b', null],
    ['exam_gone', '2026-10-05'],
  ] as const) {
    conn.run(
      `INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
         created_at, updated_at, deleted_at)
       VALUES (?1, ?1, 'completed', ?1, '{}', '{}', '2026-10-05', '2026-10-05', ?2)`,
      [id, deletedAt],
    );
  }
  const insert = (id: string, exam: string, source: string | null,
    attempts: number, correct: number, isCorrect: number | null): void => {
    conn.run(
      `INSERT INTO questions (id, exam_id, content, source_ref, attempt_count, correct_count,
         is_correct, created_at, updated_at)
       VALUES (?1, ?2, 'q', ?3, ?4, ?5, ?6, '2026-10-05', '2026-10-05')`,
      [id, exam, source, attempts, correct, isCorrect],
    );
  };
  insert('q1', 'exam_a', '{"resourceIds":["file_lec"]}', 2, 1, 0);
  insert('q2', 'exam_a', '{"resourceIds":["file_lec","file_other"]}', 1, 1, 1);
  insert('q3', 'exam_b', '{"resourceIds":["file_lec"]}', 0, 0, null);
  insert('q4', 'exam_gone', '{"resourceIds":["file_lec"]}', 3, 0, 0);
  insert('q5', 'exam_a', 'broken', 1, 0, 0);
  insert('q6', 'exam_a', null, 0, 0, null);
  insert('q7', 'exam_a', '{"resourceIds":"file_lec"}', 1, 0, 0);
  conn.exec(`INSERT INTO questions (id, exam_id, content, explanation, question_type, options_json,
      attempt_count, correct_count, is_correct, created_at, updated_at) VALUES
    ('q8', 'exam_b', '选哪个？', '因为…
[媒体@file_lec:12:30]', 'single_choice', '[{"key":"A","content":"甲"}]', 1, 1, 1, '2026-10-05', '2026-10-05'),
    ('q9', 'exam_b', '判断', '见 [媒体@file_other:00:10] 与 [媒体@file_lec:1:02:03]', 'true_false', NULL, 0, 0, NULL, '2026-10-05', '2026-10-05'),
    ('q10', 'exam_gone', '已删题目集', '[媒体@file_lec:00:05]', 'single_choice', NULL, 0, 0, NULL, '2026-10-05', '2026-10-05');`);
  conn.exec(`INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
      VALUES ('file_lec', 'sha_lec', '第3讲.mp4', 1, 'video/mp4', 'video', 'active', '2026-10-05', '2026-10-05');
    INSERT INTO media_progress (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
      VALUES ('file_lec', 1510000, 2880000, 1920000, 0, 1759640000000);
    UPDATE questions SET attempt_count = 2, is_correct = 0 WHERE id = 'q9';`);
  const summary = mediaApi.mediaLearningSummary(conn, 5);
  const course = summary.recentCourses[0]!;
  expect(course.position).toBe('25:10');
  expect(course.positionRef).toBe('[媒体@file_lec:25:10]');
  expect(course.watchedMinutes).toBe(32);
  expect(course.wrongCheckpoints[0]!.ref).toBe('[媒体@file_lec:1:02:03]');
  expect(course.wrongCheckpoints[0]!.attempts).toBe(2);
  conn.run("UPDATE questions SET attempt_count = 0, is_correct = NULL WHERE id = 'q9'");

  const checkpoints = checkpointsWithConn(conn, 'file_lec');
  expect(checkpoints.map(cp => [cp.questionId, cp.seconds, cp.isCorrect]))
    .toEqual([['q8', 750, true], ['q9', 3723, null]]);
  expect(checkpoints[0]!.questionType).toBe('single_choice');
  expect(checkpointsWithConn(conn, 'file_none')).toEqual([]);

  const ids = normalizeIds([' file_other ', 'file_lec', 'file_lec', '']);
  expect(ids).toEqual(['file_other', 'file_lec']);
  const questions = questionTallies(conn, ids);
  const ledgers = assembleLedgers(ids, new Map(), questions);
  expect(ledgers[0]!.resourceId).toBe('file_other');
  expect(ledgers[0]!.questionCount).toBe(2);
  const lec = ledgers[1]!;
  expect([
    lec.questionCount, lec.questionsAttempted, lec.attemptTotal,
    lec.correctTotal, lec.questionsWrong,
  ]).toEqual([5, 3, 4, 3, 1]);
  expect(lec.examIds).toEqual(['exam_b', 'exam_a']);
  expect(lec.cardCount).toBe(0);
});

it('X2-D01 ledger commands return the SQLite error as a plain string (ledger.rs:255-257,466-476)', async () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ledger-empty-'));
  const empty = createStorageService({ baseDir: emptyRoot, dataLocalDir: emptyRoot });
  const host = await createTestHost({
    plugins: [media],
    provide: {
      settings: { get: () => null, save: () => undefined },
      paths: { appDataDir: emptyRoot },
      storage: empty,
      vfsDatabase: { getConnSafe: () => empty.database('vfs') } as unknown as VfsDatabase,
    },
  });
  try {
    await expect(host.invoke('media_checkpoints', { resourceId: 'res_1' }))
      .rejects.toBe('no such table: questions');
    await expect(host.invoke('media_study_ledger', { resourceIds: ['res_1'] }))
      .rejects.toBe('no such table: document_tasks');
  } finally {
    await host.dispose();
    empty.dispose();
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

it('RF-W04-media-ledger-missing-vfs: ledger commands report a missing VFS database instead of returning silently empty results', async () => {
  // Rust media_*_with(vfs_db: None) returns empty data; in the Host a
  // missing vfsDatabase is a misconfigured profile and must not look like "no checkpoints".
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-ledger-novfs-'));
  fs.cpSync(template, freshRoot, { recursive: true });
  const fresh = createStorageService({ baseDir: freshRoot, dataLocalDir: freshRoot });
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: fresh, settings: { get: () => null, save: () => undefined }, paths: { appDataDir: freshRoot } },
  });
  try {
    await expect(host.invoke('media_checkpoints', { resourceId: 'res_1' })).rejects.toBe('VFS database not configured');
    await expect(host.invoke('media_study_ledger', { resourceIds: ['res_1'] })).rejects.toBe('VFS database not configured');
    expect(await host.invoke('media_checkpoints', { resourceId: '  ' })).toEqual([]);
    expect(await host.invoke('media_study_ledger', { resourceIds: [' ', ''] })).toEqual([]);
  } finally {
    await host.dispose();
    fresh.dispose();
    fs.rmSync(freshRoot, { recursive: true, force: true });
  }
});

it('WP-163 media_learning_summary watchedMinutes is i64 watched_ms.max(0) / 60_000 (ledger.rs:265-319)', async () => {
  const conn = storage.database('vfs');
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: root } },
  });
  const mediaApi = host.ctx.media;
  await host.dispose();
  const I64_MAX = 9_223_372_036_854_775_807n;
  const rows: Array<[string, bigint, bigint, bigint | null, bigint]> = [
    // [id, watched_ms, last_position_ms, duration_ms, updated_at]
    ['wp163_n2', 9_007_199_254_799_999n, 0n, null, 1_759_640_000_001n],
    ['wp163_59999', 59_999n, 0n, null, 1_759_640_000_002n],
    ['wp163_60000', 60_000n, 0n, null, 1_759_640_000_003n],
    ['wp163_119999', 119_999n, 0n, null, 1_759_640_000_004n],
    ['wp163_plain', 1_920_000n, 1_510_000n, 2_880_000n, 1_759_640_000_005n],
    ['wp163_max', I64_MAX, I64_MAX, I64_MAX, I64_MAX],
  ];
  for (const [id, watched, position, duration, updatedAt] of rows) {
    conn.run(
      `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
       VALUES (?1, ?2, ?1, 1, 'video/mp4', 'video', 'active', '2026-11-06', '2026-11-06')`,
      [id, `sha_${id}`],
    );
    conn.run(
      `INSERT INTO media_progress (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5)`,
      [id, position, duration, watched, updatedAt],
    );
  }
  const summary = mediaApi.mediaLearningSummary(conn, 10);
  const byId = new Map(summary.recentCourses.map(c => [c.resourceId, c]));
  // ORDER BY updated_at DESC is unchanged.
  expect(summary.recentCourses.slice(0, 6).map(c => c.resourceId)).toEqual(
    ['wp163_max', 'wp163_plain', 'wp163_119999', 'wp163_60000', 'wp163_59999', 'wp163_n2']);
  // R2 N2: the old Number projection gave Math.floor(9007199254800000 / 60000) = 150119987580.
  expect(Math.floor(Number(9_007_199_254_799_999n) / 60_000)).toBe(150_119_987_580);
  expect(byId.get('wp163_n2')!.watchedMinutes).toBe(150_119_987_579);
  expect(byId.get('wp163_59999')!.watchedMinutes).toBe(0);
  expect(byId.get('wp163_60000')!.watchedMinutes).toBe(1);
  expect(byId.get('wp163_119999')!.watchedMinutes).toBe(1);
  const max = byId.get('wp163_max')!;
  expect(max.watchedMinutes).toBe(Number(I64_MAX / 60_000n));
  expect(max.watchedMinutes).toBe(153_722_867_280_912);
  // Other i64 columns keep their existing projections: u32 saturation of seconds, f64 lastWatchedAt.
  expect(max.position).toBe('1193046:28:15');
  expect(max.positionRef).toBe('[媒体@wp163_max:1193046:28:15]');
  expect(max.duration).toBe('1193046:28:15');
  expect(max.lastWatchedAt).toBe(Number(I64_MAX));
  expect(typeof max.lastWatchedAt).toBe('number');
  expect(max.finished).toBe(false);
  expect(byId.get('wp163_n2')!.duration).toBeNull();
  expect(byId.get('wp163_n2')!.lastWatchedAt).toBe(1_759_640_000_001);
  const plain = byId.get('wp163_plain')!;
  expect([plain.watchedMinutes, plain.position, plain.duration]).toEqual([32, '25:10', '48:00']);
});
