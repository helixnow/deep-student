/**
 * unified_file_manager.rs 中不碰文件系统的部分（可移植叶子模块，桌面与移动端共用）：虚拟 URI 判定、
 * `urlencoding::decode`、文件名 / 扩展名提取、文件名清洗、不透明 document ID 判定，以及按文件头字节
 * 识别扩展名（文件读取由调用方注入）。`unified-file-manager.ts` 原样重导出这些函数。
 */
import { AppError } from '../errors/api.ts';
import { decodeUtf8Lossy, encodeUtf8, parseJsonDocument, rustTrim, rustTrimStart, utf8ByteLength, utf8ErrorMessage } from '../util/portable.ts';

const SPECIAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];
const ANDROID_SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];

export const DOUBLE_ENCODED_VIRTUAL_URI_REJECTED =
  '路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址';

export function isSpecialScheme(value: string): boolean {
  const lower = rustTrimStart(value).toLowerCase();
  return SPECIAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

export function isAndroidSafPath(value: string): boolean {
  const lower = rustTrimStart(value).toLowerCase();
  return ANDROID_SAF_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** unified_file_manager.rs:413. */
export function isVirtualUri(rawPath: string): boolean {
  const trimmed = rustTrim(rawPath);
  return isSpecialScheme(trimmed) || isAndroidSafPath(trimmed);
}

function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/**
 * `urlencoding::decode`：逐字节解 `%XX`，非法转义（`%zz`、末尾 `%4`）原样保留，
 * 其余转义照常解码；结果不是合法 UTF-8 时整体失败，调用方（Rust `decode_path` /
 * `extract_file_name`）回退原文。`decodeURIComponent` 遇到任一非法转义就整体抛错，语义不同。
 */
export function urlDecode(input: string): string | null {
  if (!input.includes('%')) return input;
  const bytes = encodeUtf8(input);
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x25 && i + 2 < bytes.length && hexDigit(bytes[i + 1]!) >= 0 && hexDigit(bytes[i + 2]!) >= 0) {
      out[n++] = (hexDigit(bytes[i + 1]!) << 4) | hexDigit(bytes[i + 2]!);
      i += 2;
    } else {
      out[n++] = byte;
    }
  }
  const decoded = out.subarray(0, n);
  return utf8ErrorMessage(decoded) === null ? decodeUtf8Lossy(decoded) : null;
}

export function decodePath(input: string): string {
  return urlDecode(input) ?? input;
}

/** unified_file_manager.rs:423. */
export function rejectDoubleEncodedVirtualUri(rawPath: string): void {
  const trimmed = rustTrim(rawPath);
  if (isSpecialScheme(trimmed)) return;
  const decoded = decodePath(trimmed);
  if (isSpecialScheme(decoded)) throw AppError.validation(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
}

/** unified_file_manager.rs:652. */
export function extractFileName(rawPath: string): string {
  const trimmed = rustTrim(rawPath);
  const lastSegment = trimmed.split(/[/\\]/).pop() ?? trimmed;
  const decoded = decodePath(lastSegment);
  return decoded.split('/').pop() ?? decoded;
}

/** `Path::new(name).extension()`（name 已是单段文件名）：`..`、无点、仅首字符为点时无扩展名。 */
export function pathExtension(name: string): string | null {
  if (name === '..') return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return name.slice(dot + 1);
}

/** unified_file_manager.rs:665 `extract_extension`：小写、不含点；空扩展名视为无。 */
export function extractExtension(rawPath: string): string | null {
  const ext = pathExtension(extractFileName(rawPath));
  return ext ? ext.toLowerCase() : null;
}

/** unified_file_manager.rs:979：`: ? * " < > |`、NUL 与 Unicode 控制字符（Cc）替换为 `_`。 */
export function sanitizeFileNameForFs(name: string): string {
  let out = '';
  for (const ch of name) {
    out += /^[:?*"<>|\0]$/.test(ch) || /^\p{Cc}$/u.test(ch) ? '_' : ch;
  }
  return out;
}

/**
 * unified_file_manager.rs:991：提取出的文件名是否像 Android document ID
 * （`document:1000019790`、`image:12345`、`msf:62`、纯数字 `446`）。
 */
export function isOpaqueDocumentId(name: string): boolean {
  const colon = name.indexOf(':');
  if (colon >= 0) {
    const after = name.slice(colon + 1);
    if (after !== '' && /^[0-9]+$/.test(after)) return true;
  }
  return name !== '' && /^[0-9]+$/.test(name);
}

// ------------------------------------------------------------------ 文件头识别

/** 读取文件前 `n` 个字节（不足则返回实际读到的）；读取失败返回 null（Rust `.ok()`）。 */
export type ReadHead = (n: number) => Uint8Array | null;

function startsWithBytes(data: Uint8Array, prefix: readonly number[]): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

/** `str::lines`：按 `\n` 切分并去掉行尾 `\r`，末尾换行不产生空行。 */
function rustLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (value.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** unified_file_manager.rs:961。 */
function looksLikeCsv(text: string): boolean {
  const lines = rustLines(text).slice(0, 5);
  if (lines.length < 2) return false;
  const counts = lines.map((line) => line.split(',').length - 1);
  return counts[0]! >= 1 && counts.every((count) => count === counts[0]);
}

/** unified_file_manager.rs:971。 */
function looksLikeMarkdown(text: string): boolean {
  return rustLines(text).slice(0, 20).some((line) => line.startsWith('#') || line.startsWith('```') || line.startsWith('- '));
}

/** unified_file_manager.rs:877 `detect_zip_subtype`：只解析前 64KB 内的 Local File Header 条目名。 */
function detectZipSubtype(readHead: ReadHead): string | null {
  const data = readHead(64 * 1024);
  if (data === null) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let offset = 0;
  let hasContentXml = false;
  let mimetypeContent: string | null = null;
  while (offset + 30 <= data.length) {
    if (!(data[offset] === 0x50 && data[offset + 1] === 0x4b && data[offset + 2] === 0x03 && data[offset + 3] === 0x04)) break;
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > data.length) break;

    const entryName = decodeUtf8Lossy(data.subarray(nameStart, nameEnd)).toLowerCase();
    if (entryName.startsWith('word/')) return 'docx';
    if (entryName.startsWith('xl/')) return 'xlsx';
    if (entryName.startsWith('ppt/')) return 'pptx';
    if (entryName === 'meta-inf/container.xml') return 'epub';
    if (entryName === 'content.xml') hasContentXml = true;

    if (entryName === 'mimetype') {
      const dataStart = nameEnd + extraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd <= data.length) mimetypeContent = decodeUtf8Lossy(data.subarray(dataStart, dataEnd));
    }

    const nextOffset = nameEnd + extraLen + compressedSize;
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  if (mimetypeContent !== null) {
    if (mimetypeContent.includes('spreadsheet')) return 'ods';
    if (mimetypeContent.includes('presentation')) return 'pptx';
    if (mimetypeContent.includes('text') || mimetypeContent.includes('opendocument')) return 'docx';
  }
  if (hasContentXml || mimetypeContent !== null) return 'ods';
  return null;
}

function isValidJson(text: string): boolean {
  try { parseJsonDocument(text); return true; } catch { return false; }
}

/**
 * unified_file_manager.rs:768 `detect_extension_from_magic`：先读 8 字节判 PDF/ZIP/RTF/OLE2/XML/HTML，
 * 再读 1024 字节做 JSON/CSV/Markdown/纯文本启发式。任何读取失败返回 null（Rust `.ok()?`）。
 */
export function detectExtensionFromHead(readHead: ReadHead): string | null {
  const header = readHead(8);
  if (header === null || header.length < 4) return null;

  if (startsWithBytes(header, ascii('%PDF'))) return 'pdf';
  if (startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04])) return detectZipSubtype(readHead);
  if (startsWithBytes(header, ascii('{\\rtf'))) return 'rtf';
  if (startsWithBytes(header, [0xd0, 0xcf, 0x11, 0xe0])) return null; // 不支持旧版 Office 格式

  const content = startsWithBytes(header, [0xef, 0xbb, 0xbf]) ? header.subarray(3) : header;
  if (startsWithBytes(content, ascii('<?xm'))) {
    const more = readHead(512);
    if (more !== null) {
      const lower = decodeUtf8Lossy(more).toLowerCase();
      if (lower.includes('<html') || lower.includes('<!doctype html')) return 'html';
    }
    return 'xml';
  }
  if (['<htm', '<HTM', '<!DO', '<!do'].some((prefix) => startsWithBytes(content, ascii(prefix)))) return 'html';

  const textSample = readHead(1024);
  if (textSample === null) return null;
  const trimmedText = rustTrim(decodeUtf8Lossy(textSample).replace(/^﻿+/, ''));

  if ((trimmedText.startsWith('{') || trimmedText.startsWith('['))
    && (isValidJson(trimmedText) || utf8ByteLength(trimmedText) >= 1024)) {
    return 'json';
  }
  if (looksLikeCsv(trimmedText)) return 'csv';
  if (looksLikeMarkdown(trimmedText)) return 'md';
  if (textSample.length > 0 && utf8ErrorMessage(textSample) === null) return 'txt';
  return null;
}
