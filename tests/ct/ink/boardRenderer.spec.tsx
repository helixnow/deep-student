import React from 'react';
import { expect, test } from '@playwright/experimental-ct-react';
import type { Locator } from '@playwright/test';
import type { BoardRenderResult } from '../../../src/features/ink/boardRenderer';
import { worldToScreen, type Camera } from '../../../src/features/ink/camera';
import type { InkBoardBounds } from '../../../src/features/ink/types';
import { InkBoardRendererHarness } from './InkBoardRendererHarness';
import { panZoomBoardCamera, signedBoardCamera } from './boardRendererFixtures';

type RenderStats = {
  camera: Camera;
  result: BoardRenderResult;
  surfaceBounds: InkBoardBounds;
  objectCount: number;
  chunkCount: number;
};

const pixel = async (canvas: Locator, x: number, y: number): Promise<number[]> =>
  canvas.evaluate((element, point) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    return Array.from(context.getImageData(point.x, point.y, 1, 1).data);
  }, { x, y });

const renderStats = async (canvas: Locator): Promise<RenderStats> => {
  const raw = await canvas.getAttribute('data-board-render-stats');
  if (!raw) throw new Error('board render stats missing');
  return JSON.parse(raw) as RenderStats;
};

const pngInfo = async (canvas: Locator): Promise<{ prefix: string; width: number; height: number }> =>
  canvas.evaluate(async (element) => {
    const canvasElement = element as HTMLCanvasElement;
    const dataUrl = canvasElement.toDataURL('image/png');
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const info = { prefix: dataUrl.slice(0, 22), width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return info;
  });

test('keeps a million-unit board inside a capped 320x240 viewport and culls far-offscreen chunk objects', async ({ mount }) => {
  const component = await mount(<InkBoardRendererHarness />);
  const canvas = component.getByTestId('board-canvas');
  await component.getByTestId('board-render-negative').click();

  await expect.poll(() => canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    return [canvasElement.width, canvasElement.height];
  })).toEqual([640, 480]);

  const stats = await renderStats(canvas);
  expect(stats.surfaceBounds).toEqual({ x: -10_000_000, y: -10_000_000, width: 20_000_000, height: 20_000_000 });
  expect(stats.result.worldRect).toEqual({ x: -50, y: -40, width: 320, height: 240 });
  expect(stats.result.metrics.dpr).toBe(2);
  expect(stats.result.metrics.widthPx * stats.result.metrics.heightPx).toBeLessThanOrEqual(16_000_000);
  expect(stats.result.renderedObjectCount).toBe(8);
  expect(stats.objectCount).toBe(9);

  // Signed negative-world stroke at world (-30, -35), device pixels at DPR 2.
  expect(await pixel(canvas, 40, 10)).toEqual([0, 0, 0, 255]);
  // Neither the far-offscreen chunk nor the board bounds paint here.
  expect(await pixel(canvas, 300, 200)).toEqual([255, 255, 255, 255]);
});

test('maps a world point through the pan/zoom camera to the same device pixel', async ({ mount }) => {
  const component = await mount(<InkBoardRendererHarness />);
  const canvas = component.getByTestId('board-canvas');
  await component.getByTestId('board-render-pan-zoom').click();

  const stats = await renderStats(canvas);
  expect(stats.camera).toEqual(panZoomBoardCamera);
  const screen = worldToScreen({ x: 20, y: 30 }, stats.camera);
  expect(screen).toEqual({ x: 60, y: 40 });

  const deviceScaleX = stats.result.metrics.widthPx / stats.result.metrics.cssWidth;
  const deviceScaleY = stats.result.metrics.heightPx / stats.result.metrics.cssHeight;
  const deviceX = Math.round(screen.x * deviceScaleX);
  const deviceY = Math.round(screen.y * deviceScaleY);

  expect(await pixel(canvas, deviceX, deviceY)).toEqual([0, 0, 0, 255]);
  expect(await pixel(canvas, deviceX + 40, deviceY)).toEqual([255, 255, 255, 255]);
});

test('draws cross-chunk pen, highlighter, AI rect, and arrow by z-index', async ({ mount }) => {
  const component = await mount(<InkBoardRendererHarness />);
  const canvas = component.getByTestId('board-canvas');
  await component.getByTestId('board-render-zorder').click();

  // Chunk order is deliberately top-z first; only z_index sorting gives these results.
  expect(await pixel(canvas, 100, 140)).toEqual([255, 0, 0, 255]);
  expect(await pixel(canvas, 100, 180)).toEqual([0, 0, 0, 255]);

  const highlighterPixel = await pixel(canvas, 100, 188);
  expect(highlighterPixel[1]).toBe(255);
  expect(highlighterPixel[0]).toBe(highlighterPixel[2]);
  expect(highlighterPixel[0]).toBeGreaterThanOrEqual(120);
  expect(highlighterPixel[0]).toBeLessThanOrEqual(135);
  expect(highlighterPixel[3]).toBe(255);

  // Arrow z_index 40 over the pen z_index 35 on the same world line.
  expect(await pixel(canvas, 100, 220)).toEqual([0, 0, 255, 255]);
});

test('anchors grid ruling at the signed world origin and snapshots a finite signed crop with a same-bbox blank PNG', async ({ mount }) => {
  const component = await mount(<InkBoardRendererHarness />);
  const canvas = component.getByTestId('board-canvas');
  await component.getByTestId('board-render-grid').click();

  const gridStats = await renderStats(canvas);
  expect(gridStats.camera).toEqual({ x: -48, y: -24, zoom: 1 });
  expect(gridStats.result.worldRect).toEqual({ x: -48, y: -24, width: 320, height: 240 });
  // World origin is under CSS (48, 24), device (96, 48) at DPR 2.
  expect(await pixel(canvas, 96, 48)).toEqual([0, 0, 0, 255]);

  // World x=24 grid line maps to device x=144; sample its pixel neighborhood.
  const gridLineDarkest = await canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d');
    if (!context) throw new Error('Canvas 2D context is unavailable');
    const data = context.getImageData(140, 100, 10, 1).data;
    let darkest = 255;
    for (let index = 0; index < data.length; index += 4) {
      darkest = Math.min(darkest, data[index], data[index + 1], data[index + 2]);
    }
    return darkest;
  });
  expect(gridLineDarkest).toBeLessThan(250);
  expect(gridLineDarkest).toBeGreaterThanOrEqual(200);

  await component.getByTestId('board-render-signed').click();
  const signedStats = await renderStats(canvas);
  expect(signedStats.camera).toEqual(signedBoardCamera);
  expect(signedStats.result.worldRect).toEqual({ x: -160, y: -120, width: 640, height: 480 });
  // Negative-world stroke maps through camera (-160, -120, zoom 0.5) to device (128, 85).
  expect(await pixel(canvas, 128, 85)).toEqual([0, 0, 0, 255]);

  const signedPng = await pngInfo(canvas);
  expect(signedPng.prefix).toBe('data:image/png;base64,');
  expect([signedPng.width, signedPng.height]).toEqual([640, 480]);

  const blankCanvas = component.getByTestId('board-blank-canvas');
  await component.getByTestId('board-render-signed-blank').click();
  const blankStats = await renderStats(blankCanvas);
  expect(blankStats.camera).toEqual(signedBoardCamera);
  expect(blankStats.result.worldRect).toEqual(signedStats.result.worldRect);
  expect(await pixel(blankCanvas, 128, 85)).toEqual([255, 255, 255, 255]);

  const blankPng = await pngInfo(blankCanvas);
  expect(blankPng.prefix).toBe('data:image/png;base64,');
  expect([blankPng.width, blankPng.height]).toEqual([640, 480]);
});

test('draws only horizontal ruling on a lined board', async ({ mount }) => {
  const component = await mount(<InkBoardRendererHarness />);
  const canvas = component.getByTestId('board-canvas');
  await component.getByTestId('board-render-lined').click();

  // Camera zoom 0.5 with DPR 2 maps world spacing 24 to device spacing 24.
  expect(await pixel(canvas, 24, 10)).toEqual([255, 255, 255, 255]);

  const horizontalRuling = await pixel(canvas, 10, 24);
  expect(horizontalRuling).not.toEqual([255, 255, 255, 255]);
  expect(horizontalRuling[0]).toBeGreaterThanOrEqual(200);
  expect(horizontalRuling[0]).toBeLessThan(255);
  expect(horizontalRuling[3]).toBe(255);
});
