/**
 * `qbank_import_document`: input resolution of `chat_v2/tools/qbank_import_source.rs`
 * (`resolve_import_input`) and `execute_import_document` (qbank_executor.rs:4653).
 */
import type { ExecutionContext } from '../../../chat/api.ts';
import type { ApiConfig } from '../../../llm/api.ts';
import { with_localized_message, type JsonValue } from '../../../../platform/errors/api.ts';
import { toBase64 } from '../../../../platform/crypto/encoding.ts';
import { decodeBase64Standard, encodeUtf8, rustTrim } from '../../../../platform/util/portable.ts';
import type { SourceRange } from '../../api.ts';
import { noteIdForResource } from '../../repository/import-source.ts';
import { opt, req, string, struct, u32, vec } from '../../repository/serde-decode.ts';
import * as authoring from '../authoring-service.ts';
import { documentNeedsReview } from '../document.ts';
import { ImportRun, prepareDocument, toAppError, type ImportResult } from '../question-import-service.ts';
import { asStr, errorText, qbankFailure, type Args } from './qbank-tool-args.ts';
import type { QbankToolEnv } from './qbank-tool-env.ts';

type JsonObject = Record<string, unknown>;

/** Text formats the importer decodes from base64 as UTF-8/GBK. */
const TEXT_FORMATS = ['txt', 'md', 'markdown', 'csv', 'json'];
/** Formats the importer consumes as raw bytes (base64). */
const NATIVE_FORMATS = ['pdf', 'docx', 'xlsx', 'xls', 'txt', 'md', 'markdown', 'csv', 'json', 'png', 'jpg', 'jpeg',
  'webp', 'bmp', 'gif', 'tiff', 'heic', 'heif'];

export interface ResolvedImportInput {
  content: string;
  format: string;
  defaultName: string | null;
  source: JsonObject | null;
}
export type ImportInput = { ready: ResolvedImportInput } | { notReady: JsonObject };

/** Only the published file fields `resolve_file` reads. */
interface ImportFile {
  id: string; fileName: string; fileType: string; mimeType?: string | null;
  processingStatus?: string | null; processingProgress?: string | null;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, ch => ch.toLowerCase());
}

function nonEmptyStr(args: Args, key: string): string | null {
  const value = asStr(args[key]);
  if (value === null) return null;
  const trimmed = rustTrim(value);
  return trimmed === '' ? null : trimmed;
}

/** `base64::engine::general_purpose::STANDARD.decode`: padded, canonical trailing bits. */
function strictBase64(payload: string): Uint8Array | null {
  const decoded = decodeBase64Standard(payload);
  return decoded.bytes ?? null;
}

function utf8Valid(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

function utf8Base64(text: string): string {
  return toBase64(encodeUtf8(text));
}

/** qbank_import_source.rs:117 `normalize_text_content`. */
function normalizeTextContent(content: string): string {
  const trimmed = rustTrim(content);
  let payload = trimmed;
  if (trimmed.startsWith('data:')) {
    const comma = trimmed.indexOf(',');
    if (comma >= 0) payload = trimmed.slice(comma + 1);
  }
  const bytes = strictBase64(payload);
  if (bytes !== null && utf8Valid(bytes)) return payload;
  return utf8Base64(content);
}

/** `DocumentProcessingExecutor::sanitize_id`. */
function sanitizeId(raw: string): string {
  const trimmed = rustTrim(raw).replace(/^["'`]+|["'`]+$/gu, '');
  if (trimmed === '' || !/^[A-Za-z0-9_-]+$/u.test(trimmed)) throw new Error(`资源 ID 格式无效: ${raw}`);
  return trimmed;
}

/** qbank_import_source.rs:337 `file_stem`. */
function fileStem(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  const stem = dot >= 0 && rustTrim(fileName.slice(0, dot)) !== '' ? fileName.slice(0, dot) : fileName;
  const trimmed = rustTrim(stem);
  return trimmed === '' ? null : trimmed;
}

/** qbank_import_source.rs:311 `infer_native_format`. */
function inferNativeFormat(file: ImportFile): string | null {
  const dot = file.fileName.lastIndexOf('.');
  if (dot >= 0) {
    const ext = asciiLower(file.fileName.slice(dot + 1));
    if (NATIVE_FORMATS.includes(ext)) return ext;
  }
  const mime = asciiLower(file.mimeType ?? '');
  switch (mime) {
    case 'application/pdf': return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    case 'application/vnd.ms-excel': return 'xls';
    case 'text/plain': return 'txt';
    case 'text/markdown': return 'md';
    case 'text/csv': return 'csv';
    case 'application/json': return 'json';
    default:
      if (mime.startsWith('image/') || file.fileType === 'image') return 'image';
      return null;
  }
}

/** qbank_import_source.rs:61 `resolve_import_input`. */
export async function resolveImportInput(env: QbankToolEnv): Promise<ImportInput> {
  const { args } = env;
  let resourceId = nonEmptyStr(args, 'resource_id');
  const fileId = nonEmptyStr(args, 'file_id');
  const rawContent = asStr(args.content);
  const content = rawContent !== null && rustTrim(rawContent) !== '' ? rawContent : null;
  if (resourceId !== null && fileId !== null && resourceId !== fileId) {
    throw new Error(`resource_id（${resourceId}）与 file_id（${fileId}）不一致：二者是同一参数的别名，只传 resource_id 即可。`);
  }
  resourceId ??= fileId;
  if (resourceId !== null && content !== null) {
    throw new Error('content 与 resource_id 互斥：资源库中的文件只传 resource_id（不要再传 base64/文本 content）；没有资源时才传 content。');
  }
  if (resourceId === null && content === null) {
    throw new Error('缺少导入来源：资源库（Files）里的文件/笔记请传 resource_id（resource_list/resource_read 返回的 file_*/res_*/note_* ID）；否则传 content。');
  }
  if (resourceId !== null) {
    env.vfs();
    return resolveResource(env, resourceId);
  }
  const format = asciiLower(nonEmptyStr(args, 'format') ?? 'txt');
  return { ready: {
    content: TEXT_FORMATS.includes(format) ? normalizeTextContent(content!) : content!,
    format, defaultName: null, source: null,
  } };
}

async function resolveResource(env: QbankToolEnv, rawId: string): Promise<ImportInput> {
  const id = sanitizeId(rawId);
  const noteId = noteIdFor(env, id);
  if (noteId !== null) return resolveNote(env, id, noteId);
  const { db, repos } = env.vfs();
  let file: ImportFile | null = null;
  try { file = repos.files.getFile(db, id); } catch { file = null; }
  if (file === null) {
    const docs = env.deps.docs();
    try {
      if (docs === null) throw new Error('文档解析服务未提供');
      const resolved = docs.resolveFile(id);
      file = repos.files.getFile(db, resolved.id) ?? resolved;
    } catch (error) {
      throw new Error(`${errorText(error)}（qbank_import_document 仅支持资源库中的文件——PDF/DOCX/TXT/MD/CSV/XLSX/图片——与笔记）`);
    }
  }
  return resolveFile(env, id, file);
}

/** qbank_import_source.rs:156 `note_id_for`. */
function noteIdFor(env: QbankToolEnv, id: string): string | null {
  if (id.startsWith('note_')) return id;
  if (!id.startsWith('res_')) return null;
  const { db } = env.vfs();
  try { return noteIdForResource(db, id); }
  catch (error) { throw new Error(`查询笔记失败: ${errorText(error)}`); }
}

/** qbank_import_source.rs:175 `resolve_note`. */
function resolveNote(env: QbankToolEnv, requestedId: string, noteId: string): ImportInput {
  const notes = env.deps.notes();
  if (notes === null) throw new Error('查询笔记失败: 笔记服务未提供');
  let note;
  try { note = notes.getNote(noteId); }
  catch (error) { throw new Error(`查询笔记失败: ${errorText(error)}`); }
  if (note === null) throw new Error(`笔记不存在: ${noteId}（请用 resource_list/resource_search 获取有效 ID）`);
  let content: string | null;
  try { content = notes.getNoteContent(noteId); }
  catch (error) { throw new Error(`读取笔记内容失败: ${errorText(error)}`); }
  if (rustTrim(content ?? '') === '') throw new Error(`笔记「${note.title}」内容为空，无法导入题目`);
  return { ready: {
    content: utf8Base64(content!), format: 'md',
    defaultName: rustTrim(note.title) === '' ? null : note.title,
    source: { resource_id: requestedId, note_id: noteId, title: note.title, content_source: 'note' },
  } };
}

/** qbank_import_source.rs:207 `resolve_file`. */
async function resolveFile(env: QbankToolEnv, requestedId: string, file: ImportFile): Promise<ImportInput> {
  const { db, repos } = env.vfs();
  const defaultName = fileStem(file.fileName);
  const source = (contentSource: string, format: string): JsonObject => ({
    resource_id: requestedId, file_id: file.id, file_name: file.fileName, format, content_source: contentSource,
  });

  const nativeFormat = inferNativeFormat(file);
  if (nativeFormat !== null) {
    try {
      const base64 = repos.files.getContent(db, env.deps.blobsDir(), file.id);
      if (base64 !== null && rustTrim(base64) !== '') {
        return { ready: { content: base64, format: nativeFormat, defaultName, source: source('original_file', nativeFormat) } };
      }
      env.deps.log.warn(`[QbankImport] 资源 ${file.id} 原始文件不可用，回退到已解析/OCR 文本`);
    } catch (error) {
      env.deps.log.warn(`[QbankImport] 资源 ${file.id} 原始文件读取失败（${errorText(error)}），回退到已解析/OCR 文本`);
    }
  }

  const refText = env.deps.refText();
  if (refText === null) throw new Error('资源文本抽取服务未提供（vfsRefText）');
  const text = await refText.extractFileTextWithStrategy(db, file.id, file.fileName, null);
  if (text !== null && rustTrim(text) !== '') {
    return { ready: { content: utf8Base64(text), format: 'txt', defaultName,
      source: source('extracted_text', 'txt') } };
  }

  const stage = file.processingStatus === undefined || file.processingStatus === null || file.processingStatus === ''
    ? null : file.processingStatus;
  const stageInProgress = stage !== null && stage !== 'completed' && stage !== 'completed_with_issues' && stage !== 'error';
  if (env.deps.isParseRunning(file.id) || stageInProgress) {
    return { notReady: {
      success: false, status: 'processing', resource_id: requestedId, file_id: file.id, file_name: file.fileName,
      stage, progress: file.processingProgress ?? null,
      message: `「${file.fileName}」仍在解析/OCR 中，暂无可导入的内容`,
      hint: '用 document_parse_status 轮询该 resource_id，完成后再用同一 resource_id 调用 qbank_import_document；不要自行编码 base64 或调用 shell。',
    } };
  }
  const kind = file.mimeType !== undefined && file.mimeType !== null && file.mimeType !== '' ? file.mimeType : file.fileType;
  if (nativeFormat !== null) {
    throw new Error(`资源「${file.fileName}」（${kind}）既读不到原始文件，也没有已解析/OCR 文本。PDF/图片可先用 document_parse 发起解析，完成后再用同一 resource_id 导入。`);
  }
  throw new Error(`资源「${file.fileName}」（${kind}）不是题库导入支持的格式（PDF/DOCX/TXT/MD/CSV/XLSX/JSON/图片），且没有已解析文本。PPTX 等可先用对应的 Office 读取工具取得题目文本，再用 qbank_batch_import 导入。`);
}

const decodeSourceRanges = vec(struct<SourceRange>('SourceRange', {
  source_id: req(string), start_page: opt(u32), end_page: opt(u32),
}));

function authoringConfig(ctx: ExecutionContext): ApiConfig | null {
  return (ctx as ExecutionContext & { question_authoring_config?: ApiConfig | null }).question_authoring_config ?? null;
}

function authoringRoute(ctx: ExecutionContext): Record<string, unknown> | null {
  const config = authoringConfig(ctx);
  if (config === null) return null;
  return { model_config_id: config.id, name: config.name, model: config.model,
    provider_type: config.providerType ?? null, is_multimodal: config.isMultimodal,
    max_output_tokens: config.maxOutputTokens ?? null, max_tokens_limit: config.maxTokensLimit ?? null,
    context_window: config.contextWindow ?? null };
}

function trimmedArg(args: Args, key: string): string | null {
  return nonEmptyStr(args, key);
}

/** qbank_executor.rs:4653 `execute_import_document`. */
export async function executeImportDocument(env: QbankToolEnv): Promise<unknown> {
  const input = await resolveImportInput(env);
  if ('notReady' in input) return input.notReady;
  const resolved = input.ready;
  const mode = asStr(env.args.mode) ?? 'preview';
  if (mode !== 'preview' && mode !== 'commit' && mode !== 'create') {
    throw qbankFailure('INVALID_ARGS', `不支持的导入模式: ${mode}`,
      'mode 只能是 preview（只生成草稿）或 commit（明确要求入库，兼容旧create）');
  }
  return env.lock.run(() => importDocument(env, resolved, mode));
}

async function importDocument(env: QbankToolEnv, resolved: ResolvedImportInput, mode: string): Promise<unknown> {
  const { args, ctx } = env;
  const name = trimmedArg(args, 'name') ?? resolved.defaultName;
  const sessionId = trimmedArg(args, 'session_id');
  const folderId = trimmedArg(args, 'folder_id');
  const host = env.deps.documentImport();
  if (host === null) throw new Error('LLM Manager not available');
  env.vfs();
  const trusted = authoringConfig(ctx);
  if (asciiLower(resolved.format) !== 'json' && trusted === null) {
    throw qbankFailure('MODEL_CONTEXT_UNAVAILABLE', '当前工具调用缺少可信的实际对话模型快照，无法解析该文档',
      '重新发送本轮请求；不要回退到默认模型、出题槽或让模型自行指定模型 ID');
  }
  let sourceRanges: SourceRange[];
  try { sourceRanges = decodeSourceRanges(Object.hasOwn(args, 'source_ranges') ? args.source_ranges : [], ''); }
  catch (error) { throw new Error(`source_ranges 无效: ${errorText(error)}`); }

  let result: ImportResult;
  try {
    result = await prepareDocument(host, {
      content: resolved.content, format: resolved.format, name, session_id: sessionId, folder_id: folderId,
      model_config_id: trusted?.id ?? null, pdf_prefer_ocr: null, source_ranges: sourceRanges,
    }, null, trusted, new ImportRun(ctx.cancellation_token, '题目解析已取消'));
  } catch (error) {
    const appError = toAppError(error) as { message: string; details?: unknown };
    const details = appError.details;
    if (details !== null && typeof details === 'object' && (details as JsonObject).code === 'SOURCE_RANGE_PLAN_REQUIRED') {
      throw new Error(JSON.stringify({ code: 'SOURCE_RANGE_PLAN_REQUIRED', message: appError.message, details,
        retryable: false,
        hint: '完整原文已保留。请展示返回的范围计划和跨页/答案依赖警告，取得用户明确范围选择后用 source_ranges 重试；不能自动丢弃页或把部分内容宣称为整份。' }));
    }
    throw new Error(`解析文档失败: ${appError.message}`);
  }

  const jobId = result.draft_job_id;
  if (jobId === null) throw qbankFailure('INCOMPLETE_RESULT', '导入器未返回草稿任务', '重新解析文档；不要伪称已导入');
  const authoringHost = env.deps.authoringHost();
  let draft;
  try { draft = authoring.getDraft(authoringHost, jobId); }
  catch (error) { throw new Error(`读取导入草稿失败: ${errorText(error)}`); }
  const needsReview = documentNeedsReview(draft.document);
  const modelRoute = result.model_route ?? authoringRoute(ctx);
  const payload: JsonObject = {
    success: true, committed: false, status: 'draft', session_id: result.session_id, name: result.name,
    draft_job_id: jobId, draft_version: draft.version, question_count: draft.document.questions.length,
    material_count: draft.document.materials.length, group_count: draft.document.groups.length,
    needs_review: needsReview || draft.status === 'partial', partial: draft.status === 'partial',
    coverage: draft.document.coverage, unmatched_answers: draft.document.unmatched_answers,
    issues: draft.document.issues, model_route: modelRoute,
  };
  if (resolved.source !== null) payload.source = resolved.source;

  if (mode === 'preview' || needsReview || draft.status === 'partial') {
    payload.draft_document = draft.document;
    payload.hint = mode === 'preview' ? '仅生成草稿，未写入正式题目。'
      : '草稿存在待复核项，未自动提交；检查 coverage/issues/unmatched_answers 后再明确处理。';
    env.emitChanged('import_document_draft', [result.session_id]);
    return payload;
  }

  const selected = draft.document.questions.map(question => question.local_id);
  let receipt;
  try { receipt = authoring.commitDraft(authoringHost, jobId, selected, draft.version); }
  catch (error) { throw new Error(`提交导入草稿失败: ${errorText(error)}`); }
  env.emitChanged('import_document', receipt.question_ids);
  const committed: JsonObject = { ...receipt };
  committed.success = true;
  committed.status = 'committed';
  committed.session_id = receipt.exam_id;
  committed.name = result.name;
  committed.draft_job_id = jobId;
  committed.draft_version = draft.version + 1;
  committed.model_route = modelRoute;
  if (resolved.source !== null) committed.source = resolved.source;
  return with_localized_message(committed as JsonValue, 'chat.tools.qbank.questions_imported',
    { count: receipt.imported_count },
    `已提交 ${receipt.imported_count} 道题目；题目集共 ${receipt.total_questions} 道`,
    `Committed ${receipt.imported_count} questions; the bank now has ${receipt.total_questions}.`);
}
