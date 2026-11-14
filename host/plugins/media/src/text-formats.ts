/**
 * `dstu-docs/src/document_parser.rs:4069-4153`: JSON and XML text extraction.
 *
 * - JSON: `serde_json::from_str::<Value>` (workspace `preserve_order`) followed by
 *   `serde_json::to_string_pretty`; parse failures return the lossy text trimmed.
 * - XML: quick-xml 0.37.5 `Reader::from_reader(Cursor)` with `trim_text(true)`
 *   (default features: no `encoding`, so text is strict UTF-8 after a leading BOM
 *   is skipped). Text/CDATA events are unescaped, trimmed and joined by one space;
 *   the first reader error stops the loop (logged as `XML解析错误: {e}`); no text
 *   at all returns the lossy original trimmed.
 */
import {
  decodeUtf8Lossy, jsonNumberToRawJSON, parseJsonDocument, type JsonNode, type JsonValueNumber,
} from '../../../platform/util/portable.ts';
import { rustTrim } from './transcript.ts';

/** Shared F4 Value-number spelling; `JSON.stringify` emits the raw JSON number atom. */
function numberText(number: JsonValueNumber): string {
  return JSON.stringify(jsonNumberToRawJSON(number));
}

function lossyUtf8(bytes: Uint8Array): string {
  return decodeUtf8Lossy(bytes);
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function strictUtf8(bytes: Uint8Array): string | null {
  try { return STRICT_UTF8.decode(bytes); }
  catch { return null; }
}

// ------------------------------------------------------------------ JSON

const HEX = '0123456789abcdef';

/** serde_json `format_escaped_str` (ESCAPE table: `"`, `\`, and all bytes < 0x20). */
function escapeJsonString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20) {
      switch (code) {
        case 0x08: out += '\\b'; break;
        case 0x09: out += '\\t'; break;
        case 0x0a: out += '\\n'; break;
        case 0x0c: out += '\\f'; break;
        case 0x0d: out += '\\r'; break;
        default: out += `\\u00${HEX[code >> 4]}${HEX[code & 0xf]}`;
      }
    } else out += ch;
  }
  return `${out}"`;
}

/** `serde_json::to_string_pretty` (PrettyFormatter, two-space indent). */
function prettyJson(node: JsonNode, indent: string): string {
  switch (node.kind) {
    case 'null': return 'null';
    case 'bool': return node.value ? 'true' : 'false';
    case 'string': return escapeJsonString(node.value);
    case 'number':
      // Value numbers are serialized from their raw token (arbitrary_precision); the
      // projected f64 value is not authoritative and may be absent for `1e400`.
      return numberText(node.value);
    case 'array': {
      if (node.items.length === 0) return '[]';
      const inner = `${indent}  `;
      return `[\n${node.items.map(item => inner + prettyJson(item, inner)).join(',\n')}\n${indent}]`;
    }
    case 'object': {
      // preserve_order Map: IndexMap::insert keeps the first position, last value wins.
      const members = new Map<string, JsonNode>();
      for (const member of node.members) members.set(member.key, member.value);
      if (members.size === 0) return '{}';
      const inner = `${indent}  `;
      const lines = [...members].map(([key, value]) =>
        `${inner}${escapeJsonString(key)}: ${prettyJson(value, inner)}`);
      return `{\n${lines.join(',\n')}\n${indent}}`;
    }
  }
}

/** `extract_json_from_bytes` (:4075) after the size check. */
export function extractJsonText(bytes: Uint8Array): string {
  const content = lossyUtf8(bytes);
  let root: JsonNode;
  try { root = parseJsonDocument(content); }
  catch { return rustTrim(content); }
  // to_string_pretty on a Value cannot fail; the Ok branch is returned untrimmed.
  return prettyJson(root, '');
}

// ------------------------------------------------------------------ XML

class XmlReadError extends Error {}

const LT = 0x3c, GT = 0x3e, BANG = 0x21, SLASH = 0x2f, QUESTION = 0x3f;
const isXmlWhitespace = (b: number) => b === 0x20 || b === 0x0d || b === 0x0a || b === 0x09;

function endsWithBytes(bytes: Uint8Array, end: number, suffix: readonly number[]): boolean {
  if (end < suffix.length) return false;
  for (let k = 0; k < suffix.length; k++) if (bytes[end - suffix.length + k] !== suffix[k]) return false;
  return true;
}

function startsWithAscii(bytes: Uint8Array, prefix: string, caseInsensitive = false): boolean {
  if (bytes.length < prefix.length) return false;
  for (let k = 0; k < prefix.length; k++) {
    let b = bytes[k]!, p = prefix.charCodeAt(k);
    if (caseInsensitive) {
      if (b >= 0x61 && b <= 0x7a) b -= 0x20;
      if (p >= 0x61 && p <= 0x7a) p -= 0x20;
    }
    if (b !== p) return false;
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** `ElementParser::Outside`: first `>` outside single/double quotes, or -1. */
function findElementEnd(bytes: Uint8Array, from: number): number {
  let quote = 0;
  for (let i = from; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (quote === 0) {
      if (b === GT) return i;
      if (b === 0x27 || b === 0x22) quote = b;
    } else if (b === quote) quote = 0;
  }
  return -1;
}

/** quick-xml `parse_number` (escape.rs:1823). */
function parseCharRef(num: string): string | null {
  const hex = num.startsWith('x');
  const digits = hex ? num.slice(1) : num;
  if (digits === '' || digits.startsWith('+') || digits.startsWith('-')) return null;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return null;
  const code = parseInt(digits, hex ? 16 : 10);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

const XML_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

/** quick-xml `unescape_with(resolve_predefined_entity)`; null on any EscapeError. */
function unescapeXml(raw: string): string | null {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp < 0) break;
    // memchr2 over `&`/`;`: the next delimiter after `&` must be `;`.
    let next = -1;
    for (let k = amp + 1; k < raw.length; k++) {
      if (raw[k] === '&' || raw[k] === ';') { next = k; break; }
    }
    if (next < 0 || raw[next] !== ';') return null;
    out += raw.slice(last, amp);
    const pat = raw.slice(amp + 1, next);
    if (pat.startsWith('#')) {
      const ch = parseCharRef(pat.slice(1));
      if (ch === null) return null;
      out += ch;
    } else {
      const value = XML_ENTITIES[pat];
      if (value === undefined) return null;
      out += value;
    }
    last = next + 1;
    i = next + 1;
  }
  return out + raw.slice(last);
}

function decodeName(bytes: Uint8Array): string {
  return strictUtf8(bytes) ?? '';
}

/** `extract_xml_from_bytes` (:4098) after the size check. */
export function extractXmlText(bytes: Uint8Array, warn: (message: string) => void): string {
  const parts: string[] = [];
  const push = (text: string) => {
    const trimmed = rustTrim(text);
    if (trimmed !== '') parts.push(trimmed);
  };
  const open: Uint8Array[] = [];
  let pos = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;

  const emitText = (start: number, end: number) => {
    let e = end;
    while (e > start && isXmlWhitespace(bytes[e - 1]!)) e--;   // trim_text_end
    if (e === start) return;
    const decoded = strictUtf8(bytes.subarray(start, e));
    if (decoded === null) return;                                // unescape() Err → skipped
    const text = unescapeXml(decoded);
    if (text !== null) push(text);
  };

  try {
    for (;;) {
      // ParseState::InsideText with trim_text_start.
      while (pos < bytes.length && isXmlWhitespace(bytes[pos]!)) pos++;
      const lt = bytes.indexOf(LT, pos);
      if (lt < 0) { emitText(pos, bytes.length); break; }
      if (lt > pos) emitText(pos, lt);
      pos = lt + 1;

      // ParseState::InsideMarkup (read_until_close).
      if (pos >= bytes.length) throw new XmlReadError('syntax error: tag not closed: `>` not found before end of input');
      const first = bytes[pos]!;
      if (first === BANG) {
        const kind = bytes[pos + 1];
        const chunkStart = pos + 1;
        let end = -1;
        if (kind === 0x5b) {                                       // `[` CDATA
          for (let i = chunkStart; i < bytes.length; i++) {
            if (bytes[i] === GT && endsWithBytes(bytes, i, [0x5d, 0x5d]) && i - chunkStart >= 2) { end = i; break; }
          }
          if (end < 0) throw new XmlReadError('syntax error: CDATA not closed: `]]>` not found before end of input');
          const buf = bytes.subarray(pos, end);                     // `!` + chunk[..i]
          if (!startsWithAscii(buf, '![CDATA[')) {
            throw new XmlReadError('syntax error: CDATA not closed: `]]>` not found before end of input');
          }
          const text = strictUtf8(buf.subarray(8, buf.length - 2));
          if (text !== null) push(text);
        } else if (kind === 0x2d) {                                // `-` comment
          for (let i = chunkStart; i < bytes.length; i++) {
            if (bytes[i] === GT && 1 + (i - chunkStart) > 4 && endsWithBytes(bytes, i, [0x2d, 0x2d])) { end = i; break; }
          }
          if (end < 0) throw new XmlReadError('syntax error: comment not closed: `-->` not found before end of input');
          if (!startsWithAscii(bytes.subarray(pos, end), '!--')) {
            throw new XmlReadError('syntax error: comment not closed: `-->` not found before end of input');
          }
        } else if (kind === 0x44 || kind === 0x64) {               // `D`/`d` DOCTYPE
          let balance = 0;
          for (let i = chunkStart; i < bytes.length; i++) {
            if (bytes[i] === LT) balance++;
            else if (bytes[i] === GT) {
              if (balance === 0) { end = i; break; }
              balance--;
            }
          }
          if (end < 0) throw new XmlReadError('syntax error: DOCTYPE not closed: `>` not found before end of input');
          const buf = bytes.subarray(pos, end);
          if (!startsWithAscii(buf, '!DOCTYPE', true)) {
            throw new XmlReadError('syntax error: DOCTYPE not closed: `>` not found before end of input');
          }
          if (!buf.subarray(8).some(b => !isXmlWhitespace(b))) {
            throw new XmlReadError('ill-formed document: `<!DOCTYPE>` declaration does not contain a name of a document type');
          }
        } else {
          throw new XmlReadError('syntax error: unknown or missed symbol in markup');
        }
        pos = end + 1;
      } else if (first === QUESTION) {
        // PiParser(false) fed from `?`: `>` preceded by `?` (not the leading one).
        let end = -1;
        for (let i = pos + 1; i < bytes.length; i++) {
          if (bytes[i] === GT && bytes[i - 1] === QUESTION) { end = i; break; }
        }
        const unclosed = 'syntax error: processing instruction or xml declaration not closed: `?>` not found before end of input';
        if (end < 0 || end - pos <= 1) throw new XmlReadError(unclosed);
        pos = end + 1;
      } else {
        const end = findElementEnd(bytes, pos);
        if (end < 0) throw new XmlReadError('syntax error: tag not closed: `>` not found before end of input');
        const content = bytes.subarray(pos, end);
        pos = end + 1;
        if (first === SLASH) {
          // emit_end with trim_markup_names_in_closing_tags.
          let name = content.subarray(1);
          let last = name.length;
          while (last > 0 && isXmlWhitespace(name[last - 1]!)) last--;
          if (last > 0) name = name.subarray(0, last);
          const expected = open.pop();
          if (expected === undefined) {
            throw new XmlReadError(`ill-formed document: close tag \`</${decodeName(name)}>\` does not match any open tag`);
          }
          if (!sameBytes(name, expected)) {
            throw new XmlReadError(`ill-formed document: expected \`</${decodeName(expected)}>\`, but \`</${decodeName(name)}>\` was found`);
          }
        } else if (content.length === 0 || content[content.length - 1] !== SLASH) {
          let nameLen = 0;
          while (nameLen < content.length && !isXmlWhitespace(content[nameLen]!)) nameLen++;
          open.push(content.subarray(0, nameLen));
        }
      }
    }
  } catch (error) {
    if (!(error instanceof XmlReadError)) throw error;
    warn(`XML解析错误: ${error.message}`);
  }

  const output = parts.join(' ');
  if (output === '') return rustTrim(lossyUtf8(bytes));
  return rustTrim(output);
}
