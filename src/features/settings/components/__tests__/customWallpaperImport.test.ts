import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appDataDirMock,
  copyFileMock,
  joinMock,
  mkdirMock,
  pickSingleFileMock,
  readDirMock,
  removeMock,
} = vi.hoisted(() => ({
  appDataDirMock: vi.fn(),
  copyFileMock: vi.fn(),
  joinMock: vi.fn(),
  mkdirMock: vi.fn(),
  pickSingleFileMock: vi.fn(),
  readDirMock: vi.fn(),
  removeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: appDataDirMock,
  join: joinMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  copyFile: copyFileMock,
  mkdir: mkdirMock,
  readDir: readDirMock,
  remove: removeMock,
}));

vi.mock('@/utils/fileManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/fileManager')>();
  return {
    ...actual,
    fileManager: {
      ...actual.fileManager,
      pickSingleFile: pickSingleFileMock,
    },
  };
});

import {
  CUSTOM_WALLPAPER_DIRECTORY,
  CUSTOM_WALLPAPER_EXTENSIONS,
  importCustomWallpaper,
} from '../customWallpaperImport';

describe('importCustomWallpaper', () => {
  let stagedPath = '';

  beforeEach(() => {
    vi.clearAllMocks();
    stagedPath = '';
    appDataDirMock.mockResolvedValue('C:/AppData/DeepStudent');
    joinMock.mockImplementation(async (...parts: string[]) => parts.join('/'));
    mkdirMock.mockResolvedValue(undefined);
    copyFileMock.mockImplementation(async (_source: string, destination: string) => {
      stagedPath = destination;
    });
    readDirMock.mockImplementation(async () => [
      { name: stagedPath.split('/').pop(), isFile: true, isDirectory: false, isSymlink: false },
    ]);
    removeMock.mockResolvedValue(undefined);
  });

  it('picks one raster image, copies it into AppData, commits, then removes older managed files', async () => {
    const order: string[] = [];
    const source = 'D:/Pictures/source.PNG';
    pickSingleFileMock.mockResolvedValue(source);
    copyFileMock.mockImplementation(async (_source: string, destination: string) => {
      stagedPath = destination;
      order.push('copy');
    });
    readDirMock.mockImplementation(async () => [
      { name: stagedPath.split('/').pop(), isFile: true, isDirectory: false, isSymlink: false },
      { name: 'wallpaper-old.jpg', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'nested', isFile: false, isDirectory: true, isSymlink: false },
    ]);
    removeMock.mockImplementation(async () => {
      order.push('remove-old');
    });
    const commit = vi.fn(async () => {
      order.push('commit');
    });

    const result = await importCustomWallpaper({ commit, pickerTitle: 'Choose wallpaper' });

    expect(pickSingleFileMock).toHaveBeenCalledWith({
      title: 'Choose wallpaper',
      directory: false,
      multiple: false,
      filters: [{ name: 'Images', extensions: [...CUSTOM_WALLPAPER_EXTENSIONS] }],
    });
    expect(mkdirMock).toHaveBeenCalledWith(
      `C:/AppData/DeepStudent/${CUSTOM_WALLPAPER_DIRECTORY}`,
      { recursive: true },
    );
    expect(stagedPath).toMatch(
      new RegExp(`/wallpaper-[^/]+\\.png$`),
    );
    expect(copyFileMock).toHaveBeenCalledWith(source, stagedPath);
    expect(commit).toHaveBeenCalledWith(stagedPath);
    expect(removeMock).toHaveBeenCalledWith(
      `C:/AppData/DeepStudent/${CUSTOM_WALLPAPER_DIRECTORY}/wallpaper-old.jpg`,
    );
    expect(removeMock).not.toHaveBeenCalledWith(source);
    expect(order).toEqual(['copy', 'commit', 'remove-old']);
    expect(result).toEqual({ status: 'success', value: stagedPath, cleanupErrors: [] });
  });

  it('does nothing when the picker is cancelled', async () => {
    pickSingleFileMock.mockResolvedValue(null);
    const commit = vi.fn();

    await expect(importCustomWallpaper({ commit })).resolves.toEqual({ status: 'cancelled' });
    expect(appDataDirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('rejects a non-raster extension before creating managed storage', async () => {
    pickSingleFileMock.mockResolvedValue('D:/Pictures/wallpaper.svg');
    const commit = vi.fn();

    const result = await importCustomWallpaper({ commit });

    expect(result.status).toBe('error');
    expect(appDataDirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('removes only the new staged destination when copying fails', async () => {
    const source = 'D:/Pictures/source.jpg';
    pickSingleFileMock.mockResolvedValue(source);
    copyFileMock.mockImplementation(async (_source: string, destination: string) => {
      stagedPath = destination;
      throw new Error('copy failed');
    });
    const commit = vi.fn();

    const result = await importCustomWallpaper({ commit });

    expect(result).toMatchObject({ status: 'error' });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(stagedPath);
    expect(removeMock).not.toHaveBeenCalledWith(source);
    expect(readDirMock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('rolls back only the staged file when setting persistence fails', async () => {
    const source = 'D:/Pictures/source.webp';
    pickSingleFileMock.mockResolvedValue(source);
    const commit = vi.fn().mockRejectedValue(new Error('save failed'));

    const result = await importCustomWallpaper({ commit });

    expect(result).toMatchObject({ status: 'error' });
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(stagedPath);
    expect(removeMock).not.toHaveBeenCalledWith(source);
    expect(readDirMock).not.toHaveBeenCalled();
  });

  it('keeps the committed setting active when old-file cleanup fails', async () => {
    pickSingleFileMock.mockResolvedValue('D:/Pictures/source.bmp');
    readDirMock.mockImplementation(async () => [
      { name: stagedPath.split('/').pop(), isFile: true, isDirectory: false, isSymlink: false },
      { name: 'wallpaper-old.jpg', isFile: true, isDirectory: false, isSymlink: false },
    ]);
    const cleanupError = new Error('cleanup failed');
    removeMock.mockRejectedValue(cleanupError);
    const commit = vi.fn().mockResolvedValue(undefined);

    const result = await importCustomWallpaper({ commit });

    expect(result).toEqual({
      status: 'success',
      value: stagedPath,
      cleanupErrors: [cleanupError],
    });
    expect(commit).toHaveBeenCalledBefore(removeMock);
  });

  it('never deletes the selected source even if it is listed inside the managed directory', async () => {
    const managedDirectory = `C:/AppData/DeepStudent/${CUSTOM_WALLPAPER_DIRECTORY}`;
    const source = `${managedDirectory}/selected.gif`;
    pickSingleFileMock.mockResolvedValue(source);
    readDirMock.mockImplementation(async () => [
      { name: stagedPath.split('/').pop(), isFile: true, isDirectory: false, isSymlink: false },
      { name: 'selected.gif', isFile: true, isDirectory: false, isSymlink: false },
      { name: 'wallpaper-old.png', isFile: true, isDirectory: false, isSymlink: false },
      { name: '../outside.png', isFile: true, isDirectory: false, isSymlink: false },
    ]);
    const commit = vi.fn().mockResolvedValue(undefined);

    await importCustomWallpaper({ commit });

    expect(removeMock).not.toHaveBeenCalledWith(source);
    expect(removeMock).not.toHaveBeenCalledWith('C:/AppData/DeepStudent/outside.png');
    expect(removeMock).toHaveBeenCalledWith(`${managedDirectory}/wallpaper-old.png`);
  });
});
