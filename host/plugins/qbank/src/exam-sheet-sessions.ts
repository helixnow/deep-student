/**
 * `src/commands.rs:932 list_exam_sheet_sessions`。
 *
 * 语义来自 `dstu-vision/src/exam_sheet_service.rs:252 list_exam_sheet_sessions`：
 * 按 limit（默认 50，上限 200）读取 VFS 整卷列表，元数据按
 * `ExamSheetSessionMetadata` 的 serde 规则解码（缺省 `source_type=ocr_image`，
 * 类型不符则整个 metadata 置空）。时间戳为 `DateTime<Utc>` 的 serde 表示
 * （RFC 3339、AutoSi、UTC 用 `Z`），解析失败回退 Unix 纪元。
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ExamRepository, VfsExamSheet } from '../../vfs-repos/api.ts';
import type {
  ExamSheetSessionListRequest, ExamSheetSessionListResponse, ExamSheetSessionMetadata,
  ImportSource,
} from '../api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { QbankServiceError } from './question-service.ts';
import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';
import { f64Atom, isNumberAtom, toInteger, type JsonNumberAtom } from '../../../platform/serde-compat/index.ts';

export interface ExamSheetSessionHost {
  db: SqlExecutor;
  exams?: Pick<ExamRepository, 'listExamSheets'>;
  log?: { warn(message: string): void };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined;
  return value as string[];
}

/**
 * serde 整数字段：只接受整数 token 且在范围内（`3.0` 是浮点，被拒绝）。metadata_json 经无损解析，
 * 超出安全整数的整数是原子，按原文返回。
 */
function integer(kind: 'usize' | 'i32', value: unknown): number | JsonNumberAtom | undefined {
  let exact: bigint;
  try {
    exact = toInteger(kind, value);
  } catch {
    return undefined;
  }
  const number = Number(exact);
  return Number.isSafeInteger(number) ? number : value as JsonNumberAtom;
}

function optionalUsize(value: unknown): number | JsonNumberAtom | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return integer('usize', value);
}

/** `f64`：number 与无损原子都按 f64 读取，写回时为 serde 的 f64 拼写（`1.0`、`0.5`）。 */
function f64(value: unknown): JsonNumberAtom | undefined {
  return typeof value === 'number' || isNumberAtom(value) ? f64Atom(value) : undefined;
}

const SOURCE_TYPES = new Map<string, ExamSheetSessionMetadata['source_type']>([
  ['ocr_image', 'ocr_image'], ['ocr', 'ocr_image'],
  ['import_file', 'import_file'], ['imported', 'import_file'],
  ['manual_create', 'manual_create'], ['manual', 'manual_create'],
  ['ai_generated', 'ai_generated'],
]);

function decodeImportSource(value: unknown): ImportSource | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const source: ImportSource = {};
  for (const key of ['file_name', 'file_type', 'import_time'] as const) {
    const field = optionalString(value[key]);
    if (field === undefined && value[key] !== undefined && value[key] !== null) return undefined;
    if (typeof field === 'string') source[key] = field;
  }
  return source;
}

/** `dstu_core::models::QuestionBankStats`（models.rs:382）：五个 i32 计数，`correct_rate`/`last_updated` 可缺省。 */
function decodeStats(value: unknown): JsonRecord | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const stats: JsonRecord = {};
  for (const key of ['total_count', 'mastered_count', 'review_count', 'in_progress_count', 'new_count'] as const) {
    const field = integer('i32', value[key]);
    if (field === undefined) return undefined;
    stats[key] = field;
  }
  if (value.correct_rate !== undefined && value.correct_rate !== null) {
    const rate = f64(value.correct_rate);
    if (rate === undefined) return undefined;
    stats.correct_rate = rate;
  }
  const lastUpdated = optionalString(value.last_updated);
  if (value.last_updated !== undefined && lastUpdated === undefined) return undefined;
  if (typeof lastUpdated === 'string') stats.last_updated = lastUpdated;
  return stats;
}

/** `serde_json::from_value::<ExamSheetSessionMetadata>` 的失败/成功分界；键按 models.rs:259 的声明顺序。 */
export function decodeExamSheetSessionMetadata(value: unknown): ExamSheetSessionMetadata | null {
  if (!isRecord(value)) return null;

  const instructions = optionalString(value.instructions);
  if (value.instructions !== undefined && instructions === undefined) return null;

  const tags = optionalStringArray(value.tags);
  if (value.tags !== undefined && tags === undefined) return null;

  const pageCount = optionalUsize(value.page_count);
  if (value.page_count !== undefined && pageCount === undefined) return null;
  const cardCount = optionalUsize(value.card_count);
  if (value.card_count !== undefined && cardCount === undefined) return null;

  let sourceType: ExamSheetSessionMetadata['source_type'] = 'ocr_image';
  if (value.source_type !== undefined) {
    if (typeof value.source_type !== 'string') return null;
    const mapped = SOURCE_TYPES.get(value.source_type);
    if (mapped === undefined) return null;
    sourceType = mapped;
  }

  const importSource = decodeImportSource(value.import_source);
  if (value.import_source !== undefined && importSource === undefined) return null;

  const stats = decodeStats(value.stats);
  if (value.stats !== undefined && stats === undefined) return null;

  const metadata = {} as ExamSheetSessionMetadata;
  if (typeof instructions === 'string') metadata.instructions = instructions;
  if (Array.isArray(tags)) metadata.tags = tags;
  // 大于 2^53 的 usize 以原子原样写出（IPC 线上为原文）。
  if (pageCount !== null && pageCount !== undefined) metadata.page_count = pageCount as number;
  if (cardCount !== null && cardCount !== undefined) metadata.card_count = cardCount as number;
  if (value.raw_model_response !== undefined && value.raw_model_response !== null) {
    metadata.raw_model_response = value.raw_model_response;
  }
  metadata.source_type = sourceType;
  if (importSource !== null && importSource !== undefined) metadata.import_source = importSource;
  if (stats !== null && stats !== undefined) {
    metadata.stats = stats as unknown as ExamSheetSessionMetadata['stats'];
  }
  return metadata;
}

/** chrono `DateTime<Utc>` 的 serde 序列化；非法输入回退纪元并 warn。 */
function utcTimestamp(raw: string, host: ExamSheetSessionHost): string {
  const parsed = parseRfc3339(raw);
  if (parsed !== null) return toRfc3339Opts(parsed.epochNanos, 'AutoSi', true);
  host.log?.warn(
    `[ExamSheetService] Failed to parse timestamp '${raw}': invalid RFC 3339 timestamp, using epoch fallback`,
  );
  return toRfc3339Opts(0n, 'AutoSi', true);
}

function summaryOf(exam: VfsExamSheet, host: ExamSheetSessionHost): ExamSheetSessionListResponse['sessions'][number] {
  const metadata = decodeExamSheetSessionMetadata(exam.metadataJson);
  return {
    id: exam.id,
    ...(exam.examName === undefined ? {} : { exam_name: exam.examName }),
    temp_id: exam.tempId,
    created_at: utcTimestamp(exam.createdAt, host),
    updated_at: utcTimestamp(exam.updatedAt, host),
    status: exam.status,
    ...(metadata === null ? {} : { metadata }),
    ...(exam.linkedMistakeIds === undefined ? {} : { linked_mistake_ids: exam.linkedMistakeIds }),
  };
}

/** `ExamSheetService::list_exam_sheet_sessions`。 */
export function listExamSheetSessions(
  host: ExamSheetSessionHost,
  request: ExamSheetSessionListRequest,
): ExamSheetSessionListResponse {
  const limit = Math.min(request.limit ?? 50, 200);
  if (host.exams === undefined) {
    throw new QbankServiceError(AppError.database('查询整卷历史失败: VFS 仓库服务未提供'));
  }
  let exams: VfsExamSheet[];
  try {
    exams = host.exams.listExamSheets(host.db, null, limit, 0);
  } catch (error) {
    throw new QbankServiceError(AppError.database(
      `查询整卷历史失败: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { sessions: exams.map(exam => summaryOf(exam, host)) };
}
