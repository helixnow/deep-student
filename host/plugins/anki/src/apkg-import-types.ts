/**
 * APKG 导入的共享常量、错误构造、限额与数据模型（`apkg_importer_service.rs` L1-500）。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { compareUtf8 as compareUtf8Bytes, rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { commandError, type AppErrorValue } from './command-errors.ts';
import type { AnkiLogger } from './logger.ts';
import type { ApkgMediaReport } from './apkg-types.ts';

// ============================================================================
// 常量（`apkg_importer_service.rs:18-98`）
// ============================================================================

export const APKG_ERROR_INVALID_INPUT = 'apkg_invalid_input';
export const APKG_ERROR_NOT_FOUND = 'apkg_not_found';
export const APKG_ERROR_NOT_FILE = 'apkg_not_file';
export const APKG_ERROR_IO = 'apkg_io';
export const APKG_ERROR_INVALID_ARCHIVE = 'apkg_invalid_archive';
export const APKG_ERROR_LIMIT_EXCEEDED = 'apkg_limit_exceeded';
export const APKG_ERROR_COLLECTION_MISSING = 'apkg_collection_missing';
export const APKG_ERROR_COLLECTION_INVALID = 'apkg_collection_invalid';
export const APKG_ERROR_DATABASE = 'apkg_database';
/** 历史错误码：现代 anki21b 包已支持直接导入，保留常量仅为兼容旧前端的错误映射。 */
export const APKG_ERROR_MODERN_SCHEMA = 'apkg_modern_schema_unsupported';
export const APKG_ERROR_COLPKG = 'colpkg_unsupported';

/** 导入时注入的 Anki 调度信息元数据键（与导出端 `card_sched_restore` 一致）。 */
export const ANKI_SCHED_METADATA_KEYS = [
  'AnkiSchedType',
  'AnkiQueue',
  'AnkiDue',
  'AnkiIvl',
  'AnkiFactor',
  'AnkiReps',
  'AnkiLapses',
] as const;

/** 外部 APKG 可能伪造的机器协议字段（wave2-E r2）：导入时一律剥离。 */
export const UNTRUSTED_IMPORT_PROTOCOL_FIELDS = [
  '_original_generation',
  '_content_provenance',
  '_qa_flags',
] as const;

export const MEDIA_SKIP_REASON_IMPORT_DISABLED = 'media_import_disabled';
export const MEDIA_SKIP_REASON_MANIFEST_UNPARSED = 'manifest_unparsed';
export const MEDIA_SKIP_REASON_MEDIA_DIR_UNAVAILABLE = 'media_dir_unavailable';
export const MEDIA_SKIP_REASON_UNSAFE_FILENAME = 'unsafe_filename';
export const MEDIA_SKIP_REASON_ENTRY_MISSING = 'entry_missing';
export const MEDIA_SKIP_REASON_ENTRY_OVERSIZED = 'entry_oversized';
export const MEDIA_SKIP_REASON_FILENAME_CONFLICT = 'filename_conflict';
export const MEDIA_SKIP_REASON_IO_ERROR = 'io_error';
export const MEDIA_SKIP_REASON_ORPHAN_ENTRY = 'orphan_entry';
/** 每个跳过原因在报告中最多列出的文件名数（count 始终是全量计数）。 */
export const MAX_REPORTED_MEDIA_FILENAMES = 20;

export const MAX_APKG_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_COLLECTION_BYTES = 256 * 1024 * 1024;
export const MAX_MEDIA_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_MODELS_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_DECKS_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_CARDS = 250_000;
export const MAX_FIELDS_PER_MODEL = 512;
export const MAX_FIELD_VALUE_BYTES = 16 * 1024 * 1024;
export const MAX_RAW_TAG_BYTES = 1024 * 1024;
export const MAX_TAGS_PER_CARD = 4096;
export const MAX_TAG_BYTES = 4096;
export const MAX_TEMPLATE_ID_BYTES = 4096;
export const MAX_MATERIALIZED_CARD_BYTES = 256 * 1024 * 1024;
export const MAX_ZSTD_WINDOW_LOG = 27;

export const SQLITE_HEADER = new TextEncoder().encode('SQLite format 3\0');
export const ZSTD_MAGIC = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]);
/** Anki 调度列中「due 是 unix 秒时间戳」的判定阈值（≈2001-09）。 */
export const ANKI_DUE_TIMESTAMP_THRESHOLD = 1_000_000_000;
export const MS_PER_DAY = 86_400_000;
/** 换算 SM-2 卡片时假定的历史保持率（Anki「Historical retention」默认值）。 */
export const SM2_HISTORICAL_RETENTION = 0.9;
/** Anki 默认起始难易度系数（缺失/异常 factor 时使用）。 */
export const ANKI_DEFAULT_EASE = 2.5;
/** fsrs-rs 6.6 默认权重（`fsrs::DEFAULT_PARAMETERS`）。 */
export const FSRS_W8 = 1.8722;
export const FSRS_W9 = 0.1666;
export const FSRS_W10 = 0.796;
export const FSRS_DECAY = 0.1542;
export const FSRS_PARAMS_VERSION = 'fsrs-rs-6.6';
export const DEFAULT_DECK_ID = 'deck_default';
export const DEFAULT_DESIRED_RETENTION = 0.9;

// ============================================================================
// 错误（Rust `AppError` 的 serde 形状）
// ============================================================================

export type { AppErrorValue };

export function appErrorWithCode(errorType: 'Validation' | 'Database' | 'FileSystem' | 'NotFound', code: string, message: string): AppErrorValue {
  return commandError(errorType, message, code);
}

export function validationError(code: string, message: string): AppErrorValue {
  return appErrorWithCode('Validation', code, message);
}

export function fileError(message: string): AppErrorValue {
  return appErrorWithCode('FileSystem', APKG_ERROR_IO, message);
}

export function limitError(message: string): AppErrorValue {
  return validationError(APKG_ERROR_LIMIT_EXCEEDED, message);
}

export function databaseError(message: string): AppErrorValue {
  return appErrorWithCode('Database', APKG_ERROR_DATABASE, message);
}

/** 集合库 SELECT/内省失败统一映射（`collection_sql_error`）。 */
export function collectionSqlError(error: unknown): AppErrorValue {
  return validationError(
    APKG_ERROR_COLLECTION_INVALID,
    `Invalid or unsupported APKG collection schema: ${errorMessage(error)}`,
  );
}

export function isAppErrorValue(value: unknown): value is AppErrorValue {
  return typeof value === 'object' && value !== null
    && typeof (value as { error_type?: unknown }).error_type === 'string'
    && typeof (value as { message?: unknown }).message === 'string'
    && 'details' in value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `AppError::details.errorCode`（测试用）。 */
export function errorCodeOf(error: unknown): string | undefined {
  if (!isAppErrorValue(error)) return undefined;
  const code = error.details?.errorCode;
  return typeof code === 'string' ? code : undefined;
}

// ============================================================================
// 空白 / 字节工具（Rust `str::split_whitespace` / `str::trim` / `str::len`）
// ============================================================================

/** Unicode `White_Space` 属性（Rust `char::is_whitespace`）。 */
const WHITESPACE_CLASS = '\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WHITESPACE_SPLIT_RE = new RegExp(`[${WHITESPACE_CLASS}]+`, 'u');

/** Rust `str::trim`（平台共享实现）。 */
export const trimWhitespace = rustTrim;

/** `raw.split_whitespace()`（丢弃空段）。 */
export function splitWhitespace(value: string): string[] {
  return trimWhitespace(value).split(WHITESPACE_SPLIT_RE).filter((part) => part !== '');
}

/** `str::len()`：UTF-8 字节数。 */
export function byteLen(value: string): number {
  return utf8ByteLength(value);
}

/** Rust `String` 排序（UTF-8 字节序，等价码点序）。 */
export function compareUtf8(left: string, right: string): number {
  return compareUtf8Bytes(left, right);
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/** `eq_ignore_ascii_case`。 */
export function eqIgnoreAsciiCase(left: string, right: string): boolean {
  return asciiLower(left) === asciiLower(right);
}

/** `char::is_control`（Unicode Cc）。 */
export function hasControlChar(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Rust `Path::file_name()` 的最后一段（Unix 语义：`\` 不是分隔符）。 */
export function rustFileName(raw: string): string | null {
  if (raw === '') return null;
  const parts = raw.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    normalized.push(part);
  }
  if (normalized.length === 0) return null;
  const last = normalized[normalized.length - 1]!;
  if (last === '..') return null;
  return last;
}

/** Rust `Path::extension()`（file_name 中最后一个 `.` 之后；点开头文件无扩展名）。 */
export function rustExtension(raw: string): string | null {
  const name = rustFileName(raw);
  if (name === null) return null;
  const index = name.lastIndexOf('.');
  if (index <= 0) return null;
  return name.slice(index + 1);
}

// ============================================================================
// 类型
// ============================================================================

export interface ImportLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxCollectionBytes: number;
  maxMaterializedCardBytes: number;
}

export function defaultImportLimits(): ImportLimits {
  return {
    maxEntries: MAX_ZIP_ENTRIES,
    maxEntryBytes: MAX_ENTRY_BYTES,
    maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
    maxCollectionBytes: MAX_COLLECTION_BYTES,
    maxMaterializedCardBytes: MAX_MATERIALIZED_CARD_BYTES,
  };
}

/** 集合库只读打开所需的最小运行时依赖（测试注入 F3 句柄）。 */
export interface ApkgCollectionRuntime {
  openDatabase(filePath: string): DatabaseHandle;
  closeDatabase(handle: DatabaseHandle): void;
  /** 临时目录（`std::env::temp_dir()` / 测试的运行时目录）。 */
  tempDir: string;
}

/** 导入服务运行时：应用库句柄 + 集合库句柄工厂 + 媒体落盘目录。 */
export interface ApkgImportRuntime extends ApkgCollectionRuntime {
  /** F7 `nativeCompression`；提供时异步导入路径使用它解压 zstd。 */
  compression?: import('../../../platform/native/api.ts').NativeCompression | null;
  /** L15 事务内入队；`withReviewEnqueue()` 时必需。 */
  fsrsOwner?: import('./fsrs-owner.ts').FsrsTransactionOwner | null;
  /** 应用库（mistakes）。 */
  db: DatabaseHandle;
  /** 插件日志（Rust `tracing`）。 */
  logger: AnkiLogger;
  /** 媒体落盘目录（None = 保持旧行为：不导入媒体，仅统计 skipped）。 */
  mediaDir?: string | null;
  now?: () => number;
}

/** Anki `cards` 表的调度信息快照（SM-2 语义 + `cards.data` 的 FSRS 记忆状态）。 */
export interface CardSchedState {
  cardType: number;
  queue: number;
  due: number;
  ivl: number;
  factor: number;
  reps: number;
  lapses: number;
  /** `cards.data` 的 `s` / `d`：在 Anki 里启用 FSRS 时的真实记忆状态。 */
  fsrsMemory: readonly [number, number] | null;
  /** `cards.data` 的 `lrt`（上次复习的 unix 秒）。 */
  lastReviewSecs: number | null;
}

export interface ModelDefinition {
  name: string;
  modelType: number;
  fieldsByOrd: Map<number, string>;
  fieldSlotCount: number;
  templateId: string | null;
  collapseClozeOrds: boolean;
}

/** 从 APKG 模型元数据重建 Deep Student 模板所需的最小信息。 */
export interface TemplateImportCandidate {
  templateId: string;
  name: string;
  noteType: string;
  fields: string[];
  frontTemplate: string;
  backTemplate: string;
  cssStyle: string;
}

export interface ParsedCard {
  front: string;
  back: string;
  text: string | null;
  tags: string[];
  /** 已落盘媒体的绝对路径（未启用媒体导入时为空）。 */
  images: string[];
  extraFields: Record<string, string>;
  templateId: string | null;
  /** Anki 原始调度列（包缺调度列时为 null），供导入即入队换算 FSRS 初始状态。 */
  ankiSched: CardSchedState | null;
}

export interface ParsedPackage {
  cards: ParsedCard[];
  deckNames: string[];
  mediaSkipped: number;
  mediaImported: number;
  mediaReport: ApkgMediaReport;
  templateCandidates: TemplateImportCandidate[];
  warnings: string[];
  /** `col.crt`：集合创建时间（unix 秒，Anki 日切点）。 */
  collectionCrtSecs: number | null;
}

/** FSRS 卡片状态（与 `FsrsState` 的 i32 值一致）。 */
export const FSRS_STATE_NEW = 0;
export const FSRS_STATE_LEARNING = 1;
export const FSRS_STATE_REVIEW = 2;
export const FSRS_STATE_RELEARNING = 3;

/** 外部导入卡片的初始 FSRS 调度快照（`FsrsImportedSchedule`）。 */
/** L15 已发布的导入排期类型（单一来源，L16 不再维护结构副本）。 */
export type {
  FsrsImportEnqueueSummary,
  FsrsImportedSchedule,
} from '../../review/api.ts';
