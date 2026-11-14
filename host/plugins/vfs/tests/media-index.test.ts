import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Message } from '@deepseek-ai/cordis';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { audio as nativeAudio } from '../../../platform/native/audio/index.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { FusedRetrievalHit } from '../../vfs-index/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install real table owners
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install real table owners
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: verify the real L18 transcriber consumes the public VFS refresh service
import mediaPlugin from '../../media/index.ts';
import { vfsRepositories } from '../repository/services.ts';
import { buildWindows, formatMediaTimestamp, mediaCitation, segmentMetadataJson, timeRangeFromMetadata } from '../src/media-index.ts';

const line = (start: number, end: number, text: string) => ({ startMs: start * 1000, endMs: end * 1000, text });
it('timestamps_switch_to_hours_after_one_hour', () => {
  expect(formatMediaTimestamp(0)).toBe('00:00');
  expect(formatMediaTimestamp(90500)).toBe('01:30');
  expect(formatMediaTimestamp(3725000)).toBe('1:02:05');
  expect(mediaCitation('file_a', 75000)).toBe('[媒体@file_a:01:15]');
});
it('windows_close_at_ninety_seconds', () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(i * 20, i * 20 + 15, `第${i}段`));
  const windows = buildWindows(lines);
  expect(windows).toHaveLength(3);
  expect(windows[0]!.range).toEqual({ startMs: 0, endMs: 75000 });
  expect(windows[1]!.range.startMs).toBe(80000);
  expect(windows[0]!.text.startsWith('[00:00] 第0段\n[00:20] 第1段')).toBe(true);
  expect(buildWindows(lines)).toEqual(windows);
});
it('windows_close_at_char_budget_and_skip_empty_lines', () => {
  const long = '字'.repeat(500);
  const windows = buildWindows([line(0, 5, long), line(5, 6, '   '), line(6, 10, long), line(10, 12, '尾巴')]);
  expect(windows).toHaveLength(2);
  expect(windows[1]!.range).toEqual({ startMs: 6000, endMs: 12000 });
});
it('metadata_round_trips_deterministically', () => {
  const range = { startMs: 90000, endMs: 180000 };
  expect(segmentMetadataJson(range)).toBe('{"startMs":90000,"endMs":180000}');
  expect(timeRangeFromMetadata(JSON.parse(segmentMetadataJson(range)))).toEqual(range);
  expect(timeRangeFromMetadata(null)).toBeNull();
});

let template: string, root: string, host: TestHost, db: DatabaseHandle;
let storage: ReturnType<typeof createStorageService>;
beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'media-index-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try { const report = await source.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true); }
  finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-index-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const settings = createSettingsService({ db: () => storage.database('mistakes'),
    secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin],
    provide: { storage, settings, nativeAudio }, app: { dataDir: root } });
  db = storage.database('vfs');
  db.run(`INSERT INTO resources(id, hash, type, source_id, source_table, storage_mode, metadata_json, created_at, updated_at)
    VALUES ('res_media','hash_media','file','file_media','files','external','{"title":"信号与系统 第3讲"}',0,0)`);
  db.run(`INSERT INTO files(id,resource_id,sha256,file_name,size,type,mime_type,created_at,updated_at)
    VALUES ('file_media','res_media','sha_media','lecture.mp4',1,'video','video/mp4','0','0')`);
  const topics = ['今天讲傅里叶级数', '周期信号可以展开', '正交基的概念', '系数的计算方法', '接下来介绍卷积定理', '时域卷积对应频域乘积', '例题一', '下课'];
  vfsRepositories().mediaTranscripts.setImportedSegments(db, 'file_media', topics.map((text, i) => [
    { startMs: i * 30000, endMs: i * 30000 + 28000 }, text,
  ]));
}, 60_000);
afterEach(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });

it('transcript_files_index_as_time_window_units', () => {
  const index = host.ctx.vfs.unitIndex, media = host.ctx.vfs.mediaIndex;
  const input = { resourceId: 'res_media', resourceType: 'file', extractedText: '旧的整段转写' };
  const units = index.syncResourceUnits(input);
  expect(units).toHaveLength(3);
  expect(units.every(unit => unit.textSource === 'transcript')).toBe(true);
  expect(units[1]!.textContent).toContain('[02:00] 接下来介绍卷积定理');
  const again = index.syncResourceUnits(input);
  expect(again.map(u => u.id)).toEqual(units.map(u => u.id));
  expect(again.map(u => u.contentHash)).toEqual(units.map(u => u.contentHash));
  expect(media.rangeForUnit(media.unitTimeRanges(db, 'res_media'), 1)).toEqual({ startMs: 90000, endMs: 178000 });
});
it('refresh_after_transcript_change_rebuilds_lexical_units', () => {
  const refresh = (id: string) => host.ctx.vfs.mediaIndex.refreshTranscriptIndex(host.ctx.vfsDatabase, host.ctx.vfs.unitIndex, id);
  expect(refresh('file_media')).toBe(3);
  expect(refresh('file_unknown')).toBe(0);
  vfsRepositories().mediaTranscripts.deleteSegments(db, 'file_media');
  expect(refresh('file_media')).toBe(0);
});

it('mediaTranscriber refreshes transcript windows through the published vfs service', async () => {
  await host.install(mediaPlugin);
  const stages: string[] = [];
  const result = await host.ctx.mediaTranscriber.transcribe({ fileId: 'file_media', tempDir: root,
    imported: true, signal: new AbortController().signal, onProgress: update => { stages.push(update.stage); } });
  expect(result).toMatchObject({ doneSegments: 8, totalSegments: 8, failedSegments: 0 });
  expect(stages).toEqual(['queued']);
  const units = host.ctx.vfsRepo.embeddingUnits.getByResource(db, 'res_media');
  expect(units).toHaveLength(3);
  expect(units.every(unit => unit.textSource === 'transcript')).toBe(true);
  expect(units[1]!.textContent).toContain('[02:00] 接下来介绍卷积定理');
  expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', ['res_media'])).toBe('pending');

  host.ctx.vfsRepo.mediaTranscripts.setImportedSegments(db, 'file_media', [
    [{ startMs: 0, endMs: 1000 }, '新字幕'],
  ]);
  await host.ctx.mediaTranscriber.transcribe({ fileId: 'file_media', tempDir: root,
    imported: true, signal: new AbortController().signal, onProgress: () => {} });
  const refreshed = host.ctx.vfsRepo.embeddingUnits.getByResource(db, 'res_media');
  expect(refreshed).toHaveLength(1);
  expect(refreshed[0]!.textContent).toBe('[00:00] 新字幕');
});

it('mediaTranscriber preserves transcript success when the real index refresh fails', async () => {
  const logs: Message[] = [];
  // Cordis' default buffer exports through INFO (1); capture WARN (2) explicitly.
  // This exporter is disposed with the test host and does not replace the logger.
  host.ctx.logger.exporter({ levels: { default: 3 }, export: message => { logs.push(message); } });
  await host.install(mediaPlugin);
  db.exec(`CREATE TRIGGER reject_transcript_units BEFORE INSERT ON vfs_index_units
    BEGIN SELECT RAISE(ABORT, 'index refresh rejected'); END;`);
  const result = await host.ctx.mediaTranscriber.transcribe({ fileId: 'file_media', tempDir: root,
    imported: true, signal: new AbortController().signal, onProgress: () => {} });
  expect(result).toMatchObject({ doneSegments: 8, failedSegments: 0 });
  expect(db.pluck<string>('SELECT extracted_text FROM files WHERE id = ?1', ['file_media']))
    .toContain('[00:00] 今天讲傅里叶级数');
  expect(host.ctx.vfsRepo.embeddingUnits.getByResource(db, 'res_media')).toEqual([]);
  expect(logs).toContainEqual(expect.objectContaining({
    name: 'media.commands', type: 'warn', level: 2,
    args: ['[media::pipeline] refresh transcript index failed for %s: %s',
      'file_media', expect.stringContaining('index refresh rejected')],
  }));
});
it('media_hits_get_time_range_and_file_source_id', () => {
  const hit = (pageIndex: number | null, metadata: unknown): FusedRetrievalHit => ({
    hit: { identity: { resourceId: 'res_media', chunkIndex: 0, pageIndex, timeRange: null },
      embeddingId: 'unit:x', text: '卷积', title: null, resourceType: 'file', sourceId: null,
      folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata },
    rrfScore: 1, normalizedScore: null, rerankScore: null, provenance: [],
  });
  const hits = [hit(1, null), hit(null, { startMs: 150000, endMs: 178000 }), hit(null, null)];
  host.ctx.vfs.mediaIndex.attachMediaTimeRanges(host.ctx.vfsDatabase, hits, host.ctx.logger);
  expect(hits[0]!.hit.identity.timeRange).toEqual({ startMs: 90000, endMs: 178000 });
  expect(hits[0]!.hit.sourceId).toBe('file_media');
  expect(hits[1]!.hit.identity.timeRange?.startMs).toBe(150000);
  expect(hits[2]!.hit.identity.timeRange).toBeNull();
  expect(mediaCitation('file_media', hits[0]!.hit.identity.timeRange!.startMs)).toBe('[媒体@file_media:01:30]');
});
it('transcript_reads_are_capped_at_ten_minutes', () => {
  const media = host.ctx.vfs.mediaIndex;
  const read = media.readTranscriptRange(db, 'file_media', 60, 125)!;
  expect(read.content).toBe('[01:00] 正交基的概念\n[01:30] 系数的计算方法\n[02:00] 接下来介绍卷积定理');
  expect(read.truncated).toBe(false);
  const long = media.readTranscriptRange(db, 'file_media', 0, 3600)!;
  expect(long.truncated).toBe(true);
  expect(long.range.endMs).toBe(600000);
  expect(long.lineCount).toBe(8);
  expect(media.readTranscriptRange(db, 'file_none')).toBeNull();
});
