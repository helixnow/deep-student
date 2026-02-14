import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { TauriAPI } from './tauriApi';
import { getErrorMessage } from './errorUtils';

export interface FilePickerOptions {
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  directory?: boolean;
  multiple?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  defaultFileName?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface SaveSourceOptions extends SaveDialogOptions {
  sourcePath: string;
}

export interface SaveTextOptions extends SaveDialogOptions {
  content: string;
}

export interface SaveBinaryOptions extends SaveDialogOptions {
  data: Uint8Array;
}

export interface PickDirectoryOptions {
  title?: string;
  defaultPath?: string;
}

const isMobilePlatform = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  // 1. Tauri 内部 API 检测（最可靠）
  try {
    const tauriInternals = (window as any).__TAURI_INTERNALS__;
    if (tauriInternals?.metadata?.currentDevice) {
      const device = tauriInternals.metadata.currentDevice;
      if (device === 'android' || device === 'ios') return true;
    }
  } catch {}
  // 2. UA + platform 检测（兼容回退）
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform || '').toLowerCase();
  const uaMatch =
    userAgent.includes('android') ||
    userAgent.includes('iphone') ||
    userAgent.includes('ipad') ||
    userAgent.includes('ipod');
  const platformMatch =
    platform.includes('iphone') ||
    platform.includes('ipad') ||
    platform.includes('ipod') ||
    platform.includes('android');
  // 3. iPad 在 iPadOS 13+ 的 UA 中伪装为 macOS，用 maxTouchPoints 补充检测
  const isIPadOS = platform === 'macintel' && navigator.maxTouchPoints > 1;
  return uaMatch || platformMatch || isIPadOS;
};

const DIRECTORY_PICKER_UNSUPPORTED_ERROR = 'DIRECTORY_PICKER_UNSUPPORTED_ON_MOBILE';

const ensureArray = (value: string | string[] | null): string[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const buildDefaultPath = (options: SaveDialogOptions): string | undefined => {
  if (options.defaultPath) {
    return options.defaultPath;
  }
  if (options.defaultFileName) {
    return options.defaultFileName;
  }
  return undefined;
};

export const fileManager = {
  async pickSingleFile(options: FilePickerOptions = {}): Promise<string | null> {
    const result = await dialogOpen({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      directory: options.directory,
      multiple: options.multiple,
    });
    const files = ensureArray(result);
    return files[0] ?? null;
  },

  async pickDirectory(options: PickDirectoryOptions = {}): Promise<string | null> {
    if (isMobilePlatform()) {
      throw new Error(DIRECTORY_PICKER_UNSUPPORTED_ERROR);
    }

    const result = await dialogOpen({
      title: options.title,
      defaultPath: options.defaultPath,
      directory: true,
      multiple: false,
    });
    const dirs = ensureArray(result);
    return dirs[0] ?? null;
  },

  async pickMultipleFiles(options: FilePickerOptions = {}): Promise<string[]> {
    const result = await dialogOpen({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      directory: options.directory,
      multiple: options.multiple ?? true,
    });
    return ensureArray(result);
  },

  async saveFromSource(options: SaveSourceOptions): Promise<{ canceled: boolean; path?: string }> {
    const destPath = await dialogSave({
      title: options.title,
      defaultPath: buildDefaultPath(options),
      filters: options.filters,
    });

    if (!destPath) {
      return { canceled: true };
    }

    try {
      await TauriAPI.copyFile(options.sourcePath, destPath);
      return { canceled: false, path: destPath };
    } catch (error: unknown) {
      throw new Error(getErrorMessage(error));
    }
  },

  async pickSavePath(options: SaveDialogOptions = {}): Promise<string | null> {
    const destPath = await dialogSave({
      title: options.title,
      defaultPath: buildDefaultPath(options),
      filters: options.filters,
    });
    return destPath ?? null;
  },

  async saveTextFile(options: SaveTextOptions): Promise<{ canceled: boolean; path?: string }> {
    const destPath = await dialogSave({
      title: options.title,
      defaultPath: buildDefaultPath(options),
      filters: options.filters,
    });

    if (!destPath) {
      return { canceled: true };
    }

    try {
      await TauriAPI.saveTextToFile(destPath, options.content);
      return { canceled: false, path: destPath };
    } catch (error: unknown) {
      throw new Error(getErrorMessage(error));
    }
  },

  async readTextFile(path: string): Promise<string> {
    return TauriAPI.readFileAsText(path);
  },

  async saveBinaryFile(options: SaveBinaryOptions): Promise<{ canceled: boolean; path?: string }> {
    const destPath = await dialogSave({
      title: options.title,
      defaultPath: buildDefaultPath(options),
      filters: options.filters,
    });

    if (!destPath) {
      return { canceled: true };
    }

    try {
      await writeFile(destPath, options.data);
      return { canceled: false, path: destPath };
    } catch (error: unknown) {
      throw new Error(getErrorMessage(error));
    }
  },
};

export type FileManager = typeof fileManager;
export const FILE_MANAGER_ERRORS = {
  DIRECTORY_PICKER_UNSUPPORTED_ERROR,
};
