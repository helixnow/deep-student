/**
 * `resume_import` 旧 checkpoint 中依赖 L18 视觉组件的三条恢复路径（L14 编排，视觉能力经 `questionImportVision`）：
 * - DocxVlmDirect：`resume_import` 891-955 + `run_vlm_direct_extraction`（1666-1859）
 * - DOCX 原生：`run_docx_pipeline_from_vlm`（2053-2359）+ `associate_orphan_images`（2362-2467）
 * - Visual-First：`run_visual_pipeline_from_stage2`（1199-1376，按页有界并发 + 逐页/逐批 checkpoint）
 *   + `persist_structured_questions`（2793-2934）+ `rebuild_pages_from_checkpoint`（3731-3755）
 * 以及辅助函数 build_enriched_text / extract_marker_positions / sanitize_vlm_description /
 * extract_images_from_question_json / clean_image_markers_in_params / question_to_card / build_text_parse_prompt_with_images。
 *
 * 所有偏移量按 Rust 的 UTF-8 字节计算（`str::find` / `len()` / `Match::start()`）。
 */
import { nanoid } from 'nanoid';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { MergedQuestion, PageSlice, QuestionImportVisionService, StructuredQuestion,
  VlmPageAnalysis } from '../../media/api.ts';
import type { CreateQuestionParams, Question, QuestionImage } from '../../vfs-repos/api.ts';
import type { QuestionImportProgress } from '../api.ts';
import { contentDedupKey } from './csv-import.ts';
import { defaultExamCardBBoxJson } from './exam-card-bbox.ts';
import {
  buildTextParsePrompt, buildTextParsePromptWithImages, jsonToQuestionParams, noQuestionsError,
  rebuildPreviewFromQuestions, saveCheckpoint, segmentDocument,
  type DocxImageEntrySerde, type ImportCheckpointState, type LegacyResumeHost,
} from './question-import-legacy.ts';
import type { ImportResult, ImportRun, ProgressSink } from './question-import-service.ts';
import { toAppError } from './question-import-service.ts';
import { QbankServiceError } from './question-service.ts';
import { qbankLocalRuntime } from './local-runtime.ts';

type JsonObject = { [key: string]: JsonValue };

/** `VLM_PAGE_CONCURRENCY`。 */
export const VLM_PAGE_CONCURRENCY = 3;

function send(progress: ProgressSink, event: QuestionImportProgress): void {
  if (progress !== null) progress(event);
}

function message(error: unknown): string {
  return toAppError(error).message;
}

function rustTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

const byteLength = (value: string): number => utf8ByteLength(value);

/** `str::find`：返回 UTF-8 字节偏移。 */
function byteFind(haystack: string, needle: string): number | null {
  const index = haystack.indexOf(needle);
  return index === -1 ? null : byteLength(haystack.slice(0, index));
}

function committed(sessionId: string, name: string, saved: number): ImportResult {
  return {
    session_id: sessionId, name, imported_count: saved, total_questions: saved, draft_job_id: null,
    draft_version: null, draft_document: null, model_route: null, committed: true,
  };
}

function ignore(operation: () => void): void {
  try {
    operation();
  } catch { // boundary-allow empty-catch: Rust `let _ = VfsExamRepo::...` 显式忽略且无日志
  }
}

function refreshStats(host: LegacyResumeHost, sessionId: string): void {
  try {
    host.questions.refreshStats(host.db, sessionId);
  } catch (error) {
    host.log?.warn(`[QuestionImport] 统计刷新失败: ${message(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 文本辅助（逐字移植）

/** Rust `regex` 的 `\d` 为 Unicode 十进制数字；`parse::<usize>` 只接受 ASCII，非 ASCII 数字跳过。 */
function asciiIndex(digits: string): number | null {
  return /^[0-9]+$/.test(digits) ? Number(digits) : null;
}

/** `build_enriched_text`：`<<IMG:N>>` → `<<IMG:N:[图片内容: …]>>`（无描述为 `[图片]`）。 */
export function buildEnrichedText(textWithMarkers: string, descriptions: Record<string, string>): string {
  return textWithMarkers.replace(/<<IMG:(\p{Nd}+)>>/gu, (_whole, index: string) => {
    const description = Object.hasOwn(descriptions, index) ? descriptions[index] : undefined;
    return description === undefined ? `<<IMG:${index}:[图片]>>` : `<<IMG:${index}:[图片内容: ${description}]>>`;
  });
}

/** `extract_marker_positions`：`(index, 字节偏移)`。 */
export function extractMarkerPositions(enrichedText: string): [number, number][] {
  const out: [number, number][] = [];
  for (const match of enrichedText.matchAll(/<<IMG:(\p{Nd}+):/gu)) {
    const index = asciiIndex(match[1]!);
    if (index === null) continue;
    out.push([index, byteLength(enrichedText.slice(0, match.index))]);
  }
  return out;
}

/** `sanitize_vlm_description`：转义 `>>`、换行变空格、按字符截断并加省略号。 */
export function sanitizeVlmDescription(description: string, maxChars: number): string {
  const escaped = description.replaceAll('>>', '> >').replace(/[\n\r]/g, ' ');
  const chars = [...escaped];
  return chars.length <= maxChars ? escaped : `${chars.slice(0, maxChars).join('')}...`;
}

function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
}

function strField(value: JsonValue | undefined, key: string): string | null {
  const item = field(value, key);
  return typeof item === 'string' ? item : null;
}

/** `extract_images_from_question_json`：扫描 content/options/explanation/answer 中的 `<<IMG:N`。 */
export function extractImagesFromQuestionJson(question: JsonValue, imageMap: readonly DocxImageEntrySerde[]): QuestionImage[] {
  const found: number[] = [];
  const scan = (text: string | null) => {
    if (text === null) return;
    for (const match of text.matchAll(/<<IMG:(\p{Nd}+)/gu)) {
      const index = asciiIndex(match[1]!);
      if (index !== null) found.push(index);
    }
  };
  scan(strField(question, 'content'));
  const options = field(question, 'options');
  if (Array.isArray(options)) for (const option of options) scan(strField(option, 'content'));
  scan(strField(question, 'explanation'));
  scan(strField(question, 'answer'));
  const unique = [...new Set(found)].sort((left, right) => left - right);
  return unique.flatMap(index => {
    const entry = imageMap.find(item => item.marker_index === index);
    return entry === undefined ? [] : [{
      id: `img_${nanoid(10)}`, name: `docx_image_${entry.marker_index}.${entry.ext}`, mime: entry.mime,
      hash: entry.blob_hash, role: 'question',
    }];
  });
}

/** `clean_image_markers_in_params`：`<<IMG:N…>>` → `[图N]`。 */
export function cleanImageMarkersInParams(params: CreateQuestionParams): void {
  const clean = (text: string) => text.replace(/<<IMG:(\p{Nd}+)[\s\S]*?>>/gu, (_whole, index: string) => `[图${index}]`);
  params.content = clean(params.content);
  if (params.options !== null && params.options !== undefined) {
    for (const option of params.options) option.content = clean(option.content);
  }
  if (typeof params.explanation === 'string') params.explanation = clean(params.explanation);
  if (typeof params.answer === 'string') params.answer = clean(params.answer);
}

const CORE_QUESTION_TYPES = new Set(['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank',
  'short_answer', 'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other']);
const CORE_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'very_hard']);

/** `question_to_card`（ExamCardPreview serde 输出，跳过 None 字段）。 */
export function questionToCard(question: JsonValue, position: number): JsonObject {
  const card: JsonObject = {
    card_id: `card_${nanoid(12)}`,
    page_index: 0,
    question_label: `Q${position + 1}`,
    bbox: defaultExamCardBBoxJson(),
    ocr_text: strField(question, 'content') ?? '',
    tags: (() => {
      const tags = field(question, 'tags');
      return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
    })(),
  };
  const type = strField(question, 'question_type');
  if (type !== null && CORE_QUESTION_TYPES.has(type)) card.question_type = type;
  const answer = strField(question, 'answer');
  if (answer !== null) card.answer = answer;
  const explanation = strField(question, 'explanation');
  if (explanation !== null) card.explanation = explanation;
  const difficulty = strField(question, 'difficulty');
  if (difficulty !== null && CORE_DIFFICULTIES.has(difficulty)) card.difficulty = difficulty;
  card.status = 'new';
  card.attempt_count = 0;
  card.correct_count = 0;
  card.source_type = 'import_file';
  return card;
}

// ---------------------------------------------------------------------------
// DocxVlmDirect

/** `resume_import` 的 DocxVlmDirect 分支（VLM 未完成，从 VLM 调用处恢复）。 */
export async function resumeDocxVlmDirect(host: LegacyResumeHost, sessionId: string,
  checkpoint: ImportCheckpointState, progress: ProgressSink, run: ImportRun): Promise<ImportResult> {
  const vision = host.vision;
  const hashes = [...checkpoint.docx_vlm_direct_blob_hashes];
  const mimes = [...checkpoint.docx_vlm_direct_mimes];
  const exts = [...checkpoint.docx_vlm_direct_exts];
  const cleanText = checkpoint.docx_vlm_direct_text;
  const alreadySaved = checkpoint.docx_vlm_direct_saved;
  const name = checkpoint.qbank_name;
  const dataUrls: string[] = [];
  for (const [index, hash] of hashes.entries()) {
    const mime = mimes[index] ?? 'image/png';
    let blobPath: string | null = null;
    try {
      blobPath = host.blobs.getBlobPath(host.db, host.blobsDir, hash);
    } catch { // boundary-allow empty-catch: question_import_service.rs:916 `_ =>` 把查询错误与缺失同样处理（下方 warn）
      blobPath = null;
    }
    if (blobPath === null) {
      host.log?.warn(`[QuestionImport] 恢复时找不到 blob: ${hash}`);
      dataUrls.push('');
      continue;
    }
    try {
      dataUrls.push(`data:${mime};base64,${toBase64(qbankLocalRuntime().readFile(blobPath))}`);
    } catch (error) {
      host.log?.warn(`[QuestionImport] 恢复时读取 blob 文件失败: ${blobPath}: ${error instanceof Error ? error.message : String(error)}`);
      dataUrls.push('');
    }
  }
  send(progress, {
    type: 'Preprocessing', stage: 'vlm_extracting',
    message: `恢复 VLM 提取: ${dataUrls.length} 张图片, 已保存 ${alreadySaved} 题...`, percent: 20,
  });
  const [totalSaved, vlmPartial, saveFailed] = await runVlmDirectExtraction(host, vision, sessionId, dataUrls,
    hashes, mimes, exts, cleanText, checkpoint, alreadySaved, progress, run);
  rebuildPreviewFromQuestions(host, sessionId);
  ignore(() => host.exams.updateStatus(host.db, sessionId, 'completed'));
  ignore(() => host.exams.clearImportState(host.db, sessionId));
  refreshStats(host, sessionId);
  send(progress, {
    type: 'Completed', session_id: sessionId, name, total_questions: totalSaved,
    partial: vlmPartial || saveFailed > 0, failed_count: saveFailed,
  });
  return committed(sessionId, name, totalSaved);
}

/** `run_vlm_direct_extraction` → `[total_saved, vlm_partial, save_failed]`。 */
async function runVlmDirectExtraction(host: LegacyResumeHost, vision: QuestionImportVisionService, sessionId: string,
  dataUrls: string[], blobHashes: string[], mimes: string[], exts: string[], cleanText: string,
  checkpoint: ImportCheckpointState, skipCount: number, progress: ProgressSink,
  run: ImportRun): Promise<[number, boolean, number]> {
  let totalSaved = skipCount;
  let vlmPartial = false;
  let vlmQuestionIndex = 0;
  let saveFailed = 0;
  const existingKeys = new Set<string>();
  if (skipCount > 0) {
    try {
      for (const question of host.questions.listQuestions(host.db, sessionId, {}, 1, 10000).questions) {
        existingKeys.add(contentDedupKey(question.content));
      }
    } catch (error) {
      host.log?.warn(`[QuestionImport] 恢复去重: 读取已有题目失败: ${message(error)}`);
    }
  }
  let vlmCount: number;
  try {
    vlmCount = await run.step(vision.extractDocxQuestionsStream(dataUrls, cleanText, extracted => {
      if (run.cancelled) return false;
      vlmQuestionIndex += 1;
      if (vlmQuestionIndex <= skipCount) return true;
      if (rustTrim(extracted.content) === '') return true;
      if (skipCount > 0) {
        const key = contentDedupKey(extracted.content);
        if (existingKeys.has(key)) {
          host.log?.info?.(`[QuestionImport] 恢复去重: 跳过已存在的题目 (VLM #${vlmQuestionIndex})`);
          return true;
        }
        existingKeys.add(key);
      }
      const cardId = `card_${nanoid(12)}`;
      const images: QuestionImage[] = extracted.image_indices.flatMap(index => {
        if (index >= blobHashes.length) return [];
        const imageName = `docx_image_${index}.${exts[index] ?? 'png'}`;
        const imageMime = mimes[index] ?? 'image/png';
        const fileId = ensureFileForBlob(host, blobHashes[index]!, imageName, imageMime) ?? `file_${nanoid(10)}`;
        return [{ id: fileId, name: imageName, mime: imageMime, hash: blobHashes[index]!, role: 'question' }];
      });
      const questionJson = extracted as unknown as JsonValue;
      const params = jsonToQuestionParams(questionJson, sessionId, cardId, totalSaved);
      if (images.length > 0) params.images = images;
      try {
        host.questions.createQuestion(host.db, params);
      } catch (error) {
        host.log?.warn(`[QuestionImport] 保存题目 ${vlmQuestionIndex} 失败: ${message(error)}`);
        saveFailed += 1;
        return true;
      }
      totalSaved += 1;
      checkpoint.docx_vlm_direct_saved = totalSaved;
      saveCheckpoint(host, sessionId, checkpoint);
      send(progress, { type: 'QuestionParsed', question: questionJson, question_index: totalSaved - 1, total_parsed: totalSaved });
      return true;
    }));
    host.log?.info?.(`[QuestionImport] VLM 流式提取完成: VLM 输出 ${vlmCount} 题, 实际保存 ${totalSaved} 题`);
  } catch (error) {
    if (run.cancelled) throw error;
    const text = message(error);
    host.log?.error(`[QuestionImport] VLM DOCX 提取失败: ${text}`);
    if (totalSaved > skipCount) {
      host.log?.warn(`[QuestionImport] 已保存 ${totalSaved} 道题目（部分成功）`);
      vlmPartial = true;
    } else {
      send(progress, { type: 'Failed', session_id: sessionId, error: `VLM 提取失败: ${text}`, total_parsed: totalSaved });
      throw error instanceof QbankServiceError ? error : new QbankServiceError(toAppError(error));
    }
  }
  checkpoint.current_stage = 'docx_vlm_direct_done';
  checkpoint.docx_vlm_direct_saved = totalSaved;
  saveCheckpoint(host, sessionId, checkpoint);
  if (totalSaved === 0) {
    const error = saveFailed > 0 ? `VLM 提取到 ${saveFailed} 道题目但全部写入失败` : 'VLM 未能提取到任何题目';
    send(progress, { type: 'Failed', session_id: sessionId, error, total_parsed: 0 });
    throw new QbankServiceError(AppError.validation(error));
  }
  return [totalSaved, vlmPartial, saveFailed];
}

/** `ensure_vfs_file_for_blob`（L11 `files.ensureFileForBlobWithConn`）：失败 warn 并返回 null（调用方回退）。 */
function ensureFileForBlob(host: LegacyResumeHost, blobHash: string, fileName: string, mime: string): string | null {
  try {
    return host.ensureFileForBlob(blobHash, fileName, mime);
  } catch (error) {
    host.log?.warn(`[QuestionImport] ensure_vfs_file: 创建 file 条目失败: ${message(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOCX 原生（text + marker）

/** `run_docx_pipeline_from_vlm`。 */
export async function runDocxPipelineFromVlm(host: LegacyResumeHost, sessionId: string,
  imageMap: readonly DocxImageEntrySerde[], hasImages: boolean, checkpoint: ImportCheckpointState,
  vlmStartIndex: number, progress: ProgressSink, run: ImportRun): Promise<ImportResult> {
  const name = checkpoint.qbank_name;
  const totalImages = imageMap.length;
  if (checkpoint.current_stage === 'docx_extracted' || checkpoint.current_stage === 'docx_vlm_describing') {
    checkpoint.current_stage = 'docx_vlm_describing';
    saveCheckpoint(host, sessionId, checkpoint);
    if (hasImages) {
      for (let index = vlmStartIndex; index < totalImages; index += 1) {
        const entry = imageMap[index]!;
        send(progress, { type: 'OcrImageCompleted', image_index: index, total_images: totalImages });
        let bytes: Uint8Array;
        try {
          bytes = host.vision.loadPageImageBytes(entry.blob_hash);
        } catch (error) {
          host.log?.warn(`[QuestionImport] 图片 ${index} blob 加载失败: ${message(error)}`);
          checkpoint.docx_vlm_images_completed = index + 1;
          saveCheckpoint(host, sessionId, checkpoint);
          continue;
        }
        host.log?.info?.(`[QuestionImport] VLM 描述图片 ${index + 1}/${totalImages} (${entry.mime}, ${bytes.length} bytes)`);
        try {
          const description = await run.step(host.vision.describeImage(bytes));
          if (description !== '') {
            const safe = sanitizeVlmDescription(description, 500);
            host.log?.info?.(`[QuestionImport] 图片 ${index} VLM 描述: ${[...safe].slice(0, 80).join('')}...`);
            checkpoint.docx_vlm_descriptions[String(index)] = safe;
          } else {
            host.log?.warn(`[QuestionImport] 图片 ${index} VLM 返回空描述`);
          }
        } catch (error) {
          if (run.cancelled) throw error;
          host.log?.warn(`[QuestionImport] 图片 ${index} VLM 描述失败: ${message(error)}`);
        }
        checkpoint.docx_vlm_images_completed = index + 1;
        saveCheckpoint(host, sessionId, checkpoint);
      }
      send(progress, {
        type: 'OcrPhaseCompleted', total_images: totalImages,
        total_chars: Object.values(checkpoint.docx_vlm_descriptions).reduce((sum, item) => sum + byteLength(item), 0),
      });
    }
    const enriched = buildEnrichedText(checkpoint.text_content, checkpoint.docx_vlm_descriptions);
    checkpoint.docx_marker_positions = extractMarkerPositions(enriched);
    checkpoint.docx_enriched_text = enriched;
    checkpoint.current_stage = 'docx_vlm_done';
    saveCheckpoint(host, sessionId, checkpoint);
  }

  const enrichedText = checkpoint.docx_enriched_text;
  const markerPositions = checkpoint.docx_marker_positions;
  const maxTokensPerChunk = 6000;
  const chunks = Math.floor([...enrichedText].length / 2) <= maxTokensPerChunk
    ? [enrichedText] : segmentDocument(enrichedText, maxTokensPerChunk);
  const totalChunks = chunks.length;
  checkpoint.chunks_total = totalChunks;
  const chunksStart = checkpoint.chunks_completed;
  checkpoint.current_stage = 'docx_structuring';
  saveCheckpoint(host, sessionId, checkpoint);

  let totalParsed = 0;
  if (chunksStart > 0) {
    try {
      totalParsed = host.questions.listQuestions(host.db, sessionId, {}, 1, 1).total;
    } catch { // boundary-allow empty-catch: question_import_service.rs:2177 `.unwrap_or(0)`，Rust 无日志
      totalParsed = 0;
    }
  }
  const questionOffsets: [number, number][] = [];
  let chunkByteOffset = chunks.slice(0, chunksStart).reduce((sum, chunk) => sum + byteLength(chunk), 0);
  let totalSaveFailed = 0;
  let firstFailure: string | null = null;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    if (chunkIndex < chunksStart) continue;
    const chunk = chunks[chunkIndex]!;
    send(progress, { type: 'ChunkStart', chunk_index: chunkIndex, total_chunks: totalChunks });
    const prompt = hasImages ? buildTextParsePromptWithImages(chunk) : buildTextParsePrompt(chunk);
    const chunkStartOffset = chunkByteOffset;
    const chunkBytes = byteLength(chunk);
    let questionsInChunk = 0;
    try {
      await run.step(host.questionParsing.parseStreaming(prompt, checkpoint.model_config_id, question => {
        if (run.cancelled) return false;
        const content = strField(question, 'content') ?? '';
        if (rustTrim(content) === '') return true;
        const cardId = `card_${nanoid(12)}`;
        const images = hasImages ? extractImagesFromQuestionJson(question, imageMap) : [];
        if (hasImages) {
          const snippet = [...content].slice(0, 30).join('');
          const fallback = Math.floor((questionsInChunk * chunkBytes) / Math.max(questionsInChunk + 1, 1));
          const localPos = byteLength(snippet) >= 6 ? byteFind(chunk, snippet) ?? fallback : fallback;
          questionOffsets.push([totalParsed, chunkStartOffset + localPos]);
        }
        const params = jsonToQuestionParams(question, sessionId, cardId, totalParsed);
        if (images.length > 0) params.images = images;
        cleanImageMarkersInParams(params);
        try {
          host.questions.createQuestion(host.db, params);
        } catch (error) {
          host.log?.warn(`[QuestionImport] 保存题目失败: ${message(error)}`);
          totalSaveFailed += 1;
          if (hasImages) questionOffsets.pop();
          return true;
        }
        totalParsed += 1;
        questionsInChunk += 1;
        send(progress, { type: 'QuestionParsed', question, question_index: totalParsed - 1, total_parsed: totalParsed });
        return true;
      }));
    } catch (error) {
      if (run.cancelled) throw error;
      const text = message(error);
      host.log?.warn(`[QuestionImport] DOCX 块 ${chunkIndex + 1} 解析失败: ${text}`);
      firstFailure ??= text;
    }
    chunkByteOffset += chunkBytes;
    checkpoint.chunks_completed = chunkIndex + 1;
    saveCheckpoint(host, sessionId, checkpoint);
    send(progress, {
      type: 'ChunkCompleted', chunk_index: chunkIndex, total_chunks: totalChunks,
      questions_in_chunk: questionsInChunk, total_parsed: totalParsed,
    });
  }

  if (hasImages && totalParsed > 0) associateOrphanImages(host, sessionId, imageMap, markerPositions, questionOffsets);

  if (totalParsed === 0) {
    ignore(() => host.exams.updateStatus(host.db, sessionId, 'completed'));
    ignore(() => host.exams.clearImportState(host.db, sessionId));
    const error = totalSaveFailed > 0
      ? `解析到 ${totalSaveFailed} 道题目但全部写入失败` : noQuestionsError('未能提取到题目', firstFailure);
    send(progress, { type: 'Failed', session_id: sessionId, error, total_parsed: 0 });
    throw new QbankServiceError(AppError.validation(error));
  }
  ignore(() => host.exams.updateStatus(host.db, sessionId, 'completed'));
  ignore(() => host.exams.clearImportState(host.db, sessionId));
  refreshStats(host, sessionId);
  send(progress, {
    type: 'Completed', session_id: sessionId, name, total_questions: totalParsed,
    partial: totalSaveFailed > 0, failed_count: totalSaveFailed,
  });
  return committed(sessionId, name, totalParsed);
}

/** `associate_orphan_images`：LLM 丢弃图片标记时，按原文位置把孤儿图片关联到最近的前驱题目。 */
function associateOrphanImages(host: LegacyResumeHost, sessionId: string, imageMap: readonly DocxImageEntrySerde[],
  markerPositions: readonly [number, number][], questionOffsets: readonly [number, number][]): void {
  let questions: Question[];
  try {
    questions = host.questions.listQuestions(host.db, sessionId, {}, 1, 10000).questions;
  } catch { // boundary-allow empty-catch: question_import_service.rs:2378 `Err(_) => return`，Rust 无日志
    return;
  }
  const claimed = new Set<string>();
  for (const question of questions) for (const image of question.images) claimed.add(image.hash);
  const orphans = imageMap.filter(entry => !claimed.has(entry.blob_hash));
  if (orphans.length === 0) return;
  host.log?.info?.(`[QuestionImport] DOCX 图片兜底关联: ${orphans.length} 张孤儿图片`);
  if (questions.length === 0 || questionOffsets.length === 0) return;
  const updates = new Map<string, QuestionImage[]>();
  for (const orphan of orphans) {
    const marker = markerPositions.find(([index]) => index === orphan.marker_index);
    let target = 0;
    if (marker !== undefined) {
      for (const [questionIndex, offset] of questionOffsets) if (offset <= marker[1]) target = questionIndex;
    }
    const question = questions[target];
    if (question === undefined) continue;
    const list = updates.get(question.id) ?? [];
    list.push({ id: `img_${nanoid(10)}`, name: `docx_image_${orphan.marker_index}.${orphan.ext}`, mime: orphan.mime,
      hash: orphan.blob_hash, role: 'question' });
    updates.set(question.id, list);
  }
  for (const [questionId, newImages] of updates) {
    const question = questions.find(item => item.id === questionId);
    if (question === undefined) continue;
    try {
      host.questions.updateQuestion(host.db, questionId, { images: [...question.images, ...newImages] });
    } catch (error) {
      host.log?.warn(`[QuestionImport] 兜底关联图片到 ${questionId} 失败: ${message(error)}`);
    }
  }
  host.log?.info?.(`[QuestionImport] 兜底关联完成: ${orphans.length} 张图片 → ${updates.size} 道题目`);
}

// ---------------------------------------------------------------------------
// Visual-First

/** `rebuild_pages_from_checkpoint`。 */
export function rebuildPagesFromCheckpoint(checkpoint: ImportCheckpointState): PageSlice[] {
  return checkpoint.page_blob_hashes.map((hash, index) => {
    const [width, height] = checkpoint.page_dimensions[index] ?? [0, 0];
    return { page_index: index, blob_hash: hash, text_hint: null, width, height };
  });
}

/**
 * futures `stream::iter(start..n).map(analyze).buffered(3)`：最多 3 页并发，结果按页序产出。
 * 每次产出后由调用方逐页写 checkpoint（连续前缀），被丢弃时未产出的在途页结果不落盘。
 */
async function* analyzePagesBuffered(vision: QuestionImportVisionService, pages: readonly PageSlice[],
  start: number, run: ImportRun): AsyncGenerator<[number, { ok: true; value: VlmPageAnalysis } | { ok: false; error: unknown }]> {
  const inflight: Promise<{ ok: true; value: VlmPageAnalysis } | { ok: false; error: unknown }>[] = [];
  const launch = (index: number) => {
    inflight.push(vision.analyzePageByBlob(pages[index]!).then(value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error })));
  };
  let next = start;
  while (next < pages.length && inflight.length < VLM_PAGE_CONCURRENCY) launch(next++);
  for (let index = start; index < pages.length; index += 1) {
    const result = await run.step(inflight.shift()!);
    if (next < pages.length) launch(next++);
    yield [index, result];
  }
}

/** `run_visual_pipeline_from_stage2`：Stage 2–6，首次导入与恢复共用。 */
export async function runVisualPipelineFromStage2(host: LegacyResumeHost, sessionId: string, qbankName: string,
  pages: readonly PageSlice[], checkpoint: ImportCheckpointState, vlmStartPage: number, progress: ProgressSink,
  run: ImportRun): Promise<ImportResult> {
  const vision = host.vision;
  checkpoint.current_stage = 'vlm_analyzing';
  saveCheckpoint(host, sessionId, checkpoint);
  const analyses: (VlmPageAnalysis | null)[] = checkpoint.vlm_page_results
    .map(text => (/^\p{White_Space}*$/u.test(text) ? null : vision.decodeVlmPageAnalysis(text)));
  let firstFailure: string | null = null;
  for await (const [index, result] of analyzePagesBuffered(vision, pages, vlmStartPage, run)) {
    while (analyses.length <= index) analyses.push(null);
    while (checkpoint.vlm_page_results.length <= index) checkpoint.vlm_page_results.push('');
    if (result.ok) {
      host.log?.info?.(`[QuestionImport] VLM 页面 ${index + 1}/${pages.length}: ${result.value.questions.length} 道题目`);
      checkpoint.vlm_page_results[index] = vision.encodeVlmPageAnalysis(result.value);
      analyses[index] = result.value;
    } else {
      const text = message(result.error);
      host.log?.warn(`[QuestionImport] VLM 页面 ${index + 1} 失败: ${text}`);
      firstFailure ??= text;
    }
    checkpoint.vlm_pages_completed = index + 1;
    saveCheckpoint(host, sessionId, checkpoint);
    send(progress, { type: 'OcrImageCompleted', image_index: index, total_images: pages.length });
  }
  checkpoint.current_stage = 'vlm_completed';
  saveCheckpoint(host, sessionId, checkpoint);
  const totalChars = analyses.reduce((sum, analysis) => sum + (analysis === null ? 0
    : analysis.questions.reduce((inner, question) => inner + byteLength(question.raw_text), 0)), 0);
  send(progress, { type: 'OcrPhaseCompleted', total_images: pages.length, total_chars: totalChars });

  send(progress, { type: 'Preprocessing', stage: 'merging', message: '正在跨页合并题目...', percent: 42 });
  const merged: MergedQuestion[] = vision.mergePages(analyses);
  if (merged.length === 0) {
    const error = noQuestionsError('未能识别出题目', firstFailure);
    send(progress, { type: 'Failed', session_id: sessionId, error, total_parsed: 0 });
    ignore(() => host.exams.updateStatus(host.db, sessionId, 'completed'));
    throw new QbankServiceError(AppError.validation(error));
  }

  send(progress, { type: 'ExtractingFigures', current: 0, total: merged.length });
  const withFigures = await run.step(vision.extractFigures(merged, pages));
  checkpoint.current_stage = 'figures_extracted';
  saveCheckpoint(host, sessionId, checkpoint);
  send(progress, { type: 'ExtractingFigures', current: withFigures.length, total: withFigures.length });

  checkpoint.current_stage = 'structuring';
  saveCheckpoint(host, sessionId, checkpoint);
  send(progress, { type: 'StructuringQuestion', current: checkpoint.structuring_batches_completed, total: withFigures.length });
  let structuredResult: [number, string[], StructuredQuestion[]];
  try {
    structuredResult = await run.step(vision.structureQuestions(withFigures, checkpoint.model_config_id,
      checkpoint.structuring_batches_completed, checkpoint.structured_batch_results));
  } catch (error) {
    throw error instanceof QbankServiceError ? error : new QbankServiceError(toAppError(error));
  }
  const [batchesDone, batchJsons, structured] = structuredResult;
  checkpoint.structuring_batches_completed = batchesDone;
  checkpoint.structured_batch_results = batchJsons;
  saveCheckpoint(host, sessionId, checkpoint);
  return persistStructuredQuestions(host, sessionId, qbankName, structured, pages, progress);
}

/** `persist_structured_questions`：SAVEPOINT 内写题目、预览与状态；成功后刷新统计并清除断点。 */
function persistStructuredQuestions(host: LegacyResumeHost, sessionId: string, qbankName: string,
  structured: readonly StructuredQuestion[], pages: readonly PageSlice[], progress: ProgressSink): ImportResult {
  const hasContent = (item: StructuredQuestion) => rustTrim(strField(item.json, 'content') ?? '') !== '';
  const totalSaved = host.db.transaction(tx => {
    let saved = 0;
    for (const [index, item] of structured.entries()) {
      if (!hasContent(item)) continue;
      const params = jsonToQuestionParams(item.json, sessionId, `card_${nanoid(12)}`, index);
      if (item.source.images.length > 0) params.images = [...item.source.images];
      try {
        host.questions.createQuestion(tx, params);
      } catch (error) {
        throw new QbankServiceError(AppError.database(`写入题目失败: ${message(error)}`));
      }
      saved += 1;
      send(progress, { type: 'QuestionParsed', question: item.json, question_index: index, total_parsed: saved });
    }
    const cards = structured.flatMap((item, index) => (hasContent(item) ? [questionToCard(item.json, index)] : []));
    const preview: JsonObject = {
      temp_id: sessionId,
      exam_name: qbankName,
      pages: pages.map(page => ({
        page_index: page.page_index, blob_hash: page.blob_hash, width: page.width, height: page.height,
        cards: page.page_index === 0 ? cards : [], ocr_completed: true, parse_completed: true,
      })),
      session_id: sessionId,
    };
    try {
      host.exams.updatePreviewJson(tx, sessionId, preview);
    } catch (error) {
      throw new QbankServiceError(AppError.database(`更新 preview 失败: ${message(error)}`));
    }
    try {
      host.exams.updateStatus(tx, sessionId, 'completed');
    } catch (error) {
      throw new QbankServiceError(AppError.database(`更新状态失败: ${message(error)}`));
    }
    return saved;
  });
  if (totalSaved > 0) refreshStats(host, sessionId);
  ignore(() => host.exams.clearImportState(host.db, sessionId));
  send(progress, {
    type: 'Completed', session_id: sessionId, name: qbankName, total_questions: totalSaved, partial: false, failed_count: 0,
  });
  return committed(sessionId, qbankName, totalSaved);
}
