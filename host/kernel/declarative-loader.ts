/**
 * Desktop Node-FS adapter for Tier 1 Declarative Extension Loader (RFC-002 P3).
 *
 * Reads declarative files strictly contained inside `packageRoot` (realpath containment,
 * rejecting symlinks escaping the package root) and delegates to the portable
 * `mountDeclarativeAssetsWithReader` in `declarative-registry.ts`.
 */
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { PluginManifest } from './manifest.ts';
import {
  mountDeclarativeAssetsWithReader,
  type MountDeclarativeDeps,
} from './declarative-registry.ts';

export * from './declarative-registry.ts';

async function resolveContainedFile(packageRoot: string, relPath: string): Promise<string> {
  const realRoot = await realpath(packageRoot);
  const candidate = resolve(realRoot, relPath);
  const actual = await realpath(candidate);
  const rel = relative(realRoot, actual);
  if (!rel || rel === '..' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`DECLARATIVE_PATH_ESCAPE: "${relPath}" resolves outside package root`);
  }
  return actual;
}

export async function mountDeclarativeAssets(
  manifest: PluginManifest,
  packageRoot: string,
  deps: MountDeclarativeDeps,
): Promise<() => void> {
  return mountDeclarativeAssetsWithReader(
    manifest,
    async (relPath) => readFile(await resolveContainedFile(packageRoot, relPath), 'utf8'),
    deps,
  );
}
