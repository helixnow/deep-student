import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { writeZip } from '../../../platform/util/node.ts';
import { deserializeCorpusManifest, hashTransformParams } from '../../agent-skills/api.ts';
import { artifactRoot, tempRoot } from '../../agent-workspace/api.ts';
import plugin from '../index.ts';
import { databaseFixture } from './database-fixture.ts';
import {
  MAX_AUTO_STAGE_ITEMS, MAX_CORPUS_ITEMS, MAX_FILE_NAME_CHARS, MAX_STAGE_BYTES, STAGE_INDEX_FILE, STAGE_SUBDIR,
  checkStageSize, decodeBase64Payload, loadStageIndex, sanitizeFileName, scanArchiveForStage, scanStagedArchiveOrCleanup,
  scanZipArchive, stagePayloadIntoTempRoot,
} from '../src/attachment-stage.ts';
import { setChatLocalFs } from '../src/local-fs.ts';
import { nodeChatLocalFs } from '../src/local-fs.node.ts';

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => Buffer.from(text, 'latin1');
const stageBytes = (root: string, name: string, data: Uint8Array) => stagePayloadIntoTempRoot(root, name, { kind: 'bytes', data });

interface FakeFile { name: string; mimeType: string; source?: { kind: 'base64'; data: string } | { kind: 'file'; path: string }; inline?: string | null }

describe('attachment_stage_executor.rs owned helpers (Rust unit tests)', () => {
  // 附件暂存走同步文件端口；纯 helper 用例不建 host，这里直接装桌面入口注入的 `node:fs` 实现。
  beforeAll(() => { setChatLocalFs(nodeChatLocalFs); });
  afterAll(() => { setChatLocalFs(null); });
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'stage-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const zip = (file: string, entries: [string, string][]) =>
    writeFileSync(file, writeZip(entries.map(([name, data]) => ({ name, data: bytes(data), options: { compression: 'stored' } }))));

  it('corpus_ceiling_covers_first_page', () => { expect(MAX_CORPUS_ITEMS).toBeGreaterThanOrEqual(MAX_AUTO_STAGE_ITEMS); });
  it('sanitizes_illegal_characters_and_separators', () => {
    expect(sanitizeFileName('report.xlsx')).toBe('report.xlsx');
    expect(sanitizeFileName('a<b>:c"d.txt')).toBe('a_b__c_d.txt');
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('dir\\evil.zip')).toBe('dir_evil.zip');
    expect(sanitizeFileName('期末 复习.pdf')).toBe('期末 复习.pdf');
  });
  it('sanitizes_empty_and_dot_only_names_to_fallback', () => {
    for (const raw of ['', '   ', '...', '..']) expect(sanitizeFileName(raw)).toBe('attachment');
  });
  it('truncates_overlong_names_preserving_extension', () => {
    const name = sanitizeFileName(`${'很'.repeat(300)}.xlsx`);
    expect(Array.from(name).length).toBeLessThanOrEqual(MAX_FILE_NAME_CHARS);
    expect(name.endsWith('.xlsx')).toBe(true);
  });
  it('rejects_oversized_payloads', () => {
    expect(() => checkStageSize(MAX_STAGE_BYTES)).not.toThrow();
    expect(() => checkStageSize(MAX_STAGE_BYTES + 1)).toThrow('256 MB');
    expect(() => checkStageSize(18446744073709551615n)).toThrow();
  });
  it('zip_scan_returns_bounded_safe_manifest', () => {
    const file = join(dir, 'bundle.zip'); zip(file, [['docs/readme.txt', 'hello'], ['data.csv', 'a,b']]);
    const manifest = scanZipArchive(file);
    expect(manifest).toMatchObject({ format: 'zip', scanned: true, safeToExtract: true, entryCount: 2, totalUncompressedBytes: 8 });
  });
  it('zip_scan_rejects_parent_traversal', () => {
    const file = join(dir, 'unsafe.zip'); zip(file, [['../outside.txt', 'escape']]);
    expect(() => scanZipArchive(file)).toThrow('unsafe path');
  });
  it('rar_and_7z_are_signature_checked_but_not_claimed_as_scanned', () => {
    const rar = join(dir, 'bundle.rar'); writeFileSync(rar, bytes('Rar!\x1a\x07\x01\x00payload'));
    expect(scanArchiveForStage(rar, 'bundle.rar', 'application/vnd.rar')).toMatchObject({ scanned: false, safeToExtract: false });
    const fake = join(dir, 'fake.7z'); writeFileSync(fake, 'not-7z');
    expect(() => scanArchiveForStage(fake, 'fake.7z', 'application/x-7z-compressed')).toThrow();
  });
  it('rejected_new_archive_is_removed_with_its_index_entry', () => {
    const staged = stageBytes(dir, 'fake.zip', bytes('not-a-zip'));
    expect(() => scanStagedArchiveOrCleanup(dir, staged, 'fake.zip', 'application/zip')).toThrow('signature');
    expect(existsSync(join(dir, staged.relativePath))).toBe(false);
    expect(loadStageIndex(join(dir, STAGE_SUBDIR)).has(staged.sha256)).toBe(false);
  });
  it('stages_bytes_under_attachments_subdir_with_forward_slashes', () => {
    const staged = stageBytes(dir, 'data.xlsx', bytes('binary-bytes'));
    expect(staged).toEqual({ relativePath: 'attachments/data.xlsx', sizeBytes: 12, sha256: sha('binary-bytes'), reused: false });
    expect(readFileSync(join(dir, 'attachments', 'data.xlsx'), 'latin1')).toBe('binary-bytes');
  });
  it('dedupes_same_content_even_with_different_requested_name', () => {
    const first = stageBytes(dir, 'a.zip', bytes('same content'));
    const second = stageBytes(dir, 'b.zip', bytes('same content'));
    expect(first.reused).toBe(false); expect(second.reused).toBe(true);
    expect(second.relativePath).toBe(first.relativePath); expect(second.sha256).toBe(first.sha256);
  });
  it('same_name_different_content_gets_numeric_suffix', () => {
    expect(stageBytes(dir, 'notes.txt', bytes('v1')).relativePath).toBe('attachments/notes.txt');
    expect(stageBytes(dir, 'notes.txt', bytes('v2')).relativePath).toBe('attachments/notes_1.txt');
    expect(readFileSync(join(dir, 'attachments', 'notes.txt'), 'latin1')).toBe('v1');
    expect(readFileSync(join(dir, 'attachments', 'notes_1.txt'), 'latin1')).toBe('v2');
  });
  it('same_name_same_content_reuses_existing_file_without_index', () => {
    const first = stageBytes(dir, 'report.pdf', bytes('pdf!'));
    rmSync(join(dir, 'attachments', STAGE_INDEX_FILE));
    const second = stageBytes(dir, 'report.pdf', bytes('pdf!'));
    expect(second.reused).toBe(true); expect(second.relativePath).toBe(first.relativePath);
  });
  it('escape_attempts_stay_inside_temp_root', () => {
    const staged = stageBytes(dir, '../../escape.bin', bytes('x'));
    expect(staged.relativePath.startsWith('attachments/')).toBe(true);
    expect(existsSync(join(dir, staged.relativePath))).toBe(true);
    expect(existsSync(join(dir, '..', 'escape.bin'))).toBe(false);
  });
  it('decodes_data_urls_and_plain_base64', () => {
    expect(Buffer.from(decodeBase64Payload('data:text/plain;base64,SGVsbG8=')).toString()).toBe('Hello');
    expect(Buffer.from(decodeBase64Payload('SGVsbG8=')).toString()).toBe('Hello');
    expect(() => decodeBase64Payload('data:no-comma')).toThrow();
    expect(() => decodeBase64Payload('!!!not-base64!!!')).toThrow();
    expect(() => decodeBase64Payload('SGVsbG8=', 4)).toThrow('too large');
  });
  it('stages_disk_file_via_copy', () => {
    const source = join(dir, 'source-report.xlsx'); writeFileSync(source, 'xlsx-binary');
    const root = join(dir, 'temp'); mkdirSync(root);
    const staged = stagePayloadIntoTempRoot(root, 'report.xlsx', { kind: 'disk', path: source });
    expect(staged.relativePath).toBe('attachments/report.xlsx'); expect(staged.reused).toBe(false);
    expect(readFileSync(join(root, 'attachments', 'report.xlsx'), 'latin1')).toBe('xlsx-binary');
  });
  it('rejects_oversized_sparse_disk_source_before_copying', () => {
    const source = join(dir, 'oversized.bin'); writeFileSync(source, ''); truncateSync(source, MAX_STAGE_BYTES + 1);
    const root = join(dir, 'temp'); mkdirSync(root);
    expect(() => stagePayloadIntoTempRoot(root, 'oversized.bin', { kind: 'disk', path: source })).toThrow('256 MB');
    expect(existsSync(join(root, 'attachments', 'oversized.bin'))).toBe(false);
  });
  it('index_hit_revalidates_same_length_file_hash', () => {
    const first = stageBytes(dir, 'report.bin', bytes('original'));
    writeFileSync(join(dir, first.relativePath), 'tampered');
    const second = stageBytes(dir, 'report.bin', bytes('original'));
    expect(second.reused).toBe(false); expect(second.relativePath).toBe('attachments/report_1.bin');
    expect(readFileSync(join(dir, second.relativePath), 'latin1')).toBe('original');
  });
  it('stage_index_rejects_non_plain_file_names', () => {
    const stageDir = join(dir, STAGE_SUBDIR); mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, STAGE_INDEX_FILE), JSON.stringify({ ['a'.repeat(64)]: '../outside.bin' }));
    expect(loadStageIndex(stageDir).size).toBe(0);
  });
});

describe('chat_v2_stage_context_attachments via host.invoke', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let files: Map<string, FakeFile>;
  let blobs: string;
  beforeEach(async () => {
    f = databaseFixture(); files = new Map(); blobs = mkdtempSync(join(tmpdir(), 'stage-blobs-'));
    const conn = { fake: 'vfs-conn' };
    const attachments = {
      getById: (c: unknown, id: string) => { expect(c).toBe(conn); const file = files.get(id);
        return file === undefined ? null : { id, name: file.name, mimeType: file.mimeType }; },
      getContentSource: (_c: unknown, dirArg: string, id: string) => { expect(dirArg).toBe(blobs); return files.get(id)?.source ?? null; },
      getInlineDataWithConn: (_c: unknown, id: string) => files.get(id)?.inline ?? null,
    };
    host = await createTestHost({ plugins: [plugin], provide: { storage: f.storage,
      vfs: { version: 1, database: { getConnSafe: () => conn, blobsDir: () => blobs } }, vfsRepo: { attachments } } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); rmSync(blobs, { recursive: true, force: true }); });
  const invoke = (sessionId: string, items: unknown[]) =>
    host.invoke<Record<string, any>>('chat_v2_stage_context_attachments', { sessionId, items });

  it('rejects blank session ids before staging', async () => {
    await expect(invoke('  ', [])).rejects.toBe('sessionId is required for attachment materialization');
  });

  it('rejects batches above the corpus ceiling without staging anything', async () => {
    const items = Array.from({ length: MAX_CORPUS_ITEMS + 1 }, (_, i) => ({ resourceId: `res_${i}`, sourceId: `file_${i}`, displayName: '' }));
    await expect(invoke('sess_ceiling', items)).rejects.toBe(`Too many context attachments: ${MAX_CORPUS_ITEMS + 1} exceeds the ${MAX_CORPUS_ITEMS} item corpus ceiling. Split the batch and retry; no items were staged or silently dropped.`);
    expect(existsSync(tempRoot(host.ctx.app.dataDir, 'sess_ceiling', false).path)).toBe(false);
  });

  it('stages base64, disk and legacy inline text sources and records per-item failures', async () => {
    files.set('file_b64', { name: 'data.bin', mimeType: 'application/octet-stream', source: { kind: 'base64', data: 'aGVsbG8=' } });
    const disk = join(blobs, 'blob'); writeFileSync(disk, 'xlsx-binary');
    files.set('file_disk', { name: 'report.xlsx', mimeType: '', source: { kind: 'file', path: disk } });
    files.set('file_legacy_text', { name: 'legacy.txt', mimeType: 'text/plain', inline: 'legacy plain text' });
    files.set('file_empty', { name: 'empty.txt', mimeType: 'text/plain', inline: '' });
    const result = await invoke('sess_stage', [
      { resourceId: 'res_b64', sourceId: 'file_b64', displayName: ' renamed.bin ' },
      { resourceId: 'res_disk', sourceId: 'file_disk', displayName: '' },
      { resourceId: 'res_legacy', sourceId: 'file_legacy_text', displayName: '' },
      { resourceId: 'res_missing', sourceId: 'file_missing', displayName: 'x' },
      { resourceId: 'res_empty', sourceId: 'file_empty', displayName: '' },
    ]);
    expect(result).toMatchObject({ expectedItems: 5, observedItems: 5, coverageComplete: true, truncated: false });
    expect(result.corpusManifest).toBeUndefined();
    expect(result.failures).toEqual([
      { resourceId: 'res_missing', sourceId: 'file_missing', error: 'Attachment source not found in VFS: file_missing' },
      { resourceId: 'res_empty', sourceId: 'file_empty', error: 'Attachment file_empty has no raw content available in VFS' },
    ]);
    const [b64, diskItem, legacy] = result.attachments;
    expect(b64).toMatchObject({ resourceId: 'res_b64', sourceId: 'file_b64', rootId: 'temp', relativePath: 'attachments/renamed.bin',
      sizeBytes: 5, sha256: sha('hello'), reused: false, mediaType: 'application/octet-stream' });
    expect(diskItem.relativePath).toBe('attachments/report.xlsx'); expect(diskItem.mediaType).toBeUndefined();
    expect(legacy.sha256).toBe(sha('legacy plain text'));
    const handle = b64.objectHandle;
    expect(handle).toMatchObject({ handleId: `attachment:file_b64:${sha('hello')}`, kind: 'file', displayName: 'data.bin',
      sizeBytes: 5, sha256: sha('hello'), locator: { rootId: 'temp', relativePath: 'attachments/renamed.bin' },
      capabilities: { readable: true, materializable: true, writable: false, shareable: false, sendable: false, deletable: false } });
    expect(handle.provenance.source).toBe('chat_context_ref'); expect(handle.provenance.tool).toBe('send_time_attachment_stage');
    const paramsHash = hashTransformParams({ resource_id: 'res_b64', source_id: 'file_b64', display_name: ' renamed.bin ' });
    expect(handle.provenance.derivedFrom.map((e: any) => [e.sourceHandleId, e.transformId, e.transformParamsHash]))
      .toEqual([['res_b64', 'attachment.stage_context', paramsHash], ['file_b64', 'attachment.stage_context', paramsHash]]);
    const again = await invoke('sess_stage', [{ resourceId: 'res_b64', sourceId: 'file_b64', displayName: 'other.bin' }]);
    expect(again.attachments[0]).toMatchObject({ relativePath: 'attachments/renamed.bin', reused: true });
  });

  it('rejects unsafe archives as item failures and removes the new staged file', async () => {
    files.set('file_zip', { name: 'bad.zip', mimeType: 'application/zip',
      source: { kind: 'base64', data: writeZip([{ name: '../outside.txt', data: bytes('escape') }]).toString('base64') } });
    const result = await invoke('sess_zip', [{ resourceId: 'res_zip', sourceId: 'file_zip', displayName: '' }]);
    expect(result.attachments).toEqual([]);
    expect(result.failures[0].error).toBe('Archive entry has unsafe path: ../outside.txt');
    expect(result.coverageComplete).toBe(true);
  });

  it('paginates above MAX_AUTO_STAGE_ITEMS into a corpus manifest under artifacts', async () => {
    const count = MAX_AUTO_STAGE_ITEMS + 2;
    const items = Array.from({ length: count }, (_, i) => {
      files.set(`file_${i}`, { name: `f${i}.txt`, mimeType: 'text/plain', source: { kind: 'base64', data: Buffer.from(`body ${i}`).toString('base64') } });
      return { resourceId: `res_${i}`, sourceId: `file_${i}`, displayName: '' };
    });
    const result = await invoke('sess_corpus', items);
    expect(result).toMatchObject({ expectedItems: count, observedItems: count, coverageComplete: true, truncated: true });
    expect(result.attachments).toHaveLength(MAX_AUTO_STAGE_ITEMS);
    const payload = result.corpusManifest;
    const manifest = deserializeCorpusManifest(payload.manifest);
    expect(manifest).toMatchObject({ totalCount: count, pageSize: MAX_AUTO_STAGE_ITEMS, sourceSessionId: 'sess_corpus' });
    expect(manifest.pages.map(p => p.objectHandles.length)).toEqual([MAX_AUTO_STAGE_ITEMS, 2]);
    const locator = payload.objectHandle.locator;
    expect(locator).toEqual({ rootId: 'artifacts', relativePath: `corpus/${manifest.manifestId}.json` });
    const written = readFileSync(join(artifactRoot(host.ctx.app.dataDir, 'sess_corpus', false).path, locator.relativePath));
    expect(payload.objectHandle.sizeBytes).toBe(written.length);
    expect(payload.objectHandle.sha256).toBe(sha(written));
    expect(written.toString('utf8').startsWith('{\n  "schemaVersion": 1,\n  "manifestId": ')).toBe(true);
    expect(JSON.parse(written.toString('utf8'))).toEqual(payload.manifest);
    expect(payload.modelNotice).toContain(`第 1 页 ${MAX_AUTO_STAGE_ITEMS} 个对象`);
    expect(payload.objectHandle).toMatchObject({ handleId: `corpus_manifest:${manifest.manifestId}`, kind: 'artifact',
      displayName: `corpus manifest (${count} objects)`, mediaType: 'application/json' });
    expect(payload.objectHandle.provenance.derivedFrom).toHaveLength(count);
  });
});
