/**
 * 题目 structured_data 契约的 UI 侧薄封装
 *
 * 类型与判分语义的唯一真源是 src/api/questionBankApi.ts（与 Rust
 * question_bank_service 判分引擎对齐）。本文件只保留：
 * - 对 questionBankApi 契约类型的重导出（保持 question-types 组件的既有导入名）；
 * - structured_data 原始值的收窄校验（parse*Data，api 侧仅提供 is* 守卫）；
 * - UI 专用的编解码封装与逐项揭示 helper（内部复用 api 的归一化/解析函数）。
 *
 * 2026-07 题库题型扩展
 */

import type {
  Question,
  QuestionType,
  MatchingItem,
  MatchingPair,
  FillBlankSpec,
  FillBlankStructuredData,
  MatchingStructuredData,
  OrderingStructuredData,
  NumericStructuredData,
} from '@/api/questionBankApi';
import {
  encodeUserAnswer,
  decodeUserAnswer,
  normalizeFullwidth,
  parseNumericInput,
  normalizeSequenceKey,
} from '@/api/questionBankApi';

export type {
  FillBlankSpec,
  FillBlankStructuredData,
  MatchingStructuredData,
  OrderingStructuredData,
  NumericStructuredData,
  MatchingPair,
  NumericToleranceMode,
  QuestionStructuredData,
} from '@/api/questionBankApi';

/**
 * 历史别名：QuestionType 并入 4 个新题型前组件用它规避字面量收窄错误。
 * 契约落地后与 QuestionType 等价，保留导出名避免改动下游 import。
 */
export type ExtendedQuestionType = QuestionType;

/** 历史别名：匹配/排序共用的条目结构（api 侧为 MatchingItem/OrderingItem，形状相同） */
export type StructuredItem = MatchingItem;

// ============================================================================
// 读取 / 解析（api 侧只有 is* 判别守卫；此处负责 unknown → 契约类型的收窄校验）
// ============================================================================

/**
 * 从题目上读取 structured_data 原始值。
 * 兼容 snake_case（契约字段）与 camelCase（部分序列化层可能转换），
 * 兼容对象与 JSON 字符串两种形态。
 */
export function getQuestionStructuredData(question: Question | null | undefined): unknown {
  if (!question) return null;
  const raw = (question as Question & {
    structured_data?: unknown;
    structuredData?: unknown;
  });
  const value = raw.structured_data ?? raw.structuredData ?? null;
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseItems(value: unknown): StructuredItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: StructuredItem[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.key !== 'string') return null;
    items.push({ key: entry.key, content: typeof entry.content === 'string' ? entry.content : '' });
  }
  return items;
}

/** 校验并收窄匹配题数据；结构非法时返回 null（调用方回退自由文本作答） */
export function parseMatchingData(raw: unknown): MatchingStructuredData | null {
  if (!isRecord(raw)) return null;
  const left = parseItems(raw.left);
  const right = parseItems(raw.right);
  if (!left || !right || left.length === 0 || right.length === 0) return null;
  const pairs: MatchingPair[] = [];
  if (Array.isArray(raw.pairs)) {
    for (const pair of raw.pairs) {
      if (isRecord(pair) && typeof pair.left === 'string' && typeof pair.right === 'string') {
        pairs.push({ left: pair.left, right: pair.right });
      }
    }
  }
  return { left, right, pairs };
}

/** 校验并收窄排序题数据 */
export function parseOrderingData(raw: unknown): OrderingStructuredData | null {
  if (!isRecord(raw)) return null;
  const items = parseItems(raw.items);
  if (!items || items.length === 0) return null;
  const correctOrder = Array.isArray(raw.correct_order)
    ? raw.correct_order.filter((k): k is string => typeof k === 'string')
    : [];
  return { items, correct_order: correctOrder };
}

/** 校验并收窄数值题数据 */
export function parseNumericData(raw: unknown): NumericStructuredData | null {
  if (!isRecord(raw)) return null;
  const answerValue = typeof raw.answer_value === 'number' ? raw.answer_value : Number(raw.answer_value);
  if (!Number.isFinite(answerValue)) return null;
  const tolerance = typeof raw.tolerance === 'number' && Number.isFinite(raw.tolerance)
    ? Math.abs(raw.tolerance)
    : undefined;
  return {
    answer_value: answerValue,
    tolerance,
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : undefined,
    tolerance_mode: raw.tolerance_mode === 'relative' ? 'relative' : 'absolute',
  };
}

/** 校验并收窄填空题增强数据 */
export function parseFillBlankData(raw: unknown): FillBlankStructuredData | null {
  if (!isRecord(raw) || !Array.isArray(raw.blanks) || raw.blanks.length === 0) return null;
  const blanks: FillBlankSpec[] = [];
  for (const blank of raw.blanks) {
    if (!isRecord(blank) || !Array.isArray(blank.answers)) return null;
    blanks.push({
      answers: blank.answers.filter((a): a is string => typeof a === 'string'),
      case_sensitive: blank.case_sensitive === true,
      trim: blank.trim !== false,
    });
  }
  return { blanks };
}

// ============================================================================
// user_answer 序列化 / 反序列化（薄封装 api 的 encodeUserAnswer/decodeUserAnswer）
// ============================================================================

/** matching user_answer：{"pairs":[{"left":"L1","right":"R2"}]} */
export function encodeMatchingUserAnswer(pairs: MatchingPair[]): string {
  return encodeUserAnswer({ type: 'matching', pairs });
}

/** ordering user_answer：JSON 数组 ["B","A","C"] */
export function encodeOrderingUserAnswer(order: string[]): string {
  return encodeUserAnswer({ type: 'ordering', order });
}

/**
 * fill_blank user_answer：多空 JSON 数组 ["a","b"]；
 * 单空保留裸字符串（兼容旧数据与旧判分路径）。
 */
export function encodeFillBlankUserAnswer(answers: string[]): string {
  return encodeUserAnswer({ type: 'fill_blank', blanks: answers });
}

/** 解析填空 user_answer：兼容 JSON 数组与旧单串 / '|||' 分隔旧格式 */
export function decodeFillBlankUserAnswer(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  const decoded = decodeUserAnswer('fill_blank', raw);
  if (!decoded || decoded.type !== 'fill_blank') return [];
  // '|||' 是前端历史多空拼接格式（后端与 api 契约均不含），仅在展示旧作答时兼容
  if (decoded.blanks.length === 1 && decoded.blanks[0].includes('|||')) {
    return decoded.blanks[0].split('|||');
  }
  return decoded.blanks;
}

// ============================================================================
// 前端逐项揭示 helper（api 的 gradeAnswerLocally 只给整体结论；
// 逐空/逐对/数值的单项判定复用 api 导出的归一化与解析函数，保证同口径）
// ============================================================================

/** 单空是否命中可接受答案（全角归一化 + case/trim 规则，与后端 grade_fill_blank 同口径） */
export function isBlankAnswerCorrect(input: string, spec: FillBlankSpec): boolean {
  const trim = spec.trim !== false;
  const caseSensitive = spec.case_sensitive === true;
  const normalize = (s: string) => {
    let out = normalizeFullwidth(s);
    if (trim) out = out.trim();
    if (!caseSensitive) out = out.toLowerCase();
    return out;
  };
  const normalized = normalize(input);
  return spec.answers.some((answer) => normalize(answer) === normalized);
}

/** 数值答案是否在容差内（宽松解析用户输入；无法解析时返回 false，与后端 grade_numeric 同口径） */
export function isNumericAnswerCorrect(input: string, spec: NumericStructuredData): boolean {
  const value = parseNumericInput(input);
  if (value == null) return false;
  const tolerance = Math.abs(spec.tolerance ?? 0);
  const allowed = spec.tolerance_mode === 'relative'
    ? Math.abs(spec.answer_value) * tolerance
    : tolerance;
  // 浮点噪声补偿叠加在容差上（与后端 grade_numeric 一致）
  const epsilon = Number.EPSILON * Math.max(Math.abs(spec.answer_value), 1) * 4;
  return Math.abs(value - spec.answer_value) <= allowed + epsilon;
}

/** 用户某个配对是否命中标准答案（key 经全角归一化 + trim + 大写，与后端 grade_matching 同口径） */
export function isPairCorrect(pair: MatchingPair, data: MatchingStructuredData): boolean {
  const left = normalizeSequenceKey(pair.left);
  const right = normalizeSequenceKey(pair.right);
  return data.pairs.some(
    (p) => normalizeSequenceKey(p.left) === left && normalizeSequenceKey(p.right) === right
  );
}

/** 数值题参考答案的可读展示：如 "3.14 ± 0.01 m"（UI 专用，无后端对应物） */
export function formatNumericAnswer(spec: NumericStructuredData): string {
  const parts: string[] = [String(spec.answer_value)];
  if (spec.tolerance != null && spec.tolerance > 0) {
    parts.push(spec.tolerance_mode === 'relative'
      ? `± ${spec.tolerance * 100}%`
      : `± ${spec.tolerance}`);
  }
  if (spec.unit) parts.push(spec.unit);
  return parts.join(' ');
}
