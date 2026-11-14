import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { GeneratedQuestionDraft, GeneratedQuestionOption } from '../api.ts';

// qbank_generation/types.rs:369-393
export function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  let stripped = trimmed;
  if (trimmed.startsWith('```')) {
    stripped = trimmed.replace(/^(?:```json)+/u, '').replace(/^(?:```)+/u, '')
      .replace(/(?:```)+$/u, '').trim();
  }
  if (stripped.startsWith('[')) return stripped;
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  return start >= 0 && start < end && end >= 0 ? stripped.slice(start, end + 1) : null;
}

// qbank_generation/types.rs:411-504
export function validateDraft(draft: GeneratedQuestionDraft): void {
  const supported = ['single_choice', 'multiple_choice', 'indefinite_choice', 'fill_blank', 'short_answer',
    'essay', 'calculation', 'proof', 'true_false', 'other'];
  if (!supported.includes(draft.question_type)) {
    throw new Error(`不支持的题型: ${draft.question_type}（matching/ordering/numeric 请手动创建）`);
  }
  if (!draft.content.trim()) throw new Error('题干为空');
  const answer = draft.answer?.trim();
  if (!answer) throw new Error('缺少答案');

  if (['single_choice', 'multiple_choice', 'indefinite_choice'].includes(draft.question_type)) {
    const options = draft.options?.length ? draft.options : null;
    if (!options) throw new Error('选择题缺少选项');
    if (options.length < 2 || options.length > 6) throw new Error(`选项数量非法: ${options.length}（需 2-6 个）`);
    const seen = new Set<string>();
    for (const option of options) {
      if (!option.key.trim()) throw new Error('存在空选项 key');
      if (!option.content.trim()) throw new Error(`选项 ${option.key} 内容为空`);
      const key = option.key.trim().toUpperCase();
      if (seen.has(key)) throw new Error(`选项 key 重复: ${option.key}`);
      seen.add(key);
    }
    const answerKeys = [...answer.toUpperCase()].filter(char => /^[A-Za-z]$/u.test(char));
    if (!answerKeys.length) throw new Error(`答案格式非法: ${answer}`);
    for (const key of answerKeys) {
      if (!seen.has(key)) throw new Error(`答案 ${key} 不在选项中`);
    }
    if (draft.question_type === 'single_choice' && answerKeys.length > 1) {
      throw new Error('单选题答案包含多个选项');
    }
  } else if (draft.question_type === 'true_false') {
    const lower = answer.toLowerCase();
    if (lower !== 'true' && lower !== 'false') {
      throw new Error(`判断题答案必须是 true/false，收到: ${answer}`);
    }
  }

  const smiles = draft.smiles?.trim();
  if (smiles) {
    validateSmiles(smiles);
  } else if (draft.smiles_caption != null) {
    throw new Error('给出了 smiles_caption 但缺少 smiles');
  }
}

// qbank_generation/types.rs:506-534
export function validateSmiles(smiles: string): void {
  const allowed = 'BCNOPSFIHbcnops#%+-=()[]@/\\.$0123456789:';
  const length = utf8ByteLength(smiles);
  if (length > 256) throw new Error(`SMILES 过长（${length} 字符）`);
  for (const char of smiles) {
    if (!allowed.includes(char)) throw new Error(`SMILES 含非法字符 '${char}'：${smiles}`);
  }
  let stack = 0;
  for (const char of smiles) {
    if (char === '(') stack++;
    else if (char === ')') {
      if (stack === 0) throw new Error(`SMILES 括号不配对: ${smiles}`);
      stack--;
    }
  }
  if (stack !== 0) throw new Error(`SMILES 括号不配对: ${smiles}`);
}

// qbank_generation/types.rs:545-587
export function normalizeEscapedText(text: string): string {
  if (!text.includes('\\n') && !text.includes('\\t') && !text.includes('\\r')) return text;
  const chars = [...text];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '\\' && i + 1 < chars.length) {
      const next = chars[i + 1]!;
      const afterIsAsciiAlpha = i + 2 < chars.length && /^[A-Za-z]$/u.test(chars[i + 2]!);
      if (!afterIsAsciiAlpha) {
        if (next === 'r' && chars[i + 2] === '\\' && chars[i + 3] === 'n') {
          out += '\n';
          i += 4;
          continue;
        }
        if (next === 'r' || next === 'n') {
          out += '\n';
          i += 2;
          continue;
        }
        if (next === 't') {
          out += '\t';
          i += 2;
          continue;
        }
      }
    }
    out += chars[i];
    i++;
  }
  return out;
}

function normalizeDraftText(draft: GeneratedQuestionDraft): void {
  draft.content = normalizeEscapedText(draft.content);
  if (draft.explanation != null) draft.explanation = normalizeEscapedText(draft.explanation);
  if (draft.answer != null) draft.answer = normalizeEscapedText(draft.answer);
  if (draft.options) {
    for (const option of draft.options) option.content = normalizeEscapedText(option.content);
  }
}

const SERDE_DESCRIPTION: Record<string, string> = {
  string: 'a string', boolean: 'a boolean', number: 'a number', array: 'a sequence', object: 'a map',
};

function serdeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'number') return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  return SERDE_DESCRIPTION[typeof value] ?? typeof value;
}

function readString(input: Record<string, unknown>, key: string, required: boolean): string | null {
  const value = input[key];
  if (value == null) {
    if (required) throw new Error(`missing field \`${key}\``);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`invalid type: ${serdeType(value)}, expected a string`);
  return value;
}

function decodeOption(input: Record<string, unknown>): GeneratedQuestionOption[] | null {
  const value = input.options;
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error(`invalid type: ${serdeType(value)}, expected a sequence`);
  return value.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`invalid type: ${serdeType(item)}, expected struct GeneratedQuestionOption`);
    }
    const record = item as Record<string, unknown>;
    return { key: readString(record, 'key', true)!, content: readString(record, 'content', true)! };
  });
}

/** json -> GeneratedQuestionDraft, mirroring the serde derives at types.rs:82-126. */
export function decodeDraft(item: unknown): GeneratedQuestionDraft {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`invalid type: ${serdeType(item)}, expected struct GeneratedQuestionDraft`);
  }
  const input = item as Record<string, unknown>;
  const tags = input.tags;
  if (tags != null && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) {
    throw new Error('invalid type: expected a sequence of strings');
  }
  return {
    ...(input.local_id == null ? {} : { local_id: readString(input, 'local_id', false) }),
    ...(input.group_id == null ? {} : { group_id: readString(input, 'group_id', false) }),
    ...(input.original_label == null ? {} : { original_label: readString(input, 'original_label', false) }),
    question_type: readString(input, 'question_type', true)!,
    content: readString(input, 'content', true)!,
    options: decodeOption(input),
    answer: readString(input, 'answer', false),
    explanation: readString(input, 'explanation', false),
    difficulty: readString(input, 'difficulty', false),
    tags: tags == null ? null : tags as string[],
    ...(input.structured_data == null ? {} : { structured_data: input.structured_data }),
    smiles: readString(input, 'smiles', false),
    smiles_caption: readString(input, 'smiles_caption', false),
    ...(input.source_ref == null ? {} : { source_ref: readString(input, 'source_ref', false) }),
  };
}

export interface ParsedGenerationResponse {
  exam_id: string;
  document: null;
  job_id: string;
  version: number;
  model_route: null;
  drafts: GeneratedQuestionDraft[];
  rejected_count: number;
  rejection_reasons: string[];
  skipped_references: never[];
  used_reference_count: number;
}

// qbank_generation/types.rs:623-678
export function parseGenerationOutput(raw: string, maxQuestions: number): ParsedGenerationResponse {
  const jsonText = extractJsonArray(raw);
  if (jsonText === null) throw new Error('输出中没有找到 JSON 数组');
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('JSON 解析失败: invalid type: expected a sequence');
  if (!parsed.length) throw new Error('模型返回了空数组，未生成任何题目');

  const drafts: GeneratedQuestionDraft[] = [];
  const reasons: string[] = [];
  for (const [index, item] of parsed.entries()) {
    if (drafts.length >= maxQuestions) {
      reasons.push(`第 ${index + 1} 题起超过题量上限 ${maxQuestions}，已截断`);
      break;
    }
    let draft: GeneratedQuestionDraft;
    try {
      draft = decodeDraft(item);
    } catch (error) {
      reasons.push(`第 ${index + 1} 题结构不符合契约：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    normalizeDraftText(draft);
    try {
      validateDraft(draft);
      drafts.push(draft);
    } catch (error) {
      reasons.push(`第 ${index + 1} 题被剔除：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    exam_id: '', document: null, job_id: '', version: 0, model_route: null, rejected_count: reasons.length,
    rejection_reasons: reasons, drafts, skipped_references: [], used_reference_count: 0,
  };
}
