/**
 * `serde_json::from_slice::<T>` for `#[derive(Deserialize)]` structs, ported as a
 * streaming byte reader so error priority and positions match Rust.
 *
 * Sources (read, not executed; versions from src-tauri/Cargo.lock):
 * - serde_json 1.0.149 `de.rs` / `read.rs` (`SliceRead`) / `error.rs`, with the
 *   `arbitrary_precision` feature that dstu-sync/Cargo.toml:38 enables;
 * - serde_derive 1.0.228 `de/struct_.rs` (map visitor) and `de.rs::deserialize_seq`;
 * - serde_core 1.0.228 `de/impls.rs` (u32/u64 visitors), zmij 1.0.21 (float text);
 * - chrono 0.4.41 `datetime/serde.rs` (`DateTime<Utc>` visitor `expecting`).
 *
 * Values are decoded while the bytes are read: a type error, `duplicate field`
 * or `missing field` is reported before any later syntax error or trailing
 * characters, exactly like the Rust streaming deserializer. Positions use
 * serde_json's byte-based columns (`position_of_index`).
 */

import { parseRfc3339, toRfc3339Opts } from '../../../platform/time/index.ts';

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I64_MIN_MAGNITUDE = 0x8000_0000_0000_0000n;

/** A serde_json `Error`. `line === 0` means "not positioned yet" (data errors). */
export class SerdeJsonError extends Error {
  readonly code: string;
  readonly line: number;
  readonly column: number;

  constructor(code: string, line: number, column: number) {
    super(line === 0 ? code : `${code} at line ${line} column ${column}`);
    this.name = 'SerdeJsonError';
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

/** serde_json `ParserNumber`; `Other` is the arbitrary_precision `String` arm. */
type ParserNumber =
  | { kind: 'U64'; value: bigint }
  | { kind: 'I64'; value: bigint }
  | { kind: 'F64'; value: number }
  | { kind: 'Other' };

const isDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const isEscape = (byte: number): boolean => byte === 0x22 || byte === 0x5c || byte < 0x20;

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return -1;
}

function pushCodePoint(out: number[], n: number): void {
  if (n < 0x80) out.push(n);
  else if (n < 0x800) out.push(0xc0 | (n >> 6), 0x80 | (n & 0x3f));
  else if (n < 0x10000) out.push(0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f));
  else out.push(0xf0 | (n >> 18), 0x80 | ((n >> 12) & 0x3f), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f));
}

/** zmij 1.0.21 `Buffer::format` for a finite f64 (serde_json `JsonUnexpected::Float`). */
export function formatF64(value: number): string {
  if (value === 0) return Object.is(value, -0) ? '-0.0' : '0.0';
  const sign = value < 0 ? '-' : '';
  const [mantissa, exponentText] = Math.abs(value).toExponential().split('e') as [string, string];
  const digits = mantissa.replace('.', '');
  const exp = Number(exponentText);
  const length = digits.length;
  if (exp >= -5 && exp <= 15) {
    if (length - 1 <= exp) return `${sign}${digits}${'0'.repeat(exp + 1 - length)}.0`;
    if (exp >= 0) return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
    return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  const fraction = length > 1 ? `.${digits.slice(1)}` : '';
  return `${sign}${digits[0]}${fraction}e${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`;
}

/**
 * Rust `<str as Debug>`. Printable/grapheme tables are approximated with Unicode
 * general categories; ASCII, CJK and emoji (the realistic payloads) are exact.
 */
export function rustDebugString(value: string): string {
  let out = '"';
  let first = true;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '\t') out += '\\t';
    else if (char === '\r') out += '\\r';
    else if (char === '\n') out += '\\n';
    else if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\0') out += '\\0';
    else if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(char) || (/\p{Zs}/u.test(char) && char !== ' ')
      || (first && /\p{Grapheme_Extend}/u.test(char))) out += `\\u{${code.toString(16)}}`;
    else out += char;
    first = false;
  }
  return `${out}"`;
}

function unexpectedNumber(number: ParserNumber): string {
  if (number.kind === 'F64') return `floating point \`${formatF64(number.value)}\``;
  if (number.kind === 'Other') return 'number';
  return `integer \`${number.value}\``;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** serde_json `Deserializer<SliceRead>` restricted to what derive structs use. */
export class Deserializer {
  private index = 0;
  private readonly slice: Uint8Array;

  constructor(slice: Uint8Array) {
    this.slice = slice;
  }

  // ---------------------------------------------------------------- positions

  private positionOf(index: number): [number, number] {
    let line = 1;
    let startOfLine = 0;
    for (let i = 0; i < index; i++) {
      if (this.slice[i] === 0x0a) { line += 1; startOfLine = i + 1; }
    }
    return [line, index - startOfLine];
  }

  /** `self.error(code)`: position of the next unread byte. */
  error(code: string): SerdeJsonError {
    const [line, column] = this.positionOf(this.index);
    return new SerdeJsonError(code, line, column);
  }

  /** `self.peek_error(code)`: SliceRead reports one byte past the peeked byte. */
  peekError(code: string): SerdeJsonError {
    const [line, column] = this.positionOf(Math.min(this.slice.length, this.index + 1));
    return new SerdeJsonError(code, line, column);
  }

  /** `de::Error::custom` / `invalid_type` / ...: positioned later by `fixPosition`. */
  static data(message: string): SerdeJsonError {
    return new SerdeJsonError(message, 0, 0);
  }

  fixPosition(error: unknown): unknown {
    return error instanceof SerdeJsonError && error.line === 0 ? this.error(error.code) : error;
  }

  // ---------------------------------------------------------------- bytes

  private peek(): number | undefined { return this.slice[this.index]; }
  private eat(): void { this.index += 1; }
  private next(): number | undefined {
    const byte = this.slice[this.index];
    if (byte !== undefined) this.index += 1;
    return byte;
  }

  parseWhitespace(): number | undefined {
    for (;;) {
      const byte = this.peek();
      if (byte === 0x20 || byte === 0x0a || byte === 0x09 || byte === 0x0d) this.eat();
      else return byte;
    }
  }

  private parseIdent(rest: string): void {
    for (let i = 0; i < rest.length; i++) {
      const byte = this.next();
      if (byte === undefined) throw this.error('EOF while parsing a value');
      if (byte !== rest.charCodeAt(i)) throw this.error('expected ident');
    }
  }

  // ---------------------------------------------------------------- strings

  private skipToEscape(): void {
    while (this.index < this.slice.length && !isEscape(this.slice[this.index]!)) this.index += 1;
  }

  private decodeHexEscape(): number {
    if (this.slice.length - this.index < 4) {
      this.index = this.slice.length;
      throw this.error('EOF while parsing a string');
    }
    let value = 0;
    let valid = true;
    for (let i = 0; i < 4; i++) {
      const digit = hexValue(this.slice[this.index + i]!);
      if (digit < 0) valid = false;
      value = value * 16 + Math.max(digit, 0);
    }
    this.index += 4;
    if (!valid) throw this.error('invalid escape');
    return value;
  }

  private peekOrEofInString(): number {
    const byte = this.peek();
    if (byte === undefined) throw this.error('EOF while parsing a string');
    return byte;
  }

  private parseUnicodeEscape(out: number[]): void {
    const n = this.decodeHexEscape();
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error('lone leading surrogate in hex escape');
    if (n < 0xd800 || n > 0xdbff) { pushCodePoint(out, n); return; }
    if (this.peekOrEofInString() === 0x5c) this.eat();
    else { this.eat(); throw this.error('unexpected end of hex escape'); }
    if (this.peekOrEofInString() === 0x75) this.eat();
    else { this.eat(); throw this.error('unexpected end of hex escape'); }
    const n2 = this.decodeHexEscape();
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error('lone leading surrogate in hex escape');
    pushCodePoint(out, (((n - 0xd800) << 10) | (n2 - 0xdc00)) + 0x10000);
  }

  private parseEscape(out: number[]): void {
    const byte = this.next();
    if (byte === undefined) throw this.error('EOF while parsing a string');
    switch (byte) {
      case 0x22: out.push(0x22); return;
      case 0x5c: out.push(0x5c); return;
      case 0x2f: out.push(0x2f); return;
      case 0x62: out.push(0x08); return;
      case 0x66: out.push(0x0c); return;
      case 0x6e: out.push(0x0a); return;
      case 0x72: out.push(0x0d); return;
      case 0x74: out.push(0x09); return;
      case 0x75: this.parseUnicodeEscape(out); return;
      default: throw this.error('invalid escape');
    }
  }

  /** `SliceRead::parse_str` after the opening quote; UTF-8 checked at the close. */
  private parseStr(): string {
    const scratch: number[] = [];
    let start = this.index;
    for (;;) {
      this.skipToEscape();
      if (this.index === this.slice.length) throw this.error('EOF while parsing a string');
      const byte = this.slice[this.index]!;
      if (byte === 0x22) {
        for (let i = start; i < this.index; i++) scratch.push(this.slice[i]!);
        this.index += 1;
        try { return utf8.decode(Uint8Array.from(scratch)); }
        catch { throw this.error('invalid unicode code point'); }
      }
      if (byte === 0x5c) {
        for (let i = start; i < this.index; i++) scratch.push(this.slice[i]!);
        this.index += 1;
        this.parseEscape(scratch);
        start = this.index;
        continue;
      }
      this.index += 1;
      throw this.error('control character (\\u0000-\\u001F) found while parsing a string');
    }
  }

  /** `SliceRead::ignore_str`: escapes are checked, UTF-8 is not. */
  private ignoreStr(): void {
    for (;;) {
      this.skipToEscape();
      if (this.index === this.slice.length) throw this.error('EOF while parsing a string');
      const byte = this.slice[this.index]!;
      if (byte === 0x22) { this.index += 1; return; }
      if (byte === 0x5c) {
        this.index += 1;
        const escaped = this.next();
        if (escaped === undefined) throw this.error('EOF while parsing a string');
        if (escaped === 0x75) this.decodeHexEscape();
        else if (!'"\\/bfnrt'.includes(String.fromCharCode(escaped))) throw this.error('invalid escape');
        continue;
      }
      throw this.error('control character (\\u0000-\\u001F) found while parsing a string');
    }
  }

  // ---------------------------------------------------------------- numbers

  /** Remaining fraction/exponent of an F64 token; returns the parsed value. */
  private finishFloat(start: number): number {
    if (this.peek() === 0x2e) {
      this.eat();
      let digits = 0;
      while (isDigit(this.peek())) { this.eat(); digits += 1; }
      if (digits === 0) {
        throw this.peek() === undefined
          ? this.peekError('EOF while parsing a value')
          : this.peekError('invalid number');
      }
    }
    if (this.peek() === 0x65 || this.peek() === 0x45) {
      this.eat();
      if (this.peek() === 0x2b || this.peek() === 0x2d) this.eat();
      const first = this.next();
      if (first === undefined) throw this.error('EOF while parsing a value');
      if (!isDigit(first)) throw this.error('invalid number');
      while (isDigit(this.peek())) this.eat();
    }
    const value = Number(new TextDecoder().decode(this.slice.subarray(start, this.index)));
    if (!Number.isFinite(value)) throw this.error('number out of range');
    return value;
  }

  /** `parse_integer` (used by `deserialize_number`, i.e. u32/u64 fields). */
  private parseInteger(positive: boolean, start: number): ParserNumber {
    const first = this.next();
    if (first === undefined) throw this.error('EOF while parsing a value');
    let significand: bigint;
    if (first === 0x30) {
      if (isDigit(this.peek())) throw this.peekError('invalid number');
      significand = 0n;
    } else if (isDigit(first)) {
      significand = BigInt(first - 0x30);
      while (isDigit(this.peek())) {
        const next = significand * 10n + BigInt(this.peek()! - 0x30);
        if (next > U64_MAX) {
          while (isDigit(this.peek())) this.eat();
          return { kind: 'F64', value: this.finishFloat(start) };
        }
        this.eat();
        significand = next;
      }
    } else {
      throw this.error('invalid number');
    }
    const peek = this.peek();
    if (peek === 0x2e || peek === 0x65 || peek === 0x45) return { kind: 'F64', value: this.finishFloat(start) };
    if (positive) return { kind: 'U64', value: significand };
    // `(significand as i64).wrapping_neg() >= 0` → F64: `-0` and below i64::MIN.
    if (significand === 0n || significand > I64_MIN_MAGNITUDE) return { kind: 'F64', value: -Number(significand) };
    return { kind: 'I64', value: -significand };
  }

  /** arbitrary_precision `parse_any_number` (only reached from `peek_invalid_type`). */
  private parseAnyNumber(positive: boolean, start: number): ParserNumber {
    const first = this.next();
    if (first === undefined) throw this.error('EOF while parsing a value');
    if (first === 0x30) {
      if (isDigit(this.peek())) throw this.peekError('invalid number');
    } else if (isDigit(first)) {
      while (isDigit(this.peek())) this.eat();
    } else {
      throw this.error('invalid number');
    }
    if (this.peek() === 0x2e) {
      this.eat();
      let digits = 0;
      while (isDigit(this.peek())) { this.eat(); digits += 1; }
      if (digits === 0) {
        throw this.peek() === undefined
          ? this.peekError('EOF while parsing a value')
          : this.peekError('invalid number');
      }
    }
    if (this.peek() === 0x65 || this.peek() === 0x45) {
      this.eat();
      if (this.peek() === 0x2b || this.peek() === 0x2d) this.eat();
      const digit = this.next();
      if (digit === undefined) throw this.error('EOF while parsing a value');
      if (!isDigit(digit)) throw this.error('invalid number');
      while (isDigit(this.peek())) this.eat();
    }
    const text = new TextDecoder().decode(this.slice.subarray(start, this.index));
    if (/^-?[0-9]+$/.test(text)) {
      const value = BigInt(text);
      if (positive && value <= U64_MAX) return { kind: 'U64', value };
      if (!positive && -value <= I64_MIN_MAGNITUDE) return { kind: 'I64', value };
    }
    return { kind: 'Other' };
  }

  private ignoreInteger(): void {
    const first = this.next();
    if (first === 0x30) {
      if (isDigit(this.peek())) throw this.peekError('invalid number');
    } else if (isDigit(first)) {
      while (isDigit(this.peek())) this.eat();
    } else {
      throw this.error('invalid number');
    }
    if (this.peek() === 0x2e) {
      this.eat();
      let digits = 0;
      while (isDigit(this.peek())) { this.eat(); digits += 1; }
      if (digits === 0) throw this.peekError('invalid number');
    }
    if (this.peek() === 0x65 || this.peek() === 0x45) {
      this.eat();
      if (this.peek() === 0x2b || this.peek() === 0x2d) this.eat();
      if (!isDigit(this.next())) throw this.error('invalid number');
      while (isDigit(this.peek())) this.eat();
    }
  }

  // ---------------------------------------------------------------- errors

  /** `peek_invalid_type`: consumes scalars (not `[`/`{`) before reporting. */
  peekInvalidType(expected: string): SerdeJsonError {
    const byte = this.peek() ?? 0;
    let unexpected: string;
    switch (byte) {
      case 0x6e: this.eat(); this.parseIdent('ull'); unexpected = 'null'; break;
      case 0x74: this.eat(); this.parseIdent('rue'); unexpected = 'boolean `true`'; break;
      case 0x66: this.eat(); this.parseIdent('alse'); unexpected = 'boolean `false`'; break;
      case 0x2d: {
        const start = this.index;
        this.eat();
        unexpected = unexpectedNumber(this.parseAnyNumber(false, start));
        break;
      }
      case 0x22: this.eat(); unexpected = `string ${rustDebugString(this.parseStr())}`; break;
      case 0x5b: unexpected = 'sequence'; break;
      case 0x7b: unexpected = 'map'; break;
      default:
        if (isDigit(byte)) { unexpected = unexpectedNumber(this.parseAnyNumber(true, this.index)); break; }
        return this.peekError('expected value');
    }
    return Deserializer.data(`invalid type: ${unexpected}, expected ${expected}`);
  }

  // ---------------------------------------------------------------- data model

  /** serde_json `deserialize_bool`, serde_core `BoolVisitor` (de/impls.rs:53-75). */
  deserializeBool(): boolean {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing a value');
    try {
      if (peek === 0x74) { this.eat(); this.parseIdent('rue'); return true; }
      if (peek === 0x66) { this.eat(); this.parseIdent('alse'); return false; }
      throw this.peekInvalidType('a boolean');
    } catch (error) {
      throw this.fixPosition(error);
    }
  }

  /** `deserialize_str` with a visitor that maps the string (String / DateTime). */
  deserializeStr<T>(expected: string, visit: (value: string) => T): T {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing a value');
    try {
      if (peek !== 0x22) throw this.peekInvalidType(expected);
      this.eat();
      return visit(this.parseStr());
    } catch (error) {
      throw this.fixPosition(error);
    }
  }

  /** `deserialize_number` with a visitor over `ParserNumber`. */
  deserializeNumber<T>(expected: string, visit: (number: ParserNumber) => T): T {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing a value');
    try {
      if (peek === 0x2d) {
        const start = this.index;
        this.eat();
        return visit(this.parseInteger(false, start));
      }
      if (isDigit(peek)) return visit(this.parseInteger(true, this.index));
      throw this.peekInvalidType(expected);
    } catch (error) {
      throw this.fixPosition(error);
    }
  }

  /** `deserialize_option`: `null` → None, anything else → `visit_some`. */
  deserializeOption<T>(visitSome: () => T): T | undefined {
    if (this.parseWhitespace() === 0x6e) {
      this.eat();
      this.parseIdent('ull');
      return undefined;
    }
    return visitSome();
  }

  /** `SeqAccess::has_next_element`. */
  hasNextElement(state: { first: boolean }): boolean {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing a list');
    if (peek === 0x5d) return false;
    if (state.first) { state.first = false; return true; }
    if (peek === 0x2c) {
      this.eat();
      const after = this.parseWhitespace();
      if (after === 0x5d) throw this.peekError('trailing comma');
      if (after === undefined) throw this.peekError('EOF while parsing a value');
      return true;
    }
    throw this.peekError('expected `,` or `]`');
  }

  /** `MapAccess::next_key_seed` for a field identifier; null at `}`. */
  nextKey(state: { first: boolean }): string | null {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing an object');
    if (peek === 0x7d) return null;
    if (state.first) {
      state.first = false;
      if (peek !== 0x22) throw this.peekError('key must be a string');
    } else if (peek === 0x2c) {
      this.eat();
      const after = this.parseWhitespace();
      if (after === 0x7d) throw this.peekError('trailing comma');
      if (after === undefined) throw this.peekError('EOF while parsing a value');
      if (after !== 0x22) throw this.peekError('key must be a string');
    } else {
      throw this.peekError('expected `,` or `}`');
    }
    this.eat();
    return this.parseStr();
  }

  /** `parse_object_colon` (start of `next_value_seed`). */
  parseObjectColon(): void {
    const peek = this.parseWhitespace();
    if (peek === 0x3a) { this.eat(); return; }
    throw this.peekError(peek === undefined ? 'EOF while parsing an object' : 'expected `:`');
  }

  private endSeq(): void {
    const peek = this.parseWhitespace();
    if (peek === 0x5d) { this.eat(); return; }
    if (peek === 0x2c) {
      this.eat();
      throw this.peekError(this.parseWhitespace() === 0x5d ? 'trailing comma' : 'trailing characters');
    }
    throw this.peekError(peek === undefined ? 'EOF while parsing a list' : 'trailing characters');
  }

  private endMap(): void {
    const peek = this.parseWhitespace();
    if (peek === 0x7d) { this.eat(); return; }
    if (peek === 0x2c) throw this.peekError('trailing comma');
    throw this.peekError(peek === undefined ? 'EOF while parsing an object' : 'trailing characters');
  }

  /**
   * `deserialize_seq` / `deserialize_struct` body: the visitor runs, then
   * `end_seq`/`end_map` always runs (its side effects move the position used to
   * fix a positionless visitor error), and the visitor error wins.
   */
  private container<T>(visitSeq: (() => T) | null, visitMap: (() => T) | null, expected: string): T {
    const peek = this.parseWhitespace();
    if (peek === undefined) throw this.peekError('EOF while parsing a value');
    let result: T | undefined;
    let failure: unknown = null;
    if (peek === 0x5b && visitSeq !== null) {
      this.eat();
      try { result = visitSeq(); } catch (error) { failure = error; }
      try { this.endSeq(); } catch (error) { failure ??= error; }
    } else if (peek === 0x7b && visitMap !== null) {
      this.eat();
      try { result = visitMap(); } catch (error) { failure = error; }
      try { this.endMap(); } catch (error) { failure ??= error; }
    } else {
      try { failure = this.peekInvalidType(expected); } catch (error) { failure = error; }
    }
    if (failure !== null) throw this.fixPosition(failure);
    return result as T;
  }

  deserializeSeq<T>(expected: string, visitSeq: () => T): T {
    return this.container(visitSeq, null, expected);
  }

  deserializeStruct<T>(name: string, visitSeq: () => T, visitMap: () => T): T {
    return this.container(visitSeq, visitMap, `struct ${name}`);
  }

  /** `ignore_value` (`IgnoredAny`). */
  ignoreValue(): void {
    const frames: number[] = [];
    let enclosing: number | null = null;
    for (;;) {
      const peek = this.parseWhitespace();
      if (peek === undefined) throw this.peekError('EOF while parsing a value');
      let frame: number | null = null;
      switch (peek) {
        case 0x6e: this.eat(); this.parseIdent('ull'); break;
        case 0x74: this.eat(); this.parseIdent('rue'); break;
        case 0x66: this.eat(); this.parseIdent('alse'); break;
        case 0x2d: this.eat(); this.ignoreInteger(); break;
        case 0x22: this.eat(); this.ignoreStr(); break;
        case 0x5b: case 0x7b:
          if (enclosing !== null) frames.push(enclosing);
          enclosing = null;
          this.eat();
          frame = peek;
          break;
        default:
          if (isDigit(peek)) { this.ignoreInteger(); break; }
          throw this.peekError('expected value');
      }
      let acceptComma: boolean;
      let current: number;
      if (frame !== null) {
        acceptComma = false;
        current = frame;
      } else if (enclosing !== null) {
        acceptComma = true;
        current = enclosing;
        enclosing = null;
      } else {
        const popped = frames.pop();
        if (popped === undefined) return;
        acceptComma = true;
        current = popped;
      }
      for (;;) {
        const next = this.parseWhitespace();
        if (next === 0x2c && acceptComma) { this.eat(); break; }
        const closes = (next === 0x5d && current === 0x5b) || (next === 0x7d && current === 0x7b);
        if (!closes) {
          if (next === undefined) {
            throw this.peekError(current === 0x5b ? 'EOF while parsing a list' : 'EOF while parsing an object');
          }
          if (acceptComma) throw this.peekError(current === 0x5b ? 'expected `,` or `]`' : 'expected `,` or `}`');
          break;
        }
        this.eat();
        const popped = frames.pop();
        if (popped === undefined) return;
        current = popped;
        acceptComma = true;
      }
      if (current === 0x7b) {
        const key = this.parseWhitespace();
        if (key === undefined) throw this.peekError('EOF while parsing an object');
        if (key !== 0x22) throw this.peekError('key must be a string');
        this.eat();
        this.ignoreStr();
        const colon = this.parseWhitespace();
        if (colon === undefined) throw this.peekError('EOF while parsing an object');
        if (colon !== 0x3a) throw this.peekError('expected `:`');
        this.eat();
      }
      enclosing = current;
    }
  }

  /** `Deserializer::end`. */
  end(): void {
    if (this.parseWhitespace() !== undefined) throw this.peekError('trailing characters');
  }
}

// -------------------------------------------------------------------- visitors

export function decodeString(de: Deserializer): string {
  return de.deserializeStr('a string', value => value);
}

export function decodeBool(de: Deserializer): boolean {
  return de.deserializeBool();
}

function unsignedVisitor(max: bigint, rustType: string): (number: ParserNumber) => bigint {
  return number => {
    if (number.kind === 'U64') {
      if (number.value <= max) return number.value;
      throw Deserializer.data(`invalid value: integer \`${number.value}\`, expected ${rustType}`);
    }
    if (number.kind === 'I64') {
      if (number.value >= 0n && number.value <= max) return number.value;
      throw Deserializer.data(`invalid value: integer \`${number.value}\`, expected ${rustType}`);
    }
    throw Deserializer.data(`invalid type: ${unexpectedNumber(number)}, expected ${rustType}`);
  };
}

export function decodeU32(de: Deserializer): number {
  return Number(de.deserializeNumber('u32', unsignedVisitor(0xffff_ffffn, 'u32')));
}

export function decodeU64(de: Deserializer): bigint {
  return de.deserializeNumber('u64', unsignedVisitor(U64_MAX, 'u64'));
}

/**
 * chrono `DateTime<Utc>`: `deserialize_str`, re-serialized like chrono (`AutoSi`, `Z`).
 * Known gap: chrono's `FromStr` is `parse_rfc3339_relaxed` (spaces, `UTC`, flexible
 * widths) with its own `ParseError` text; this uses strict `parse_from_rfc3339`.
 */
export function decodeUtcTimestamp(de: Deserializer, field: string): string {
  return de.deserializeStr('an RFC 3339 formatted date and time string', raw => {
    const parsed = parseRfc3339(raw);
    if (parsed === null) {
      throw Deserializer.data(
        `invalid value: ${JSON.stringify(raw)}, expected an RFC 3339 timestamp for \`${field}\``);
    }
    return toRfc3339Opts(parsed.epochNanos, 'AutoSi', true);
  });
}

/** `Option<T>`: JSON `null` is `None`. */
export function decodeOption<T>(de: Deserializer, decode: (de: Deserializer) => T): T | undefined {
  return de.deserializeOption(() => decode(de));
}

/** `Vec<T>`. */
export function decodeSeq<T>(de: Deserializer, decode: (de: Deserializer) => T): T[] {
  return de.deserializeSeq('a sequence', () => {
    const out: T[] = [];
    const state = { first: true };
    while (de.hasNextElement(state)) out.push(decode(de));
    return out;
  });
}

export interface FieldSpec<T> {
  readonly decode: (de: Deserializer) => T;
  /** `#[serde(default)]`: value used when the field is absent. */
  readonly default?: () => T;
}

type Decoded<F> = { [K in keyof F]: F[K] extends FieldSpec<infer T> ? T : never };

/** `#[derive(Deserialize)] struct <name>`; `fields` in declaration order (wire names). */
export function decodeStruct<F extends Record<string, FieldSpec<unknown>>>(
  de: Deserializer,
  name: string,
  fields: F,
): Decoded<F> {
  const names = Object.keys(fields);
  const visitSeq = (): Decoded<F> => {
    const out: Record<string, unknown> = {};
    const state = { first: true };
    const expecting = `struct ${name} with ${names.length} element${names.length === 1 ? '' : 's'}`;
    names.forEach((field, index) => {
      if (de.hasNextElement(state)) { out[field] = fields[field]!.decode(de); return; }
      const fallback = fields[field]!.default;
      if (fallback === undefined) throw Deserializer.data(`invalid length ${index}, expected ${expecting}`);
      out[field] = fallback();
    });
    return out as Decoded<F>;
  };
  const visitMap = (): Decoded<F> => {
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    const state = { first: true };
    for (let key = de.nextKey(state); key !== null; key = de.nextKey(state)) {
      if (Object.hasOwn(fields, key)) {
        if (seen.has(key)) throw Deserializer.data(`duplicate field \`${key}\``);
        de.parseObjectColon();
        out[key] = fields[key]!.decode(de);
        seen.add(key);
      } else {
        de.parseObjectColon();
        de.ignoreValue();
      }
    }
    for (const field of names) {
      if (seen.has(field)) continue;
      const fallback = fields[field]!.default;
      if (fallback === undefined) throw Deserializer.data(`missing field \`${field}\``);
      out[field] = fallback();
    }
    return out as Decoded<F>;
  };
  return de.deserializeStruct(name, visitSeq, visitMap);
}

/** `serde_json::from_slice::<T>`: deserialize, then `end()`. Throws `SerdeJsonError`. */
export function fromSlice<T>(data: Uint8Array, decode: (de: Deserializer) => T): T {
  const de = new Deserializer(data);
  const value = decode(de);
  de.end();
  return value;
}
