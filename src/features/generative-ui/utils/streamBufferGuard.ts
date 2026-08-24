/**
 * 流式 JSON 硬上限：防止恶意 / 异常超长 payload 撑爆 parser buffer。
 * 按 JS 字符串 UTF-16 code unit 计，256_000 ≈ 256 KiB 量级。
 */

export const MAX_GENERATIVE_UI_STREAM_CHARS = 256_000;

export const STREAM_BUFFER_CAPPED_WARNING = 'stream-buffer-capped';

export interface StreamBufferGuardResult {
  /** 本次允许写入的片段；超限时为空，不截尾窗口 */
  accepted: string;
  capped: boolean;
}

/**
 * 决定本次 chunk 是否可追加。
 * 已达上限或本次会越界则停止增长，整段拒绝，避免半截 JSON 污染 last-good。
 */
export function guardStreamBufferAppend(
  currentLength: number,
  chunk: string,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): StreamBufferGuardResult {
  if (currentLength > maxChars) {
    return { accepted: '', capped: true };
  }
  if (!chunk) {
    return { accepted: '', capped: false };
  }
  if (currentLength + chunk.length > maxChars) {
    return { accepted: '', capped: true };
  }
  return { accepted: chunk, capped: false };
}

export function isStreamBufferOverCap(
  length: number,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): boolean {
  return length > maxChars;
}

export function withStreamBufferCappedWarning(warnings: string[]): string[] {
  if (warnings.includes(STREAM_BUFFER_CAPPED_WARNING)) return warnings;
  return [...warnings, STREAM_BUFFER_CAPPED_WARNING];
}
