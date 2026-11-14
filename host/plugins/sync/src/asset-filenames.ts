import { utf8ByteLength } from '../../../platform/util/index.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';
import { toHex, fromHex } from '../../../platform/crypto/encoding.ts';

export const FILENAME_CONFLICT_MARKER = '[filename-conflict]';
export const MAX_PORTABLE_SEGMENT_UNITS = 255;
export const MAX_PORTABLE_ASSET_KEY_UNITS = 240;
const QUOTE = '‛';
const PREFIX = '‛e';
const illegal = '\\/:*?"<>|';
const reserved = new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `LPT${i}`)]);

export class FilenameCodecError extends Error {
  constructor(message: string) { super(message); this.name = 'FilenameCodecError'; }
}
function fail(message: string): never { throw new FilenameCodecError(message); }
function validatePathUnits(value: string, limit: number, label: string): void {
  const bytes = utf8ByteLength(value);
  if (bytes > limit || value.length > limit) fail(`${label}超长（UTF-8 ${bytes} 字节，UTF-16 ${value.length} 单元，上限 ${limit}）`);
}
function validateDecodedSegmentLength(raw: string): void {
  if (!raw) fail('文件名段为空');
  validatePathUnits(raw, MAX_PORTABLE_SEGMENT_UNITS, '原始文件名段');
}
function isReserved(name: string): boolean {
  const stem = name.replace(/[ .]+$/u, '').split('.')[0]!.replace(/ +$/u, '');
  return reserved.has(stem.replace(/[a-z]/g, c => c.toUpperCase()));
}
export function validateEncodedSegment(encoded: string): void {
  validatePathUnits(encoded, MAX_PORTABLE_SEGMENT_UNITS, '编码后文件名段');
  if (!encoded || encoded === '.' || encoded === '..' || encoded.endsWith('.') || encoded.endsWith(' ')
    || [...encoded].some(c => illegal.includes(c) || /\p{Cc}/u.test(c)) || isReserved(encoded)) {
    fail('编码后文件名仍不满足跨平台安全约束');
  }
}
function replacementForUnsafe(char: string): string | null {
  const code = char.codePointAt(0)!;
  if (illegal.includes(char)) return String.fromCodePoint(code + 0xfee0);
  if (code <= 0x1f) return String.fromCodePoint(code + 0x2400);
  return code === 0x7f ? '␡' : null;
}
function decodedReplacement(char: string): string | null {
  const code = char.codePointAt(0)!;
  if ('＂＊：＜＞？＼｜／'.includes(char)) return String.fromCodePoint(code - 0xfee0);
  if (code >= 0x2400 && code <= 0x241f) return String.fromCodePoint(code - 0x2400);
  if (char === '␠') return ' ';
  if (char === '␡') return '\x7f';
  return char === '．' ? '.' : null;
}
function encodeRcloneBody(raw: string): [string, boolean] {
  const chars = [...raw];
  let trailingStart = chars.length;
  while (trailingStart && (chars[trailingStart - 1] === '.' || chars[trailingStart - 1] === ' ')) trailingStart--;
  let output = ''; let changed = false;
  for (const [index, char] of chars.entries()) {
    const replacement = index >= trailingStart && char === '.' ? '．'
      : index >= trailingStart && char === ' ' ? '␠' : replacementForUnsafe(char);
    if (replacement !== null) { output += replacement; changed = true; }
    else if (char === QUOTE || decodedReplacement(char) !== null) { output += QUOTE + char; changed = true; }
    else output += char;
  }
  return [output, changed];
}
function decodeRcloneBody(body: string): string {
  let output = ''; let quoted = false;
  for (const char of body) {
    if (quoted) { output += char; quoted = false; }
    else if (char === QUOTE) quoted = true;
    else output += decodedReplacement(char) ?? char;
  }
  if (quoted) fail('文件名引用符缺少后续字符');
  return output;
}
export function encodeSegment(raw: string): string {
  validateDecodedSegmentLength(raw);
  let encoded: string;
  if (raw.normalize('NFC') !== raw || [...raw].some(c => /\p{Cc}/u.test(c) && c.codePointAt(0)! > 0x7f)) {
    encoded = `${PREFIX}h${toHex(encodeUtf8(raw))}`;
  } else {
    const [body, changed] = encodeRcloneBody(raw);
    encoded = changed || isReserved(raw) ? `${PREFIX}r${body}` : raw;
  }
  validateEncodedSegment(encoded);
  return encoded;
}
export function decodeSegment(encoded: string): string {
  if (!encoded.startsWith(PREFIX)) { validateDecodedSegmentLength(encoded); return encoded; }
  const chars = [...encoded.slice(PREFIX.length)];
  const mode = chars.shift();
  if (!mode) fail('文件名编码缺少模式');
  const body = chars.join('');
  if (!body) fail('文件名编码内容为空');
  let decoded: string;
  if (mode === 'r') decoded = decodeRcloneBody(body);
  else if (mode === 'h') {
    if (body.length % 2 || !/^[0-9a-f]+$/u.test(body)) fail('文件名 UTF-8 十六进制编码非法');
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fromHex(body)); }
    catch { fail('文件名编码还原后不是有效 UTF-8'); }
  } else fail('未知文件名编码模式');
  validateDecodedSegmentLength(decoded);
  if (encodeSegment(decoded) !== encoded) fail('文件名编码不是规范形式');
  return decoded;
}
export function sanitizeSegment(raw: string): string | null {
  try {
    if (raw.startsWith(PREFIX)) { decodeSegment(raw); validateEncodedSegment(raw); return raw; }
    return encodeSegment(raw);
  } catch (error) { if (error instanceof FilenameCodecError) return null; throw error; }
}
function splitStructuralSegments(path: string): string[] {
  const segments = path.split('/');
  if (segments.some(s => !s || s === '.' || s === '..')) fail('路径包含空段或遍历段');
  return segments;
}
function encodeRelSegments(segments: readonly string[]): string {
  if (!segments.length) fail('资产相对路径为空');
  const encoded = segments.map(segment => {
    if (!segment || segment === '.' || segment === '..') fail('资产相对路径包含空段或遍历段');
    return encodeSegment(segment);
  }).join('/');
  validatePathUnits(encoded, MAX_PORTABLE_ASSET_KEY_UNITS, '资产相对路径');
  return encoded;
}
export function encodeRelPath(raw: string): string { return encodeRelSegments(raw.split('/')); }
export function decodeRelPath(encoded: string): string { return splitStructuralSegments(encoded).map(decodeSegment).join('/'); }
export function sanitizeRelPath(raw: string): string | null {
  try {
    const segments = splitStructuralSegments(raw).map(sanitizeSegment);
    if (segments.some(s => s === null)) return null;
    const rel = segments.join('/');
    validatePathUnits(rel, MAX_PORTABLE_ASSET_KEY_UNITS, '资产相对路径');
    return rel;
  } catch (error) { if (error instanceof FilenameCodecError) return null; throw error; }
}
/** Top-level directories the asset scan uploads, mod.rs:10217 ACTIVE_ASSET_DIRS and :11634 pdf_ocr_sessions. */
export const SYNCED_ASSET_DIRS: ReadonlyMap<string, readonly string[]> = new Map([
  ['active', ['images', 'notes_assets', 'documents', 'subjects', 'textbooks', 'audio', 'videos']],
  ['app_data', ['pdf_ocr_sessions', 'skills', 'plugins', 'dstu-workshop']],
]);
// RUST-FIX(RF-W32-asset-top-allowlist): Rust only scans these directories but maps any cloud key's top directory to a local path (mod.rs:12315), so a remote entry can overwrite or delete databases/ in the active slot.
export function isSyncedAssetKey(key: string): boolean {
  const first = key.indexOf('/'), second = key.indexOf('/', first + 1);
  if (first < 0 || second < 0) return false;
  return SYNCED_ASSET_DIRS.get(key.slice(0, first))?.includes(key.slice(first + 1, second)) ?? false;
}
function validateRootAndTop(root: string, top: string): void {
  if ((root !== 'active' && root !== 'app_data') || !top || top === '.' || top === '..' || /[/\\\p{Cc}]/u.test(top)) {
    fail('资产 root 或顶层目录非法');
  }
  validatePathUnits(top, MAX_PORTABLE_SEGMENT_UNITS, '资产顶层目录');
}
function assemble(root: string, top: string, rel: string): string {
  const key = `${root}/${top}/${rel}`;
  validatePathUnits(key, MAX_PORTABLE_ASSET_KEY_UNITS, '资产 key');
  return key;
}
function splitAssetKey(key: string): [string, string, string] {
  const first = key.indexOf('/');
  if (first < 0) fail('资产 key 缺少顶层目录');
  const second = key.indexOf('/', first + 1);
  if (second < 0) fail('资产 key 缺少相对路径');
  const parts: [string, string, string] = [key.slice(0, first), key.slice(first + 1, second), key.slice(second + 1)];
  if (parts.some(s => !s)) fail('资产 key 含空结构段');
  return parts;
}
export function encodeAssetKeySegments(root: string, top: string, segments: readonly string[]): string {
  validateRootAndTop(root, top);
  return assemble(root, top, encodeRelSegments(segments));
}
export function sanitizeAssetKeySegments(root: string, top: string, segments: readonly string[]): string {
  validateRootAndTop(root, top);
  if (!segments.length) fail('资产相对路径为空');
  return assemble(root, top, segments.map(segment => {
    if (!segment || segment === '.' || segment === '..') fail('资产相对路径包含空段或遍历段');
    const encoded = sanitizeSegment(segment);
    if (encoded === null) fail('文件名段编码损坏或超长');
    return encoded;
  }).join('/'));
}
export function sanitizeAssetKey(key: string): string | null {
  try {
    const [root, top, rel] = splitAssetKey(key); validateRootAndTop(root, top);
    const encoded = sanitizeRelPath(rel);
    return encoded === null ? null : assemble(root, top, encoded);
  } catch (error) { if (error instanceof FilenameCodecError) return null; throw error; }
}
export function decodeAssetKey(key: string): string {
  const [root, top, rel] = splitAssetKey(key); validateRootAndTop(root, top);
  validatePathUnits(key, MAX_PORTABLE_ASSET_KEY_UNITS, '资产 key');
  return `${root}/${top}/${decodeRelPath(rel)}`;
}
function legacySanitizeSegment(raw: string): string {
  let cleaned = [...raw.normalize('NFC')].map(c => illegal.includes(c) || /\p{Cc}/u.test(c) ? '_' : c).join('').replace(/[ .]+$/u, '');
  if (!cleaned) return `unnamed-${createHasherSync('SHA-256').update(raw).digestHex().slice(0, 8)}`;
  const stemEnd = cleaned.indexOf('.') < 0 ? cleaned.length : cleaned.indexOf('.');
  if (reserved.has(cleaned.slice(0, stemEnd).replace(/ +$/u, '').replace(/[a-z]/g, c => c.toUpperCase()))) {
    cleaned = cleaned.slice(0, stemEnd) + '_' + cleaned.slice(stemEnd);
  }
  return cleaned;
}
export function legacySanitizedAssetKey(key: string): string | null {
  try {
    const [root, top, rel] = splitAssetKey(key); validateRootAndTop(root, top);
    return assemble(root, top, splitStructuralSegments(rel).map(s => legacySanitizeSegment(decodeSegment(s))).join('/'));
  } catch (error) { if (error instanceof FilenameCodecError) return null; throw error; }
}
export function casefoldKey(key: string): string { return [...key.normalize('NFC')].map(c => c.toLowerCase()).join(''); }

export const localDuplicateMessage = (key: string, kept: string, skipped: string): string =>
  `${FILENAME_CONFLICT_MARKER} ${key}: 本地文件 ${skipped} 与 ${kept} 映射到同一云端名称，本次仅同步 ${kept}；请重命名其中一个文件后重新同步`;
export const localCaseConflictMessage = (skipped: string, kept: string): string =>
  `${FILENAME_CONFLICT_MARKER} ${skipped}: 与本地 ${kept} 仅文件名大小写不同，在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；请重命名其中一个文件后重新同步`;
export const uploadCaseConflictMessage = (local: string, cloud: string): string =>
  `${FILENAME_CONFLICT_MARKER} ${local}: 与云端 ${cloud} 仅文件名大小写不同，在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；请重命名本地文件后重新同步`;
export const downloadCaseConflictMessage = (cloud: string, occupied: string): string =>
  `${FILENAME_CONFLICT_MARKER} ${cloud}: 与 ${occupied} 仅文件名大小写不同，为避免在不区分大小写的系统上互相覆盖已跳过下载；请在源设备重命名该文件后重新同步`;
export const shadowedDivergentMessage = (skipped: string, kept: string): string =>
  `${FILENAME_CONFLICT_MARKER} ${skipped}: 与 ${kept} 映射到同一本地名称但内容不同，本地按 ${kept} 物化；请在源设备重命名后重新同步`;
