/**
 * 字段级合并策略（`field_merge.rs` 移植）。
 *
 * 只有可交换、幂等的策略进入自动字段级合并：标签集合求并、真正单调的计数取 max、
 * 布尔 OR。有序 JSON 数组、深层 JSON 对象、自由文本、SM-2 难度因子与派生计数
 * 一律回退到行级 LWW/冲突处理。
 *
 * TD-02：`todo_items.completed_pomodoros` 是 `pomodoro_records` 事实表的派生缓存，
 * 由 `pomodoro_counts` 在 apply 事务内重算，不做字段级合并。
 */
import { cloneDbJson, dbJsonEquals, type DbJson as JsonValue } from '../../../platform/util/lossless-json.ts';

/** `merge_field` 的返回值：`(value, was_merged, is_conflict)`。 */
export type MergeResult = [value: JsonValue, wasMerged: boolean, isConflict: boolean];

/** 跨 lane 的学习者画像合并接口（Rust 中位于 `memory::learner_profile`）。 */
export interface LearnerProfileMerger {
  /** 两侧均匹配画像 JSON 形状时返回合并后的 JSON；否则返回 `null`。 */
  mergeProfileJsonForSync(localJson: string, remoteJson: string): string | null;
}

type FieldMergeStrategy = 'TagSetUnion' | 'MaxValue' | 'BooleanOr' | 'LearnerProfileData';

/**
 * 进程级默认 merger：Rust `dstu_sync::hooks::SYNC_FIELD_MERGER` 槽位的对应物。
 * app 组合根（`index.ts` apply）安装 memory 发布的实现；未安装时等价于“任一侧
 * 不是画像”，回退行级 LWW/冲突（`hooks.rs:35-39`）。
 */
let defaultProfileMerger: LearnerProfileMerger | null = null;

/** 安装/清除默认学习者画像 merger（`index.ts` apply 安装 memory 的实现）。 */
export function setDefaultProfileMerger(merger: LearnerProfileMerger | null): void {
  defaultProfileMerger = merger;
}

export function getDefaultProfileMerger(): LearnerProfileMerger | null {
  return defaultProfileMerger;
}

/** notes.tags 数值型单值前缀（同前缀多条时取数值最大者）。 */
const NOTES_NUMERIC_VALUE_TAG_PREFIXES = ['_hits:', '_last_hit:', '_last_injected:', '_used:'] as const;

/** notes.tags 枚举型单值前缀（冲突时取字典序第一条并告警）。 */
const NOTES_ENUM_VALUE_TAG_PREFIXES = ['_type:', '_purpose:', '_daily_log_date:'] as const;

/**
 * 自动字段级合并注册表（唯一事实来源，顺序即 UI picklist 顺序）。
 *
 * attempt_count/correct_count、interval_days/consecutive_failures、
 * estimated_pomodoros、completed_pomodoros 故意缺席，原因见各表注释。
 */
const FIELD_MERGE_REGISTRY: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['questions', ['is_favorite', 'is_bookmarked', 'tags']],
  ['notes', ['tags', 'is_favorite']],
  ['files', ['tags_json', 'is_favorite']],
  ['review_plans', ['total_reviews', 'total_correct']],
  ['todo_items', ['tags_json']],
  ['essays', ['is_favorite']],
  ['translations', ['is_favorite']],
  ['todo_lists', ['is_favorite']],
  ['mindmaps', ['is_favorite']],
  ['exam_sheets', ['is_favorite']],
  ['mistakes', ['tags']],
  ['review_analyses', ['tags']],
  ['anki_cards', ['tags_json']],
  ['resources', ['data']],
];

/** serde_json::Value 的结构相等（对象键顺序无关；数字按数值比较）。 */
export function jsonEquals(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return dbJsonEquals(left, right);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return cloneDbJson(value);
}

/** `merge_field`（`field_merge.rs:95`）。 */
export function mergeField(
  tableName: string,
  columnName: string,
  localValue: JsonValue | undefined,
  remoteValue: JsonValue | undefined,
  profileMerger?: LearnerProfileMerger | null,
): MergeResult {
  if (localValue === undefined && remoteValue === undefined) return [null, false, false];
  if (localValue !== undefined && remoteValue === undefined) return [cloneJson(localValue), false, false];
  if (localValue === undefined && remoteValue !== undefined) return [cloneJson(remoteValue), false, false];
  if (jsonEquals(localValue, remoteValue)) return [cloneJson(localValue as JsonValue), false, false];
  const merger = profileMerger === undefined ? defaultProfileMerger : profileMerger;
  return mergeConflicting(tableName, columnName, localValue as JsonValue, remoteValue as JsonValue, merger);
}

/** 派生计数不再自动合并（`supports_counter_delta` 恒为 false）。 */
export function supportsCounterDelta(_tableName: string, _columnName: string): boolean {
  return false;
}

/** `field_merge_columns_for_table`。 */
export function fieldMergeColumnsForTable(tableName: string): string[] {
  const entry = FIELD_MERGE_REGISTRY.find(([table]) => table === tableName);
  return entry ? [...entry[1]] : [];
}

/** `field_merge_tables`。 */
export function fieldMergeTables(): string[] {
  return FIELD_MERGE_REGISTRY.map(([table]) => table);
}

function mergeConflicting(
  tableName: string,
  columnName: string,
  local: JsonValue,
  remote: JsonValue,
  profileMerger?: LearnerProfileMerger | null,
): MergeResult {
  switch (fieldMergeStrategy(tableName, columnName)) {
    case 'TagSetUnion': {
      const result = mergeTagSet(local, remote);
      if (tableName === 'notes' && columnName === 'tags') return normalizeNotesSingleValueTags(result);
      return result;
    }
    case 'MaxValue':
      return mergeMaxValue(local, remote);
    case 'BooleanOr':
      return mergeBooleanOr(local, remote);
    case 'LearnerProfileData':
      return mergeLearnerProfileData(local, remote, profileMerger);
    case undefined:
      return [cloneJson(remote), false, true];
  }
}

function fieldMergeStrategy(tableName: string, columnName: string): FieldMergeStrategy | undefined {
  if (columnName === 'tags' || columnName === 'tags_json') return 'TagSetUnion';

  if (
    (tableName === 'review_plans' && columnName === 'total_reviews')
    || (tableName === 'review_plans' && columnName === 'total_correct')
  ) {
    return 'MaxValue';
  }

  const booleanOrColumns: ReadonlyArray<readonly [string, string]> = [
    ['questions', 'is_favorite'],
    ['questions', 'is_bookmarked'],
    ['notes', 'is_favorite'],
    ['essays', 'is_favorite'],
    ['translations', 'is_favorite'],
    ['todo_lists', 'is_favorite'],
    ['mindmaps', 'is_favorite'],
    ['files', 'is_favorite'],
    ['exam_sheets', 'is_favorite'],
  ];
  if (booleanOrColumns.some(([table, column]) => table === tableName && column === columnName)) return 'BooleanOr';

  if (tableName === 'resources' && columnName === 'data') return 'LearnerProfileData';
  return undefined;
}

/** JSON 字符串数组或 JSON 数组字符串 → string[]（解析失败为空）。 */
function parseStringOrArray(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) return [];
    return parsed as string[];
  }
  return [];
}

/** 标签集合求并（BTreeSet 语义：去重 + UTF-8 字节序排序）。 */
function mergeTagSet(local: JsonValue, remote: JsonValue): MergeResult {
  const localTags = parseStringOrArray(local);
  const remoteTags = parseStringOrArray(remote);
  if (localTags.length === 0 && remoteTags.length === 0) return [[], false, false];

  const union = new Set<string>([...localTags, ...remoteTags]);
  const merged = [...union].sort(compareUtf8);
  const wasMerged = !jsonEquals(localTags, remoteTags);
  return [merged, wasMerged, false];
}

function parseI64(value: string): bigint | null {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed < -(2n ** 63n) || parsed > 2n ** 63n - 1n) return null;
  return parsed;
}

/**
 * notes.tags 单值前缀归一（J8b）。
 *
 * 输入是并集产物（已排序、去重）。数值型前缀保留数值最大者；数值并列或
 * 全部不可解析时保留字典序靠后的一条。枚举型前缀保留字典序第一条。
 * 结果只依赖集合本身，因此两侧独立合并会收敛到同一结果。
 */
function normalizeNotesSingleValueTags(result: MergeResult): MergeResult {
  const [value, wasMerged, conflict] = result;
  if (!Array.isArray(value)) return result;
  const tags = value.filter((item): item is string => typeof item === 'string');

  const survivors: Array<readonly [string, string]> = [];

  for (const prefix of NOTES_NUMERIC_VALUE_TAG_PREFIXES) {
    const candidates = tags.filter(tag => tag.startsWith(prefix));
    if (candidates.length < 2) continue;
    let best: string | undefined;
    let bestKey: readonly [number, bigint] = [-1, 0n];
    for (const candidate of candidates) {
      const parsed = parseI64(candidate.slice(prefix.length));
      const key: readonly [number, bigint] = parsed === null ? [0, 0n] : [1, parsed];
      // Rust `max_by_key` 在并列时返回最后一个最大值。
      if (best === undefined || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] >= bestKey[1])) {
        best = candidate;
        bestKey = key;
      }
    }
    survivors.push([prefix, best as string]);
  }

  for (const prefix of NOTES_ENUM_VALUE_TAG_PREFIXES) {
    const candidates = tags.filter(tag => tag.startsWith(prefix));
    if (candidates.length < 2) continue;
    survivors.push([prefix, candidates[0] as string]);
  }

  if (survivors.length === 0) return result;

  const normalized = tags.filter(tag => survivors.every(([prefix, keep]) => !tag.startsWith(prefix) || tag === keep));
  return [normalized, wasMerged, conflict];
}

/**
 * `resources.data` 的条件合并（J8c）。
 *
 * 仅当两侧都是学习者画像 JSON 时做结构化合并；其余内容（普通笔记、画像历史
 * JSONL 等）回退行级 LWW/冲突。画像合并实现由 memory lane 提供。
 */
function mergeLearnerProfileData(
  local: JsonValue,
  remote: JsonValue,
  profileMerger?: LearnerProfileMerger | null,
): MergeResult {
  if (typeof local !== 'string' || typeof remote !== 'string' || !profileMerger) return [cloneJson(remote), false, true];
  const merged = profileMerger.mergeProfileJsonForSync(local, remote);
  if (merged === null) return [cloneJson(remote), false, true];
  return [merged, merged !== remote, false];
}

function asI64(value: JsonValue): bigint {
  if (typeof value !== 'bigint' && !(typeof value === 'number' && Number.isSafeInteger(value))) return 0n;
  const integer = BigInt(value);
  return integer < -(2n ** 63n) || integer > 2n ** 63n - 1n ? 0n : integer;
}

function mergeMaxValue(local: JsonValue, remote: JsonValue): MergeResult {
  const left = asI64(local);
  const right = asI64(remote);
  const merged = left > right ? left : right;
  const value = merged >= BigInt(Number.MIN_SAFE_INTEGER) && merged <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(merged) : merged;
  return [value, left !== right, false];
}

function asSqlBool(value: JsonValue): boolean {
  if (typeof value === 'boolean') return value;
  return asI64(value) !== 0n;
}

function mergeBooleanOr(local: JsonValue, remote: JsonValue): MergeResult {
  const left = asSqlBool(local);
  const right = asSqlBool(remote);
  return [left || right, left !== right, false];
}
import { compareUtf8 } from '../../../platform/util/portable.ts';
