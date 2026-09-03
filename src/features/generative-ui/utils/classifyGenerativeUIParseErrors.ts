/**
 * 将 parseGenerativeUIIntent / Zod 错误字符串映射为稳定 code。
 * 供模型反馈与 telemetry 使用；不抛异常、不改原始 message。
 */

export type GenerativeUIParseErrorCode =
  | 'invalid-json'
  | 'invalid-shape'
  | 'unknown-version'
  | 'too-many-blocks'
  | 'invalid-block'
  | 'buffer-capped'
  | 'unknown';

export interface ClassifiedGenerativeUIParseError {
  code: GenerativeUIParseErrorCode;
  message: string;
}

function classifyCode(message: string): GenerativeUIParseErrorCode {
  const haystack = message.toLowerCase();

  if (haystack.includes('invalid json') || haystack.includes('json.parse')) {
    return 'invalid-json';
  }

  if (haystack.includes('stream-buffer-capped') || haystack.includes('buffer-capped')) {
    return 'buffer-capped';
  }

  if (
    haystack.includes('version') &&
    (haystack.includes('invalid enum') ||
      haystack.includes('invalid_enum') ||
      haystack.includes('enum') ||
      haystack.includes('invalid option'))
  ) {
    return 'unknown-version';
  }

  if (
    haystack.includes('blocks') &&
    (haystack.includes('too_big') ||
      haystack.includes('too big') ||
      haystack.includes('max') ||
      haystack.includes('32'))
  ) {
    return 'too-many-blocks';
  }

  if (
    haystack.includes('blocks') &&
    (haystack.includes('required') ||
      haystack.includes('expected array') ||
      haystack.includes('array'))
  ) {
    return 'invalid-shape';
  }

  if (haystack.includes('type') || haystack.includes('span') || haystack.includes('props')) {
    return 'invalid-block';
  }

  return 'unknown';
}

function asMessage(error: unknown): string {
  return typeof error === 'string' ? error : String(error ?? '');
}

export function classifyGenerativeUIParseErrors(
  errors: readonly string[] | null | undefined,
): ClassifiedGenerativeUIParseError[] {
  try {
    if (errors == null || !Array.isArray(errors) || errors.length === 0) {
      return [];
    }
    return errors.map((error) => {
      const message = asMessage(error);
      return { code: classifyCode(message), message };
    });
  } catch {
    return [];
  }
}
