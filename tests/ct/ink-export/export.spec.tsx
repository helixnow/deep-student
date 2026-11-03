import React from 'react';
import { expect, test, type ComponentFixtures } from '@playwright/experimental-ct-react';
import { InkExportHarness } from './InkExportHarness';

type Mode = 'png' | 'crop' | 'pdf';

async function startExport(mount: ComponentFixtures['mount'], mode: Mode) {
  const component = await mount(<InkExportHarness mode={mode} />);
  const status = component.getByTestId('ink-export-status');
  await expect.poll(() => status.textContent(), { timeout: 60000 }).toMatch(/^(done|error: .+)$/);
  expect(await status.textContent()).toBe('done');
  const artifact = component.getByTestId('ink-export-artifact');
  const href = await artifact.getAttribute('href');
  if (!href) throw new Error('Export artifact URL was not published');
  const bytes = await component.evaluate(async (_element, url) => Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer())), href);
  return { component, bytes: Buffer.from(bytes) };
}

async function imagePixel(component: Awaited<ReturnType<typeof startExport>>['component'], x: number, y: number) {
  return component.getByTestId('ink-export-image').evaluate((image, point) => {
    const canvas = document.createElement('canvas');
    canvas.width = (image as HTMLImageElement).naturalWidth;
    canvas.height = (image as HTMLImageElement).naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(image as HTMLImageElement, 0, 0);
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });
}

test('exports a real PNG with the original page size, gray background, and red ink pixels', async ({ mount }) => {
  const { component, bytes } = await startExport(mount, 'png');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = component.getByTestId('ink-export-image');
  await expect(image).toHaveJSProperty('naturalWidth', 120);
  await expect(image).toHaveJSProperty('naturalHeight', 160);
  expect(await imagePixel(component, 30, 25)).toEqual([255, 0, 0, 255]);
  expect(await imagePixel(component, 80, 100)).toEqual([238, 238, 238, 255]);
});

test('exports a crop as actual PNG pixels aligned to its requested page region', async ({ mount }) => {
  const { component, bytes } = await startExport(mount, 'crop');
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const image = component.getByTestId('ink-export-image');
  await expect(image).toHaveJSProperty('naturalWidth', 80);
  await expect(image).toHaveJSProperty('naturalHeight', 60);
  expect(await imagePixel(component, 20, 10)).toEqual([255, 0, 0, 255]);
  expect(await imagePixel(component, 70, 40)).toEqual([238, 238, 238, 255]);
});

test('exports real PDF pages in requested reverse order with preserved ratios and rendered ink', async ({ mount }) => {
  const { component, bytes } = await startExport(mount, 'pdf');
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await expect(component.getByTestId('ink-export-source-unchanged')).toHaveText('true');
  const pages = [component.getByTestId('ink-export-pdf-page-1'), component.getByTestId('ink-export-pdf-page-2')];
  await expect(pages[0]).toBeVisible();
  await expect(pages[1]).toBeVisible();
  expect(Number(await pages[0].getAttribute('data-page-ratio'))).toBeCloseTo(2, 4);
  expect(Number(await pages[1].getAttribute('data-page-ratio'))).toBeCloseTo(0.75, 4);
  const colors = await Promise.all(pages.map((canvas) => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const pixels = context.getImageData(0, 0, (element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height).data;
    let red = 0;
    let blue = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 180 && pixels[index + 1] < 80 && pixels[index + 2] < 80) red += 1;
      if (pixels[index] < 80 && pixels[index + 1] < 80 && pixels[index + 2] > 150) blue += 1;
    }
    return { red, blue };
  })));
  expect(colors[0].blue).toBeGreaterThan(20);
  expect(colors[0].red).toBe(0);
  expect(colors[1].red).toBeGreaterThan(20);
  expect(colors[1].blue).toBe(0);
});

test('cancels during PDF raster encoding without publishing an artifact or mutating source pages', async ({ mount }) => {
  const component = await mount(<InkExportHarness mode="cancel" />);
  await expect(component.getByTestId('ink-export-status')).toHaveText('cancelled');
  await expect(component.getByTestId('ink-export-source-unchanged')).toHaveText('true');
  await expect(component.getByTestId('ink-export-artifact')).toHaveCount(0);
});
