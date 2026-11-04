import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import { loadInkBackground } from './background';
import type { InkPageRef } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024;

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set(PNG_SIGNATURE, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function imageBlob(overrides: { size?: number; base64?: string } = {}) {
  const bytes = pngHeader(2, 3);
  return {
    base64: overrides.base64 ?? toBase64(bytes),
    mimeType: 'image/png',
    size: overrides.size ?? bytes.byteLength,
  };
}

function pageRef(background: InkPageRef['background']): InkPageRef {
  return {
    page_id: 'page-1',
    width: 794,
    height: 1123,
    page_blob_hash: 'page-hash',
    background,
  };
}

const IMAGE_BACKGROUND = { kind: 'image', blob_hash: 'hash-png' } as const;

function bitmap(width: number, height: number) {
  const close = vi.fn();
  return {
    close,
    value: { width, height, close } as unknown as ImageBitmap,
  };
}

describe('loadInkBackground', () => {
  let createImageBitmapMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invokeMock.mockReset();
    createImageBitmapMock = vi.fn();
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('decodes the frozen PNG bytes and closes the bitmap exactly once', async () => {
    const target = bitmap(2, 3);
    createImageBitmapMock.mockResolvedValueOnce(target.value);
    invokeMock.mockResolvedValueOnce(imageBlob());

    const lease = await loadInkBackground(pageRef(IMAGE_BACKGROUND));

    expect(invokeMock).toHaveBeenCalledWith('vfs_get_blob_base64', { blobHash: 'hash-png' });
    const blob = createImageBitmapMock.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('image/png');
    expect(await readBlob(blob)).toEqual(pngHeader(2, 3));
    expect(lease.background).toBe(target.value);
    lease.dispose();
    lease.dispose();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('keeps the blank page fast path without invoking the blob command', async () => {
    const lease = await loadInkBackground(pageRef({ kind: 'blank', ruling: 'blank' }));

    expect(lease.background).toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
    lease.dispose();
  });

  it('rejects invalid base64 before creating a bitmap', async () => {
    invokeMock.mockResolvedValueOnce({ ...imageBlob(), base64: 'not base64!' });

    await expect(loadInkBackground(pageRef(IMAGE_BACKGROUND)))
      .rejects.toThrow('Frozen Ink PNG background is not valid base64.');
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('rejects bytes that do not match the declared PNG blob', async () => {
    invokeMock.mockResolvedValueOnce(imageBlob({ size: 25 }));

    await expect(loadInkBackground(pageRef(IMAGE_BACKGROUND)))
      .rejects.toThrow('Frozen Ink background bytes do not match the declared PNG blob.');
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('rejects a declared blob above the 4 MiB limit before decoding', async () => {
    invokeMock.mockResolvedValueOnce(imageBlob({ size: MAX_BACKGROUND_BYTES + 1 }));

    await expect(loadInkBackground(pageRef(IMAGE_BACKGROUND)))
      .rejects.toThrow('Frozen Ink PNG background is missing or exceeds the 4 MiB limit.');
    expect(createImageBitmapMock).not.toHaveBeenCalled();
  });

  it('closes the decoded bitmap when its dimensions disagree with the PNG header', async () => {
    const target = bitmap(3, 4);
    createImageBitmapMock.mockResolvedValueOnce(target.value);
    invokeMock.mockResolvedValueOnce(imageBlob());

    await expect(loadInkBackground(pageRef(IMAGE_BACKGROUND)))
      .rejects.toThrow('Decoded frozen Ink PNG dimensions do not match its header.');
    expect(target.close).toHaveBeenCalledOnce();
  });
});
