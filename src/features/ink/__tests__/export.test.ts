import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportInkPdf, exportInkPng, type InkExportPage } from '../export';

function input(pageId = 'page-1', width = 100, height = 80): InkExportPage {
  return {
    page_ref: {
      page_id: pageId,
      width,
      height,
      background: { kind: 'blank', ruling: 'blank' },
      page_blob_hash: `${pageId}-blob`,
    },
    page: { schema_version: 1, page_id: pageId, objects: [] },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('ink export rejection gates', () => {
  it('rejects pre-cancelled PNG and PDF before allocating canvases', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const controller = new AbortController();
    controller.abort();

    await expect(exportInkPng(input(), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(exportInkPdf([input()], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(createElement.mock.calls.some(([tagName]) => tagName.toLowerCase() === 'canvas')).toBe(false);
  });

  it('rejects invalid PNG crop and long-edge values before allocating canvases', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const page = input();

    await expect(exportInkPng({ ...page, crop: { x: 90, y: 0, width: 20, height: 10 } })).rejects.toThrow(/Crop/);
    await expect(exportInkPng(page, { long_edge: 0 })).rejects.toThrow(/long_edge/);
    await expect(exportInkPng(page, { long_edge: Number.NaN })).rejects.toThrow(/long_edge/);
    await expect(exportInkPng(page, { long_edge: 4097 })).rejects.toThrow(/long_edge/);
    expect(createElement.mock.calls.some(([tagName]) => tagName.toLowerCase() === 'canvas')).toBe(false);
  });

  it('rejects empty, unknown, or duplicate page selections before allocating canvases', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const pages = [input('page-1'), input('page-2')];

    await expect(exportInkPdf(pages, { page_ids: [] })).rejects.toThrow(/At least one/);
    await expect(exportInkPdf(pages, { page_ids: ['missing'] })).rejects.toThrow(/Unknown selected/);
    await expect(exportInkPdf(pages, { page_ids: ['page-1', 'page-1'] })).rejects.toThrow(/Duplicate selected/);
    expect(createElement.mock.calls.some(([tagName]) => tagName.toLowerCase() === 'canvas')).toBe(false);
  });

  it('rejects oversized page dimensions and aggregate raster budget before allocating canvases', async () => {
    const createElement = vi.spyOn(document, 'createElement');

    await expect(exportInkPng(input('too-large', 16_385, 100))).rejects.toThrow(/ink limits/);
    await expect(exportInkPdf([
      input('large-a', 4096, 4096),
      input('large-b', 4096, 4096),
    ])).rejects.toThrow(/200 MiB estimated byte limit/);
    expect(createElement.mock.calls.some(([tagName]) => tagName.toLowerCase() === 'canvas')).toBe(false);
  });

  it('rejects more than 500 pages before allocating canvases', async () => {
    const createElement = vi.spyOn(document, 'createElement');
    const pages = Array.from({ length: 501 }, (_, index) => input(`page-${index}`));

    await expect(exportInkPdf(pages)).rejects.toThrow(/1 to 500 pages/);
    expect(createElement.mock.calls.some(([tagName]) => tagName.toLowerCase() === 'canvas')).toBe(false);
  });
});
