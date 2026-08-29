import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...original, invoke: invokeMock };
});

import {
  clearBlobCache,
  getBlobBase64,
  getBlobCacheStats,
  type VfsBlobBase64Result,
} from '../blobApi';

const MB = 1024 * 1024;

/**
 * 缓存阈值逻辑只读取 base64.length，用带 length 的对象代替真实字符串，
 * 避免在测试里真的分配几十 MB 内存（CI 堆敏感）。
 */
const fakeBlobResult = (byteLength: number): VfsBlobBase64Result => ({
  base64: { length: byteLength } as unknown as string,
  mimeType: 'image/jpeg',
  size: byteLength,
});

describe('blobApi single-item cache limit (50MB, aligned with backend MAX_IMAGE_BYTES)', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    clearBlobCache();
  });

  it('caches a 25MB exam image instead of skipping it at the old 10MB limit', async () => {
    invokeMock.mockResolvedValue(fakeBlobResult(25 * MB));

    await getBlobBase64('hash-25mb');
    await getBlobBase64('hash-25mb');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(getBlobCacheStats().size).toBe(1);
    expect(getBlobCacheStats().totalBytes).toBe(25 * MB);
  });

  it('caches a blob at exactly the 50MB single-item limit', async () => {
    invokeMock.mockResolvedValue(fakeBlobResult(50 * MB));

    await getBlobBase64('hash-50mb');
    await getBlobBase64('hash-50mb');

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(getBlobCacheStats().size).toBe(1);
  });

  it('still skips caching for blobs above 50MB', async () => {
    invokeMock.mockResolvedValue(fakeBlobResult(50 * MB + 1));

    await getBlobBase64('hash-oversized');
    await getBlobBase64('hash-oversized');

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(getBlobCacheStats().size).toBe(0);
    expect(getBlobCacheStats().totalBytes).toBe(0);
  });
});
