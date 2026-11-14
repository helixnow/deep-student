/**
 * 文档分段的 Rust 语义工具与日志端口。
 *
 * 常量/日志状态供 segment/overlap/main 共享，避免循环依赖。
 */
import type { AnkiLogger } from './logger.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const DEFAULT_MAX_TOKENS_PER_SEGMENT = 10_000;

/**
 * 每段预算下限。防止调用方传入 `max_tokens=0` 之类的值把预算压成 0，
 * 旧实现会因此在 `splitByCharacters` 中死循环（`max_chars=0` 时 `start` 永不前进）。
 */
export const MIN_TOKENS_PER_SEGMENT = 256;

/** 句末标点集合（中英文），用于句子切分与边界吸附。 */
export const SENTENCE_ENDS: readonly string[] = ['.', '!', '?', '。', '！', '？'];

export const SENTENCE_END_SET = new Set(SENTENCE_ENDS);

/** 插件入口注入的日志端口（Rust `println!("[DOCUMENT_DEBUG] …")`）。 */
let configuredLogger: AnkiLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** 插件入口在加载时调用：把文档分段调试日志接到宿主日志。 */
export function configureDocumentProcessingLogger(logger: AnkiLogger): void {
  configuredLogger = logger;
}

export function debugLog(message: string): void {
  configuredLogger.debug(message);
}

/** `AnkiGenerationOptions.segment_overlap_size` 的 serde 默认值。 */
export const DEFAULT_SEGMENT_OVERLAP_SIZE = 200;

// =====================================================================
// Rust 标准库语义工具
// =====================================================================

export const F32_1_3 = Math.fround(1.3);
export const F32_0_2 = Math.fround(0.2);

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** `{:?}` 形式的 `Option<u32>`（调试日志用）。 */
export function debugOption(value: number | null | undefined): string {
  return value === null || value === undefined ? 'None' : `Some(${value})`;
}

/** Rust `String::len()`（UTF-8 字节数）。 */
export function utf8Length(value: string): number {
  return utf8ByteLength(value);
}

/** Rust `str::lines`：按 `\n` 分割，去掉每行末尾的 `\r`，末行换行可选。 */
export function rustLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part));
}

/** Rust `str::split_inclusive(&SENTENCE_ENDS[..])`。 */
export function splitInclusiveSentenceEnds(text: string): string[] {
  const pieces: string[] = [];
  let buffer = '';
  for (const ch of text) {
    buffer += ch;
    if (SENTENCE_END_SET.has(ch)) {
      pieces.push(buffer);
      buffer = '';
    }
  }
  if (buffer !== '') {
    pieces.push(buffer);
  }
  return pieces;
}

export function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const found = text.indexOf(needle, from);
    if (found < 0) return count;
    count += 1;
    from = found + needle.length;
  }
}

/** 字符索引（码点）→ 该位置之前字符的 UTF-8 字节数。 */
export function byteIndexAtCharIndex(text: string, charIndex: number): number {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    if (index >= charIndex) break;
    bytes += utf8Length(ch);
    index += 1;
  }
  return bytes;
}

/** `prefix.rfind(&SENTENCE_ENDS[..])` 的字节索引；无命中返回 null。 */
export function lastSentenceEndByteIndex(text: string): number | null {
  let lastCharIndex: number | null = null;
  let index = 0;
  for (const ch of text) {
    if (SENTENCE_END_SET.has(ch)) lastCharIndex = index;
    index += 1;
  }
  if (lastCharIndex === null) return null;
  return byteIndexAtCharIndex(text, lastCharIndex);
}

/** `suffix.find(&SENTENCE_ENDS[..])` 的字节索引；无命中返回 null。 */
export function firstSentenceEndByteIndex(text: string): number | null {
  let index = 0;
  for (const ch of text) {
    if (SENTENCE_END_SET.has(ch)) return byteIndexAtCharIndex(text, index);
    index += 1;
  }
  return null;
}

/** `prefix.rfind("\n\n")` 的字节索引；无命中返回 null。 */
export function lastParagraphStartByteIndex(text: string): number | null {
  const index = text.lastIndexOf('\n\n');
  if (index < 0) return null;
  return utf8Length(text.slice(0, index));
}

/** `suffix.find("\n\n")` 的字节索引；无命中返回 null。 */
export function firstParagraphStartByteIndex(text: string): number | null {
  const index = text.indexOf('\n\n');
  if (index < 0) return null;
  return utf8Length(text.slice(0, index));
}

/**
 * `f64::from_str` 的语法（`cell.parse::<f64>().is_ok()`）：十进制数、
 * `inf`/`infinity`/`nan`（大小写不敏感）；不接受十六进制、下划线。
 */
export function isRustFloat(text: string): boolean {
  return /^[+-]?(?:inf(?:inity)?|nan|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$/i.test(
    text,
  );
}
