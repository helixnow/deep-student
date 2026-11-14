import type { NativeOfficeText } from './api.ts';

const trim = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

function decodeTextBytes(bytes: Uint8Array): string {
  // document_parser.rs::decode_text_bytes, encoding_rs BOM priority.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  for (const encoding of ['utf-8', 'gb18030', 'big5', 'shift_jis']) {
    try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (error) {
      // encoding_rs decode_without_bom_handling's had_errors means try the next codec.
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** csv-core 0.1.13 reader.rs::transition_nfa, ReaderBuilder's default dialect.
 * flexible(true): unmatched quotes and unequal field counts are accepted by Rust.
 */
export function parseCsvRecords(text: string): string[][] {
  if (text.startsWith('\ufeff')) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'record' | 'field' | 'unquoted' | 'quoted' | 'after-quote' = 'record';
  for (const c of text) {
    const terminator = c === '\r' || c === '\n';
    if (state === 'record') {
      if (terminator) continue;
      state = 'field';
    }
    if (state === 'quoted') {
      if (c === '"') state = 'after-quote';
      else field += c;
      continue;
    }
    if (state === 'after-quote' && c === '"') {
      field += c;
      state = 'quoted';
      continue;
    }
    if (state === 'field' && c === '"') {
      state = 'quoted';
    } else if (c === ',') {
      row.push(field);
      field = '';
      state = 'field';
    } else if (terminator) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      state = 'record';
    } else {
      field += c;
      state = 'unquoted';
    }
  }
  if (state !== 'record') { row.push(field); rows.push(row); }
  return rows;
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.length > 200 * 1024 * 1024) {
    const detail = `文件大小 ${Math.floor(bytes.length / (1024 * 1024))}MB 超过限制 200MB`;
    const error = new Error(`文件过大: ${detail}`);
    error.name = 'FileTooLarge';
    throw error;
  }
}

export const officeText: NativeOfficeText = {
  decodeTextBytes,
  extractPlainText(bytes) {
    checkSize(bytes);
    return trim(decodeTextBytes(bytes));
  },
  extractCsv(bytes) {
    checkSize(bytes);
    return trim(parseCsvRecords(decodeTextBytes(bytes)).map(row => row.join('\t') + '\n').join(''));
  },
};
