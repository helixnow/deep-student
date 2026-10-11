/**
 * imagePreviewAssets 测试（#470）
 *
 * 契约：消息图片预览不再以原图 data URL 上屏——原图转 blob URL 只给查看器，
 * 列表格子用长边 THUMBNAIL_MAX_EDGE 的缩略图；无法缩略时回落原图。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  THUMBNAIL_MAX_EDGE,
  base64ToBlob,
  computeThumbnailSize,
  createImagePreviewAsset,
  revokeImagePreviewAsset,
} from '../imagePreviewAssets';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lDkAAAAASUVORK5CYII=';

describe('computeThumbnailSize', () => {
  it('按长边等比缩放到上限', () => {
    expect(computeThumbnailSize(4000, 3000)).toEqual({ width: THUMBNAIL_MAX_EDGE, height: 192 });
    expect(computeThumbnailSize(1000, 4000, 200)).toEqual({ width: 50, height: 200 });
  });

  it('不超过上限或尺寸无效时不缩略', () => {
    expect(computeThumbnailSize(200, 100)).toBeNull();
    expect(computeThumbnailSize(0, 100)).toBeNull();
    expect(computeThumbnailSize(Number.NaN, 100)).toBeNull();
  });
});

describe('createImagePreviewAsset', () => {
  let created: string[];
  const createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:test/${created.length + 1}/${blob.type}`;
    created.push(url);
    return url;
  });
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    created = [];
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('base64 解码为原始二进制', () => {
    const blob = base64ToBlob(PNG, 'image/png');
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(atob(PNG).length);
  });

  it('大图生成独立缩略图 blob URL，原图 blob URL 只留给查看器', async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })));
    class FakeOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() { return { drawImage, imageSmoothingQuality: 'low' }; }
      convertToBlob({ type }: { type: string }) { return Promise.resolve(new Blob(['thumb'], { type })); }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);

    const asset = await createImagePreviewAsset(`data:image/jpeg;base64,${PNG}`);
    expect(asset).not.toBeNull();
    expect(asset!.mimeType).toBe('image/jpeg');
    expect(asset!.fullUrl.startsWith('blob:')).toBe(true);
    expect(asset!.thumbnailUrl.startsWith('blob:')).toBe(true);
    expect(asset!.thumbnailUrl).not.toBe(asset!.fullUrl);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, THUMBNAIL_MAX_EDGE, 192);
    // JPEG 源保持 JPEG 输出；位图用完即释放
    expect(asset!.thumbnailUrl).toContain('image/jpeg');
    expect(close).toHaveBeenCalled();

    revokeImagePreviewAsset(asset!);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('无法解码时缩略图回落原图 URL', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    const asset = await createImagePreviewAsset(PNG, 'image/png');
    expect(asset!.thumbnailUrl).toBe(asset!.fullUrl);
    expect(created).toHaveLength(1);

    revokeImagePreviewAsset(asset!);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('无效载荷返回 null', async () => {
    expect(await createImagePreviewAsset('not base64 !!!')).toBeNull();
    expect(await createImagePreviewAsset('')).toBeNull();
  });
});
