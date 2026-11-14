import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { ContentBlock } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install the real owner plugins for command integration
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install the real owner plugins for command integration
import reposPlugin from '../../vfs-repos/index.ts';
import { vfsRepositories } from '../repository/services.ts';
import { escapeXml, formatPageQuestions } from '../src/exam-formatter.ts';

const cards = [
  { card_id: 'card_1', page_index: 0, question_label: '1', bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    ocr_text: '求 x + 2 = 5 的解', tags: ['代数'] },
  { card_id: 'card_2', page_index: 0, question_label: '2', bbox: { x: 0.1, y: 0.4, width: 0.3, height: 0.15 },
    ocr_text: '计算 3 × 4', tags: ['算术'] },
];
const preview = { temp_id: 'test_temp_id', exam_name: '期末考试', session_id: 'session_test',
  pages: [{ page_index: 0, blob_hash: 'abc123', width: 800, height: 1200, cards }] };

describe('exam_formatter.rs', () => {
  let template: string;
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let examId: string;
  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-format-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try { const result = await source.migrations.runAll(); expect(result.success, result.error ?? '').toBe(true); }
    finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-format-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
    examId = vfsRepositories().exams.createExamSheet(storage.database('vfs'), {
      examName: '期末考试', tempId: 'test_temp_id', metadataJson: {}, previewJson: preview,
    }).id;
  }, 60_000);
  afterEach(async () => { await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const format = (isMultimodal: boolean) => host.invoke<ContentBlock[]>('dstu_get_exam_content', { examId, isMultimodal });

  it('test_format_text_only', async () => {
    const blocks = await format(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('text');
    if (blocks[0]!.type !== 'text') throw new Error('Expected Text block');
    for (const fragment of ['<attached_exam_sheet', "exam_name='期末考试'", "<question label='1'",
      '求 x + 2 = 5 的解', '</attached_exam_sheet>']) expect(blocks[0]!.text).toContain(fragment);
    expect(blocks[0]!.text).toContain("bbox='0.100,0.200,0.300,0.100'");
  });
  it('test_escape_xml', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
    expect(escapeXml('a > b')).toBe('a &gt; b');
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml("a 'b' c")).toBe('a &apos;b&apos; c');
    expect(escapeXml('a "b" c')).toBe('a &quot;b&quot; c');
  });
  it('test_format_page_questions', () => {
    const xml = formatPageQuestions([{ ...cards[0]!, ocr_text: '测试题目' }]);
    expect(xml).toContain("<question label='1'");
    expect(xml).toContain("bbox='0.100,0.200,0.300,0.100'");
    expect(xml).toContain('测试题目');
  });
  it('emits page images in order and falls back to the Rust placeholder for missing page blobs', async () => {
    const blocks = await format(true);
    expect(blocks[2]).toEqual({ type: 'text', text: '[页面 0 图片加载失败]' });
    const blob = vfsRepositories().blobs.storeBlob(storage.database('vfs'), host.ctx.vfsDatabase.blobsDir(),
      Buffer.from('image'), 'image/png', 'png');
    vfsRepositories().exams.updatePreviewJson(storage.database('vfs'), examId,
      { ...preview, pages: [{ ...preview.pages[0]!, blob_hash: blob.hash }] });
    const withImage = await format(true);
    expect(withImage[2]).toEqual({ type: 'image', mediaType: 'image/png', base64: Buffer.from('image').toString('base64') });
    expect(withImage.at(-1)).toEqual({ type: 'text', text: '\n</attached_exam_sheet>' });
  });
  it('prefers canonical questions, deduplicates required images and fails on missing canonical images', async () => {
    const db = storage.database('vfs');
    db.run(`INSERT INTO questions(id, exam_id, content, images_json, created_at, updated_at)
      VALUES ('q_context', ?1, 'a < b', ?2, '2026-01-01', '2026-01-01')`,
    [examId, JSON.stringify([{ hash: 'required' }, { hash: 'required' }])]);
    const blocks = await format(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: expect.stringContaining('a &lt; b') });
    await expect(format(true)).rejects.toBe('题目/材料必要图片缺失: Blob 不存在: required');
    const blob = vfsRepositories().blobs.storeBlob(db, host.ctx.vfsDatabase.blobsDir(), Buffer.from('canonical'), null, 'bin');
    db.run('UPDATE questions SET images_json = ?1 WHERE id = ?2',
      [JSON.stringify([{ hash: blob.hash }, { hash: blob.hash }]), 'q_context']);
    const result = await format(true);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', base64: Buffer.from('canonical').toString('base64') });
  });
  it('preserves serde defaults and rejects malformed preview fields', async () => {
    const repo = vfsRepositories().exams;
    const db = storage.database('vfs');
    repo.updatePreviewJson(db, examId, { pages: [{ page_index: 0, cards: [{}] }] });
    expect(await format(false)).toEqual([{ type: 'text', text: "<attached_exam_sheet exam_name='未命名试卷'>\n"
      + "  <page index='0'>\n    <question label='' bbox='0.000,0.000,0.000,0.000'></question>\n  </page>\n</attached_exam_sheet>" }]);
    repo.updatePreviewJson(db, examId, { pages: [{ cards: [] }] });
    await expect(format(false)).rejects.toBe('解析 preview_json 失败: missing field `page_index`');
    repo.updatePreviewJson(db, examId, { pages: [{ page_index: 0, cards: [{ bbox: { x: 1 } }] }] });
    await expect(format(false)).rejects.toBe('解析 preview_json 失败: missing field `y`');
  });
});
