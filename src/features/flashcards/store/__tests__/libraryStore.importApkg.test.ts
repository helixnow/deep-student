/**
 * libraryStore.importApkg 移动端虚拟 URI 分支契约：
 * - content:// 等虚拟 URI：先经后端 copy_file 落盘应用私有 tmp（含 .apkg 扩展名
 *   预检），再走同一条 import_apkg_to_library；导入后清理 tmp（best-effort）。
 * - 桌面端真实路径：保持直传，不产生 tmp。
 * - 非 .apkg 显示名：友好友拒绝，不触发后端 zip 解析错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const copyFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/data/app/com.deepstudent.app',
  join: async (...parts: string[]) => parts.join('/'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: mkdirMock,
  remove: removeMock,
}));
vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    pickSingleFile: vi.fn(),
  },
  isVirtualUri: (path: string) => path.startsWith('content://'),
  extractFileName: (path: string) => decodeURIComponent(path.split('/').pop() || path),
}));
vi.mock('@/utils/chatApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/chatApi')>()),
  copyFile: copyFileMock,
}));

import { fileManager } from '@/utils/fileManager';
import { useFlashcardsLibraryStore } from '../libraryStore';

const pickMock = fileManager.pickSingleFile as ReturnType<typeof vi.fn>;

describe('libraryStore.importApkg virtual URI staging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlashcardsLibraryStore.getState().reset();
  });

  it('stages content:// picks into app-private tmp then imports via the same command', async () => {
    pickMock.mockResolvedValue('content://com.android.providers.downloads/documents/abc%3Adeck.apkg');
    copyFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    invokeMock.mockResolvedValue({ importedCards: 12 });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome).toEqual({ status: 'imported', importedCards: 12 });
    // 落盘目录与文件名（SAF document ID 中的 `:` 净化为 `_`，扩展名保留）
    expect(copyFileMock).toHaveBeenCalledWith(
      'content://com.android.providers.downloads/documents/abc%3Adeck.apkg',
      '/data/app/com.deepstudent.app/tmp_apkg_import/abc_deck.apkg',
    );
    // 走原导入命令的是落盘后的真实路径
    expect(invokeMock).toHaveBeenCalledWith('import_apkg_to_library', {
      path: '/data/app/com.deepstudent.app/tmp_apkg_import/abc_deck.apkg',
    });
    // 导入后清理 tmp（含目录递归建）
    expect(mkdirMock).toHaveBeenCalledWith('/data/app/com.deepstudent.app/tmp_apkg_import', { recursive: true });
    expect(removeMock).toHaveBeenCalledWith('/data/app/com.deepstudent.app/tmp_apkg_import/abc_deck.apkg');
  });

  it('keeps the desktop path flow unchanged without staging', async () => {
    pickMock.mockResolvedValue('C:\\Users\\me\\Downloads\\deck.apkg');
    invokeMock.mockResolvedValue({ importedCards: 3 });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome).toEqual({ status: 'imported', importedCards: 3 });
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith('import_apkg_to_library', {
      path: 'C:\\Users\\me\\Downloads\\deck.apkg',
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('rejects non-apkg display names with a friendly error before staging', async () => {
    pickMock.mockResolvedValue('content://storage/document/notes.txt');

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome.status).toBe('failed');
    expect(copyFileMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(useFlashcardsLibraryStore.getState().actionError).toBeTruthy();
  });

  it('still reports success when tmp cleanup fails after a successful import', async () => {
    pickMock.mockResolvedValue('content://storage/deck.apkg');
    copyFileMock.mockResolvedValue(undefined);
    removeMock.mockRejectedValue(new Error('locked'));
    invokeMock.mockResolvedValue({ importedCards: 1 });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome).toEqual({ status: 'imported', importedCards: 1 });
    expect(removeMock).toHaveBeenCalled();
  });
});
