/** iLink's serde structs (client.rs:17-83), including token widths and duplicate fields.
 * Token scanning follows serde_json 1.0.149 de.rs/read.rs; retain locations/order
 * and integer tokens that JSON.parse alone discards.
 */
import type { IlinkCredentials, QrcodeResponse, QrcodeStatusResponse, GetUpdatesResponse } from './client.ts';
import type { PluginJsonValue } from '../../../kernel/plugin-types.ts';
import { unexpectedOf } from '../../../kernel/serde.ts';
import { utf8Encode } from '../../../platform/crypto/encoding.ts';

interface Token {
  start: number;
  end: number;
  value: unknown;
  text: string;
  fields?: { key: string; keyEnd: number; token: Token }[];
  items?: Token[];
}
type Shape = 'string' | 'i32' | 'i64' | 'u64' | { optional: Shape } | { vector: Shape } | { map: Shape } | { name: string; fields: Record<string, Field> };
interface Field { shape: Shape; default?: () => unknown }
const field = (shape: Shape): Field => ({ shape });
const optional = (shape: Shape): Field => field({ optional: shape });
const textItem: Shape = { name: 'TextItem', fields: { text: optional('string') } };
const messageItem: Shape = { name: 'MessageItem', fields: { type: optional('i32'), text_item: optional(textItem) } };
const vector = (shape: Shape): Field => ({ shape: { vector: shape }, default: () => [] });
const message: Shape = { name: 'WeixinMessage', fields: {
  seq: optional('u64'), message_id: optional('u64'), from_user_id: optional('string'), to_user_id: optional('string'),
  client_id: optional('string'), create_time_ms: optional('u64'), session_id: optional('string'),
  message_type: optional('i32'), message_state: optional('i32'), context_token: optional('string'), item_list: vector(messageItem),
} };
const shapes: Record<string, Shape> = {
  credentials: { name: 'IlinkCredentials', fields: {
    token: field('string'), baseUrl: field('string'), accountId: field('string'), userId: field('string'),
    getUpdatesBuf: { shape: 'string', default: () => '' }, contextTokens: { shape: { map: 'string' }, default: () => ({}) },
  } },
  qrcode: { name: 'QrcodeResponse', fields: { qrcode: field('string'), qrcode_img_content: field('string') } },
  status: { name: 'QrcodeStatusResponse', fields: {
    status: field('string'), bot_token: optional('string'), ilink_bot_id: optional('string'), ilink_user_id: optional('string'), baseurl: optional('string'),
  } },
  updates: { name: 'GetUpdatesResponse', fields: {
    ret: optional('i64'), errcode: optional('i64'), errmsg: optional('string'), msgs: vector(message),
    get_updates_buf: optional('string'), longpolling_timeout_ms: optional('u64'),
  } },
};

function tokenTree(text: string, fail: (message: string, position: number) => never): Token {
  let offset = 0;
  const space = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? '\0')) offset++; };
  const peekFail = (message: string): never => fail(message, Math.min(offset + 1, text.length));
  const hex = (): number => {
    const start = offset;
    for (let i = 0; i < 4; i++) {
      if (offset === text.length) return fail('EOF while parsing a string', offset);
      if (!/[0-9a-fA-F]/.test(text[offset++]!)) return fail('invalid escape', offset);
    }
    return parseInt(text.slice(start, offset), 16);
  };
  const string = (): string => {
    const start = offset++;
    while (text[offset] !== '"') {
      if (offset === text.length) return fail('EOF while parsing a string', offset);
      const char = text[offset++]!;
      if (char.charCodeAt(0) < 32) return fail('control character (\\u0000-\\u001F) found while parsing a string', offset);
      if (char !== '\\') continue;
      if (offset === text.length) return fail('EOF while parsing a string', offset);
      const escape = text[offset++]!;
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== 'u') return fail('invalid escape', offset);
      const first = hex();
      if (first >= 0xdc00 && first <= 0xdfff) return fail('lone leading surrogate in hex escape', offset);
      if (first >= 0xd800 && first <= 0xdbff) {
        for (const expected of ['\\', 'u']) {
          if (offset === text.length) return fail('EOF while parsing a string', offset);
          if (text[offset++] !== expected) return fail('unexpected end of hex escape', offset);
        }
        const second = hex();
        if (second < 0xdc00 || second > 0xdfff) return fail('lone leading surrogate in hex escape', offset);
      }
    }
    offset++;
    const value: unknown = JSON.parse(text.slice(start, offset));
    if (typeof value !== 'string') throw new TypeError('expected a string token');
    return value;
  };
  const number = (): string => {
    const start = offset;
    if (text[offset] === '-') offset++;
    if (offset === text.length) return fail('EOF while parsing a value', offset);
    if (text[offset] === '0') {
      offset++;
      if (/\d/.test(text[offset] ?? '')) return peekFail('invalid number');
    } else {
      if (!/[1-9]/.test(text[offset] ?? '')) return peekFail('invalid number');
      while (/\d/.test(text[offset] ?? '')) offset++;
    }
    if (text[offset] === '.') {
      offset++;
      if (!/\d/.test(text[offset] ?? '')) return peekFail(offset === text.length ? 'EOF while parsing a value' : 'invalid number');
      while (/\d/.test(text[offset] ?? '')) offset++;
    }
    if (text[offset] === 'e' || text[offset] === 'E') {
      offset++;
      if (text[offset] === '+' || text[offset] === '-') offset++;
      if (!/\d/.test(text[offset] ?? '')) return peekFail(offset === text.length ? 'EOF while parsing a value' : 'invalid number');
      while (/\d/.test(text[offset] ?? '')) offset++;
    }
    return text.slice(start, offset);
  };
  const node = (depth = 0): Token => {
    space();
    const start = offset;
    let value: unknown;
    let fields: Token['fields'], items: Token['items'];
    if (text[offset] === '{') {
      if (depth >= 127) return peekFail('recursion limit exceeded');
      fields = []; offset++; space();
      while (text[offset] !== '}') {
        if (offset === text.length) return fail('EOF while parsing an object', offset);
        if (text[offset] !== '"') return peekFail('key must be a string');
        const key = string(), keyEnd = offset;
        space();
        if (text[offset] !== ':') return peekFail(offset === text.length ? 'EOF while parsing an object' : 'expected `:`');
        offset++;
        fields.push({ key, keyEnd, token: node(depth + 1) });
        space(); if (text[offset] === '}') break;
        if (text[offset] !== ',') return peekFail(offset === text.length ? 'EOF while parsing an object' : 'expected `,` or `}`');
        offset++; space();
        if (text[offset] === '}') return peekFail('trailing comma');
      }
      offset++; value = {};
    } else if (text[offset] === '[') {
      if (depth >= 127) return peekFail('recursion limit exceeded');
      items = []; offset++; space();
      while (text[offset] !== ']') {
        if (offset === text.length) return fail('EOF while parsing a list', offset);
        items.push(node(depth + 1)); space(); if (text[offset] === ']') break;
        if (text[offset] !== ',') return peekFail(offset === text.length ? 'EOF while parsing a list' : 'expected `,` or `]`');
        offset++; space();
        if (text[offset] === ']') return peekFail('trailing comma');
      }
      offset++; value = [];
    } else if (text[offset] === '"') value = string();
    else if (/[-0-9]/.test(text[offset] ?? '')) {
      const raw = number();
      value = /^-?\d+$/.test(raw) && raw !== '-0' ? BigInt(raw) : JSON.parse(raw);
    } else {
      const literal = text[offset] === 'n' ? 'null' : text[offset] === 't' ? 'true' : text[offset] === 'f' ? 'false' : null;
      if (!literal) return peekFail(offset === text.length ? 'EOF while parsing a value' : 'expected value');
      for (const char of literal) {
        if (offset === text.length) return fail('EOF while parsing a value', offset);
        if (text[offset++] !== char) return fail('expected ident', offset);
      }
      value = literal === 'null' ? null : literal === 'true';
    }
    return { start, end: offset, text: text.slice(start, offset), value, ...(fields ? { fields } : {}), ...(items ? { items } : {}) };
  };
  const root = node(); space();
  if (offset !== text.length) return peekFail('trailing characters');
  return root;
}

export function decodeIlink(text: string, kind: 'credentials'): IlinkCredentials;
export function decodeIlink(text: string, kind: 'qrcode'): QrcodeResponse;
export function decodeIlink(text: string, kind: 'status'): QrcodeStatusResponse;
export function decodeIlink(text: string, kind: 'updates'): GetUpdatesResponse;
export function decodeIlink(text: string, kind: 'reply'): { value: PluginJsonValue; ret: number | bigint | null; errcode: number | bigint | null; display: string };
export function decodeIlink(text: string, kind: string): unknown {
  const fail = (message: string, position: number): never => {
    const prefix = text.slice(0, position), lines = prefix.split('\n');
    throw new TypeError(`${message} at line ${lines.length} column ${utf8Encode(lines.at(-1)!).length}`);
  };
  const unexpected = (t: Token) => typeof t.value === 'bigint' ? `integer \`${t.value}\``
    : typeof t.value === 'number' ? `floating point \`${Number.isInteger(t.value) ? t.value.toFixed(1) : t.value}\`` : unexpectedOf(t.value);
  const invalid = (t: Token, expected: string): never => fail(`invalid type: ${unexpected(t)}, expected ${expected}`, t.fields || t.items ? t.start + 1 : t.end);
  const decode = (t: Token, shape: Shape): unknown => {
    if (shape === 'string') return typeof t.value === 'string' ? t.value : invalid(t, 'a string');
    if (typeof shape === 'string') {
      if (typeof t.value !== 'bigint') return invalid(t, shape);
      const min = shape === 'u64' ? 0n : shape === 'i32' ? -2147483648n : -9223372036854775808n;
      const max = shape === 'u64' ? 18446744073709551615n : shape === 'i32' ? 2147483647n : 9223372036854775807n;
      if (t.value < min || t.value > max) return fail(`invalid value: ${unexpected(t)}, expected ${shape}`, t.end);
      return t.value >= BigInt(Number.MIN_SAFE_INTEGER) && t.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t.value) : t.value;
    }
    if ('optional' in shape) return t.value === null ? null : decode(t, shape.optional);
    if ('vector' in shape) return t.items ? t.items.map(item => decode(item, shape.vector)) : invalid(t, 'a sequence');
    if ('map' in shape) return t.fields ? Object.fromEntries(t.fields.map(({ key, token }) => [key, decode(token, shape.map)])) : invalid(t, 'a map');
    const output: Record<string, unknown> = {};
    const seen = new Set<string>();
    const put = (key: string, value: unknown) => Object.defineProperty(output, key, { value, enumerable: true, configurable: true, writable: true });
    if (t.fields) {
      for (const { key, keyEnd, token } of t.fields) {
        if (!Object.hasOwn(shape.fields, key)) continue;
        if (seen.has(key)) return fail(`duplicate field \`${key}\``, keyEnd);
        seen.add(key); put(key, decode(token, shape.fields[key]!.shape));
      }
    } else if (t.items) {
      const fields = Object.entries(shape.fields);
      for (let i = 0; i < t.items.length; i++) {
        if (i >= fields.length) return fail(`invalid length ${t.items.length}, expected fewer elements in array`, t.items[i]!.start + 1);
        const [key, field] = fields[i]!;
        seen.add(key); put(key, decode(t.items[i]!, field.shape));
      }
    } else return invalid(t, `struct ${shape.name}`);
    for (const [key, field] of Object.entries(shape.fields)) if (!seen.has(key)) {
      if (field.default) put(key, field.default());
      else if (t.items) return fail(`invalid length ${t.items.length}, expected struct ${shape.name} with ${Object.keys(shape.fields).length} elements`, t.end);
      else if (typeof field.shape === 'object' && 'optional' in field.shape) put(key, null);
      else return fail(`missing field \`${key}\``, t.end);
    }
    return output;
  };
  const root = tokenTree(text, fail);
  if (kind === 'reply') {
    const value = (t: Token): PluginJsonValue => {
      if (t.fields) return Object.fromEntries(t.fields.map(({ key, token }) => [key, value(token)]));
      if (t.items) return t.items.map(value);
      if (typeof t.value === 'bigint') return t.value >= BigInt(Number.MIN_SAFE_INTEGER) && t.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(t.value) : t.value;
      if (t.value === null || typeof t.value === 'boolean' || typeof t.value === 'number' || typeof t.value === 'string') return t.value;
      return fail('expected value', t.start + 1);
    };
    const display = (t: Token): string => {
      // serde_json::Value keeps insertion order in this app (Cargo preserve_order).
      if (t.fields) return `{${[...new Map(t.fields.map(f => [f.key, f.token]))].map(([key, child]) => `${JSON.stringify(key)}:${display(child)}`).join(',')}}`;
      if (t.items) return `[${t.items.map(display).join(',')}]`;
      return typeof t.value === 'string' ? JSON.stringify(t.value) : t.text;
    };
    const asI64 = (key: string): number | bigint | null => {
      const token = root.fields?.findLast(f => f.key === key)?.token;
      if (!token || typeof token.value !== 'bigint' || token.value < -9223372036854775808n || token.value > 9223372036854775807n) return null;
      return token.value >= BigInt(Number.MIN_SAFE_INTEGER) && token.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(token.value) : token.value;
    };
    return { value: value(root), ret: asI64('ret'), errcode: asI64('errcode'), display: display(root) };
  }
  return decode(root, shapes[kind]!);
}
