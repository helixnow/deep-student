/**
 * Argument parsing, structured errors and bounded output helpers of
 * `src-tauri/src/chat_v2/tools/qbank_executor.rs` (lines 54–1420).
 * Every helper throws `Error(message)` where Rust returns `Err(String)`.
 */
import {
  ensure_localized_error, with_localized_message, type JsonValue,
} from '../../../../platform/errors/api.ts';
import { f64Atom } from '../../../../platform/serde-compat/index.ts';
import { charCount, compareUtf8, rustTrim, takeChars } from '../../../../platform/util/portable.ts';
import type {
  Question, QuestionImage, QuestionOption,
  dstu_vfs__vfs__repos__question_repo__Difficulty as Difficulty,
  dstu_vfs__vfs__repos__question_repo__QuestionStatus as QuestionStatus,
  dstu_vfs__vfs__repos__question_repo__QuestionType as QuestionType,
} from '../../api.ts';
import { unitEnum } from '../../repository/serde-decode.ts';

export type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function argsObject(args: unknown): Args {
  return isRecord(args) ? args : {};
}

/** serde_json `Value::as_str`. */
export function asStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function requiredStr(args: Args, key: string): string {
  const value = asStr(args[key]);
  if (value === null) throw new Error(`Missing '${key}' parameter`);
  return value;
}

export function cardIdOf(question: Question): string {
  return question.card_id ?? question.id;
}

/** serde_json `Value::as_bool`. */
export function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** serde_json `Value::as_u64`. */
export function asU64(value: unknown): number | null {
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** serde_json `Value::as_i64`. */
export function asI64(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Rust `Vec<String>::sort()` order (UTF-8 bytes). */
export function compareRustStrings(left: string, right: string): number {
  return compareUtf8(left, right);
}

export function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'appError' in error) {
    const appError = (error as { appError: unknown }).appError;
    // AppError `Display` is its message.
    if (isRecord(appError) && typeof appError.message === 'string') return appError.message;
    if (typeof appError === 'string') return appError;
  }
  return error instanceof Error ? error.message : String(error);
}

/** qbank_executor.rs:54 `qbank_error`. */
export function qbankError(code: string, message: string, hint: string): string {
  return JSON.stringify(with_localized_message({
    code, hint,
    hintFallback: {
      'zh-CN': hint,
      'en-US': 'Review the structured error code and correct the request before retrying.',
    },
    retryable: false,
  }, 'chat.tools.qbank.error', { code, detail: message }, message,
  `Question bank operation failed (${code}).`));
}

export function qbankFailure(code: string, message: string, hint: string): Error {
  return new Error(qbankError(code, message, hint));
}

/** qbank_executor.rs:74 `qbank_conflict_error`. */
export function qbankConflictError(message: string, hint: string, current: unknown): Error {
  return new Error(JSON.stringify(with_localized_message({
    code: 'QBANK_CONFLICT', hint,
    hintFallback: {
      'zh-CN': hint,
      'en-US': 'Read the current question state and plan the change again; do not retry with a guessed revision.',
    },
    retryable: false,
    current: current as JsonValue,
  }, 'chat.tools.qbank.error', { code: 'QBANK_CONFLICT', detail: message }, message,
  'Question bank conflict. Read the current value before retrying.')));
}

/** qbank_executor.rs:100 `localized_qbank_failure`. */
export function localizedQbankFailure(error: string): string {
  return ensure_localized_error(error, 'QBANK_OPERATION_FAILED', 'chat.tools.qbank.error',
    '题库操作失败', 'The question-bank operation failed.');
}

function trimmedString(value: unknown): string | null {
  const text = asStr(value);
  if (text === null) return null;
  const trimmed = rustTrim(text);
  return trimmed === '' ? null : trimmed;
}

/** qbank_executor.rs:110 `expected_qbank_revision`. */
export function expectedQbankRevision(args: Args): string {
  const value = trimmedString(args.expected_updated_at ?? args.expectedUpdatedAt);
  if (value === null) {
    throw qbankFailure('QBANK_OCC_REQUIRED', '更新题目前必须提供 expected_updated_at',
      '先调用 qbank_get_question，原样传入其 updated_at 后再更新');
  }
  return value;
}

/** qbank_executor.rs:126 `required_non_empty_string`. */
export function requiredNonEmptyString(args: Args, key: string): string {
  const value = trimmedString(args[key]);
  if (value === null) throw qbankFailure('INVALID_ARGS', `${key} 必须是非空字符串`, '修正参数后重试');
  return value;
}

/** qbank_executor.rs:141 `optional_string`. */
export function optionalString(args: Args, key: string, maxChars: number): string | null {
  if (!Object.hasOwn(args, key)) return null;
  const value = asStr(args[key]);
  if (value === null) throw qbankFailure('INVALID_ARGS', `${key} 必须是字符串`, '修正参数后重试');
  if (charCount(value) > maxChars) {
    throw qbankFailure('INVALID_ARGS', `${key} 超过 ${maxChars} 字符上限`, '缩短内容后重试');
  }
  return value;
}

/** qbank_executor.rs:162 `parse_string_array` (trimmed, de-duplicated, order preserved). */
export function parseStringArray(value: unknown, field: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) throw qbankFailure('INVALID_ARGS', `${field} 必须是字符串数组`, '修正参数后重试');
  if (value.length > maxItems) throw qbankFailure('INVALID_ARGS', `${field} 最多包含 ${maxItems} 项`, '缩小批次后重试');
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const item = trimmedString(raw);
    if (item === null) throw qbankFailure('INVALID_ARGS', `${field}[${index}] 必须是非空字符串`, '修正参数后重试');
    if (charCount(item) > maxChars) {
      throw qbankFailure('INVALID_ARGS', `${field}[${index}] 超过 ${maxChars} 字符上限`, '缩短该项后重试');
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  });
  return result;
}

/** qbank_executor.rs:211 `parse_question_options`. */
export function parseQuestionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) throw qbankFailure('INVALID_ARGS', 'options 必须是结构化数组', '每项格式为 {key,content}');
  if (value.length > 26) throw qbankFailure('INVALID_ARGS', 'options 最多包含 26 项', '缩减选项后重试');
  const keys = new Set<string>();
  return value.map((option, index) => {
    if (!isRecord(option)) throw qbankFailure('INVALID_ARGS', `options[${index}] 必须是对象`, '每项格式为 {key,content}');
    const key = trimmedString(option.key);
    if (key === null) throw qbankFailure('INVALID_ARGS', `options[${index}].key 必须是非空字符串`, '修正选项后重试');
    const content = trimmedString(option.content);
    if (content === null) {
      throw qbankFailure('INVALID_ARGS', `options[${index}].content 必须是非空字符串`, '修正选项后重试');
    }
    if (keys.has(key)) throw qbankFailure('INVALID_ARGS', `options 包含重复 key: ${key}`, '每个选项 key 必须唯一');
    keys.add(key);
    return { key, content };
  });
}

const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'short_answer',
  'essay', 'calculation', 'proof', 'true_false', 'matching', 'ordering', 'numeric', 'other'] as const;
const decodeQuestionType = unitEnum<QuestionType>(QUESTION_TYPES);
const decodeDifficulty = unitEnum<Difficulty>(['easy', 'medium', 'hard', 'very_hard']);
const decodeStatus = unitEnum<QuestionStatus>(['new', 'in_progress', 'mastered', 'review']);
const decodeSortBy = unitEnum(['relevance', 'created_desc', 'created_asc', 'updated_desc']);

/** `serde_json::from_value::<T>(value).ok()` for unit enums. */
export function tryParseStatus(value: unknown): QuestionStatus | null {
  try { return decodeStatus(value, ''); } catch { return null; }
}
export function tryParseDifficulty(value: unknown): Difficulty | null {
  try { return decodeDifficulty(value, ''); } catch { return null; }
}

/** qbank_executor.rs:276 `parse_repo_question_type`. */
export function parseRepoQuestionType(value: unknown, field: string): QuestionType {
  try { return decodeQuestionType(value, field); }
  catch {
    throw qbankFailure('INVALID_ARGS', `${field} 是不支持的题型`,
      '使用 single_choice/multiple_choice/indefinite_choice/fill_blank/true_false/matching/ordering/numeric/short_answer/essay/calculation/proof/other');
  }
}

/** qbank_executor.rs:648 `parse_difficulty`. */
export function parseDifficulty(value: unknown, field: string): Difficulty {
  try { return decodeDifficulty(value, field); }
  catch { throw qbankFailure('INVALID_ARGS', `${field} 是不支持的难度`, '使用 easy/medium/hard/very_hard'); }
}

/** qbank_executor.rs:658 `parse_status`. */
export function parseStatus(value: unknown, field: string): QuestionStatus {
  try { return decodeStatus(value, field); }
  catch { throw qbankFailure('INVALID_ARGS', `${field} 是不支持的学习状态`, '使用 new/in_progress/mastered/review'); }
}

/** qbank_executor.rs:2760 `SearchSortBy` parse. */
export function parseSortBy(value: unknown): 'relevance' | 'created_desc' | 'created_asc' | 'updated_desc' {
  try { return decodeSortBy(value, 'sort_by'); }
  catch { throw qbankFailure('INVALID_ARGS', 'sort_by 不受支持', '使用 relevance/created_desc/created_asc/updated_desc'); }
}

export function isChoiceType(questionType: QuestionType): boolean {
  return questionType === 'single_choice' || questionType === 'multiple_choice' || questionType === 'indefinite_choice';
}

/** qbank_executor.rs:287. */
export function questionTypeSupportsStructuredData(questionType: QuestionType): boolean {
  return questionType === 'fill_blank' || questionType === 'matching' || questionType === 'ordering'
    || questionType === 'numeric';
}

/** qbank_executor.rs:298. */
export function questionTypeRequiresStructuredData(questionType: QuestionType): boolean {
  return questionType === 'matching' || questionType === 'ordering' || questionType === 'numeric';
}

/** qbank_executor.rs:305 `structured_key_content_entries`. */
function structuredKeyContentEntries(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    throw qbankFailure('INVALID_ARGS', `${field} 必须是 {key,content} 对象数组`, '修正 structured_data 后重试');
  }
  if (value.length === 0 || value.length > maxItems) {
    throw qbankFailure('INVALID_ARGS', `${field} 必须包含 1..=${maxItems} 项`, '修正 structured_data 后重试');
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) throw qbankFailure('INVALID_ARGS', `${field}[${index}] 必须是对象`, '每项格式为 {key,content}');
    const key = trimmedString(item.key);
    if (key === null) {
      throw qbankFailure('INVALID_ARGS', `${field}[${index}].key 必须是非空字符串`, '修正 structured_data 后重试');
    }
    if (trimmedString(item.content) === null) {
      throw qbankFailure('INVALID_ARGS', `${field}[${index}].content 必须是非空字符串`, '修正 structured_data 后重试');
    }
    if (seen.has(key)) throw qbankFailure('INVALID_ARGS', `${field} 包含重复 key: ${key}`, '每项 key 必须唯一');
    seen.add(key);
    keys.push(key);
  });
  return keys;
}

/** qbank_executor.rs:372 `validate_structured_data` (shape only). */
export function validateStructuredData(questionType: QuestionType, data: unknown): void {
  if (!questionTypeSupportsStructuredData(questionType)) {
    throw qbankFailure('INVALID_ARGS', `题型 ${questionType} 不支持 structured_data`,
      '只有 fill_blank/matching/ordering/numeric 支持 structured_data；其他题型请移除该字段');
  }
  if (charCount(JSON.stringify(data)) > 20_000) {
    throw qbankFailure('INVALID_ARGS', 'structured_data 序列化后超过 20000 字符上限', '缩减 structured_data 内容后重试');
  }
  if (!isRecord(data)) throw qbankFailure('INVALID_ARGS', 'structured_data 必须是 JSON 对象', '按对应题型格式传入对象');
  switch (questionType) {
    case 'fill_blank': {
      const blanks = data.blanks;
      if (!Array.isArray(blanks)) {
        throw qbankFailure('INVALID_ARGS', 'fill_blank 的 structured_data 缺少 blanks 数组',
          '格式：{"blanks":[{"answers":["答案1","答案2"],"case_sensitive":false,"trim":true}]}，blanks 顺序与题干 ____ 空位一一对应');
      }
      if (blanks.length === 0 || blanks.length > 50) {
        throw qbankFailure('INVALID_ARGS', 'blanks 必须包含 1..=50 个空位', '修正 blanks 后重试');
      }
      blanks.forEach((blank, index) => {
        if (!isRecord(blank)) {
          throw qbankFailure('INVALID_ARGS', `blanks[${index}] 必须是对象`,
            '每个空位格式：{"answers":[...],"case_sensitive"?:bool,"trim"?:bool}');
        }
        const answers = blank.answers;
        if (!Array.isArray(answers) || answers.length === 0 || answers.length > 20) {
          throw qbankFailure('INVALID_ARGS', `blanks[${index}].answers 必须是 1..=20 项的非空数组`,
            'answers 列出该空位所有可接受答案');
        }
        answers.forEach((answer, answerIndex) => {
          const text = typeof answer === 'string' ? rustTrim(answer) : null;
          if (text === null || text === '' || charCount(text) > 500) {
            throw qbankFailure('INVALID_ARGS',
              `blanks[${index}].answers[${answerIndex}] 必须是 1..=500 字符的非空字符串`, '修正答案文本后重试');
          }
        });
        for (const key of ['case_sensitive', 'trim']) {
          if (Object.hasOwn(blank, key) && typeof blank[key] !== 'boolean') {
            throw qbankFailure('INVALID_ARGS', `blanks[${index}].${key} 必须是布尔值`, '修正后重试');
          }
        }
      });
      return;
    }
    case 'matching': {
      const leftKeys = structuredKeyContentEntries(data.left ?? null, 'structured_data.left', 26);
      const rightKeys = structuredKeyContentEntries(data.right ?? null, 'structured_data.right', 26);
      const pairs = data.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) {
        throw qbankFailure('INVALID_ARGS', 'matching 的 structured_data 缺少非空 pairs 数组',
          '格式：{"left":[{"key","content"}],"right":[...],"pairs":[{"left":"L1","right":"R2"}]}');
      }
      const leftSet = new Set(leftKeys);
      const rightSet = new Set(rightKeys);
      const pairedLeft = new Set<string>();
      pairs.forEach((pair, index) => {
        if (!isRecord(pair)) {
          throw qbankFailure('INVALID_ARGS', `pairs[${index}] 必须是对象`, '每项格式：{"left":"左侧key","right":"右侧key"}');
        }
        const left = asStr(pair.left) ?? '';
        const right = asStr(pair.right) ?? '';
        if (!leftSet.has(left)) {
          throw qbankFailure('INVALID_ARGS', `pairs[${index}].left 引用了不存在的左侧 key: ${left}`,
            'pairs 中的 left/right 必须引用 left/right 数组中的 key');
        }
        if (!rightSet.has(right)) {
          throw qbankFailure('INVALID_ARGS', `pairs[${index}].right 引用了不存在的右侧 key: ${right}`,
            'pairs 中的 left/right 必须引用 left/right 数组中的 key');
        }
        if (pairedLeft.has(left)) {
          throw qbankFailure('INVALID_ARGS', `pairs 中左侧 key ${left} 出现多次`, '每个左侧 key 至多配对一次');
        }
        pairedLeft.add(left);
      });
      return;
    }
    case 'ordering': {
      const itemKeys = structuredKeyContentEntries(data.items ?? null, 'structured_data.items', 50);
      const correctOrder = data.correct_order;
      if (!Array.isArray(correctOrder)) {
        throw qbankFailure('INVALID_ARGS', 'ordering 的 structured_data 缺少 correct_order 数组',
          '格式：{"items":[{"key","content"}],"correct_order":["K2","K1",...]}，correct_order 必须是 items key 的一个排列');
      }
      const orderKeys = correctOrder.filter((key): key is string => typeof key === 'string');
      if (orderKeys.length !== correctOrder.length) {
        throw qbankFailure('INVALID_ARGS', 'correct_order 必须全部是字符串 key', '修正 correct_order 后重试');
      }
      const expected = [...itemKeys].sort(compareRustStrings);
      const actual = [...orderKeys].sort(compareRustStrings);
      if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
        throw qbankFailure('INVALID_ARGS', 'correct_order 必须恰好是 items 中所有 key 的一个排列',
          '检查 correct_order 是否遗漏、重复或引用了不存在的 key');
      }
      return;
    }
    case 'numeric': {
      if (typeof data.answer_value !== 'number') {
        throw qbankFailure('INVALID_ARGS', 'numeric 的 structured_data 缺少数值 answer_value',
          '格式：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}');
      }
      if (Object.hasOwn(data, 'tolerance') && !(typeof data.tolerance === 'number' && data.tolerance >= 0)) {
        throw qbankFailure('INVALID_ARGS', 'tolerance 必须是 >= 0 的数值', '修正容差后重试');
      }
      if (Object.hasOwn(data, 'tolerance_mode') && data.tolerance_mode !== 'absolute' && data.tolerance_mode !== 'relative') {
        throw qbankFailure('INVALID_ARGS', 'tolerance_mode 只能是 absolute 或 relative', '修正容差模式后重试');
      }
      if (Object.hasOwn(data, 'unit') && !(typeof data.unit === 'string' && charCount(data.unit) <= 50)) {
        throw qbankFailure('INVALID_ARGS', 'unit 必须是不超过 50 字符的字符串', '修正单位后重试');
      }
      return;
    }
    default:
      return;
  }
}

/** qbank_executor.rs:612 `parse_structured_data_arg`. */
export function parseStructuredDataArg(args: Args, questionType: QuestionType, requiredWhenMissing: boolean): unknown {
  const data = args.structured_data;
  if (data === undefined || data === null) {
    if (requiredWhenMissing && questionTypeRequiresStructuredData(questionType)) {
      throw qbankFailure('INVALID_ARGS', 'matching/ordering/numeric 题型必须提供 structured_data',
        'matching 需 {"left","right","pairs"}；ordering 需 {"items","correct_order"}；numeric 需 {"answer_value","tolerance"?,"unit"?,"tolerance_mode"?}');
    }
    return null;
  }
  validateStructuredData(questionType, data);
  return structuredClone(data);
}

/** qbank_executor.rs:636 `validate_true_false_answer`. */
export function validateTrueFalseAnswer(answer: string): void {
  const trimmed = rustTrim(answer);
  if (trimmed !== 'true' && trimmed !== 'false') {
    throw qbankFailure('INVALID_ARGS', `true_false 题的答案必须是 "true" 或 "false"，收到: ${answer}`,
      '使用小写字符串 true/false 表示判断题答案');
  }
}

/** qbank_executor.rs:668 `read_strict_u32`. */
export function readStrictU32(args: Args, key: string, defaultValue: number, min: number, max: number): number {
  if (!Object.hasOwn(args, key)) return defaultValue;
  const raw = asU64(args[key]);
  if (raw === null) throw qbankFailure('INVALID_ARGS', `${key} 必须是整数`, '修正参数后重试');
  if (raw < min || raw > max) throw qbankFailure('INVALID_ARGS', `${key} 必须在 ${min}..=${max} 范围内`, '修正参数后重试');
  return raw;
}

/** qbank_executor.rs:695 `read_bool`. */
export function readBool(args: Args, key: string, defaultValue: boolean): boolean {
  if (!Object.hasOwn(args, key)) return defaultValue;
  const value = asBool(args[key]);
  if (value === null) throw qbankFailure('INVALID_ARGS', `${key} 必须是布尔值`, '修正参数后重试');
  return value;
}

/** qbank_executor.rs:708 `parse_count_map`. */
export function parseCountMap(value: unknown, field: string, allowedKeys: readonly string[],
  maxTotal: number): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw qbankFailure('INVALID_ARGS', `${field} 必须是对象`, '使用名称到题数的映射');
  const result: Record<string, number> = {};
  let total = 0;
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw qbankFailure('INVALID_ARGS', `${field} 包含不支持的键: ${key}`, '修正分布配置后重试');
    const count = asU64(value[key]);
    if (count === null || count === 0) throw qbankFailure('INVALID_ARGS', `${field}.${key} 必须是正整数`, '修正分布配置后重试');
    if (count > 0xffff_ffff) throw qbankFailure('INVALID_ARGS', `${field}.${key} 数值过大`, '缩小题数后重试');
    total += count;
    if (total > 0xffff_ffff) throw qbankFailure('INVALID_ARGS', `${field} 总题数溢出`, '缩小题数后重试');
    if (total > maxTotal) throw qbankFailure('INVALID_ARGS', `${field} 总题数不能超过 ${maxTotal}`, '缩小题数后重试');
    result[key] = count;
  }
  return result;
}

/**
 * `NaiveDate::parse_from_str(raw, "%Y-%m-%d")`: chrono accepts unpadded month/day.
 * Returns the `%Y-%m-%d` rendering and the day number since the Unix epoch.
 */
function parseChronoDate(value: string): { text: string; epochDay: number } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(value);
  if (match === null) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const pad = (part: number) => String(part).padStart(2, '0');
  return { text: `${match[1]}-${pad(month)}-${pad(day)}`, epochDay: Math.floor(date.getTime() / 86_400_000) };
}

/** qbank_executor.rs:767 `parse_iso_date`. */
export function parseIsoDate(args: Args, key: string): { text: string; epochDay: number } {
  const raw = requiredNonEmptyString(args, key);
  const date = parseChronoDate(raw);
  if (date === null) throw qbankFailure('INVALID_ARGS', `${key} 必须使用 YYYY-MM-DD 格式`, '修正日期后重试');
  return date;
}

/** qbank_executor.rs:798 `bounded_text`. */
export function boundedText(value: string, maxChars: number): [string, boolean] {
  const bounded = takeChars(value, maxChars);
  return [bounded, bounded.length < value.length];
}

/** qbank_executor.rs:805 `truncate_json_strings`. */
export function truncateJsonStrings(value: unknown, path: string, fieldsTruncated: string[]): unknown {
  if (typeof value === 'string') {
    const [bounded, truncated] = boundedText(value, 2_000);
    if (truncated) fieldsTruncated.push(path);
    return bounded;
  }
  if (Array.isArray(value)) return value.map((item, index) => truncateJsonStrings(item, `${path}[${index}]`, fieldsTruncated));
  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      value[key] = truncateJsonStrings(value[key], path === '' ? key : `${path}.${key}`, fieldsTruncated);
    }
  }
  return value;
}

/** qbank_executor.rs:834 `question_to_bounded_value`. */
export function questionToBoundedValue(question: Question): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(question)) as Record<string, unknown>;
  const fieldsTruncated: string[] = [];
  for (const field of ['content', 'answer', 'explanation', 'user_note', 'ai_feedback']) {
    const text = value[field];
    if (typeof text !== 'string') continue;
    const [bounded, truncated] = boundedText(text, 2_000);
    if (truncated) {
      value[field] = bounded;
      value[`${field}_truncated`] = true;
      fieldsTruncated.push(field);
    }
  }
  if (Array.isArray(value.options)) {
    value.options.forEach((option: unknown, index: number) => {
      if (!isRecord(option) || typeof option.content !== 'string') return;
      const [bounded, truncated] = boundedText(option.content, 2_000);
      if (truncated) {
        option.content = bounded;
        option.content_truncated = true;
        fieldsTruncated.push(`options[${index}].content`);
      }
    });
  }
  truncateJsonStrings(value, '', fieldsTruncated);
  value.fieldsTruncated = [...new Set(fieldsTruncated)].sort(compareRustStrings);
  // 原子冻结，须在 truncateJsonStrings（逐键回写）之后替换。
  value.source_refs = sourceRefsValue(value.source_refs);
  value.answer_source_refs = sourceRefsValue(value.answer_source_refs);
  value.materials = materialsValue(value.materials);
  return value;
}

/** `SourceRef.bbox` 是 `[f64; 4]`（qbank_types.rs:16），serde_json 写 `1.0`。 */
export function sourceRefsValue(refs: unknown): unknown {
  if (!Array.isArray(refs)) return refs;
  return refs.map(ref => (isRecord(ref) && Array.isArray(ref.bbox)
    ? { ...ref, bbox: ref.bbox.map(item => (typeof item === 'number' ? f64Atom(item) : item)) } : ref));
}

/** `QuestionMaterial.source_refs`（qbank_types.rs:26）同 {@link sourceRefsValue}。 */
export function materialsValue(materials: unknown): unknown {
  if (!Array.isArray(materials)) return materials;
  return materials.map(material => (isRecord(material)
    ? { ...material, source_refs: sourceRefsValue(material.source_refs) } : material));
}

/** qbank_executor.rs:890 `bounded_optional_text`. */
export function boundedOptionalText(value: string | null | undefined): { text: string; truncated: boolean } | null {
  if (value === null || value === undefined) return null;
  const [text, truncated] = boundedText(value, 2_000);
  return { text, truncated };
}

/** qbank_executor.rs:1269 `parse_question_images`. */
export function parseQuestionImages(value: unknown): QuestionImage[] {
  if (!Array.isArray(value)) {
    throw qbankFailure('INVALID_ARGS', 'images 必须是结构化附件数组', '每项至少包含非空字符串 id；只有显式空数组才表示清空图片');
  }
  return value.map((image, index) => {
    if (!isRecord(image)) throw qbankFailure('INVALID_ARGS', `images[${index}] 必须是对象`, '每项格式为 {id,name?,mime?,hash?}');
    const unknown = Object.keys(image).find(key => key !== 'id' && key !== 'name' && key !== 'mime' && key !== 'hash');
    if (unknown !== undefined) {
      throw qbankFailure('INVALID_ARGS', `images[${index}] 包含未知字段 ${unknown}`, '每项仅允许 {id,name?,mime?,hash?}');
    }
    const id = trimmedString(image.id);
    if (id === null) {
      throw qbankFailure('INVALID_ARGS', `images[${index}].id 必须是非空字符串`, '修正附件描述后重试；无效项不会被忽略或用于清空图片');
    }
    const optional = (key: string, fallback: string): string => {
      if (!Object.hasOwn(image, key)) return fallback;
      const text = asStr(image[key]);
      if (text === null) {
        throw qbankFailure('INVALID_ARGS', `images[${index}].${key} 必须是字符串`, '修正附件描述后重试；无效项不会被忽略或用于清空图片');
      }
      return text;
    };
    return { id, name: optional('name', ''), mime: optional('mime', 'image/png'), hash: optional('hash', '') };
  });
}

export interface ImageFileResolver {
  resolveFileId(rawId: string): string | null;
  getById(fileId: string): { id: string; blobHash?: string; mimeType: string; name: string; deletedAt?: string } | null;
}

/** qbank_executor.rs:1344 `normalize_question_image_ids`: `res_*` resource ids → files primary keys. */
export function normalizeQuestionImageIds(resolver: ImageFileResolver | null, images: QuestionImage[]): void {
  if (!images.some(image => image.id.startsWith('res_'))) return;
  if (resolver === null) return;
  images.forEach((image, index) => {
    if (!image.id.startsWith('res_')) return;
    const fileId = resolver.resolveFileId(image.id);
    const record = fileId === null ? null : resolver.getById(fileId);
    if (record === null || record.deletedAt != null) {
      throw qbankFailure('INVALID_ARGS', `images[${index}].id=${image.id} 不是可加载的图片文件`,
        '该资源未关联图片文件；用 attachment_list 取 att_/file_ 开头的附件 ID 后重试');
    }
    image.id = record.id;
    if (record.blobHash !== undefined && record.blobHash !== '') image.hash = record.blobHash;
    if (record.mimeType.startsWith('image/')) image.mime = record.mimeType;
    if (rustTrim(image.name) === '') image.name = record.name;
  });
}

/** qbank_executor.rs:1484 `read_bounded_u32` (lenient: invalid → default). */
export function readBoundedU32(args: Args, key: string, defaultValue: number, min: number, max: number): number {
  const raw = asI64(args[key]) ?? defaultValue;
  const normalized = raw < min ? min : raw;
  return Math.min(max, Math.max(min, normalized));
}

/** qbank_executor.rs:1493 `read_non_negative_u32`. */
export function readNonNegativeU32(args: Args, key: string, defaultValue: number): number {
  const raw = asI64(args[key]) ?? defaultValue;
  return raw < 0 ? defaultValue : raw;
}

/** qbank_executor.rs:1559 `page_bounds`. */
export function pageBounds(args: Args, total: number): { page: number; pageSize: number; start: number; end: number } {
  const page = readStrictU32(args, 'page', 1, 1, 0xffff_ffff);
  const pageSize = readStrictU32(args, 'page_size', 20, 1, 20);
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return { page, pageSize, start: Math.min(start, total), end };
}

/** qbank_executor.rs:1567 `practice_handoff`. */
export function practiceHandoff(examId: string, mode: string, session: unknown): Record<string, unknown> {
  if (mode !== 'timed' && mode !== 'mock_exam' && mode !== 'daily') {
    throw qbankFailure('INVALID_ARGS', `不支持的练习 handoff mode: ${mode}`, 'mode 仅支持 timed、mock_exam 或 daily');
  }
  const record = isRecord(session) ? session : {};
  const handoffId = asStr(record.id ?? record.date);
  if (handoffId === null || rustTrim(handoffId) === '') {
    throw qbankFailure('QBANK_HANDOFF_INVALID', '练习会话缺少稳定 id/date', '重新生成练习会话后再打开题库 UI');
  }
  return {
    version: 1, kind: 'qbank_practice_session', handoff_id: handoffId, exam_id: examId, mode, session,
    agentCanAnswer: false,
  };
}

/** qbank_executor.rs:1598 `practice_workbench_action`. */
export function practiceWorkbenchAction(examId: string, handoff: unknown): Record<string, unknown> {
  return {
    tool: 'builtin-workbench_app_command',
    executed: false,
    payloadHydrationSupported: true,
    arguments: { typeId: 'exam', instanceKey: examId, action: 'hydratePracticeSession', payload: { handoff } },
  };
}
