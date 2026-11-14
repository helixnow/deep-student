/**
 * `question_import_service.rs:3912-4970` CSV 预览/导入（`CsvImportService`）。
 *
 * 写入一律经 L11 发布的 conn-bound 方法（`questions.createQuestion/updateQuestion/
 * getQuestion/refreshStats`、`exams.getExamSheet/createExamSheet/purgeExamSheet`），
 * 本文件只做只读查询（去重哈希、空题目集计数）。
 *
 * Rust 在 `spawn_blocking` 中执行，取消请求可在任意时刻到达；TS 在每行写入前让出
 * 事件循环一次，使 `cancel_questions_csv_import` 能在行间生效（与 Rust 的
 * “已写入的行保留，后续行不再写入”一致）。
 */
import { sha256Sync } from '../../../platform/crypto/sync.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import * as path from '../../../platform/util/path.ts';
import { nanoid } from 'nanoid';
import { AppError } from '../../../platform/errors/api.ts';
import { ioMessageFor } from '../../../platform/paths/io-error.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  CreateQuestionParams, Difficulty, ExamRepository, Question, QuestionImage, QuestionOption,
  QuestionRepository, QuestionType, UpdateQuestionParams,
} from '../../vfs-repos/api.ts';
import { QbankServiceError } from './question-service.ts';
import { decodeCsvBytes, readCsvRecords, rustTrim } from './csv-codec.ts';
import * as serde from '../repository/serde-decode.ts';
import { countLiveQuestions, liveQuestionContents } from '../repository/csv-import.ts';
import { qbankLocalRuntime, readAllBytes, type LocalReadHandle } from './local-runtime.ts';

export type CsvDuplicateStrategy = 'skip' | 'overwrite' | 'merge';

export interface CsvImportRequest {
  file_path: string;
  exam_id: string;
  field_mapping: Record<string, string>;
  duplicate_strategy: CsvDuplicateStrategy;
  folder_id: string | null;
  exam_name: string | null;
}

export interface CsvImportError {
  row: number;
  message: string;
  raw_data: string | null;
}

export interface CsvImportResult {
  success_count: number;
  skipped_count: number;
  failed_count: number;
  errors: CsvImportError[];
  exam_id: string;
  total_rows: number;
  cancelled: boolean;
}

/** `#[serde(tag = "type")] enum CsvImportProgress`。 */
export type CsvImportProgress =
  | { type: 'Started'; total_rows: number; file_path: string; exam_id: string }
  | { type: 'Progress'; current: number; total: number; success: number; skipped: number;
    failed: number; exam_id: string }
  | ({ type: 'Completed' } & CsvImportResult)
  | ({ type: 'Cancelled' } & CsvImportResult)
  | { type: 'Failed'; error: string; exam_id: string };

export interface CsvPreviewResult {
  headers: string[];
  rows: string[][];
  total_rows: number;
  encoding: string;
}

const CSV_IMPORT_ACTIVE = 0;
const CSV_IMPORT_CANCELLED = 1;
const CSV_IMPORT_COMPLETED = 2;

/** `CsvImportCancellation`：取消与完成通过单次状态迁移决出唯一终态。 */
export class CsvImportCancellation {
  private state = CSV_IMPORT_ACTIVE;

  requestCancel(): boolean {
    if (this.state !== CSV_IMPORT_ACTIVE) return false;
    this.state = CSV_IMPORT_CANCELLED;
    return true;
  }

  isCancelled(): boolean {
    return this.state === CSV_IMPORT_CANCELLED;
  }

  /** 成功收尾；返回 true 表示取消先到，调用方必须报 Cancelled。 */
  finishOrCancelled(): boolean {
    if (this.state === CSV_IMPORT_ACTIVE) {
      this.state = CSV_IMPORT_COMPLETED;
      return false;
    }
    return this.state === CSV_IMPORT_CANCELLED;
  }
}

export interface CsvImportHost {
  db: SqlExecutor;
  questions: QuestionRepository;
  exams: ExamRepository;
  blobsDir: string;
  log: { info(message: string): void; warn(message: string): void };
  /** Node 平台名（`ctx.app.platform`），决定 io::Error Display 的 strerror 文案。 */
  platform: string;
}

const CSV_IMPORT_TARGET_FIELDS = [
  'question_label', 'content', 'options', 'answer', 'explanation', 'question_type',
  'difficulty', 'tags', 'images',
] as const;

/** Rust `Regex::new(r"^([A-Za-z])[\.、\s]\s*(.+)$")`：`.` 只排除 `\n`。 */
const CSV_OPTION_ITEM_RE = /^([A-Za-z])[.、\s]\s*([^\n]+)$/u;

function fail(appError: unknown): never {
  throw new QbankServiceError(appError);
}

function messageOf(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    if (typeof appError.message === 'string') return appError.message;
  }
  if (error !== null && typeof error === 'object' && 'message' in error
    && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

function validateFilePath(filePath: string): void {
  if (filePath.includes('..')) fail(AppError.validation("路径不允许包含 '..' 目录遍历"));
}

/** `read_file_with_encoding`。 */
export function readFileWithEncoding(filePath: string, platform: string): { content: string; encoding: string } {
  validateFilePath(filePath);
  let handle: LocalReadHandle;
  try { handle = qbankLocalRuntime().openRead(filePath); }
  catch (error) { return fail(AppError.internal(`打开文件失败: ${ioMessageFor(error, platform)}`)); }
  let bytes: Uint8Array;
  try { bytes = readAllBytes(handle); }
  catch (error) { return fail(AppError.internal(`读取文件失败: ${ioMessageFor(error, platform)}`)); }
  finally { handle.close(); }
  return decodeCsvBytes(bytes);
}

/** `CsvImportService::preview_csv`。 */
export function previewCsv(filePath: string, previewRows: number, platform: string): CsvPreviewResult {
  const { content, encoding } = readFileWithEncoding(filePath, platform);
  const [headers = [], ...records] = readCsvRecords(content);
  const rows: string[][] = [];
  let totalRows = 0;
  for (const record of records) {
    totalRows += 1;
    if (rows.length < previewRows) rows.push(record);
  }
  return { headers, rows, total_rows: totalRows, encoding };
}

function validateFieldMapping(headers: readonly string[], mapping: Record<string, string>): void {
  const targets = Object.values(mapping);
  if (!targets.some(target => target === 'content')) {
    fail(AppError.validation('字段映射中必须包含 content 字段'));
  }
  for (const column of Object.keys(mapping)) {
    if (!headers.includes(column)) fail(AppError.validation(`CSV 文件中不存在列 '${column}'`));
  }
  for (const target of targets) {
    if (!(CSV_IMPORT_TARGET_FIELDS as readonly string[]).includes(target)) {
      fail(AppError.validation(
        `不支持的目标字段 '${target}', 仅支持: ${CSV_IMPORT_TARGET_FIELDS.join(', ')}`));
    }
  }
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) {
      fail(AppError.validation(`目标字段 '${target}' 被重复映射，请确保每个目标字段只映射一次`));
    }
    seen.add(target);
  }
}

/** `content_dedup_key`：trim 后去掉空格/制表/回车/换行，SHA-256 前 16 字节 hex。 */
export function contentDedupKey(content: string): string {
  const normalized = rustTrim(content).replace(/[ \t\r\n]/g, '');
  return toHex(sha256Sync(normalized).subarray(0, 16));
}

/** `Path::file_stem`。 */
function fileStem(filePath: string): string | null {
  const base = path.basename(filePath);
  if (base === '' || base === '..' || base === '.') return null;
  if (base.startsWith('.') && base.indexOf('.', 1) < 0) return base;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? base : base.slice(0, dot);
}

function ensureExamExists(host: CsvImportHost, request: CsvImportRequest): [string, boolean] {
  let existing: unknown = null;
  try { existing = host.exams.getExamSheet(host.db, request.exam_id); }
  catch {
    // Rust `if let Ok(Some(_))`：读取失败按不存在处理，继续创建。
    existing = null;
  }
  if (existing !== null) return [request.exam_id, false];
  const examName = request.exam_name ?? `CSV导入 - ${fileStem(request.file_path) ?? 'CSV导入'}`;
  const previewJson = {
    temp_id: request.exam_id,
    exam_name: examName,
    pages: [{ page_index: 0, cards: [], ocr_completed: false, parse_completed: false }],
    session_id: request.exam_id,
  };
  try {
    const exam = host.exams.createExamSheet(host.db, {
      examName,
      tempId: request.exam_id,
      metadataJson: {},
      previewJson,
      status: 'completed',
      folderId: request.folder_id,
    });
    return [exam.id, true];
  } catch (error) {
    return fail(AppError.database(`创建题目集失败: ${messageOf(error)}`));
  }
}

function discardNewEmptyExam(host: CsvImportHost, examId: string): void {
  let count: number;
  try {
    count = countLiveQuestions(host.db, examId);
  } catch (error) {
    host.log.warn(`[CsvImport] 取消后检查新建题目集失败 (${examId}): ${messageOf(error)}`);
    return;
  }
  if (count > 0) return;
  try {
    host.exams.purgeExamSheet(host.db, host.blobsDir, examId);
  } catch (error) {
    host.log.warn(`[CsvImport] 取消后清理新建空题目集失败 (${examId}): ${messageOf(error)}`);
  }
}

function existingContentHashes(host: CsvImportHost, examId: string): Map<string, string> {
  let rows: { id: string; content: string }[];
  try {
    rows = liveQuestionContents(host.db, examId);
  } catch (error) {
    return fail(AppError.database(`查询失败: ${messageOf(error)}`));
  }
  const hashes = new Map<string, string>();
  for (const row of rows) hashes.set(contentDedupKey(row.content), row.id);
  return hashes;
}

const questionOption = serde.struct<QuestionOption>('QuestionOption', {
  key: serde.req(serde.string),
  content: serde.req(serde.string),
});
const questionImage = serde.struct<QuestionImage>('QuestionImage', {
  id: serde.req(serde.string),
  name: serde.req(serde.string),
  mime: serde.req(serde.string),
  hash: serde.req(serde.string),
  role: serde.opt(serde.string, true),
});

function tryFromStr<T>(raw: string, decode: serde.Decoder<T>): T | null {
  try { return serde.fromStr(raw, decode); }
  catch { return null; }
}

export function parseOptionsString(raw: string): QuestionOption[] | null {
  const s = rustTrim(raw);
  if (s.startsWith('[')) {
    const options = tryFromStr(s, serde.vec(questionOption));
    if (options !== null) return options;
  }
  for (const separator of [';', '\n', '|']) {
    const parts = s.split(separator).filter(part => rustTrim(part) !== '');
    if (parts.length >= 2) {
      const options: QuestionOption[] = [];
      for (const part of parts) {
        const caps = CSV_OPTION_ITEM_RE.exec(rustTrim(part));
        if (caps !== null) options.push({ key: caps[1]!.toUpperCase(), content: caps[2]! });
      }
      if (options.length > 0) return options;
    }
  }
  return null;
}

const QUESTION_TYPE_ALIASES: readonly [QuestionType, readonly string[]][] = [
  ['single_choice', ['single_choice', '单选', '单选题']],
  ['multiple_choice', ['multiple_choice', '多选', '多选题']],
  ['indefinite_choice', ['indefinite_choice', '不定项', '不定项选择题']],
  ['fill_blank', ['fill_blank', '填空', '填空题']],
  ['short_answer', ['short_answer', '简答', '简答题']],
  ['essay', ['essay', '论述', '论述题']],
  ['calculation', ['calculation', '计算', '计算题']],
  ['proof', ['proof', '证明', '证明题']],
  ['true_false', ['true_false', '判断', '判断题', 'judgment']],
  ['matching', ['matching', '匹配', '匹配题', '连线', '连线题']],
  ['ordering', ['ordering', '排序', '排序题']],
  ['numeric', ['numeric', '数值', '数值题']],
];

/** 未识别的类型落为 `Other`（Rust 返回 `Some(Other)`，从不为 None）。 */
export function parseQuestionType(raw: string): QuestionType {
  const value = rustTrim(raw).toLowerCase();
  return QUESTION_TYPE_ALIASES.find(([, aliases]) => aliases.includes(value))?.[0] ?? 'other';
}

export function parseDifficulty(raw: string): Difficulty | null {
  switch (rustTrim(raw).toLowerCase()) {
    case 'easy': case '简单': case '1': return 'easy';
    case 'medium': case '中等': case '2': return 'medium';
    case 'hard': case '困难': case '难': case '3': return 'hard';
    case 'very_hard': case '极难': case '4': return 'very_hard';
    default: return null;
  }
}

export function parseTags(raw: string): string[] | null {
  const s = rustTrim(raw);
  if (s.startsWith('[')) {
    const tags = tryFromStr(s, serde.vec(serde.string));
    if (tags !== null) return tags;
  }
  for (const separator of [',', ';', '|', '、']) {
    if (s.includes(separator)) {
      const tags = s.split(separator).map(rustTrim).filter(tag => tag !== '');
      if (tags.length > 0) return tags;
    }
  }
  return s !== '' ? [s] : null;
}

/** `parse_images`：错误文案沿用本 lane serde 解码器（serde 措辞，不含行列后缀）。 */
export function parseImages(raw: string): QuestionImage[] | null {
  const input = rustTrim(raw);
  if (input === '') return null;
  if (!input.startsWith('[')) throw new CsvRowMessage('images 字段必须是 JSON 数组格式');
  try {
    // serde_json 的元素错误不带路径前缀（本 lane 解码器约定去掉行列后缀）。
    const value: unknown = serde.fromStr(input, serde.json);
    if (!Array.isArray(value)) return serde.vec(questionImage)(value, '');
    return value.map(item => questionImage(item, ''));
  } catch (error) {
    throw new CsvRowMessage(`images 字段解析失败: ${messageOf(error)}`);
  }
}

class CsvRowMessage extends Error {}

type FieldValues = Map<string, string>;

function buildCreateParams(examId: string, fv: FieldValues, images: QuestionImage[] | null,
  rowNum: number): CreateQuestionParams {
  const options = fv.has('options') ? parseOptionsString(fv.get('options')!) : null;
  const questionType = fv.has('question_type') ? parseQuestionType(fv.get('question_type')!) : null;
  const difficulty = fv.has('difficulty') ? parseDifficulty(fv.get('difficulty')!) : null;
  const tags = fv.has('tags') ? parseTags(fv.get('tags')!) : null;
  return {
    exam_id: examId,
    card_id: `csv_${nanoid(10)}`,
    question_label: fv.get('question_label') ?? `Q${rowNum - 1}`,
    content: fv.get('content') ?? '',
    options,
    answer: fv.get('answer') ?? null,
    explanation: fv.get('explanation') ?? null,
    question_type: questionType,
    difficulty,
    tags,
    source_type: 'imported',
    source_ref: 'csv',
    images,
    parent_id: null,
  };
}

/** Rust `UpdateQuestionParams::default()` 上只设置 Some 的字段；None 即不修改。 */
function buildUpdateParams(fv: FieldValues, images: QuestionImage[] | null): UpdateQuestionParams {
  const params: UpdateQuestionParams = {};
  if (fv.has('content')) params.content = fv.get('content')!;
  if (fv.has('answer')) params.answer = fv.get('answer')!;
  if (fv.has('explanation')) params.explanation = fv.get('explanation')!;
  if (fv.has('options')) {
    const options = parseOptionsString(fv.get('options')!);
    if (options !== null) params.options = options;
  }
  if (fv.has('question_type')) params.question_type = parseQuestionType(fv.get('question_type')!);
  if (fv.has('difficulty')) {
    const difficulty = parseDifficulty(fv.get('difficulty')!);
    if (difficulty !== null) params.difficulty = difficulty;
  }
  if (fv.has('tags')) {
    const tags = parseTags(fv.get('tags')!);
    if (tags !== null) params.tags = tags;
  }
  if (images !== null) params.images = images;
  return params;
}

function buildMergeParams(fv: FieldValues, existing: Question,
  images: QuestionImage[] | null): UpdateQuestionParams {
  const params: UpdateQuestionParams = {};
  if (existing.answer === null && fv.has('answer')) params.answer = fv.get('answer')!;
  if (existing.explanation === null && fv.has('explanation')) params.explanation = fv.get('explanation')!;
  if (existing.options === null && fv.has('options')) {
    const options = parseOptionsString(fv.get('options')!);
    if (options !== null) params.options = options;
  }
  if (existing.tags.length === 0 && fv.has('tags')) {
    const tags = parseTags(fv.get('tags')!);
    if (tags !== null) params.tags = tags;
  }
  if (existing.images.length === 0 && images !== null && images.length > 0) params.images = images;
  return params;
}

type CsvRowResult = 'success' | 'skipped' | 'updated';

function processCsvRow(host: CsvImportHost, examId: string, headers: readonly string[],
  record: readonly string[], mapping: Record<string, string>, strategy: CsvDuplicateStrategy,
  existingHashes: Map<string, string>, rowNum: number): CsvRowResult {
  const fv: FieldValues = new Map();
  for (const [column, target] of Object.entries(mapping)) {
    const index = headers.indexOf(column);
    if (index < 0) continue;
    const value = record[index];
    if (value !== undefined && rustTrim(value) !== '') fv.set(target, value);
  }
  const content = fv.get('content');
  if (content === undefined || rustTrim(content) === '') {
    fail(AppError.validation(`第 ${rowNum} 行: content 为空`));
  }
  const contentHash = contentDedupKey(content);
  let images: QuestionImage[] | null = null;
  if (fv.has('images')) {
    try { images = parseImages(fv.get('images')!); }
    catch (error) {
      if (error instanceof CsvRowMessage) fail(AppError.validation(`第 ${rowNum} 行: ${error.message}`));
      throw error;
    }
  }

  const existingId = existingHashes.get(contentHash);
  if (existingId !== undefined) {
    switch (strategy) {
      case 'skip':
        return 'skipped';
      case 'overwrite':
        try { host.questions.updateQuestion(host.db, existingId, buildUpdateParams(fv, images)); }
        catch (error) { fail(AppError.database(`更新失败: ${messageOf(error)}`)); }
        return 'updated';
      case 'merge': {
        let existing: Question | null = null;
        try { existing = host.questions.getQuestion(host.db, existingId); }
        catch { existing = null; }
        if (existing !== null) {
          try {
            host.questions.updateQuestion(host.db, existingId, buildMergeParams(fv, existing, images));
          } catch (error) {
            fail(AppError.database(`合并失败: ${messageOf(error)}`));
          }
          return 'updated';
        }
        host.log.warn(`[CsvImport] 第 ${rowNum} 行: 合并目标题目 ${existingId} 不可读，按跳过处理`);
        return 'skipped';
      }
    }
  }

  let created: Question;
  try { created = host.questions.createQuestion(host.db, buildCreateParams(examId, fv, images, rowNum)); }
  catch (error) { return fail(AppError.database(`创建失败: ${messageOf(error)}`)); }
  existingHashes.set(contentHash, created.id);
  return 'success';
}

/** `setImmediate` 的可移植替代：宏任务让出，取消请求才可能在行间生效。 */
const yieldToEventLoop = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

/** `CsvImportService::import_csv`。 */
export async function importCsv(host: CsvImportHost, request: CsvImportRequest,
  progress: ((event: CsvImportProgress) => void) | null,
  cancellation: CsvImportCancellation | null): Promise<CsvImportResult> {
  host.log.info(`[CsvImport] 开始导入: ${request.file_path} -> exam_id=${request.exam_id}`);
  const isCancelled = (): boolean => cancellation?.isCancelled() ?? false;
  const finishOrCancelled = (): boolean => cancellation?.finishOrCancelled() ?? false;
  const cancelledResult = (examId: string, totalRows: number, success: number, skipped: number,
    failed: number, errors: CsvImportError[]): CsvImportResult => {
    const result: CsvImportResult = {
      success_count: success, skipped_count: skipped, failed_count: failed, errors,
      exam_id: examId, total_rows: totalRows, cancelled: true,
    };
    progress?.({ type: 'Cancelled', ...result });
    return result;
  };

  // CsvImportCompletionGuard：任何返回/抛出路径都把令牌收尾。
  try {
    // Rust 在 spawn_blocking 中启动：命令登记令牌后导入才开始，先让出一次。
    await yieldToEventLoop();
    if (isCancelled()) return cancelledResult(request.exam_id, 0, 0, 0, 0, []);

    let decoded: { content: string; encoding: string };
    try { decoded = readFileWithEncoding(request.file_path, host.platform); }
    catch (error) {
      if (finishOrCancelled()) return cancelledResult(request.exam_id, 0, 0, 0, 0, []);
      throw error;
    }
    host.log.info(`[CsvImport] 编码: ${decoded.encoding}`);

    if (isCancelled()) return cancelledResult(request.exam_id, 0, 0, 0, 0, []);

    const [headers = [], ...parsed] = readCsvRecords(decoded.content);
    try { validateFieldMapping(headers, request.field_mapping); }
    catch (error) {
      if (finishOrCancelled()) return cancelledResult(request.exam_id, 0, 0, 0, 0, []);
      throw error;
    }

    const records: string[][] = [];
    for (const record of parsed) {
      if (isCancelled()) return cancelledResult(request.exam_id, records.length, 0, 0, 0, []);
      records.push(record);
    }
    const totalRows = records.length;

    if (isCancelled()) return cancelledResult(request.exam_id, totalRows, 0, 0, 0, []);

    let examId: string;
    let createdExam: boolean;
    try { [examId, createdExam] = ensureExamExists(host, request); }
    catch (error) {
      if (finishOrCancelled()) return cancelledResult(request.exam_id, totalRows, 0, 0, 0, []);
      throw error;
    }
    if (isCancelled()) {
      if (createdExam) discardNewEmptyExam(host, examId);
      return cancelledResult(request.exam_id, totalRows, 0, 0, 0, []);
    }
    let existingHashes: Map<string, string>;
    try { existingHashes = existingContentHashes(host, examId); }
    catch (error) {
      if (finishOrCancelled()) {
        if (createdExam) discardNewEmptyExam(host, examId);
        return cancelledResult(examId, totalRows, 0, 0, 0, []);
      }
      if (createdExam) discardNewEmptyExam(host, examId);
      throw error;
    }

    if (isCancelled()) {
      if (createdExam) discardNewEmptyExam(host, examId);
      return cancelledResult(request.exam_id, totalRows, 0, 0, 0, []);
    }

    progress?.({ type: 'Started', total_rows: totalRows, file_path: request.file_path, exam_id: examId });

    let success = 0;
    let skipped = 0;
    let failed = 0;
    const errors: CsvImportError[] = [];
    const cancelAfterWrites = (): CsvImportResult => {
      if (createdExam) discardNewEmptyExam(host, examId);
      if (success > 0 || skipped > 0 || failed > 0) {
        try { host.questions.refreshStats(host.db, examId); }
        catch (error) { host.log.warn(`[CsvImport] 取消后刷新统计失败: ${messageOf(error)}`); }
      }
      return cancelledResult(examId, totalRows, success, skipped, failed, errors);
    };

    for (const [index, record] of records.entries()) {
      // 行间让出：取消请求在下一行写入前生效，已写入的行保留。
      await yieldToEventLoop();
      if (isCancelled()) return cancelAfterWrites();
      const rowNum = index + 2;
      try {
        const outcome = processCsvRow(host, examId, headers, record, request.field_mapping,
          request.duplicate_strategy, existingHashes, rowNum);
        if (outcome === 'skipped') skipped += 1;
        else success += 1;
      } catch (error) {
        failed += 1;
        errors.push({ row: rowNum, message: messageOf(error), raw_data: record.join(',') });
      }
      if ((index + 1) % 10 === 0 || index + 1 === totalRows) {
        progress?.({
          type: 'Progress', current: index + 1, total: totalRows, success, skipped, failed, exam_id: examId,
        });
      }
    }

    if (finishOrCancelled()) return cancelAfterWrites();

    try { host.questions.refreshStats(host.db, examId); }
    catch (error) { host.log.warn(`[CsvImport] 统计刷新失败: ${messageOf(error)}`); }

    const result: CsvImportResult = {
      success_count: success, skipped_count: skipped, failed_count: failed, errors,
      exam_id: examId, total_rows: totalRows, cancelled: false,
    };
    progress?.({ type: 'Completed', ...result });
    return result;
  } finally {
    cancellation?.finishOrCancelled();
  }
}
