import { notesLog } from '../repository/log.ts';
import { notesLocalRuntime } from './local-runtime.ts';
import * as path from '../../../platform/util/path.ts';
import { lines, trim, trimStart } from './markdown.ts';

function stripBom(content: string): string {
  return content.startsWith('\ufeff') ? content.slice(1) : content;
}

/** cmd/notes.rs:59-87; WHATWG decoders share encoding_rs's encoding labels. */
export function decodeMarkdownBytes(bytes: Uint8Array): [string, string] {
  const starts = (...prefix: number[]) => prefix.every((byte, i) => bytes[i] === byte);
  if (starts(0xef, 0xbb, 0xbf)) {
    try {
      return [stripBom(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3))), 'UTF-8 BOM'];
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // Invalid UTF-8 with a BOM falls through to the remaining encodings.
    }
  }
  for (const [prefix, encoding, label] of [
    [[0xff, 0xfe], 'utf-16le', 'UTF-16LE'], [[0xfe, 0xff], 'utf-16be', 'UTF-16BE'],
  ] as const) {
    if (starts(...prefix)) return [stripBom(new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes.subarray(2))), label];
  }
  try {
    return [stripBom(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)), 'UTF-8'];
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    // Rust attempts GBK only after strict UTF-8 fails.
  }
  try {
    return [stripBom(new TextDecoder('gbk', { fatal: true, ignoreBOM: true }).decode(bytes)), 'GBK'];
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return [stripBom(new TextDecoder('gb18030', { ignoreBOM: true }).decode(bytes)), 'GB18030'];
  }
}

export function deriveMarkdownNoteTitle(rawPath: string): string {
  // Rust Path::file_stem ignores trailing separators and treats dotfiles as stems.
  const normalized = path.normalize(rawPath);
  const base = path.basename(normalized);
  const candidate = base === '.' || base === path.parse(normalized).root ? '' : trim(path.parse(base).name);
  return candidate || `导入笔记_${new Date().toISOString().slice(0, 19).replaceAll('-', '').replace('T', '_').replaceAll(':', '')}`;
}

export function extractFirstHeading(content: string): string | null {
  for (const line of lines(content)) {
    const text = trim(line);
    if (text.startsWith('# ')) {
      const title = trim(text.slice(2));
      if (title !== '') return title;
    }
  }
  return null;
}

export function splitLeadingHeading(content: string): [string, string] | null {
  const start = trimStart(content.replace(/^\ufeff+/, ''));
  const lineEnd = start.indexOf('\n') === -1 ? start.length : start.indexOf('\n');
  const line = start.slice(0, lineEnd).replace(/\r+$/, '');
  if (!line.startsWith('#')) return null;
  const rest = line.slice(1);
  if (!rest.startsWith(' ') && !rest.startsWith('\t')) return null;
  const title = trim(trim(rest).replace(/#+$/, ''));
  if (title === '') return null;
  let body = start.slice(lineEnd).startsWith('\n') ? start.slice(lineEnd + 1) : '';
  const nextEnd = body.indexOf('\n');
  if (nextEnd !== -1) {
    if (trim(body.slice(0, nextEnd)) === '') body = body.slice(nextEnd + 1);
  } else if (trim(body) === '') body = '';
  return [title, body];
}

export function isGenericNoteTitle(title: string): boolean {
  const text = trim(title);
  if (text === '' || text === '文件' || /^[0-9]+$/.test(text)) return true;
  const colon = text.indexOf(':');
  return colon !== -1 && /^[0-9]+$/.test(text.slice(colon + 1));
}

export function cleanupMaterializedImportFiles(context: string, paths: Iterable<string | null>): void {
  for (const file of paths) {
    if (file === null) continue;
    try {
      notesLocalRuntime().unlink(file);
    } catch (error) {
      notesLog.warn(`${context}: 清理临时导入文件失败 (${file}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
