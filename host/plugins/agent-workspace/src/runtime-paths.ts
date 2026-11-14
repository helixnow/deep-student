import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RuntimeDirectoryPage, RuntimeRoot } from '../api.ts';
import { ioMessage } from '../../../platform/paths/compat.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import {
  asciiLower, authorizedRootId, assessAuthorizedRootRisk, assessAuthorizedRootRiskCanonical,
  effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs, isWithin, legacySessionDir,
  normalizeRuntimeRelativePath, parseRuntimeDirectoryCursor, redactPathForDisplayIn, safeSessionDir,
  sha256Hex, stripWindowsVerbatimPrefix, type AuthorizedRootRisk,
} from './runtime-path-values.ts';

export { ioMessage };
export {
  asciiLower, authorizedRootId, assessAuthorizedRootRisk, assessAuthorizedRootRiskCanonical,
  effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs, isWithin, legacySessionDir,
  normalizeRuntimeRelativePath, parseRuntimeDirectoryCursor, safeSessionDir, sha256Hex,
  stripWindowsVerbatimPrefix, type AuthorizedRootRisk,
};
export function io<T>(label: string, operation: () => T): T {
  try { return operation(); } catch (error) { throw new Error(`${label}: ${ioMessage(error)}`); }
}
export function optionalMetadata(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function canonicalPath(file: string): string {
  const resolved = fs.realpathSync.native(file);
  return process.platform === 'win32' ? path.toNamespacedPath(resolved) : resolved;
}
export function resolveSessionRuntimeRoot(base: string, directory: string, sessionId: string, create: boolean): string {
  const rootPath = (basePath: string) => path.join(basePath, directory, safeSessionDir(sessionId));
  if (create) io('Failed to create app data dir', () => fs.mkdirSync(base, { recursive: true }));
  let baseCanon: string;
  try { baseCanon = canonicalPath(base); } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return rootPath(base);
    throw new Error(`Failed to resolve app data dir: ${ioMessage(error)}`);
  }
  const container = path.join(baseCanon, directory);
  if (create) io('Failed to create runtime-root container', () => fs.mkdirSync(container, { recursive: true }));
  const containerMeta = io('Failed to inspect runtime-root container', () => optionalMetadata(container));
  if (!containerMeta) {
    if (!create) return rootPath(baseCanon);
    return io('Failed to inspect runtime-root container', () => { fs.lstatSync(container); return rootPath(baseCanon); });
  }
  if (containerMeta.isSymbolicLink() || !containerMeta.isDirectory()) throw new Error('Runtime-root container must be a real directory');
  const containerCanon = io('Failed to resolve runtime-root container', () => canonicalPath(container));
  if (!isWithin(baseCanon, containerCanon)) throw new Error('Runtime-root container escapes the app data directory');
  const root = path.join(containerCanon, safeSessionDir(sessionId));
  const legacyName = legacySessionDir(sessionId);
  if (create) {
    if (!fs.existsSync(root) && legacyName !== null) {
      const legacy = path.join(containerCanon, legacyName);
      const metadata = io('Failed to inspect legacy session runtime root', () => optionalMetadata(legacy));
      if (metadata) {
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Legacy session runtime root must be a real directory');
        io('Failed to migrate legacy session runtime root', () => fs.renameSync(legacy, root));
      }
    }
    if (!fs.existsSync(root)) {
      try { fs.mkdirSync(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error(`Failed to create session runtime root: ${ioMessage(error)}`);
      }
    }
  }
  const metadata = io('Failed to inspect session runtime root', () => optionalMetadata(root));
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Session runtime root must be a real directory');
    const canonical = io('Failed to resolve session runtime root', () => canonicalPath(root));
    if (!isWithin(containerCanon, canonical)) throw new Error('Session runtime root escapes its container');
    return canonical;
  }
  if (!create) {
    if (legacyName === null) return root;
    const legacy = path.join(containerCanon, legacyName);
    const legacyMetadata = io('Failed to inspect legacy session runtime root', () => optionalMetadata(legacy));
    if (!legacyMetadata) return root;
    if (legacyMetadata.isSymbolicLink() || !legacyMetadata.isDirectory()) throw new Error('Legacy session runtime root must be a real directory');
    return io('Failed to resolve legacy session runtime root', () => canonicalPath(legacy));
  }
  return io('Failed to inspect session runtime root', () => { fs.lstatSync(root); return root; });
}
export function cleanupSessionRuntimeRoots(base: string, sessionId: string): void {
  const failures: string[] = [];
  for (const directory of ['chat_v2_artifacts', 'chat_v2_temp']) {
    for (const name of [safeSessionDir(sessionId), legacySessionDir(sessionId)]) {
      if (name === null) continue;
      const file = path.join(base, directory, name);
      try {
        const metadata = io(`Failed to inspect session runtime root '${file}'`, () => optionalMetadata(file));
        if (!metadata) continue;
        io(`Failed to remove session runtime root '${file}'`, () => {
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) fs.rmSync(file, { recursive: true });
          else fs.unlinkSync(file);
        });
      } catch (error) { failures.push((error as Error).message); }
    }
  }
  if (failures.length) throw new Error(failures.join('; '));
}
export function canonicalizeExistingDir(raw: string, label: string): string {
  const trimmed = rustTrim(raw);
  if (!trimmed) throw new Error('Path is required');
  const canonical = io(`Failed to resolve ${label}`, () => canonicalPath(trimmed));
  const meta = io(`Failed to inspect ${label}`, () => fs.statSync(canonical));
  if (!meta.isDirectory()) throw new Error(`${label} must be an existing directory`);
  return canonical;
}
export function sessionRoot(base: string, sessionId: string, kind: 'artifact' | 'temp', create: boolean): RuntimeRoot {
  const artifact = kind === 'artifact';
  return { id: artifact ? 'artifacts' : 'temp', kind,
    path: resolveSessionRuntimeRoot(base, artifact ? 'chat_v2_artifacts' : 'chat_v2_temp', sessionId, create),
    access: 'read_write', label: artifact ? 'Artifacts' : 'Temp',
    description: artifact ? 'Per-session artifact root. Agent writes are limited to relative paths here.' : 'Per-session temporary root for runtime intermediates.',
    session_scoped: true, configured: false };
}
export function redactPathForDisplay(value: string): string {
  return redactPathForDisplayIn(value, os.homedir());
}
const USIZE_MAX = (1n << 64n) - 1n;

export function listRuntimeDirectoryPage(rootId: string, root: string, relative: string, cursor: number | bigint, requestedLimit: number): RuntimeDirectoryPage {
  const offset = BigInt(cursor);
  const target = io('Runtime directory does not exist', () => canonicalPath(path.join(root, relative)));
  if (!isWithin(root, target) || !fs.statSync(target).isDirectory()) throw new Error('Runtime directory is outside the selected root or is not a directory');
  const limit = Math.max(1, Math.min(requestedLimit, 100));
  const dir = io('Failed to list runtime directory', () => fs.opendirSync(target));
  const page: RuntimeDirectoryPage = { rootId, relativePath: relative.replaceAll('\\', '/'), entries: [], nextCursor: null, truncated: false, scanned: 0 };
  try {
    for (let i = 0n; i < offset; i++) if (!io('Failed to read runtime entry', () => dir.readSync())) return page;
    while (page.scanned < 1000 && page.entries.length < limit) {
      const entry = io('Failed to read runtime entry', () => dir.readSync());
      if (!entry) break;
      page.scanned++;
      const name = entry.name;
      if (name.startsWith('.') || ['node_modules', 'target', '__pycache__', '.git', '.env'].includes(asciiLower(name))) continue;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      let sizeBytes: number | null = null;
      if (entry.isFile()) {
        try { sizeBytes = fs.statSync(path.join(target, name)).size; } catch { sizeBytes = null; }
      }
      page.entries.push({ name, relativePath: path.join(relative, name).replaceAll('\\', '/'), kind: entry.isDirectory() ? 'directory' : 'file', sizeBytes });
    }
    page.entries.sort((a, b) => compareUtf8(a.kind, b.kind) || compareUtf8(a.name.toLowerCase(), b.name.toLowerCase()));
    page.truncated = page.entries.length === limit || page.scanned === 1000;
    const nextOffset = offset + BigInt(page.scanned);
    page.nextCursor = page.truncated ? String(nextOffset > USIZE_MAX ? USIZE_MAX : nextOffset) : null;
    return page;
  } finally { dir.closeSync(); }
}

export function removeArtifactFile(root: string, relative: string): void {
  if (!relative) throw new Error('A relative artifact path is required');
  const rootCanon = io('Failed to resolve artifacts root', () => canonicalPath(root));
  const parent = io('Failed to resolve parent directory', () => canonicalPath(path.dirname(path.join(rootCanon, relative))));
  if (!isWithin(rootCanon, parent)) throw new Error('Path escapes the artifacts root');
  const target = path.join(parent, path.basename(relative));
  const metadata = io('Artifact does not exist', () => fs.lstatSync(target));
  if (metadata.isSymbolicLink()) { io('Failed to delete artifact symlink', () => fs.unlinkSync(target)); return; }
  if (!metadata.isFile()) throw new Error('Only artifact files can be deleted, not directories');
  const canonical = io('Artifact does not exist', () => canonicalPath(target));
  if (!isWithin(rootCanon, canonical)) throw new Error('Path escapes the artifacts root');
  io('Failed to delete artifact', () => fs.unlinkSync(target));
}
