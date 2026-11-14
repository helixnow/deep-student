/**
 * serde_json 1.0.149 读取原语（F4 共享；L11/L12/L23/F3 与 F4 自身的持久化 serde 解码共用）。
 *
 * serde 是流式反序列化：typed decoder 按字段读取，类型错误、已知字段重复会先于后面的语法错误与
 * 尾随字符报出。因此这里提供 **pull reader**（`JsonReader`），由各 struct 的所有者按 serde derive
 * 的顺序驱动；`parseJsonDocument` 只是 reader 上的 `serde_json::Value` 读取（重复键全部保留，
 * 由 `objectLastWins` 取 Value 的 last-wins），**不**用于 typed struct。
 *
 * 依据（只读源码，不运行 Rust）：
 * - 位置 = `read.rs` SliceRead：line 从 1 起，column = 当前行已消费的 UTF-8 字节数。
 *   `peek_error` 含被看到的那个字节；`error` 为已消费位置。
 * - typed 数字分类 = `de.rs` parse_integer/parse_number：有小数或指数 → F64；`-0` → F64(-0.0)；
 *   正整数溢出 u64、负整数溢出 i64 → F64；有限性溢出 → `number out of range`。
 *   Value/arbitrary_precision 的 scan_* 和 IgnoredAny 的 ignore_* 只检查数字语法，不检查 f64 有限性。
 *   Value 节点始终以 raw 为准（分类是投影提示，不是 serde_json::Number 的完整 from_value 语义）。
 * - 错误文本 = `error.rs` ErrorCode Display 与 `JsonUnexpected`（null 写作 `null`，浮点用 zmij 1.0.21）。
 * - 结构错误位置 = `deserialize_struct` 的 `fix_position`：visitor 自身的错误（duplicate/missing
 *   field）在 `end_map` 跳过空白（并在 `}` 时吃掉它）之后的位置报出。
 * - typed/Value 递归上限 128（`remaining_depth`）；精确 IgnoredAny 用 skipIgnoredValue 的独立迭代栈。
 */

import { validUtf8Prefix } from './utf8.ts';

export class JsonSyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  /** 不含位置的 Display（serde_json ErrorCode 或 de::Error::custom 文本）。 */
  readonly code: string;
  constructor(code: string, line: number, column: number) {
    super(`${code} at line ${line} column ${column}`);
    this.name = 'JsonSyntaxError';
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

/** serde_json `ParserNumber`。整数用 bigint，保留 u64/i64 全精度。 */
export type JsonNumber =
  | { readonly kind: 'u64'; readonly value: bigint; readonly raw: string }
  | { readonly kind: 'i64'; readonly value: bigint; readonly raw: string }
  | { readonly kind: 'f64'; readonly value: number; readonly raw: string };

/** Value/arbitrary_precision can contain a legal decimal outside f64's finite range.
 * `raw` is authoritative; no Infinity placeholder is exposed as a JSON numeric value.
 */
export type JsonValueNumber = JsonNumber | { readonly kind: 'arbitrary'; readonly raw: string };

export type JsonNode =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: JsonValueNumber }
  | { readonly kind: 'array'; readonly items: readonly JsonNode[] }
  | { readonly kind: 'object'; readonly members: readonly { readonly key: string; readonly value: JsonNode }[] };

type JsonScalar = Exclude<JsonNode, { kind: 'array' | 'object' | 'number' }>
  | { readonly kind: 'number'; readonly value: JsonNumber } | { readonly kind: 'array' | 'object' };

export type JsonTokenKind = 'null' | 'bool' | 'string' | 'number' | 'array' | 'object';

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES = new Map([['"', '"'], ['\\', '\\'], ['/', '/'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);
const utf8Len = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);

/** serde_json `ParserNumber` 分类（`de.rs:462-527`）。 */
export function classifyJsonNumber(raw: string): JsonNumber {
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(raw)) return { kind: 'f64', value: Number(raw), raw };
  const value = BigInt(raw);
  if (!raw.startsWith('-')) return value <= U64_MAX ? { kind: 'u64', value, raw } : { kind: 'f64', value: Number(raw), raw };
  if (value === 0n) return { kind: 'f64', value: -0, raw };
  return value >= I64_MIN ? { kind: 'i64', value, raw } : { kind: 'f64', value: Number(raw), raw };
}

/**
 * `zmij::Buffer::format(f64)`（zmij 1.0.21 `lib.rs:1064-1135`；serde_json 1.0.149 `error.rs:471-475`
 * 的 `JsonUnexpected::Float` 与 `ser.rs` 用它，不再是 ryu）。导出名沿用 `ryuFormat`。
 * 与 ryu 的唯一差别：科学计数的非负指数写 `e+X`。dec_exp 在 [-5, 15] 内用定点。
 */
export function ryuFormat(value: number): string {
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exp] = Math.abs(value).toExponential().split('e') as [string, string];
  const digits = mantissa.replace('.', '');
  const length = digits.length;
  const kk = Number(exp) + 1; // 10^(kk-1) <= v < 10^kk
  const k = kk - length;
  let out: string;
  if (k >= 0 && kk <= 16) out = `${digits}${'0'.repeat(k)}.0`;
  else if (kk > 0 && kk <= 16) out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  else if (kk > -5 && kk <= 0) out = `0.${'0'.repeat(-kk)}${digits}`;
  else {
    const decExp = kk - 1;
    out = `${digits[0]}${length > 1 ? `.${digits.slice(1)}` : ''}e${decExp >= 0 ? '+' : '-'}${Math.abs(decExp)}`;
  }
  return sign + out;
}

/** Rust `<str as Debug>`（serde `Unexpected::Str` 的 `{:?}`），按 char 转义。 */
function rustDebugStr(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code === 0) out += '\\0';
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** serde `Unexpected` 经 serde_json `JsonUnexpected` 的 Display。 */
export function jsonUnexpected(node: JsonScalar | JsonNode): string {
  switch (node.kind) {
    case 'null': return 'null';
    case 'bool': return `boolean \`${node.value}\``;
    case 'string': return `string ${rustDebugStr(node.value)}`;
    case 'array': return 'sequence';
    case 'object': return 'map';
    case 'number':
      if (node.value.kind === 'arbitrary') return 'number';
      return node.value.kind === 'f64' ? `floating point \`${ryuFormat(node.value.value)}\`` : `integer \`${node.value.value}\``;
  }
}

/**
 * 流式读取器（serde_json `Deserializer<StrRead>` 的读取面）。typed decoder 的典型用法：
 *
 * ```ts
 * const r = new JsonReader(text);
 * r.beginObject();                       // deserialize_struct：非 `{` 时抛 invalid type … expected <exp>
 * for (let key; (key = r.nextKey()) !== null;) {
 *   if (key === 'version') { if (version !== undefined) throw r.fieldError('duplicate field `version`'); version = r.readUnsigned('u32', 0xffff_ffffn); }
 *   else r.skipIgnoredValue();          // 未知字段 = IgnoredAny（与构造 Value 的语义不同）
 * }
 * if (version === undefined) throw r.error('missing field `version`');
 * r.end();                               // de.end()：trailing characters
 * ```
 * 只有 `nextKey()` 返回非 null 后才能读取值；值读取方法会先吃掉 `:`。
 */
export class JsonReader {
  private index = 0;
  private lineNo = 1;
  private col = 0;
  private depth = 128;
  private pendingColon = false;
  /** 每层容器是否已读过首个成员（决定下一个成员前需要 `,`）。 */
  private readonly started: boolean[] = [];
  private readonly text: string;
  /**
   * `from_slice` 模式：`text` 每个 UTF-16 单元恰为一个输入字节（0x00–0xFF），位置直接按字节推进；
   * 字符串内容只在闭合引号处做 `str::from_utf8`（read.rs:868 as_str），不预先校验整块输入。
   */
  private bytes = false;
  constructor(text: string) { this.text = text; }

  /** serde_json `Deserializer::from_slice` / `SliceRead::new`（de.rs:89、read.rs:411）。 */
  static fromSlice(input: Uint8Array): JsonReader {
    const reader = new JsonReader(byteString(input));
    reader.bytes = true;
    return reader;
  }

  get line(): number { return this.lineNo; }
  get column(): number { return this.col; }

  /** serde_json `self.error(code)`：已消费位置。typed decoder 的 invalid value 等用它。 */
  error(code: string): JsonSyntaxError { return new JsonSyntaxError(code, this.lineNo, this.col); }

  /**
   * 对象仍打开时 derive visitor 自身的错误（如 `duplicate field`，在 `nextKey()` 返回该键之后、读值之前）：
   * serde_json `deserialize_struct` 先跑 `end_map`（跳空白、遇 `}` 吃掉）再 `fix_position`。
   * `nextKey()` 已返回 null（对象已关闭）之后的错误（如 `missing field`）直接用 `error()`。
   */
  fieldError(code: string): JsonSyntaxError {
    this.pendingColon = false;
    this.ws();
    if (this.peek() === '}') this.close();
    return this.error(code);
  }

  // ------------------------------------------------------------ 低层
  private peekError(code: string): JsonSyntaxError {
    const char = this.text.codePointAt(this.index);
    // SliceRead::peek_position sees index+1 BYTE, not the entire UTF-8 scalar.
    if (char === 0x0a) return new JsonSyntaxError(code, this.lineNo + 1, 0);
    return new JsonSyntaxError(code, this.lineNo, this.col + (char === undefined ? 0 : 1));
  }
  private advance(): void {
    if (this.bytes) {
      if (this.text.charCodeAt(this.index++) === 0x0a) { this.lineNo += 1; this.col = 0; } else this.col += 1;
      return;
    }
    const char = this.text.codePointAt(this.index)!;
    this.index += char > 0xffff ? 2 : 1;
    if (char === 0x0a) { this.lineNo += 1; this.col = 0; } else this.col += utf8Len(char);
  }
  private peek(): string | undefined { return this.text[this.index]; }
  private ws(): void {
    for (let c = this.peek(); c === ' ' || c === '\t' || c === '\n' || c === '\r'; c = this.peek()) this.advance();
  }
  private colon(): void {
    if (!this.pendingColon) return;
    this.pendingColon = false;
    this.ws();
    const c = this.peek();
    if (c === undefined) throw this.error('EOF while parsing an object');
    if (c !== ':') throw this.peekError('expected `:`');
    this.advance();
  }
  private enter(): void {
    if (--this.depth === 0) throw this.peekError('recursion limit exceeded');
    this.advance();
    this.started.push(false);
  }
  private close(): void {
    this.advance();
    this.started.pop();
    this.depth += 1;
  }

  // ------------------------------------------------------------ token
  /** 看下一个值的种类（不消费）。EOF / 非法起始字符按 serde 报错。 */
  peekKind(): JsonTokenKind {
    this.colon();
    this.ws();
    const c = this.peek();
    if (c === undefined) throw this.error('EOF while parsing a value');
    if (c === '{') return 'object';
    if (c === '[') return 'array';
    if (c === '"') return 'string';
    if (c === 't' || c === 'f') return 'bool';
    if (c === 'n') return 'null';
    if (c === '-' || (c >= '0' && c <= '9')) return 'number';
    throw this.peekError('expected value');
  }

  private ident(word: string): void {
    for (const expected of word) {
      if (this.peek() === undefined) throw this.error('EOF while parsing a value');
      const matches = this.peek() === expected;
      this.advance();
      if (!matches) throw this.error('expected ident');
    }
  }

  /** 标量 token（消费）或容器种类（不消费，用于 invalid type 的 `sequence`/`map`）。 */
  private scalar(): JsonScalar {
    const kind = this.peekKind();
    if (kind === 'null') { this.ident('null'); return { kind: 'null' }; }
    if (kind === 'bool') { const v = this.peek() === 't'; this.ident(v ? 'true' : 'false'); return { kind: 'bool', value: v }; }
    if (kind === 'string') return { kind: 'string', value: this.string() };
    if (kind === 'number') return { kind: 'number', value: this.number() };
    return { kind };
  }

  /**
   * serde `invalid_type`：消费标量 token（容器不消费），在 serde_json 的位置报
   * `invalid type: <unexpected>, expected <expected>`。typed decoder 遇到类型不符时调用。
   */
  invalidType(expected: string): JsonSyntaxError {
    return this.error(`invalid type: ${jsonUnexpected(this.scalar())}, expected ${expected}`);
  }

  readNull(expected = 'unit'): null {
    if (this.peekKind() !== 'null') throw this.invalidType(expected);
    this.ident('null');
    return null;
  }
  /** `Option<T>`：null → true（已消费），否则 false（未消费，接着读 T）。 */
  readOptionNone(): boolean {
    if (this.peekKind() !== 'null') return false;
    this.ident('null');
    return true;
  }
  readBool(expected = 'a boolean'): boolean {
    if (this.peekKind() !== 'bool') throw this.invalidType(expected);
    return (this.scalar() as { value: boolean }).value;
  }
  readString(expected = 'a string'): string {
    if (this.peekKind() !== 'string') throw this.invalidType(expected);
    return this.string();
  }
  /** 原始数字（分类后），非数字 → invalid type。 */
  readNumber(expected: string): JsonNumber {
    if (this.peekKind() !== 'number') throw this.invalidType(expected);
    return this.number();
  }
  /** serde 无符号整数 visitor（u8..u64）：`expected` 如 `'u32'`，`max` 如 `0xffff_ffffn`。 */
  readUnsigned(expected: string, max: bigint): bigint {
    const n = this.readNumber(expected);
    if (n.kind === 'f64') throw this.error(`invalid type: floating point \`${ryuFormat(n.value)}\`, expected ${expected}`);
    if (n.value < 0n || n.value > max) throw this.error(`invalid value: integer \`${n.value}\`, expected ${expected}`);
    return n.value;
  }
  /** serde 有符号整数 visitor（i8..i64）。 */
  readSigned(expected: string, min: bigint, max: bigint): bigint {
    const n = this.readNumber(expected);
    if (n.kind === 'f64') throw this.error(`invalid type: floating point \`${ryuFormat(n.value)}\`, expected ${expected}`);
    if (n.value < min || n.value > max) throw this.error(`invalid value: integer \`${n.value}\`, expected ${expected}`);
    return n.value;
  }

  // ------------------------------------------------------------ 容器
  /** `deserialize_struct`/`map`：吃掉 `{`；不是对象时报 invalid type。 */
  beginObject(expected = 'a map'): void {
    if (this.peekKind() !== 'object') throw this.invalidType(expected);
    this.enter();
  }
  /** `MapAccess::next_key`：下一个键，或在 `}` 处返回 null（同时完成 `end_map`）。 */
  nextKey(): string | null {
    if (this.pendingColon) this.skipValue();
    this.ws();
    let c = this.peek();
    if (this.started.at(-1)) {
      if (c === undefined) throw this.error('EOF while parsing an object');
      if (c === '}') { this.close(); return null; }
      if (c !== ',') throw this.peekError('expected `,` or `}`');
      this.advance();
      this.ws();
      c = this.peek();
      if (c === '}') throw this.peekError('trailing comma');
    } else {
      this.started[this.started.length - 1] = true;
      if (c === '}') { this.close(); return null; }
      if (c === undefined) throw this.error('EOF while parsing an object');
    }
    if (c === undefined) throw this.error('EOF while parsing a value');
    if (c !== '"') throw this.peekError('key must be a string');
    const key = this.string();
    this.pendingColon = true;
    return key;
  }
  /**
   * externally-tagged enum 的 map 形式（`de.rs` `deserialize_enum` 的 `{` 分支 + `VariantAccess`）。
   * 调用 `beginObject()` 吃掉 `{` 之后调用：按 `deserialize_str` 读变体名（不走 map 的空/逗号/结束分支），
   * 非字符串 → `invalid type: …, expected <expected>`；返回后由调用方校验变体名，接着读变体值
   * （`:` 在读值时消费，等价于 `variant_seed` 后的 `parse_object_colon`），最后调用 `endEnumObject()`。
   */
  readEnumVariant(expected = 'variant identifier'): string {
    if (this.peekKind() !== 'string') throw this.invalidType(expected);
    const name = this.string();
    this.pendingColon = true;
    return name;
  }
  /** `deserialize_enum` 读完变体值后：跳空白，要求并消费 `}`；否则在当前位置报 `expected value` / EOF。 */
  endEnumObject(): void {
    if (this.pendingColon) throw new Error('JsonReader.endEnumObject: variant value not read');
    this.ws();
    const c = this.peek();
    if (c === undefined) throw this.error('EOF while parsing an object');
    if (c !== '}') throw this.error('expected value');
    this.close();
  }

  /** `deserialize_seq`：吃掉 `[`。 */
  beginArray(expected = 'a sequence'): void {
    if (this.peekKind() !== 'array') throw this.invalidType(expected);
    this.enter();
  }
  /** `SeqAccess::next_element`：还有元素 → true（接着读值）；`]` → false（同时完成 `end_seq`）。 */
  nextItem(): boolean {
    this.ws();
    const c = this.peek();
    if (this.started.at(-1)) {
      if (c === undefined) throw this.error('EOF while parsing a list');
      if (c === ']') { this.close(); return false; }
      if (c !== ',') throw this.peekError('expected `,` or `]`');
      this.advance();
      this.ws();
      if (this.peek() === ']') throw this.peekError('trailing comma');
      return true;
    }
    this.started[this.started.length - 1] = true;
    if (c === ']') { this.close(); return false; }
    if (c === undefined) throw this.error('EOF while parsing a list');
    return true;
  }

  /**
   * serde_json `de.rs:1072-1086` end_seq：positional struct/tuple 读满已知字段后调用，
   * 不读取下一元素。`]` → 消费并闭合；`,` 后 `]` → trailing comma；否则 peek_error
   * trailing characters（先消费逗号、跳空白），EOF 无逗号 → EOF while parsing a list。
   * 不在 nextItem() 已返回 false（已闭合）之后调用。
   */
  endArray(): void {
    this.ws();
    const c = this.peek();
    if (c === ']') { this.close(); return; }
    if (c === ',') {
      this.advance();
      this.ws();
      throw this.peekError(this.peek() === ']' ? 'trailing comma' : 'trailing characters');
    }
    if (c === undefined) throw this.peekError('EOF while parsing a list');
    throw this.peekError('trailing characters');
  }

  /** 保留既有 Value 式丢弃：不存储子树，但仍检查深度和字符串代理项配对。精确 IgnoredAny 用 skipIgnoredValue。 */
  skipValue(): void { this.valueTree(true); }

  /**
   * serde_json 1.0.149 `deserialize_ignored_any` → `ignore_value` (de.rs:1102-1281)。
   * 消费挂起的冒号和一个值；只扫描词法，不构造 JsonNode、不检查数字范围、不配对 \u 代理项。
   * 容器用独立迭代栈，不使用 typed 的 remaining_depth/started 栈；不会放宽已知字段的读取。
   * 仍检查转义、四位 hex、控制字符、闭合/逗号/冒号；错误位置由同一个 reader 维护。
   */
  skipIgnoredValue(): void {
    this.colon();
    const parents: ('[' | '{')[] = [];
    let enclosing: '[' | '{' | undefined;
    while (true) {
      this.ws();
      const c = this.peek();
      if (c === undefined) throw this.peekError('EOF while parsing a value');
      let frame: '[' | '{' | undefined;
      if (c === 'n' || c === 't' || c === 'f') this.ident(c === 'n' ? 'null' : c === 't' ? 'true' : 'false');
      else if (c === '-' || (c >= '0' && c <= '9')) this.ignoreNumber();
      else if (c === '"') this.ignoreString();
      else if (c === '[' || c === '{') {
        if (enclosing !== undefined) parents.push(enclosing);
        enclosing = undefined;
        this.advance();
        frame = c;
      } else throw this.peekError('expected value');

      let acceptComma = false;
      if (frame === undefined) {
        frame = enclosing ?? parents.pop();
        enclosing = undefined;
        if (frame === undefined) return;
        acceptComma = true;
      }
      while (true) {
        this.ws();
        const next = this.peek();
        if (next === undefined) throw this.peekError(frame === '[' ? 'EOF while parsing a list' : 'EOF while parsing an object');
        if (next === ',' && acceptComma) { this.advance(); break; }
        if ((next === ']' && frame === '[') || (next === '}' && frame === '{')) {
          this.advance();
          frame = parents.pop();
          if (frame === undefined) return;
          acceptComma = true;
          continue;
        }
        if (acceptComma) throw this.peekError(frame === '[' ? 'expected `,` or `]`' : 'expected `,` or `}`');
        break;
      }
      if (frame === '{') {
        this.ws();
        if (this.peek() === undefined) throw this.peekError('EOF while parsing an object');
        if (this.peek() !== '"') throw this.peekError('key must be a string');
        this.ignoreString();
        this.ws();
        if (this.peek() === undefined) throw this.peekError('EOF while parsing an object');
        if (this.peek() !== ':') throw this.peekError('expected `:`');
        this.advance();
      }
      enclosing = frame;
    }
  }

  /** Value/arbitrary_precision：成员按序保留重复键，超 f64 的合法数字保留 raw，不拒绝或投影为 Infinity。 */
  readValue(): JsonNode {
    return this.valueTree(false);
  }

  private valueTree(ignored: boolean): JsonNode {
    const kind = this.peekKind();
    if (kind === 'object') {
      this.enter();
      const members: { key: string; value: JsonNode }[] = [];
      for (let key = this.nextKey(); key !== null; key = this.nextKey()) {
        const value = this.valueTree(ignored);
        if (!ignored) members.push({ key, value });
      }
      return { kind: 'object', members };
    }
    if (kind === 'array') {
      this.enter();
      const items: JsonNode[] = [];
      while (this.nextItem()) {
        const value = this.valueTree(ignored);
        if (!ignored) items.push(value);
      }
      return { kind: 'array', items };
    }
    if (kind === 'number') {
      const raw = this.numberToken(ignored ? 'ignored' : 'value');
      if (ignored) return { kind: 'null' };
      const number = classifyJsonNumber(raw);
      return { kind: 'number', value: number.kind === 'f64' && !Number.isFinite(number.value)
        ? { kind: 'arbitrary', raw } : number };
    }
    return this.scalar() as JsonNode;
  }

  /** `Deserializer::end`：根值之后只允许空白。 */
  end(): void {
    this.ws();
    if (this.index < this.text.length) throw this.peekError('trailing characters');
  }

  // ------------------------------------------------------------ 词法
  /** IgnoredAny 的 ignore_integer/ignore_decimal/ignore_exponent：不收集数字原文、不转换 number。 */
  private ignoreNumber(): void {
    if (this.peek() === '-') this.advance();
    const first = this.peek();
    if (first !== undefined) this.advance();
    const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
    if (first === '0') {
      if (isDigit(this.peek())) throw this.peekError('invalid number');
    } else if (first !== undefined && first >= '1' && first <= '9') {
      while (isDigit(this.peek())) this.advance();
    } else throw this.error('invalid number');
    if (this.peek() === '.') {
      this.advance();
      if (!isDigit(this.peek())) throw this.peekError('invalid number');
      while (isDigit(this.peek())) this.advance();
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.advance();
      if (this.peek() === '+' || this.peek() === '-') this.advance();
      const digit = this.peek();
      if (digit !== undefined) this.advance();
      if (!isDigit(digit)) throw this.error('invalid number');
      while (isDigit(this.peek())) this.advance();
    }
  }

  /** read.rs SliceRead::ignore_str / ignore_escape：四个 hex 均读取后才判错，不验证代理项。 */
  private ignoreString(): void {
    this.advance(); // opening quote
    while (true) {
      const c = this.peek();
      if (c === undefined) throw this.error('EOF while parsing a string');
      if (c.charCodeAt(0) < 0x20) throw this.error('control character (\\u0000-\\u001F) found while parsing a string');
      this.advance();
      if (c === '"') return;
      if (c !== '\\') continue;
      const escape = this.peek();
      if (escape === undefined) throw this.error('EOF while parsing a string');
      this.advance();
      if (escape === 'u') this.hex4();
      else if (!ESCAPES.has(escape)) throw this.error('invalid escape');
    }
  }

  private number(): JsonNumber {
    const number = classifyJsonNumber(this.numberToken('typed'));
    if (number.kind === 'f64' && !Number.isFinite(number.value)) throw this.error('number out of range');
    return number;
  }

  /** Shared number grammar; only typed number() performs a finite-range check.
   * Value's arbitrary_precision scan_* reports EOF for incomplete decimals/exponents;
   * IgnoredAny's ignore_* and typed parse_* retain their invalid-number errors.
   */
  private numberToken(mode: 'typed' | 'value' | 'ignored'): string {
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(this.text);
    if (match === null) { // '-' 后不是数字（parse_integer 用 next_char）
      this.advance();
      if (this.peek() === undefined) throw this.error('EOF while parsing a value');
      this.advance();
      throw this.error('invalid number');
    }
    const raw = match[0];
    const after = this.text[this.index + raw.length];
    for (let i = 0; i < raw.length; i++) this.advance();
    if (/^-?0$/.test(raw) && after !== undefined && after >= '0' && after <= '9') throw this.peekError('invalid number');
    const hasExp = /[eE]/.test(raw);
    if ((after === '.' && !raw.includes('.') && !hasExp) || ((after === 'e' || after === 'E') && !hasExp)) {
      this.advance();
      if (after !== '.' && (this.peek() === '+' || this.peek() === '-')) this.advance();
      if (mode === 'value' && this.peek() === undefined) throw this.error('EOF while parsing a value');
      if (mode === 'ignored' && after !== '.' && this.peek() !== undefined) {
        this.advance();
        throw this.error('invalid number');
      }
      throw this.peekError('invalid number');
    }
    return raw;
  }

  private string(): string {
    this.advance(); // "
    // from_slice：out 收集原始字节（转义按 push_wtf8_codepoint 写 UTF-8 字节），闭合引号后才 as_str。
    const utf8 = this.bytes ? (unit: number) => utf8Bytes(unit) : (unit: number) => String.fromCharCode(unit);
    let out = '';
    while (true) {
      // Ordinary ASCII has identical UTF-16/UTF-8/byte widths and no line breaks.
      // Append a whole span instead of allocating a rope node for every character.
      const start = this.index;
      let end = start;
      while (end < this.text.length) {
        const code = this.text.charCodeAt(end);
        if (code < 0x20 || code >= 0x80 || code === 0x22 || code === 0x5c) break;
        end++;
      }
      if (end > start) {
        out += this.text.slice(start, end);
        this.index = end;
        this.col += end - start;
      }
      const c = this.peek();
      if (c === undefined) throw this.error('EOF while parsing a string');
      if (c === '"') {
        this.advance();
        if (!this.bytes) return out;
        const raw = stringBytes(out);
        if (validUtf8Prefix(raw) !== null) throw this.error('invalid unicode code point');
        return UTF8.decode(raw);
      }
      if (c === '\\') {
        this.advance();
        const e = this.peek();
        if (e === undefined) throw this.error('EOF while parsing a string');
        this.advance();
        if (e === 'u') {
          const unit = this.hex4();
          if (unit >= 0xdc00 && unit <= 0xdfff) throw this.error('lone leading surrogate in hex escape');
          if (unit >= 0xd800 && unit <= 0xdbff) {
            for (const expected of '\\u') {
              if (this.peek() === undefined) throw this.error('EOF while parsing a string');
              if (this.peek() !== expected) { this.advance(); throw this.error('unexpected end of hex escape'); }
              this.advance();
            }
            const low = this.hex4();
            if (low < 0xdc00 || low > 0xdfff) throw this.error('lone leading surrogate in hex escape');
            out += this.bytes ? utf8Bytes(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)) : String.fromCharCode(unit, low);
          } else out += utf8(unit);
          continue;
        }
        const simple = ESCAPES.get(e);
        if (simple === undefined) throw this.error('invalid escape');
        out += simple;
        continue;
      }
      const code = this.text.codePointAt(this.index)!;
      this.advance();
      if (code < 0x20) throw this.error('control character (\\u0000-\\u001F) found while parsing a string');
      out += this.bytes ? c : String.fromCodePoint(code);
    }
  }

  private hex4(): number {
    const value = this.hexEscape();
    if (value === null) throw this.error('invalid escape');
    return value;
  }

  /**
   * SliceRead::decode_hex_escape（read.rs:621-635）：剩余不足 4 字节 → 消费到末尾报 EOF；
   * 否则先消费 4 个字节再判 hex，非法返回 null（调用方在其后位置报 invalid escape）。
   * 字符串模式下按 UTF-8 字节计数，跨越 4 字节边界的多字节字符只计入已读部分。
   */
  private hexEscape(): number | null {
    let remaining = 0;
    for (let i = this.index; i < this.text.length && remaining < 4;) {
      const code = this.bytes ? 0 : this.text.codePointAt(i)!;
      remaining += this.bytes ? 1 : utf8Len(code);
      i += code > 0xffff ? 2 : 1;
    }
    if (remaining < 4) {
      while (this.index < this.text.length) this.advance();
      throw this.error('EOF while parsing a string');
    }
    let value = 0;
    let valid = true;
    for (let consumed = 0; consumed < 4;) {
      const c = this.peek()!;
      const width = this.bytes ? 1 : utf8Len(this.text.codePointAt(this.index)!);
      if (consumed + width > 4) { this.col += 4 - consumed; valid = false; break; }
      this.advance();
      consumed += width;
      if (/^[0-9a-fA-F]$/.test(c)) value = value * 16 + parseInt(c, 16);
      else valid = false;
    }
    return valid ? value : null;
  }
}

const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** 每字节一个 UTF-16 单元的二进制串（不做 UTF-8 解释）。 */
function byteString(input: Uint8Array): string {
  let out = '';
  for (let i = 0; i < input.length; i += 0x8000) out += String.fromCharCode(...input.subarray(i, i + 0x8000));
  return out;
}

function stringBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** push_wtf8_codepoint（read.rs:985-1022）写成二进制串；代理项已在调用前拒绝。 */
function utf8Bytes(code: number): string {
  if (code < 0x80) return String.fromCharCode(code);
  if (code < 0x800) return String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  if (code < 0x10000) return String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  return String.fromCharCode(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
}

/** `serde_json::from_str::<Value>` with arbitrary_precision：保留 raw 数字，读取整个文档并检查尾随字符。 */
export function parseJsonDocument(text: string): JsonNode {
  const reader = new JsonReader(text);
  const root = reader.readValue();
  reader.end();
  return root;
}

/**
 * `serde_json::from_slice::<Value>`（de.rs:2657 → from_trait:2497）：按 SliceRead 顺序读字节，
 * 不先整体校验 UTF-8。字符串（含键）在闭合引号后 `as_str` 报 `invalid unicode code point`；
 * 字符串外的非 ASCII 字节按语法错误报；位置 column 为当前行字节数。BOM 不剥离。
 */
export function parseJsonDocumentBytes(bytes: Uint8Array): JsonNode {
  const reader = JsonReader.fromSlice(bytes);
  const root = reader.readValue();
  reader.end();
  return root;
}

/** `serde_json::Value` / map 语义：重复键 last-wins，键位置取首次出现（preserve_order 的 IndexMap::insert）。 */
export function objectLastWins(node: JsonNode & { kind: 'object' }): Map<string, JsonNode> {
  const map = new Map<string, JsonNode>();
  for (const member of node.members) map.set(member.key, member.value);
  return map;
}
