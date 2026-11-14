// notes_exporter.rs: unified ZIP schema 3 (Markdown + lossless documents),
// schema 2 legacy Markdown ZIPs, and the zip-slip safe import helpers.
const randomUUID = () => globalThis.crypto.randomUUID();
import { notesLog } from './log.ts';
import { dirname, join, resolve, sep } from '../../../platform/util/path.ts';
import JSZip from 'jszip';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type {
  NoteFormat, NoteRevision,
} from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { VfsNote } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { noteRepository } from './notes.ts';
import { noteFormatRepository } from './format.ts';
import { noteRevisionRepository, extractAssetRefs } from './revisions.ts';
import { noteRelationRepository } from './relations.ts';
import { decodeJson } from './json.ts';
import { vfsErrorDisplay } from './errors.ts';
import { blocks, marker, roots } from '../src/structure.ts';

export const SCHEMA_VERSION = 3;
import {
  civilTime, nowEpochNanos, toRfc3339, ymd,
} from '../../../platform/time/index.ts';
import { isRustWhitespace, rustTrim, truncateUtf8 } from '../../../platform/util/index.ts';
export const MAX_IMPORT_TEXT_BYTES = 64 * 1024 * 1024;

export class NotesExporterError extends Error {
  readonly kind: 'validation' | 'filesystem' | 'database' | 'internal';
  constructor(kind: 'validation' | 'filesystem' | 'database' | 'internal', message: string) {
    super(message);
    this.kind = kind;
  }
}

export function validation(message: string): never {
  throw new NotesExporterError('validation', message);
}
export function filesystem(message: string): never {
  throw new NotesExporterError('filesystem', message);
}
export function database(message: string): never {
  throw new NotesExporterError('database', message);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------ archive types

export interface ManifestPreference {
  key: string;
  file: string;
  bytes: number;
}

export interface Manifest {
  schema_version: number;
  exported_at: string;
  app_version: string;
  note_count: number;
  attachment_count: number;
  version_count: number;
  preferences: ManifestPreference[];
  subjects: unknown[];
}

export interface ExportRelation {
  id: string;
  block_id: string | null;
  relation_type: string;
  resource_id: string;
  locator: unknown;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExportNote {
  id: string;
  title: string;
  content_md: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_favorite: boolean;
  attachments: unknown[];
  props: unknown | null;
  format: NoteFormat | null;
  resource_id: string | null;
  relations: ExportRelation[];
}

export interface DocumentArchive {
  notes?: ExportNote[];
  revisions?: NoteRevision[];
  note_files: string[];
  revision_files: string[];
}

export interface AttachmentInternal {
  relative_path: string;
  absolute_path: string;
}

export interface SubjectBundle {
  notes: ExportNote[];
  attachments: AttachmentInternal[];
  preferences: Map<string, unknown>;
  revisions: NoteRevision[];
}

// ------------------------------------------------------------------ pure helpers

export function slugifySubject(subject: string): string {
  let out = '';
  for (const ch of subject) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch.toLowerCase();
    else if (ch === ' ' || ch === '-' || ch === '_') {
      if (!out.endsWith('_')) out += '_';
    } else if (/^[\x00-\x7f]$/.test(ch)) {
      if (!out.endsWith('_')) out += '_';
    } else out += '_';
  }
  const trimmed = out.replace(/^_+|_+$/g, '');
  return trimmed.length === 0 ? 'subject' : trimmed;
}

export function yamlQuote(value: string): string {
  if (value.length === 0) return '""';
  const needs = [':', '#', '{', '}', '[', ']', "'", '"', '&', '*', '!', '|', '>', '%', '@', '`']
    .some((token) => value.includes(token))
    || value.startsWith(' ') || value.endsWith(' ')
    || value.startsWith('-') || value.startsWith('?');
  if (!needs) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function stripYamlQuotes(value: string): string {
  const trimmed = rustTrim(value);
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  }
  return trimmed;
}

export function sanitizePrefKey(key: string): string {
  let out = '';
  for (const ch of key) out += /[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : '_';
  return out;
}

export function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    if (/[A-Za-z0-9\-_ ]/.test(ch)) out += ch;
    else if (isRustWhitespace(ch.codePointAt(0)!)) {
      if (!out.endsWith('_')) out += '_';
    } else if (!/^[\x00-\x7f]$/.test(ch)) out += ch;
    else if (!out.endsWith('_')) out += '_';
  }
  const trimmed = out.replace(/^_+|_+$/g, '');
  // Rust truncates at a UTF-8 boundary to at most 100 *bytes*.
  return truncateUtf8(trimmed, 100);
}

export function stripNotesAssetsPrefix(path: string): string | null {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (parts[0] !== 'notes_assets' || parts.length < 2) return null;
  const rest = parts.slice(1).join('/');
  return rest.length === 0 ? null : rest;
}

export function isPathTraversal(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split('/').includes('..');
}

export function isUnsafeArchiveRelative(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.length === 0) return true;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return true;
  const first = normalized.split('/')[0] ?? '';
  if (first.length >= 2 && first[1] === ':') return true;
  if (isPathTraversal(normalized)) return true;
  for (const segment of normalized.split('/')) {
    if (segment.length === 0 || segment === '..') return true;
  }
  return false;
}

export function resolveSafePathUnder(base: string, relative: string): string | null {
  if (isUnsafeArchiveRelative(relative)) return null;
  const parts = relative.replaceAll('\\', '/').split('/').filter((part) => part.length > 0 && part !== '.');
  const resolved = resolve(base, ...parts);
  const normalizedBase = resolve(base);
  if (resolved !== normalizedBase && !resolved.startsWith(`${normalizedBase}${sep}`)) return null;
  return resolved;
}

export function resolveImportAttachmentDiskPath(
  assetsBaseDir: string,
  relativePath: string,
): string | null {
  const normalized = relativePath.replaceAll('\\', '/');
  const under = normalized.startsWith('notes_assets/') ? normalized.slice('notes_assets/'.length) : null;
  if (under === null || isUnsafeArchiveRelative(under)) return null;
  const notesRoot = join(assetsBaseDir, 'notes_assets');
  const disk = resolveSafePathUnder(notesRoot, under);
  if (disk === null || !resolve(disk).startsWith(`${resolve(assetsBaseDir)}${sep}`)) return null;
  return disk;
}

export function extractNoteAssetPaths(content: string): Set<string> {
  const result = new Set<string>();
  for (const matched of content.matchAll(/notes_assets[/\\][^\s\)\]\[\}"'<>]+/g)) {
    const normalized = matched[0].replaceAll('\\', '/');
    if (isPathTraversal(normalized)) continue;
    const stripped = stripNotesAssetsPrefix(normalized);
    if (stripped === null) continue;
    result.add(normalized);
  }
  return result;
}

export function collectPropsAssets(props: unknown, paths: Set<string>): void {
  if (typeof props === 'string') {
    for (const path of extractNoteAssetPaths(props)) paths.add(path);
  } else if (Array.isArray(props)) {
    for (const value of props) collectPropsAssets(value, paths);
  } else if (props !== null && typeof props === 'object') {
    for (const value of Object.values(props as Record<string, unknown>)) collectPropsAssets(value, paths);
  }
}

export function remapAssetText(text: string, paths: ReadonlyMap<string, string>): string {
  const keys = [...paths.keys()].sort((a, b) => b.length - a.length);
  let result = '';
  let offset = 0;
  while (offset < text.length) {
    const remaining = text.slice(offset);
    let found: [number, string] | null = null;
    for (const key of keys) {
      const variants = [key, key.replaceAll('/', '\\'), key.replaceAll(' ', '%20')];
      for (const variant of variants) {
        if (!remaining.startsWith(variant)) continue;
        const next = remaining.slice(variant.length).charAt(0);
        if (next.length === 0 || /\s/.test(next) || ")]}\"'<>?,#".includes(next)) {
          found = [variant.length, paths.get(key) as string];
          break;
        }
      }
      if (found !== null) break;
    }
    if (found !== null) {
      result += found[1];
      offset += found[0];
    } else {
      const ch = String.fromCodePoint(remaining.codePointAt(0) as number);
      result += ch;
      offset += ch.length;
    }
  }
  return result;
}

export function remapProps(props: unknown, paths: ReadonlyMap<string, string>): unknown {
  if (typeof props === 'string') return remapAssetText(props, paths);
  if (Array.isArray(props)) return props.map((value) => remapProps(value, paths));
  if (props !== null && typeof props === 'object') {
    return Object.fromEntries(Object.entries(props as Record<string, unknown>)
      .map(([key, value]) => [key, remapProps(value, paths)]));
  }
  return props;
}

/** Remove layout wrappers only from validated root containers. */
export function plainMarkdown(content: string): string {
  const removals: Array<[number, number]> = [];
  for (const root of roots(content)) {
    const text = content.slice(root.start, root.end);
    if (marker(text) !== null) {
      removals.push([root.start, root.end]);
      continue;
    }
    if (!root.columns) continue;
    const tree = fromMarkdown(text) as unknown as {
      children: Array<{ type: string; position?: { start: { offset?: number }; end: { offset?: number } } }>;
    };
    for (const node of tree.children) {
      if (node.type !== 'paragraph' || node.position === undefined) continue;
      const start = node.position.start.offset;
      const end = node.position.end.offset;
      if (start === undefined || end === undefined) continue;
      const line = text.slice(start, end).replace(/[\n\r]+$/, '');
      if (line.startsWith(':::ds-columns{')
        || line === ':::column' || line === ':::end-column' || line === ':::end-ds-columns') {
        removals.push([root.start + start, root.start + end]);
      }
    }
  }
  let result = content;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

export function validateDocumentFormat(noteId: string, content: string, format: NoteFormat | null): void {
  let detected: NoteFormat;
  try {
    detected = noteFormatRepository.detect(noteId, content);
  } catch (error) {
    validation(message(error));
  }
  if (format === null) return;
  try {
    noteFormatRepository.ensureSupported(format);
  } catch (error) {
    validation(message(error));
  }
  if (format.content_format !== detected.content_format) {
    validation('Document envelope does not match declared format');
  }
  if (noteFormatRepository.requiredCapabilities(detected).length > 0
    && noteFormatRepository.requiredCapabilities(format).length === 0) {
    validation('Document envelope lacks required columns capability');
  }
}
