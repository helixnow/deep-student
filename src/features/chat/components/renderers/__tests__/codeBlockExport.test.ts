import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { saveTextFile, saveBinaryFile } = vi.hoisted(() => ({
  saveTextFile: vi.fn(),
  saveBinaryFile: vi.fn(),
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: { saveTextFile, saveBinaryFile },
}));

import {
  downloadHtmlSource,
  downloadSvgSource,
  planSvgRaster,
  rasterizeSvgToPng,
  saveSvgAsPng,
  withExplicitSvgSize,
} from '../codeBlockExport';

describe('svg raster planning', () => {
  it('scales the intrinsic size and caps the longest edge', () => {
    expect(planSvgRaster('<svg viewBox="0 0 300 150"></svg>')).toEqual({
      width: 300, height: 150, canvasWidth: 600, canvasHeight: 300,
    });
    const big = planSvgRaster('<svg viewBox="0 0 4000 1000"></svg>');
    expect(big.canvasWidth).toBe(4096);
    expect(big.canvasHeight).toBe(1024);
    expect(planSvgRaster('<svg></svg>')).toMatchObject({ width: 800, height: 600 });
  });

  it('writes explicit pixel size on the root without touching stroke-width', () => {
    const out = withExplicitSvgSize('<svg viewBox="0 0 3 2" width="100%" stroke-width="2"><rect/></svg>', 300, 200);
    expect(out).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 3 2" stroke-width="2" width="300" height="200">/);
  });
});

describe('save actions', () => {
  beforeEach(() => {
    saveTextFile.mockReset().mockResolvedValue({ canceled: false, path: 'content://x/1' });
    saveBinaryFile.mockReset().mockResolvedValue({ canceled: false, path: 'content://x/2' });
  });

  it('downloads svg/html source through the save dialog flow', async () => {
    await downloadSvgSource('<svg viewBox="0 0 1 1"></svg>');
    expect(saveTextFile).toHaveBeenCalledWith(expect.objectContaining({
      defaultFileName: 'image.svg',
      content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      filters: [{ name: 'SVG', extensions: ['svg'] }],
    }));
    await downloadHtmlSource('<p>x</p>', 'Demo.html');
    expect(saveTextFile).toHaveBeenLastCalledWith(expect.objectContaining({
      defaultFileName: 'Demo.html',
      content: '<p>x</p>',
    }));
  });

  describe('rasterization', () => {
    const OriginalImage = globalThis.Image;
    let drawImage: ReturnType<typeof vi.fn>;
    let loadedSrc = '';

    beforeEach(() => {
      drawImage = vi.fn();
      class FakeImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        decoding = '';
        set src(value: string) {
          loadedSrc = value;
          setTimeout(() => this.onload?.(), 0);
        }
      }
      (globalThis as any).Image = FakeImage;
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as any);
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
        cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
      });
      (URL as any).createObjectURL = vi.fn(() => 'blob:svg-1');
      (URL as any).revokeObjectURL = vi.fn();
    });

    afterEach(() => {
      (globalThis as any).Image = OriginalImage;
      vi.restoreAllMocks();
    });

    it('draws the sanitized svg via a blob: image and saves PNG bytes', async () => {
      const result = await saveSvgAsPng('<svg viewBox="0 0 100 50"><script>x()</script><rect/></svg>');
      expect(result).toEqual({ canceled: false, path: 'content://x/2' });
      expect(loadedSrc).toBe('blob:svg-1');
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 200, 100);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg-1');
      const args = saveBinaryFile.mock.calls[0][0];
      expect(args.defaultFileName).toBe('image.png');
      expect(Array.from(args.data as Uint8Array)).toEqual([137, 80, 78, 71]);
      const blob = (URL.createObjectURL as any).mock.calls[0][0] as Blob;
      expect(blob.type).toContain('image/svg+xml');
    });

    it('surfaces canvas security errors instead of saving', async () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
        throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      });
      await expect(rasterizeSvgToPng('<svg viewBox="0 0 1 1"></svg>')).rejects.toThrow(/Tainted/);
      expect(saveBinaryFile).not.toHaveBeenCalled();
    });

    it('rejects input without an svg root', async () => {
      await expect(rasterizeSvgToPng('<div>no</div>')).rejects.toThrow(/No renderable SVG/);
    });
  });
});
