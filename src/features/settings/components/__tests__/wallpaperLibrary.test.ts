import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  appDataDirMock,
  copyFileMock,
  joinMock,
  mkdirMock,
  pickSingleFileMock,
  readDirMock,
  readFileMock,
  removeMock,
  writeFileMock,
} = vi.hoisted(() => ({
  appDataDirMock: vi.fn(),
  copyFileMock: vi.fn(),
  joinMock: vi.fn(),
  mkdirMock: vi.fn(),
  pickSingleFileMock: vi.fn(),
  readDirMock: vi.fn(),
  readFileMock: vi.fn(),
  removeMock: vi.fn(),
  writeFileMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: appDataDirMock,
  join: joinMock,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  copyFile: copyFileMock,
  mkdir: mkdirMock,
  readDir: readDirMock,
  readFile: readFileMock,
  remove: removeMock,
  writeFile: writeFileMock,
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
  CUSTOM_WALLPAPER_LIBRARY_LIMIT,
  WALLPAPER_MAX_EDGE_CEIL,
  WALLPAPER_MAX_EDGE_FLOOR,
  computeTargetDimensions,
  importWallpaperToLibrary,
  listCustomWallpapers,
  removeCustomWallpaper,
  resolveWallpaperMaxEdge,
  shouldReencodeWallpaper,
} from '../wallpaperLibrary';

const MANAGED_DIR = `C:/AppData/DeepStudent/${CUSTOM_WALLPAPER_DIRECTORY}`;

function fileEntry(name: string) {
  return { name, isFile: true, isDirectory: false, isSymlink: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  appDataDirMock.mockResolvedValue('C:/AppData/DeepStudent');
  joinMock.mockImplementation(async (...parts: string[]) => parts.join('/'));
  mkdirMock.mockResolvedValue(undefined);
  copyFileMock.mockResolvedValue(undefined);
  readDirMock.mockResolvedValue([]);
  readFileMock.mockResolvedValue(new Uint8Array());
  removeMock.mockResolvedValue(undefined);
  writeFileMock.mockResolvedValue(undefined);
});

describe('computeTargetDimensions', () => {
  it('keeps dimensions untouched when the long edge is within the limit', () => {
    expect(computeTargetDimensions(2560, 1440, 4096)).toEqual({
      width: 2560,
      height: 1440,
      shouldResize: false,
    });
    // 刚好等于上限也不缩放
    expect(computeTargetDimensions(4096, 2000, 4096)).toEqual({
      width: 4096,
      height: 2000,
      shouldResize: false,
    });
  });

  it('scales the long edge down to maxEdge while preserving aspect ratio', () => {
    expect(computeTargetDimensions(8192, 4096, 4096)).toEqual({
      width: 4096,
      height: 2048,
      shouldResize: true,
    });
    // 纵向图：长边是高度
    expect(computeTargetDimensions(3000, 9000, 3000)).toEqual({
      width: 1000,
      height: 3000,
      shouldResize: true,
    });
  });

  it('never rounds the short edge down to zero', () => {
    const result = computeTargetDimensions(1, 100000, 2560);
    expect(result.shouldResize).toBe(true);
    expect(result.width).toBe(1);
    expect(result.height).toBe(2560);
  });

  it('treats invalid inputs as no-resize', () => {
    expect(computeTargetDimensions(0, 100, 2560).shouldResize).toBe(false);
    expect(computeTargetDimensions(100, -1, 2560).shouldResize).toBe(false);
    expect(computeTargetDimensions(Number.NaN, 100, 2560).shouldResize).toBe(false);
    expect(computeTargetDimensions(100, 100, 0).shouldResize).toBe(false);
  });
});

describe('shouldReencodeWallpaper', () => {
  it('never re-encodes gif (may be animated)', () => {
    expect(shouldReencodeWallpaper('gif', true)).toBe(false);
    expect(shouldReencodeWallpaper('gif', false)).toBe(false);
  });

  it('always re-encodes bmp even within the size limit', () => {
    expect(shouldReencodeWallpaper('bmp', false)).toBe(true);
    expect(shouldReencodeWallpaper('bmp', true)).toBe(true);
  });

  it('re-encodes other formats only when the size limit is exceeded', () => {
    for (const extension of ['png', 'jpg', 'jpeg', 'webp']) {
      expect(shouldReencodeWallpaper(extension, true)).toBe(true);
      expect(shouldReencodeWallpaper(extension, false)).toBe(false);
    }
  });
});

describe('resolveWallpaperMaxEdge', () => {
  it('applies the 1.5x margin over the physical long edge', () => {
    expect(
      resolveWallpaperMaxEdge({ screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1 }),
    ).toBe(2880);
  });

  it('clamps to the floor for small screens', () => {
    expect(
      resolveWallpaperMaxEdge({ screenWidth: 1280, screenHeight: 720, devicePixelRatio: 1 }),
    ).toBe(WALLPAPER_MAX_EDGE_FLOOR);
  });

  it('clamps to the ceiling for high-DPI large screens', () => {
    expect(
      resolveWallpaperMaxEdge({ screenWidth: 3840, screenHeight: 2160, devicePixelRatio: 2 }),
    ).toBe(WALLPAPER_MAX_EDGE_CEIL);
  });
});

describe('listCustomWallpapers', () => {
  it('lists managed image files with absolute paths', async () => {
    readDirMock.mockResolvedValue([
      fileEntry('wallpaper-a.png'),
      fileEntry('wallpaper-b.jpeg'),
    ]);

    await expect(listCustomWallpapers()).resolves.toEqual([
      { path: `${MANAGED_DIR}/wallpaper-a.png`, fileName: 'wallpaper-a.png' },
      { path: `${MANAGED_DIR}/wallpaper-b.jpeg`, fileName: 'wallpaper-b.jpeg' },
    ]);
    expect(readDirMock).toHaveBeenCalledWith(MANAGED_DIR);
  });

  it('returns an empty list when the managed directory does not exist', async () => {
    readDirMock.mockRejectedValue(new Error('ENOENT'));
    await expect(listCustomWallpapers()).resolves.toEqual([]);
  });

  it('filters out directories, non-image files, dot names, and sub-path entries', async () => {
    readDirMock.mockResolvedValue([
      fileEntry('wallpaper-good.webp'),
      { name: 'nested', isFile: false, isDirectory: true, isSymlink: false },
      fileEntry('notes.txt'),
      fileEntry('no-extension'),
      fileEntry('.'),
      fileEntry('..'),
      fileEntry('../escape.png'),
      fileEntry('sub/inner.png'),
      fileEntry('sub\\inner.png'),
      { name: undefined, isFile: true, isDirectory: false, isSymlink: false },
    ]);

    const entries = await listCustomWallpapers();
    expect(entries.map((entry) => entry.fileName)).toEqual(['wallpaper-good.webp']);
  });
});

describe('importWallpaperToLibrary', () => {
  it('copies the picked image into the managed directory without cleaning other files', async () => {
    const source = 'D:/Pictures/source.PNG';
    pickSingleFileMock.mockResolvedValue(source);
    readDirMock.mockResolvedValue([fileEntry('wallpaper-old.jpg')]);

    const result = await importWallpaperToLibrary({ pickerTitle: 'Choose wallpaper' });

    expect(pickSingleFileMock).toHaveBeenCalledWith({
      title: 'Choose wallpaper',
      directory: false,
      multiple: false,
      filters: [{ name: 'Images', extensions: [...CUSTOM_WALLPAPER_EXTENSIONS] }],
    });
    expect(mkdirMock).toHaveBeenCalledWith(MANAGED_DIR, { recursive: true });
    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('unreachable');
    expect(result.entry.fileName).toMatch(/^wallpaper-[^/\\]+\.png$/);
    expect(result.entry.path).toBe(`${MANAGED_DIR}/${result.entry.fileName}`);
    expect(copyFileMock).toHaveBeenCalledWith(source, result.entry.path);
    // 多张共存：绝不清理既有库存
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('falls back to a raw copy for bmp when the environment cannot decode images', async () => {
    // vitest/jsdom 没有 createImageBitmap：降采样路径必须静默跳过而非导入失败
    expect(typeof createImageBitmap).toBe('undefined');
    pickSingleFileMock.mockResolvedValue('D:/Pictures/huge.bmp');

    const result = await importWallpaperToLibrary();

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error('unreachable');
    expect(result.entry.fileName).toMatch(/^wallpaper-[^/\\]+\.bmp$/);
    expect(copyFileMock).toHaveBeenCalledWith('D:/Pictures/huge.bmp', result.entry.path);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is cancelled', async () => {
    pickSingleFileMock.mockResolvedValue(null);

    await expect(importWallpaperToLibrary()).resolves.toEqual({ status: 'cancelled' });
    expect(appDataDirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it('rejects an unsupported extension before touching managed storage', async () => {
    pickSingleFileMock.mockResolvedValue('D:/Pictures/wallpaper.svg');

    const result = await importWallpaperToLibrary();

    expect(result.status).toBe('error');
    expect(appDataDirMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(copyFileMock).not.toHaveBeenCalled();
  });

  it('reports limit-exceeded when the library is full and copies nothing', async () => {
    pickSingleFileMock.mockResolvedValue('D:/Pictures/source.jpg');
    readDirMock.mockResolvedValue(
      Array.from({ length: CUSTOM_WALLPAPER_LIBRARY_LIMIT }, (_, i) =>
        fileEntry(`wallpaper-${i}.png`),
      ),
    );

    await expect(importWallpaperToLibrary()).resolves.toEqual({
      status: 'limit-exceeded',
      limit: CUSTOM_WALLPAPER_LIBRARY_LIMIT,
    });
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
  });

  it('returns an error result when copying fails', async () => {
    pickSingleFileMock.mockResolvedValue('D:/Pictures/source.webp');
    const copyError = new Error('copy failed');
    copyFileMock.mockRejectedValue(copyError);

    await expect(importWallpaperToLibrary()).resolves.toEqual({
      status: 'error',
      error: copyError,
    });
  });

  it('returns an error result when the picker itself throws', async () => {
    const pickerError = new Error('dialog unavailable');
    pickSingleFileMock.mockRejectedValue(pickerError);

    await expect(importWallpaperToLibrary()).resolves.toEqual({
      status: 'error',
      error: pickerError,
    });
    expect(copyFileMock).not.toHaveBeenCalled();
  });
});

describe('removeCustomWallpaper', () => {
  it('removes a file inside the managed directory', async () => {
    const target = `${MANAGED_DIR}/wallpaper-a.png`;
    await removeCustomWallpaper(target);
    expect(removeMock).toHaveBeenCalledWith(target);
  });

  it('rejects paths outside the managed directory', async () => {
    for (const path of [
      'C:/AppData/DeepStudent/other/wallpaper-a.png',
      `${MANAGED_DIR}/../secrets.png`,
      `${MANAGED_DIR}/nested/inner.png`,
      `${MANAGED_DIR}`,
      `${MANAGED_DIR}/`,
      `${MANAGED_DIR}/..`,
      `${MANAGED_DIR}/not-an-image.txt`,
      '/etc/passwd',
    ]) {
      await expect(removeCustomWallpaper(path)).rejects.toThrow(
        /outside the managed wallpaper directory/,
      );
    }
    expect(removeMock).not.toHaveBeenCalled();
  });
});
