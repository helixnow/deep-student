/** Bounded filesystem snapshots and change summaries for shell execution. */
import * as fs from 'node:fs';
import path from 'node:path';
import type { RuntimeRoot } from '../../../api.ts';
import type { JsonValue } from '../shared.ts';
import { isWithin, sha256Hex } from '../../runtime-paths.ts';
import type { ExternalFileSnapshot } from '../../workspace-change-set.ts';

const MAX_FILE_SNAPSHOT_ENTRIES = 1_000;
const MAX_FILE_CHANGE_ENTRIES = 200;
const MAX_REVERSIBLE_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_IO_CONCURRENCY = 16;
const SNAPSHOT_SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'target', '.next', 'dist', 'build', '.turbo',
  '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.cache',
  'coverage', '.nuxt', '.svelte-kit', '.parcel-cache', '.gradle',
]);
export interface FileSnapshotEntry {
  bytes: number; modified_ms: number | null; sha256: string | null; content: Buffer | null;
}
export interface FileSnapshot { files: Map<string, FileSnapshotEntry>; skipped: number; truncated: boolean }
function sorted(keys: Iterable<string>): string[] {
  return [...keys].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
}
function normalizedRelativePath(target: string, base: string): string {
  const relative = isWithin(base, target) ? path.relative(base, target) : target;
  return relative.split(path.sep).join('/');
}
/** Rust runs this walk under spawn_blocking; async fs keeps the Host event loop serving other sessions meanwhile. */
export async function collectFileSnapshot(root: string, cwd: string, captureContent: boolean): Promise<FileSnapshot> {
  const files = new Map<string, FileSnapshotEntry>();
  let skipped = 0;
  let truncated = false;
  let capturedBytes = 0;
  const stack: string[] = [cwd];
  while (stack.length > 0 && !truncated) {
    if (files.size >= MAX_FILE_SNAPSHOT_ENTRIES) { truncated = true; break; }
    const dir = stack.pop();
    if (dir === undefined) break;
    if (SNAPSHOT_SKIP_DIRECTORIES.has(path.basename(dir))) { skipped += 1; continue; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { skipped += 1; continue; }
    for (let offset = 0; offset < entries.length && !truncated; offset += SNAPSHOT_IO_CONCURRENCY) {
      const slice = entries.slice(offset, offset + SNAPSHOT_IO_CONCURRENCY);
      const inspected = await Promise.all(slice.map(async entry => {
        if (entry.isSymbolicLink()) return { kind: 'skip' as const };
        if (entry.isDirectory() && SNAPSHOT_SKIP_DIRECTORIES.has(entry.name)) return { kind: 'skip' as const };
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) return { kind: 'dir' as const, target };
        let metadata: fs.Stats;
        try { metadata = await fs.promises.lstat(target); }
        catch { return { kind: 'skip' as const }; }
        if (metadata.isSymbolicLink()) return { kind: 'skip' as const };
        if (metadata.isDirectory()) return { kind: 'dir' as const, target };
        if (!metadata.isFile()) return { kind: 'skip' as const };
        return { kind: 'file' as const, target, metadata };
      }));

      const toRead: Array<{ target: string; metadata: fs.Stats }> = [];
      for (const item of inspected) {
        if (item.kind === 'skip') { skipped += 1; continue; }
        if (item.kind === 'dir') { stack.push(item.target); continue; }
        if (files.size + toRead.length >= MAX_FILE_SNAPSHOT_ENTRIES) { truncated = true; break; }
        if (captureContent) {
          if (capturedBytes + item.metadata.size > MAX_REVERSIBLE_SNAPSHOT_BYTES) { truncated = true; break; }
          capturedBytes += item.metadata.size;
        }
        toRead.push({ target: item.target, metadata: item.metadata });
      }

      if (toRead.length === 0) continue;
      if (!captureContent) {
        for (const item of toRead) {
          const modifiedMs = item.metadata.mtimeMs >= 0 ? Math.trunc(item.metadata.mtimeMs) : null;
          files.set(normalizedRelativePath(item.target, root), {
            bytes: item.metadata.size, modified_ms: modifiedMs, sha256: null, content: null,
          });
        }
        continue;
      }

      const readResults = await Promise.all(toRead.map(async item => {
        try {
          const bytes = await fs.promises.readFile(item.target);
          return { item, bytes };
        } catch {
          return { item, bytes: null };
        }
      }));
      for (const { item, bytes } of readResults) {
        if (bytes === null) {
          capturedBytes = Math.max(0, capturedBytes - item.metadata.size);
          skipped += 1;
          continue;
        }
        const modifiedMs = item.metadata.mtimeMs >= 0 ? Math.trunc(item.metadata.mtimeMs) : null;
        files.set(normalizedRelativePath(item.target, root), {
          bytes: item.metadata.size, modified_ms: modifiedMs, sha256: sha256Hex(bytes), content: bytes,
        });
      }
    }
  }
  return { files, skipped, truncated };
}
export function collectFileSnapshotBlocking(root: string, cwd: string, captureContent: boolean): Promise<FileSnapshot> {
  return collectFileSnapshot(root, cwd, captureContent);
}
export function externalSnapshot(snapshot: FileSnapshot): ExternalFileSnapshot {
  const result: ExternalFileSnapshot = new Map();
  for (const [file, entry] of snapshot.files) {
    if (entry.content === null || entry.sha256 === null) continue;
    result.set(file, { bytes: entry.content, sha256: entry.sha256 });
  }
  return result;
}
function snapshotEntriesEqual(left: FileSnapshotEntry, right: FileSnapshotEntry): boolean {
  if (left.bytes !== right.bytes || left.modified_ms !== right.modified_ms) return false;
  if (left.sha256 !== right.sha256) return false;
  if (left.content === null || right.content === null) return left.content === right.content;
  return left.content.equals(right.content);
}
export function fileChangeSummaryJson(root: RuntimeRoot, before: FileSnapshot | null,
  after: FileSnapshot | null, error: string | null): Record<string, JsonValue> {
  let created = 0;
  let modified = 0;
  let deleted = 0;
  const changes: JsonValue[] = [];
  if (before !== null && after !== null) {
    for (const file of sorted(after.files.keys())) {
      const entry = after.files.get(file)!;
      const previous = before.files.get(file);
      if (previous === undefined) {
        created += 1;
        if (changes.length < MAX_FILE_CHANGE_ENTRIES) changes.push({ op: 'created', root_id: root.id, relative_path: file, bytes: entry.bytes });
      } else if (!snapshotEntriesEqual(previous, entry)) {
        modified += 1;
        if (changes.length < MAX_FILE_CHANGE_ENTRIES) changes.push({ op: 'modified', root_id: root.id, relative_path: file, bytes: entry.bytes });
      }
    }
    for (const file of sorted(before.files.keys())) {
      if (after.files.has(file)) continue;
      deleted += 1;
      if (changes.length < MAX_FILE_CHANGE_ENTRIES) changes.push({ op: 'deleted', root_id: root.id, relative_path: file, bytes: before.files.get(file)!.bytes });
    }
  }
  return { created, modified, deleted, changes,
    changes_truncated: created + modified + deleted > MAX_FILE_CHANGE_ENTRIES,
    tracked_files_before: before === null ? 0 : before.files.size,
    tracked_files_after: after === null ? 0 : after.files.size,
    snapshot_truncated: (before?.truncated ?? false) || (after?.truncated ?? false),
    snapshot_skipped: (before?.skipped ?? 0) + (after?.skipped ?? 0), error };
}

/** POSIX `SYMLOOP_MAX`; resolving more links than this fails with ELOOP, as the kernel would. */
export const PATH_HOLDERS_MAX_LINKS = 40;

/**
 * Returns the real directory holding every entry the kernel walks through to resolve `target`: each component of
 * `target` and, for every symbolic link or junction met on the way, each component of its target, followed hop by
 * hop. Whoever can write one of these directories can rename or replace the entry it holds and so redirect `target`.
 * Walking stops at the first missing entry; its holder is still included, since creating that entry redirects the
 * rest of the path too. Throws ELOOP after `maxLinks` links and rethrows any other filesystem error.
 */
export function pathHolders(target: string, maxLinks = PATH_HOLDERS_MAX_LINKS): string[] {
  const holders: string[] = [];
  let links = 0;
  const separators = path.sep === '\\' ? /[\\/]/ : /\//;
  const walk = (base: string, rest: string): void => {
    const root = path.isAbsolute(rest) ? path.parse(rest).root : '';
    let current = fs.realpathSync.native(root === '' ? base : root);
    for (const segment of rest.slice(root.length).split(separators)) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') { current = path.dirname(current); continue; }
      if (!holders.includes(current)) holders.push(current);
      const next = path.join(current, segment);
      const entry = fs.lstatSync(next, { throwIfNoEntry: false });
      if (entry === undefined) return;
      if (entry.isSymbolicLink()) {
        if (++links > maxLinks) {
          throw Object.assign(new Error(`Too many levels of symbolic links while resolving '${target}'`), { code: 'ELOOP' });
        }
        walk(current, fs.readlinkSync(next));
        try { current = fs.realpathSync.native(next); }
        catch (error) {
          if ((error as { code?: unknown }).code === 'ENOENT') return;
          throw error;
        }
      } else {
        current = fs.realpathSync.native(next);
      }
    }
  };
  const absolute = path.resolve(target);
  walk(path.parse(absolute).root, absolute);
  return holders;
}
