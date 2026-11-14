/**
 * CSV 读写的底层语义，按 Rust 依赖逐条复刻（不引入新依赖）：
 *
 * - `question_import_service.rs:4490 read_file_with_encoding`：严格 UTF-8（去 BOM）→
 *   `encoding_rs::GBK.decode`（`!had_errors` 才采用）→ `encoding_rs::GB18030.decode` 兜底。
 *   `Encoding::decode` 先做 BOM 嗅探（UTF-8 / UTF-16LE / UTF-16BE），嗅到即按 BOM 编码解码。
 *   encoding_rs 的 GBK 解码器即 WHATWG gb18030 解码器；这里用平台 ICU 的 WHATWG
 *   `TextDecoder('gbk' | 'gb18030')`。
 * - `csv::ReaderBuilder::new().flexible(true).has_headers(true)`（csv 1.x / csv-core）：
 *   分隔符 `,`、引号 `"`、双引号转义、`\r` / `\n` / `\r\n` 都是记录终止符、空行跳过、
 *   允许每行字段数不同、开头 UTF-8 BOM 剥离；未闭合引号在 EOF 处结束字段（不报错）。
 * - `question_export_service.rs:401 write_csv_row` 的 `encoding_rs::GBK.encode`：
 *   WHATWG GBK 编码器（ASCII 单字节、U+20AC→0x80、U+E5E5 与无映射字符为错误）。
 *   编码表从同一 ICU 解码器按 pointer 升序反推，取每个码点的首个 pointer
 *   （= WHATWG “index gb18030 pointer”）。
 */

export interface DecodedCsvText {
  content: string;
  encoding: string;
}

interface EncodingRsDecode {
  text: string;
  hadErrors: boolean;
}

function decodeWith(label: string, bytes: Uint8Array): EncodingRsDecode {
  try {
    return { text: new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes), hadErrors: false };
  } catch {
    return { text: new TextDecoder(label, { fatal: false, ignoreBOM: true }).decode(bytes), hadErrors: true };
  }
}

/** `encoding_rs::Encoding::decode`：BOM 嗅探优先，否则按本编码解码。 */
function encodingRsDecode(label: 'gbk' | 'gb18030', bytes: Uint8Array): EncodingRsDecode {
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return decodeWith('utf-8', bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return decodeWith('utf-16le', bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return decodeWith('utf-16be', bytes.subarray(2));
  }
  return decodeWith(label, bytes);
}

/** `read_file_with_encoding` 的解码部分（文件读取与路径校验在调用方）。 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsvText {
  const utf8 = decodeWith('utf-8', bytes);
  if (!utf8.hadErrors) {
    const content = utf8.text.startsWith('﻿') ? utf8.text.slice(1) : utf8.text;
    return { content, encoding: 'UTF-8' };
  }
  const gbk = encodingRsDecode('gbk', bytes);
  if (!gbk.hadErrors) return { content: gbk.text, encoding: 'GBK' };
  return { content: encodingRsDecode('gb18030', bytes).text, encoding: 'GB18030' };
}

/** csv-core 的默认 CRLF 终止符：`\r`、`\n` 各自终止；`\r\n` 只算一次。 */
function isTerminator(ch: string): boolean {
  return ch === '\n' || ch === '\r';
}

/**
 * `csv::Reader`（flexible + has_headers）读出的全部记录；第 0 条是表头。
 * 输入已是合法 Unicode 字符串，csv crate 的 UTF-8 / 字段数错误在该配置下不会出现。
 */
export function readCsvRecords(content: string): string[][] {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  type State = 'startRecord' | 'startField' | 'inField' | 'inQuoted' | 'quoteInQuoted';
  let state: State = 'startRecord';
  let skipLf = false;

  const endField = (): void => { record.push(field); field = ''; };
  const endRecord = (): void => { endField(); records.push(record); record = []; };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (skipLf) {
      skipLf = false;
      if (ch === '\n') continue;
    }
    switch (state) {
      case 'startRecord':
        if (isTerminator(ch)) {
          if (ch === '\r') skipLf = true;
          continue;
        }
        state = 'startField';
        i -= 1;
        continue;
      case 'startField':
        if (ch === '"') { state = 'inQuoted'; continue; }
        if (ch === ',') { endField(); continue; }
        if (isTerminator(ch)) {
          endRecord();
          state = 'startRecord';
          if (ch === '\r') skipLf = true;
          continue;
        }
        field += ch;
        state = 'inField';
        continue;
      case 'inField':
        if (ch === ',') { endField(); state = 'startField'; continue; }
        if (isTerminator(ch)) {
          endRecord();
          state = 'startRecord';
          if (ch === '\r') skipLf = true;
          continue;
        }
        field += ch;
        continue;
      case 'inQuoted':
        if (ch === '"') { state = 'quoteInQuoted'; continue; }
        field += ch;
        continue;
      case 'quoteInQuoted':
        if (ch === '"') { field += '"'; state = 'inQuoted'; continue; }
        if (ch === ',') { endField(); state = 'startField'; continue; }
        if (isTerminator(ch)) {
          endRecord();
          state = 'startRecord';
          if (ch === '\r') skipLf = true;
          continue;
        }
        field += ch;
        state = 'inField';
        continue;
    }
  }
  if (state !== 'startRecord') endRecord();
  return records;
}

let gbkTable: Map<number, number> | null = null;

function gbkEncodeTable(): Map<number, number> {
  if (gbkTable !== null) return gbkTable;
  const decoder = new TextDecoder('gbk', { fatal: false, ignoreBOM: true });
  const table = new Map<number, number>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xFE; lead += 1) {
    for (let trail = 0x40; trail <= 0xFE; trail += 1) {
      if (trail === 0x7F) continue;
      pair[0] = lead;
      pair[1] = trail;
      const text = decoder.decode(pair);
      const codePoint = text.codePointAt(0);
      if (codePoint === undefined || codePoint === 0xFFFD) continue;
      if (String.fromCodePoint(codePoint) !== text) continue;
      if (!table.has(codePoint)) table.set(codePoint, (lead << 8) | trail);
    }
  }
  gbkTable = table;
  return table;
}

/** `encoding_rs::GBK.encode`：返回 null 表示 `had_errors`（存在 GBK 不可表示的字符）。 */
export function encodeGbk(text: string): Uint8Array | null {
  const table = gbkEncodeTable();
  const out: number[] = [];
  for (const ch of text) {
    const codePoint = ch.codePointAt(0)!;
    if (codePoint < 0x80) { out.push(codePoint); continue; }
    if (codePoint === 0xE5E5) return null;
    if (codePoint === 0x20AC) { out.push(0x80); continue; }
    const bytes = table.get(codePoint);
    if (bytes === undefined) return null;
    out.push(bytes >> 8, bytes & 0xFF);
  }
  return Uint8Array.from(out);
}

const RUST_WHITESPACE = '\\t\\n\\v\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const RUST_TRIM = new RegExp(`^[${RUST_WHITESPACE}]+|[${RUST_WHITESPACE}]+$`, 'gu');

/** Rust `str::trim`（Unicode White_Space；不同于 JS trim，不含 U+FEFF、含 U+0085）。 */
export function rustTrim(value: string): string {
  return value.replace(RUST_TRIM, '');
}
