import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
// boundary-allow cross-plugin-impl: 测试用 L11 真实仓储验证链接条目的原子写入
import { AttachmentRepo } from '../../vfs-repos/repository/attachments.ts';
// boundary-allow cross-plugin-impl: 同上；链接条目内容通过 files 仓储读取
import { FileRepo } from '../../vfs-repos/repository/files.ts';
// boundary-allow cross-plugin-impl: 同上；字幕段通过 mediaTranscripts 仓储写入/读取
import { MediaTranscriptRepo } from '../../vfs-repos/repository/media-transcripts.ts';
import type { BiliLinkDescriptor } from '../api.ts';
import { DESCRIPTOR_KIND, DESCRIPTOR_VERSION, pageUrl } from '../src/bilibili-links.ts';
import {
  findLinkItem, linkItemRepos, readLinkDescriptor, upsertLinkItem,
} from '../src/bilibili-link-items.ts';
import {
  buildTranscriptView, importSubtitle, isLinkItem, loadMediaFile,
} from '../src/media-commands.ts';
import { estimateImpl } from '../src/pipeline.ts';
import { listMediaLibrary } from '../src/media-library.ts';
import type { NativeAudio } from '../../../platform/native/api.ts';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let conn: DatabaseHandle;
let database: VfsDatabase;
let repos: VfsReposService;
let links: ReturnType<typeof linkItemRepos>;

const BCC = '{"type":"AIsubtitle","body":[{"from":0.5,"to":2.0,"content":"第一句"},'
  + '{"from":2.5,"to":4.0,"content":"第二句"}]}';

function settings() {
  return { get: () => null, save: () => undefined };
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-links-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-links-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  conn = storage.database('vfs');
  database = {
    getConnSafe: () => conn,
    blobsDir: () => path.join(root, 'vfs_blobs'),
  } as unknown as VfsDatabase;
  repos = {
    files: new FileRepo(),
    mediaTranscripts: new MediaTranscriptRepo(),
    attachments: new AttachmentRepo(),
  } as unknown as VfsReposService;
  links = linkItemRepos(repos);
}, 60_000);
afterEach(() => {
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

function descriptor(title: string, page: number, pageCount: number, part: string): BiliLinkDescriptor {
  return {
    kind: DESCRIPTOR_KIND,
    version: DESCRIPTOR_VERSION,
    bvid: 'BV1GJ411x7h7',
    aid: 80433022,
    cid: 137649199,
    page,
    pageCount,
    title,
    part,
    owner: 'UP',
    cover: 'http://i0.hdslb.com/bfs/archive/a.jpg',
    durationMs: 213_000,
    url: pageUrl('BV1GJ411x7h7', page),
  };
}

it('new_import_commits_subtitles_atomically_and_reimport_preserves_user_edits', () => {
  const first = descriptor('Atomic', 1, 1, '');
  const bytes = Buffer.from('{"body":[{"from":0,"to":1,"content":"first"}]}');
  const created = upsertLinkItem(database, links, first, bytes);
  expect(created.attachment).not.toBeNull();
  expect(repos.mediaTranscripts.listSegments(conn, created.info.fileId)[0]?.text).toBe('first');
  expect(conn.pluck<string>('SELECT extracted_text FROM files WHERE id = ?1',
    [created.info.fileId])).toBe('[00:00] first');

  const replacement = Buffer.from('{"body":[{"from":0,"to":1,"content":"replacement"}]}');
  upsertLinkItem(database, links, first, replacement);
  expect(repos.mediaTranscripts.listSegments(conn, created.info.fileId)[0]?.text).toBe('first');

  conn.exec("CREATE TRIGGER reject_bili_subtitle BEFORE INSERT ON media_transcript_segments BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  const second = { ...descriptor('Atomic', 1, 1, ''), bvid: 'BV1xx411c7mD' };
  expect(() => upsertLinkItem(database, links, second, bytes)).toThrow();
  expect(findLinkItem(database, links, second.bvid, 1)).toBeNull();
  expect(findLinkItem(database, links, first.bvid, 1)).toBe(created.info.fileId);
});

// bilibili.rs:1039-1047：新建条目在 upload finalize 回调连接内写 cues.join("\n") 原值，不改 updated_at。
it('new link item writes the joined cue text through the files owner inside finalize', () => {
  const created = upsertLinkItem(database, links, descriptor('Owner', 1, 1, ''), Buffer.from(BCC));
  const row = conn.get<{ extracted_text: string; updated_at: string; created_at: string }>(
    'SELECT extracted_text, updated_at, created_at FROM files WHERE id = ?1', [created.info.fileId])!;
  expect(row.extracted_text).toBe('[00:00] 第一句\n[00:02] 第二句');
  expect(row.updated_at).toBe(row.created_at);
});

// bilibili.rs:1002-1016：已有条目在 conn.transaction() 内写段与 extracted_text；UPDATE 失败整体回滚。
it('existing link item rolls back imported segments when the files owner rejects extracted_text', () => {
  const first = descriptor('Rollback', 1, 1, '');
  const created = upsertLinkItem(database, links, first);
  const fileId = created.info.fileId;
  conn.exec(`CREATE TRIGGER reject_bili_text BEFORE UPDATE OF extracted_text ON files
    BEGIN SELECT RAISE(ABORT, 'extracted_text rejected'); END;`);
  const before = conn.get("SELECT * FROM files WHERE id = ?1", [fileId]);

  expect(() => upsertLinkItem(database, links, first, Buffer.from(BCC)))
    .toThrow('extracted_text rejected');
  expect(repos.mediaTranscripts.listSegments(conn, fileId)).toEqual([]);
  expect(conn.get("SELECT * FROM files WHERE id = ?1", [fileId])).toEqual(before);

  conn.exec('DROP TRIGGER reject_bili_text');
  upsertLinkItem(database, links, first, Buffer.from(BCC));
  expect(repos.mediaTranscripts.listSegments(conn, fileId).map(segment => segment.text))
    .toEqual(['第一句', '第二句']);
  expect(conn.get("SELECT * FROM files WHERE id = ?1", [fileId]))
    .toEqual({ ...(before as object), extracted_text: '[00:00] 第一句\n[00:02] 第二句' });
});

// bilibili.rs:1027-1047：finalize 回调内 extracted_text 写失败时，新条目与段都不落库。
it('new link item is not created when the files owner rejects extracted_text in finalize', () => {
  conn.exec(`CREATE TRIGGER reject_bili_text BEFORE UPDATE OF extracted_text ON files
    BEGIN SELECT RAISE(ABORT, 'extracted_text rejected'); END;`);
  const fresh = { ...descriptor('Fresh', 1, 1, ''), bvid: 'BV1xx411c7mD' };
  expect(() => upsertLinkItem(database, links, fresh, Buffer.from(BCC)))
    .toThrow('extracted_text rejected');
  expect(findLinkItem(database, links, fresh.bvid, 1)).toBeNull();
  expect(conn.pluck<number>('SELECT COUNT(*) FROM media_transcript_segments')).toBe(0);
});

it('link_items_are_created_reused_and_never_decoded', async () => {
  const first = descriptor('线性代数', 1, 1, '');
  const created = upsertLinkItem(database, links, first);
  expect(created.attachment).not.toBeNull();
  expect(isLinkItem(created.info)).toBe(true);
  expect(created.info.fileName).toBe('线性代数.bilibili');
  expect(created.info.mimeType).toBe('video/x-bilibili');
  expect(readLinkDescriptor(conn, links, database.blobsDir(), created.info.fileId).bvid)
    .toBe('BV1GJ411x7h7');

  const audio = {} as NativeAudio;
  await expect(estimateImpl(database, repos, created.info, audio))
    .rejects.toMatchObject({ code: 'media-link-only' });

  const imported = importSubtitle(
    conn, repos.mediaTranscripts, repos.files, created.info, 'bilibili.json', Buffer.from(BCC));
  expect(imported).toBe(2);
  const view = buildTranscriptView(conn, repos.mediaTranscripts, created.info, false, true);
  expect(view.status).toBe('completed');
  expect(view.mediaType).toBe('video');
  expect(view.progress.durationMs).toBe(213_000);

  const renamed = descriptor('线性代数（重制）', 1, 1, '');
  const again = upsertLinkItem(database, links, renamed);
  expect(again.attachment).toBeNull();
  expect(again.info.fileId).toBe(created.info.fileId);
  const other = upsertLinkItem(database, links, descriptor('线性代数', 2, 2, '02'));
  expect(other.attachment).not.toBeNull();
  expect(other.info.fileId).not.toBe(created.info.fileId);

  const items = listMediaLibrary(database);
  const listed = items.find(item => item.id === created.info.fileId);
  expect(listed?.isLink).toBe(true);
  expect(listed?.kind).toBe('video');
  expect(listed?.transcript.source).toBe('import');
});
