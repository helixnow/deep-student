/**
 * libraryStore.importApkg 移动端虚拟 URI 分支契约：
 * - content:// 等虚拟 URI：先经后端 copy_file 落盘应用私有 tmp（含 .apkg 扩展名
 *   预检），再走同一条 import_apkg_to_library；导入后清理 tmp（best-effort）。
 * - 桌面端真实路径：保持直传，不产生 tmp。
 * - 非 .apkg 显示名：友好友拒绝，不触发后端 zip 解析错误。
 * - 不透明 document ID（无扩展名）：落盘为 import_*.apkg 后按 ZIP 魔数校验内容。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const copyFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());
const openMock = vi.hoisted(() => vi.fn());

function fakeHandle(bytes: number[]) {
  return {
    read: vi.fn(async (buf: Uint8Array) => {
      buf.set(bytes.slice(0, buf.length));
      return Math.min(bytes.length, buf.length);
    }),
    close: vi.fn(async () => undefined),
  };
}

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: async () => '/data/app/com.deepstudent.app',
  join: async (...parts: string[]) => parts.join('/'),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: mkdirMock,
  remove: removeMock,
  open: openMock,
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
    invokeMock.mockResolvedValue({ importedCards: 12, reviewEnqueue: { enqueued: 12, withHistory: 5, suspended: 1 } });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome).toEqual({ status: 'imported', importedCards: 12, reviewEnqueued: 12, reviewWithHistory: 5 });
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

    expect(outcome).toEqual({ status: 'imported', importedCards: 3, reviewEnqueued: 0, reviewWithHistory: 0 });
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

  it('accepts opaque content:// document IDs and validates the staged file by ZIP magic', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    pickMock.mockResolvedValue('content://com.android.providers.downloads.documents/document/msf%3A1234');
    copyFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    openMock.mockResolvedValue(fakeHandle([0x50, 0x4b, 0x03, 0x04, 0x14]));
    invokeMock.mockResolvedValue({ importedCards: 4 });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    const staged = '/data/app/com.deepstudent.app/tmp_apkg_import/import_1700000000000.apkg';
    expect(outcome).toEqual({ status: 'imported', importedCards: 4, reviewEnqueued: 0, reviewWithHistory: 0 });
    expect(copyFileMock).toHaveBeenCalledWith(
      'content://com.android.providers.downloads.documents/document/msf%3A1234',
      staged,
    );
    expect(openMock).toHaveBeenCalledWith(staged, { read: true });
    expect(invokeMock).toHaveBeenCalledWith('import_apkg_to_library', { path: staged });
    expect(removeMock).toHaveBeenCalledWith(staged);
    vi.restoreAllMocks();
  });

  it('rejects opaque content:// picks whose content is not a ZIP and cleans up', async () => {
    pickMock.mockResolvedValue('content://com.android.providers.media.documents/document/446');
    copyFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    openMock.mockResolvedValue(fakeHandle([0x25, 0x50, 0x44, 0x46]));

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome.status).toBe('failed');
    expect(invokeMock).not.toHaveBeenCalled();
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(useFlashcardsLibraryStore.getState().actionError).toBeTruthy();
  });

  it('still reports success when tmp cleanup fails after a successful import', async () => {
    pickMock.mockResolvedValue('content://storage/deck.apkg');
    copyFileMock.mockResolvedValue(undefined);
    removeMock.mockRejectedValue(new Error('locked'));
    invokeMock.mockResolvedValue({ importedCards: 1 });

    const outcome = await useFlashcardsLibraryStore.getState().importApkg();

    expect(outcome).toEqual({ status: 'imported', importedCards: 1, reviewEnqueued: 0, reviewWithHistory: 0 });
    expect(removeMock).toHaveBeenCalled();
  });
});
