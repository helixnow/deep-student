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

function isUnsupportedJsonValue(value: unknown): boolean {
  const type = typeof value;
  return type === 'undefined' || type === 'function' || type === 'symbol';
}

/**
 * 计算 JSON 字符串编码长度，逐字符处理 escape，并在超预算后立即停止。
 * 不构造序列化副本，避免 object intent 在 render hot path 额外分配大字符串。
 */
function isJsonStringOverBudget(value: string, consume: (length: number) => boolean): boolean {
  if (consume(2)) return true; // opening + closing quotes

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let encodedLength = 1;

    if (code === 0x22 || code === 0x5c) {
      encodedLength = 2;
    } else if (code <= 0x1f) {
      encodedLength =
        code === 0x08 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0c ||
        code === 0x0d
          ? 2
          : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        encodedLength = 2;
        index += 1;
      } else {
        encodedLength = 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      encodedLength = 6;
    }

    if (consume(encodedLength)) return true;
  }

  return false;
}

/**
 * 判断 JSON-like object 序列化后是否超过 stream cap。
 *
 * 对普通 JSON 数据计算与 JSON.stringify 一致的 UTF-16 长度，但不创建结果字符串；
 * 超限即停止。循环引用、toJSON 和非普通对象无法安全估算，按超限处理，宁可保守拒绝。
 */
export function isSerializedStreamValueOverCap(
  value: unknown,
  maxChars: number = MAX_GENERATIVE_UI_STREAM_CHARS,
): boolean {
  let remaining = maxChars;
  const ancestors = new Set<object>();
  const consume = (length: number): boolean => {
    remaining -= length;
    return remaining < 0;
  };

  const visit = (current: unknown, arrayItem: boolean): boolean => {
    if (current === null) return consume(4);

    switch (typeof current) {
      case 'string':
        return isJsonStringOverBudget(current, consume);
      case 'number':
        return consume(Number.isFinite(current) ? String(current).length : 4);
      case 'boolean':
        return consume(current ? 4 : 5);
      case 'undefined':
      case 'function':
      case 'symbol':
        return arrayItem ? consume(4) : false;
      case 'bigint':
        return true;
      case 'object': {
        if (ancestors.has(current)) return true;

        const isArray = Array.isArray(current);
        const prototype = Object.getPrototypeOf(current);
        if (!isArray && prototype !== Object.prototype && prototype !== null) return true;
        if ('toJSON' in current && typeof current.toJSON === 'function') return true;

        ancestors.add(current);
        if (consume(2)) return true; // [] or {}

        if (isArray) {
          for (let index = 0; index < current.length; index += 1) {
            if (index > 0 && consume(1)) return true;
            if (visit(current[index], true)) return true;
          }
        } else {
          let emittedCount = 0;
          for (const key of Object.keys(current)) {
            const child = (current as Record<string, unknown>)[key];
            if (isUnsupportedJsonValue(child)) continue;
            if (emittedCount > 0 && consume(1)) return true;
            if (isJsonStringOverBudget(key, consume) || consume(1) || visit(child, false)) {
              return true;
            }
            emittedCount += 1;
          }
        }

        ancestors.delete(current);
        return false;
      }
    }
  };

  try {
    return visit(value, false);
  } catch {
    return true;
  }
}

export function withStreamBufferCappedWarning(warnings: string[]): string[] {
  if (warnings.includes(STREAM_BUFFER_CAPPED_WARNING)) return warnings;
  return [...warnings, STREAM_BUFFER_CAPPED_WARNING];
}
