/**
 * Generative UI 交互作答 — 从各交互块本地状态构造 GenerativeUIAnswerPayload
 *
 * 客户端预校验规则与 Rust `validate_genui_answer` 一致（Rust 为准）：
 * - choice：selected 去重后 ∈ option ids；single 恰 1（required=false 可 0）；
 *   multiple ∈ [minSelect(默认1), maxSelect(默认 options.length)]（required=false 可 0）；
 *   other 仅 allowOther、≤500，非空时计入选择数。
 * - form：text ≤maxLength；number 有限且 ∈[min,max]；slider ∈[min,max] 且对齐 step（误差 <1e-6）；
 *   rating 整数 1..=max；switch bool；必填非 null / 非空串；可选未填为 null。
 * - summary：标签拼接，剔除 \n\t 以外控制字符，截断到 500；data 序列化 ≤16000。
 */

import type { ChoiceProps, FormField, FormProps } from '../schema';
import { resolveChoiceSelectBounds } from '../schema';
import type { InteractiveBlockSpec } from '../validateIntentRules';
import {
  GENUI_ANSWER_DATA_MAX_CHARS,
  GENUI_ANSWER_SUMMARY_MAX_CHARS,
  GENUI_CHOICE_OTHER_MAX_CHARS,
  countGenuiChars,
  truncateGenuiChars,
} from './limits';
import type {
  ChoiceAnswer,
  FormAnswer,
  GenerativeUIAnswerData,
  GenerativeUIAnswerPayload,
} from './types';

/** choice 本地状态 */
export interface ChoiceDraftState {
  selected: readonly string[];
  other?: string;
}

/** form 本地状态：输入框可能是字符串（number/slider 也接受数字字符串） */
export type FormDraftValue = string | number | boolean | null | undefined;
export type FormDraftState = Record<string, FormDraftValue>;

export type GenerativeUIInteractiveDraft =
  | (Extract<InteractiveBlockSpec, { type: 'choice' }> & { state: ChoiceDraftState })
  | (Extract<InteractiveBlockSpec, { type: 'form' }> & { state: FormDraftState });

export type GenerativeUIAnswerIssueCode =
  | 'no_blocks'
  | 'duplicate_block'
  | 'choice_required'
  | 'choice_too_few'
  | 'choice_too_many'
  | 'choice_unknown_option'
  | 'choice_other_not_allowed'
  | 'choice_other_too_long'
  | 'field_required'
  | 'field_too_long'
  | 'field_not_number'
  | 'field_out_of_range'
  | 'field_step_mismatch'
  | 'field_invalid'
  | 'data_too_large';

export interface GenerativeUIAnswerIssue {
  blockId: string;
  /** form 字段 name；choice 为空 */
  field?: string;
  code: GenerativeUIAnswerIssueCode;
}

export interface GenerativeUIAnswerSummaryLabels {
  keyValueSeparator: string;
  listSeparator: string;
  fieldSeparator: string;
  blockSeparator: string;
  other: string;
  yes: string;
  no: string;
  notSelected: string;
  /** 全部为空时的兜底摘要（Rust 要求 summary 非空） */
  fallback: string;
}

export const DEFAULT_ANSWER_SUMMARY_LABELS: GenerativeUIAnswerSummaryLabels = {
  keyValueSeparator: '：',
  listSeparator: '、',
  fieldSeparator: '；',
  blockSeparator: '\n',
  other: '其他',
  yes: '是',
  no: '否',
  notSelected: '（未选择）',
  fallback: '已提交',
};

export type BuildGenerativeUIAnswerResult =
  | { ok: true; payload: GenerativeUIAnswerPayload }
  | { ok: false; issues: GenerativeUIAnswerIssue[] };

const SLIDER_STEP_EPSILON = 1e-6;

/** 剔除 \n \t 以外的 C0/C1 控制字符（同 Rust summary 清理） */
// eslint-disable-next-line no-control-regex
const SUMMARY_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** 剔除 \n \t 以外的控制字符（Rust sanitize_genui_user_text） */
export function stripGenuiControlChars(text: string): string {
  return text.replace(SUMMARY_CONTROL_RE, '');
}

export function sanitizeGenerativeUIAnswerSummary(summary: string): string {
  const cleaned = summary.replace(SUMMARY_CONTROL_RE, '').trim();
  return truncateGenuiChars(cleaned, GENUI_ANSWER_SUMMARY_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// choice
// ---------------------------------------------------------------------------

export function buildChoiceAnswer(
  blockId: string,
  props: ChoiceProps,
  state: ChoiceDraftState,
): { answer: ChoiceAnswer; issues: GenerativeUIAnswerIssue[] } {
  const issues: GenerativeUIAnswerIssue[] = [];
  const optionIds = props.options.map((o) => o.id);
  const picked = new Set(state.selected);
  for (const id of picked) {
    if (!optionIds.includes(id)) issues.push({ blockId, code: 'choice_unknown_option' });
  }
  // 按选项顺序输出，保证确定性
  const selected = optionIds.filter((id) => picked.has(id));
  const other = typeof state.other === 'string' ? stripGenuiControlChars(state.other).trim() : '';

  const answer: ChoiceAnswer = { selected };
  if (other) {
    if (!props.allowOther) issues.push({ blockId, code: 'choice_other_not_allowed' });
    else if (countGenuiChars(other) > GENUI_CHOICE_OTHER_MAX_CHARS) {
      issues.push({ blockId, code: 'choice_other_too_long' });
    }
    answer.other = other;
  }

  const count = selected.length + (other ? 1 : 0);
  const required = props.required !== false;
  if (count === 0) {
    if (required) issues.push({ blockId, code: 'choice_required' });
  } else {
    const { min, max } = resolveChoiceSelectBounds(props);
    if (count < min) issues.push({ blockId, code: 'choice_too_few' });
    if (count > max) issues.push({ blockId, code: 'choice_too_many' });
  }
  return { answer, issues };
}

// ---------------------------------------------------------------------------
// form
// ---------------------------------------------------------------------------

function toNumber(value: FormDraftValue): number | null | 'nan' {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'nan';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : 'nan';
  }
  return 'nan';
}

function normalizeFieldValue(
  blockId: string,
  field: FormField,
  raw: FormDraftValue,
  issues: GenerativeUIAnswerIssue[],
): string | number | boolean | null {
  const push = (code: GenerativeUIAnswerIssueCode) => issues.push({ blockId, field: field.name, code });
  switch (field.kind) {
    case 'text': {
      const text = typeof raw === 'string' ? stripGenuiControlChars(raw).trim() : raw == null ? '' : String(raw).trim();
      if (!text) {
        if (field.required) push('field_required');
        return null;
      }
      if (countGenuiChars(text) > field.maxLength) push('field_too_long');
      return text;
    }
    case 'switch': {
      if (raw === undefined || raw === null) return field.default ?? false;
      if (typeof raw !== 'boolean') {
        push('field_invalid');
        return null;
      }
      return raw;
    }
    case 'number':
    case 'slider':
    case 'rating': {
      const n = toNumber(raw);
      if (n === 'nan') {
        push('field_not_number');
        return null;
      }
      if (n === null) {
        if (field.required) push('field_required');
        return null;
      }
      if (field.kind === 'rating') {
        if (!Number.isInteger(n) || n < 1 || n > field.max) push('field_out_of_range');
        return n;
      }
      if (field.kind === 'number') {
        if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
          push('field_out_of_range');
        }
        return n;
      }
      // slider
      if (n < field.min || n > field.max) {
        push('field_out_of_range');
      } else {
        const steps = (n - field.min) / field.step;
        if (Math.abs(steps - Math.round(steps)) >= SLIDER_STEP_EPSILON) push('field_step_mismatch');
      }
      return n;
    }
    default:
      return null;
  }
}

export function buildFormAnswer(
  blockId: string,
  props: FormProps,
  state: FormDraftState,
): { answer: FormAnswer; issues: GenerativeUIAnswerIssue[] } {
  const issues: GenerativeUIAnswerIssue[] = [];
  const answer: FormAnswer = {};
  for (const field of props.fields) {
    answer[field.name] = normalizeFieldValue(blockId, field, state[field.name], issues);
  }
  return { answer, issues };
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

function formatFormValue(
  field: FormField,
  value: string | number | boolean | null,
  labels: GenerativeUIAnswerSummaryLabels,
): string | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? labels.yes : labels.no;
  if (field.kind === 'rating') return `${value}/${field.max}`;
  if ((field.kind === 'number' || field.kind === 'slider') && field.unit) return `${value}${field.unit}`;
  return String(value);
}

export function buildGenerativeUIAnswerSummary(
  drafts: readonly InteractiveBlockSpec[],
  data: GenerativeUIAnswerData,
  labelOverrides?: Partial<GenerativeUIAnswerSummaryLabels>,
): string {
  const labels = { ...DEFAULT_ANSWER_SUMMARY_LABELS, ...labelOverrides };
  const parts: string[] = [];
  for (const block of drafts) {
    const answer = data[block.blockId];
    if (!answer) continue;
    if (block.type === 'choice') {
      const choice = answer as ChoiceAnswer;
      const picked = choice.selected
        .map((id) => block.props.options.find((o) => o.id === id)?.label)
        .filter((label): label is string => Boolean(label));
      if (choice.other) picked.push(`${labels.other}${labels.keyValueSeparator}${choice.other}`);
      const value = picked.length > 0 ? picked.join(labels.listSeparator) : labels.notSelected;
      parts.push(`${block.props.question}${labels.keyValueSeparator}${value}`);
    } else {
      const form = answer as FormAnswer;
      const fieldParts: string[] = [];
      for (const field of block.props.fields) {
        const shown = formatFormValue(field, form[field.name] ?? null, labels);
        if (shown !== null) fieldParts.push(`${field.label}${labels.keyValueSeparator}${shown}`);
      }
      if (fieldParts.length > 0) parts.push(fieldParts.join(labels.fieldSeparator));
    }
  }
  const summary = sanitizeGenerativeUIAnswerSummary(parts.join(labels.blockSeparator));
  return summary || sanitizeGenerativeUIAnswerSummary(labels.fallback) || 'submitted';
}

// ---------------------------------------------------------------------------
// 严格校验已成形载荷（镜像 Rust validate_genui_answer；用于 fixtures 一致性与提交前兜底）
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBlockRequired(block: InteractiveBlockSpec): boolean {
  if (block.type === 'choice') return block.props.required !== false;
  return block.props.fields.some((f) => f.required);
}

/**
 * 校验任意 { summary, data } 是否满足 spec：data 必须对象、键 ⊆ 块 id、必答块必须出现、
 * 序列化 ≤16000；choice/form 值类型严格（数字必须是 number、switch 必须是 boolean）。
 * 通过后按 spec 顺序重建 data。
 */
export function validateGenerativeUIAnswer(
  spec: { blocks: readonly InteractiveBlockSpec[] },
  summary: unknown,
  data: unknown,
): { ok: true; payload: GenerativeUIAnswerPayload } | { ok: false; issues: GenerativeUIAnswerIssue[] } {
  const issues: GenerativeUIAnswerIssue[] = [];
  const cleanSummary = typeof summary === 'string' ? summary.replace(SUMMARY_CONTROL_RE, '').trim() : '';
  if (!cleanSummary || countGenuiChars(cleanSummary) > GENUI_ANSWER_SUMMARY_MAX_CHARS) {
    issues.push({ blockId: '', code: 'field_invalid', field: 'summary' });
  }
  if (!isPlainRecord(data)) {
    return { ok: false, issues: [...issues, { blockId: '', code: 'field_invalid', field: 'data' }] };
  }
  if (countGenuiChars(JSON.stringify(data)) > GENUI_ANSWER_DATA_MAX_CHARS) {
    issues.push({ blockId: '', code: 'data_too_large' });
  }
  const known = new Set(spec.blocks.map((b) => b.blockId));
  for (const key of Object.keys(data)) {
    if (!known.has(key)) issues.push({ blockId: key, code: 'field_invalid' });
  }

  const rebuilt: GenerativeUIAnswerData = {};
  for (const block of spec.blocks) {
    const raw = data[block.blockId];
    if (raw === undefined || raw === null) {
      if (isBlockRequired(block)) {
        issues.push({ blockId: block.blockId, code: block.type === 'choice' ? 'choice_required' : 'field_required' });
      }
      continue;
    }
    if (!isPlainRecord(raw)) {
      issues.push({ blockId: block.blockId, code: 'field_invalid' });
      continue;
    }
    if (block.type === 'choice') {
      const { selected, other } = raw;
      const extraKeys = Object.keys(raw).filter((k) => k !== 'selected' && k !== 'other');
      if (
        !Array.isArray(selected) ||
        !selected.every((s) => typeof s === 'string') ||
        (other !== undefined && other !== null && typeof other !== 'string') ||
        extraKeys.length > 0
      ) {
        issues.push({ blockId: block.blockId, code: 'field_invalid' });
        continue;
      }
      const built = buildChoiceAnswer(block.blockId, block.props, {
        selected: selected as string[],
        other: typeof other === 'string' ? other : undefined,
      });
      issues.push(...built.issues);
      rebuilt[block.blockId] = built.answer;
    } else {
      const fieldNames = new Set(block.props.fields.map((f) => f.name));
      let typeError = false;
      for (const [key, value] of Object.entries(raw)) {
        if (!fieldNames.has(key)) {
          issues.push({ blockId: block.blockId, field: key, code: 'field_invalid' });
          typeError = true;
          continue;
        }
        const field = block.props.fields.find((f) => f.name === key)!;
        const expected = field.kind === 'text' ? 'string' : field.kind === 'switch' ? 'boolean' : 'number';
        if (value !== null && typeof value !== expected) {
          issues.push({ blockId: block.blockId, field: key, code: 'field_invalid' });
          typeError = true;
        }
        if (field.kind === 'switch' && value === null && field.required) {
          issues.push({ blockId: block.blockId, field: key, code: 'field_required' });
          typeError = true;
        }
      }
      if (typeError) continue;
      const state: FormDraftState = {};
      for (const field of block.props.fields) {
        const value = raw[field.name];
        // switch 缺省不补默认值：严格模式下缺失即 null
        state[field.name] = field.kind === 'switch' && value === undefined ? null : (value as FormDraftValue);
      }
      const built = buildFormAnswer(block.blockId, block.props, state);
      for (const field of block.props.fields) {
        if (field.kind === 'switch' && state[field.name] === null) {
          built.answer[field.name] = null;
          if (field.required) built.issues.push({ blockId: block.blockId, field: field.name, code: 'field_required' });
        }
      }
      issues.push(...built.issues);
      rebuilt[block.blockId] = built.answer;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, payload: { summary: cleanSummary, data: rebuilt } };
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

export function buildGenerativeUIAnswer(
  drafts: readonly GenerativeUIInteractiveDraft[],
  options?: { labels?: Partial<GenerativeUIAnswerSummaryLabels> },
): BuildGenerativeUIAnswerResult {
  if (drafts.length === 0) return { ok: false, issues: [{ blockId: '', code: 'no_blocks' }] };

  const issues: GenerativeUIAnswerIssue[] = [];
  const data: GenerativeUIAnswerData = {};
  for (const draft of drafts) {
    if (Object.prototype.hasOwnProperty.call(data, draft.blockId)) {
      issues.push({ blockId: draft.blockId, code: 'duplicate_block' });
      continue;
    }
    const built =
      draft.type === 'choice'
        ? buildChoiceAnswer(draft.blockId, draft.props, draft.state)
        : buildFormAnswer(draft.blockId, draft.props, draft.state);
    data[draft.blockId] = built.answer;
    issues.push(...built.issues);
  }
  if (issues.length > 0) return { ok: false, issues };

  if (countGenuiChars(JSON.stringify(data)) > GENUI_ANSWER_DATA_MAX_CHARS) {
    return { ok: false, issues: [{ blockId: '', code: 'data_too_large' }] };
  }

  const summary = buildGenerativeUIAnswerSummary(drafts, data, options?.labels);
  return { ok: true, payload: { summary, data } };
}
