import { JsonSyntaxError, parseJsonDocument, type JsonNode } from '../../../platform/util/json-exact.ts';
import { jsonNumberToRawJSON } from '../../../platform/util/json-value.ts';

/** note_transfer_repo.rs::decode: serde_json syntax and UTF-8 byte positions. */
export class NoteSerializationError extends Error {}

export function decodeJson(text: string, uniqueRootFields: readonly string[] = []): unknown {
  validateJson(text, uniqueRootFields);
  return JSON.parse(text) as unknown;
}

function exactValue(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool':
    case 'string': return node.value;
    case 'number': return jsonNumberToRawJSON(node.value);
    case 'array': return node.items.map(exactValue);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const { key, value } of node.members) {
        Object.defineProperty(out, key, { value: exactValue(value), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

/**
 * serde_json::Value under dstu-vfs `arbitrary_precision` (Cargo.toml:50): same
 * errors as decodeJson, but numbers are raw JSON atoms so JSON.stringify writes
 * the original digits back. Persistence-only; not an IPC/domain DTO.
 */
export function decodeJsonExact(text: string): unknown {
  validateJson(text, []);
  try {
    return exactValue(parseJsonDocument(text));
  } catch (error) {
    if (error instanceof JsonSyntaxError) throw new NoteSerializationError(error.message);
    throw error;
  }
}

function validateJson(text: string, uniqueRootFields: readonly string[]): void {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  let depth = 128;
  const seenRootFields = new Set<string>();
  const error = (reason: string, peek = false): never => {
    const position = Math.min(bytes.length, at + (peek ? 1 : 0));
    const prefix = bytes.subarray(0, position);
    const lastLine = prefix.lastIndexOf(10);
    let line = 1;
    for (const byte of prefix) if (byte === 10) line++;
    throw new NoteSerializationError(`${reason} at line ${line} column ${position - lastLine - 1}`);
  };
  const whitespace = () => {
    while (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 10 || bytes[at] === 13) at++;
  };
  const hex = (): number => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = bytes[at++] ?? error('EOF while parsing a string');
      const digit = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
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
      for (const expected of new TextEncoder().encode(ident.slice(1))) {
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
          const keyStart = at;
          string();
          // serde struct deserialization rejects repeated known fields; unlike
          // serde_json::Value, it does not silently keep the final value.
          if (depth === 127 && uniqueRootFields.length > 0) {
            const key: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(keyStart, at)));
            if (typeof key === 'string' && uniqueRootFields.includes(key)) {
              if (seenRootFields.has(key)) error(`duplicate field \`${key}\``);
              seenRootFields.add(key);
            }
          }
          whitespace();
          const colon = bytes[at++];
          if (colon === undefined) error('EOF while parsing an object');
          if (colon !== 58) error('expected `:`');
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
}
