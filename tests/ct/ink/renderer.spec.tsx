import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import { InkRendererHarness } from './InkRendererHarness';

const pixel = async (canvas: ReturnType<import('@playwright/test').Page['locator']>, x: number, y: number) =>
  canvas.evaluate((element, point) => {
    const canvasElement = element as HTMLCanvasElement;
    const context = canvasElement.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });

test('renders background, pen, highlighter, and a full-page bottom object to real canvas pixels', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-full').click();

  await expect.poll(() => canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]))
    .toEqual([120, 160]);
  expect(await pixel(canvas, 80, 100)).toEqual([238, 238, 238, 255]);
  expect(await pixel(canvas, 5, 75)).toEqual([255, 0, 0, 255]);
  expect(await pixel(canvas, 60, 20)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 60, 45)).toEqual([238, 238, 119, 255]);
  expect(await pixel(canvas, 30, 147)).toEqual([0, 0, 238, 255]);
  expect(await pixel(canvas, 70, 70)).toEqual([0, 255, 0, 255]);
  expect(await pixel(canvas, 70, 80)).toEqual([238, 238, 238, 255]);
  expect(await pixel(canvas, 85, 80)).toEqual([0, 255, 0, 255]);
  expect(await pixel(canvas, 20, 100)).toEqual([0, 0, 255, 255]);
  expect(await pixel(canvas, 60, 116)).toEqual([238, 119, 238, 255]);
  expect(await pixel(canvas, 80, 130)).toEqual([238, 119, 238, 255]);
  expect(await pixel(canvas, 80, 116)).toEqual([238, 119, 238, 255]);
  expect(await pixel(canvas, 12, 125)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 36, 125)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 12, 127)).toEqual([238, 238, 238, 255]);
  expect(await pixel(canvas, 36, 127)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 12, 105)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 15, 105)).toEqual([238, 238, 238, 255]);
});

test('renders the same state deterministically across repeated real canvas renders', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-full').click();
  const first = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return {
      background: Array.from(context.getImageData(80, 100, 1, 1).data),
      pen: Array.from(context.getImageData(60, 20, 1, 1).data),
      pixels: Array.from(context.getImageData(0, 0, 120, 160).data),
    };
  });
  expect(first.background).toEqual([238, 238, 238, 255]);
  expect(first.pen).toEqual([0, 0, 0, 255]);
  await component.getByTestId('ink-render-full').click();
  const second = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(0, 0, 120, 160).data);
  });
  expect(second).toEqual(first.pixels);
});

test('maps crop output pixels to the matching full-page pixels', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-full').click();
  const fullPen = await pixel(canvas, 60, 20);
  await component.getByTestId('ink-render-crop').click();

  await expect.poll(() => canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]))
    .toEqual([60, 60]);
  expect(await pixel(canvas, 10, 10)).toEqual(fullPen);
  expect(await pixel(canvas, 10, 35)).toEqual([238, 238, 119, 255]);
});

test('limits scaled canvas dimensions to the caller pixel budget', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-scaled').click();

  const dimensions = await canvas.evaluate((element) => [(element as HTMLCanvasElement).width, (element as HTMLCanvasElement).height]);
  expect(dimensions[0]).toBeGreaterThan(0);
  expect(dimensions[1]).toBeGreaterThan(0);
  expect(dimensions[0] * dimensions[1]).toBeLessThanOrEqual(10_000);
  expect(Math.max(...dimensions)).toBeLessThan(320);
});

test('draws markup-looking text as plain canvas text without DOM nodes', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  await component.getByTestId('ink-render-text').click();

  expect(await component.locator('b').count()).toBe(0);
  const textPixels = await component.getByTestId('ink-render-canvas').evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const data = context.getImageData(60, 80, 50, 30).data;
    let darkPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] < 80 && data[index + 1] < 80 && data[index + 2] < 80) darkPixels += 1;
    }
    return {
      background: Array.from(context.getImageData(110, 109, 1, 1).data),
      darkPixels,
      pixels: Array.from(data),
    };
  });
  expect(textPixels.background).toEqual([238, 238, 238, 255]);
  expect(textPixels.darkPixels).toBeGreaterThan(0);

  await component.getByTestId('ink-render-literal').click();
  const literalPixels = await component.getByTestId('ink-render-canvas').evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(60, 80, 50, 30).data);
  });
  expect(literalPixels).toEqual(textPixels.pixels);
});

test('keeps a retraced highlighter stroke at the same alpha as one pass', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-full').click();

  expect(await pixel(canvas, 80, 116)).toEqual([238, 119, 238, 255]);
  expect(await pixel(canvas, 80, 130)).toEqual([238, 119, 238, 255]);
});

test('uses pressure-scaled endpoint widths and renders a pressure dot', async ({ mount }) => {
  const component = await mount(<InkRendererHarness />);
  const canvas = component.getByTestId('ink-render-canvas');
  await component.getByTestId('ink-render-full').click();

  expect(await pixel(canvas, 12, 127)).toEqual([238, 238, 238, 255]);
  expect(await pixel(canvas, 36, 127)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 12, 105)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, 15, 105)).toEqual([238, 238, 238, 255]);
});
