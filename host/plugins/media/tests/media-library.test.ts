import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { listMediaLibrary, listMediaRelatedNotes } from '../src/media-library.ts';
import { parseLibraryTimestamp } from '../src/media-library.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-library-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-library-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
}, 60_000);
afterEach(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

function insertFile(
  id: string,
  name: string,
  mime: string | null,
  fileType: string,
  updatedAt: string,
): void {
  conn.run(
    `INSERT INTO files (id, sha256, file_name, size, mime_type, type, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1000, ?4, ?5, 'active', ?6, ?6)`,
    [id, `sha_${id}`, name, mime, fileType, updatedAt],
  );
}

function noteWithOrigin(title: string, origin: unknown): string {
  const id = `note_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const resourceId = `res_${id}`;
  conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES (?1, ?2, 'note', 'inline', '', 0, 1, 1)`,
    [resourceId, `hash_${id}`],
  );
  const props = origin === null ? null : JSON.stringify({
    _origin: JSON.stringify(origin),
    课程: 'ML',
  });
  conn.run(
    `INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props)
     VALUES (?1, ?2, ?3, '[]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, ?4)`,
    [id, resourceId, title, props],
  );
  return id;
}

it('lists_only_live_audio_video_files', () => {
  const t = '2026-10-01T00:00:00Z';
  insertFile('file_a', 'talk.mp3', 'audio/mpeg', 'audio', t);
  insertFile('file_v', 'lecture.mkv', 'application/octet-stream', 'document', t);
  insertFile('file_pdf', 'book.pdf', 'application/pdf', 'document', t);
  insertFile('file_img', 'a.png', 'image/png', 'image', t);
  insertFile('file_gone', 'old.mp4', 'video/mp4', 'video', t);
  conn.run("UPDATE files SET status = 'deleted', deleted_at = ?1 WHERE id = 'file_gone'", [t]);

  const items = listMediaLibrary(database);
  expect(items.map(item => item.id).sort()).toEqual(['file_a', 'file_v']);
  const audio = items.find(item => item.id === 'file_a')!;
  const video = items.find(item => item.id === 'file_v')!;
  expect(audio.kind).toBe('audio');
  expect(video.kind).toBe('video');
  expect(audio.transcript.status).toBe('none');
  expect(audio.durationMs).toBeNull();
  expect(audio.progress).toEqual({ lastPositionMs: 0, watchedMs: 0, finished: false });
  expect(audio.lastWatchedAt).toBeNull();
  expect(audio.handoutCount).toBe(0);
  expect(audio.createdAt).toBe(parseLibraryTimestamp(t));
  expect(audio.folderPath).toEqual([]);
  expect(audio.transcript.completedSegments).toBe(0);
  expect(audio.progress.lastPositionMs).toBe(0);
  expect(audio.mimeType).toBe('audio/mpeg');

  expect(listMediaLibrary(database, { limit: 1 })).toHaveLength(1);
});

it('transcript_status_matches_transcript_get_vocabulary', () => {
  const t = '2026-10-01T00:00:00Z';
  for (const id of ['file_none', 'file_partial', 'file_done', 'file_run', 'file_err']) {
    insertFile(id, 'x.wav', 'audio/wav', 'audio', t);
  }
  const insertSegment = (resource: string, idx: number, status: number, source: string, text = ''): void => {
    conn.run(
      `INSERT INTO media_transcript_segments
       (resource_id, idx, start_ms, end_ms, text, status, source, plan_version, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 1)`,
      [resource, idx, idx * 1000, idx * 1000 + 900, text, status, source],
    );
  };
  for (let idx = 0; idx < 4; idx += 1) insertSegment('file_partial', idx, 0, 'asr');
  conn.run("UPDATE media_transcript_segments SET status = 1, text = 'a' WHERE resource_id = 'file_partial' AND idx = 0");
  conn.run("UPDATE media_transcript_segments SET status = 1, text = 'b' WHERE resource_id = 'file_partial' AND idx = 1");
  conn.run("UPDATE files SET processing_status = 'asr' WHERE id = 'file_partial'");
  insertSegment('file_done', 0, 1, 'import', 'hi');
  conn.run("UPDATE files SET processing_status = 'asr' WHERE id = 'file_run'");
  conn.run("UPDATE files SET processing_status = 'error' WHERE id = 'file_err'");

  const items = listMediaLibrary(database, { isRunning: id => id === 'file_run' });
  const byId = (id: string) => items.find(item => item.id === id)!;
  expect(byId('file_none').transcript.status).toBe('none');
  const partial = byId('file_partial').transcript;
  expect(partial.status).toBe('partial');
  expect([partial.completedSegments, partial.totalSegments, partial.failedSegments])
    .toEqual([2, 4, 0]);
  expect(partial.source).toBe('asr');
  expect(byId('file_done').transcript.status).toBe('completed');
  expect(byId('file_done').transcript.source).toBe('import');
  expect(byId('file_run').transcript.status).toBe('running');
  expect(byId('file_err').transcript.status).toBe('error');
  expect(byId('file_none').transcript.source).toBeNull();
});

it('progress_duration_and_sort_by_recent_activity', () => {
  insertFile('file_old', 'o.mp3', 'audio/mpeg', 'audio', '2020-01-01T00:00:00Z');
  insertFile('file_mid', 'm.mp3', 'audio/mpeg', 'audio', '2021-01-01T00:00:00Z');
  insertFile('file_new', 'n.mp4', 'video/mp4', 'video', '2022-01-01T00:00:00Z');
  conn.run(
    `INSERT INTO media_progress
     (resource_id, last_position_ms, duration_ms, watched_ms, finished, updated_at)
     VALUES ('file_old', 30000, 100000, 20000, 0, 2000000000000)`,
  );
  conn.run(
    `INSERT INTO media_progress (resource_id, duration_ms, updated_at)
     VALUES ('file_mid', 42000, 2000000000000)`,
  );

  const items = listMediaLibrary(database);
  expect(items.map(item => item.id)).toEqual(['file_old', 'file_new', 'file_mid']);
  const old = items[0]!;
  expect(old.durationMs).toBe(100_000);
  expect(old.progress).toEqual({ lastPositionMs: 30_000, watchedMs: 20_000, finished: false });
  expect(old.lastWatchedAt).not.toBeNull();
  expect(old.lastActivityAt).toBe(old.lastWatchedAt);
  const mid = items[2]!;
  expect(mid.durationMs).toBe(42_000);
  expect(mid.lastWatchedAt).toBeNull();
  expect(mid.lastActivityAt).toBe(mid.updatedAt);
});

it('folder_path_is_resolved', () => {
  insertFile('file_a', 'a.mp3', 'audio/mpeg', 'audio', '2026-01-01T00:00:00Z');
  conn.exec(
    `INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES ('fld_root', NULL, '课程', 1, 1);
     INSERT INTO folders (id, parent_id, title, created_at, updated_at) VALUES ('fld_sub', 'fld_root', '第一周', 1, 1);
     INSERT INTO folder_items (id, folder_id, item_type, item_id, created_at) VALUES ('fi_1', 'fld_sub', 'file', 'file_a', 1);`,
  );
  const items = listMediaLibrary(database);
  expect(items[0]!.folderId).toBe('fld_sub');
  expect(items[0]!.folderName).toBe('第一周');
  expect(items[0]!.folderPath).toEqual(['课程', '第一周']);
});

it('related_notes_match_exactly_and_skip_deleted', () => {
  insertFile('file_abc', 'a.mp3', 'audio/mpeg', 'audio', '2026-01-01T00:00:00Z');
  insertFile('file_abcd', 'b.mp3', 'audio/mpeg', 'audio', '2026-01-01T00:00:00Z');
  conn.run('UPDATE files SET resource_id = NULL');

  const origin = (id: string): Record<string, string> =>
    ({ kind: 'resource', resourceId: id, title: '讲座' });
  const n1 = noteWithOrigin('讲义一', origin('file_abc'));
  const n2 = noteWithOrigin('讲义二', origin('file_abc'));
  const other = noteWithOrigin('别的', origin('file_abcd'));
  noteWithOrigin('对话', { kind: 'chat', sessionId: 'file_abc' });
  noteWithOrigin('无来源', null);
  const deleted = noteWithOrigin('已删', origin('file_abc'));
  conn.run('UPDATE notes SET deleted_at = 1 WHERE id = ?1', [deleted]);
  conn.run("UPDATE notes SET props = '{\"_origin\":\"not json\"}' WHERE id = ?1", [other]);
  conn.run("UPDATE notes SET updated_at = '2030-01-01T00:00:00Z' WHERE id = ?1", [n2]);

  const notes = listMediaRelatedNotes(database, 'file_abc');
  expect(notes.map(note => note.id)).toEqual([n2, n1]);
  expect(notes[1]!.title).toBe('讲义一');
  expect(listMediaRelatedNotes(database, 'file_abcd')).toEqual([]);
  expect(listMediaRelatedNotes(database, 'file_ab')).toEqual([]);

  const items = listMediaLibrary(database);
  expect(items.find(item => item.id === 'file_abc')!.handoutCount).toBe(2);
  expect(items.find(item => item.id === 'file_abcd')!.handoutCount).toBe(0);
});

it('related_notes_accept_res_id_alias', () => {
  insertFile('file_x', 'x.mp4', 'video/mp4', 'video', '2026-01-01T00:00:00Z');
  conn.run(
    `INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
     VALUES ('res_x', 'hash_res_x', 'file', 'inline', '', 0, 1, 1)`,
  );
  conn.run("UPDATE files SET resource_id = 'res_x' WHERE id = 'file_x'");

  const byRes = noteWithOrigin('按 res 记录', { kind: 'resource', resourceId: 'res_x' });
  const byFile = noteWithOrigin('按 file 记录', { kind: 'resource', resourceId: 'file_x' });
  const ids = listMediaRelatedNotes(database, 'file_x').map(note => note.id).sort();
  expect(ids).toEqual([byRes, byFile].sort());
  expect(listMediaRelatedNotes(database, 'res_x')).toHaveLength(2);
  const items = listMediaLibrary(database);
  expect(items[0]!.handoutCount).toBe(2);
  expect(() => listMediaRelatedNotes(database, '  ')).toThrowError('resourceId 不能为空');
});
