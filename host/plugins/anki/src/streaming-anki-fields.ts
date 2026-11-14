/**
 * 可读文本、占位符、牌组标签与字段规则校验
 * （`streaming_anki_service.rs:357-592`）。
 */
import type {
  FieldExtractionRule__De,
  FieldType__De,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { NativeRegex, NativeRegexPattern } from '../../../platform/native/api.ts';
import { NativeRegexCompileError } from '../../../platform/native/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import type { AnkiLogger } from './logger.ts';
import { ERROR_CARD_RAW_PREVIEW_CHARS } from './streaming-anki-protocol.ts';
import { eqIgnoreAsciiCase } from './streaming-anki-templates.ts';

// ============================================================================
// 可读文本 / 占位符 / 牌组标签（`streaming_anki_service.rs:357-456`）
// ============================================================================

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractReadableText(jsonValue: unknown): string | null {
  const scan = (obj: Record<string, unknown>): string | null => {
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (['tags', 'template_id', 'templateid', 'images', 'fields'].includes(keyLower)) continue;
      if (typeof value === 'string') {
        const trimmed = rustTrim(value);
        if (trimmed !== '') return trimmed;
      }
    }
    return null;
  };

  if (!isRecord(jsonValue)) return null;
  const top = scan(jsonValue);
  if (top !== null) return top;
  const fields = jsonValue['fields'];
  return isRecord(fields) ? scan(fields) : null;
}

const PLACEHOLDER_VALUES: readonly string[] = [
  'placeholder',
  '...',
  '…',
  'todo',
  'tbd',
  'xxx',
  'n/a',
  'none',
  'null',
  '占位',
  '示例',
  '待补充',
  '内容',
];

const PLACEHOLDER_TRIM_CHARS = new Set('[]{}<>()（）【】"\'');
const PLACEHOLDER_TRIM_RE = /^[\[\]{}<>()（）【】"']+/u;
const PLACEHOLDER_TRIM_END_RE = /[\[\]{}<>()（）【】"']+$/u;

export function isPlaceholderCard(jsonValue: unknown): boolean {
  if (!isRecord(jsonValue)) return false;

  const collect = (obj: Record<string, unknown>, out: string[]): void => {
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase();
      if (['tags', 'template_id', 'templateid', 'images'].includes(keyLower)) continue;
      if (typeof value === 'string') out.push(value);
      else if (isRecord(value) && keyLower === 'fields') collect(value, out);
    }
  };

  const values: string[] = [];
  collect(jsonValue, values);
  return (
    values.length > 0 &&
    values.every((value) => {
      const normalized = rustTrim(
        rustTrim(value).replace(PLACEHOLDER_TRIM_RE, '').replace(PLACEHOLDER_TRIM_END_RE, ''),
      );
      return (
        normalized === '' ||
        PLACEHOLDER_VALUES.some((placeholder) => eqIgnoreAsciiCase(normalized, placeholder))
      );
    })
  );
}

export function deckTag(deckName: string): string | null {
  const deck = rustTrim(deckName);
  if (deck === '' || eqIgnoreAsciiCase(deck, 'default')) return null;
  return deck.split(/\s+/u).filter((part) => part !== '').join('_');
}

export function errorCardContent(error: string, rawOutput: string): string {
  const raw = [...rawOutput].slice(0, ERROR_CARD_RAW_PREVIEW_CHARS).join('');
  return `解析卡片失败: ${error}\n原始输出: ${raw}`;
}

// ============================================================================
// 字段描述 / 规则查找 / 字段校验（`streaming_anki_service.rs:462-592`）
// ============================================================================

export function fieldTypeName(fieldType: FieldType__De): string {
  if (typeof fieldType === 'string') return fieldType;
  const record = fieldType as Record<string, unknown>;
  const key = Object.keys(record)[0];
  return key ?? 'Text';
}

export function describePromptField(
  field: string,
  rule: FieldExtractionRule__De | null | undefined,
): string {
  const requiredMark =
    rule !== null && rule !== undefined
      ? rule.is_required
        ? '必填'
        : '可选'
      : field === 'front' || field === 'back'
        ? '必填'
        : '可选';

  let typeLabel: string;
  if (rule !== null && rule !== undefined) {
    const typeName = fieldTypeName(rule.field_type);
    if (typeName === 'Array') typeLabel = '字符串数组';
    else if (typeName === 'Number') typeLabel = '数字';
    else if (typeName === 'Boolean') typeLabel = '布尔值';
    else typeLabel = '字符串';
  } else if (field === 'tags') {
    typeLabel = '字符串数组';
  } else {
    typeLabel = '字符串';
  }

  const rawDescription = rule !== null && rule !== undefined ? rustTrim(rule.description) : '';
  const description =
    rawDescription !== ''
      ? rawDescription
      : field === 'front'
        ? '问题或概念'
        : field === 'back'
          ? '答案或解释'
          : field === 'tags'
            ? '相关标签'
            : field === 'example'
              ? '具体示例'
              : field === 'source'
                ? '来源信息'
                : field === 'code'
                  ? '代码示例'
                  : field === 'notes'
                    ? '补充注释'
                    : field;

  return `${field}（${typeLabel}，${requiredMark}）：${description}`;
}

export function findRule(
  rules: Readonly<Record<string, FieldExtractionRule__De>> | null | undefined,
  field: string,
): FieldExtractionRule__De | undefined {
  if (rules === null || rules === undefined) return undefined;
  if (Object.hasOwn(rules, field)) return rules[field];
  for (const [key, rule] of Object.entries(rules)) {
    if (eqIgnoreAsciiCase(key, field)) return rule;
  }
  return undefined;
}

export interface FieldViolation {
  field: string;
  rule: string;
  message: string;
}

/** `validate_field_against_rule`：违规只标记，不毙卡。 */
export async function validateFieldAgainstRule(
  fieldName: string,
  value: string,
  rule: FieldExtractionRule__De,
  regex: Pick<NativeRegex, 'compile' | 'isMatch'>,
  logger: Pick<AnkiLogger, 'warn'> = { warn() {} },
): Promise<FieldViolation[]> {
  const violations: FieldViolation[] = [];
  const charCount = [...value].length;

  const min = rule.min_length ?? null;
  if (min !== null && charCount < min) {
    violations.push({
      field: fieldName,
      rule: 'min_length',
      message: `长度 ${charCount} 小于最小长度 ${min}`,
    });
  }

  const max = rule.max_length ?? null;
  if (max !== null && charCount > max) {
    violations.push({
      field: fieldName,
      rule: 'max_length',
      message: `长度 ${charCount} 超过最大长度 ${max}`,
    });
  }

  const allowed = rule.allowed_values ?? null;
  if (allowed !== null && allowed.length > 0) {
    const matched = allowed.some((candidate) =>
      typeof candidate === 'string' ? candidate === value : JSON.stringify(candidate) === value,
    );
    if (!matched) {
      const preview = [...value].slice(0, 40).join('');
      violations.push({
        field: fieldName,
        rule: 'allowed_values',
        message: `值 "${preview}" 不在允许值列表中`,
      });
    }
  }

  const pattern = rustTrim(rule.validation_pattern ?? '');
  if (pattern !== '') {
    let compiled: NativeRegexPattern | null;
    try {
      compiled = await regex.compile(pattern);
    } catch (error) {
      if (!(error instanceof NativeRegexCompileError)) throw error;
      logger.warn(`[QA_FLAGS] 字段 ${fieldName} 的 validation_pattern 无法编译（${error.message}），跳过该项校验`);
      compiled = null;
    }
    if (compiled !== null && !(await regex.isMatch(compiled, value))) {
      violations.push({
        field: fieldName,
        rule: 'validation_pattern',
        message: `值不匹配校验模式 ${pattern}`,
      });
    }
  }

  return violations;
}

/** 判断 JSON 片段是否自身配平。 */
export function jsonFragmentBalanced(fragment: string): boolean {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (const c of fragment) {
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0 && !inString;
}

/** 紧凑输出上限（`compact_output_budget`）。 */
export function compactOutputBudget(cap: number, segment: string, reasoning: boolean, modelLimit: number): number {
  const chars = [...segment].length;
  const floor = chars * 3 + 1000;
  let budget = Math.max(cap, floor);
  if (reasoning) budget += 4096;
  if (modelLimit > 0) budget = Math.min(budget, modelLimit);
  return budget;
}
