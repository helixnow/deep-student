/**
 * `serde_json` 兼容的 AnkiConnect 响应解码。
 *
 * Rust 有两条不同路径（`anki_connect_service.rs:371-471`）：
 * - `version`：先 `response.text()`（UTF-8 宽松解码），再 `serde_json::from_str
 *   ::<AnkiConnectResponse>`；语法/类型错误直接拼入命令文案。
 * - `deckNames` / `modelNames` / 其他 action：`response.json::<AnkiConnectResponse>()`
 *   等价于 `serde_json::from_slice`（严格 UTF-8），reqwest 0.11 在 Display 前加
 *   `error decoding response body: `。
 *
 * 因此这里按 serde_json 的字节位置规则解析，并保留：
 * - 数字原始词法（workspace 开启 `arbitrary_precision`），typed 错误不经过 JS
 *   double 舍入；
 * - 结构体字段按输入顺序反序列化，`{"error":1,"result":[}` 先报 error 类型错；
 * - 派生结构体拒绝重复的 `result` / `error` 字段；
 * - 严格 / 宽松 UTF-8 两条路径。
 *
 * 该解析器只服务 AnkiConnect 响应契约，不试图成为通用 serde_json 替代品。
 */
export class SerdeJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerdeJsonError';
  }
}

export type JsonNode =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'number'; raw: string }
  | { kind: 'array'; items: JsonNode[] }
  | { kind: 'object'; entries: Array<[string, JsonNode]> };

export interface AnkiResponseNode {
  result: JsonNode | null;
  error: string | null;
}

const NULL_NODE: JsonNode = { kind: 'null' };

/** JSON 数字原文 → Rust `Number::as_u64`（arbitrary_precision 下是严格十进制解析）。 */
export function jsonNodeAsU64(node: JsonNode | null): bigint | null {
  if (node === null || node.kind !== 'number') return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(node.raw)) return null;
  const value = BigInt(node.raw);
  return value <= 0xffff_ffff_ffff_ffffn ? value : null;
}

/** Rust `Debug` 数字/字符串在 typed 错误中的描述（`JsonUnexpected`/`Unexpected`）。 */
export function describeJsonNode(node: JsonNode): string {
  switch (node.kind) {
    case 'null': return 'null';
    case 'boolean': return `boolean \`${node.value}\``;
    case 'string': return `string ${JSON.stringify(node.value)}`;
    case 'number': return describeNumber(node.raw);
    case 'array': return 'sequence';
    case 'object': return 'map';
  }
}

/**
 * `response.json` 直接反序列化到 `Option<String>` 时，arbitrary_precision 的
 * 数字只有严格 u64/i64 会走 visit_u64/visit_i64；`-0`、浮点、越界整数都会作为
 * `NumberDeserializer` map 交给 String visitor，得到 `invalid type: map`。
 */
function describeDirectFieldNumber(raw: string): string {
  if (/^(?:0|[1-9]\d*)$/u.test(raw)) {
    return BigInt(raw) <= 0xffff_ffff_ffff_ffffn ? `integer \`${raw}\`` : 'map';
  }
  if (/^-(?:0|[1-9]\d*)$/u.test(raw) && raw !== '-0') {
    return BigInt(raw) >= -0x8000_0000_0000_0000n
      ? `integer \`${BigInt(raw).toString()}\``
      : 'map';
  }
  return 'map';
}

/** `serde_json::Value` 反序列化路径（`from_value`）的数字描述。 */
function describeNumber(raw: string): string {
  if (/^(?:0|[1-9]\d*)$/u.test(raw)) {
    const value = BigInt(raw);
    if (value <= 0xffff_ffff_ffff_ffffn) return `integer \`${value.toString()}\``;
    if (value <= 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn) return `integer \`${value.toString()}\``;
    return 'map';
  }
  if (/^-(?:0|[1-9]\d*)$/u.test(raw)) {
    const value = BigInt(raw);
    if (raw === '-0') return 'integer `0`';
    if (value >= -0x8000_0000_0000_0000n) return `integer \`${value.toString()}\``;
    if (value >= -0x8000_0000_0000_0000_0000_0000_0000_0000n) return `integer \`${value.toString()}\``;
    return 'map';
  }
  const canonical = canonicalFloat(raw);
  return canonical === null ? 'map' : `floating point \`${canonical}\``;
}

/**
 * serde_json arbitrary_precision 的 `Number::deserialize_any`：
 * `as_u64` → `as_i64` → `as_u128`/`as_i128` → `as_f64` 且
 * `zmij::format_finite(f) == raw` 才走 `visit_f64`，否则按 map 处理。
 */
function canonicalFloat(raw: string): string | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  let text = value.toString();
  if (/[eE]/u.test(text)) text = expandExponent(text);
  if (!text.includes('.')) text += '.0';
  if (Object.is(value, -0)) text = `-${text}`;
  return text;
}

/** JS 指数形式 → Rust `Display` 的十进制展开（用于与原始词法比较）。 */
function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/u.exec(text);
  if (match === null) return text;
  const sign = match[1] ?? '';
  const integer = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4]);
  const digits = integer + fraction;
  const point = integer.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** `serde_json::Value` 的 JS 投影（命令返回值保持旧 JSON.parse 的 number 语义）。 */
export function jsonNodeToJs(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'boolean': return node.value;
    case 'string': return node.value;
    case 'number': return Number(node.raw);
    case 'array': return node.items.map(jsonNodeToJs);
    case 'object': {
      const output: Record<string, unknown> = {};
      for (const [key, value] of node.entries) output[key] = jsonNodeToJs(value);
      return output;
    }
  }
}

class Parser {
  private readonly bytes: Uint8Array;
  private readonly strictUtf8: boolean;
  private at = 0;
  private depth = 128;

  constructor(bytes: Uint8Array, strictUtf8: boolean) {
    this.bytes = bytes;
    this.strictUtf8 = strictUtf8;
  }

  parseResponse(): AnkiResponseNode {
    this.whitespace();
    if (this.bytes[this.at] !== 123) {
      const first = this.bytes[this.at];
      if (first === 91 || first === 123) {
        // serde `peek_invalid_type` 对 sequence/map 不消费，位置停在首字节。
        this.error(
          `invalid type: ${first === 91 ? 'sequence' : 'map'}, expected struct AnkiConnectResponse`,
          true,
        );
      }
      const value = this.value();
      this.error(`invalid type: ${describeJsonNode(value)}, expected struct AnkiConnectResponse`);
    }
    this.at++;
    let result: JsonNode | null = null;
    let error: string | null = null;
    let seenResult = false;
    let seenError = false;
    this.whitespace();
    if (this.bytes[this.at] === 125) {
      this.at++;
    } else {
      let afterComma = false;
      for (;;) {
        if (this.bytes[this.at] === undefined) {
          this.error(afterComma ? 'EOF while parsing a value' : 'EOF while parsing an object');
        }
        if (this.bytes[this.at] !== 34) this.error('key must be a string', true);
        const key = this.string();
        // serde 的派生 visitor 在 `next_key` 返回后立刻判重，此时冒号尚未消费。
        if (key === 'result' && seenResult) this.error('duplicate field `result`');
        if (key === 'error' && seenError) this.error('duplicate field `error`');
        if (key === 'result') seenResult = true;
        if (key === 'error') seenError = true;
        this.whitespace();
        const colon = this.bytes[this.at++];
        if (colon === undefined) this.error('EOF while parsing a value');
        if (colon !== 58) this.error('expected `:`');
        this.whitespace();
        if (key === 'result') {
          // `Option<serde_json::Value>`：JSON `null` 走 deserialize_option → None，不是 Some(Null)。
          const node = this.value();
          result = node.kind === 'null' ? null : node;
        } else if (key === 'error') {
          const first = this.bytes[this.at];
          if (first === 91 || first === 123) {
            // `Option<String>` 对 sequence/map 在首字节直接报 peek_invalid_type。
            this.error(
              `invalid type: ${first === 91 ? 'sequence' : 'map'}, expected a string`,
              true,
            );
          }
          const value = this.value();
          if (value.kind === 'null') {
            error = null;
          } else if (value.kind === 'string') {
            error = value.value;
          } else {
            const description = value.kind === 'number'
              ? describeDirectFieldNumber(value.raw)
              : describeJsonNode(value);
            this.error(`invalid type: ${description}, expected a string`);
          }
        } else {
          this.value();
        }
        this.whitespace();
        const next = this.bytes[this.at++];
        if (next === 125) break;
        if (next === undefined) this.error('EOF while parsing an object');
        if (next !== 44) this.error('expected `,` or `}`');
        this.whitespace();
        if (this.bytes[this.at] === 125) this.error('trailing comma', true);
        afterComma = true;
      }
    }
    this.whitespace();
    if (this.at !== this.bytes.length) this.error('trailing characters', true);
    return { result, error };
  }

  private whitespace(): void {
    while (
      this.bytes[this.at] === 32
      || this.bytes[this.at] === 9
      || this.bytes[this.at] === 10
      || this.bytes[this.at] === 13
    ) this.at++;
  }

  private value(): JsonNode {
    this.whitespace();
    const byte = this.bytes[this.at];
    if (byte === undefined) this.error('EOF while parsing a value');
    if (byte === 34) return { kind: 'string', value: this.string() };
    if (byte === 110 || byte === 116 || byte === 102) {
      const ident = byte === 110 ? 'null' : byte === 116 ? 'true' : 'false';
      this.at++;
      for (const expected of new TextEncoder().encode(ident.slice(1))) {
        const actual = this.bytes[this.at++];
        if (actual === undefined) this.error('EOF while parsing a value');
        if (actual !== expected) this.error('expected ident');
      }
      if (byte === 110) return NULL_NODE;
      return { kind: 'boolean', value: byte === 116 };
    }
    if (byte === 91 || byte === 123) return this.container(byte === 123);
    if (byte === 45 || (byte >= 48 && byte <= 57)) return this.number();
    this.error('expected value', true);
  }

  private container(object: boolean): JsonNode {
    if (--this.depth === 0) this.error('recursion limit exceeded', true);
    this.at++;
    this.whitespace();
    const end = object ? 125 : 93;
    if (this.bytes[this.at] === end) {
      this.at++;
      this.depth++;
      return object ? { kind: 'object', entries: [] } : { kind: 'array', items: [] };
    }
    const entries: Array<[string, JsonNode]> = [];
    const items: JsonNode[] = [];
    for (;;) {
      if (object) {
        if (this.bytes[this.at] === undefined) this.error('EOF while parsing an object');
        if (this.bytes[this.at] !== 34) this.error('key must be a string', true);
        const key = this.string();
        this.whitespace();
        const colon = this.bytes[this.at++];
        if (colon === undefined) this.error('EOF while parsing an object');
        if (colon !== 58) this.error('expected `:`');
        this.whitespace();
        entries.push([key, this.value()]);
      } else {
        if (this.bytes[this.at] === undefined) this.error('EOF while parsing a list');
        items.push(this.value());
      }
      this.whitespace();
      const next = this.bytes[this.at++];
      if (next === end) {
        this.depth++;
        return object ? { kind: 'object', entries } : { kind: 'array', items };
      }
      if (next === undefined) this.error(object ? 'EOF while parsing an object' : 'EOF while parsing a list');
      if (next !== 44) this.error(object ? 'expected `,` or `}`' : 'expected `,` or `]`');
      this.whitespace();
      if (this.bytes[this.at] === end) this.error('trailing comma', true);
    }
  }

  private number(): JsonNode {
    const start = this.at;
    if (this.bytes[this.at] === 45) this.at++;
    if (this.bytes[this.at] === 48) {
      this.at++;
      if (this.isDigit()) this.error('invalid number', true);
    } else if (this.isDigit()) {
      while (this.isDigit()) this.at++;
    } else {
      if (this.bytes[this.at] === undefined) this.error('EOF while parsing a value');
      this.error('invalid number', true);
    }
    if (this.bytes[this.at] === 46) {
      this.at++;
      if (!this.isDigit()) {
        if (this.bytes[this.at] === undefined) this.error('EOF while parsing a value');
        this.error('invalid number', true);
      }
      while (this.isDigit()) this.at++;
    }
    if (this.bytes[this.at] === 69 || this.bytes[this.at] === 101) {
      this.at++;
      if (this.bytes[this.at] === 43 || this.bytes[this.at] === 45) this.at++;
      if (!this.isDigit()) {
        if (this.bytes[this.at] === undefined) this.error('EOF while parsing a value');
        this.error('invalid number', true);
      }
      while (this.isDigit()) this.at++;
    }
    return {
      kind: 'number',
      raw: new TextDecoder('utf-8', { ignoreBOM: true }).decode(this.bytes.subarray(start, this.at)),
    };
  }

  private isDigit(): boolean {
    const byte = this.bytes[this.at];
    return byte !== undefined && byte >= 48 && byte <= 57;
  }

  private string(): string {
    const contentStart = this.at + 1;
    this.at++;
    const output: number[] = [];
    for (;;) {
      const byte = this.bytes[this.at++];
      if (byte === undefined) this.error('EOF while parsing a string');
      if (byte === 34) break;
      if (byte < 32) this.error('control character (\\u0000-\\u001F) found while parsing a string');
      if (byte !== 92) {
        output.push(byte);
        continue;
      }
      const escape = this.bytes[this.at++];
      if (escape === undefined) this.error('EOF while parsing a string');
      if (escape === 117) {
        this.pushCodePoint(this.hex(), output);
      } else {
        const mapped = escape === 34 ? 34
          : escape === 92 ? 92
            : escape === 47 ? 47
              : escape === 98 ? 8
                : escape === 102 ? 12
                  : escape === 110 ? 10
                    : escape === 114 ? 13
                      : escape === 116 ? 9
                        : undefined;
        if (mapped === undefined) this.error('invalid escape');
        output.push(mapped);
      }
    }
    const decoded = this.decodeString(output, contentStart);
    return decoded;
  }

  private hex(): number {
    let value = 0;
    for (let index = 0; index < 4; index++) {
      const byte = this.bytes[this.at++] ?? this.error('EOF while parsing a string');
      const digit = byte >= 48 && byte <= 57 ? byte - 48
        : byte >= 65 && byte <= 70 ? byte - 55
          : byte >= 97 && byte <= 102 ? byte - 87 : -1;
      if (digit === -1) this.error('invalid escape');
      value = value * 16 + digit;
    }
    return value;
  }

  private pushCodePoint(code: number, output: number[]): void {
    if (code >= 0xdc00 && code <= 0xdfff) this.error('lone leading surrogate in hex escape');
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.bytes[this.at++] !== 92) this.error('unexpected end of hex escape');
      if (this.bytes[this.at++] !== 117) this.error('unexpected end of hex escape');
      const trailing = this.hex();
      if (trailing < 0xdc00 || trailing > 0xdfff) this.error('lone leading surrogate in hex escape');
      const combined = (((code - 0xd800) << 10) | (trailing - 0xdc00)) + 0x10000;
      output.push(
        0xf0 | (combined >> 18),
        0x80 | ((combined >> 12) & 0x3f),
        0x80 | ((combined >> 6) & 0x3f),
        0x80 | (combined & 0x3f),
      );
      return;
    }
    if (code < 0x80) {
      output.push(code);
    } else if (code < 0x800) {
      output.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      output.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  private decodeString(output: number[], contentStart: number): string {
    const bytes = Uint8Array.from(output);
    if (this.strictUtf8) {
      const invalid = firstInvalidUtf8(bytes);
      if (invalid !== -1) {
        // serde `as_str`：位置为非法字节本身的 1-based 列（转义串为近似值）。
        this.errorAt('invalid unicode code point', contentStart + invalid + 1);
      }
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
  }

  private error(reason: string, peek = false): never {
    this.errorAt(reason, Math.min(this.bytes.length, this.at + (peek ? 1 : 0)));
  }

  private errorAt(reason: string, position: number): never {
    const prefix = this.bytes.subarray(0, position);
    const lastLine = prefix.lastIndexOf(10);
    let line = 1;
    for (const byte of prefix) if (byte === 10) line++;
    throw new SerdeJsonError(`${reason} at line ${line} column ${position - lastLine - 1}`);
  }
}

function firstInvalidUtf8(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index]!;
    if (byte < 0x80) {
      index++;
      continue;
    }
    const width = byte >= 0xc2 && byte <= 0xdf ? 2
      : byte >= 0xe0 && byte <= 0xef ? 3
        : byte >= 0xf0 && byte <= 0xf4 ? 4
          : -1;
    if (width === -1 || index + width > bytes.length) return index;
    for (let offset = 1; offset < width; offset++) {
      const continuation = bytes[index + offset]!;
      if ((continuation & 0xc0) !== 0x80) return index;
    }
    const second = bytes[index + 1]!;
    if (width === 3 && byte === 0xe0 && second < 0xa0) return index;
    if (width === 3 && byte === 0xed && second > 0x9f) return index;
    if (width === 4 && byte === 0xf0 && second < 0x90) return index;
    if (width === 4 && byte === 0xf4 && second > 0x8f) return index;
    index += width;
  }
  return -1;
}

/** `serde_json::from_str::<AnkiConnectResponse>`（version 路径）。 */
export function parseAnkiConnectResponseText(text: string): AnkiResponseNode {
  return new Parser(new TextEncoder().encode(text), false).parseResponse();
}

/** `serde_json::from_slice::<AnkiConnectResponse>`（reqwest `response.json` 路径）。 */
export function parseAnkiConnectResponseBytes(bytes: Uint8Array): AnkiResponseNode {
  return new Parser(bytes, true).parseResponse();
}

/** 读取 `result` 数组元素（供牌组/模型名命令使用）。 */
export function stringArrayFromNode(result: JsonNode | null): string[] {
  if (result === null) throw new Error('AnkiConnect返回空结果');
  if (result.kind !== 'array') {
    throw new Error(`invalid type: ${describeJsonNode(result)}, expected a sequence`);
  }
  return result.items.map((item) => {
    if (item.kind !== 'string') {
      throw new Error(`invalid type: ${describeJsonNode(item)}, expected a string`);
    }
    return item.value;
  });
}
