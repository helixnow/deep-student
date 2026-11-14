/**
 * Web fetch helpers, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs`.
 *
 * The module owns the deterministic parts of the executor: binary sniffing,
 * download-name safety, streaming size limits, charset decoding, HTML cleanup,
 * pagination and the optional DeepSeek fetch response contract. Network I/O is
 * provided by the caller so tests can exercise the contract without sockets.
 */
import { utf8ByteLength } from '../../../../platform/util/portable.ts';
import { readZipEntries } from '../zip-entries.ts';

export const DEFAULT_MAX_LENGTH = 5000;
export const DEFAULT_START_INDEX = 0;
export const REQUEST_TIMEOUT_SECS = 30;
export const MAX_CONTENT_LENGTH = 1024 * 1024;
export const MAX_BINARY_LENGTH = 64 * 1024 * 1024;
export const DEFAULT_USER_AGENT =
  'DeepStudent/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)';
export const MAX_REDIRECTS = 10;
export const DEEPSEEK_FETCH_ENABLED_SETTING = 'web_search.deepseek.fetch_enabled';
export const DEEPSEEK_API_KEY_SETTING = 'web_search.api_key.deepseek';
export const DEEPSEEK_FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch';

export interface BinaryKind {
  mime: string;
  extension: string;
}

const PDF: BinaryKind = { mime: 'application/pdf', extension: 'pdf' };
const DOCX: BinaryKind = {
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  extension: 'docx',
};
const PNG: BinaryKind = { mime: 'image/png', extension: 'png' };
const JPEG: BinaryKind = { mime: 'image/jpeg', extension: 'jpg' };
const GIF: BinaryKind = { mime: 'image/gif', extension: 'gif' };
const WEBP: BinaryKind = { mime: 'image/webp', extension: 'webp' };
const MP3: BinaryKind = { mime: 'audio/mpeg', extension: 'mp3' };
const WAV: BinaryKind = { mime: 'audio/wav', extension: 'wav' };
const OGG: BinaryKind = { mime: 'audio/ogg', extension: 'ogg' };
const FLAC: BinaryKind = { mime: 'audio/flac', extension: 'flac' };
const WEBM: BinaryKind = { mime: 'video/webm', extension: 'webm' };
const MP4: BinaryKind = { mime: 'video/mp4', extension: 'mp4' };

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  const slice = bytes.subarray(start, Math.min(end, bytes.length));
  for (const byte of slice) out += String.fromCharCode(byte);
  return out;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return latin1(bytes, start, end);
}

function normalizedMime(contentType: string): string {
  const [first] = contentType.split(';');
  return (first ?? '').trim();
}

/** DOCX is only accepted when the ZIP carries the OOXML `word/` payload. */
function docxMagicMatches(bytes: Uint8Array): boolean {
  if (!startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
  let entries;
  try { entries = readZipEntries(bytes); }
  catch { return false; }
  const hasContentTypes = entries.some(entry => entry.name === '[Content_Types].xml');
  return hasContentTypes
    && entries.some(entry => entry.name.startsWith('word/') && !entry.name.endsWith('/'));
}

/** Identify supported URL binary bodies from their magic bytes. */
export function sniffBinaryKind(bytes: Uint8Array): BinaryKind | undefined {
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return PDF;
  if (docxMagicMatches(bytes)) return DOCX;
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return JPEG;
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return GIF;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return WEBP;
  }
  if (ascii(bytes, 0, 3) === 'ID3'
    || startsWithBytes(bytes, [0xff, 0xfb])
    || startsWithBytes(bytes, [0xff, 0xf3])
    || startsWithBytes(bytes, [0xff, 0xf2])) return MP3;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    return WAV;
  }
  if (ascii(bytes, 0, 4) === 'OggS') return OGG;
  if (ascii(bytes, 0, 4) === 'fLaC') return FLAC;
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return WEBM;
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp') return MP4;
  return undefined;
}

/** Whether a declared content type is compatible with a sniffed binary kind. */
export function binaryHeaderFamilyMatches(header: string, kind: BinaryKind): boolean {
  const normalized = normalizedMime(header).toLowerCase();
  return normalized === ''
    || normalized === 'unknown'
    || normalized === 'application/octet-stream'
    || normalized === 'binary/octet-stream'
    || normalized === kind.mime
    || (kind.extension === 'docx' && normalized === 'application/zip')
    || (normalized.startsWith('image/') && kind.mime.startsWith('image/'))
    || (normalized.startsWith('audio/') && kind.mime.startsWith('audio/'))
    || (normalized.startsWith('video/') && kind.mime.startsWith('video/'))
    || (kind.extension === 'mp4'
      && (normalized.startsWith('audio/') || normalized.startsWith('video/')));
}

/** `path.basename` for both flavours without `node:path` (the host may run in a Worker). */
function baseName(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** `path.parse(x).name` (basename without its last extension). */
function baseStem(value: string): string {
  const leaf = baseName(value);
  const dot = leaf.lastIndexOf('.');
  return dot <= 0 ? leaf : leaf.slice(0, dot);
}

/** Keep a safe leaf stem (max 80 chars) and force the sniffed extension. */
export function sanitizeDownloadName(raw: string, kind: BinaryKind): string {
  const leaf = baseName(raw) || 'download';
  const stemRaw = baseStem(leaf) || 'download';
  let stem = [...stemRaw]
    .map(ch => (/[A-Za-z0-9._-]/.test(ch) ? ch : '_'))
    .slice(0, 80)
    .join('');
  if (stem === '' || stem === '.' || stem === '..') stem = 'download';
  return `${stem}.${kind.extension}`;
}

function headerValue(headers: Headers | Record<string, string> | Map<string, string>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (headers instanceof Map) {
    for (const [key, value] of headers) if (key.toLowerCase() === name.toLowerCase()) return value;
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

/** Prefer `Content-Disposition: filename=…`, else the final URL leaf. */
export function filenameFromHeadersOrUrl(
  headers: Headers | Record<string, string> | Map<string, string>,
  finalUrl: string,
  kind: BinaryKind,
): string {
  const disposition = headerValue(headers, 'content-disposition');
  let fromHeader: string | undefined;
  if (disposition !== undefined) {
    for (const part of disposition.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      if (part.slice(0, separator).trim().toLowerCase() === 'filename') {
        fromHeader = part.slice(separator + 1).trim().replace(/^['"]+|['"]+$/g, '');
        break;
      }
    }
  }
  let raw = fromHeader;
  if (raw === undefined) {
    try {
      const segments = new URL(finalUrl).pathname.split('/');
      const leaf = segments[segments.length - 1] ?? '';
      raw = leaf === '' ? undefined : leaf;
    } catch { raw = undefined; }
  }
  return sanitizeDownloadName(raw ?? 'download', kind);
}

/**
 * Consume a download body with a hard byte limit. Stops before retaining any
 * chunk that would cross the limit.
 */
export async function collectDownloadStreamLimited(
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes: number,
  initialCapacity: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  void initialCapacity;
  for await (const raw of stream) {
    const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
    const projected = total + chunk.length;
    if (!Number.isSafeInteger(projected)) throw new Error('Download size overflow');
    if (projected > maxBytes) {
      throw new Error(`Download exceeded size limit (${projected} bytes > ${maxBytes} bytes)`);
    }
    chunks.push(chunk);
    total = projected;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export const ERROR_EXCERPT_CHARS = 500;
/** 500 code points take at most 2000 bytes after a BOM in every WHATWG encoding (UTF-16 and GB18030 included). */
const ERROR_EXCERPT_BYTES = 4096;

/** reqwest `Response::text()`: a BOM wins, then the Content-Type charset label, else UTF-8; always lossy. */
function errorBodyDecoder(prefix: Uint8Array, contentType: string | null): TextDecoder {
  if (prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) return new TextDecoder('utf-8');
  if (prefix[0] === 0xff && prefix[1] === 0xfe) return new TextDecoder('utf-16le');
  if (prefix[0] === 0xfe && prefix[1] === 0xff) return new TextDecoder('utf-16be');
  const label = contentType === null ? undefined : detectCharsetFromContentType(contentType);
  if (label === undefined) return new TextDecoder('utf-8');
  try { return new TextDecoder(label); }
  catch { return new TextDecoder('utf-8'); }
}

/**
 * The trimmed first 500 code points of an error body, as if the whole body had been decoded.
 * Stops pulling the stream once enough bytes are buffered.
 */
export async function readResponseExcerpt(
  stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  contentType: string | null = null,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for await (const raw of stream) {
    const chunk = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= ERROR_EXCERPT_BYTES) {
      truncated = true;
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, ERROR_EXCERPT_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const piece = chunk.subarray(0, bytes.length - offset);
    bytes.set(piece, offset);
    offset += piece.length;
  }
  const text = errorBodyDecoder(bytes, contentType).decode(bytes, { stream: truncated });
  return Array.from(text).slice(0, ERROR_EXCERPT_CHARS).join('').trim();
}

/** Extract a `charset=` label from a Content-Type header. */
export function detectCharsetFromContentType(contentType: string): string | undefined {
  const lower = contentType.toLowerCase();
  const position = lower.indexOf('charset=');
  if (position < 0) return undefined;
  const start = position + 'charset='.length;
  const rest = contentType.slice(start);
  let charset: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    charset = end < 0 ? rest.slice(1) : rest.slice(1, end);
  } else {
    const match = /^[^;\s]*/.exec(rest);
    charset = match?.[0] ?? '';
  }
  return charset === '' ? undefined : charset;
}

/** Extract a charset label from a `<meta>` tag in the first 1024 bytes. */
export function detectCharsetFromHtmlMeta(bytes: Uint8Array): string | undefined {
  const scanLength = Math.min(bytes.length, 1024);
  const preview = latin1(bytes, 0, scanLength);
  const lower = preview.toLowerCase();
  const position = lower.indexOf('charset=');
  if (position < 0) return undefined;
  const rest = preview.slice(position + 'charset='.length);
  let charset: string;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    charset = end < 0 ? rest.slice(1) : rest.slice(1, end);
  } else if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    charset = end < 0 ? rest.slice(1) : rest.slice(1, end);
  } else {
    const end = rest.search(/[;"'>\s]/);
    charset = end < 0 ? rest : rest.slice(0, end);
  }
  return charset === '' ? undefined : charset;
}

/** `encoding_rs::Encoding::name` spellings for the labels we decode. */
function encodingName(label: string): string {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'gbk' || normalized === 'gb2312' || normalized === 'x-gbk') return 'GBK';
  if (normalized === 'gb18030') return 'gb18030';
  if (normalized === 'utf-8' || normalized === 'utf8') return 'UTF-8';
  if (normalized === 'utf-16le') return 'UTF-16LE';
  if (normalized === 'utf-16be') return 'UTF-16BE';
  if (normalized === 'shift_jis' || normalized === 'shift-jis' || normalized === 'sjis') return 'Shift_JIS';
  if (normalized === 'euc-jp') return 'EUC-JP';
  if (normalized === 'big5') return 'Big5';
  if (normalized === 'euc-kr') return 'EUC-KR';
  if (/^iso-8859-\d+$/.test(normalized)) return normalized.toUpperCase();
  if (/^windows-\d+$/.test(normalized)) return normalized;
  return label;
}

function tryDecode(bytes: Uint8Array, charset: string): [string, string] | undefined {
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charset, { fatal: true }); }
  catch { return undefined; }
  try { return [decoder.decode(bytes), encodingName(charset)]; }
  catch { return undefined; }
}

/**
 * Decode a response body: Content-Type charset → HTML meta → UTF-8 → lossy UTF-8.
 */
export function decodeBytesWithCharset(
  bytes: Uint8Array,
  contentType: string,
): [string, string] {
  const fromHeader = detectCharsetFromContentType(contentType);
  if (fromHeader !== undefined) {
    const decoded = tryDecode(bytes, fromHeader);
    if (decoded !== undefined && !/^utf-?8$/i.test(fromHeader)) return decoded;
  }
  const fromMeta = detectCharsetFromHtmlMeta(bytes);
  if (fromMeta !== undefined) {
    const decoded = tryDecode(bytes, fromMeta);
    if (decoded !== undefined && !/^utf-?8$/i.test(fromMeta)) return decoded;
  }
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return [strict, 'UTF-8'];
  } catch {
    return [new TextDecoder('utf-8').decode(bytes), 'UTF-8 (lossy)'];
  }
}

/** Detect HTML by the first 256 non-leading-whitespace characters. */
export function looksLikeHtml(content: string): boolean {
  const prefix = Array.from(content.trimStart()).slice(0, 256).join('');
  const lower = prefix.replace(/[A-Z]/g, ch => ch.toLowerCase());
  return lower.startsWith('<!doctype html')
    || lower.startsWith('<html')
    || lower.includes('<head')
    || lower.includes('<body');
}

/*
 * HTML scanning below replaces the former `/<tag[^>]*>(.*?)<\/tag>/gis` regexes, which backtrack
 * in O(n²) on unclosed tags and would block the Host thread. Each scanner reproduces the regex
 * match sequence exactly (leftmost start, `[^>]*>` up to the first `>`, lazy body up to the first
 * closing needle) using forward-only `indexOf` searches, so the output is byte-identical.
 */

/** ASCII-only lower-casing (the regexes' non-unicode `i` flag) that keeps UTF-16 indices aligned. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]+/g, run => run.toLowerCase());
}

/**
 * `haystack.indexOf(needle, from)` that reuses the previous answer while it still applies, so a
 * series of non-decreasing `from` values scans the haystack at most once.
 */
function forwardSearch(haystack: string, needle: string): (from: number) => number {
  let lastFrom = Number.POSITIVE_INFINITY;
  let lastAt = -1;
  return from => {
    if (from >= lastFrom && (lastAt < 0 || from <= lastAt)) return lastAt;
    lastFrom = from;
    lastAt = haystack.indexOf(needle, from);
    return lastAt;
  };
}

interface ScannedMatch {
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
}

/** Matches of `/<tag[^>]*>(.*?)<\/tag>/gis` over the ASCII-lowered source, in regex order. */
function* elementMatches(lower: string, tag: string): Generator<ScannedMatch> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const opens = forwardSearch(lower, open);
  const tagEnds = forwardSearch(lower, '>');
  const closes = forwardSearch(lower, close);
  let from = 0;
  for (;;) {
    const start = opens(from);
    if (start < 0) return;
    const tagEnd = tagEnds(start + open.length);
    const bodyEnd = tagEnd < 0 ? -1 : closes(tagEnd + 1);
    if (bodyEnd < 0) {
      from = start + 1;
      continue;
    }
    yield { start, end: bodyEnd + close.length, bodyStart: tagEnd + 1, bodyEnd };
    from = bodyEnd + close.length;
  }
}

/** `String.prototype.replace` over scanned matches; `render` receives the match. */
function replaceMatches<M extends ScannedMatch>(
  source: string,
  matches: Iterable<M>,
  render: (match: M) => string,
): string {
  let output = '';
  let copied = 0;
  for (const match of matches) {
    output += source.slice(copied, match.start) + render(match);
    copied = match.end;
  }
  return copied === 0 ? source : output + source.slice(copied);
}

/** `/<!--.*?-->/gs`. */
function* commentMatches(source: string): Generator<ScannedMatch> {
  const opens = forwardSearch(source, '<!--');
  const closes = forwardSearch(source, '-->');
  let from = 0;
  for (;;) {
    const start = opens(from);
    if (start < 0) return;
    const bodyEnd = closes(start + 4);
    if (bodyEnd < 0) {
      from = start + 1;
      continue;
    }
    yield { start, end: bodyEnd + 3, bodyStart: start + 4, bodyEnd };
    from = bodyEnd + 3;
  }
}

/**
 * `/<embed[^>]*(?:\/>|>.*?<\/embed>)/gis`: the `>…</embed>` branch is tried at the first `>`
 * before backtracking one character for the self-closing `/>` branch.
 */
function* embedMatches(lower: string): Generator<ScannedMatch> {
  const opens = forwardSearch(lower, '<embed');
  const tagEnds = forwardSearch(lower, '>');
  const closes = forwardSearch(lower, '</embed>');
  let from = 0;
  for (;;) {
    const start = opens(from);
    if (start < 0) return;
    const tagEnd = tagEnds(start + 6);
    const bodyEnd = tagEnd < 0 ? -1 : closes(tagEnd + 1);
    if (bodyEnd >= 0) {
      yield { start, end: bodyEnd + 8, bodyStart: tagEnd + 1, bodyEnd };
      from = bodyEnd + 8;
    } else if (tagEnd > start + 6 && lower.charCodeAt(tagEnd - 1) === 0x2f) {
      yield { start, end: tagEnd + 1, bodyStart: tagEnd + 1, bodyEnd: tagEnd + 1 };
      from = tagEnd + 1;
    } else {
      from = start + 1;
    }
  }
}

/** `/<h([1-6])[^>]*>(.*?)<\/h\1>/gis`; the body is closed only by the same heading level. */
function* headingMatches(lower: string): Generator<ScannedMatch & { level: number }> {
  const opens = forwardSearch(lower, '<h');
  const tagEnds = forwardSearch(lower, '>');
  const closes = [1, 2, 3, 4, 5, 6].map(level => forwardSearch(lower, `</h${level}>`));
  let from = 0;
  for (;;) {
    const start = opens(from);
    if (start < 0) return;
    const level = lower.charCodeAt(start + 2) - 0x30;
    const tagEnd = level >= 1 && level <= 6 ? tagEnds(start + 3) : -1;
    const bodyEnd = tagEnd < 0 ? -1 : closes[level - 1]!(tagEnd + 1);
    if (bodyEnd < 0) {
      from = start + 1;
      continue;
    }
    yield { start, end: bodyEnd + 5, bodyStart: tagEnd + 1, bodyEnd, level };
    from = bodyEnd + 5;
  }
}

/** `/<[^>]+>/g`: a `<` followed by at least one character before the next `>`. */
function* tagMatches(source: string): Generator<ScannedMatch> {
  const opens = forwardSearch(source, '<');
  const tagEnds = forwardSearch(source, '>');
  let from = 0;
  for (;;) {
    const start = opens(from);
    if (start < 0) return;
    const tagEnd = tagEnds(start + 1);
    if (tagEnd < 0) return;
    if (tagEnd === start + 1) {
      from = start + 1;
      continue;
    }
    yield { start, end: tagEnd + 1, bodyStart: start + 1, bodyEnd: tagEnd };
    from = tagEnd + 1;
  }
}

function largestElementBody(html: string, lower: string, tag: string): string | undefined {
  let best: ScannedMatch | undefined;
  for (const match of elementMatches(lower, tag)) {
    if (best === undefined || match.bodyEnd - match.bodyStart > best.bodyEnd - best.bodyStart) best = match;
  }
  return best === undefined ? undefined : html.slice(best.bodyStart, best.bodyEnd);
}

/** Prefer the largest `<article>`, then `<main>`, when it exceeds 200 bytes. */
export function tryExtractMainContent(html: string): string | undefined {
  const lower = asciiLower(html);
  let best = largestElementBody(html, lower, 'article');
  if (best === undefined) best = largestElementBody(html, lower, 'main');
  if (best === undefined || utf8ByteLength(best) <= 200) return undefined;
  return best;
}

/** Removal order; `!--` stands for comments and `embed` also accepts the self-closing form. */
const CLEAN_HTML_ELEMENTS: readonly string[] = [
  'script', 'style', 'noscript', '!--', 'nav', 'header', 'footer', 'aside',
  'iframe', 'svg', 'form', 'dialog', 'template', 'object', 'embed', 'applet',
];

export function cleanHtmlContent(html: string): string {
  let result = html;
  for (const element of CLEAN_HTML_ELEMENTS) {
    if (element === '!--') {
      result = replaceMatches(result, commentMatches(result), () => '');
      continue;
    }
    const lower = asciiLower(result);
    if (!lower.includes(`<${element}`)) continue;
    const matches = element === 'embed' ? embedMatches(lower) : elementMatches(lower, element);
    result = replaceMatches(result, matches, () => '');
  }
  return result;
}

export function cleanMarkdownContent(markdown: string): string {
  return markdown.replace(/\n{3,}/g, '\n\n');
}

const ENTITY_MAP: ReadonlyMap<string, string> = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' '],
]);

/** HTML numeric reference rule (html5ever `finish_numeric`): NUL, surrogates and > U+10FFFF become U+FFFD. */
function numericReference(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(code);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : numericReference(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : numericReference(code);
    }
    return ENTITY_MAP.get(body.toLowerCase()) ?? whole;
  });
}

/** Small HTML→Markdown conversion used when the body declares text/html. */
export function htmlToMarkdownText(html: string): string {
  const source = tryExtractMainContent(html) ?? html;
  let text = cleanHtmlContent(source);
  const headings = text;
  text = replaceMatches(headings, headingMatches(asciiLower(headings)), match =>
    `\n\n${'#'.repeat(match.level)} ${headings.slice(match.bodyStart, match.bodyEnd).trim()}\n\n`);
  const items = text;
  text = replaceMatches(items, elementMatches(asciiLower(items), 'li'), match =>
    `\n- ${items.slice(match.bodyStart, match.bodyEnd).trim()}`);
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|section|table|tr|ul|ol)>/gi, '\n\n');
  text = replaceMatches(text, tagMatches(text), () => '');
  text = decodeEntities(text);
  return cleanMarkdownContent(text.split('\n').map(line => line.trimEnd()).join('\n').trim());
}

export interface PaginateResult {
  content: string;
  hasMore: boolean;
  truncationNotice?: string;
}

/** Rust `usize::saturating_add` semantics without BigInt overflow. */
function saturatingAdd(left: number, right: number): number {
  const value = left + right;
  return Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER
    ? value : Number.MAX_SAFE_INTEGER;
}

export function paginateContent(
  content: string,
  startIndex: number,
  maxLength: number,
): PaginateResult {
  const chars = Array.from(content);
  const total = chars.length;
  if (startIndex >= total) {
    return { content: '<error>No more content available.</error>', hasMore: false };
  }
  const endIndex = Math.min(saturatingAdd(startIndex, Math.max(0, maxLength)), total);
  let paginated = chars.slice(startIndex, endIndex).join('');
  const actualLength = Array.from(paginated).length;
  const remaining = Math.max(0, total - saturatingAdd(startIndex, actualLength));
  const hasMore = remaining > 0;
  let truncationNotice: string | undefined;
  if (hasMore && actualLength === maxLength) {
    const nextStart = saturatingAdd(startIndex, actualLength);
    truncationNotice = `\n\n<truncated>Content truncated. Call the fetch tool with start_index=${nextStart} to get more content. Remaining: ${remaining} characters.</truncated>`;
    paginated += truncationNotice;
  }
  return {
    content: paginated,
    hasMore,
    ...(truncationNotice === undefined ? {} : { truncationNotice }),
  };
}

/** Only the string `true` (ASCII case-insensitive, trimmed) enables DeepSeek. */
export function deepseekFetchSettingEnabled(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed.length !== 4) return false;
  return [...trimmed].every((ch, index) => {
    const folded = ch >= 'A' && ch <= 'Z' ? String.fromCharCode(ch.charCodeAt(0) + 32) : ch;
    return folded === 'true'[index];
  });
}

/** Enabled + non-empty key + http(s) URL. */
export function shouldUseDeepseekFetch(
  enabled: boolean,
  apiKey: string | null | undefined,
  url: string,
): boolean {
  if (!enabled || apiKey === null || apiKey === undefined || apiKey.trim() === '') return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch { return false; }
}

/** Parse `{title?, content}`; blank content is a failure. */
export function parseDeepseekFetchResponse(body: unknown): [string | null, string] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('DeepSeek Fetch returned empty content');
  }
  const record = body as Record<string, unknown>;
  const rawContent = record.content;
  const content = typeof rawContent === 'string' ? rawContent.trim() : '';
  if (content === '') throw new Error('DeepSeek Fetch returned empty content');
  const rawTitle = record.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle.trim() : null;
  return [title, content];
}

export function describeDeepseekFetchFailure(status: number, bodyExcerpt: string): string {
  let summary: string;
  if (status === 402) summary = 'DeepSeek Fetch 余额不足（HTTP 402），请充值后再试';
  else if (status === 404) summary = 'DeepSeek Fetch 未能抓取该网页内容（HTTP 404）';
  else if (status === 408) summary = 'DeepSeek Fetch 请求超时（HTTP 408，可重试）';
  else if (status === 429) summary = 'DeepSeek Fetch 请求频率超限（HTTP 429，可重试）';
  else if (status === 400) summary = 'DeepSeek Fetch 请求参数错误（HTTP 400）';
  else if (status === 401 || status === 403) {
    summary = `DeepSeek Fetch 鉴权失败（HTTP ${status}，请检查 DeepSeek API Key）`;
  } else if (status >= 500 && status <= 599) {
    summary = `DeepSeek Fetch 服务端错误（HTTP ${status}，可重试）`;
  } else summary = `DeepSeek Fetch 失败（HTTP ${status}）`;
  const excerpt = bodyExcerpt.trim();
  return excerpt === '' ? summary : `${summary}: ${excerpt}`;
}

export interface DeepseekFetchSuccessArgs {
  url: string;
  host: string | null;
  content: string;
  startIndex: number;
  maxLength: number;
  durationMs: number;
}

/** Success payload identical in shape to the local fetch success branch. */
export function deepseekFetchSuccessResult(args: DeepseekFetchSuccessArgs): Record<string, unknown> {
  const totalLength = Array.from(args.content).length;
  const paginated = paginateContent(args.content, args.startIndex, args.maxLength);
  const returnedLength = Array.from(paginated.content).length;
  const nextStartIndex = paginated.hasMore
    ? saturatingAdd(args.startIndex, args.maxLength) : null;
  return {
    success: true,
    url: args.url,
    finalUrl: args.url,
    redirected: false,
    finalDomain: args.host,
    content: paginated.content,
    contentType: 'text/markdown; deepseek-fetch',
    totalLength,
    startIndex: args.startIndex,
    returnedLength,
    hasMore: paginated.hasMore,
    nextStartIndex,
    durationMs: args.durationMs,
  };
}

export class FetchExecutor {
  canHandle(toolName: string): boolean {
    const stripped = toolName.startsWith('builtin-') ? toolName.slice(8)
      : toolName.startsWith('mcp_') ? toolName.slice(4) : toolName;
    return stripped === 'web_fetch';
  }

  sensitivityLevel(_toolName: string): 'low' { return 'low'; }
  concurrencyClass(_toolName: string): 'read_only' { return 'read_only'; }
  name(): string { return 'FetchExecutor'; }

  cleanHtml(html: string): string { return cleanHtmlContent(html); }
  cleanMarkdown(markdown: string): string { return cleanMarkdownContent(markdown); }
  htmlToMarkdown(html: string): string { return htmlToMarkdownText(html); }
  tryExtractMainContent(html: string): string | undefined { return tryExtractMainContent(html); }

  paginateContent(content: string, startIndex: number, maxLength: number): PaginateResult {
    return paginateContent(content, startIndex, maxLength);
  }

  deepseekFetchSuccessResult(
    url: string,
    host: string | null,
    content: string,
    startIndex: number,
    maxLength: number,
    durationMs: number,
  ): Record<string, unknown> {
    return deepseekFetchSuccessResult({ url, host, content, startIndex, maxLength, durationMs });
  }
}
