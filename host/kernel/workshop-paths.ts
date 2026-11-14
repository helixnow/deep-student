import { posix, win32 } from 'node:path';

/** Containment of Host-canonicalized absolute paths; also accepts win32 vectors on POSIX. */
export function workshopDirectoryWithin(root: string, directory: string): boolean {
  // RUST-FIX(RF-P1-managed-plugin-install): Both separators are boundaries even when validating win32 paths on POSIX.
  if (/^[\\/]{2}/.test(root) || /^[\\/]{2}/.test(directory)) return false;
  if (directory.split(/[\\/]/).includes('..')) return false;
  const windows = /^[A-Za-z]:[\\/]/.test(root);
  const paths = windows ? win32 : posix;
  if (!windows && /^[A-Za-z]:/.test(directory)) return false;
  if (directory.replace(/^[A-Za-z]:/, '').includes(':')) return false;
  const normalized = paths.normalize(directory.replace(/\\/g, '/'));
  if (!paths.isAbsolute(normalized)) return false;
  const rel = paths.relative(paths.normalize(root.replace(/\\/g, '/')), normalized);
  return rel.split(/[\\/]/)[0] !== '..' && !paths.isAbsolute(rel);
}
