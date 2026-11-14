/**
 * 流式切卡状态机（`extract_card_from_buffer_impl`）。
 */
import { rustTrim, rustTrimStart, utf8ByteLength } from '../../../platform/util/index.ts';
import { BROKEN_DELIMITER_TAIL, CARD_DELIMITER } from './anki-protocol.ts';
import type { AnkiLogger } from './logger.ts';
import { jsonFragmentBalanced } from './streaming-anki-fields.ts';
import { CARD_BUFFER_HARD_LIMIT } from './streaming-anki-protocol.ts';


/** 流式收尾残留 payload（`expandWrapperPayloads`）。 */
export interface ResidualCardPayload {
  json: string;
  truncated: boolean;
}
// ============================================================================
// 流式切卡状态机（`extract_card_from_buffer_impl`）
// ============================================================================

export type ExtractCardResult = { ok: true; card: string } | { ok: false; truncated: string };

/** 损坏分隔符修复（`extract_card_from_buffer_impl` 的辅助信号）。 */
export function extractCardFromBufferImpl(
  buffer: { text: string },
  logger: Pick<AnkiLogger, 'warn'> = { warn() {} },
): ExtractCardResult | null {
  const text = buffer.text;
  let inString = false;
  let escape = false;
  let depth = 0;
  let objStart = -1;

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }

    if (ch === '<' && text.startsWith(CARD_DELIMITER, i)) {
      const cardContent = rustTrim(text.slice(0, i));
      buffer.text = text.slice(i + CARD_DELIMITER.length);
      return cardContent === '' ? null : { ok: true, card: cardContent };
    }

    if (ch === 'A' && text.startsWith(BROKEN_DELIMITER_TAIL, i)) {
      const start = text.slice(0, i).lastIndexOf('<<<');
      if (start >= 0) {
        const cardContent = rustTrim(text.slice(0, start));
        const endPos = i + BROKEN_DELIMITER_TAIL.length;
        buffer.text = text.slice(endPos);
        logger.warn('[ANKI_CARD_DEBUG] 检测到损坏的分隔符，已自动修复');
        return cardContent === '' ? null : { ok: true, card: cardContent };
      }
    }

    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const cardContent = text.slice(objStart, i + 1);
        let restStart = i + 1;
        const rest = text.slice(restStart);
        const trimmed = rustTrimStart(rest);
        const wsLen = rest.length - trimmed.length;
        if (trimmed.startsWith(CARD_DELIMITER)) {
          restStart += wsLen + CARD_DELIMITER.length;
        } else if (trimmed.startsWith('<<<')) {
          const tailPos = trimmed.indexOf(BROKEN_DELIMITER_TAIL);
          if (tailPos >= 0) {
            const between = trimmed.slice(3, tailPos);
            if ([...between].every((c) => /\s/u.test(c) || c === '<')) {
              restStart += wsLen + tailPos + BROKEN_DELIMITER_TAIL.length;
            }
          }
        }
        buffer.text = text.slice(restStart);
        return { ok: true, card: cardContent };
      }
    }
    i += 1;
  }

  return checkBufferHardLimit(buffer, logger);
}

export function checkBufferHardLimit(
  buffer: { text: string },
  logger: Pick<AnkiLogger, 'warn'> = { warn() {} },
): ExtractCardResult | null {
  const bytes = utf8ByteLength(buffer.text);
  if (bytes > CARD_BUFFER_HARD_LIMIT) {
    logger.warn(
      `[ANKI_CARD_DEBUG] 卡片缓冲超过硬上限 ${CARD_BUFFER_HARD_LIMIT} 字节（当前 ${bytes} 字节）仍未出现分隔符，判为异常截断`,
    );
    const truncated = buffer.text;
    buffer.text = '';
    return { ok: false, truncated };
  }
  return null;
}
