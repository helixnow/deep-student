import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Page } from '@playwright/test';
import type { SourcePreparationResult } from '@/features/ink/prepare/source';
import { SourcePrepareHarness } from './SourcePrepareHarness';

const PDF_MARKERS = ['#ff0000', '#0000ff'] as const;
const PNG_MARKERS = ['#d7191c', '#1450cc'] as const;

interface PagePixels {
  width: number;
  height: number;
  markerCounts: number[];
  markerTops: number[];
  whiteCorner: boolean;
}

declare global {
  interface Window {
    __INK_PREPARE_CT_RESULT__?: SourcePreparationResult;
  }
}

async function renderedPixels(page: Page, markerColors: readonly string[]): Promise<PagePixels[]> {
  return page.evaluate(async (colors) => {
    const result = window.__INK_PREPARE_CT_RESULT__;
    if (!result) throw new Error('Source preparation returned no result');
    const expected = colors.map((hex) => {
      const value = hex.slice(1);
      return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
    });
    return Promise.all(result.pages.map(async ({ png }) => {
      const bitmap = await createImageBitmap(png);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const markerTops: number[] = [];
      const markerCounts = expected.map(([red, green, blue]) => {
        let count = 0;
        let firstY = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            const offset = (y * canvas.width + x) * 4;
            if (Math.abs(pixels[offset] - red) < 8 && Math.abs(pixels[offset + 1] - green) < 8 && Math.abs(pixels[offset + 2] - blue) < 8 && pixels[offset + 3] > 240) {
              count += 1;
              if (firstY < 0) firstY = y;
            }
          }
        }
        markerTops.push(firstY);
        return count;
      });
      const corner = context.getImageData(0, 0, 1, 1).data;
      return {
        width: canvas.width,
        height: canvas.height,
        markerCounts,
        markerTops,
        whiteCorner: corner[0] > 245 && corner[1] > 245 && corner[2] > 245 && corner[3] > 240,
      };
    }));
  }, markerColors);
}

test('renders a real two-page PDF into ordered full-page PNGs, honoring CropBox and rotation', async ({ mount, page }) => {
  test.setTimeout(60000);
  const component = await mount(<SourcePrepareHarness format="pdf" />);
  await component.getByRole('button', { name: 'ready' }).click();
  await expect(component.getByRole('button')).toHaveText(/^(done|failed)$/);
  const status = await component.getByRole('button').innerText();
  const diagnostic = await page.evaluate(() => window.__INK_PREPARE_CT_ERROR__);
  expect(status, `PDF preparation diagnostic: ${JSON.stringify(diagnostic)}`).toBe('done');

  const result = await page.evaluate(() => {
    const prepared = window.__INK_PREPARE_CT_RESULT__;
    return prepared && {
      pageCount: prepared.pages.length,
      mimeTypes: prepared.pages.map(({ png }) => png.type),
      converterVersion: prepared.converter_version,
    };
  });
  expect(result?.pageCount).toBe(2);
  expect(result?.mimeTypes).toEqual(['image/png', 'image/png']);
  const pages = await renderedPixels(page, PDF_MARKERS);
  expect(pages).toHaveLength(2);
  expect(pages[0].width).toBeGreaterThan(0);
  expect(pages.map(({ width, height }) => [width, height])).toEqual([[1536, 2048], [1536, 2048]]);
  expect(pages.map(({ whiteCorner }) => whiteCorner)).toEqual([true, true]);
  expect(pages[0].markerCounts[0]).toBeGreaterThan(100);
  expect(pages[0].markerCounts[1]).toBe(0);
  expect(pages[1].markerCounts[0]).toBe(0);
  expect(pages[1].markerCounts[1]).toBeGreaterThan(100);
  expect(pages[0].markerTops[0] / pages[0].height).toBeGreaterThan(0.8);
  expect(pages[1].markerTops[1] / pages[1].height).toBeGreaterThan(0.8);
  expect(result?.converterVersion).toBeTruthy();
});

test('turns a real PNG into one unchanged fixed page with its full-page pixels', async ({ mount, page }) => {
  const component = await mount(<SourcePrepareHarness format="image" />);
  await component.getByRole('button', { name: 'ready' }).click();
  await expect(component.getByRole('button')).toHaveText(/^(done|failed)$/);
  await expect(component.getByRole('button')).toHaveText('done');

  const result = await page.evaluate(() => {
    const prepared = window.__INK_PREPARE_CT_RESULT__;
    return prepared && {
      pageCount: prepared.pages.length,
      mimeTypes: prepared.pages.map(({ png }) => png.type),
      converterVersion: prepared.converter_version,
    };
  });
  expect(result?.pageCount).toBe(1);
  expect(result?.mimeTypes).toEqual(['image/png']);
  const [image] = await renderedPixels(page, PNG_MARKERS);
  expect(image.width).toBe(36);
  expect(image.height).toBe(24);
  expect(image.whiteCorner).toBe(true);
  expect(image.markerCounts[0]).toBe(54);
  expect(image.markerCounts[1]).toBe(48);
  expect(result?.converterVersion).toBeTruthy();
});
