/**
 * Portable error envelopes shared by the desktop skill modules and the mobile host:
 * Rust `{:?}` path rendering and the ChatV2Error JSON `fail()` helper.
 *
 * `files.ts` and `src/mobile/paths.ts` re-export these so both hosts produce identical
 * `Invalid input: …` / `IO error: …` / `Resource not found: …` prefixes.
 */
import { CommandError } from '../../../kernel/api.ts';

export type FailCode = 'INVALID_INPUT' | 'IO_ERROR' | 'RESOURCE_NOT_FOUND';

const PREFIX: Record<FailCode, string> = {
  INVALID_INPUT: 'Invalid input',
  IO_ERROR: 'IO error',
  RESOURCE_NOT_FOUND: 'Resource not found',
};

/** Rust `{:?}` for `Path`/`String`: quotes + control-character escapes. */
export function debugPath(value: string): string {
  return '"' + Array.from(value, c => {
    if (c === '\0') return '\\0';
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    if (c === '"' || c === '\\') return `\\${c}`;
    if (/\p{C}|\p{Zl}|\p{Zp}/u.test(c)) return `\\u{${c.codePointAt(0)!.toString(16)}}`;
    return c;
  }).join('') + '"';
}

/** ChatV2Error JSON envelope; the frontend splits on the `message` prefix. */
export function fail(code: FailCode, message: string): never {
  throw new CommandError(JSON.stringify({ code, message: `${PREFIX[code]}: ${message}` }));
}
