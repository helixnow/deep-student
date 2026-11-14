/**
 * 题目集解引用：移植 `chat_v2/vfs_resolver.rs` 的 exam 分支。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import {
  blobRow, examHistoryRows, examManualImageRows, examPreviewJsonRow, examQuestionRows,
  examQuestionTotal, questionImageBlobHash,
} from '../../repository/vfs-resolver-repository.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import {
  escapeXmlAttr, escapeXmlContent, imageBlock, silentVfsResolverLogger, textBlock,
  type ContentBlock, type VfsResolverLogger, type VfsResourceRef,
} from './model.ts';

interface QuestionBankStats {
  total: number;
  mastered: number;
  review: number;
  inProgress: number;
  new: number;
}

function emptyStats(): QuestionBankStats {
  return { total: 0, mastered: 0, review: 0, inProgress: 0, new: 0 };
}

function questionStatus(raw: string): 'new' | 'in_progress' | 'mastered' | 'review' {
  switch (raw) {
    case 'new': return 'new';
    case 'in_progress': return 'in_progress';
    case 'mastered': return 'mastered';
    case 'review': return 'review';
    default: return 'new';
  }
}

const QUESTION_TYPES: Record<string, string> = {
  singlechoice: 'single_choice',
  multiplechoice: 'multiple_choice',
  indefinitechoice: 'indefinite_choice',
  fillblank: 'fill_blank',
  shortanswer: 'short_answer',
  essay: 'essay',
  calculation: 'calculation',
  proof: 'proof',
  truefalse: 'true_false',
  matching: 'matching',
  ordering: 'ordering',
  numeric: 'numeric',
};

function normalizeQuestionType(raw: string): string {
  const compact = [...raw].filter(ch => ch !== '_' && ch !== '-' && !/\s/.test(ch)).join('').toLowerCase();
  return QUESTION_TYPES[compact] ?? 'other';
}

function buildStatsXml(stats: QuestionBankStats, extras: string): string {
  let xml = `<stats total="${stats.total}" mastered="${stats.mastered}" review="${stats.review}" ` +
    `in_progress="${stats.inProgress}" new="${stats.new}"`;
  const correctRate = stats.total > 0 && (stats.mastered + stats.review) > 0
    ? (() => {
      const attempted = stats.mastered + stats.review + stats.inProgress;
      return attempted > 0 ? (stats.mastered / attempted).toFixed(2) : null;
    })()
    : null;
  if (correctRate !== null) xml += ` correct_rate="${correctRate}"`;
  return `${xml}${extras}/>`;
}

function addStats(stats: QuestionBankStats, status: string): void {
  switch (status) {
    case 'mastered': stats.mastered += 1; break;
    case 'review': stats.review += 1; break;
    case 'in_progress': stats.inProgress += 1; break;
    default: stats.new += 1;
  }
}

/** `build_exam_questions_ssot_block`：题目表为文本 SSOT。 */
export function buildExamQuestionsSsotBlock(db: SqlExecutor, vfsRef: VfsResourceRef): ContentBlock | null {
  const MAX_QUESTIONS = 200;
  const rows = examQuestionRows(db, vfsRef.sourceId, MAX_QUESTIONS);
  if (rows === null) return null;
  const totalAvailable = examQuestionTotal(db, vfsRef.sourceId);

  let questionsXml = '';
  const stats = emptyStats();
  for (const row of rows) {
    const hasContent = rustTrim(row.content) !== ''
      || rustTrim(row.label) !== ''
      || (row.answer ?? '') !== ''
      || (row.explanation ?? '') !== ''
      || (row.userAnswer ?? '') !== ''
      || (row.userNote ?? '') !== '';
    if (!hasContent) continue;
    stats.total += 1;
    const status = questionStatus(row.status);
    addStats(stats, status);

    const attrs = [
      `label="${escapeXmlAttr(row.label)}"`,
      `status="${escapeXmlAttr(status)}"`,
    ];
    if (row.difficulty !== null) attrs.push(`difficulty="${escapeXmlAttr(row.difficulty)}"`);
    if (row.questionType !== null) {
      attrs.push(`type="${escapeXmlAttr(normalizeQuestionType(row.questionType))}"`);
    }
    if (row.attemptCount > 0) {
      attrs.push(`attempts="${row.attemptCount}"`);
      attrs.push(`correct="${row.correctCount}"`);
    }
    questionsXml += `<question ${attrs.join(' ')}>\n`;
    questionsXml += `  <content>${escapeXmlContent(row.content)}</content>\n`;
    let tags: string | null = null;
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter(item => typeof item === 'string').join(', ');
    } catch (error) { tags = null; }
    if (tags !== null && rustTrim(tags) !== '') {
      questionsXml += `  <tags>${escapeXmlContent(tags)}</tags>\n`;
    }
    if (row.answer !== null && row.answer !== '') {
      questionsXml += `  <answer>${escapeXmlContent(row.answer)}</answer>\n`;
    }
    if (row.explanation !== null && row.explanation !== '') {
      questionsXml += `  <explanation>${escapeXmlContent(row.explanation)}</explanation>\n`;
    }
    if (row.userAnswer !== null && row.userAnswer !== '') {
      questionsXml += `  <user_answer>${escapeXmlContent(row.userAnswer)}</user_answer>\n`;
    }
    if (row.userNote !== null && row.userNote !== '') {
      questionsXml += `  <user_note>${escapeXmlContent(row.userNote)}</user_note>\n`;
    }
    questionsXml += '</question>\n';
  }
  if (questionsXml === '') return null;

  let extras = '';
  if (totalAvailable > MAX_QUESTIONS) {
    extras = ` truncated="true" total_available="${totalAvailable}"`;
    questionsXml += `<system_note>题目较多，已按预算注入前 ${MAX_QUESTIONS} 题（共 ${totalAvailable} 题）。</system_note>\n`;
  }
  return textBlock(
    `<question_bank id="${escapeXmlAttr(vfsRef.sourceId)}" name="${escapeXmlAttr(vfsRef.name)}" source="questions">\n` +
    `${buildStatsXml(stats, extras)}\n<questions>\n${questionsXml}</questions>\n</question_bank>`,
  );
}

/** `resolve_exam_text_only_from_preview`：旧卷预览卡片 OCR 回退。 */
export function resolveExamTextOnlyFromPreview(
  previewJson: string,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  let preview: unknown;
  try { preview = JSON.parse(previewJson); } catch (error) {
    logger.warn(`[VfsResolver] Failed to parse exam preview_json: ${error instanceof Error ? error.message : String(error)}`);
    return [textBlock(`[题目集解析失败: ${vfsRef.name}]`)];
  }
  if (typeof preview !== 'object' || preview === null) {
    return [textBlock(`[题目集解析失败: ${vfsRef.name}]`)];
  }

  let questionsXml = '';
  const stats = emptyStats();
  const pages = (preview as Record<string, unknown>).pages;
  if (Array.isArray(pages)) {
    for (const page of pages as Record<string, unknown>[]) {
      const cards = page.cards;
      if (!Array.isArray(cards)) continue;
      for (const card of cards as Record<string, unknown>[]) {
        stats.total += 1;
        const str = (key: string): string | null =>
          typeof card[key] === 'string' ? card[key] as string : null;
        const num = (key: string): number => {
          const value = card[key];
          if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
          return Math.trunc(value);
        };
        const label = str('questionLabel') ?? '';
        const ocr = str('ocrText') ?? '';
        const status = str('status') ?? 'new';
        const difficulty = str('difficulty');
        const questionType = str('questionType');
        const answer = str('answer');
        const explanation = str('explanation');
        const userNote = str('userNote');
        const userAnswer = str('userAnswer');
        const attemptCount = num('attemptCount');
        const correctCount = num('correctCount');
        const tagsValue = card.tags;
        const tags = Array.isArray(tagsValue)
          ? tagsValue.filter(item => typeof item === 'string').join(', ')
          : null;

        addStats(stats, questionStatus(status));

        const attrs = [`label="${escapeXmlAttr(label)}"`, `status="${escapeXmlAttr(status)}"`];
        if (difficulty !== null) attrs.push(`difficulty="${escapeXmlAttr(difficulty)}"`);
        if (questionType !== null) attrs.push(`type="${escapeXmlAttr(questionType)}"`);
        if (attemptCount > 0) {
          attrs.push(`attempts="${attemptCount}"`);
          attrs.push(`correct="${correctCount}"`);
        }
        questionsXml += `<question ${attrs.join(' ')}>\n`;
        questionsXml += `  <content>${escapeXmlContent(ocr)}</content>\n`;
        if (tags !== null && tags !== '') {
          questionsXml += `  <tags>${escapeXmlContent(tags)}</tags>\n`;
        }
        if (answer !== null) questionsXml += `  <answer>${escapeXmlContent(answer)}</answer>\n`;
        if (explanation !== null) {
          questionsXml += `  <explanation>${escapeXmlContent(explanation)}</explanation>\n`;
        }
        if (userAnswer !== null) {
          questionsXml += `  <user_answer>${escapeXmlContent(userAnswer)}</user_answer>\n`;
        }
        if (userNote !== null) questionsXml += `  <user_note>${escapeXmlContent(userNote)}</user_note>\n`;
        questionsXml += '</question>\n';
      }
    }
  }

  if (questionsXml === '') return [];
  return [textBlock(
    `<question_bank id="${escapeXmlAttr(vfsRef.sourceId)}" name="${escapeXmlAttr(vfsRef.name)}" source="preview_ocr">\n` +
    `${buildStatsXml(stats, '')}\n<questions>\n${questionsXml}</questions>\n</question_bank>`,
  )];
}

/** `build_exam_history_xml`：每题最近 5 条作答，ai_feedback 不注入。 */
export function buildExamHistoryXml(db: SqlExecutor, examId: string): string {
  const rows = examHistoryRows(db, examId);
  if (rows.length === 0) return '';
  let xml = '<answer_history>\n';
  let currentQuestionId = '';
  let countPerQuestion = 0;
  for (const row of rows) {
    if (row.questionId !== currentQuestionId) {
      if (currentQuestionId !== '') xml += '  </question_attempts>\n';
      currentQuestionId = row.questionId;
      countPerQuestion = 0;
      xml += `  <question_attempts question_id="${escapeXmlAttr(row.questionId)}" label="${escapeXmlAttr(row.label)}">\n`;
    }
    if (countPerQuestion >= 5) continue;
    countPerQuestion += 1;
    const correct = row.isCorrect === 1 ? 'yes' : row.isCorrect === 0 ? 'no' : 'pending';
    xml += `    <attempt n="${countPerQuestion}" answer="${escapeXmlAttr(row.userAnswer)}" ` +
      `correct="${correct}" method="${escapeXmlAttr(row.gradingMethod)}" at="${escapeXmlAttr(row.submittedAt)}"/>\n`;
  }
  if (currentQuestionId !== '') xml += '  </question_attempts>\n';
  return `${xml}</answer_history>`;
}

/** `resolve_question_image_blob`：优先 hash/blobHash/compressedBlobHash，其次 files 表。 */
export function resolveQuestionImageBlob(
  db: SqlExecutor,
  imageValue: unknown,
): [string, string] | null {
  if (typeof imageValue !== 'object' || imageValue === null || Array.isArray(imageValue)) return null;
  const obj = imageValue as Record<string, unknown>;
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    return null;
  };
  let blobHash = pick('hash', 'blobHash', 'compressedBlobHash');
  const mimeType = pick('mime', 'mimeType') ?? 'image/png';
  if (blobHash === null) {
    const fileId = pick('id', 'sourceId');
    if (fileId !== null) blobHash = questionImageBlobHash(db, fileId);
  }
  return blobHash === null ? null : [blobHash, mimeType];
}

function readBlobBytes(
  db: SqlExecutor,
  blobsDir: string,
  hash: string,
  logger: VfsResolverLogger,
): Buffer | null {
  const blob = blobRow(db, hash);
  if (!blob) {
    logger.warn(`[VfsResolver] Blob not found for exam page: ${hash}`);
    return null;
  }
  try {
    return fs.readFileSync(path.join(blobsDir, blob.relativePath));
  } catch (error) {
    logger.warn(`[VfsResolver] Failed to read blob file: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function appendExamManualImages(
  db: SqlExecutor,
  blobsDir: string,
  examId: string,
  blocks: ContentBlock[],
  logger: VfsResolverLogger,
): void {
  const MAX_MANUAL_IMAGES = 24;
  const rows = examManualImageRows(db, examId);
  if (rows === null) return;
  const seen = new Set<string>();
  let injected = 0;
  for (const row of rows) {
    if (injected >= MAX_MANUAL_IMAGES) {
      blocks.push(textBlock('<system_note>题目手动图片较多，已按预算截断。</system_note>'));
      break;
    }
    let imagesValue: unknown;
    try { imagesValue = JSON.parse(row.imagesJson); } catch (error) { imagesValue = []; }
    if (!Array.isArray(imagesValue)) continue;
    for (const image of imagesValue) {
      if (injected >= MAX_MANUAL_IMAGES) break;
      const resolved = resolveQuestionImageBlob(db, image);
      if (resolved === null) continue;
      const [blobHash, mimeType] = resolved;
      if (seen.has(blobHash)) continue;
      seen.add(blobHash);
      const content = readBlobBytes(db, blobsDir, blobHash, logger);
      if (content === null) continue;
      blocks.push(textBlock(
        `<question_image question="${escapeXmlAttr(row.label)}">手动图片</question_image>`,
      ));
      blocks.push(imageBlock(mimeType, content.toString('base64')));
      injected += 1;
    }
  }
}

/** `resolve_exam_multimodal`：页图 + 题目 SSOT + 作答历史；预览解析失败走手动图片/文本。 */
export function resolveExamMultimodal(
  db: SqlExecutor,
  blobsDir: string,
  vfsRef: VfsResourceRef,
  previewJson: string,
  includeImages: boolean,
  includeOcrText: boolean,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  let preview: unknown;
  try { preview = JSON.parse(previewJson); } catch (error) {
    logger.warn(`[VfsResolver] Failed to parse exam preview_json: ${error instanceof Error ? error.message : String(error)}`);
    const blocks: ContentBlock[] = [];
    if (includeImages) appendExamManualImages(db, blobsDir, vfsRef.sourceId, blocks, logger);
    if (includeOcrText) {
      const ssot = buildExamQuestionsSsotBlock(db, vfsRef);
      if (ssot !== null) blocks.push(ssot);
      const history = buildExamHistoryXml(db, vfsRef.sourceId);
      if (history !== '') blocks.push(textBlock(history));
    }
    return blocks;
  }
  const blocks: ContentBlock[] = [];
  const previewObject = typeof preview === 'object' && preview !== null
    ? preview as Record<string, unknown>
    : {};
  if (includeImages && Array.isArray(previewObject.pages)) {
    for (const page of previewObject.pages as Record<string, unknown>[]) {
      const blobHash = typeof page.blobHash === 'string' ? page.blobHash : null;
      if (blobHash === null) continue;
      const content = readBlobBytes(db, blobsDir, blobHash, logger);
      if (content === null) continue;
      const mimeType = typeof page.mimeType === 'string' ? page.mimeType : 'image/png';
      blocks.push(imageBlock(mimeType, content.toString('base64')));
    }
  }
  if (includeImages) appendExamManualImages(db, blobsDir, vfsRef.sourceId, blocks, logger);
  if (includeOcrText) {
    const ssot = buildExamQuestionsSsotBlock(db, vfsRef);
    if (ssot !== null) blocks.push(ssot);
    else blocks.push(...resolveExamTextOnlyFromPreview(previewJson, vfsRef, logger));
  }
  if (includeOcrText) {
    const history = buildExamHistoryXml(db, vfsRef.sourceId);
    if (history !== '') blocks.push(textBlock(history));
  }
  return blocks;
}

/** `resolve_exam`：按注入模式决定图片/文本；无 preview 时仍注入 SSOT/历史。 */
export function resolveExam(
  db: SqlExecutor,
  blobsDir: string,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const pdfModes = vfsRef.injectModes?.pdf ?? null;
  const imageModes = vfsRef.injectModes?.image ?? null;
  const hasPdfModes = pdfModes != null && pdfModes.length > 0;
  const hasImageModes = imageModes != null && imageModes.length > 0;
  let includeImages: boolean;
  if (hasPdfModes) includeImages = pdfModes!.includes('image');
  else if (hasImageModes) includeImages = imageModes!.includes('image');
  else includeImages = true;
  const includeOcr = (pdfModes?.includes('ocr') ?? false) || (imageModes?.includes('ocr') ?? false);
  const includeExamText = includeOcr || !includeImages || (!hasPdfModes && !hasImageModes);

  const previewJson = examPreviewJsonRow(db, vfsRef.sourceId);
  if (previewJson === undefined) {
    return [textBlock(`[题目集未找到: ${vfsRef.name}]`)];
  }
  if (previewJson === null) {
    const blocks: ContentBlock[] = [];
    if (includeImages) appendExamManualImages(db, blobsDir, vfsRef.sourceId, blocks, logger);
    if (includeExamText) {
      const ssot = buildExamQuestionsSsotBlock(db, vfsRef);
      if (ssot !== null) blocks.push(ssot);
      const history = buildExamHistoryXml(db, vfsRef.sourceId);
      if (history !== '') blocks.push(textBlock(history));
    }
    return blocks;
  }
  return resolveExamMultimodal(db, blobsDir, vfsRef, previewJson, includeImages, includeExamText, logger);
}
