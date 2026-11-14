import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { ioMessageFor } from '../../../platform/paths/io-error.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  Difficulty, Question as VfsQuestion, QuestionImage, QuestionListResult, QuestionRepository,
  QuestionStatus, QuestionType,
} from '../../vfs-repos/api.ts';
import type { QuestionFilters, QuestionOption } from '../api.ts';
import { QbankServiceError } from './question-service.ts';
import { vfsFilters } from './question-repository-adapter.ts';
import { encodeGbk } from './csv-codec.ts';
import { qbankLocalRuntime, type LocalWriteHandle } from './local-runtime.ts';

// question_export_service.rs:65-85,105-110
export function getExportableFields(): [string, string][] {
  return [
    ['content', '题干内容'], ['question_type', '题目类型'], ['options', '选项'],
    ['answer', '答案'], ['explanation', '解析'], ['difficulty', '难度'], ['tags', '标签'],
    ['images', '关联图片'], ['question_label', '题号'], ['user_answer', '用户答案'],
    ['is_correct', '是否正确'], ['attempt_count', '答题次数'], ['correct_count', '正确次数'],
    ['status', '学习状态'], ['is_favorite', '收藏'], ['user_note', '笔记'],
    ['created_at', '创建时间'], ['updated_at', '更新时间'],
  ];
}

// question_export_service.rs:386-395
export function formatOptions(options: QuestionOption[] | null): string {
  return options?.map(option => `${option.key}. ${option.content}`).join('; ') ?? '';
}

// question_export_service.rs:429-465
export function escapeCsvCell(cell: string): string {
  const isFormulaPrefix = /^[=+\-@\t\r\n＝＋－＠]/u.test(cell);
  const value = isFormulaPrefix ? `\t${cell}` : cell;
  return /[,"\n\r]/u.test(value) || isFormulaPrefix ? `"${value.replaceAll('"', '""')}"` : value;
}

// ---------------------------------------------------------------------------
// question_export_service.rs:111-427 `CsvExportService::export_csv`
// ---------------------------------------------------------------------------

export type ExportEncoding = 'utf8' | 'gbk' | 'utf8_bom';

export interface CsvExportRequest {
  exam_id: string;
  file_path: string;
  fields: string[];
  filters: QuestionFilters;
  include_answers: boolean;
  encoding: ExportEncoding;
}

export interface CsvExportResult {
  exported_count: number;
  file_path: string;
  file_size: number;
}

export interface CsvExportHost {
  db: SqlExecutor;
  questions: QuestionRepository;
  log: { info(message: string): void; warn(message: string): void };
  /** Node 平台名（`ctx.app.platform`），决定 io::Error Display 的 strerror 文案。 */
  platform: string;
}

function exportFail(appError: unknown): never {
  throw new QbankServiceError(appError);
}

function errorText(error: unknown): string {
  if (error instanceof QbankServiceError) {
    const appError = error.appError as { message?: unknown };
    if (typeof appError.message === 'string') return appError.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** M-038 `validate_file_path`：任何 `..` 路径组件即拒绝。 */
function validateExportPath(filePath: string, platform: string): void {
  const separators = platform === 'win32' ? /[\\/]/ : /\//;
  if (filePath.split(separators).some(component => component === '..')) {
    exportFail(AppError.validation("路径不允许包含 '..' 目录遍历"));
  }
}

function defaultFields(includeAnswers: boolean): string[] {
  const fields = ['content', 'question_type', 'options', 'answer', 'explanation', 'difficulty',
    'tags', 'question_label'];
  if (includeAnswers) fields.push('user_answer', 'is_correct', 'attempt_count', 'correct_count', 'status');
  return fields;
}

function fieldDisplayName(field: string): string {
  return getExportableFields().find(([key]) => key === field)?.[1] ?? field;
}

const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  single_choice: '单选题', multiple_choice: '多选题', indefinite_choice: '不定项选择题',
  fill_blank: '填空题', short_answer: '简答题', essay: '论述题', calculation: '计算题',
  proof: '证明题', true_false: '判断题', matching: '匹配题', ordering: '排序题',
  numeric: '数值题', other: '其他',
};
const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: '简单', medium: '中等', hard: '困难', very_hard: '极难',
};
const STATUS_LABEL: Record<QuestionStatus, string> = {
  new: '新题', in_progress: '学习中', mastered: '已掌握', review: '需复习',
};

/** `serde_json::to_string(&question.images)`：字段按 Rust 结构顺序，`role` 为 None 时省略。 */
function imagesJson(images: readonly QuestionImage[]): string {
  return JSON.stringify(images.map(image => ({
    id: image.id, name: image.name, mime: image.mime, hash: image.hash,
    ...(image.role != null ? { role: image.role } : {}),
  })));
}

function fieldValue(question: VfsQuestion, field: string): string {
  switch (field) {
    case 'content': return question.content;
    case 'question_type': return QUESTION_TYPE_LABEL[question.question_type];
    case 'options': return formatOptions(question.options);
    case 'answer': return question.answer ?? '';
    case 'explanation': return question.explanation ?? '';
    case 'difficulty': return question.difficulty === null ? '' : DIFFICULTY_LABEL[question.difficulty];
    case 'tags': return question.tags.join(',');
    case 'question_label': return question.question_label ?? '';
    case 'user_answer': return question.user_answer ?? '';
    case 'is_correct': return question.is_correct === null ? '' : question.is_correct ? '正确' : '错误';
    case 'attempt_count': return String(question.attempt_count);
    case 'correct_count': return String(question.correct_count);
    case 'status': return STATUS_LABEL[question.status];
    case 'is_favorite': return question.is_favorite ? '是' : '否';
    case 'user_note': return question.user_note ?? '';
    case 'created_at': return question.created_at;
    case 'updated_at': return question.updated_at;
    case 'images': return imagesJson(question.images);
    default: return '';
  }
}

function encodeRow(row: readonly string[], encoding: ExportEncoding): Uint8Array {
  const line = `${row.map(escapeCsvCell).join(',')}\n`;
  if (encoding !== 'gbk') return utf8Encode(line);
  const encoded = encodeGbk(line);
  if (encoded === null) {
    exportFail(AppError.validation(
      'GBK 编码失败：内容包含 GBK 不支持的字符，请改用 UTF-8 或 UTF-8 BOM 导出'));
  }
  return encoded;
}

function writeAll(handle: LocalWriteHandle, bytes: Uint8Array, context: string, platform: string): void {
  try { handle.write(bytes); }
  catch (error) { exportFail(AppError.internal(`${context}: ${ioMessageFor(error, platform)}`)); }
}

function listPage(host: CsvExportHost, request: CsvExportRequest, page: number): QuestionListResult {
  try {
    return host.questions.listQuestions(host.db, request.exam_id, vfsFilters(request.filters), page, 200);
  } catch (error) {
    return exportFail(AppError.database(`获取题目失败: ${errorText(error)}`));
  }
}

export function exportCsv(host: CsvExportHost, request: CsvExportRequest): CsvExportResult {
  host.log.info(`[CsvExport] 开始导出 exam_id=${request.exam_id} -> ${request.file_path}`);
  validateExportPath(request.file_path, host.platform);
  const fields = request.fields.length === 0 ? defaultFields(request.include_answers) : [...request.fields];
  for (const field of fields) {
    if (!getExportableFields().some(([key]) => key === field)) {
      exportFail(AppError.validation(`不支持的导出字段: ${field}`));
    }
  }

  let page = 1;
  const firstPage = listPage(host, request, page);
  if (firstPage.questions.length === 0) exportFail(AppError.validation('没有可导出的题目'));

  let handle: LocalWriteHandle;
  try { handle = qbankLocalRuntime().openWrite(request.file_path); }
  catch (error) { return exportFail(AppError.internal(`创建文件失败: ${ioMessageFor(error, host.platform)}`)); }

  let exportedCount = 0;
  try {
    try {
      if (request.encoding === 'utf8_bom') {
        writeAll(handle, Uint8Array.from([0xEF, 0xBB, 0xBF]), '写入 BOM 失败', host.platform);
      }
      writeAll(handle, encodeRow(fields.map(fieldDisplayName), request.encoding), '写入 CSV 行失败', host.platform);
      let current = firstPage;
      for (;;) {
        for (const question of current.questions) {
          writeAll(handle, encodeRow(fields.map(field => fieldValue(question, field)), request.encoding),
            '写入 CSV 行失败', host.platform);
          exportedCount += 1;
        }
        if (!current.has_more) break;
        page += 1;
        current = listPage(host, request, page);
      }
      // Rust BufWriter::flush：这里逐行 writeSync 无用户态缓冲，写失败已在 writeAll 上抛。
    } finally {
      handle.close();
    }
  } catch (error) {
    try { qbankLocalRuntime().removeFile(request.file_path); }
    catch (removeError) {
      host.log.warn(`[CsvExport] 清理失败的导出文件失败 ${request.file_path}: ${ioMessageFor(removeError, host.platform)}`);
    }
    throw error;
  }

  let fileSize = 0;
  try { fileSize = qbankLocalRuntime().stat(request.file_path).size; }
  catch { fileSize = 0; }
  host.log.info(`[CsvExport] 导出完成: ${exportedCount} 道题目, ${fileSize} 字节`);
  return { exported_count: exportedCount, file_path: request.file_path, file_size: fileSize };
}
