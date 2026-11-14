/**
 * serde_json-compatible JSON text parsing for dstu_update payloads.
 *
 * Rust parses translation/exam/essay/essay-session payloads with
 * `serde_json::from_str`, whose syntax failures are surfaced verbatim to the
 * caller. JSON.parse messages differ, so the scanner below reproduces
 * serde_json's reason/line/column text (UTF-8 byte positions) before handing
 * the validated text to JSON.parse.
 */
import { encodeUtf8 } from '../../../platform/util/portable.ts';

export class SerdeJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerdeJsonError';
  }
}

export function parseSerdeJson(text: string): unknown {
  const bytes = encodeUtf8(text);
  let at = 0;
  let depth = 128;
  const error = (reason: string, peek = false): never => {
    const position = Math.min(bytes.length, at + (peek ? 1 : 0));
    const prefix = bytes.subarray(0, position);
    const lastLine = prefix.lastIndexOf(10);
    let line = 1;
    for (const byte of prefix) if (byte === 10) line++;
    throw new SerdeJsonError(`${reason} at line ${line} column ${position - lastLine - 1}`);
  };
  const whitespace = () => {
    while (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 10 || bytes[at] === 13) at++;
  };
  const hex = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = bytes[at++] ?? error('EOF while parsing a string');
      const digit = byte >= 48 && byte <= 57 ? byte - 48
        : byte >= 65 && byte <= 70 ? byte - 55
          : byte >= 97 && byte <= 102 ? byte - 87 : -1;
      if (digit === -1) error('invalid escape');
      value = value * 16 + digit;
    }
    return value;
  };
  const string = () => {
    at++;
    for (;;) {
      const byte = bytes[at++] ?? error('EOF while parsing a string');
      if (byte === 34) return;
      if (byte < 32) error('control character (\\u0000-\\u001F) found while parsing a string');
      if (byte !== 92) continue;
      const escape = bytes[at++] ?? error('EOF while parsing a string');
      if (escape === 117) {
        const code = hex();
        if (code >= 0xdc00 && code <= 0xdfff) error('lone leading surrogate in hex escape');
        if (code >= 0xd800 && code <= 0xdbff) {
          if (bytes[at++] !== 92) error('unexpected end of hex escape');
          if (bytes[at++] !== 117) error('unexpected end of hex escape');
          const trailing = hex();
          if (trailing < 0xdc00 || trailing > 0xdfff) error('lone leading surrogate in hex escape');
        }
      } else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(escape)) error('invalid escape');
    }
  };
  const digit = () => bytes[at] !== undefined && bytes[at]! >= 48 && bytes[at]! <= 57;
  const value = (): void => {
    whitespace();
    const byte = bytes[at];
    if (byte === undefined) error('EOF while parsing a value');
    if (byte === 34) return string();
    if (byte === 110 || byte === 116 || byte === 102) {
      const ident = byte === 110 ? 'null' : byte === 116 ? 'true' : 'false';
      at++;
      for (const expected of encodeUtf8(ident.slice(1))) {
        const actual = bytes[at++];
        if (actual === undefined) error('EOF while parsing a value');
        if (actual !== expected) error('expected ident');
      }
      return;
    }
    if (byte === 91 || byte === 123) {
      if (--depth === 0) error('recursion limit exceeded', true);
      at++;
      whitespace();
      const object = byte === 123;
      const end = object ? 125 : 93;
      if (bytes[at] === end) { at++; depth++; return; }
      for (;;) {
        if (object) {
          if (bytes[at] === undefined) error('EOF while parsing an object');
          if (bytes[at] !== 34) error('key must be a string', true);
          string();
          whitespace();
          const colon = bytes[at++];
          if (colon === undefined) error('EOF while parsing an object');
          if (colon !== 58) error('expected `:`');
        } else if (bytes[at] === undefined) {
          error('EOF while parsing a list');
        }
        value();
        whitespace();
        const next = bytes[at++];
        if (next === end) { depth++; return; }
        if (next === undefined) error(object ? 'EOF while parsing an object' : 'EOF while parsing a list');
        if (next !== 44) error(object ? 'expected `,` or `}`' : 'expected `,` or `]`');
        whitespace();
        if (bytes[at] === end) error('trailing comma', true);
      }
    }
    if (byte === 45 || digit()) {
      if (byte === 45) at++;
      if (bytes[at] === 48) {
        at++;
        if (digit()) error('invalid number', true);
      } else if (digit()) {
        while (digit()) at++;
      } else {
        if (bytes[at] === undefined) error('EOF while parsing a value');
        error('invalid number', true);
      }
      if (bytes[at] === 46) {
        at++;
        if (!digit()) {
          if (bytes[at] === undefined) error('EOF while parsing a value');
          error('invalid number', true);
        }
        while (digit()) at++;
      }
      if (bytes[at] === 69 || bytes[at] === 101) {
        at++;
        if (bytes[at] === 43 || bytes[at] === 45) at++;
        if (!digit()) {
          if (bytes[at] === undefined) error('EOF while parsing a value');
          error('invalid number', true);
        }
        while (digit()) at++;
      }
      return;
    }
    error('expected value', true);
  };
  value();
  whitespace();
  if (at !== bytes.length) error('trailing characters', true);
  return JSON.parse(text) as unknown;
}
