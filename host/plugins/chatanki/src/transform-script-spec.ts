// Rust: src/chat_v2/tools/chatanki_transform_script.rs — 资源边界、参数归一化与输入合同。
import type { AnkiCard } from '../api.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import {
  deserializeSerdeStruct, serdeOption, serdeString, serdeU64, serdeUnitEnum, type SerdeStructField,
} from './serde-struct.ts';

// ============================================================================
// 资源边界（对齐调研报告 §6）
// ============================================================================

/** 脚本正文长度上限（JSON Schema maxLength 同值，按 Unicode 标量计）。 */
export const CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS = 65_536;
export const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS = 120_000;
export const CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS = 30_000;
/** `CHATANKI_OUTPUT.json` 文件大小上限。 */
export const CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
/** stdout / stderr 各自最多从管道消费的字节数。 */
export const CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES = 1024 * 1024;
/** stdout / stderr 各自进入工具返回值的日志尾部字节数。 */
export const CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES = 16 * 1024;
/** transform script 接受的平台后端进程数上限（RLIMIT_NPROC 2048）。 */
export const CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX = 2_048;
/** 脚本回传的单卡 tags 数上限（宽于 ops 单 op 的 50）。 */
export const CHATANKI_TRANSFORM_SCRIPT_TAGS_LIMIT = 100;
/** 脚本**新写入**的单字段（front/back/text）字符数上限。 */
export const CHATANKI_TRANSFORM_SCRIPT_FIELD_MAX_CHARS = 100_000;
/** 脚本**新写入**的单个 tag 字符数上限。 */
export const CHATANKI_TRANSFORM_SCRIPT_TAG_MAX_CHARS = 4_096;
/** 输出 `cards` 数组条目数硬上限：2 * CHATANKI_TRANSFORM_CARD_LIMIT（500）。 */
export const CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_ENTRIES = 1_000;
/** 输出条目 `id` 字符数上限。 */
export const CHATANKI_TRANSFORM_SCRIPT_ID_MAX_CHARS = 128;
/** 逐卡拒绝 detail 中回显脚本自报内容的截断长度。 */
export const SCRIPT_ISSUE_ECHO_MAX_CHARS = 64;
/** 超时杀进程组后等待收尸 / 排空管道的宽限期。 */
export const SCRIPT_CLEANUP_GRACE_MS = 5_000;

export const CHATANKI_INPUT_FILE = 'CHATANKI_INPUT.json';
export const CHATANKI_OUTPUT_FILE = 'CHATANKI_OUTPUT.json';

// ============================================================================
// 参数（wire 形态 → 归一化）
// ============================================================================

export type ScriptLanguage = 'python' | 'node';

export interface NormalizedTransformScript {
  language: ScriptLanguage;
  code: string;
  timeoutMs: number;
}

/** chatanki_transform_script.rs:122-128 `TransformScriptSpec` after serde, before `normalize`. */
export interface TransformScriptSpec {
  language: ScriptLanguage;
  code: string;
  timeoutMs: number | null;
}

const SCRIPT_SPEC_FIELDS: readonly SerdeStructField[] = [
  { name: 'language', read: serdeUnitEnum<ScriptLanguage>(['python', 'node']) },
  { name: 'code', read: serdeString },
  { name: 'timeoutMs', option: true, read: serdeOption(serdeU64) },
];

/** 按 Unicode 标量计长（Rust `chars().count()`）。 */
export function charCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** serde phase of `TransformScriptSpec` (deny_unknown_fields, camelCase). */
export function decodeScriptSpec(raw: unknown): TransformScriptSpec {
  const [language, code, timeoutMs] = deserializeSerdeStruct(raw, 'TransformScriptSpec', SCRIPT_SPEC_FIELDS, true);
  return {
    language: language as ScriptLanguage,
    code: code as string,
    timeoutMs: timeoutMs === undefined || timeoutMs === null ? null : Number(timeoutMs as number | bigint),
  };
}

/** `TransformScriptSpec` 的 serde 解析 + `normalize`，错误文本与 Rust 对齐。 */
export function normalizeScriptSpec(raw: unknown): NormalizedTransformScript {
  return normalizeDecodedScriptSpec(decodeScriptSpec(raw));
}

/** chatanki_transform_script.rs:137-166 `TransformScriptSpec::normalize`. */
export function normalizeDecodedScriptSpec(spec: TransformScriptSpec): NormalizedTransformScript {
  const { language, code } = spec;
  const timeoutMs = spec.timeoutMs ?? CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_DEFAULT_MS;
  if (rustTrim(code).length === 0) throw new Error('transform.script.code must not be empty');
  if (charCount(code) > CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS) {
    throw new Error(
      `transform.script.code exceeds ${CHATANKI_TRANSFORM_SCRIPT_CODE_MAX_CHARS} characters`,
    );
  }
  if (timeoutMs < CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS
    || timeoutMs > CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS) {
    throw new Error(
      `transform.script.timeoutMs must be within ${CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MIN_MS}` +
      `..=${CHATANKI_TRANSFORM_SCRIPT_TIMEOUT_MAX_MS} milliseconds`,
    );
  }
  return { language, code, timeoutMs };
}

export function interpreterCandidates(language: ScriptLanguage): readonly string[] {
  return language === 'python' ? ['python3', 'python'] : ['node'];
}

export function scriptFileName(language: ScriptLanguage): string {
  return language === 'python' ? 'transform_script.py' : 'transform_script.js';
}

// ============================================================================
// 输入合同（$CHATANKI_INPUT）
// ============================================================================

export interface ScriptInputCard {
  id: string;
  index: number;
  front: string;
  back: string;
  text: string | null;
  tags: string[];
  templateId: string | null;
  extraFields: Record<string, string>;
  version: string;
}

export interface ScriptInput {
  documentId: string;
  cards: ScriptInputCard[];
}

/** 构造脚本输入 JSON；字段全文出自 DB 快照，version = updated_at（CAS 只认 Rust 侧记录）。 */
export function buildScriptInput(documentId: string, cards: readonly AnkiCard[]): ScriptInput {
  return {
    documentId,
    cards: cards.map((card, index) => ({
      id: card.id,
      index: index + 1,
      front: card.front,
      back: card.back,
      text: card.text,
      tags: [...card.tags],
      templateId: card.template_id,
      extraFields: { ...card.extra_fields },
      version: card.updated_at,
    })),
  };
}

