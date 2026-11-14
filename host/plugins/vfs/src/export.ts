/**
 * DSTU export: dstu_export_formats / dstu_export.
 * Rust: dstu/export/mod.rs and the eight per-type adapters.
 */
import * as path from '../../../platform/util/path.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { toBase64, utf8Encode } from '../../../platform/crypto/encoding.ts';
import { MemoryZipSink, ZipWriter } from '../../../platform/zip/core/index.ts';
import { fs } from './local-runtime.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { DstuExportResult, VfsDatabase } from '../api.ts';
import type {
  VfsExamSheet,
  VfsFile,
  VfsMindMap,
  VfsNote,
  VfsTextbook,
  VfsTranslation,
} from '../api.ts';
import type { VfsEssay, VfsEssaySession } from '../../vfs-repos/api.ts';
import type { DstuNodeType } from './dstu-types.ts';
import { DstuFailure } from './dstu-error.ts';
import { extractResourceInfo } from './path-utils.ts';
import { decodeBase64 } from './dstu-create.ts';
import {
  getMindmapContentWithConn,
  getMindmapWithConn,
} from '../repository/resources.ts';
import { contextText, contextWithConn } from '../repository/qbank-read.ts';
import { listFoldersByParentWithConn, listItemsByFolderWithConn } from '../repository/folders.ts';
import { notesRepository, vfsRepositories } from '../repository/services.ts';
import { exportTextbookTextWithConn } from '../repository/export.ts';

export type ExportFormat = 'markdown' | 'original' | 'zip';

/** Minimal surface of the qbank export hook (`vfs::hooks::ExamDocumentExporter`). */
export interface QbankExportHook {
  /** `exam_document_exporter().export_document(vfs_db, exam_id)`; may be absent until L14 publishes it. */
  exportDocument(examId: string): unknown;
}

export interface DstuExportDeps {
  readonly database: VfsDatabase;
  readonly log: { warn(message: string, ...args: unknown[]): void; info(message: string, ...args: unknown[]): void };
  readonly qbank?: QbankExportHook;
}

type ExportPayload =
  | { kind: 'text'; content: string; suggestedFilename: string; mimeType: string }
  | { kind: 'binary'; data: Uint8Array; suggestedFilename: string; mimeType: string }
  | { kind: 'file'; tempPath: string; suggestedFilename: string; mimeType: string };

const SUPPORTED_FORMATS: Readonly<Record<string, readonly ExportFormat[]>> = {
  note: ['markdown'],
  textbook: ['original', 'markdown'],
  exam: ['markdown', 'original'],
  translation: ['markdown', 'original'],
  essay: ['markdown'],
  image: ['original'],
  file: ['original', 'markdown'],
  mindmap: ['markdown', 'original'],
};

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function internal(detail: string): DstuFailure {
  return new DstuFailure('Internal', detail);
}

function notSupported(detail: string): DstuFailure {
  return new DstuFailure('NotSupported', detail);
}

function notFound(id: string): DstuFailure {
  return new DstuFailure('NotFound', id);
}

/** `sanitize_filename` (export/mod.rs:606-627). */
export function sanitizeFilename(name: string): string {
  let out = '';
  for (const char of name) {
    if (/^[A-Za-z0-9\-_ .]$/.test(char)) {
      out += char;
    } else if (char.charCodeAt(0) > 0x7f) {
      out += char;
    } else {
      out += '_';
    }
  }
  return out === '' ? 'untitled' : out;
}

function escapeYamlQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

function translationContent(deps: DstuExportDeps, id: string): string {
  const conn = deps.database.getConnSafe();
  try {
    return vfsRepositories().translations.getTranslationContent(conn, id) ?? '';
  } catch (error) {
    throw internal(`获取翻译内容失败: ${failureMessage(error)}`);
  }
}

function getNote(deps: DstuExportDeps, id: string): VfsNote {
  const conn = deps.database.getConnSafe();
  let note: VfsNote | null;
  try {
    note = notesRepository().getNote(id, conn);
  } catch (error) {
    throw internal(`获取笔记失败: ${failureMessage(error)}`);
  }
  if (note === null) throw notFound(id);
  return note;
}

function getNoteContent(deps: DstuExportDeps, id: string): string {
  try {
    return notesRepository().getNoteContent(id, deps.database.getConnSafe()) ?? '';
  } catch (error) {
    throw internal(`获取笔记内容失败: ${failureMessage(error)}`);
  }
}

function getTextbook(deps: DstuExportDeps, id: string): VfsTextbook {
  let textbook: VfsTextbook | null;
  try {
    textbook = vfsRepositories().textbooks.getTextbook(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取教材失败: ${failureMessage(error)}`);
  }
  if (textbook === null) throw notFound(id);
  return textbook;
}

function getTranslation(deps: DstuExportDeps, id: string): VfsTranslation {
  let translation: VfsTranslation | null;
  try {
    translation = vfsRepositories().translations.getTranslation(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取翻译失败: ${failureMessage(error)}`);
  }
  if (translation === null) throw notFound(id);
  return translation;
}

function getExam(deps: DstuExportDeps, id: string): VfsExamSheet {
  let exam: VfsExamSheet | null;
  try {
    exam = vfsRepositories().exams.getExamSheet(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取题目集失败: ${failureMessage(error)}`);
  }
  if (exam === null) throw notFound(id);
  return exam;
}

function getMindmap(deps: DstuExportDeps, id: string): VfsMindMap {
  let mindmap: VfsMindMap | undefined;
  try {
    mindmap = getMindmapWithConn(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取知识导图失败: ${failureMessage(error)}`);
  }
  if (mindmap === undefined) throw notFound(id);
  return mindmap;
}

function getMindmapContent(deps: DstuExportDeps, id: string): string {
  let content: string | undefined;
  try {
    content = getMindmapContentWithConn(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取知识导图内容失败: ${failureMessage(error)}`);
  }
  if (content === undefined) throw internal('知识导图内容为空');
  return content;
}

function getFile(deps: DstuExportDeps, id: string, label: string): VfsFile {
  let file: VfsFile | null;
  try {
    file = vfsRepositories().files.getFile(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取${label}失败: ${failureMessage(error)}`);
  }
  if (file === null) throw notFound(id);
  return file;
}

function getSession(deps: DstuExportDeps, id: string): VfsEssaySession {
  let session: VfsEssaySession | null;
  try {
    session = vfsRepositories().essays.getSession(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取作文会话失败: ${failureMessage(error)}`);
  }
  if (session === null) throw notFound(id);
  return session;
}

function getEssay(deps: DstuExportDeps, id: string): VfsEssay {
  let essay: VfsEssay | null;
  try {
    essay = vfsRepositories().essays.getEssay(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取作文失败: ${failureMessage(error)}`);
  }
  if (essay === null) throw notFound(id);
  return essay;
}

function getEssayContent(deps: DstuExportDeps, id: string): string | null {
  try {
    return vfsRepositories().essays.getEssayContent(deps.database.getConnSafe(), id);
  } catch (error) {
    throw internal(`获取作文内容失败: ${failureMessage(error)}`);
  }
}

function getBlobPath(
  deps: DstuExportDeps,
  hash: string,
  failureLabel: string,
): string | null {
  try {
    return vfsRepositories().blobs.getBlobPath(
      deps.database.getConnSafe(), deps.database.blobsDir(), hash);
  } catch (error) {
    throw internal(`${failureLabel}: ${failureMessage(error)}`);
  }
}

function fileContentBase64(
  deps: DstuExportDeps,
  id: string,
  failureLabel: string,
  emptyLabel: string,
): Uint8Array {
  const conn = deps.database.getConnSafe();
  let content: string | null;
  try {
    content = vfsRepositories().files.getContent(conn, deps.database.blobsDir(), id);
  } catch (error) {
    throw internal(`${failureLabel}: ${failureMessage(error)}`);
  }
  if (content === null) throw internal(emptyLabel);
  try {
    return decodeBase64(content);
  } catch (error) {
    throw internal(`解码 base64 失败: ${failureMessage(error)}`);
  }
}

function essayGradingSummary(grading: unknown): string | undefined {
  if (grading === null || typeof grading !== 'object' || Array.isArray(grading)) return undefined;
  const summary = (grading as Record<string, unknown>).summary;
  return typeof summary === 'string' ? summary : undefined;
}

// -------------------------------------------------------------------------- adapters

function exportNote(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  if (format !== 'markdown') throw notSupported(`笔记不支持 ${format} 格式导出`);
  const note = getNote(deps, id);
  const content = getNoteContent(deps, id);

  let md = '---\n';
  md += `id: ${note.id}\n`;
  md += `title: "${escapeYamlQuotes(note.title)}"\n`;
  md += `created: ${note.createdAt}\n`;
  md += `updated: ${note.updatedAt}\n`;
  if (note.isFavorite) md += 'favorite: true\n';
  if (note.tags.length > 0) {
    md += 'tags:\n';
    for (const tag of note.tags) md += `  - "${escapeYamlQuotes(tag)}"\n`;
  }
  md += '---\n\n';
  md += content;

  const safeTitle = sanitizeFilename(note.title);
  return {
    kind: 'text',
    content: md,
    suggestedFilename: safeTitle === '' ? `${id}.md` : `${safeTitle}.md`,
    mimeType: 'text/markdown',
  };
}

function exportTextbook(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  const textbook = getTextbook(deps, id);
  if (format === 'markdown') {
    let conn;
    try { conn = deps.database.getConnSafe(); }
    catch (error) { throw internal(`获取数据库连接失败: ${failureMessage(error)}`); }
    const text = rustTrim(exportTextbookTextWithConn(conn, id) ?? '');
    if (text === '') {
      throw notSupported(`教材 ${textbook.fileName} 没有可导出的提取文本（可能尚未完成解析/OCR）`);
    }
    const stem = path.parse(textbook.fileName).name || textbook.fileName;
    return {
      kind: 'text',
      content: `# ${textbook.fileName}\n\n${text}\n`,
      suggestedFilename: sanitizeFilename(`${stem}.md`),
      mimeType: 'text/markdown',
    };
  }
  if (format !== 'original') throw notSupported(`教材不支持 ${format} 格式导出`);

  const blobHash = textbook.blobHash;
  if (blobHash === undefined || blobHash === null) {
    throw internal(`教材 ${id} 没有关联的 blob`);
  }
  const blobPath = getBlobPath(deps, blobHash, '获取 blob 路径失败');
  if (blobPath === null) throw internal(`blob ${blobHash} 文件不存在`);
  if (!fs.existsSync(blobPath)) throw internal(`PDF 文件不存在: ${blobPath}`);

  const safe = sanitizeFilename(textbook.fileName);
  return {
    kind: 'file',
    tempPath: blobPath,
    suggestedFilename: safe === '' ? `${id}.pdf` : safe,
    mimeType: 'application/pdf',
  };
}

function exportExam(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  const exam = getExam(deps, id);
  const title = exam.examName ?? '未命名题目集';

  if (format === 'markdown') {
    let md = '---\n';
    md += `id: ${exam.id}\n`;
    md += `title: "${escapeYamlQuotes(title)}"\n`;
    md += `status: ${exam.status}\n`;
    md += `created: ${exam.createdAt}\n`;
    md += `updated: ${exam.updatedAt}\n`;
    md += '---\n\n';
    md += `# ${title}\n\n`;

    let canonical;
    try {
      canonical = contextWithConn(deps.database.getConnSafe(), id);
    } catch (error) {
      throw internal(failureMessage(error));
    }
    if (canonical !== null) {
      md += contextText(canonical);
      return {
        kind: 'text',
        content: md,
        suggestedFilename: `${sanitizeFilename(title)}.md`,
        mimeType: 'text/markdown',
      };
    }

    const preview = exam.previewJson;
    const pages = preview !== null && typeof preview === 'object' && !Array.isArray(preview)
      ? (preview as Record<string, unknown>).pages
      : undefined;
    if (Array.isArray(pages)) {
      pages.forEach((page, pageIndex) => {
        const record = page !== null && typeof page === 'object' && !Array.isArray(page)
          ? page as Record<string, unknown>
          : {};
        const cards = Array.isArray(record.cards) ? record.cards : [];
        md += `## 第 ${pageIndex + 1} 页（${cards.length} 题）\n\n`;
        for (const card of cards) {
          const cardRecord = card !== null && typeof card === 'object' && !Array.isArray(card)
            ? card as Record<string, unknown>
            : {};
          const rawLabel = Object.hasOwn(cardRecord, 'question_label') ? cardRecord.question_label : cardRecord.questionLabel;
          const label = typeof rawLabel === 'string' ? rawLabel : '-';
          const rawOcr = Object.hasOwn(cardRecord, 'ocr_text') ? cardRecord.ocr_text : cardRecord.ocrText;
          const status = typeof cardRecord.status === 'string' ? cardRecord.status : 'new';
          const ocr = typeof rawOcr === 'string' ? rustTrim(rawOcr) : '';
          if (ocr === '') {
            md += `- **${label}** [${status}]（无 OCR 文本）\n`;
          } else {
            md += `- **${label}** [${status}] ${ocr}\n`;
          }
        }
        md += '\n';
      });
    }

    return {
      kind: 'text',
      content: md,
      suggestedFilename: `${sanitizeFilename(title)}.md`,
      mimeType: 'text/markdown',
    };
  }

  if (format !== 'original') throw notSupported(`题目集不支持 ${format} 格式导出`);
  if (deps.qbank === undefined) throw internal('题目导出服务未注册');
  let document: unknown;
  try {
    document = deps.qbank.exportDocument(id);
  } catch (error) {
    throw internal(failureMessage(error));
  }
  const questions = document !== null && typeof document === 'object' && !Array.isArray(document)
    ? (document as Record<string, unknown>).questions
    : undefined;
  const value = Array.isArray(questions) && questions.length > 0 ? document : exam.previewJson;
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch (error) {
    throw internal(`序列化 JSON 失败: ${failureMessage(error)}`);
  }
  return {
    kind: 'text',
    content: json,
    suggestedFilename: `${sanitizeFilename(title)}.json`,
    mimeType: 'application/json',
  };
}

function exportTranslation(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  const translation = getTranslation(deps, id);
  const title = translation.title ?? '未命名翻译';

  if (format === 'markdown') {
    const contentStr = translationContent(deps, id);
    let source = '';
    let translated = '';
    try {
      const parsed = JSON.parse(contentStr) as Record<string, unknown>;
      if (parsed !== null && typeof parsed === 'object') {
        source = typeof parsed.source === 'string' ? parsed.source : '';
        translated = typeof parsed.translated === 'string' ? parsed.translated : '';
      }
    } catch {
      translated = contentStr;
    }

    let md = '---\n';
    md += `id: ${translation.id}\n`;
    md += `title: "${escapeYamlQuotes(title)}"\n`;
    md += `src_lang: ${translation.srcLang}\n`;
    md += `tgt_lang: ${translation.tgtLang}\n`;
    if (translation.engine !== undefined && translation.engine !== null) {
      md += `engine: ${translation.engine}\n`;
    }
    md += `created: ${translation.createdAt}\n`;
    md += '---\n\n';
    md += `# ${title}\n\n`;
    if (source !== '') md += `## 原文\n\n${source}\n\n`;
    if (translated !== '') md += `## 译文\n\n${translated}\n`;

    return {
      kind: 'text',
      content: md,
      suggestedFilename: `${sanitizeFilename(title)}.md`,
      mimeType: 'text/markdown',
    };
  }

  if (format !== 'original') throw notSupported(`翻译不支持 ${format} 格式导出`);
  return {
    kind: 'text',
    content: translationContent(deps, id),
    suggestedFilename: `${sanitizeFilename(title)}.json`,
    mimeType: 'application/json',
  };
}

function exportEssay(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  if (format !== 'markdown') throw notSupported(`作文不支持 ${format} 格式导出`);
  return id.startsWith('essay_session_')
    ? exportEssaySession(deps, id)
    : exportSingleEssay(deps, id);
}

function exportEssaySession(deps: DstuExportDeps, sessionId: string): ExportPayload {
  const session = getSession(deps, sessionId);
  let essays: VfsEssay[];
  try {
    essays = vfsRepositories().essays.listEssaysBySession(deps.database.getConnSafe(), sessionId);
  } catch (error) {
    throw internal(`获取作文轮次失败: ${failureMessage(error)}`);
  }
  const title = session.title === '' ? '未命名作文' : session.title;

  let md = '---\n';
  md += `id: ${session.id}\n`;
  md += `title: "${escapeYamlQuotes(title)}"\n`;
  if (session.essay_type !== '') md += `essay_type: ${session.essay_type}\n`;
  if (session.grade_level !== '') md += `grade_level: ${session.grade_level}\n`;
  md += `total_rounds: ${session.total_rounds}\n`;
  if (session.latest_score !== undefined && session.latest_score !== null) {
    md += `latest_score: ${session.latest_score}\n`;
  }
  md += `created: ${session.created_at}\n`;
  md += `updated: ${session.updated_at}\n`;
  md += '---\n\n';
  md += `# ${title}\n\n`;

  essays.forEach((essay, index) => {
    md += `## 第 ${index + 1} 轮`;
    if (essay.score !== undefined && essay.score !== null) md += `（得分: ${essay.score}）`;
    md += '\n\n';

    // Rust `if let Ok(Some(content))`: read failures are skipped without failing the export.
    try {
      const content = vfsRepositories().essays.getEssayContent(
        deps.database.getConnSafe(), essay.id);
      if (content !== null) md += `${content}\n\n`;
    } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(...))` 忽略读取失败并继续导出
      // skip
    }

    const summary = essayGradingSummary(essay.gradingResult);
    if (summary !== undefined) md += `### 批改意见\n\n${summary}\n\n`;
  });

  return {
    kind: 'text',
    content: md,
    suggestedFilename: `${sanitizeFilename(title)}.md`,
    mimeType: 'text/markdown',
  };
}

function exportSingleEssay(deps: DstuExportDeps, essayId: string): ExportPayload {
  const essay = getEssay(deps, essayId);
  const title = essay.title ?? '未命名作文';
  const content = getEssayContent(deps, essayId) ?? '';

  let md = '---\n';
  md += `id: ${essay.id}\n`;
  md += `title: "${escapeYamlQuotes(title)}"\n`;
  if (essay.essayType !== undefined) md += `essay_type: ${essay.essayType}\n`;
  if (essay.score !== undefined && essay.score !== null) md += `score: ${essay.score}\n`;
  md += `round: ${essay.roundNumber}\n`;
  md += `created: ${essay.createdAt}\n`;
  md += '---\n\n';
  md += `# ${title}\n\n`;
  md += content;

  const summary = essayGradingSummary(essay.gradingResult);
  if (summary !== undefined) md += `\n\n## 批改意见\n\n${summary}\n`;

  return {
    kind: 'text',
    content: md,
    suggestedFilename: `${sanitizeFilename(title)}.md`,
    mimeType: 'text/markdown',
  };
}

function blobOriginal(
  deps: DstuExportDeps,
  file: VfsFile,
  mimeType: string,
  fallbackFilename: string,
  failureLabel: string,
  emptyLabel: string,
): ExportPayload {
  const safe = sanitizeFilename(file.fileName);
  const filename = safe === '' ? fallbackFilename : safe;

  if (file.blobHash !== undefined && file.blobHash !== null) {
    let blobPath: string | null = null;
    try {
      blobPath = vfsRepositories().blobs.getBlobPath(
        deps.database.getConnSafe(), deps.database.blobsDir(), file.blobHash);
    } catch { // boundary-allow empty-catch: Rust `if let Ok(Some(path))` 忽略 blob 路径查询失败并走 base64 回退
      blobPath = null;
    }
    if (blobPath !== null && fs.existsSync(blobPath)) {
      return { kind: 'file', tempPath: blobPath, suggestedFilename: filename, mimeType };
    }
  }

  const data = fileContentBase64(deps, file.id, failureLabel, emptyLabel);
  return { kind: 'binary', data, suggestedFilename: filename, mimeType };
}

function exportImage(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  if (format !== 'original') throw notSupported(`图片不支持 ${format} 格式导出`);
  const file = getFile(deps, id, '图片文件');
  return blobOriginal(
    deps,
    file,
    file.mimeType ?? 'image/png',
    `${id}.png`,
    '获取图片内容失败',
    '图片内容为空',
  );
}

function exportFile(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  const file = getFile(deps, id, '文件');
  if (format === 'markdown') {
    const text = file.extractedText === undefined || file.extractedText === null
      ? ''
      : rustTrim(file.extractedText);
    if (text === '') {
      throw notSupported(`文件 ${file.fileName} 没有可导出的提取文本（仅支持已解析出文本的文档）`);
    }
    const stem = path.parse(file.fileName).name || file.fileName;
    return {
      kind: 'text',
      content: `# ${file.fileName}\n\n${text}\n`,
      suggestedFilename: sanitizeFilename(`${stem}.md`),
      mimeType: 'text/markdown',
    };
  }
  if (format !== 'original') throw notSupported(`文件不支持 ${format} 格式导出`);
  return blobOriginal(
    deps,
    file,
    file.mimeType ?? 'application/octet-stream',
    `${id}.bin`,
    '获取文件内容失败',
    '文件内容为空',
  );
}

function exportMindmap(deps: DstuExportDeps, id: string, format: ExportFormat): ExportPayload {
  const mindmap = getMindmap(deps, id);
  const content = getMindmapContent(deps, id);

  if (format === 'markdown') {
    let md = '---\n';
    md += `id: ${mindmap.id}\n`;
    md += `title: "${escapeYamlQuotes(mindmap.title)}"\n`;
    if (mindmap.description !== undefined && mindmap.description !== null) {
      md += `description: "${escapeYamlQuotes(mindmap.description)}"\n`;
    }
    md += `created: ${mindmap.createdAt}\n`;
    md += `updated: ${mindmap.updatedAt}\n`;
    md += '---\n\n';
    md += `# ${mindmap.title}\n\n`;

    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(content);
    } catch {
      parseFailed = true;
    }
    if (parseFailed) {
      md += `\`\`\`json\n${content}\n\`\`\`\n`;
    } else {
      const root = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).root
        : undefined;
      if (root !== undefined) renderMindmapNode(root, (line) => { md += line; }, 0);
    }

    return {
      kind: 'text',
      content: md,
      suggestedFilename: `${sanitizeFilename(mindmap.title)}.md`,
      mimeType: 'text/markdown',
    };
  }

  if (format !== 'original') throw notSupported(`知识导图不支持 ${format} 格式导出`);
  let pretty: string;
  try {
    pretty = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    pretty = content;
  }
  return {
    kind: 'text',
    content: pretty,
    suggestedFilename: `${sanitizeFilename(mindmap.title)}.json`,
    mimeType: 'application/json',
  };
}

/** `render_node_to_markdown` (mindmap_adapter.rs:131-149). */
function renderMindmapNode(node: unknown, write: (chunk: string) => void, depth: number): void {
  const record = node !== null && typeof node === 'object' && !Array.isArray(node)
    ? node as Record<string, unknown>
    : {};
  const text = typeof record.text === 'string' ? record.text : '(空节点)';
  write(`${'  '.repeat(depth)}- ${text}\n`);
  if (Array.isArray(record.children)) {
    for (const child of record.children) renderMindmapNode(child, write, depth + 1);
  }
}

function exportPayload(
  deps: DstuExportDeps,
  nodeType: DstuNodeType,
  id: string,
  format: ExportFormat,
): ExportPayload {
  const formats = SUPPORTED_FORMATS[nodeType];
  if (formats === undefined) throw notSupported(`资源类型 ${nodeType} 不支持导出`);
  if (!formats.includes(format)) {
    throw notSupported(`资源类型 ${nodeType} 不支持 ${format} 格式导出`);
  }
  switch (nodeType) {
    case 'note': return exportNote(deps, id, format);
    case 'textbook': return exportTextbook(deps, id, format);
    case 'exam': return exportExam(deps, id, format);
    case 'translation': return exportTranslation(deps, id, format);
    case 'essay': return exportEssay(deps, id, format);
    case 'image': return exportImage(deps, id, format);
    case 'file': return exportFile(deps, id, format);
    case 'mindmap': return exportMindmap(deps, id, format);
    default: throw notSupported(`资源类型 ${nodeType} 不支持导出`);
  }
}

function parseExportFormat(format: string): ExportFormat | undefined {
  switch (format.toLowerCase()) {
    case 'markdown':
    case 'md': return 'markdown';
    case 'original':
    case 'raw': return 'original';
    case 'zip': return 'zip';
    default: return undefined;
  }
}

/** `infer_node_type_from_path` (export/mod.rs:584-604). */
function inferNodeTypeFromPath(pathValue: string): DstuNodeType {
  const segments = pathValue.split('/').filter(segment => segment !== '');
  const id = segments.at(-1);
  if (id === undefined) throw new Error('路径为空');
  if (id.startsWith('note_')) return 'note';
  if (id.startsWith('tb_')) return 'textbook';
  if (id.startsWith('exam_')) return 'exam';
  if (id.startsWith('tr_')) return 'translation';
  if (id.startsWith('essay_session_') || id.startsWith('essay_')) return 'essay';
  if (id.startsWith('img_')) return 'image';
  if (id.startsWith('file_') || id.startsWith('att_')) return 'file';
  if (id.startsWith('mm_')) return 'mindmap';
  if (id.startsWith('fld_')) return 'folder';
  throw new Error(`无法从 ID '${id}' 推断资源类型`);
}

function mapResult(payload: ExportPayload): DstuExportResult {
  switch (payload.kind) {
    case 'text':
      return {
        payloadType: 'text',
        suggestedFilename: payload.suggestedFilename,
        mimeType: payload.mimeType,
        content: payload.content,
      };
    case 'binary':
      return {
        payloadType: 'binary',
        suggestedFilename: payload.suggestedFilename,
        mimeType: payload.mimeType,
        dataBase64: toBase64(payload.data),
      };
    case 'file':
      return {
        payloadType: 'file',
        suggestedFilename: payload.suggestedFilename,
        mimeType: payload.mimeType,
        tempPath: payload.tempPath,
      };
  }
}

function commandError(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  return new CommandError(failureMessage(error));
}

/** `dstu_export_formats` (export/mod.rs:275-300). */
export function exportFormatsCommand(deps: DstuExportDeps, pathValue: string): string[] {
  deps.log.info('[DSTU::export] dstu_export_formats: path=%s', pathValue);
  try {
    extractResourceInfo(pathValue);
    const nodeType = inferNodeTypeFromPath(pathValue);
    if (nodeType === 'folder') return ['zip'];
    return [...(SUPPORTED_FORMATS[nodeType] ?? [])];
  } catch (error) {
    throw commandError(error);
  }
}

/** `dstu_export` (export/mod.rs:304-340). */
export async function exportCommand(
  deps: DstuExportDeps,
  pathValue: string,
  format: string,
): Promise<DstuExportResult> {
  deps.log.info('[DSTU::export] dstu_export: path=%s, format=%s', pathValue, format);
  try {
    const exportFormat = parseExportFormat(format);
    if (exportFormat === undefined) throw new Error(`不支持的导出格式: ${format}`);
    const { id } = extractResourceInfo(pathValue);
    const nodeType = inferNodeTypeFromPath(pathValue);

    if (nodeType === 'folder') {
      if (exportFormat !== 'zip') {
        throw notSupported(`文件夹仅支持 zip 格式导出，收到: ${exportFormat}`);
      }
      return mapResult(await exportFolderZip(deps, id));
    }
    return mapResult(exportPayload(deps, nodeType, id, exportFormat));
  } catch (error) {
    throw commandError(error);
  }
}

// -------------------------------------------------------------------------- folder zip

const FOLDER_EXPORT_MAX_DEPTH = 16;
const FOLDER_EXPORT_MAX_ENTRIES = 2_000;

/** `infer_node_type_from_id` (export/mod.rs:348-368). */
function inferNodeTypeFromId(id: string): DstuNodeType | undefined {
  if (id.startsWith('note_')) return 'note';
  if (id.startsWith('tb_')) return 'textbook';
  if (id.startsWith('exam_')) return 'exam';
  if (id.startsWith('tr_')) return 'translation';
  if (id.startsWith('essay_')) return 'essay';
  if (id.startsWith('img_')) return 'image';
  if (id.startsWith('file_') || id.startsWith('att_')) return 'file';
  if (id.startsWith('mm_')) return 'mindmap';
  return undefined;
}

/** `dedup_zip_entry_name` (export/mod.rs:371-394). */
function dedupZipEntryName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot + 1) : undefined;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = extension === undefined
      ? `${stem}_${attempt}`
      : `${stem}_${attempt}.${extension}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${stem}_${Date.now()}`;
}

/** `collect_folder_resources` (export/mod.rs:397-433). */
function collectFolderResources(
  deps: DstuExportDeps,
  folderId: string,
  prefix: string,
  depth: number,
  out: Array<[string, string]>,
): void {
  if (depth > FOLDER_EXPORT_MAX_DEPTH) return;
  if (out.length >= FOLDER_EXPORT_MAX_ENTRIES) return;

  const conn = deps.database.getConnSafe();
  let items;
  try {
    items = listItemsByFolderWithConn(conn, folderId);
  } catch (error) {
    throw internal(`读取文件夹内容失败: ${failureMessage(error)}`);
  }
  for (const item of items) {
    if (out.length >= FOLDER_EXPORT_MAX_ENTRIES) break;
    out.push([prefix, item.itemId]);
  }

  let subfolders;
  try {
    subfolders = listFoldersByParentWithConn(conn, folderId);
  } catch (error) {
    throw internal(`读取子文件夹失败: ${failureMessage(error)}`);
  }
  for (const folder of subfolders) {
    collectFolderResources(
      deps, folder.id, `${prefix}${sanitizeFilename(folder.title)}/`, depth + 1, out);
  }
}

function payloadBytes(payload: ExportPayload): Uint8Array {
  switch (payload.kind) {
    case 'text': return utf8Encode(payload.content);
    case 'binary': return payload.data;
    case 'file': return fs.readFileSync(payload.tempPath);
  }
}

/** `export_folder_zip` (export/mod.rs:441-576). */
async function exportFolderZip(deps: DstuExportDeps, folderId: string): Promise<ExportPayload> {
  const conn = deps.database.getConnSafe();
  let folder;
  try {
    folder = vfsRepositories().folders.getFolder(conn, folderId);
  } catch (error) {
    throw internal(`获取文件夹失败: ${failureMessage(error)}`);
  }
  if (folder === null) throw notFound(folderId);

  const resources: Array<[string, string]> = [];
  collectFolderResources(deps, folderId, '', 0, resources);
  if (resources.length === 0) {
    throw notSupported(`文件夹「${folder.title}」内没有可导出的资源`);
  }

  const tempPath = path.join(
    fs.tmpDir(),
    `dstu_folder_export_${folderId}_${Date.now()}.zip`,
  );
  try {
    fs.writeFileSync(tempPath, new Uint8Array());
  } catch (error) {
    throw internal(`创建导出临时文件失败: ${failureMessage(error)}`);
  }

  const sink = new MemoryZipSink();
  const zip = new ZipWriter(sink);
  const usedNames = new Set<string>();
  const skipped: string[] = [];
  let exportedCount = 0;

  for (const [prefix, resourceId] of resources) {
    const nodeType = inferNodeTypeFromId(resourceId);
    if (nodeType === undefined) {
      skipped.push(`${resourceId}: 无法识别的资源类型`);
      continue;
    }

    const formats = SUPPORTED_FORMATS[nodeType] ?? [];
    const format: ExportFormat | undefined = formats.includes('original')
      ? 'original'
      : formats[0];
    if (format === undefined) {
      skipped.push(`${resourceId}: 该资源类型不支持导出`);
      continue;
    }

    let payload: ExportPayload;
    try {
      payload = exportPayload(deps, nodeType, resourceId, format);
    } catch (error) {
      skipped.push(`${resourceId}: ${failureMessage(error)}`);
      continue;
    }

    let data: Uint8Array;
    try {
      data = payloadBytes(payload);
    } catch (error) {
      skipped.push(`${payload.suggestedFilename}: 读取源文件失败: ${failureMessage(error)}`);
      continue;
    }

    const entryName = dedupZipEntryName(
      usedNames,
      `${prefix}${sanitizeFilename(payload.suggestedFilename)}`,
    );
    try {
      await zip.addBytes(entryName, data);
      exportedCount += 1;
    } catch (error) {
      skipped.push(`${payload.suggestedFilename}: 写入 ZIP 失败 (${failureMessage(error)})`);
    }
  }

  if (skipped.length > 0) {
    const note = `以下 ${skipped.length} 个资源未包含在导出包中：\n${skipped.join('\n')}\n`;
    const entryName = dedupZipEntryName(usedNames, '导出说明.txt');
    try { await zip.addBytes(entryName, note); }
    catch { // boundary-allow empty-catch: Rust `let _ = writer.start_file(...).and_then(...)` discards this result
      // A failed explanation entry does not abort the remaining ZIP finalization.
    }
  }

  let buffer: Uint8Array;
  try {
    await zip.finish();
    buffer = sink.bytes();
  } catch (error) {
    throw internal(`完成 ZIP 写入失败: ${failureMessage(error)}`);
  }
  try {
    fs.writeFileSync(tempPath, buffer);
  } catch (error) {
    throw internal(`完成 ZIP 写入失败: ${failureMessage(error)}`);
  }

  if (exportedCount === 0) {
    try { fs.rmSync(tempPath, { force: true }); }
    catch { // boundary-allow empty-catch: Rust `let _ = std::fs::remove_file(&temp_path)` 忽略删除失败
      // ignore
    }
    throw notSupported(
      `文件夹「${folder.title}」内没有成功导出的资源：${skipped.join('; ')}`,
    );
  }

  return {
    kind: 'file',
    tempPath,
    suggestedFilename: sanitizeFilename(`${folder.title}.zip`),
    mimeType: 'application/zip',
  };
}
