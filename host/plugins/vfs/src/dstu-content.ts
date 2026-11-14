/** dstu/handler_utils/content_helpers.rs `get_content_by_type` and `dstu_get_content`. */
import { CommandError } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { VfsDatabase } from '../api.ts';
import { DstuFailure } from './dstu-error.ts';
import { extractResourceInfo } from './path-utils.ts';
import {
  getEssayContentWithConn,
  getEssaySessionWithConn,
  getExtractedTextWithConn,
  getExamWithConn,
  getFileContentWithConn,
  getFileWithConn,
  getImageOcrTextWithConn,
  getMindmapContentWithConn,
  getNoteContentWithConn,
  getOcrPagesTextWithConn,
  getTranslationContentWithConn,
  listEssaysBySessionWithConn,
  resolveFileIdForReadWithConn,
} from '../repository/resources.ts';

/** content_helpers.rs:29-31. */
const MAX_ESSAY_SESSION_CHARS = 20_000;
const MAX_ESSAY_SESSION_ROUNDS = 10;
const TEXT_THRESHOLD = 1000;

export interface DstuContentDeps {
  readonly database: VfsDatabase;
}

function command<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(error instanceof Error ? error.message : String(error));
  }
}

/** `format_exam_preview_for_read` (content_helpers.rs:87-145). */
export function formatExamPreviewForRead(preview: unknown): string {
  const lines: string[] = [];
  let pageCount = 0;
  let cardCount = 0;
  let withOcrCount = 0;

  if (typeof preview === 'object' && preview !== null && Array.isArray(
    (preview as Record<string, unknown>).pages,
  )) {
    const pages = (preview as { pages: unknown[] }).pages;
    pageCount = pages.length;
    pages.forEach((page, pageIndex) => {
      const cards = typeof page === 'object' && page !== null && Array.isArray(
        (page as Record<string, unknown>).cards,
      ) ? (page as { cards: unknown[] }).cards : [];
      cardCount += cards.length;
      lines.push(`## 第 ${pageIndex + 1} 页（${cards.length} 题）`);
      for (const card of cards) {
        const record = typeof card === 'object' && card !== null
          ? card as Record<string, unknown>
          : {};
        const label = typeof record.questionLabel === 'string' ? record.questionLabel : '-';
        const ocr = typeof record.ocrText === 'string' ? rustTrim(record.ocrText) : '';
        const status = typeof record.status === 'string' ? record.status : 'new';
        if (ocr !== '') withOcrCount += 1;
        let shown: string;
        if (ocr === '') {
          shown = '（无 OCR 文本）';
        } else {
          const chars = Array.from(ocr);
          shown = chars.length > 200 ? `${chars.slice(0, 200).join('')}...` : ocr;
        }
        lines.push(`- ${label} [${status}] ${shown}`);
      }
    });
  }

  if (lines.length === 0) return '[题目集内容为空]';
  return `# 题目集结构化摘要\n统计：页数=${pageCount}，题目数=${cardCount}，含 OCR 题目=${withOcrCount}\n\n${lines.join('\n')}`;
}

/** `extract_file_text_with_strategy` (ref_handlers.rs:1877-1946) without DocumentParser. */
function extractFileText(
  deps: DstuContentDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  sourceId: string,
): string | undefined {
  const ocrText = getOcrPagesTextWithConn(conn, sourceId);
  const ocrLength = ocrText === undefined ? 0 : new TextEncoder().encode(ocrText).length;
  const parsedText = getExtractedTextWithConn(conn, sourceId);
  const parsedLength = parsedText === undefined ? 0 : new TextEncoder().encode(parsedText).length;

  // DocumentParser is an L02/F7 native adapter; without it only the stored text is
  // available, so the OCR-vs-parsed comparison keeps Rust's ordering.
  if (ocrLength > parsedLength) return ocrText;
  if (parsedLength > 0) return parsedText;
  return ocrLength > 0 ? ocrText : undefined;
}

function essaySessionContent(
  deps: DstuContentDeps,
  conn: ReturnType<VfsDatabase['getConnSafe']>,
  sessionId: string,
): string {
  const session = getEssaySessionWithConn(conn, sessionId);
  if (session === undefined) throw new DstuFailure('NotFound', sessionId);
  const essays = listEssaysBySessionWithConn(conn, sessionId);
  const parts: string[] = [];
  let totalChars = 0;
  let truncated = false;

  const push = (part: string): boolean => {
    if (totalChars >= MAX_ESSAY_SESSION_CHARS) {
      truncated = true;
      return false;
    }
    const remaining = MAX_ESSAY_SESSION_CHARS - totalChars;
    const chars = Array.from(part);
    if (chars.length > remaining) {
      const kept = chars.slice(0, remaining).join('');
      if (kept !== '') parts.push(kept);
      totalChars = MAX_ESSAY_SESSION_CHARS;
      truncated = true;
      return false;
    }
    totalChars += chars.length;
    parts.push(part);
    return true;
  };

  const title = session.title === '' ? '未命名' : session.title;
  push(`# 作文会话: ${title}`);
  push(`类型: ${session.essayType ?? '未知'}, 总轮次: ${session.totalRounds}`);

  const maxRounds = Math.min(MAX_ESSAY_SESSION_ROUNDS, essays.length);
  if (essays.length > maxRounds) truncated = true;
  for (let index = 0; index < maxRounds; index += 1) {
    if (!push(`\n## 第 ${index + 1} 轮`)) break;
    const essay = essays[index]!;
    const content = getEssayContentWithConn(conn, essay.id);
    if (content !== undefined) {
      if (!push(content)) break;
    }
  }
  if (truncated) push('\n\n[内容过长，已截断]');
  return parts.join('\n');
}

/** `get_content_by_type` (content_helpers.rs:148-395). */
export function getContentByType(deps: DstuContentDeps, resourceType: string, id: string): string {
  const conn = deps.database.getConnSafe();
  switch (resourceType) {
    case 'notes':
    case 'note': {
      const content = getNoteContentWithConn(conn, id);
      if (content === undefined) throw new DstuFailure('NotFound', id);
      return content;
    }
    case 'translations':
    case 'translation': {
      const content = getTranslationContentWithConn(conn, id);
      if (content === undefined) throw new DstuFailure('NotFound', id);
      return content;
    }
    case 'exams':
    case 'exam': {
      const exam = getExamWithConn(conn, id);
      if (exam === undefined) throw new DstuFailure('NotFound', id);
      return formatExamPreviewForRead(exam.previewJson);
    }
    case 'essays':
    case 'essay': {
      if (id.startsWith('essay_session_')) return essaySessionContent(deps, conn, id);
      const content = getEssayContentWithConn(conn, id);
      if (content === undefined) throw new DstuFailure('NotFound', id);
      return content;
    }
    case 'images':
    case 'image': {
      const ocr = getImageOcrTextWithConn(conn, id);
      if (ocr !== undefined) return `<image_ocr id="${id}">${ocr}</image_ocr>`;
      const base64 = getFileContentWithConn(conn, deps.database.blobsDir(), id);
      if (base64 === undefined) throw new DstuFailure('NotFound', id);
      return base64;
    }
    case 'mindmaps':
    case 'mindmap': {
      const content = getMindmapContentWithConn(conn, id);
      if (content === undefined) throw new DstuFailure('NotFound', id);
      return content;
    }
    case 'textbooks':
    case 'textbook':
    case 'files':
    case 'file': {
      const resolvedId = resolveFileIdForReadWithConn(conn, id) ?? id;
      const file = getFileWithConn(conn, resolvedId);
      const fileName = file?.fileName ?? 'document.pdf';
      const text = extractFileText(deps, conn, resolvedId);
      if (text !== undefined && text !== '') return text;
      return `[文档: ${fileName}]`;
    }
    default:
      throw new DstuFailure('InvalidNodeType', resourceType);
  }
}

/** `dstu_get_content` (handlers.rs:3290-3309). */
export function getContentCommand(deps: DstuContentDeps, path: string): string {
  return command(() => {
    const { resourceType, id } = extractResourceInfo(path);
    return getContentByType(deps, resourceType, id);
  });
}
