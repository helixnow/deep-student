import { appDataDir, join } from '@tauri-apps/api/path';
import { copyFile, mkdir, readDir, remove } from '@tauri-apps/plugin-fs';

import { extractFileExtension, fileManager } from '@/utils/fileManager';

export const CUSTOM_WALLPAPER_DIRECTORY = 'workbench-wallpapers';
export const CUSTOM_WALLPAPER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] as const;
export const CUSTOM_WALLPAPER_FILTERS = [
  { name: 'Images', extensions: [...CUSTOM_WALLPAPER_EXTENSIONS] },
] as const;

export type CustomWallpaperImportResult =
  | { status: 'cancelled' }
  | { status: 'success'; value: string; cleanupErrors: unknown[] }
  | { status: 'error'; error: unknown };

export interface ImportCustomWallpaperOptions {
  commit: (managedPath: string) => Promise<void>;
  pickerTitle?: string;
}

function createManagedFileName(extension: string): string {
  return `wallpaper-${crypto.randomUUID()}.${extension}`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

async function removeStagedFile(path: string): Promise<void> {
  try {
    await remove(path);
  } catch {
    // The original failure is authoritative; a partial copy is safe to retry/clean later.
  }
}

async function cleanupManagedDirectory(
  managedDirectory: string,
  activePath: string,
  selectedSource: string,
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  let entries;
  try {
    entries = await readDir(managedDirectory);
  } catch (error) {
    return [error];
  }

  for (const entry of entries) {
    if (!entry.isFile || !entry.name || entry.name === '.' || entry.name === '..') continue;
    if (entry.name.includes('/') || entry.name.includes('\\')) continue;

    try {
      const candidate = await join(managedDirectory, entry.name);
      if (samePath(candidate, activePath) || samePath(candidate, selectedSource)) continue;
      await remove(candidate);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  return cleanupErrors;
}

export async function importCustomWallpaper({
  commit,
  pickerTitle,
}: ImportCustomWallpaperOptions): Promise<CustomWallpaperImportResult> {
  let selectedSource: string;
  try {
    const selected = await fileManager.pickSingleFile({
      title: pickerTitle,
      directory: false,
      multiple: false,
      filters: CUSTOM_WALLPAPER_FILTERS.map((filter) => ({
        name: filter.name,
        extensions: [...filter.extensions],
      })),
    });
    if (!selected) return { status: 'cancelled' };
    selectedSource = selected;
  } catch (error) {
    return { status: 'error', error };
  }

  const extension = extractFileExtension(selectedSource);
  if (!(CUSTOM_WALLPAPER_EXTENSIONS as readonly string[]).includes(extension)) {
    return { status: 'error', error: new Error('Unsupported wallpaper image type') };
  }

  let stagedPath: string | undefined;
  let managedDirectory: string;
  try {
    managedDirectory = await join(await appDataDir(), CUSTOM_WALLPAPER_DIRECTORY);
    await mkdir(managedDirectory, { recursive: true });
    stagedPath = await join(managedDirectory, createManagedFileName(extension));
    await copyFile(selectedSource, stagedPath);
  } catch (error) {
    if (stagedPath) await removeStagedFile(stagedPath);
    return { status: 'error', error };
  }

  try {
    await commit(stagedPath);
  } catch (error) {
    await removeStagedFile(stagedPath);
    return { status: 'error', error };
  }

  const cleanupErrors = await cleanupManagedDirectory(
    managedDirectory,
    stagedPath,
    selectedSource,
  );
  return { status: 'success', value: stagedPath, cleanupErrors };
}
