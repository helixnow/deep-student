// serde_json::from_str::<Value> input rules that JSON.parse does not enforce. The grammar
// (RFC 8259, whitespace set, no trailing commas) is identical, so JSON.parse decides syntax and
// this module adds serde_json's extra rejections (de.rs parse_escape / check_recursion):
//   - `\uD800`-`\uDBFF` not followed by `\u` + `\uDC00`-`\uDFFF`, or a bare `\uDC00`-`\uDFFF`;
//   - nesting reaching serde_json's remaining_depth of 128 (127 levels are accepted).
// Syntax error texts stay V8's. These two categories use serde_json's wording; the line/column
// suffix follows StrRead byte columns but is not verified against Rust output.
import type { JsonValue } from '../api.ts';

export type SerdeJsonResult = { ok: true; value: JsonValue } | { ok: false; message: string };

const RECURSION_LIMIT = 128;

function position(text: string, index: number): string {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) { line += 1; lineStart = i + 1; }
  }
  const column = Buffer.byteLength(text.slice(lineStart, index), 'utf8');
  return `at line ${line} column ${column}`;
}

function hexAt(text: string, index: number): number | null {
  const digits = text.slice(index, index + 4);
  return /^[0-9a-fA-F]{4}$/u.test(digits) ? Number.parseInt(digits, 16) : null;
}

function serdeOnlyViolation(text: string): string | null {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x22) {
      for (i += 1; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c === 0x22) break;
        if (c !== 0x5c) continue;
        if (text.charCodeAt(i + 1) !== 0x75) { i += 1; continue; }
        const unit = hexAt(text, i + 2);
        if (unit === null) return null;
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          return `lone leading surrogate in hex escape ${position(text, i + 6)}`;
        }
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text.charCodeAt(i + 6) !== 0x5c || text.charCodeAt(i + 7) !== 0x75) {
            return `unexpected end of hex escape ${position(text, i + 7)}`;
          }
          const low = hexAt(text, i + 8);
          if (low === null) return null;
          if (low < 0xdc00 || low > 0xdfff) {
            return `lone leading surrogate in hex escape ${position(text, i + 12)}`;
          }
          i += 11;
          continue;
        }
        i += 5;
      }
    } else if (ch === 0x5b || ch === 0x7b) {
      depth += 1;
      if (depth >= RECURSION_LIMIT) return `recursion limit exceeded ${position(text, i + 1)}`;
    } else if (ch === 0x5d || ch === 0x7d) {
      depth -= 1;
    }
  }
  return null;
}

/** `serde_json::from_str::<serde_json::Value>(text)`. */
export function parseSerdeJson(text: string): SerdeJsonResult {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  const violation = serdeOnlyViolation(text);
  if (violation !== null) return { ok: false, message: violation };
  return { ok: true, value: value as JsonValue };
}

/** `serde_json::from_slice::<Value>(bytes)` (reqwest `Response::json`): invalid UTF-8 is an error, a BOM is not skipped. */
export function parseSerdeJsonBytes(bytes: Uint8Array): SerdeJsonResult {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, message: 'invalid unicode code point' }; }
  return parseSerdeJson(text);
}
