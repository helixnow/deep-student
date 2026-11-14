import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Test-only: retain bytes, not checksums; never write to a caller's cache. */
export function snapshotCacheInput(root) {
  const snapshot = new Map();
  const walk = (relative) => {
    const path = join(root, relative);
    const stat = statSync(path);
    snapshot.set(relative, { directory: stat.isDirectory(), mode: stat.mode, mtimeMs: stat.mtimeMs,
      bytes: stat.isDirectory() ? null : readFileSync(path) });
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(relative, entry));
  };
  walk('');
  return snapshot;
}

export function sameCacheInput(before, after) {
  if (before.size !== after.size) return false;
  for (const [path, a] of before) {
    const b = after.get(path);
    if (!b || a.directory !== b.directory || a.mode !== b.mode || a.mtimeMs !== b.mtimeMs ||
      (a.bytes !== null && !a.bytes.equals(b.bytes))) return false;
  }
  return true;
}
