import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { DstuExportResult, DstuNode, VfsFolder } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L10 notes 插件，验证 notes 表只经其写入
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: 安装真实 L11 vfs-repos 插件，验证 resources 只经其写入
import reposPlugin from '../../vfs-repos/index.ts';
import {
  addItemToFolderWithConn,
  createFolderItemRecord,
} from '../repository/folders.ts';
import { vfsRepositories } from '../repository/services.ts';

describe('dstu_export', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  let conn: DatabaseHandle;
  let template: string;
  const qbankService: { exportDocument?: (examId: string) => unknown } = {};

  beforeAll(async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-export-schema-'));
    const source = createStorageService({ baseDir: template, dataLocalDir: template });
    try {
      const report = await source.migrations.runAll();
      expect(report.success, report.error ?? '').toBe(true);
    } finally { source.dispose(); }
  }, 120_000);
  afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 120_000);

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-export-'));
    fs.cpSync(template, root, { recursive: true });
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    qbankService.exportDocument = () => ({ questions: [] });
    host = await createTestHost({
      plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin],
      provide: { storage, qbank: qbankService },
      app: { dataDir: root },
    });
    conn = host.ctx.vfsDatabase.getConn();
  }, 60_000);
  afterEach(async () => {
    await host?.dispose();
    storage?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  const invoke = <T>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const create = (options: Record<string, unknown>) => invoke<DstuNode>('dstu_create', {
    path: '/',
    options,
  });
  const createFolder = async (title: string, parentId?: string): Promise<VfsFolder> =>
    invoke<VfsFolder>('dstu_folder_create', {
      title,
      ...(parentId === undefined ? {} : { parentId }),
    });
  const exportAs = (pathValue: string, format: string) =>
    invoke<DstuExportResult>('dstu_export', { path: pathValue, format });

  it('reports the Rust format lists for every resource type and folders', async () => {
    const note = await create({ type: 'note', name: 'n', content: 'x' });
    const translation = await create({ type: 'translation', name: 't' });
    const mindmap = await create({
      type: 'mindmap', name: 'm', content: '{"root":{"id":"root","text":"r","children":[]}}',
    });
    const essay = await create({ type: 'essay', name: 'e' });
    const exam = await create({ type: 'exam', name: 'q' });
    const image = await create({
      type: 'image', name: 'i.png', fileBase64: Buffer.from('i').toString('base64'),
    });
    const file = await create({
      type: 'file', name: 'f.txt', fileBase64: Buffer.from('f').toString('base64'),
    });
    const folder = await createFolder('目录');
    conn.run(
      `INSERT INTO files (id, resource_id, sha256, file_name, size, "type", tags_json,
                          is_favorite, status, created_at, updated_at)
       VALUES ('tb_formats', NULL, 'sha_tb_formats', 'book.pdf', 1, 'textbook', '[]',
               0, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );

    const formats = async (value: string) =>
      invoke<string[]>('dstu_export_formats', { path: value });
    await expect(formats(note.id)).resolves.toEqual(['markdown']);
    await expect(formats('tb_formats')).resolves.toEqual(['original', 'markdown']);
    await expect(formats(exam.id)).resolves.toEqual(['markdown', 'original']);
    await expect(formats(translation.id)).resolves.toEqual(['markdown', 'original']);
    await expect(formats(essay.id)).resolves.toEqual(['markdown']);
    // New image uploads have file_* IDs; the legacy img_* prefix selects ImageExportAdapter.
    await expect(formats(image.id)).resolves.toEqual(['original', 'markdown']);
    await expect(formats('img_formats')).resolves.toEqual(['original']);
    await expect(formats(file.id)).resolves.toEqual(['original', 'markdown']);
    await expect(formats(mindmap.id)).resolves.toEqual(['markdown', 'original']);
    await expect(formats(folder.id)).resolves.toEqual(['zip']);
    await expect(formats('res_1')).rejects.toContain("无法从 ID 'res_1' 推断资源类型");
  });

  it('exports a note as Markdown with YAML frontmatter and tags', async () => {
    const note = await create({
      type: 'note', name: '导出 笔记', content: '正文内容', metadata: { tags: ['数学', 'a"b'] },
    });
    await invoke('dstu_set_favorite', { path: note.id, favorite: true });
    const row = conn.get<{ created_at: string; updated_at: string }>(
      'SELECT created_at, updated_at FROM notes WHERE id = ?1', [note.id])!;

    const result = await exportAs(note.id, 'markdown');
    expect(result).toMatchObject({
      payloadType: 'text', suggestedFilename: '导出 笔记.md', mimeType: 'text/markdown',
    });
    expect(result.content).toBe(
      `---\nid: ${note.id}\ntitle: "导出 笔记"\ncreated: ${row.created_at}\n`
      + `updated: ${row.updated_at}\nfavorite: true\ntags:\n  - "数学"\n  - "a\\"b"\n---\n\n正文内容`,
    );
    await expect(exportAs(note.id, 'original'))
      .rejects.toContain('资源类型 note 不支持 original 格式导出');
  });

  it('exports translations and mindmaps in markdown and original formats', async () => {
    const translation = vfsRepositories().translations.createTranslation(conn, {
      title: '译稿', source: 'hello', translated: '你好', srcLang: 'en', tgtLang: 'zh', engine: 'llm',
    });
    const markdown = await exportAs(translation.id, 'markdown');
    expect(markdown.suggestedFilename).toBe('译稿.md');
    expect(markdown.content).toContain('src_lang: en\ntgt_lang: zh\nengine: llm\n');
    expect(markdown.content).toContain('# 译稿\n\n## 原文\n\nhello\n\n## 译文\n\n你好\n');
    const original = await exportAs(translation.id, 'original');
    expect(original).toMatchObject({
      payloadType: 'text', suggestedFilename: '译稿.json', mimeType: 'application/json',
      content: '{"source":"hello","translated":"你好"}',
    });

    const mindmap = await create({
      type: 'mindmap',
      name: '导图',
      content: '{"root":{"id":"root","text":"根","children":[{"id":"c","text":"子","children":[]}]}}',
      metadata: { description: '说明' },
    });
    const mindmapMarkdown = await exportAs(mindmap.id, 'markdown');
    expect(mindmapMarkdown.content).toContain('# 导图\n\n- 根\n  - 子\n');
    expect(mindmapMarkdown.content).toContain('description: "说明"');
    const mindmapJson = await exportAs(mindmap.id, 'original');
    expect(JSON.parse(mindmapJson.content!)).toMatchObject({
      root: { id: 'root', text: '根', children: [{ text: '子' }] },
    });
    expect(mindmapJson.suggestedFilename).toBe('导图.json');
  });

  it('exports essay sessions with rounds and single essays', async () => {
    const session = await create({
      type: 'essay',
      name: '作文',
      metadata: { essayType: 'argument', gradeLevel: 'high_school', customPrompt: 'p' },
    });
    const created = vfsRepositories().essays.createEssay(conn, {
      title: '第一轮',
      content: '作文正文',
      score: 88,
      sessionId: session.id,
      roundNumber: 1,
      gradingResult: { summary: '结构清晰' },
    });

    const sessionExport = await exportAs(session.id, 'markdown');
    expect(sessionExport.suggestedFilename).toBe('作文.md');
    expect(sessionExport.content).toContain(
      'essay_type: argument\ngrade_level: high_school\ntotal_rounds: 1\nlatest_score: 88\n');
    expect(sessionExport.content).toContain('## 第 1 轮（得分: 88）\n\n作文正文\n\n');
    expect(sessionExport.content).toContain('### 批改意见\n\n结构清晰\n\n');

    const single = await exportAs(created.id, 'markdown');
    expect(single.content).toContain(`id: ${created.id}\ntitle: "第一轮"\n`);
    expect(single.content).toContain('score: 88\nround: 1\n');
    expect(single.content).toContain('\n\n## 批改意见\n\n结构清晰\n');
  });

  it('exports exams from canonical questions or the preview fallback', async () => {
    const exam = await create({ type: 'exam', name: '试卷' });
    vfsRepositories().exams.updatePreviewJson(conn, exam.id, {
      pages: [{ cards: [
        { question_label: '1', status: 'new', ocr_text: '题干' },
        { questionLabel: '2', ocrText: '  ' },
      ] }],
    });
    const fallback = await exportAs(exam.id, 'markdown');
    expect(fallback.content).toContain('## 第 1 页（2 题）\n\n');
    expect(fallback.content).toContain('- **1** [new] 题干\n');
    expect(fallback.content).toContain('- **2** [new]（无 OCR 文本）\n');

    conn.run(
      `INSERT INTO questions (id, exam_id, content, created_at, updated_at)
       VALUES ('q_canonical', ?1, '规范题干', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [exam.id],
    );
    const canonical = await exportAs(exam.id, 'markdown');
    expect(canonical.content).toContain(
      'Question q_canonical\n规范题干\noptions: null\nanswer: null\nexplanation: null\n'
      + 'structured_data: null\ngroup: null\nsource: null');
    expect(canonical.content).not.toContain('## 第 1 页');
  });

  it('uses the qbank export hook for original exam JSON and errors without it', async () => {
    const exam = await create({ type: 'exam', name: '试卷' });
    vfsRepositories().exams.updatePreviewJson(conn, exam.id, { temp_id: 't', pages: [] });

    Reflect.deleteProperty(qbankService, 'exportDocument');
    await expect(exportAs(exam.id, 'original')).rejects.toContain('题目导出服务未注册');

    qbankService.exportDocument = () => ({ questions: [] });
    const previewFallback = await exportAs(exam.id, 'original');
    expect(JSON.parse(previewFallback.content!)).toEqual({ temp_id: 't', pages: [] });
    expect(previewFallback.suggestedFilename).toBe('试卷.json');

    const document = { schema_version: 2, questions: [{ id: 'q1' }] };
    qbankService.exportDocument = () => document;
    const canonical = await exportAs(exam.id, 'original');
    expect(JSON.parse(canonical.content!)).toEqual(document);
    expect(canonical.mimeType).toBe('application/json');
  });

  it('exports images and files from blobs or base64 and rejects missing text', async () => {
    const imageBytes = Buffer.from('image-bytes');
    const image = await create({
      type: 'image', name: '图 片.png', fileBase64: imageBytes.toString('base64'),
    });
    // Seed the legacy image ID used by the Rust image adapter, preserving its blob.
    conn.run(`INSERT INTO files (id, sha256, file_name, size, type, blob_hash, mime_type, created_at, updated_at)
      SELECT 'img_export', 'legacy-image', file_name, size, type, blob_hash, mime_type, created_at, updated_at
      FROM files WHERE id = ?1`, [image.id]);
    const imageExport = await exportAs('img_export', 'original');
    const imageData = imageExport.payloadType === 'file'
      ? fs.readFileSync(imageExport.tempPath!)
      : Buffer.from(imageExport.dataBase64!, 'base64');
    expect(imageData.equals(imageBytes)).toBe(true);
    expect(imageExport.suggestedFilename).toBe('图 片.png');
    await expect(exportAs('img_export', 'markdown'))
      .rejects.toContain('资源类型 image 不支持 markdown 格式导出');

    const fileBytes = Buffer.from('file-bytes');
    const file = await create({
      type: 'file', name: 'a.txt', fileBase64: fileBytes.toString('base64'),
    });
    await expect(exportAs(file.id, 'markdown'))
      .rejects.toContain('文件 a.txt 没有可导出的提取文本（仅支持已解析出文本的文档）');
    conn.run("UPDATE files SET extracted_text = '  提取文本  ' WHERE id = ?1", [file.id]);
    const markdown = await exportAs(file.id, 'markdown');
    expect(markdown).toMatchObject({
      payloadType: 'text', suggestedFilename: 'a.md', content: '# a.txt\n\n提取文本\n',
    });
    const original = await exportAs(file.id, 'original');
    const fileData = original.payloadType === 'file'
      ? fs.readFileSync(original.tempPath!)
      : Buffer.from(original.dataBase64!, 'base64');
    expect(fileData.equals(fileBytes)).toBe(true);
  });

  it('exports textbooks from their blob and extracted text', async () => {
    const pdf = Buffer.from('%PDF-1.4 textbook');
    const blob = vfsRepositories().blobs.storeBlob(
      conn, host.ctx.vfsDatabase.blobsDir(), pdf, 'application/pdf', 'pdf');
    conn.run(
      `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, size, "type", mime_type,
                          tags_json, is_favorite, status, extracted_text, created_at, updated_at)
       VALUES ('tb_export', NULL, ?1, 'sha_tb_export', '书.pdf', ?2, 'textbook', 'application/pdf',
               '[]', 0, 'active', '  教材文本  ', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [blob.hash, pdf.length],
    );
    const original = await exportAs('tb_export', 'original');
    expect(original).toMatchObject({
      payloadType: 'file', suggestedFilename: '书.pdf', mimeType: 'application/pdf',
    });
    expect(fs.readFileSync(original.tempPath!).equals(pdf)).toBe(true);
    const markdown = await exportAs('tb_export', 'markdown');
    expect(markdown.content).toBe('# 书.pdf\n\n教材文本\n');
    expect(markdown.suggestedFilename).toBe('书.md');

    conn.run('UPDATE files SET extracted_text = NULL WHERE id = ?1', ['tb_export']);
    await expect(exportAs('tb_export', 'markdown'))
      .rejects.toContain('教材 书.pdf 没有可导出的提取文本（可能尚未完成解析/OCR）');
  });

  it('packs folders recursively, dedups names and reports skipped resources', async () => {
    const folder = await createFolder('打包');
    const child = await createFolder('子级', folder.id);
    const first = await create({
      type: 'note', name: '重复', content: '一', metadata: { folderId: folder.id },
    });
    await create({ type: 'note', name: '重复', content: '二', metadata: { folderId: folder.id } });
    await create({ type: 'note', name: '子笔记', content: '三', metadata: { folderId: child.id } });
    addItemToFolderWithConn(conn, createFolderItemRecord(folder.id, 'note', 'res_unknown'));

    await expect(exportAs(folder.id, 'markdown'))
      .rejects.toContain('文件夹仅支持 zip 格式导出，收到: markdown');

    const result = await exportAs(folder.id, 'zip');
    expect(result).toMatchObject({
      payloadType: 'file', suggestedFilename: '打包.zip', mimeType: 'application/zip',
    });
    const zip = await JSZip.loadAsync(fs.readFileSync(result.tempPath!));
    expect(zip.file('重复.md')).not.toBeNull();
    expect(zip.file('重复_1.md')).not.toBeNull();
    expect(zip.file('子级/子笔记.md')).not.toBeNull();
    const explanation = await zip.file('导出说明.txt')!.async('string');
    expect(explanation).toContain('以下 1 个资源未包含在导出包中：\nres_unknown: 无法识别的资源类型\n');
    expect(await zip.file('重复.md')!.async('string')).toContain(`id: ${first.id}`);

    const empty = await createFolder('空目录');
    await expect(exportAs(empty.id, 'zip'))
      .rejects.toContain('文件夹「空目录」内没有可导出的资源');
    await expect(exportAs(first.id, 'pdf')).rejects.toContain('不支持的导出格式: pdf');
  });
});
