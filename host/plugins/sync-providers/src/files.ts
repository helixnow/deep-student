import type { FilesService } from '../../../platform/files/api.ts';

/**
 * Local file access. The plugin installs a lookup of `ctx.files`; hosts that do not install
 * `dstu.platform.files` (unit tests, tools, bare constructors) get `null` and the callers keep
 * their path-based fallbacks.
 */
let filesLookup: (() => FilesService | undefined) | null = null;

export function setFilesLookup(lookup: (() => FilesService | undefined) | null): void {
  filesLookup = lookup;
}

export function filesService(): FilesService | null {
  return filesLookup?.() ?? null;
}
