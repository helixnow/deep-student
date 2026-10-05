import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureBaseName,
  capturePdfRegion,
  intersectRects,
  pickMostOverlapping,
  rectFromPoints,
  toCanvasPixels,
  type ScreenRect,
} from '../regionCapture';

function domRect(rect: ScreenRect): DOMRect {
  return {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => rect,
  } as DOMRect;
}

describe('regionCapture geometry', () => {
  it('normalizes a drag in any direction into a rect', () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, width: 40, height: 60 });
  });

  it('treats disjoint or edge-touching rects as not overlapping', () => {
    const page = { left: 0, top: 0, width: 100, height: 100 };
    expect(intersectRects(page, { left: 100, top: 0, width: 10, height: 10 })).toBeNull();
    expect(intersectRects(page, { left: 90, top: 90, width: 20, height: 20 })).toEqual({ left: 90, top: 90, width: 10, height: 10 });
  });

  it('picks the page the selection overlaps most when it spans two pages', () => {
    const pages = [
      { id: 1, rect: { left: 0, top: 0, width: 100, height: 100 } },
      { id: 2, rect: { left: 0, top: 110, width: 100, height: 100 } },
    ];
    // 第 1 页重叠 50×20，第 2 页重叠 50×30
    expect(pickMostOverlapping({ left: 10, top: 80, width: 50, height: 60 }, pages)?.id).toBe(2);
    expect(pickMostOverlapping({ left: 200, top: 0, width: 10, height: 10 }, pages)).toBeNull();
  });

  it('maps a screen selection to canvas pixels at the render ratio and clips it to the page', () => {
    // 页面画布显示为 100×200（左上角 50,40），像素 200×400（2 倍渲染）
    const canvasRect = { left: 50, top: 40, width: 100, height: 200 };
    expect(toCanvasPixels({ left: 60, top: 50, width: 20, height: 30 }, canvasRect, 200, 400))
      .toEqual({ sx: 20, sy: 20, sw: 40, sh: 60 });
    expect(toCanvasPixels({ left: 130, top: 220, width: 100, height: 100 }, canvasRect, 200, 400))
      .toEqual({ sx: 160, sy: 360, sw: 40, sh: 40 });
  });

  it('rejects a sliver that barely touches the page', () => {
    expect(toCanvasPixels({ left: 145, top: 50, width: 20, height: 30 }, { left: 50, top: 40, width: 100, height: 200 }, 200, 400))
      .toBeNull();
  });

  it('names captures after the document without the extension or path characters', () => {
    expect(captureBaseName('线性代数/第一章.PDF', 'PDF')).toBe('线性代数 第一章');
    expect(captureBaseName('  ', 'PDF')).toBe('PDF');
    expect(captureBaseName(undefined, 'PDF')).toBe('PDF');
  });
});

describe('capturePdfRegion', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
  });

  function mountViewport(pages: Array<{ page: number; rect: ScreenRect; canvas?: { width: number; height: number } }>) {
    const viewport = document.createElement('div');
    const canvases = new Map<number, HTMLCanvasElement>();
    for (const { page, rect, canvas } of pages) {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-page-number', String(page));
      wrapper.getBoundingClientRect = () => domRect(rect);
      if (canvas) {
        const element = document.createElement('canvas');
        element.className = 'react-pdf__Page__canvas';
        element.width = canvas.width;
        element.height = canvas.height;
        element.getBoundingClientRect = () => domRect(rect);
        wrapper.appendChild(element);
        canvases.set(page, element);
      }
      viewport.appendChild(wrapper);
    }
    return { viewport, canvases };
  }

  it('crops the overlapped page into a PNG', async () => {
    const drawImage = vi.fn();
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage })) as unknown as typeof originalGetContext;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
      callback(new Blob(['png'], { type: 'image/png' }));
    };
    const { viewport, canvases } = mountViewport([
      { page: 2, rect: { left: 50, top: -170, width: 100, height: 200 }, canvas: { width: 200, height: 400 } },
      { page: 3, rect: { left: 50, top: 40, width: 100, height: 200 }, canvas: { width: 200, height: 400 } },
    ]);

    const outcome = await capturePdfRegion(viewport, { left: 60, top: 50, width: 20, height: 30 });

    expect(outcome).toMatchObject({ kind: 'ok', page: 3 });
    expect(drawImage).toHaveBeenCalledWith(canvases.get(3), 20, 20, 40, 60, 0, 0, 40, 60);
  });

  it('says the page is not rendered yet when its canvas is missing', async () => {
    const { viewport } = mountViewport([{ page: 7, rect: { left: 0, top: 0, width: 100, height: 200 } }]);
    await expect(capturePdfRegion(viewport, { left: 10, top: 10, width: 40, height: 40 }))
      .resolves.toEqual({ kind: 'not-rendered', page: 7 });
  });

  it('ignores a click-sized drag and a box outside every page', async () => {
    const { viewport } = mountViewport([
      { page: 1, rect: { left: 0, top: 0, width: 100, height: 200 }, canvas: { width: 100, height: 200 } },
    ]);
    await expect(capturePdfRegion(viewport, { left: 10, top: 10, width: 3, height: 3 })).resolves.toEqual({ kind: 'too-small' });
    await expect(capturePdfRegion(viewport, { left: 300, top: 10, width: 40, height: 40 })).resolves.toEqual({ kind: 'too-small' });
  });
});
