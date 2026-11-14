/**
 * `dstu-media/src/media/subtitle.rs`: `.srt` / `.vtt` / Bilibili BCC JSON import and
 * srt / vtt / txt export. Encoding order: UTF-8 (BOM aware), UTF-16 BOM, then GB18030.
 */
import type { MediaSegmentRow, PlannedSpan } from '../api.ts';
import { decodeUtf8Lossy, rustTrim, rustTrimStart } from '../../../platform/util/portable.ts';
import { MediaError } from './errors.ts';
import { buildTranscriptText } from './transcript.ts';

export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
export type SubtitleFormat = 'srt' | 'vtt' | 'bcc';
export type ExportFormat = 'srt' | 'vtt' | 'txt';

export function parseExportFormat(s: string): ExportFormat {
  const value = rustTrim(s).replace(/^\.+/, '').replace(/[A-Z]/g, c => c.toLowerCase());
  if (value === 'srt') return 'srt';
  if (value === 'vtt' || value === 'webvtt') return 'vtt';
  if (value === 'txt' || value === 'text') return 'txt';
  throw new MediaError('InvalidInput', `不支持的导出格式: ${value}（可选 srt / vtt / txt）`);
}

export function exportExtension(format: ExportFormat): string { return format; }

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8Lossy(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('gb18030').decode(bytes);
  }
}

export function detectFormat(fileName: string, text: string): SubtitleFormat | null {
  const lower = fileName.replace(/[A-Z]/g, c => c.toLowerCase());
  const head = rustTrimStart(text.replace(/^\uFEFF/, ''));
  if (lower.endsWith('.vtt') || head.startsWith('WEBVTT')) return 'vtt';
  if (lower.endsWith('.json') || lower.endsWith('.bcc') || head.startsWith('{')) return 'bcc';
  if (lower.endsWith('.srt') || head.includes('-->')) return 'srt';
  return null;
}

export function parseSubtitle(fileName: string, bytes: Uint8Array): Array<[PlannedSpan, string]> {
  const text = decodeText(bytes);
  const format = detectFormat(fileName, text);
  if (format === null) throw new MediaError('InvalidInput', '无法识别的字幕格式（支持 .srt / .vtt / B 站 BCC .json）');
  let cues = format === 'bcc' ? parseBcc(text) : parseCues(text);
  cues = cues.filter(([, t]) => rustTrim(t) !== '');
  cues.sort((a, b) => a[0].start_ms - b[0].start_ms || a[0].end_ms - b[0].end_ms);
  if (cues.length === 0) throw new MediaError('InvalidInput', '字幕文件中没有可用的字幕条目');
  return cues;
}

function parseI64(value: string): number | null {
  const trimmed = rustTrim(value);
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return null;
  const n = Number(BigInt(trimmed));
  return Number.isSafeInteger(n) ? n : null;
}

export function parseCueTime(raw: string): number | null {
  const normalized = rustTrim(raw).replace(/,/g, '.');
  const dot = normalized.indexOf('.');
  const hms = dot >= 0 ? normalized.slice(0, dot) : normalized;
  const frac = dot >= 0 ? normalized.slice(dot + 1) : '';
  const parts = hms.split(':').map(parseI64);
  if (parts.some(p => p === null)) return null;
  const n = parts as number[];
  let secs: number;
  if (n.length === 3) secs = n[0]! * 3600 + n[1]! * 60 + n[2]!;
  else if (n.length === 2) secs = n[0]! * 60 + n[1]!;
  else if (n.length === 1) secs = n[0]!;
  else return null;
  const digits: string[] = [];
  for (const c of frac) { if (c < '0' || c > '9') break; digits.push(c); if (digits.length === 3) break; }
  let ms = 0;
  if (digits.length > 0) {
    const parsed = parseI64(digits.join(''));
    if (parsed === null) return null;
    ms = parsed * 10 ** (3 - digits.length);
  }
  return secs * 1000 + ms;
}

function stripMarkup(line: string): string {
  let out = '';
  let angle = false;
  let brace = false;
  for (const ch of line) {
    if (ch === '<') { angle = true; continue; }
    if (ch === '>' && angle) { angle = false; continue; }
    if (ch === '{') { brace = true; continue; }
    if (ch === '}' && brace) { brace = false; continue; }
    if (angle || brace) continue;
    out += ch;
  }
  return rustTrim(out.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

function parseCues(text: string): Array<[PlannedSpan, string]> {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: Array<[PlannedSpan, string]> = [];
  let i = 0;
  let skipBlock = false;
  while (i < lines.length) {
    const trimmed = rustTrim(lines[i]!);
    i += 1;
    if (trimmed === '') { skipBlock = false; continue; }
    if (trimmed.startsWith('NOTE') || trimmed === 'STYLE' || trimmed === 'REGION') { skipBlock = true; continue; }
    if (skipBlock || !trimmed.includes('-->')) continue;
    const arrow = trimmed.indexOf('-->');
    const a = trimmed.slice(0, arrow);
    const b = trimmed.slice(arrow + 3);
    const endRaw = rustTrim(b).split(/\p{White_Space}+/u)[0] ?? '';
    const start = parseCueTime(a);
    const end = parseCueTime(endRaw);
    if (start === null || end === null) continue;
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i]!;
      if (rustTrim(next) === '' || next.includes('-->')) break;
      i += 1;
      const cleaned = stripMarkup(next);
      if (cleaned !== '') body.push(cleaned);
    }
    cues.push([{ start_ms: start, end_ms: Math.max(end, start) }, body.join(' ')]);
  }
  return cues;
}

function parseBcc(text: string): Array<[PlannedSpan, string]> {
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) {
    throw new MediaError('InvalidInput', `BCC 字幕 JSON 解析失败: ${(error as Error).message}`);
  }
  const body = (parsed as { body?: unknown } | null)?.body;
  if (!Array.isArray(body)) throw new MediaError('InvalidInput', "BCC 字幕 JSON 解析失败: missing field `body`");
  const out: Array<[PlannedSpan, string]> = [];
  for (const raw of body) {
    const item = raw as { from?: unknown; to?: unknown; content?: unknown };
    if (typeof item.from !== 'number' || typeof item.to !== 'number' || typeof item.content !== 'string') {
      throw new MediaError('InvalidInput', 'BCC 字幕 JSON 解析失败: invalid body item');
    }
    if (!Number.isFinite(item.from) || !Number.isFinite(item.to) || item.from < 0) continue;
    const start = Math.round(item.from * 1000);
    const end = Math.max(Math.round(item.to * 1000), start);
    out.push([{ start_ms: start, end_ms: end }, rustTrim(item.content.replace(/\n/g, ' '))]);
  }
  return out;
}

function formatCueTime(ms: number, sep: string): string {
  const value = Math.max(ms, 0);
  const h = Math.trunc(value / 3_600_000);
  const m = Math.trunc((value % 3_600_000) / 60_000);
  const s = Math.trunc((value % 60_000) / 1000);
  const milli = value % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(milli).padStart(3, '0')}`;
}

export function exportSegments(segments: readonly MediaSegmentRow[], format: ExportFormat): string {
  const done = segments.filter(s => s.status === 1 && rustTrim(s.text) !== '');
  if (format === 'txt') {
    const text = buildTranscriptText(segments);
    return text === '' ? '' : `${text}\n`;
  }
  if (format === 'srt') {
    return done.map((s, i) => `${i + 1}\n${formatCueTime(s.start_ms, ',')} --> ${formatCueTime(s.end_ms, ',')}\n${rustTrim(s.text).replace(/-->/g, '→')}\n\n`).join('');
  }
  return `WEBVTT\n\n${done.map(s => `${formatCueTime(s.start_ms, '.')} --> ${formatCueTime(s.end_ms, '.')}\n${rustTrim(s.text).replace(/-->/g, '→')}\n\n`).join('')}`;
}
