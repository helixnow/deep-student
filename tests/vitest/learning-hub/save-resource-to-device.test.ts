/**
 * saveResourceToDevice 双通道保存契约
 *
 * 通道一（优先）：vfs_get_file_blob_path → fileManager.saveFromSource（零拷贝）
 * 通道二（回退）：vfs_get_attachment_content base64 → fileManager.saveBinaryFile
 * 壳层 / FileContentView / ImageContentView 统一复用本实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveFromSource: vi.fn(async () => ({ canceled: false, path: '/saved/out.bin' })),
    saveBinaryFile: vi.fn(async () => ({ canceled: false, path: '/saved/out.bin' })),
  },
}));

import { invoke } from '@tauri-apps/api/core';
import { fileManager } from '@/utils/fileManager';
import {
  saveFiltersForFileName,
  saveResourceToDevice,
} from '@/features/learning-hub/apps/views/saveResourceToDevice';

const invokeMock = vi.mocked(invoke);
const saveFromSourceMock = vi.mocked(fileManager.saveFromSource);
const saveBinaryFileMock = vi.mocked(fileManager.saveBinaryFile);

const NOT_FOUND = '图片不存在';

describe('saveResourceToDevice', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    saveFromSourceMock.mockClear();
    saveBinaryFileMock.mockClear();
  });

  it('prefers the blob path channel (saveFromSource, zero-copy)', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return '/blobs/abc123';
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await saveResourceToDevice({
      nodeId: 'img_1',
      fileName: 'photo.png',
      notFoundMessage: NOT_FOUND,
    });

    expect(result).toEqual({ canceled: false, path: '/saved/out.bin' });
    expect(saveFromSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/blobs/abc123', defaultFileName: 'photo.png' }),
    );
    expect(saveBinaryFileMock).not.toHaveBeenCalled();
    // blob 命中时不再读 base64 附件内容
    expect(invokeMock).not.toHaveBeenCalledWith('vfs_get_attachment_content', expect.anything());
  });

  it('skips blob-path resolution when caller already provides sourcePath', async () => {
    await saveResourceToDevice({
      nodeId: 'file_1',
      fileName: 'doc.pdf',
      sourcePath: '/blobs/pre-resolved',
      notFoundMessage: NOT_FOUND,
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(saveFromSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/blobs/pre-resolved' }),
    );
  });

  it('falls back to base64 attachment content when no blob file exists', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return null;
      if (cmd === 'vfs_get_attachment_content') {
        // "hello" 的 base64
        return { content: 'aGVsbG8=', found: true };
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await saveResourceToDevice({
      nodeId: 'legacy_1',
      fileName: 'inline.bin',
      notFoundMessage: NOT_FOUND,
    });

    expect(result.canceled).toBe(false);
    expect(saveFromSourceMock).not.toHaveBeenCalled();
    expect(saveBinaryFileMock).toHaveBeenCalledTimes(1);
    const { data } = saveBinaryFileMock.mock.calls[0][0];
    expect(Array.from(data)).toEqual([104, 101, 108, 108, 111]);
  });

  it('still falls back to base64 when blob-path resolution rejects', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') throw new Error('command missing');
      if (cmd === 'vfs_get_attachment_content') return { content: 'aGVsbG8=', found: true };
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await saveResourceToDevice({
      nodeId: 'legacy_2',
      fileName: 'inline.bin',
      notFoundMessage: NOT_FOUND,
    });

    expect(result.canceled).toBe(false);
    expect(saveBinaryFileMock).toHaveBeenCalledTimes(1);
  });

  it('throws the caller message when both channels are unavailable', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'vfs_get_file_blob_path') return null;
      if (cmd === 'vfs_get_attachment_content') return { content: null, found: false };
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    await expect(
      saveResourceToDevice({
        nodeId: 'missing_1',
        fileName: 'gone.bin',
        notFoundMessage: NOT_FOUND,
      }),
    ).rejects.toThrow(NOT_FOUND);
    expect(saveFromSourceMock).not.toHaveBeenCalled();
    expect(saveBinaryFileMock).not.toHaveBeenCalled();
  });
});

describe('saveFiltersForFileName', () => {
  it('derives the dialog filter from the extension', () => {
    expect(saveFiltersForFileName('photo.png')).toEqual([
      { name: 'photo.png', extensions: ['png'] },
    ]);
  });

  it('returns undefined for extension-less names', () => {
    expect(saveFiltersForFileName('README')).toBeUndefined();
  });
});
